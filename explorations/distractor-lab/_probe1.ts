// TEMPORARY verification probe — delete after use.
import * as crypto from 'crypto';
import { loadSession, compileToVegaLite, specSignature } from './lib';
import { generateAll, DistractorCandidate } from './_head_generators';

function canonicalize(v: any): any {
    if (Array.isArray(v)) return v.map(canonicalize);
    if (v && typeof v === 'object') {
        const o: any = {};
        for (const k of Object.keys(v).sort()) {
            if (k === '_warnings' || k === '_width' || k === '_height' || k === '_options') continue;
            o[k] = canonicalize(v[k]);
        }
        return o;
    }
    return v;
}
function key(vl: any): string {
    return crypto.createHash('sha256').update(JSON.stringify(canonicalize(vl))).digest('hex').slice(0, 20);
}
/** raw JSON.stringify, no canonicalization — to test whether canonicalize matters */
function rawKey(vl: any): string {
    return crypto.createHash('sha256').update(JSON.stringify(vl)).digest('hex').slice(0, 20);
}

const statePath = process.argv[2];
const session = loadSession(statePath);
console.log(`session: ${session.charts.length} charts`);

// session-wide render key of every chart the participant saw
const seenByParticipant = new Map<string, string>();
for (const c of session.charts) {
    try { seenByParticipant.set(key(compileToVegaLite(c.spec, c.rows, c.metadata)), c.title); } catch { }
}
console.log(`distinct render keys among ${session.charts.length} originals: ${seenByParticipant.size}`);

let totalCand = 0, totalCompiled = 0, compileFail = 0;
let dupPairs = 0, sameSigPairs = 0, diffTypePairs = 0, sameTypeDiffSigPairs = 0;
let rawDupPairs = 0;
let dupOwnOriginal = 0, dupOtherSessionChart = 0;
const dupOtherByMethod: Record<string, number> = {};
const dupOwnByMethod: Record<string, number> = {};
const examples: string[] = [];
const otherExamples: string[] = [];
const t0 = Date.now();

for (const chart of session.charts) {
    const cands: DistractorCandidate[] = generateAll(chart, session);
    totalCand += cands.length;
    const selfKey = key(compileToVegaLite(chart.spec, chart.rows, chart.metadata));

    const groups = new Map<string, { c: DistractorCandidate; sig: string }[]>();
    const rawGroups = new Map<string, number>();
    // include the ORIGINAL as a group member (the claim's bookkeeping)
    groups.set(selfKey, [{ c: { method: 'enumeration', label: '<<ORIGINAL>>', rationale: '', spec: chart.spec, rows: chart.rows, metadata: chart.metadata } as any, sig: specSignature(chart.spec) }]);
    for (const c of cands) {
        let vl: any;
        try { vl = compileToVegaLite(c.spec, c.rows, c.metadata); if (!vl || typeof vl !== 'object') throw 0; }
        catch { compileFail++; continue; }
        totalCompiled++;
        const k = key(vl);
        const rk = rawKey(vl);
        rawGroups.set(rk, (rawGroups.get(rk) ?? 0) + 1);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push({ c, sig: specSignature(c.spec) });

        // vs the participant's own charts
        if (k === selfKey) {
            dupOwnOriginal++;
            dupOwnByMethod[c.method] = (dupOwnByMethod[c.method] ?? 0) + 1;
        } else if (seenByParticipant.has(k)) {
            dupOtherSessionChart++;
            dupOtherByMethod[c.method] = (dupOtherByMethod[c.method] ?? 0) + 1;
            if (otherExamples.length < 4) otherExamples.push(
                `[${chart.title}] ${c.method} "${c.label}" == SESSION CHART "${seenByParticipant.get(k)}"`);
        }
    }

    for (const [, g] of groups) {
        if (g.length < 2) continue;
        for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
            dupPairs++;
            const a = g[i], b = g[j];
            if (a.sig === b.sig) sameSigPairs++;
            else if (a.c.spec.chartType !== b.c.spec.chartType) diffTypePairs++;
            else sameTypeDiffSigPairs++;
            if (examples.length < 8 && a.sig !== b.sig && a.c.spec.chartType !== b.c.spec.chartType)
                examples.push(`[${chart.title}] ${a.c.spec.chartType}/"${a.c.label}" == ${b.c.spec.chartType}/"${b.c.label}"`);
        }
    }
    for (const [, n] of rawGroups) if (n >= 2) rawDupPairs += n * (n - 1) / 2;
}

console.log(`\ncandidates: ${totalCand}  compiled: ${totalCompiled}  compile-fail: ${compileFail}  (${Date.now() - t0}ms)`);
console.log(`duplicate pairs (canonical key, pre-selectSpread): ${dupPairs}`);
console.log(`  same chart-level signature (cross-generator):   ${sameSigPairs}`);
console.log(`  different chartType, identical render:          ${diffTypePairs}`);
console.log(`  same chartType, different signature (no-op):    ${sameTypeDiffSigPairs}`);
console.log(`duplicate pairs with RAW JSON.stringify key:      ${rawDupPairs}`);
console.log(`lures identical to their OWN original: ${dupOwnOriginal}`, JSON.stringify(dupOwnByMethod));
console.log(`lures identical to a DIFFERENT session chart: ${dupOtherSessionChart}`, JSON.stringify(dupOtherByMethod));
console.log('\nexamples (different chartType, same render):');
for (const e of examples) console.log('  ' + e);
console.log('examples (cross-chart):');
for (const e of otherExamples) console.log('  ' + e);
