// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * quiz-distractors/extract.ts — session extraction + chart compilation.
 *
 * Reconstructs each user-created chart of a Data Formulator session as a
 * *chart-level spec* (chartType + field-name-based encodings + rows +
 * metadata), and compiles those specs through the same `assembleVegaLite`
 * pipeline the app itself uses — so a distractor is pixel-faithful to what the
 * participant actually saw.
 *
 * BROWSER-SAFE ON PURPOSE. `extractSession` takes a plain state *object*, not a
 * path, so one implementation serves both callers:
 *   • the app        — dfSlice state (live session) or loadWorkspace(id).state
 *   • the offline lab — JSON.parse of an exported state.json
 * Nothing here may import `fs`, `path`, or any other node built-in.
 */

import { assembleVegaLite } from '../agents-chart';

// ── Types ────────────────────────────────────────────────────────────────

export interface FieldMeta {
    type: string;            // 'string' | 'number' | ...
    semanticType: string;    // 'Category' | 'Count' | 'Percentage' | ...
    levels: any[];
    displayName?: string;
}

/** Chart-level spec: everything needed to compile one chart. */
export interface ChartLevelSpec {
    chartType: string;
    /**
     * channel -> field name (only channels that carry a field).
     * `sortBy` is a CHANNEL reference ('x' | 'y' | 'color'), not a field name —
     * that is what the assembler expects, and it is what turns `sortOrder` into
     * a by-value sort (VL's `"y"` / `"-y"` shorthand) rather than an
     * alphabetical one.
     */
    encodings: Record<string, { field: string; sortOrder?: string; sortBy?: string; aggregate?: string }>;
    config?: Record<string, any>;
}

export interface SessionChart {
    id: string;
    title: string;
    tableId: string;
    spec: ChartLevelSpec;
    rows: any[];
    metadata: Record<string, FieldMeta>;
    /** ms the chart held focus during the session (state.chartUsage); 0 if untracked */
    focusMs: number;
    /** number of times the chart was viewed */
    visits: number;
    /** true when the participant put the chart in their findings report */
    inReport: boolean;
}

export interface SessionData {
    charts: SessionChart[];
    /** tableId -> { rows, metadata } for every table in the session */
    tables: Record<string, { rows: any[]; metadata: Record<string, FieldMeta> }>;
    /** the original source table (largest, non-derived) for sibling-label pools */
    sourceTable?: { rows: any[]; metadata: Record<string, FieldMeta> };
}

// ── Session extraction ───────────────────────────────────────────────────

/**
 * Shape this reads out of a session. Satisfied identically by the persisted
 * state.json and by dfSlice's live state (see dfSlice's load path, which
 * restores these very fields), so either can be passed in.
 */
export interface SessionStateLike {
    charts?: any[];
    tables?: any[];
    conceptShelfItems?: any[];
    chartUsage?: Record<string, { focusMs?: number; visits?: number }>;
    /** "My findings" membership (dfSlice.findingsChartIds); absent in older sessions */
    findingsChartIds?: string[];
}

/**
 * Reconstruct the quizzable charts of a session from its state.
 *
 * Row sourcing: every chart takes `table.rows` — the same array its
 * distractors will be built and rendered from. That single choice matters more
 * than it looks: a virtual table's `rows` can be a server-sampled slice, so if
 * an original were rendered from one row set and its lures from another, the
 * render guard would compare charts that differ by row count alone and the
 * lures would be trivially distinguishable. One array per chart, always.
 */
export function extractSession(s: SessionStateLike): SessionData {
    const conceptName: Record<string, string> = {};
    for (const c of s.conceptShelfItems ?? []) conceptName[c.id] = c.name;

    // Per-chart viewing telemetry (chartUsageTelemetry.ts → state.chartUsage).
    // Absent in older sessions; treat missing entries as never focused.
    const usage: Record<string, { focusMs?: number; visits?: number }> = s.chartUsage ?? {};

    // Report membership — the charts the participant selected into "My
    // findings". A missing list means no report, so every chart counts as
    // intermediate.
    const inReport = new Set(s.findingsChartIds ?? []);

    const tables: SessionData['tables'] = {};
    let sourceTable: SessionData['sourceTable'];
    for (const t of s.tables ?? []) {
        tables[t.id] = { rows: t.rows ?? [], metadata: t.metadata ?? {} };
        if (!t.derive && (!sourceTable || (t.rows?.length ?? 0) > sourceTable.rows.length)) {
            sourceTable = tables[t.id];
        }
    }

    const charts: SessionChart[] = [];
    for (const c of s.charts ?? []) {
        if (c.chartType === 'Auto' || c.chartType === 'Table') continue;
        const table = tables[c.tableRef];
        if (!table || table.rows.length === 0) continue;

        const encodings: ChartLevelSpec['encodings'] = {};
        for (const [channel, enc] of Object.entries<any>(c.encodingMap ?? {})) {
            if (!enc?.fieldID) continue;
            const field = conceptName[enc.fieldID];
            if (!field) continue;
            encodings[channel] = { field };
            if (enc.sortOrder) encodings[channel].sortOrder = enc.sortOrder;
            if (enc.sortBy) encodings[channel].sortBy = enc.sortBy;
            if (enc.aggregate) encodings[channel].aggregate = enc.aggregate;
        }
        if (Object.keys(encodings).length === 0) continue;

        charts.push({
            id: c.id,
            title: c.title ?? c.id,
            tableId: c.tableRef,
            spec: { chartType: c.chartType, encodings, config: c.config ?? {} },
            rows: table.rows,
            metadata: table.metadata,
            focusMs: usage[c.id]?.focusMs ?? 0,
            visits: usage[c.id]?.visits ?? 0,
            inReport: inReport.has(c.id),
        });
    }

    return { charts, tables, sourceTable };
}

// ── Compilation (mirrors src/app/utils.tsx assembleVegaChart) ────────────

export const CANVAS = { width: 300, height: 220 };

export function compileToVegaLite(
    spec: ChartLevelSpec,
    rows: any[],
    metadata: Record<string, FieldMeta>,
): any {
    const semanticTypes: Record<string, string> = {};
    const displayNames: Record<string, string> = {};
    for (const [name, meta] of Object.entries(metadata)) {
        if (meta.semanticType) semanticTypes[name] = meta.semanticType;
        if (meta.displayName) displayNames[name] = meta.displayName;
    }

    // `_quiz*` config keys are reserved for quiz-internal directives that a
    // lure applies to the COMPILED spec. No generator emits one today (the
    // color-shift and log-scale lures were removed), but the assembler must
    // never see such a key, and specDiff must not cost it.
    const chartProperties = Object.fromEntries(
        Object.entries(spec.config ?? {}).filter(([k]) => !k.startsWith('_quiz')));

    const vl = assembleVegaLite({
        data: { values: rows },
        semantic_types: semanticTypes,
        chart_spec: {
            chartType: spec.chartType,
            encodings: spec.encodings as any,
            canvasSize: CANVAS,
            chartProperties,
        },
        field_display_names: displayNames,
        options: { maxStretchFactor: 2.2 },
    });

    if (vl && typeof vl === 'object') {
        // Strip assembler by-products; give quiz-friendly white background.
        delete vl._options;
        vl.background = 'white';
    }
    return vl;
}

/**
 * Quick validity probe: does this chart-level spec compile to a non-trivial VL
 * spec?
 *
 * A mark alone is not enough. The assembler can accept a field map, drop every
 * channel it cannot use, and hand back `{ mark: "point", encoding: {} }` — a
 * chart of nothing, which the renderer then rejects with "layout size is
 * step". So the probe also demands that at least one channel carries a field.
 * It is still only a probe: the render guard stays the authority.
 */
export function compiles(spec: ChartLevelSpec, rows: any[], metadata: Record<string, FieldMeta>): boolean {
    try {
        const vl = compileToVegaLite(spec, rows, metadata);
        if (!vl || typeof vl !== 'object') return false;
        if (!(vl.mark || vl.layer || vl.hconcat || vl.vconcat || vl.facet || vl.spec)) return false;
        return encodesAField(vl);
    } catch {
        return false;
    }
}

/** Does any channel anywhere in a compiled VL spec carry a field? */
function encodesAField(o: any): boolean {
    if (!o || typeof o !== 'object') return false;
    if (o.encoding && typeof o.encoding === 'object') {
        for (const def of Object.values<any>(o.encoding)) {
            if (def && typeof def === 'object' && (def.field || def.aggregate === 'count')) return true;
        }
    }
    return Object.values(o).some(v => v && typeof v === 'object' && encodesAField(v));
}

// ── Small utilities shared by generators ─────────────────────────────────

export function fieldTypeOf(field: string, metadata: Record<string, FieldMeta>): string {
    return metadata[field]?.type ?? 'string';
}

export function isQuantitative(field: string, metadata: Record<string, FieldMeta>): boolean {
    return fieldTypeOf(field, metadata) === 'number';
}

export function cloneSpec(spec: ChartLevelSpec): ChartLevelSpec {
    return JSON.parse(JSON.stringify(spec));
}

/** Canonical signature of a chart-level spec (for dedupe). Includes config,
 *  since two variants may differ only in a config-carried edit (color shift,
 *  scale change) and must not collapse into one. */
export function specSignature(spec: ChartLevelSpec): string {
    const enc = Object.entries(spec.encodings)
        .map(([ch, e]) => `${ch}:${e.field}:${e.sortOrder ?? ''}:${e.sortBy ?? ''}:${e.aggregate ?? ''}`)
        .sort()
        .join('|');
    const cfg = Object.entries(spec.config ?? {})
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .sort()
        .join(',');
    return `${spec.chartType}||${enc}||${cfg}`;
}
