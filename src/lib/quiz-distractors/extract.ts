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
        });
    }

    return { charts, tables, sourceTable };
}

// ── Compilation (mirrors src/app/utils.tsx assembleVegaChart) ────────────

export const CANVAS = { width: 300, height: 220 };

/**
 * Alternate palettes for the color-shift form lure. Same lightness texture as
 * the default tableau10, hues rotated, so a shifted chart still looks like an
 * app chart — just not the one the participant made.
 */
const QUIZ_PALETTES: string[][] = [
    ['#e45756', '#f58518', '#72b7b2', '#4c78a8', '#54a24b', '#eeca3b', '#b279a2', '#ff9da6', '#9d755d', '#bab0ac'],
    ['#54a24b', '#b279a2', '#f58518', '#72b7b2', '#e45756', '#4c78a8', '#eeca3b', '#9d755d', '#ff9da6', '#bab0ac'],
];

/**
 * Recolor a compiled VL spec in place: rotate the categorical range and remap
 * every explicit mark/encoding color a template hard-coded. Charts whose color
 * comes entirely from the default config pick it up via `config.range` /
 * `config.mark`; the render-identity guard drops any chart where the shift
 * turned out to be inert.
 */
function recolorVl(vl: any, shift: number): void {
    const palette = QUIZ_PALETTES[(shift - 1 + QUIZ_PALETTES.length) % QUIZ_PALETTES.length];
    const remap = new Map<string, string>();
    let next = 0;
    const replacement = (orig: string) => {
        if (!remap.has(orig)) remap.set(orig, palette[next++ % palette.length]);
        return remap.get(orig)!;
    };
    const isColor = (v: any) => typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v);
    const walk = (o: any): void => {
        if (!o || typeof o !== 'object') return;
        if (o.mark && typeof o.mark === 'object' && isColor(o.mark.color)) {
            o.mark.color = replacement(o.mark.color);
        }
        if (o.color && typeof o.color === 'object' && isColor(o.color.value)) {
            o.color.value = replacement(o.color.value);
        }
        if (o.scale && Array.isArray(o.scale.range) && o.scale.range.every(isColor)) {
            o.scale.range = o.scale.range.map(replacement);
        }
        for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
    };
    walk(vl);
    vl.config = {
        ...vl.config,
        range: { ...vl.config?.range, category: palette },
        mark: { ...vl.config?.mark, color: palette[0] },
    };
}

/**
 * Put the named quantitative field on a log scale, wherever it is encoded on a
 * positional channel. Generation only offers this for strictly-positive
 * measures, so the log domain is always valid.
 */
function injectLogScale(vl: any, field: string): void {
    const unescape = (s: string) => String(s).replace(/\\/g, '');
    const walk = (o: any): void => {
        if (!o || typeof o !== 'object') return;
        if (o.encoding && typeof o.encoding === 'object') {
            for (const ch of ['x', 'y']) {
                const def = o.encoding[ch];
                if (def && typeof def.field === 'string' && unescape(def.field) === field) {
                    def.scale = { ...def.scale, type: 'log' };
                    // a log scale cannot include zero, and stacking is meaningless on it
                    if ('stack' in def) def.stack = null;
                }
            }
        }
        for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
    };
    walk(vl);
}

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

    // Quiz-internal directives ride in config under `_quiz*` keys — the
    // assembler never sees them (they are applied to the compiled VL below),
    // and specDiff ignores them when costing config changes.
    const config = spec.config ?? {};
    const chartProperties = Object.fromEntries(
        Object.entries(config).filter(([k]) => !k.startsWith('_quiz')));

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
        if (typeof config._quizColorShift === 'number') recolorVl(vl, config._quizColorShift);
        if (typeof config._quizLogScaleField === 'string') injectLogScale(vl, config._quizLogScaleField);
    }
    return vl;
}

/** Quick validity probe: does this chart-level spec compile to a non-trivial VL spec? */
export function compiles(spec: ChartLevelSpec, rows: any[], metadata: Record<string, FieldMeta>): boolean {
    try {
        const vl = compileToVegaLite(spec, rows, metadata);
        return !!vl && typeof vl === 'object' && (!!vl.mark || !!vl.layer || !!vl.hconcat || !!vl.vconcat || !!vl.facet || !!vl.spec);
    } catch {
        return false;
    }
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
