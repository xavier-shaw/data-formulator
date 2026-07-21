// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Human-readable display name for a chart.
//
// `chart.title` only exists for charts the analyst agent produced (it comes
// from the `visualize` action's refined goal) — charts the user builds by
// dragging fields onto the encoding shelf have none. Anywhere a chart is
// listed rather than rendered (the analysis graph's nodes and side panel), a
// raw `chart-1750112233456` id is useless, so fall back to a name derived from
// what the chart actually encodes: "sum(Damage) by Species".

import { Chart, FieldItem, computeInsightKey } from '../components/ComponentType';

// The measure (what is being shown) and the breakdown (what it is shown
// against), each in preference order. A chart normally has one of each.
const VALUE_CHANNELS = ['y', 'theta', 'size', 'text', 'radius'];
const CATEGORY_CHANNELS = ['x', 'color', 'column', 'row', 'shape', 'detail'];

/** Field name for one encoding, wrapped in its aggregate when there is one. */
const encodingLabel = (
    enc: { fieldID?: string; aggregate?: string } | undefined,
    fieldsById: Map<string, FieldItem>,
): string => {
    if (!enc?.fieldID) return '';
    const name = fieldsById.get(enc.fieldID)?.name || '';
    if (!name) return '';
    return enc.aggregate ? `${enc.aggregate}(${name})` : name;
};

/** "sum(Damage) by Species" — built from the chart's encoded channels. */
export const deriveChartName = (chart: Chart, fieldsById: Map<string, FieldItem>): string => {
    const map = (chart.encodingMap || {}) as Record<string, { fieldID?: string; aggregate?: string }>;
    const labelOf = (channel: string) => encodingLabel(map[channel], fieldsById);

    const valueChannel = VALUE_CHANNELS.find(c => labelOf(c));
    const categoryChannel = CATEGORY_CHANNELS.find(c => labelOf(c));
    let value = valueChannel ? labelOf(valueChannel) : '';
    let category = categoryChannel ? labelOf(categoryChannel) : '';

    // A horizontal bar puts the measure on x and the category on y, which the
    // channel order above reads backwards. The aggregate marks the real
    // measure, so swap when it sits on the channel we called the category.
    if (valueChannel && categoryChannel
        && map[categoryChannel]?.aggregate && !map[valueChannel]?.aggregate) {
        [value, category] = [category, value];
    }

    if (value && category) {
        // A third encoded field (e.g. color alongside x/y) is worth naming too,
        // but only as a trailing qualifier so the main phrase stays readable.
        const extra = CATEGORY_CHANNELS.map(labelOf)
            .find(l => l && l !== category && l !== value);
        return extra ? `${value} by ${category} · ${extra}` : `${value} by ${category}`;
    }
    if (value || category) return value || category;

    // No recognized channel — fall back to whatever fields are encoded at all.
    const any = Object.keys(map).map(labelOf).filter(Boolean);
    return any.slice(0, 2).join(' · ');
};

/**
 * Display name for a chart, never an id.
 *
 * Precedence: the agent's title when it still matches the chart's encodings
 * (the same freshness rule VisualizationView uses to decide whether to draw
 * the title on the canvas), then a name derived from the encodings, then the
 * chart type.
 */
export const chartDisplayTitle = (chart: Chart, fieldsById: Map<string, FieldItem>): string => {
    const title = (chart.title || '').trim();
    // A title with no titleKey predates staleness tracking — trust it.
    if (title && (!chart.titleKey || chart.titleKey === computeInsightKey(chart))) return title;
    return deriveChartName(chart, fieldsById) || title || chart.chartType || 'Untitled chart';
};
