// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * @module quiz-distractors
 *
 * Generates "which chart did you actually make?" look-alikes for a Data
 * Formulator session, and scores each one against the real chart on two axes:
 * how much the FORM changed (spec distance) and how much the VALUES changed
 * (data distance). When a participant picks a look-alike, that pair of numbers
 * says what they failed to remember.
 *
 * Every module here is browser-safe — no node built-ins — because two callers
 * share it:
 *   • the app, for the in-session recognition quiz (renders via vega)
 *   • explorations/distractor-lab, for the offline gallery (renders via vl2svg)
 * Rendering is injected rather than imported, which is what keeps the two paths
 * from drifting.
 */

export * from './extract';
export * from './distance';
export * from './curated';
export * from './messageOps';
export * from './generators';
export * from './guard';
export * from './seeded';
export * from './select';
