// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * distractor-lab/lib.ts — session extraction + chart compilation helpers.
 *
 * Loads a Data Formulator session state (state.json) and reconstructs each
 * user-created chart as a *chart-level spec* (chartType + field-name-based
 * encodings + rows + metadata). Compiles chart-level specs to Vega-Lite via
 * the same `assembleVegaLite` pipeline the app itself uses, so distractors
 * are pixel-faithful to what the participant actually saw.
 */

import * as fs from 'fs';
import { assembleVegaLite } from '../../src/lib/agents-chart';

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
}

export interface SessionData {
    charts: SessionChart[];
    /** tableId -> { rows, metadata } for every table in the session */
    tables: Record<string, { rows: any[]; metadata: Record<string, FieldMeta> }>;
    /** the original source table (largest, non-derived) for sibling-label pools */
    sourceTable?: { rows: any[]; metadata: Record<string, FieldMeta> };
}

// ── Session extraction ───────────────────────────────────────────────────

export function loadSession(statePath: string): SessionData {
    const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

    const conceptName: Record<string, string> = {};
    for (const c of s.conceptShelfItems ?? []) conceptName[c.id] = c.name;

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

    const vl = assembleVegaLite({
        data: { values: rows },
        semantic_types: semanticTypes,
        chart_spec: {
            chartType: spec.chartType,
            encodings: spec.encodings as any,
            canvasSize: CANVAS,
            chartProperties: spec.config,
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

/** Canonical signature of a chart-level spec (for dedupe). */
export function specSignature(spec: ChartLevelSpec): string {
    const enc = Object.entries(spec.encodings)
        .map(([ch, e]) => `${ch}:${e.field}:${e.sortOrder ?? ''}:${e.sortBy ?? ''}:${e.aggregate ?? ''}`)
        .sort()
        .join('|');
    return `${spec.chartType}||${enc}`;
}
