// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * distractor-lab/main.ts — orchestrator.
 *
 * Usage:  node distractor-lab.mjs <state.json> <outDir>
 *
 * For every user chart in the session: run all five generators, score each
 * candidate on (specDistance, dataDistance), keep a distance-spread subset
 * per method, compile original + distractors to Vega-Lite, and write
 *   out/specs/<id>.vl.json   — compiled specs (for vl2svg)
 *   out/manifest.json        — everything the gallery needs
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadSession, compileToVegaLite } from './lib';
import { generateAll, chartRoles, DistractorCandidate, Method } from './generators';
import { specDiff, specDistance, dataDistance } from './distance';

const [statePath, outDir] = process.argv.slice(2);
if (!statePath || !outDir) {
    console.error('usage: node distractor-lab.mjs <state.json> <outDir>');
    process.exit(1);
}

const session = loadSession(statePath);
console.log(`session: ${session.charts.length} charts, ${Object.keys(session.tables).length} tables`);

fs.mkdirSync(path.join(outDir, 'specs'), { recursive: true });

/** per-method cap, chosen to spread across the distance range */
const PER_METHOD = 5;

function selectSpread(cands: (DistractorCandidate & { specDist: number; dataDist: number })[], n: number) {
    if (cands.length <= n) return cands;
    // sort by combined distance, then pick evenly spaced entries → spread
    const sorted = [...cands].sort((a, b) => (a.specDist + a.dataDist) - (b.specDist + b.dataDist));
    const picked: typeof cands = [];
    for (let i = 0; i < n; i++) {
        picked.push(sorted[Math.round(i * (sorted.length - 1) / (n - 1))]);
    }
    // dedupe (rounding can collide)
    return [...new Map(picked.map(c => [c.label + c.specDist, c])).values()];
}

const manifest: any = { charts: [], generatedFor: path.basename(path.dirname(statePath)) };
let specCount = 0, failCount = 0;

for (const chart of session.charts) {
    const roles = chartRoles(chart);
    const t0 = Date.now();
    let candidates: DistractorCandidate[] = [];
    try {
        candidates = generateAll(chart, session);
    } catch (e: any) {
        console.error(`  !! generation failed for ${chart.title}: ${e.message}`);
        continue;
    }

    // score every candidate
    const scored = candidates.map(c => {
        const edits = specDiff(chart.spec, c.spec, { ...chart.metadata, ...c.metadata });
        const sDist = specDistance(edits);
        const dd = dataDistance(chart.rows, c.rows, roles.category, roles.measure);
        // when the candidate plots a different measure/table, data distance vs the
        // original plotted measure is what matters for "did values change"
        const dDist = c.rows === chart.rows && c.spec.encodings ? dd.overall : Math.max(dd.overall, c.dataEditNote ? dd.overall : 0);
        return { ...c, edits, specDist: sDist, dataDist: +dDist.toFixed(3), dataDetail: dd };
    });

    // per-method spread selection
    const byMethod = new Map<Method, typeof scored>();
    for (const c of scored) {
        if (!byMethod.has(c.method)) byMethod.set(c.method, []);
        byMethod.get(c.method)!.push(c);
    }
    const selected = [...byMethod.entries()].flatMap(([, cs]) => selectSpread(cs, PER_METHOD));

    // compile original
    const origId = `${chart.id}_orig`;
    let origSpec: any;
    try {
        origSpec = compileToVegaLite(chart.spec, chart.rows, chart.metadata);
        fs.writeFileSync(path.join(outDir, 'specs', `${origId}.vl.json`), JSON.stringify(origSpec));
        specCount++;
    } catch (e: any) {
        console.error(`  !! original failed to compile: ${chart.title}: ${e.message}`);
        continue;
    }

    const chartEntry: any = {
        id: chart.id,
        title: chart.title,
        tableId: chart.tableId,
        chartType: chart.spec.chartType,
        encodings: chart.spec.encodings,
        measure: roles.measure,
        category: roles.category,
        origSpecFile: `${origId}.vl.json`,
        distractors: [],
    };

    selected.forEach((c, i) => {
        const dId = `${chart.id}_d${i}`;
        try {
            const vl = compileToVegaLite(c.spec, c.rows, c.metadata);
            if (!vl || typeof vl !== 'object') throw new Error('empty spec');
            fs.writeFileSync(path.join(outDir, 'specs', `${dId}.vl.json`), JSON.stringify(vl));
            specCount++;
        } catch (e: any) {
            failCount++;
            return;
        }
        chartEntry.distractors.push({
            id: dId,
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
            specFile: `${dId}.vl.json`,
        });
    });

    manifest.charts.push(chartEntry);
    console.log(`${chart.title}: ${candidates.length} candidates → ${chartEntry.distractors.length} selected (${Date.now() - t0}ms)`);
}

fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`\nwrote ${specCount} specs (${failCount} candidate compile failures) → ${outDir}`);
