// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * distractor-lab/main.ts — orchestrator.
 *
 * Usage:  node distractor-lab.mjs <state.json> <outDir> [vl2svgPath]
 *
 * For every user chart in the session: run all five generators, score each
 * candidate on (specDistance, dataDistance), RENDER every candidate, and drop
 * any lure that is not actually distinguishable. Then write
 *   out/specs/<id>.vl.json   — compiled specs
 *   out/svg/<id>.svg         — rendered charts
 *   out/manifest.json        — everything the gallery needs, incl. drop report
 *
 * WHY RENDERING IS PART OF THIS SCRIPT (not a separate step):
 * a lure that renders pixel-identical to the original is a broken quiz item —
 * the participant would face two correct answers. Spec-level identity is NOT
 * sufficient to catch these: "Bar Chart" and "Stacked Bar Chart" with no color
 * channel are different chart types, different specs, identical renders. Only
 * the rendered bytes settle it, so the guard runs here and the build fails
 * loudly if anything degenerate survives.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { loadSession, compileToVegaLite } from './lib';
import { generateAll, chartRoles, DistractorCandidate, Method } from './generators';
import { specDiff, specDistance, dataDistance, mergeEdits, displayedOrder, kendallTauDistance, EDIT_COSTS } from './distance';

const [statePath, outDir, vl2svgArg] = process.argv.slice(2);
if (!statePath || !outDir) {
    console.error('usage: node distractor-lab.mjs <state.json> <outDir> [vl2svgPath]');
    process.exit(1);
}
// Resolved from cwd, not __dirname: this file is bundled by esbuild and the
// bundle usually lives outside the repo, where __dirname points nowhere useful.
const VL2SVG = vl2svgArg || path.resolve(process.cwd(), 'node_modules/.bin/vl2svg');
if (!fs.existsSync(VL2SVG)) {
    console.error(`vl2svg not found at ${VL2SVG}\n` +
        `Run from the repo root, or pass the path as the 3rd argument.`);
    process.exit(1);
}

// ── determinism ──────────────────────────────────────────────────────────
// Flint's recommender picks at random among equally-good fields
// (core/recommendation.ts uses Math.random in pickBestGroupingField and
// friends). That is good variety for the app and wrong for a study
// instrument: the same session must always yield the same quiz items, or the
// items cannot be reproduced, audited, or counterbalanced. Seed the generator
// for the whole run; override with DISTRACTOR_SEED to sample a different set.
const SEED = Number(process.env.DISTRACTOR_SEED ?? 20260807);
Math.random = (() => {
    let a = SEED >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
})();

const session = loadSession(statePath);
console.log(`session: ${session.charts.length} charts, ${Object.keys(session.tables).length} tables (seed ${SEED})`);

const specsDir = path.join(outDir, 'specs');
const svgDir = path.join(outDir, 'svg');
for (const d of [specsDir, svgDir]) fs.mkdirSync(d, { recursive: true });

/** per-method cap, chosen to spread across the distance range */
const PER_METHOD = 5;

function selectSpread<T extends { specDist: number; dataDist: number; label: string }>(cands: T[], n: number): T[] {
    if (cands.length <= n) return cands;
    const sorted = [...cands].sort((a, b) => (a.specDist + a.dataDist) - (b.specDist + b.dataDist));
    const picked: T[] = [];
    for (let i = 0; i < n; i++) picked.push(sorted[Math.round(i * (sorted.length - 1) / (n - 1))]);
    return [...new Map(picked.map(c => [c.label + c.specDist, c])).values()];
}

// ── rendering ────────────────────────────────────────────────────────────

function renderOne(specFile: string, svgFile: string): Promise<string | null> {
    return new Promise(resolve => {
        execFile(VL2SVG, [specFile, svgFile], { maxBuffer: 1 << 26 }, (err) => {
            if (err) return resolve(null);
            try { resolve(fs.readFileSync(svgFile, 'utf-8')); } catch { resolve(null); }
        });
    });
}

async function renderAll(jobs: { spec: any; id: string }[], concurrency = 8): Promise<Map<string, string | null>> {
    const results = new Map<string, string | null>();
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
        while (cursor < jobs.length) {
            const job = jobs[cursor++];
            const specFile = path.join(specsDir, `${job.id}.vl.json`);
            fs.writeFileSync(specFile, JSON.stringify(job.spec));
            results.set(job.id, await renderOne(specFile, path.join(svgDir, `${job.id}.svg`)));
        }
    });
    await Promise.all(workers);
    return results;
}

/**
 * Hash of what the viewer actually sees. Normalizes away Vega's
 * non-semantic churn (whitespace, float formatting jitter) so two charts are
 * "the same" only when they truly look the same.
 */
/**
 * Does the rendered chart show broken text — NaN, undefined, null in an axis
 * or data label? Such a lure compiles and renders, so the identity guard keeps
 * it, but it is *visibly* broken: a participant can eliminate it on sight,
 * which inflates recognition accuracy. Originals never contain these tokens,
 * so their presence is an unambiguous defect signal.
 */
function degenerateText(svg: string): string[] {
    const BAD = new Set(['NaN', 'undefined', 'null', 'Infinity', '-Infinity']);
    const hits = new Set<string>();
    for (const m of svg.matchAll(/>([^<>]*)</g)) {
        const t = m[1].trim();
        if (BAD.has(t)) hits.add(t);
    }
    return [...hits];
}

function renderHash(svg: string): string {
    const normalized = svg
        .replace(/\s+/g, ' ')
        .replace(/(\d+\.\d{3})\d+/g, '$1')
        .trim();
    return crypto.createHash('sha1').update(normalized).digest('hex');
}

// ── main ─────────────────────────────────────────────────────────────────

interface DropRecord { chart: string; method: Method; label: string; reason: string; sameAs?: string }

async function run() {
    const manifest: any = {
        charts: [],
        generatedFor: path.basename(path.dirname(statePath)),
        // Published so the gallery documents the costs it actually used;
        // a hand-written table in the HTML would drift from the code.
        editCosts: EDIT_COSTS,
        seed: SEED,
        drops: [] as DropRecord[],
        dropSummary: {} as Record<string, number>,
    };
    const allDrops: DropRecord[] = [];
    const skipped: { title: string; chartType: string; reason: string }[] = [];
    let kept = 0;

    for (const chart of session.charts) {
        const roles = chartRoles(chart);
        const t0 = Date.now();

        let candidates: DistractorCandidate[] = [];
        try {
            candidates = generateAll(chart, session);
        } catch (e: any) {
            console.error(`  !! generation failed for ${chart.title}: ${e.message}`);
            skipped.push({ title: chart.title, chartType: chart.spec.chartType, reason: 'generation-failed' });
            continue;
        }

        // score
        const scored = candidates.map(c => {
            const diffed = specDiff(chart.spec, c.spec, { ...chart.metadata, ...c.metadata });
            const edits = mergeEdits(c.declaredEdits, diffed);
            const dd = dataDistance(chart.rows, c.rows, roles.category, roles.measure);
            return { ...c, edits, specDist: specDistance(edits), dataDist: dd.overall, dataDetail: dd };
        });

        const byMethod = new Map<Method, typeof scored>();
        for (const c of scored) {
            if (!byMethod.has(c.method)) byMethod.set(c.method, []);
            byMethod.get(c.method)!.push(c);
        }
        const selected = [...byMethod.entries()].flatMap(([, cs]) => selectSpread(cs, PER_METHOD));

        // compile + render original and every selected candidate together
        const origId = `${chart.id}_orig`;
        let origSpec: any;
        try {
            origSpec = compileToVegaLite(chart.spec, chart.rows, chart.metadata);
        } catch (e: any) {
            console.error(`  !! original failed to compile: ${chart.title}: ${e.message}`);
            skipped.push({ title: chart.title, chartType: chart.spec.chartType, reason: 'original-compile-failed' });
            continue;
        }

        const origOrder = displayedOrder(origSpec, roles.category, chart.rows);

        const jobs: { spec: any; id: string }[] = [{ spec: origSpec, id: origId }];
        const idOf = new Map<number, string>();
        selected.forEach((c, i) => {
            try {
                const vl = compileToVegaLite(c.spec, c.rows, c.metadata);
                if (!vl || typeof vl !== 'object') throw new Error('empty spec');
                const id = `${chart.id}_d${i}`;
                idOf.set(i, id);
                jobs.push({ spec: vl, id });
                // Displayed order is only knowable from the compiled spec —
                // overwrite dataDistance's row-order fallback with the truth.
                c.dataDetail.order = +kendallTauDistance(
                    origOrder, displayedOrder(vl, roles.category, c.rows),
                ).toFixed(3);
            } catch {
                allDrops.push({ chart: chart.title, method: c.method, label: c.label, reason: 'compile-failed' });
            }
        });

        const svgs = await renderAll(jobs);
        const origSvg = svgs.get(origId);
        if (!origSvg) {
            console.error(`  !! original failed to render: ${chart.title}`);
            skipped.push({ title: chart.title, chartType: chart.spec.chartType, reason: 'original-render-failed' });
            continue;
        }
        const origHash = renderHash(origSvg);

        const chartEntry: any = {
            id: chart.id,
            title: chart.title,
            tableId: chart.tableId,
            chartType: chart.spec.chartType,
            encodings: chart.spec.encodings,
            measure: roles.measure,
            category: roles.category,
            focusMs: chart.focusMs,
            visits: chart.visits,
            origSpecFile: `${origId}.vl.json`,
            distractors: [],
        };

        // ── the guard ────────────────────────────────────────────────────
        // Drop anything that renders identically to the ORIGINAL: such a lure
        // is not a distractor at all, and the quiz item would have two correct
        // answers.
        //
        // Lures that duplicate EACH OTHER are kept on purpose. This gallery
        // compares what each method can reach, so hiding a chart because a
        // different method found it first would misrepresent the method that
        // also found it. Convergence is recorded on both copies instead, and
        // the quiz sampler de-duplicates by render hash when it builds an item.
        const keptByHash = new Map<string, any[]>();
        selected.forEach((c, i) => {
            const id = idOf.get(i);
            if (!id) return;
            const svg = svgs.get(id);
            const drop = (reason: string, sameAs?: string) => {
                allDrops.push({ chart: chart.title, method: c.method, label: c.label, reason, sameAs });
                for (const f of [path.join(specsDir, `${id}.vl.json`), path.join(svgDir, `${id}.svg`)]) {
                    try { fs.unlinkSync(f); } catch { /* already gone */ }
                }
            };
            if (!svg) return drop('render-failed');

            const broken = degenerateText(svg);
            if (broken.length) return drop('degenerate-render', broken.join('/'));

            const h = renderHash(svg);
            if (h === origHash) return drop('identical-to-original');

            const entry = {
                renderHash: h,
                id,
                method: c.method,
                label: c.label,
                rationale: c.rationale,
                chartType: c.spec.chartType,
                encodings: c.spec.encodings,
                edits: c.edits.map(e => ({ op: e.op, detail: e.detail, cost: e.cost })),
                specDist: c.specDist,
                dataDist: c.dataDist,
                dataDetail: c.dataDetail,
                dataEditNote: c.dataEditNote,
                caveat: c.caveat,
                specFile: `${id}.vl.json`,
                alsoProducedBy: [] as { method: Method; label: string }[],
            };
            if (!keptByHash.has(h)) keptByHash.set(h, []);
            keptByHash.get(h)!.push(entry);
            chartEntry.distractors.push(entry);
        });

        // Cross-link every group of lures that render the same, so each copy
        // shows which other methods reached the same chart.
        for (const group of keptByHash.values()) {
            if (group.length < 2) continue;
            for (const e of group) {
                e.alsoProducedBy = group
                    .filter(o => o !== e)
                    .map(o => ({ method: o.method, label: o.label }));
            }
        }

        // A chart can be quizzed only if it yields ≥3 visually distinct lures
        // (a 4-option item needs the original + 3 different wrong answers).
        // Chart types the generators barely support — maps, some heatmaps —
        // fall short; they stay in the manifest for completeness but are marked
        // ineligible so the quiz builder skips them instead of the build failing.
        const distinctCount = new Set(chartEntry.distractors.map((d: any) => d.renderHash)).size;
        chartEntry.quizEligible = distinctCount >= 3;
        chartEntry.distinctLures = distinctCount;

        kept += chartEntry.distractors.length;
        manifest.charts.push(chartEntry);
        const dropped = candidates.length - chartEntry.distractors.length;
        const flag = chartEntry.quizEligible ? '' : `  [not quiz-eligible: ${distinctCount} distinct]`;
        console.log(`${chart.title}: ${candidates.length} cand → ${chartEntry.distractors.length} kept, ${dropped} dropped/capped (${Date.now() - t0}ms)${flag}`);
    }

    manifest.drops = allDrops;
    manifest.skipped = skipped;
    for (const d of allDrops) manifest.dropSummary[d.reason] = (manifest.dropSummary[d.reason] ?? 0) + 1;
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));

    const eligible = manifest.charts.filter((c: any) => c.quizEligible).length;
    console.log(`\nkept ${kept} lures across ${manifest.charts.length} charts (${eligible} quiz-eligible)`);
    console.log('drops by reason:', JSON.stringify(manifest.dropSummary));
    if (skipped.length) {
        console.log(`skipped ${skipped.length} chart(s) (compile/render unsupported):`);
        for (const s of skipped) console.log(`  - ${s.title} [${s.chartType}] — ${s.reason}`);
    }

    // ── build-time assertion ─────────────────────────────────────────────
    // Re-verify from the files on disk. Two classes are HARD failures because
    // they mean a broken item slipped through among the distractors we kept:
    //   • identical-to-original  → the quiz item would have two correct answers
    //   • degenerate-render      → visibly broken, eliminable on sight
    // A chart producing <3 distinct lures is NOT a failure: some chart types
    // (maps, some heatmaps) the generators barely support. It is marked
    // quizEligible=false and the quiz builder skips it. Only a totally empty
    // run fails, so the guard can never pass vacuously.
    let violations = 0;
    if (kept === 0 || manifest.charts.length === 0) {
        console.error('FAILED: no charts/lures survived — the verification below would pass vacuously.');
        process.exit(1);
    }
    for (const c of manifest.charts) {
        const oh = renderHash(fs.readFileSync(path.join(svgDir, `${c.id}_orig.svg`), 'utf-8'));
        for (const d of c.distractors) {
            const svg = fs.readFileSync(path.join(svgDir, `${d.id}.svg`), 'utf-8');
            if (renderHash(svg) === oh) { console.error(`  VIOLATION identical-to-original: ${c.title} / ${d.label}`); violations++; }
            const broken = degenerateText(svg);
            if (broken.length) { console.error(`  VIOLATION degenerate-render (${broken.join('/')}): ${c.title} / ${d.label}`); violations++; }
        }
    }
    if (violations > 0) {
        console.error(`\nFAILED: ${violations} degenerate lure(s) survived the guard.`);
        process.exit(1);
    }
    const distinct = manifest.charts.map((c: any) => new Set(c.distractors.map((d: any) => d.renderHash)).size);
    const twins = kept - distinct.reduce((a: number, b: number) => a + b, 0);
    console.log(`guard verified: no lure renders identically to its original; ` +
        `${twins} lure(s) reproduce another method's chart and are kept on purpose.`);
}

run().catch(e => { console.error(e); process.exit(1); });
