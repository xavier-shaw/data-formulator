import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { loadSession, compileToVegaLite, cloneSpec } from './lib';
import { chartRoles } from './generators';

const ROOT = '/Users/xavierxiao/Desktop/data-formulator';
const OUT = '/private/tmp/claude-501/-Users-xavierxiao-Desktop-data-formulator/584aa0ae-bacc-45b7-91a1-bc8375a12a30/scratchpad/out';
fs.mkdirSync(OUT, { recursive: true });
const VL2SVG = path.join(ROOT, 'node_modules/.bin/vl2svg');

// same normalization as main.ts:113-119
function renderHash(svg: string): string {
    const normalized = svg.replace(/\s+/g, ' ').replace(/(\d+\.\d{3})\d+/g, '$1').trim();
    return crypto.createHash('sha1').update(normalized).digest('hex');
}

function render(vl: any, id: string): string | null {
    const sf = path.join(OUT, `${id}.vl.json`);
    const gf = path.join(OUT, `${id}.svg`);
    fs.writeFileSync(sf, JSON.stringify(vl, null, 2));
    try {
        execFileSync(VL2SVG, [sf, gf], { maxBuffer: 1 << 26, stdio: 'pipe' });
        return fs.readFileSync(gf, 'utf-8');
    } catch (e: any) {
        return null;
    }
}

const session = loadSession(path.join(ROOT, 'py-src/data_formulator/example_analysis/Nic- FAA Wildlife Strikes/state.json'));

// ---- global measurement: how many encodings carry sortOrder / sortBy?
let nEnc = 0, nSortOrder = 0, nSortBy = 0;
for (const c of session.charts) {
    for (const [, e] of Object.entries<any>(c.spec.encodings)) {
        nEnc++;
        if (e.sortOrder) nSortOrder++;
        if (e.sortBy) nSortBy++;
    }
}
console.log(`CHARTS=${session.charts.length}  ENCODINGS=${nEnc}  withSortOrder=${nSortOrder}  withSortBy=${nSortBy}`);
// NOTE: lib.ts:80 does not copy sortBy out of the session, so nSortBy is
// structurally 0. Measure the raw session too.
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'py-src/data_formulator/example_analysis/Nic- FAA Wildlife Strikes/state.json'), 'utf-8'));
let rawSO = 0, rawSB = 0, rawEnc = 0;
const walk = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if ('fieldID' in o) { rawEnc++; if (o.sortOrder) rawSO++; if (o.sortBy) rawSB++; }
    Object.values(o).forEach(walk);
};
walk(raw);
console.log(`RAW session: encodings-with-fieldID=${rawEnc} sortOrder=${rawSO} sortBy=${rawSB}`);

console.log('');
const results: any[] = [];

session.charts.forEach((chart, i) => {
    const roles = chartRoles(chart);
    const mk = (mut: (s: any) => void) => { const s = cloneSpec(chart.spec) as any; mut(s); return s; };
    const catCh = roles.categoryCh, meaCh = roles.measureCh;

    const variants: Record<string, any> = { base: chart.spec };
    if (catCh) {
        variants['cat.sortOrder=asc'] = mk(s => { s.encodings[catCh].sortOrder = 'ascending'; });
        variants['cat.sortOrder=desc'] = mk(s => { s.encodings[catCh].sortOrder = 'descending'; });
    }
    if (catCh && meaCh) {
        variants['cat.sortBy=mea+asc'] = mk(s => { s.encodings[catCh].sortBy = meaCh; s.encodings[catCh].sortOrder = 'ascending'; });
        variants['cat.sortBy=mea+desc'] = mk(s => { s.encodings[catCh].sortBy = meaCh; s.encodings[catCh].sortOrder = 'descending'; });
        variants['cat.sortBy=mea+undef'] = mk(s => { s.encodings[catCh].sortBy = meaCh; });
    }
    if (meaCh) {
        variants['mea.sortOrder=asc(HEADbug)'] = mk(s => { s.encodings[meaCh].sortOrder = 'ascending'; });
        variants['mea.sortOrder=desc'] = mk(s => { s.encodings[meaCh].sortOrder = 'descending'; });
    }
    // explicit reversed category array lever
    if (catCh) {
        const f = chart.spec.encodings[catCh].field;
        const seen: any[] = [];
        for (const r of chart.rows) { const v = r[f]; if (v !== undefined && !seen.includes(v)) seen.push(v); }
        variants['cat.sortBy=REVARRAY'] = mk(s => { s.encodings[catCh].sortBy = JSON.stringify([...seen].reverse()); });
    }

    const hashes: Record<string, string> = {};
    const vlSorts: Record<string, any> = {};
    for (const [name, spec] of Object.entries(variants)) {
        const id = `c${i}_${name.replace(/[^a-z0-9]/gi, '_')}`;
        let vl: any;
        try { vl = compileToVegaLite(spec, chart.rows, chart.metadata); }
        catch (e: any) { hashes[name] = 'COMPILE-FAIL'; continue; }
        // record what sort ended up on the category channel in the VL JSON
        const findSort = (o: any, ch: string): any => {
            if (!o || typeof o !== 'object') return undefined;
            if (o.encoding && o.encoding[ch] && 'sort' in o.encoding[ch]) return o.encoding[ch].sort;
            for (const v of Object.values(o)) { const r = findSort(v, ch); if (r !== undefined) return r; }
            return undefined;
        };
        vlSorts[name] = catCh ? JSON.stringify(findSort(vl, catCh))?.slice(0, 60) : undefined;
        const svg = render(vl, id);
        hashes[name] = svg ? renderHash(svg) : 'RENDER-FAIL';
    }

    const b = hashes['base'];
    const cmp: Record<string, string> = {};
    for (const [n, h] of Object.entries(hashes)) {
        if (n === 'base') continue;
        cmp[n] = h === b ? 'SAME' : (h.includes('FAIL') ? h : 'DIFFERS');
    }
    console.log(`[${i}] ${chart.spec.chartType} | "${chart.title}" | catCh=${catCh}(${roles.category}) meaCh=${meaCh}(${roles.measure})`);
    for (const [n, v] of Object.entries(cmp)) {
        console.log(`      ${v.padEnd(11)} ${n.padEnd(24)} vlSort[${catCh}]=${vlSorts[n]}`);
    }
    results.push({ i, type: chart.spec.chartType, title: chart.title, catCh, meaCh, cmp, vlSorts });
});

fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
