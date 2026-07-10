import { describe, expect, it } from 'vitest';
import { Chart, DictTable, FieldItem } from '../../../../src/components/ComponentType';
import { Type } from '../../../../src/data/types';
import { buildAnalysisGraph, STATE_ID_SEP } from '../../../../src/app/analysisGraph';

// ── fixture helpers ──────────────────────────────────────────────────────────

const field = (name: string, tableRef: string): FieldItem =>
    ({ id: `${tableRef}--${name}`, name, source: 'original', tableRef } as FieldItem);

const rawTable = (id: string, cols: string[]): DictTable => ({
    kind: 'table', id, displayId: id, names: cols,
    metadata: Object.fromEntries(cols.map(c => [c, { type: Type.String, semanticType: '', levels: [] }])) as any,
    rows: [], virtual: { tableId: id, rowCount: 0 }, anchored: true, description: '',
});

const derivedTable = (id: string, code: string, source: string[], cols: string[]): DictTable => ({
    ...rawTable(id, cols), anchored: false,
    derive: { source, code, outputVariable: 'df', dialog: [], trigger: { tableId: source[0], resultTableId: id } },
});

const chart = (id: string, tableRef: string, fieldNames: string[], title?: string): Chart => ({
    id, chartType: 'Bar Chart', tableRef, source: 'user', title,
    encodingMap: Object.fromEntries(
        fieldNames.map((n, i) => [['x', 'y', 'color'][i], { fieldID: `${tableRef}--${n}` }]),
    ) as any,
});

// Mirrors the FAA session shape: raw source table; derived tables whose code
// references raw columns; charts encoding derived measure columns.
const buildFixture = () => {
    const raw = rawTable('src', ['AIRPORT', 'SPECIES', 'DAMAGE', 'PHASE', 'HEIGHT']);
    const tAirport = derivedTable('t_airport', `df = read('src')[['AIRPORT']].value_counts()`, ['src'], ['AIRPORT', 'n']);
    const tAirportSpecies = derivedTable('t_as', `df = g[df['AIRPORT'] == x]; df.groupby(['AIRPORT','SPECIES'])`, ['src'], ['AIRPORT', 'rate']);
    const tPhaseDamage = derivedTable('t_pd', `d = df[['PHASE','DAMAGE']].groupby('PHASE')`, ['src'], ['PHASE', 'dmg_rate']);
    const tHeightDamage = derivedTable('t_hd', `d = df[['HEIGHT','DAMAGE']]`, ['src'], ['HEIGHT', 'dmg_rate']);

    const tables = [raw, tAirport, tAirportSpecies, tPhaseDamage, tHeightDamage];
    const conceptShelfItems = tables.flatMap(t => t.names.map(n => field(n, t.id)));
    const charts = [
        chart('chart-1000000000001', 't_airport', ['AIRPORT', 'n'], 'Top airports'),
        chart('chart-1000000000002', 't_as', ['AIRPORT', 'rate'], 'Deer strike rates'),
        chart('chart-1000000000003', 't_as', ['AIRPORT', 'rate'], 'Deer strike rates v2'),  // dup state
        chart('chart-1000000000004', 't_pd', ['PHASE', 'dmg_rate'], 'Damage by phase'),
        chart('chart-1000000000005', 't_hd', ['HEIGHT', 'dmg_rate'], 'Damage by height'),
    ];
    return { charts, tables, conceptShelfItems };
};

// ── tests ────────────────────────────────────────────────────────────────────

describe('buildAnalysisGraph', () => {
    it('canonicalizes charts to raw-attribute sets and dedupes into states', () => {
        const f = buildFixture();
        const g = buildAnalysisGraph(f.charts, f.tables, f.conceptShelfItems);

        // 5 charts -> 4 states ({AIRPORT}, {AIRPORT,SPECIES} x2 charts, {DAMAGE,PHASE}, {DAMAGE,HEIGHT})
        expect(g.metrics.chartCount).toBe(5);
        expect(g.metrics.stateCount).toBe(4);

        const ids = g.nodes.map(n => n.id);
        expect(ids).toContain('AIRPORT');
        expect(ids).toContain(['AIRPORT', 'SPECIES'].join(STATE_ID_SEP));
        expect(ids).toContain(['DAMAGE', 'PHASE'].join(STATE_ID_SEP));
        expect(ids).toContain(['DAMAGE', 'HEIGHT'].join(STATE_ID_SEP));

        // the duplicated state carries both charts
        const dup = g.nodes.find(n => n.id === ['AIRPORT', 'SPECIES'].join(STATE_ID_SEP))!;
        expect(dup.charts).toHaveLength(2);
        // derived measures are node properties, not identity
        expect(dup.charts[0].encodedFields).toContain('rate');
    });

    it('draws containment (refinement) edges as immediate covers', () => {
        const f = buildFixture();
        const g = buildAnalysisGraph(f.charts, f.tables, f.conceptShelfItems);
        const refinements = g.edges.filter(e => e.kind === 'refinement');
        expect(refinements).toEqual([
            { source: 'AIRPORT', target: ['AIRPORT', 'SPECIES'].join(STATE_ID_SEP), kind: 'refinement' },
        ]);
        // depth level follows the chain
        const child = g.nodes.find(n => n.id === ['AIRPORT', 'SPECIES'].join(STATE_ID_SEP))!;
        expect(child.depthLevel).toBe(2);
        expect(g.metrics.maxDepth).toBe(2);
        expect(g.metrics.deepestChain).toEqual(['AIRPORT', ['AIRPORT', 'SPECIES'].join(STATE_ID_SEP)]);
    });

    it('connects thematic hubs via overlap spanning-forest without containment', () => {
        const f = buildFixture();
        const g = buildAnalysisGraph(f.charts, f.tables, f.conceptShelfItems);
        // {DAMAGE,PHASE} and {DAMAGE,HEIGHT} share DAMAGE (jaccard 1/3) but have
        // no subset relation — must be linked by exactly one overlap edge.
        const overlaps = g.edges.filter(e => e.kind === 'overlap');
        const hub = overlaps.find(e =>
            [e.source, e.target].sort().join('|') ===
            [['DAMAGE', 'HEIGHT'].join(STATE_ID_SEP), ['DAMAGE', 'PHASE'].join(STATE_ID_SEP)].sort().join('|'));
        expect(hub).toBeDefined();
        expect(hub!.shared).toEqual(['DAMAGE']);
        // spanning forest: no overlap edge duplicates an existing connection
        expect(overlaps.length).toBeLessThanOrEqual(g.metrics.stateCount - 1);
    });

    it('computes components, anchors, breadth, and coverage', () => {
        const f = buildFixture();
        const g = buildAnalysisGraph(f.charts, f.tables, f.conceptShelfItems);
        // AIRPORT line and DAMAGE hub are separate components (no shared attrs)
        expect(g.metrics.componentCount).toBe(2);
        const damageComp = g.components.find(c =>
            c.nodeIds.includes(['DAMAGE', 'PHASE'].join(STATE_ID_SEP)))!;
        expect(damageComp.anchorAttributes).toEqual(['DAMAGE']);
        expect(g.metrics.attributeCoverage).toEqual({ used: 5, total: 5 });
        expect(g.metrics.maxBreadth).toBe(3); // three level-1 states
        expect(g.metrics.leafCount).toBe(3);  // maximal states
        // attribute stats: DAMAGE analyzed in 2 states
        const dmg = g.metrics.attributeStats.find(a => a.name === 'DAMAGE')!;
        expect(dmg.states).toBe(2);
    });

    it('is a pure function: same input, same output', () => {
        const f = buildFixture();
        const a = buildAnalysisGraph(f.charts, f.tables, f.conceptShelfItems);
        const b = buildAnalysisGraph(f.charts, f.tables, f.conceptShelfItems);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it('falls back to encoded fields when no raw columns resolve', () => {
        // chart directly on a raw table encodes raw fields
        const raw = rawTable('src', ['A', 'B']);
        const cs = [field('A', 'src'), field('B', 'src')];
        const g = buildAnalysisGraph([chart('chart-1000000000009', 'src', ['A', 'B'])], [raw], cs);
        expect(g.nodes).toHaveLength(1);
        expect(g.nodes[0].attributes).toEqual(['A', 'B']);
    });
});
