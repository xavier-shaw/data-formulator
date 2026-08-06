// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Shared structured thread-context builder (Tier 2 + Tier 3), extracted from
// SimpleChartRecBox so both the component (analyst-streaming requests) and the
// dfSlice suggestions thunk (the one-shot next-step-suggestions agent) send
// the exact same exploration narrative — user questions, agent thinking,
// findings — instead of just a flat list of charts.

import { Chart, DictTable, FieldItem, InteractionEntry } from '../components/ComponentType';
import { getTriggers } from './utils';

/** Walk a table's derive chain up to its root (source or anchored) table.
 *  Returns undefined when the id is unknown or the chain is broken. Used to
 *  key the persistent suggestion strip: suggestions are stored per ROOT
 *  table, but the user may be focused on any derived chart/table under it. */
export function resolveRootTableId(tables: DictTable[], tableId?: string): string | undefined {
    const isRoot = (t: DictTable) => t.derive === undefined || !!t.anchored;
    let cur = tableId ? tables.find(t => t.id === tableId) : undefined;
    const seen = new Set<string>();
    while (cur && !isRoot(cur) && !seen.has(cur.id)) {
        seen.add(cur.id);
        const srcId = cur.derive?.source?.[0];
        cur = srcId ? tables.find(t => t.id === srcId) : undefined;
    }
    return cur && isRoot(cur) ? cur.id : undefined;
}

export function buildThreadContext(
    tables: DictTable[],
    charts: Chart[],
    conceptShelfItems: FieldItem[],
    targetTableId: string,
): { focusedThread: any[] | undefined; otherThreads: any[] | undefined } {
    // Tier 2: Focused thread — detailed per-step info
    const focusedSteps: any[] = [];
    let walkTable = tables.find(t => t.id === targetTableId);
    const visited = new Set<string>();
    const focusedChainIds = new Set<string>();
    while (walkTable?.derive?.trigger) {
        if (visited.has(walkTable.id)) break;
        visited.add(walkTable.id);
        focusedChainIds.add(walkTable.id);
        const trigger = walkTable.derive.trigger;
        const interaction = trigger.interaction || [];
        const userPrompt = interaction.find(e => e.role === 'prompt')?.content;
        const instruction = interaction.find(e => e.role === 'instruction');
        const summary = interaction.find(e => e.role === 'summary');

        // Find the actual resolved chart (not the trigger's "Auto" stub)
        const resolvedChart = charts.find(c => c.tableRef === walkTable!.id && c.source === 'trigger')
            || charts.find(c => c.tableRef === walkTable!.id);
        const chartType = resolvedChart?.chartType || '';
        // Map field IDs to field names for readable context
        const encodings = resolvedChart?.encodingMap
            ? Object.fromEntries(
                Object.entries(resolvedChart.encodingMap)
                    .filter(([, v]: [string, any]) => v?.fieldID)
                    .map(([k, v]: [string, any]) => {
                        const field = conceptShelfItems.find(f => f.id === v.fieldID);
                        return [k, field?.name || v.fieldID];
                    })
              )
            : {};

        const step: any = {
            table_name: walkTable.virtual?.tableId || walkTable.id,
            columns: walkTable.names,
            row_count: walkTable.virtual?.rowCount ?? walkTable.rows.length,
            user_question: userPrompt || '',
            agent_thinking: instruction?.plan || '',
            display_instruction: instruction?.displayContent || instruction?.content || '',
            chart_type: chartType,
            encodings,
            agent_summary: summary?.content || '',
        };

        focusedSteps.unshift(step);

        walkTable = tables.find(t => t.id === trigger.tableId);
    }
    const focusedThread = focusedSteps.length > 0 ? focusedSteps : undefined;

    // Tier 3: Peripheral threads — one-line summary per step
    // Find all leaf tables (no children or all children are anchored)
    const leafTables = tables.filter(t => {
        const children = tables.filter(c => c.derive?.trigger.tableId === t.id);
        return children.length === 0 || children.every(c => c.anchored);
    });

    const peripheralThreads: any[] = [];
    for (const leaf of leafTables) {
        // Skip the focused thread's leaf
        if (focusedChainIds.has(leaf.id)) continue;
        // Skip root/source tables
        if (!leaf.derive) continue;

        const triggers = getTriggers(leaf, tables);
        if (triggers.length === 0) continue;

        const STEP_FINDING_CHAR_LIMIT = 200;
        const steps: string[] = [];
        for (const trig of triggers) {
            const instr = trig.interaction?.find((e: InteractionEntry) => e.role === 'instruction');
            const label = instr?.displayContent || instr?.content || '';
            // Look up the actual resolved chart from state, not the trigger's "Auto" stub
            const chartForStep = charts.find(c => c.tableRef === trig.resultTableId && c.source === 'trigger')
                || charts.find(c => c.tableRef === trig.resultTableId);
            const chartType = chartForStep?.chartType || '';
            const encStr = chartForStep?.encodingMap
                ? Object.entries(chartForStep.encodingMap)
                    .filter(([, v]: [string, any]) => v?.fieldID)
                    .map(([k, v]: [string, any]) => {
                        const field = conceptShelfItems.find(f => f.id === v.fieldID);
                        return `${k}: ${field?.name || v.fieldID}`;
                    })
                    .join(', ')
                : '';
            // Per-step agent commentary: the `summary` entry that the
            // visualize action emits after running this step.
            let finding = trig.interaction?.find(
                (e: InteractionEntry) => e.role === 'summary',
            )?.content?.trim() || '';
            if (finding.length > STEP_FINDING_CHAR_LIMIT) {
                finding = finding.slice(0, STEP_FINDING_CHAR_LIMIT - 1).trimEnd() + '…';
            }
            const head = `${label}${chartType ? ` → ${chartType}` : ''}${encStr ? ` (${encStr})` : ''}`;
            steps.push(finding ? `${head} — finding: ${finding}` : head);
        }

        if (steps.length > 0) {
            const sourceTableId = triggers[0].tableId;
            const sourceTable = tables.find(t => t.id === sourceTableId);
            peripheralThreads.push({
                source_table: sourceTable?.virtual?.tableId || sourceTableId,
                leaf_table: leaf.virtual?.tableId || leaf.id,
                step_count: steps.length,
                steps,
            });
        }
    }
    const otherThreads = peripheralThreads.length > 0 ? peripheralThreads : undefined;

    return { focusedThread, otherThreads };
}
