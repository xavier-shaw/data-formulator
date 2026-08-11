// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * quiz-distractors/guard.ts — reject lures that would break a quiz item.
 *
 * Two defects can only be seen in the RENDER, never in the spec:
 *
 *  1. A lure that renders like the original. The item would then have two
 *     correct answers. Comparing specs does not catch this — a "Bar Chart" and
 *     a "Stacked Bar Chart" with no color channel are different chart types,
 *     different specs, identical pixels.
 *  2. A lure that draws `NaN` / `undefined` labels. It compiles and renders, so
 *     the identity check keeps it, but a participant eliminates it on sight,
 *     which inflates recognition accuracy.
 *
 * So both callers render every candidate and run it past these two functions.
 *
 * Hashes are only ever compared WITHIN one run (browser vega and node vl2svg
 * measure text differently, so hashes are not portable across the two). That is
 * why a plain string hash is enough and no node `crypto` is needed. The
 * normalization must stay identical in both paths.
 */

/** Strip non-semantic churn (whitespace, float-formatting jitter). */
export function normalizeSvg(svg: string): string {
    return svg
        .replace(/\s+/g, ' ')
        .replace(/(\d+\.\d{3})\d+/g, '$1')
        .trim();
}

/**
 * Hash of what the viewer actually sees. FNV-1a over the normalized SVG —
 * no node built-ins, so this runs in the browser too.
 */
export function renderHash(svg: string): string {
    const s = normalizeSvg(svg);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    // Second pass over a coarse fold of the string guards against the
    // collisions a single 32-bit hash would risk across ~700 charts.
    let h2 = 0x9e3779b9;
    for (let i = 0; i < s.length; i += 7) {
        h2 ^= s.charCodeAt(i);
        h2 = Math.imul(h2, 0x85ebca6b);
    }
    return ((h >>> 0).toString(16).padStart(8, '0')) + ((h2 >>> 0).toString(16).padStart(8, '0')) +
        s.length.toString(16);
}

/**
 * Remove every piece of text a chart draws — axis titles, tick values, legend
 * labels, data labels — leaving the marks, scales and colors in place.
 *
 * Used by the quiz's first step, which asks whether the SHAPE of a chart is
 * remembered before letting the reader see what was written on it. Stripping
 * the rendered SVG rather than re-rendering a text-free spec matters: the two
 * steps must show the *same* chart, and removing `<text>` cannot move a single
 * mark, whereas a re-render without labels would re-lay-out the plotting area.
 */
export function stripSvgText(svg: string): string {
    return svg
        .replace(/<text\b[^>]*>[\s\S]*?<\/text>/g, '')
        .replace(/<text\b[^>]*\/>/g, '')
        // Vega puts accessible descriptions on group marks; they would leak the
        // labels to anyone reading the DOM (or a screen reader) mid-question.
        .replace(/\saria-label="[^"]*"/g, '')
        .replace(/<title>[\s\S]*?<\/title>/g, '');
}

const BAD_TOKENS = new Set(['NaN', 'undefined', 'null', 'Infinity', '-Infinity']);

/**
 * Broken text drawn in the chart (axis or data labels). Originals never contain
 * these tokens, so their presence is an unambiguous defect signal.
 */
export function degenerateText(svg: string): string[] {
    const hits = new Set<string>();
    for (const m of svg.matchAll(/>([^<>]*)</g)) {
        const t = m[1].trim();
        if (BAD_TOKENS.has(t)) hits.add(t);
    }
    return [...hits];
}
