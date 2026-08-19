// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * quizModeratorConfig — the moderator's per-session quiz configuration.
 *
 * The moderator page (views/QuizModeratorPage.tsx) writes this; the participant
 * quiz reads it. When a session has no config, or a config section is absent,
 * the quiz falls back to its automatic behavior (focus-ranked chart selection,
 * seeded random provenance sampling), so a config never has to be complete: the
 * moderator overrides exactly the choices they care about.
 *
 * Stored in localStorage, keyed by session id. That fits the study setup: the
 * moderator configures the quiz on the machine the participant will take it on,
 * between the analysis phase and the quiz phase.
 */

export interface RecognitionConfig {
    /**
     * The charts the quiz must ask about, in question order. Absent = automatic
     * (focus-time ranking, capped at the default question count). A listed
     * chart that cannot form an option matrix is still skipped, with a reason.
     */
    chartIds?: string[];
    /**
     * Per chart, the perturbations to prefer when the matrix is filled, keyed
     * by `lureKey(op, label)`. Preferred lures move to the front of their
     * axis's pick order; the guards still apply.
     */
    preferred?: Record<string, { visual?: string[]; data?: string[] }>;
}

export interface ProvenanceConfig {
    /**
     * The lineage moves to ask about, in item order. Absent = automatic seeded
     * sampling. Each entry must be a real ground-truth edge of the session.
     */
    transitions?: { from: string; to: string }[];
    /**
     * Per transition (keyed by `transitionKey(from, to)`), the chart ids to
     * offer as distractors. A short or invalid list is completed with the
     * seeded random pick.
     */
    distractors?: Record<string, string[]>;
    /** item count for AUTOMATIC sampling; ignored when `transitions` is set */
    count?: number;
}

export interface QuizModeratorConfig {
    sessionId: string;
    updatedAt: string;
    recognition?: RecognitionConfig;
    provenance?: ProvenanceConfig;
}

/** Stable identity of one perturbation inside one chart's candidate set. */
export const lureKey = (op: string, label: string) => `${op}::${label}`;

/** Stable identity of one lineage move. */
export const transitionKey = (from: string, to: string) => `${from}>${to}`;

const storageKey = (sessionId: string) => `dfQuizModeratorConfig:${sessionId}`;

export function loadModeratorConfig(sessionId: string): QuizModeratorConfig | null {
    try {
        const raw = localStorage.getItem(storageKey(sessionId));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed as QuizModeratorConfig : null;
    } catch {
        return null;
    }
}

export function saveModeratorConfig(config: QuizModeratorConfig): void {
    localStorage.setItem(
        storageKey(config.sessionId),
        JSON.stringify({ ...config, updatedAt: new Date().toISOString() }),
    );
}

export function clearModeratorConfig(sessionId: string): void {
    localStorage.removeItem(storageKey(sessionId));
}
