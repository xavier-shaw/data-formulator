// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * RecallDataPreview — the participant's own data table, as the recall parts of
 * the quiz show it.
 *
 * This is the canvas's own `SelectableDataGrid`, not a lookalike — the point of
 * showing the table is to put the participant back in front of the thing they
 * worked in, so the column headers, type icons and cell formatting have to be
 * the ones they saw. It is fed a small slice of rows with `virtual={false}`, so
 * it renders statically and never calls the sampling endpoint.
 *
 * Shared by the parts that ask over that table and must show it identically:
 * the three questions they would ask next, name the attributes, and group them.
 */

import { FC, useMemo } from 'react';
import { Box, Typography } from '@mui/material';
import { useSelector } from 'react-redux';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { DataFormulatorState } from '../app/dfSlice';
import { DictTable } from '../components/ComponentType';
import { SelectableDataGrid, ColumnDef } from './SelectableDataGrid';
import { formatCellValue, getColumnAlign } from './ViewUtils';
import { Type } from '../data/types';
import { borderColor, radius } from '../app/tokens';

/** Rows handed to the grid. Enough to scroll, few enough to stay static. */
const PREVIEW_ROWS = 50;

interface RecallDataPreviewProps {
    table?: DictTable;
    /** how much vertical room the step can spare */
    height: number;
    /** shown in place of the grid when the session's table could not be read.
     *  Omit it where the table is a prompt rather than the material — the
     *  questions part still works without it, so it shows nothing instead. */
    emptyNote?: string;
}

export const RecallDataPreview: FC<RecallDataPreviewProps> = ({ table, height, emptyNote }) => {
    // Only used to mark which columns are participant-created, mirroring how the
    // canvas colours its headers.
    const conceptShelfItems = useSelector((state: DataFormulatorState) => state.conceptShelfItems);

    const previewRows = useMemo(
        () => (table?.rows ?? []).slice(0, PREVIEW_ROWS).map((r: any, i: number) => ({ ...r, '#rowId': i + 1 })),
        [table],
    );

    // Column definitions, mirroring DataView's canvas grid: width from the
    // content, alignment and cell formatting from the column's type.
    const columnDefs: ColumnDef[] = useMemo(() => {
        if (!table) return [];
        const widthFor = (name: string) => {
            const values = previewRows.slice(0, 20).map(row => String(row[name] ?? ''));
            const avg = values.length ? values.reduce((s, v) => s + v.length, 0) / values.length : 0;
            const longestWord = name.split(/[\s-]+/).reduce((m, seg) => Math.max(m, seg.length), 0);
            return Math.max(60, Math.min(240, Math.max(longestWord, avg) * 8)) + 50;
        };
        const cols: ColumnDef[] = (table.names ?? []).map(name => {
            const dataType = table.metadata?.[name]?.type as Type;
            const semanticType = table.metadata?.[name]?.semanticType;
            const width = widthFor(name);
            return {
                id: name,
                label: table.metadata?.[name]?.displayName || name,
                description: table.metadata?.[name]?.description,
                minWidth: width,
                width,
                align: getColumnAlign(dataType),
                format: (value: any) => <Typography fontSize="inherit">{formatCellValue(value, dataType, semanticType)}</Typography>,
                dataType,
                source: conceptShelfItems.find(f => f.name === name)?.source || 'original',
            };
        });
        return [
            {
                id: '#rowId', label: '#', minWidth: 56, width: 56, align: undefined,
                format: (value: any) => <Typography fontSize="inherit" color="rgba(0,0,0,0.65)">{value}</Typography>,
                dataType: Type.Number,
                source: 'original' as const,
            },
            ...cols,
        ];
    }, [table, previewRows, conceptShelfItems]);

    if (!table) {
        if (!emptyNote) return null;
        return (
            <Typography sx={{ fontSize: 12.5, color: 'text.disabled', mb: 2 }}>{emptyNote}</Typography>
        );
    }

    return (
        <Box sx={{ height, mb: 2, border: `1px solid ${borderColor.view}`, borderRadius: radius.sm, overflow: 'hidden' }}>
            {/* The grid's column headers are drag sources (they drop onto the
                canvas's encoding shelf), so they need a dnd context — this
                route has none, and without it the header throws
                "Expected drag drop context". Nothing here is a drop target,
                so a drag is inert. */}
            <DndProvider backend={HTML5Backend}>
                <SelectableDataGrid
                    tableId={table.id}
                    tableName={table.displayId || table.id}
                    rows={previewRows}
                    columnDefs={columnDefs}
                    rowCount={table.virtual?.rowCount || table.rows?.length || 0}
                    // Static preview: `virtual` would make the grid fetch its
                    // own pages from the server as the participant scrolls.
                    virtual={false}
                    hideFooter
                />
            </DndProvider>
        </Box>
    );
};
