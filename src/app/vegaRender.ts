// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * vegaRender — headless Vega-Lite rendering primitives.
 *
 * Extracted from ChartRenderService so callers that only need an SVG (the
 * recognition quiz, which renders ~80 candidate charts and compares them) do not
 * also pay for a 2× PNG rasterization of every one.
 *
 * "Headless" means no DOM container: vega runs its dataflow and serializes,
 * which is what lets these be called in a loop off-screen.
 */

import { compile } from 'vega-lite';
import { parse, View } from 'vega';

/**
 * Render a Vega-Lite spec to an SVG string.
 *
 * The view is finalized in `finally`: these run dozens at a time, and a spec
 * that throws mid-dataflow would otherwise leak its runtime.
 */
export async function renderVegaLiteToSvg(vlSpec: any): Promise<string> {
    const runtime = parse(compile(vlSpec as any).spec);
    const view = new View(runtime, { renderer: 'none' });
    try {
        await view.runAsync();
        return await view.toSVG();
    } finally {
        view.finalize();
    }
}

/**
 * Render a Vega-Lite spec to SVG + a retina PNG data URL, reporting the
 * intrinsic size vega laid the chart out at (axes / legends / titles included)
 * so consumers can preserve its true aspect ratio.
 */
export async function renderVegaLiteToImages(
    vlSpec: any,
): Promise<{ svg: string; pngDataUrl: string; width: number; height: number }> {
    const runtime = parse(compile(vlSpec as any).spec);
    const view = new View(runtime, { renderer: 'none' });
    try {
        await view.runAsync();
        const [svg, pngDataUrl] = await Promise.all([
            view.toSVG(),
            view.toImageURL('png', 2),
        ]);
        return { svg, pngDataUrl, ...extractSvgSize(svg) };
    } finally {
        view.finalize();
    }
}

/** Intrinsic pixel dimensions from a vega-rendered SVG's root tag. */
export function extractSvgSize(svg: string, fallback = { width: 300, height: 300 }): { width: number; height: number } {
    const tag = svg.match(/<svg\b[^>]*>/i)?.[0] ?? '';
    const w = tag.match(/\bwidth="([\d.]+)"/);
    const h = tag.match(/\bheight="([\d.]+)"/);
    return {
        width: w ? Math.round(parseFloat(w[1])) : fallback.width,
        height: h ? Math.round(parseFloat(h[1])) : fallback.height,
    };
}
