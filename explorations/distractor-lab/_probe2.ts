// TEMPORARY verification probe — delete after use.
// Q2: is `Bar Chart == Stacked Bar Chart` really UNCONDITIONAL?
import { compileToVegaLite, ChartLevelSpec, FieldMeta } from './lib';

function canon(v: any): any {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
        const o: any = {};
        for (const k of Object.keys(v).sort()) {
            if (k === '_warnings' || k === '_options') continue;   // keep _width/_height: they ARE visual
            o[k] = canon(v[k]);
        }
        return o;
    }
    return v;
}
const K = (vl: any) => JSON.stringify(canon(vl));

function mkTable(nCat: number, nSeries: number) {
    const rows: any[] = [];
    for (let i = 0; i < nCat; i++)
        for (let s = 0; s < nSeries; s++)
            rows.push({ cat: `C${i}`, series: `S${s}`, val: 10 + ((i * 7 + s * 3) % 40) });
    const metadata: Record<string, FieldMeta> = {
        cat: { type: 'string', semanticType: 'Category', levels: [] },
        series: { type: 'string', semanticType: 'Category', levels: [] },
        val: { type: 'number', semanticType: 'Quantity', levels: [] },
    };
    return { rows, metadata };
}

function cmp(tag: string, a: string, b: string, enc: any, rows: any[], metadata: any) {
    const mk = (ct: string): ChartLevelSpec => ({ chartType: ct, encodings: enc, config: {} });
    let ka = '', kb = '', wa: any, wb: any;
    try { const v = compileToVegaLite(mk(a), rows, metadata); ka = K(v); wa = [v._width, v._height]; } catch (e: any) { ka = 'ERR ' + e.message; }
    try { const v = compileToVegaLite(mk(b), rows, metadata); kb = K(v); wb = [v._width, v._height]; } catch (e: any) { kb = 'ERR ' + e.message; }
    console.log(`${ka === kb ? 'IDENTICAL' : 'DIFFERENT'}  ${tag}: ${a} vs ${b}   size ${JSON.stringify(wa)} / ${JSON.stringify(wb)}`);
    if (ka !== kb && !ka.startsWith('ERR') && !kb.startsWith('ERR')) {
        // show first divergence
        for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
            if (ka[i] !== kb[i]) { console.log(`    diverge@${i}: ...${ka.slice(Math.max(0, i - 60), i + 60)}\n              vs ...${kb.slice(Math.max(0, i - 60), i + 60)}`); break; }
        }
    }
    return ka === kb;
}

console.log('--- no series (x=cat, y=val) ---');
{
    const { rows, metadata } = mkTable(6, 1);
    const enc = { x: { field: 'cat' }, y: { field: 'val' } };
    cmp('nocolor', 'Bar Chart', 'Stacked Bar Chart', enc, rows, metadata);
    cmp('nocolor', 'Bar Chart', 'Grouped Bar Chart', enc, rows, metadata);
    cmp('nocolor', 'Bar Chart', 'Custom Bar', enc, rows, metadata);
}
console.log('\n--- WITH a color series, few series (3) ---');
for (const nS of [2, 3, 5, 8, 10, 11, 12, 15, 20, 30]) {
    const { rows, metadata } = mkTable(6, nS);
    const enc = { x: { field: 'cat' }, y: { field: 'val' }, color: { field: 'series' } };
    cmp(`nSeries=${nS}`, 'Bar Chart', 'Stacked Bar Chart', enc, rows, metadata);
}
console.log('\n--- group channel present (Grouped Bar with real group) ---');
{
    const { rows, metadata } = mkTable(6, 3);
    const encG = { x: { field: 'cat' }, y: { field: 'val' }, group: { field: 'series' } };
    cmp('group', 'Grouped Bar Chart', 'Bar Chart', encG, rows, metadata);
}
console.log('\n--- line / area aliases ---');
{
    const rows: any[] = [];
    for (let i = 0; i < 12; i++) rows.push({ t: i, val: 10 + ((i * 7) % 30) });
    const metadata: any = { t: { type: 'number', semanticType: 'Number', levels: [] }, val: { type: 'number', semanticType: 'Quantity', levels: [] } };
    const enc = { x: { field: 't' }, y: { field: 'val' } };
    cmp('line', 'Line Chart', 'Custom Line', enc, rows, metadata);
    cmp('area', 'Area Chart', 'Custom Area', enc, rows, metadata);
    cmp('scatter', 'Scatter Plot', 'Custom Point', enc, rows, metadata);
}
