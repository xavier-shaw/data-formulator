import { describe, expect, it } from 'vitest';
import { Chart, DictTable, FieldItem } from '../../../../src/components/ComponentType';
import { Type } from '../../../../src/data/types';
import { ROOT_ID, STATE_ID_SEP, buildAnalysisTree } from '../../../../src/app/analysisGraph';

// The analysis tree is Battle & Heer's search tree: the session is a SEQUENCE
// of state visits (charts ordered by time); consecutive visits type the raw
// transitions (forward / backward / self-loop / pivot); first-seen states
// attach under the largest previously-visited subset (root when none).

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

// chart with explicit visit time (drives the sequence)
const chart = (id: string, tableRef: string, fieldNames: string[], t: number, title?: string): Chart => ({
    id, chartType: 'Bar Chart', tableRef, source: 'user', title,
    createdAt: t,
    encodingMap: Object.fromEntries(
        fieldNames.map((n, i) => [['x', 'y', 'color'][i], { fieldID: `${tableRef}--${n}` }]),
    ) as any,
} as Chart);

const sid = (...attrs: string[]) => [...attrs].sort().join(STATE_ID_SEP);

/**
 * Mini FAA-shaped session. Visit sequence (by t):
 *   1. {PHASE}            t=1   (new → root)
 *   2. {PHASE}            t=2   (self-loop)
 *   3. {AIRPORT}          t=3   (pivot, no visited subset → root)
 *   4. {DAMAGE, HEIGHT}   t=4   (pivot → root)
 *   5. {DAMAGE, PHASE}    t=5   (pivot; visited subset {PHASE} → child of {PHASE})
 *   6. {AIRPORT}          t=6   (pivot back = revisit)
 *   7. {AIRPORT, SPECIES} t=7   (forward from {AIRPORT} → its child)
 */
const buildFixture = () => {
    const raw = rawTable('src', ['AIRPORT', 'SPECIES', 'DAMAGE', 'PHASE', 'HEIGHT']);
    const tPhase = derivedTable('t_phase', `d = df[['PHASE']]`, ['src'], ['PHASE', 'n']);
    const tAirport = derivedTable('t_airport', `d = df[['AIRPORT']]`, ['src'], ['AIRPORT', 'n']);
    const tHeightDmg = derivedTable('t_hd', `d = df[['HEIGHT','DAMAGE']]`, ['src'], ['HEIGHT', 'rate']);
    const tPhaseDmg = derivedTable('t_pd', `d = df[['PHASE','DAMAGE']]`, ['src'], ['PHASE', 'rate']);
    const tAirSpecies = derivedTable('t_as', `d = df[df['SPECIES'] == 'Deer'][['AIRPORT']]`, ['src'], ['AIRPORT', 'rate']);

    const tables = [raw, tPhase, tAirport, tHeightDmg, tPhaseDmg, tAirSpecies];
    const conceptShelfItems = tables.flatMap(t => t.names.map(n => field(n, t.id)));
    const charts = [
        // deliberately out of array order — the sequence must follow time
        chart('chart-7000000000007', 't_as', ['AIRPORT', 'rate'], 7, 'Deer airports'),
        chart('chart-1000000000001', 't_phase', ['PHASE', 'n'], 1, 'Strikes by phase'),
        chart('chart-2000000000002', 't_phase', ['PHASE', 'n'], 2, 'Normalized by phase'),
        chart('chart-3000000000003', 't_airport', ['AIRPORT', 'n'], 3, 'Top airports'),
        chart('chart-4000000000004', 't_hd', ['HEIGHT', 'rate'], 4, 'Damage by height'),
        chart('chart-5000000000005', 't_pd', ['PHASE', 'rate'], 5, 'Damage by phase'),
        chart('chart-6000000000006', 't_airport', ['AIRPORT', 'n'], 6, 'Airports again'),
    ];
    return { charts, tables, conceptShelfItems };
};

// ── tests ────────────────────────────────────────────────────────────────────

describe('buildAnalysisTree', () => {
    it('walks the visit sequence in time order and types the raw transitions', () => {
        const f = buildFixture();
        const tree = buildAnalysisTree(f.charts, f.tables, f.conceptShelfItems);

        expect(tree.transitions.map(tr => tr.kind)).toEqual([
            'self-loop',   // {PHASE} → {PHASE}
            'pivot',       // {PHASE} → {AIRPORT}
            'pivot',       // {AIRPORT} → {DAMAGE,HEIGHT}
            'pivot',       // {DAMAGE,HEIGHT} → {DAMAGE,PHASE}
            'pivot',       // {DAMAGE,PHASE} → {AIRPORT}   (return)
            'forward',     // {AIRPORT} → {AIRPORT,SPECIES}
        ]);
    });

    it('builds the search tree: parents are the largest previously-visited subset', () => {
        const f = buildFixture();
        const tree = buildAnalysisTree(f.charts, f.tables, f.conceptShelfItems);
        const byId = new Map(tree.nodes.map(n => [n.id, n]));

        expect(byId.get(sid('PHASE'))!.parentId).toBe(ROOT_ID);
        expect(byId.get(sid('AIRPORT'))!.parentId).toBe(ROOT_ID);
        expect(byId.get(sid('DAMAGE', 'HEIGHT'))!.parentId).toBe(ROOT_ID);
        // pivot that extends an earlier state attaches under it, not the root
        expect(byId.get(sid('DAMAGE', 'PHASE'))!.parentId).toBe(sid('PHASE'));
        // plain forward transition attaches under the previous state
        expect(byId.get(sid('AIRPORT', 'SPECIES'))!.parentId).toBe(sid('AIRPORT'));
        expect(byId.get(sid('AIRPORT', 'SPECIES'))!.depth).toBe(2);
    });

    it('counts self-loops, visits, and revisits per state', () => {
        const f = buildFixture();
        const tree = buildAnalysisTree(f.charts, f.tables, f.conceptShelfItems);
        const byId = new Map(tree.nodes.map(n => [n.id, n]));

        const phase = byId.get(sid('PHASE'))!;
        expect(phase.visits).toBe(2);
        expect(phase.selfLoops).toBe(1);   // consecutive re-realization
        expect(phase.revisits).toBe(0);

        const airport = byId.get(sid('AIRPORT'))!;
        expect(airport.visits).toBe(2);
        expect(airport.selfLoops).toBe(0);
        expect(airport.revisits).toBe(1);  // returned after leaving
    });

    it('computes B&H tree-shape metrics: depth = commitment, breadth = trajectories', () => {
        const f = buildFixture();
        const tree = buildAnalysisTree(f.charts, f.tables, f.conceptShelfItems);
        const m = tree.metrics;

        expect(m.chartCount).toBe(7);
        expect(m.stateCount).toBe(5);
        expect(m.height).toBe(2);          // …→{AIRPORT}→{AIRPORT,SPECIES}
        expect(m.leafCount).toBe(3);       // {DAMAGE,HEIGHT}, {DAMAGE,PHASE}, {AIRPORT,SPECIES}
        expect(m.maxWidth).toBe(3);        // level 1: {PHASE},{AIRPORT},{DAMAGE,HEIGHT}
        expect(m.aspectRatio).toBe(1.5);
        expect(m.totalSelfLoops).toBe(1);
        expect(m.revisitedStates).toBe(1);

        // trajectories carry effort (visits incl. self-loops along the path)
        const deer = m.trajectories.find(tr => tr.leafId === sid('AIRPORT', 'SPECIES'))!;
        expect(deer.stateIds).toEqual([sid('AIRPORT'), sid('AIRPORT', 'SPECIES')]);
        expect(deer.totalVisits).toBe(3);  // AIRPORT×2 + AIRPORT,SPECIES×1
    });

    it('is deterministic: same input, same output', () => {
        const f = buildFixture();
        const a = buildAnalysisTree(f.charts, f.tables, f.conceptShelfItems);
        const b = buildAnalysisTree(f.charts, f.tables, f.conceptShelfItems);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it('falls back to encoded fields when no raw columns resolve', () => {
        const raw = rawTable('src', ['A', 'B']);
        const cs = [field('A', 'src'), field('B', 'src')];
        const tree = buildAnalysisTree([chart('chart-9000000000009', 'src', ['A', 'B'], 1)], [raw], cs);
        expect(tree.nodes).toHaveLength(1);
        expect(tree.nodes[0].attributes).toEqual(['A', 'B']);
        expect(tree.nodes[0].parentId).toBe(ROOT_ID);
        expect(tree.metrics.leafCount).toBe(1);
    });
});
