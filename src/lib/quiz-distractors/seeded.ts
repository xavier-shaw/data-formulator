// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * quiz-distractors/seeded.ts — reproducible generation.
 *
 * Flint's recommender picks at random among equally-good fields
 * (`core/recommendation.ts` calls `Math.random` in `pickBestGroupingField` and
 * friends). That is good variety for the app and wrong for a quiz: two runs over
 * the same session would produce different questions, which cannot be audited
 * or counterbalanced. So generation runs against a seeded stream.
 *
 * There is no way to inject an RNG into the recommender without changing app
 * code, so `Math.random` is swapped for the duration. That is only safe while
 * the swapped-in code is SYNCHRONOUS — an await would let unrelated app code
 * draw from the seeded stream (and, worse, leak the patch if it never resumes).
 * `withSeededRandom` therefore refuses a thenable return value instead of
 * quietly leaking, so chunking generation across frames fails loudly rather
 * than corrupting every other consumer of Math.random.
 */

/** mulberry32 — small, fast, good enough for choosing among equal candidates. */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Install a seeded `Math.random` and return a restore function.
 *
 * For the offline pipeline, which installs once at startup and keeps ONE
 * continuous stream across the whole run (its generation is interleaved with
 * async renders, and nothing else in that process draws random numbers).
 * In an app, prefer `withSeededRandom`.
 */
export function installSeededRandom(seed: number): () => void {
    const original = Math.random;
    Math.random = mulberry32(seed);
    return () => { Math.random = original; };
}

/**
 * Run `fn` with a seeded `Math.random`, then restore it.
 *
 * `fn` MUST be synchronous. Returning a promise throws: the patch would
 * otherwise stay installed across the await and every other caller of
 * Math.random in the app would silently draw from this stream.
 */
export function withSeededRandom<T>(seed: number, fn: () => T): T {
    const restore = installSeededRandom(seed);
    let result: T;
    try {
        result = fn();
    } finally {
        restore();
    }
    if (result && typeof (result as any).then === 'function') {
        throw new Error(
            'withSeededRandom requires a synchronous function: a promise was returned, ' +
            'so Math.random would have been restored before the work finished. ' +
            'Generate all specs synchronously, then do async work (rendering) afterwards.',
        );
    }
    return result;
}
