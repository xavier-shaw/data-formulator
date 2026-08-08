// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * distractor-lab/lib.ts — node-side entry to the shared distractor library.
 *
 * The generators, distances, guard, and quiz-selection logic all live in
 * `src/lib/quiz-distractors/` so the app and this offline pipeline run ONE
 * implementation. The only thing that cannot be shared is reading a session off
 * disk — the library takes a state object, since in the app the state comes from
 * Redux or IndexedDB, never a file.
 */

import * as fs from 'fs';
import { extractSession, SessionData } from '../../src/lib/quiz-distractors';

/** Read an exported session state.json and extract its quizzable charts. */
export function loadSession(statePath: string): SessionData {
    return extractSession(JSON.parse(fs.readFileSync(statePath, 'utf-8')));
}

// Re-exported so the rest of the pipeline can keep importing from './lib'.
export * from '../../src/lib/quiz-distractors';
