// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Semantic analysis threads — the LLM-clustered counterpart of the hybrid
// analysis graph (analysisHybridGraph.ts).
//
// The hybrid graph derives structure deterministically from attribute-set
// lineage, which cannot tell apart two DIRECTIONS of inquiry that happen to
// share columns (or split one direction that touches different columns). Here
// the charts' titles, attribute sets, and driving prompts are sent to a
// language model, which groups them into SEMANTIC THREADS: one thread per
// topic the analyst pursued, charts ordered as a narrative progression within
// it. Breadth = number of threads; depth = how far a thread goes.
//
// Chart numbering (#1..#N by creation time) uses the same eligibility rules as
// buildHybridGraph — user charts on known tables with non-empty attribute
// sets — so a chart keeps its number across both views.

import { Chart, DictTable, FieldItem } from '../components/ComponentType';
import { chartAttributeSet } from './analysisGraph';
import { PromptSource, chartTime, promptOfTable } from './analysisHybridGraph';
import { chartDisplayTitle } from './chartTitle';
import { apiRequest } from './apiClient';
import { getUrls } from './utils';

export interface SemanticChartItem {
    num: number;                // creation-time index, aligned with the hybrid view
    chartId: string;
    chartType: string;
    title: string;              // display name — never an id (see chartTitle.ts)
    attributes: string[];
    prompt: string;             // the user question / agent instruction behind it
    promptSource: PromptSource;
    datasetName: string;        // source dataset at the top of the lineage
}

export interface SemanticThread {
    topic: string;
    summary: string;
    charts: SemanticChartItem[];
    /** True for the catch-all bucket of charts the model failed to assign. */
    isFallback: boolean;
}

export interface SemanticThreadsResult {
    threads: SemanticThread[];
    metrics: { chartCount: number; threadCount: number; maxThreadLength: number };
}

/** Every committed chart as a clustering input, ordered/numbered by creation time. */
export const collectSemanticChartItems = (
    tables: DictTable[],
    charts: Chart[],
    conceptShelfItems: FieldItem[],
): SemanticChartItem[] => {
    const tablesById = new Map(tables.map(t => [t.id, t]));
    const fieldsById = new Map(conceptShelfItems.map(f => [f.id, f]));

    const universe = new Set<string>();
    for (const t of tables) if (!t.derive) for (const n of t.names || []) universe.add(n);
    const memo = new Map<string, Set<string>>();

    // Source dataset at the top of a table's lineage.
    const datasetOf = (tableId: string): DictTable | undefined => {
        const seen = new Set<string>();
        let cur: DictTable | undefined = tablesById.get(tableId);
        while (cur && cur.derive && !seen.has(cur.id)) {
            seen.add(cur.id);
            const next = cur.derive.trigger?.tableId || cur.derive.source?.[0];
            cur = next ? tablesById.get(next) : undefined;
        }
        return cur;
    };

    const visits: { chart: Chart; table: DictTable; attrs: string[]; t: number }[] = [];
    for (const chart of charts) {
        if ((chart.source ?? 'user') !== 'user') continue;
        const table = tablesById.get(chart.tableRef);
        if (!table) continue;
        const { attrs } = chartAttributeSet(chart, tablesById, fieldsById, universe, memo);
        if (attrs.size === 0) continue;
        visits.push({ chart, table, attrs: [...attrs].sort(), t: chartTime(chart, table) });
    }
    visits.sort((a, b) => a.t - b.t);

    return visits.map((v, i) => {
        const { text, source } = promptOfTable(v.table);
        const dataset = datasetOf(v.table.id);
        return {
            num: i + 1,
            chartId: v.chart.id,
            chartType: v.chart.chartType,
            title: chartDisplayTitle(v.chart, fieldsById),
            attributes: v.attrs,
            prompt: text,
            promptSource: source,
            datasetName: dataset?.displayId || dataset?.id || v.table.id,
        };
    });
};

/** Stable key for caching a clustering result: changes iff the inputs change. */
export const semanticThreadsSignature = (items: SemanticChartItem[]): string =>
    items.map(i => `${i.chartId}${i.title}${i.attributes.join(',')}`).join('');

/**
 * Normalize the model's thread assignment against the actual chart list:
 * unknown numbers are dropped, a chart claimed by several threads stays with
 * the first, empty threads disappear, and anything left unassigned lands in a
 * trailing fallback bucket. Thread order and within-thread chart order are the
 * model's (that ordering — semantic, not chronological — is the point).
 */
export const normalizeSemanticThreads = (
    raw: { threads?: { topic?: string; summary?: string; charts?: number[] }[] } | null | undefined,
    items: SemanticChartItem[],
): SemanticThreadsResult => {
    const byNum = new Map(items.map(i => [i.num, i]));
    const used = new Set<number>();
    const threads: SemanticThread[] = [];

    for (const t of raw?.threads || []) {
        const charts: SemanticChartItem[] = [];
        for (const n of t.charts || []) {
            const item = byNum.get(n);
            if (!item || used.has(n)) continue;
            used.add(n);
            charts.push(item);
        }
        if (charts.length === 0) continue;
        threads.push({
            topic: (t.topic || '').trim() || `Thread ${threads.length + 1}`,
            summary: (t.summary || '').trim(),
            charts,
            isFallback: false,
        });
    }

    const leftover = items.filter(i => !used.has(i.num));
    if (leftover.length > 0) {
        threads.push({
            topic: 'Ungrouped',
            summary: 'Charts the model did not assign to any topic.',
            charts: leftover,
            isFallback: true,
        });
    }

    return {
        threads,
        metrics: {
            chartCount: items.length,
            threadCount: threads.length,
            maxThreadLength: threads.length ? Math.max(...threads.map(t => t.charts.length)) : 0,
        },
    };
};

/** One clustering round-trip: POST the chart list, normalize what comes back. */
export const fetchSemanticThreads = async (
    items: SemanticChartItem[],
    model: any,
): Promise<SemanticThreadsResult> => {
    if (items.length === 0) return normalizeSemanticThreads({ threads: [] }, items);
    const datasets = [...new Set(items.map(i => i.datasetName))];
    const { data } = await apiRequest(getUrls().SEMANTIC_THREADS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            datasets,
            charts: items.map(i => ({
                num: i.num,
                title: i.title,
                attributes: i.attributes,
                prompt: i.prompt,
            })),
        }),
    });
    return normalizeSemanticThreads(data, items);
};
