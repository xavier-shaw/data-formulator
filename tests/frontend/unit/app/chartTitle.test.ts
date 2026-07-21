import { describe, expect, it } from 'vitest';
import { Chart, FieldItem, computeInsightKey } from '../../../../src/components/ComponentType';
import { chartDisplayTitle, deriveChartName } from '../../../../src/app/chartTitle';

// Charts only carry a `title` when the analyst agent made them; hand-built
// charts have none. Everywhere a chart is listed rather than drawn (the
// analysis graph) the display name must still be meaningful — never the raw
// `chart-1750112233456` id.

const field = (id: string, name: string): FieldItem => ({ id, name } as FieldItem);

const fields = new Map<string, FieldItem>([
    ['f-damage', field('f-damage', 'Damage')],
    ['f-species', field('f-species', 'Species')],
    ['f-airport', field('f-airport', 'Airport')],
]);

const chart = (encodings: Record<string, { fieldID?: string; aggregate?: string }>, extra: Partial<Chart> = {}): Chart =>
    ({
        id: 'chart-1750112233456', chartType: 'Bar Chart', tableRef: 't1', source: 'user',
        encodingMap: encodings as any, ...extra,
    } as Chart);

describe('deriveChartName', () => {
    it('names a chart "measure by breakdown" from its encodings', () => {
        const c = chart({ x: { fieldID: 'f-species' }, y: { fieldID: 'f-damage' } });
        expect(deriveChartName(c, fields)).toBe('Damage by Species');
    });

    it('wraps the aggregate around the field name', () => {
        const c = chart({ x: { fieldID: 'f-species' }, y: { fieldID: 'f-damage', aggregate: 'sum' } });
        expect(deriveChartName(c, fields)).toBe('sum(Damage) by Species');
    });

    it('appends a third encoded field as a trailing qualifier', () => {
        const c = chart({
            x: { fieldID: 'f-species' }, y: { fieldID: 'f-damage' }, color: { fieldID: 'f-airport' },
        });
        expect(deriveChartName(c, fields)).toBe('Damage by Species · Airport');
    });

    it('reads a horizontal bar the right way round (measure on x)', () => {
        const c = chart({
            x: { fieldID: 'f-damage', aggregate: 'sum' }, y: { fieldID: 'f-species' },
        });
        expect(deriveChartName(c, fields)).toBe('sum(Damage) by Species');
    });

    it('falls back to the single encoded field when only one channel is bound', () => {
        expect(deriveChartName(chart({ x: { fieldID: 'f-species' } }), fields)).toBe('Species');
        expect(deriveChartName(chart({ y: { fieldID: 'f-damage' } }), fields)).toBe('Damage');
    });

    it('returns empty when nothing is encoded or fields are unknown', () => {
        expect(deriveChartName(chart({}), fields)).toBe('');
        expect(deriveChartName(chart({ x: { fieldID: 'missing' } }), fields)).toBe('');
    });
});

describe('chartDisplayTitle', () => {
    it('prefers the agent title when it still matches the encodings', () => {
        const base = chart({ x: { fieldID: 'f-species' }, y: { fieldID: 'f-damage' } });
        const c = { ...base, title: 'Which species cause the worst damage', titleKey: computeInsightKey(base) };
        expect(chartDisplayTitle(c, fields)).toBe('Which species cause the worst damage');
    });

    it('trusts a title that predates staleness tracking (no titleKey)', () => {
        const c = chart({ x: { fieldID: 'f-species' } }, { title: 'Legacy title' });
        expect(chartDisplayTitle(c, fields)).toBe('Legacy title');
    });

    it('derives a fresh name when the stored title went stale', () => {
        const c = chart(
            { x: { fieldID: 'f-species' }, y: { fieldID: 'f-damage' } },
            { title: 'Old title about other fields', titleKey: 'Bar Chart|f-something-else' },
        );
        expect(chartDisplayTitle(c, fields)).toBe('Damage by Species');
    });

    it('falls back to the chart type, never the id', () => {
        const c = chart({});
        expect(chartDisplayTitle(c, fields)).toBe('Bar Chart');
        expect(chartDisplayTitle(c, fields)).not.toContain('chart-');
    });
});
