// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * build_v6_gallery.ts — the Chart Perturbation Gallery, design v6.
 *
 * One example chart per curated chart type. The SHIPPED pipeline builds the
 * option matrix for each one: `buildQuizItems` from src/lib/quiz-distractors,
 * rendered through `compileToVegaLite` + vl2svg — the same code path as the
 * in-app quiz, with the renderer swapped. The page therefore shows what the
 * module really builds, not an illustration of it.
 *
 * Usage (from the repo root):
 *   node_modules/.bin/esbuild explorations/distractor-lab/build_v6_gallery.ts \
 *     --bundle --platform=node --format=cjs --outfile=/tmp/v6gallery.cjs
 *   node /tmp/v6gallery.cjs <outDir> <gallery.html>
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

import {
    buildQuizItems, generateAll, withSeededRandom, curatedFor,
    MESSAGE_OPS, resolveRoles, compileToVegaLite,
    SessionChart, SessionData, QuizItem, DistractorCandidate,
} from '../../src/lib/quiz-distractors';

const [outDir, htmlPath] = process.argv.slice(2);
if (!outDir || !htmlPath) { console.error('usage: node v6gallery.cjs <outDir> <gallery.html>'); process.exit(1); }
fs.mkdirSync(path.join(outDir, 'spec'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'svg'), { recursive: true });

const VL2SVG = path.resolve(process.cwd(), 'node_modules/.bin/vl2svg');
const VL2PNG = path.resolve(process.cwd(), 'node_modules/.bin/vl2png');
const SEED = 20260818;

// ── deterministic value streams ──────────────────────────────────────────

function mulberry(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const num = (semanticType = 'Number') => ({ type: 'number', semanticType, levels: [] as string[] });
const str = (semanticType = 'Category') => ({ type: 'string', semanticType, levels: [] as string[] });

// ── the example charts ───────────────────────────────────────────────────

interface Example {
    type: string;
    title: string;
    dataType: string;
    message: string;
    encodings: Record<string, { field: string }>;
    rows: any[];
    metadata: Record<string, any>;
}

function examples(): Example[] {
    const r = mulberry(7);
    const out: Example[] = [];

    // Bars ────────────────────────────────────────────────────────────────
    const airlines = ['Skyline', 'Aerova', 'Northbird', 'Cirrus Jet', 'Pelican', 'Vantage'];
    out.push({
        type: 'Bar Chart', title: 'Incidents by airline',
        dataType: 'One nominal field + one quantitative field.',
        message: 'The ranking and the gap sizes: which airline leads, and by how much.',
        encodings: { x: { field: 'airline' }, y: { field: 'incidents' } },
        rows: airlines.map((a, i) => ({ airline: a, incidents: [420, 180, 305, 95, 250, 140][i] })),
        metadata: { airline: str(), incidents: num('Count') },
    });
    const aircraft = ['A320', 'B737', 'B777', 'E190', 'CRJ9', 'A350'];
    out.push({
        type: 'Lollipop Chart', title: 'Strikes by aircraft type',
        dataType: 'One nominal field + one quantitative field.',
        message: 'The same as Bar Chart, with less ink.',
        encodings: { x: { field: 'aircraft' }, y: { field: 'strikes' } },
        rows: aircraft.map((a, i) => ({ aircraft: a, strikes: [88, 210, 45, 132, 60, 170][i] })),
        metadata: { aircraft: str(), strikes: num('Count') },
    });
    const airports = ['DEN', 'DFW', 'ORD', 'ATL', 'SMF', 'MEM', 'SLC'];
    out.push({
        type: 'Bar Table', title: 'Damage rate by airport',
        dataType: 'One nominal field (label column) + one quantitative field (bar column).',
        message: 'The ranking, with each value readable.',
        encodings: { y: { field: 'airport' }, x: { field: 'damage_rate' } },
        rows: airports.map((a, i) => ({ airport: a, damage_rate: [0.042, 0.018, 0.031, 0.012, 0.055, 0.026, 0.037][i] })),
        metadata: { airport: str(), damage_rate: num('Percentage') },
    });
    const quarters = ['2024Q1', '2024Q2', '2024Q3', '2024Q4'];
    out.push({
        type: 'Grouped Bar Chart', title: 'Revenue by quarter and region',
        dataType: 'Two nominal fields (x, group) + one quantitative field.',
        message: 'The interaction: does the same region lead in each quarter?',
        encodings: { x: { field: 'quarter' }, y: { field: 'revenue' }, group: { field: 'region' } },
        rows: quarters.flatMap((q, i) => [
            { quarter: q, region: 'East', revenue: [120, 135, 150, 172][i] },
            { quarter: q, region: 'West', revenue: [95, 102, 118, 121][i] },
        ]),
        metadata: { quarter: str('Date'), region: str(), revenue: num('Currency') },
    });
    const months6 = ['2024-01', '2024-02', '2024-03', '2024-04', '2024-05', '2024-06'];
    out.push({
        type: 'Stacked Bar Chart', title: 'Tickets by month and severity',
        dataType: 'Two nominal fields (x, color) + one quantitative field. The sum has meaning.',
        message: 'The composition of each bar and the ranking of the totals.',
        encodings: { x: { field: 'month' }, y: { field: 'tickets' }, color: { field: 'severity' } },
        rows: months6.flatMap((m, i) => [
            { month: m, severity: 'Low', tickets: [40, 44, 52, 48, 60, 66][i] },
            { month: m, severity: 'Medium', tickets: [22, 25, 20, 30, 28, 35][i] },
            { month: m, severity: 'High', tickets: [8, 6, 12, 9, 14, 10][i] },
        ]),
        metadata: { month: str('Date'), severity: str(), tickets: num('Count') },
    });
    const steps = ['Start', 'Product A', 'Product B', 'Returns', 'Services', 'Discounts', 'Licensing', 'Adjustments'];
    out.push({
        type: 'Waterfall Chart', title: 'Profit build-up by component',
        dataType: 'One ordered field (sequence) + one quantitative field of signed deltas.',
        message: 'The running sum: which steps add, which remove, and the end level.',
        encodings: { x: { field: 'component' }, y: { field: 'delta' } },
        rows: steps.map((s, i) => ({ component: s, delta: [50, 34, 21, -18, 15, -9, 27, -6][i] })),
        metadata: { component: str(), delta: num('Currency') },
    });

    // Lines & Areas ───────────────────────────────────────────────────────
    const months12 = Array.from({ length: 12 }, (_, i) => `2024-${String(i + 1).padStart(2, '0')}`);
    const trend = [22, 26, 31, 38, 47, 58, 72, 66, 55, 46, 38, 31];
    out.push({
        type: 'Line Chart', title: 'Ridership over the year',
        dataType: 'One ordered field + one quantitative field.',
        message: 'The trend shape: direction, peak, slope, endpoints.',
        encodings: { x: { field: 'month' }, y: { field: 'riders' } },
        rows: months12.map((m, i) => ({ month: m, riders: trend[i] })),
        metadata: { month: str('Date'), riders: num('Count') },
    });
    out.push({
        type: 'Area Chart', title: 'Storage used over the year',
        dataType: 'One ordered field + one quantitative field ≥ 0. A zero baseline has meaning.',
        message: 'The trend shape and the level.',
        encodings: { x: { field: 'month' }, y: { field: 'terabytes' } },
        rows: months12.map((m, i) => ({ month: m, terabytes: [12, 14, 15, 18, 22, 27, 33, 40, 44, 47, 52, 60][i] })),
        metadata: { month: str('Date'), terabytes: num() },
    });
    const rounds = ['1', '2', '3', '4', '5', '6'];
    const teams = { Falcons: [42, 45, 51, 48, 56, 61], Comets: [50, 47, 44, 52, 49, 46], Titans: [38, 44, 47, 55, 52, 58], Rovers: [45, 41, 39, 36, 42, 40] } as Record<string, number[]>;
    out.push({
        type: 'Bump Chart', title: 'League positions by round',
        dataType: 'One ordered field + one nominal field (series); y = rank, not value.',
        message: 'Who is above whom, and where they overtake.',
        encodings: { x: { field: 'round' }, y: { field: 'points' }, color: { field: 'team' } },
        rows: Object.entries(teams).flatMap(([t, vs]) => rounds.map((rd, i) => ({ round: rd, team: t, points: vs[i] }))),
        metadata: { round: str(), team: str(), points: num('Count') },
    });
    const q8 = ['2023Q1', '2023Q2', '2023Q3', '2023Q4', '2024Q1', '2024Q2', '2024Q3', '2024Q4'];
    const streams = { Web: [30, 34, 39, 44, 52, 58, 66, 71], Mobile: [18, 22, 28, 35, 41, 50, 58, 69], Desktop: [40, 38, 36, 33, 30, 28, 25, 22] } as Record<string, number[]>;
    out.push({
        type: 'Streamgraph', title: 'Traffic by platform over time',
        dataType: 'One ordered field + one nominal field (series) + one quantitative field ≥ 0.',
        message: 'The width of the whole flow, and the growth or decay of each band.',
        encodings: { x: { field: 'quarter' }, y: { field: 'sessions' }, color: { field: 'platform' } },
        rows: Object.entries(streams).flatMap(([p, vs]) => q8.map((q, i) => ({ quarter: q, platform: p, sessions: vs[i] }))),
        metadata: { quarter: str('Date'), platform: str(), sessions: num('Count') },
    });

    // Points ──────────────────────────────────────────────────────────────
    const scatterRows = Array.from({ length: 40 }, () => {
        const price = 20 + r() * 80;
        const rating = Math.max(1, Math.min(10, price / 10 + (r() - 0.5) * 3));
        return { price: +price.toFixed(1), rating: +rating.toFixed(1) };
    });
    out.push({
        type: 'Scatter Plot', title: 'Price against rating',
        dataType: 'Two quantitative fields (x, y).',
        message: 'The association: its sign, its strength, its clusters, and its outliers.',
        encodings: { x: { field: 'price' }, y: { field: 'rating' } },
        rows: scatterRows,
        metadata: { price: num('Currency'), rating: num() },
    });
    const regRows = Array.from({ length: 36 }, () => {
        const hours = 1 + r() * 9;
        const score = Math.max(20, Math.min(100, 30 + hours * 6.5 + (r() - 0.5) * 14));
        return { hours: +hours.toFixed(1), score: +score.toFixed(0) };
    });
    out.push({
        type: 'Regression', title: 'Study hours against score',
        dataType: 'Two quantitative fields + a fitted line.',
        message: 'The direction and the strength of the linear relation.',
        encodings: { x: { field: 'hours' }, y: { field: 'score' } },
        rows: regRows,
        metadata: { hours: num(), score: num() },
    });
    const depts = ['Sales', 'Support', 'Product', 'Design', 'Finance', 'Legal'];
    out.push({
        type: 'Ranged Dot Plot', title: 'Satisfaction: 2023 vs 2024',
        dataType: 'One nominal field (category) + one quantitative field at two conditions.',
        message: 'The gap between the two conditions, and its direction, per category.',
        encodings: { y: { field: 'department' }, x: { field: 'satisfaction' }, color: { field: 'year' } },
        rows: depts.flatMap((d, i) => [
            { department: d, year: '2023', satisfaction: [62, 55, 71, 68, 58, 52][i] },
            { department: d, year: '2024', satisfaction: [74, 59, 69, 80, 66, 57][i] },
        ]),
        metadata: { department: str(), year: str(), satisfaction: num() },
    });
    const sites = ['North', 'South', 'East', 'West', 'Central', 'Harbor'];
    const stripRows = sites.flatMap((s, si) =>
        Array.from({ length: 10 }, () => ({ site: s, response_ms: +(80 + si * 25 + r() * 60).toFixed(0) })));
    out.push({
        type: 'Strip Plot', title: 'Response times by site',
        dataType: 'One nominal field (category) + one quantitative field; each row = one mark.',
        message: 'The density and the outliers, with no aggregation.',
        encodings: { x: { field: 'site' }, y: { field: 'response_ms' } },
        rows: stripRows,
        metadata: { site: str(), response_ms: num() },
    });

    // Distributions ───────────────────────────────────────────────────────
    const histRows = Array.from({ length: 70 }, () => {
        // right-skewed delay distribution
        const v = 5 + (-Math.log(1 - r())) * 12;
        return { delay_min: +Math.min(90, v).toFixed(0) };
    });
    out.push({
        type: 'Histogram', title: 'Departure delays',
        dataType: 'One quantitative field (binned; y = count).',
        message: 'The shape of one distribution: modes, skew, center, spread.',
        encodings: { x: { field: 'delay_min' } },
        rows: histRows,
        metadata: { delay_min: num() },
    });
    const densRows = Array.from({ length: 80 }, () => {
        const v = 30 + (-Math.log(1 - r())) * 9;
        return { commute_min: +Math.min(95, v).toFixed(0) };
    });
    out.push({
        type: 'Density Plot', title: 'Commute times',
        dataType: 'One quantitative field, smoothed.',
        message: 'The same shape, smooth.',
        encodings: { x: { field: 'commute_min' } },
        rows: densRows,
        metadata: { commute_min: num() },
    });
    const lines = ['Line A', 'Line B', 'Line C', 'Line D', 'Line E'];
    const boxRows = lines.flatMap((l, li) =>
        Array.from({ length: 12 }, () => ({ line: l, output: +(40 + li * 12 + (r() - 0.5) * 20).toFixed(1) })));
    out.push({
        type: 'Boxplot', title: 'Output by production line',
        dataType: 'One nominal field + one quantitative field, reduced to a five-number summary.',
        message: 'The medians, the spreads, and the outliers, per category.',
        encodings: { x: { field: 'line' }, y: { field: 'output' } },
        rows: boxRows,
        metadata: { line: str(), output: num() },
    });
    const ages = ['0-9', '10-19', '20-29', '30-39', '40-49', '50-59', '60-69', '70-79'];
    out.push({
        type: 'Pyramid Chart', title: 'Population by age and gender',
        dataType: 'One ordered field (bins) + one quantitative field, split by a binary nominal field.',
        message: 'The asymmetry between the two sides, and the bulges.',
        encodings: { y: { field: 'age' }, x: { field: 'population' }, color: { field: 'gender' } },
        rows: ages.flatMap((a, i) => [
            { age: a, gender: 'Female', population: [42, 48, 66, 84, 71, 55, 38, 22][i] },
            { age: a, gender: 'Male', population: [45, 50, 62, 76, 65, 50, 32, 16][i] },
        ]),
        metadata: { age: str(), gender: str(), population: num('Count') },
    });

    // Circular ────────────────────────────────────────────────────────────
    const channels = ['Organic', 'Paid', 'Referral', 'Social', 'Email'];
    out.push({
        type: 'Pie Chart', title: 'Signups by channel',
        dataType: 'One nominal field (color) + one quantitative field (angle). Sum has meaning; values ≥ 0.',
        message: 'The dominant share and the majority boundary.',
        encodings: { color: { field: 'channel' }, size: { field: 'signups' } },
        rows: channels.map((c, i) => ({ channel: c, signups: [340, 190, 120, 95, 75][i] })),
        metadata: { channel: str(), signups: num('Count') },
    });
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'];
    out.push({
        type: 'Rose Chart', title: 'Rainfall by month',
        dataType: 'One nominal field (cyclic) + one quantitative field (radius).',
        message: 'Which sector is largest, and the cyclic pattern.',
        encodings: { x: { field: 'month' }, y: { field: 'rainfall' } },
        rows: monthNames.map((m, i) => ({ month: m, rainfall: [88, 74, 61, 42, 30, 22, 26, 45][i] })),
        metadata: { month: str(), rainfall: num() },
    });
    const dims = ['Speed', 'Range', 'Comfort', 'Safety', 'Economy', 'Cargo'];
    out.push({
        type: 'Radar Chart', title: 'Vehicle profile',
        dataType: 'One nominal field (the axes) + one quantitative field.',
        message: 'The shape of the profile: balance against spikes.',
        encodings: { x: { field: 'dimension' }, y: { field: 'score' } },
        rows: dims.map((d, i) => ({ dimension: d, score: [8.2, 6.1, 7.4, 9.0, 5.2, 4.4][i] })),
        metadata: { dimension: str(), score: num() },
    });

    // Tables & Maps ───────────────────────────────────────────────────────
    const shifts = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const hours = ['06:00', '10:00', '14:00', '18:00', '22:00'];
    out.push({
        type: 'Heatmap', title: 'Orders by day and hour',
        dataType: 'Two nominal/ordered fields (x, y) + one quantitative field (color).',
        message: 'The hotspot locations and the gradient direction.',
        encodings: { x: { field: 'day' }, y: { field: 'hour' }, color: { field: 'orders' } },
        rows: shifts.flatMap((d, di) => hours.map((h, hi) => ({
            day: d, hour: h,
            orders: Math.round(20 + 60 * Math.exp(-((di - 4) ** 2 + (hi - 3) ** 2) / 4) + r() * 10),
        }))),
        metadata: { day: str(), hour: str(), orders: num('Count') },
    });
    const usCities = [
        ['Boston', 42.36, -71.06, 620], ['New York', 40.71, -74.01, 890], ['Philadelphia', 39.95, -75.17, 540],
        ['Washington', 38.91, -77.04, 610], ['Chicago', 41.88, -87.63, 480], ['Atlanta', 33.75, -84.39, 300],
        ['Houston', 29.76, -95.37, 260], ['Denver', 39.74, -104.99, 230], ['Phoenix', 33.45, -112.07, 190],
        ['Seattle', 47.61, -122.33, 350], ['San Francisco', 37.77, -122.42, 430], ['Los Angeles', 34.05, -118.24, 380],
    ] as const;
    out.push({
        type: 'US Map', title: 'Riders per city',
        dataType: 'Geographic position (longitude, latitude) + one nominal label + one quantitative field.',
        message: 'The spatial pattern: which regions are high, and the clusters.',
        encodings: { longitude: { field: 'lon' }, latitude: { field: 'lat' }, color: { field: 'city' }, size: { field: 'riders' } },
        rows: usCities.map(([city, lat, lon, riders]) => ({ city, lat, lon, riders })),
        metadata: { city: str(), lat: num('Latitude'), lon: num('Longitude'), riders: num('Count') },
    });
    const worldCities = [
        ['London', 51.51, -0.13, 720], ['Paris', 48.86, 2.35, 640], ['Berlin', 52.52, 13.41, 410],
        ['Madrid', 40.42, -3.70, 380], ['Rome', 41.90, 12.50, 350], ['Tokyo', 35.68, 139.69, 900],
        ['Seoul', 37.57, 126.98, 610], ['Singapore', 1.35, 103.82, 560], ['Sydney', -33.87, 151.21, 300],
        ['São Paulo', -23.55, -46.63, 450], ['Mexico City', 19.43, -99.13, 400], ['Cairo', 30.04, 31.24, 260],
    ] as const;
    out.push({
        type: 'World Map', title: 'Bookings per city',
        dataType: 'Geographic position (longitude, latitude) + one nominal label + one quantitative field.',
        message: 'The spatial pattern across the world.',
        encodings: { longitude: { field: 'lon' }, latitude: { field: 'lat' }, color: { field: 'city' }, size: { field: 'bookings' } },
        rows: worldCities.map(([city, lat, lon, bookings]) => ({ city, lat, lon, bookings })),
        metadata: { city: str(), lat: num('Latitude'), lon: num('Longitude'), bookings: num('Count') },
    });

    return out;
}

// ── rendering ────────────────────────────────────────────────────────────

function renderCli(bin: string, specFile: string, outFile: string, extra: string[] = []): Promise<string | null> {
    return new Promise((resolve) => {
        execFile(bin, [specFile, outFile, ...extra], { maxBuffer: 1 << 27 }, (err) => {
            if (err) return resolve(null);
            try { resolve(fs.readFileSync(outFile, 'utf-8')); } catch { resolve(null); }
        });
    });
}

let renderN = 0;
async function renderVl(vlSpec: any, id: string): Promise<string | null> {
    const safe = id.replace(/[^\w.-]+/g, '_');
    const specFile = path.join(outDir, 'spec', `${safe}.vl.json`);
    const svgFile = path.join(outDir, 'svg', `${safe}.svg`);
    fs.writeFileSync(specFile, JSON.stringify(vlSpec));
    renderN++;
    return renderCli(VL2SVG, specFile, svgFile);
}

const RASTER_THRESHOLD = 100_000;
async function embedOf(id: string, svg: string): Promise<string> {
    if (svg.length > RASTER_THRESHOLD) {
        const safe = id.replace(/[^\w.-]+/g, '_');
        const specFile = path.join(outDir, 'spec', `${safe}.vl.json`);
        const pngFile = path.join(outDir, 'svg', `${safe}.png`);
        const ok = await new Promise<boolean>((resolve) => {
            execFile(VL2PNG, [specFile, pngFile, '-s', '2'], { maxBuffer: 1 << 27 }, (err) => resolve(!err));
        });
        if (ok) {
            const png = fs.readFileSync(pngFile);
            return `<img alt="" loading="lazy" src="data:image/png;base64,${png.toString('base64')}">`;
        }
    }
    const raw = svg.replace(/^<\?xml[^>]*\?>\s*/, '');
    return `<img alt="" loading="lazy" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw)}">`;
}

// ── main ─────────────────────────────────────────────────────────────────

const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function main() {
    const exs = examples();
    const charts: SessionChart[] = exs.map((ex, i) => ({
        id: `t${i}`,
        title: ex.title,
        tableId: `tab${i}`,
        spec: { chartType: ex.type, encodings: ex.encodings, config: {} },
        rows: ex.rows,
        metadata: ex.metadata,
        focusMs: 1000 * (exs.length - i),
        visits: 1,
    }));
    const session: SessionData = {
        charts,
        tables: Object.fromEntries(charts.map(c => [c.tableId, { rows: c.rows, metadata: c.metadata }])),
    };

    console.log(`building matrices for ${charts.length} example charts…`);
    const { items, skipped } = await buildQuizItems({
        session, render: renderVl, topN: charts.length, seed: SEED,
        onProgress: (done, total, label) => label && console.log(`  [${done + 1}/${total}] ${label}`),
    });
    const itemByChart = new Map<string, QuizItem>(items.map(it => [it.chartId, it]));
    const skipByChart = new Map(skipped.map(s => [s.chartId, s.reason]));

    // Full candidate lists (beyond the picked matrix) + refusal reasons.
    interface Extra { cand: DistractorCandidate; embed: string }
    const sections: string[] = [];

    for (const chart of charts) {
        const ex = exs.find(e => e.title === chart.title)!;
        const item = itemByChart.get(chart.id);
        const curated = curatedFor(chart.spec.chartType);

        const all = withSeededRandom(SEED, () => generateAll(chart, session));
        const admittedTargets = new Set(all.filter(c => c.method === 'visual').map(c => c.spec.chartType));
        const admittedOps = new Set(all.filter(c => c.method === 'data').map(c => c.op));

        // refusals with reasons
        const roles = resolveRoles(chart);
        const refusals: string[] = [];
        for (const t of curated.visual) {
            if (!admittedTargets.has(t)) refusals.push(`✗ → ${t} — refused on this data (gate, field match, or compile probe).`);
        }
        for (const opId of curated.data) {
            if (admittedOps.has(opId)) continue;
            const op = MESSAGE_OPS.find(o => o.id === opId);
            const reason = op ? (op.gate(chart, roles) ?? 'passed its gate, but the floor or the story check dropped it') : 'unknown operator';
            refusals.push(`✗ ${opId} — ${reason}.`);
        }

        // extra candidates not shown in the matrix
        const inMatrix = new Set((item?.options ?? []).map(o => `${o.method ?? 'orig'}:${o.op ?? ''}:${o.chartType}`));
        const extras: Extra[] = [];
        for (const cand of all) {
            const key = `${cand.method}:${cand.op}:${cand.spec.chartType}`;
            if (inMatrix.has(key)) continue;
            const svg = await renderVl(compileToVegaLite(cand.spec, cand.rows, cand.metadata), `${chart.id}_x${extras.length}`);
            if (!svg) continue;
            extras.push({ cand, embed: await embedOf(`${chart.id}_x${extras.length - 0}`, svg) });
        }

        // matrix grid
        let matrixHtml = '';
        if (item) {
            const nV = Math.max(...item.options.map(o => o.cell.v));
            const nD = Math.max(...item.options.map(o => o.cell.d));
            const byCell = new Map(item.options.map(o => [`${o.cell.v}:${o.cell.d}`, o]));
            const embeds = new Map<string, string>();
            for (const o of item.options) embeds.set(o.id, await embedOf(o.id, o.svg));

            const colHead = ['<th class="axis-corner">mark ↓ · data →</th>', '<th>original data</th>'];
            for (let d = 1; d <= nD; d++) {
                const opt = byCell.get(`0:${d}`)!;
                colHead.push(`<th><span class="chip data">D${d} · ${esc(opt.dim)}</span> ${esc(opt.label)}</th>`);
            }
            let rowsHtml = '';
            for (let v = 0; v <= nV; v++) {
                const rowHead = v === 0
                    ? '<th>original mark</th>'
                    : `<th><span class="chip visual">V${v} · ${esc(byCell.get(`${v}:0`)!.band)}</span> ${esc(byCell.get(`${v}:0`)!.chartType)}</th>`;
                let cells = '';
                for (let d = 0; d <= nD; d++) {
                    const opt = byCell.get(`${v}:${d}`)!;
                    const cls = v === 0 && d === 0 ? 'orig' : v === 0 ? 'data' : d === 0 ? 'visual' : 'combined';
                    const tag = v === 0 && d === 0 ? 'ORIGINAL' : cls.toUpperCase();
                    cells += `<td class="cell ${cls}"><div class="plate">${embeds.get(opt.id)}</div><div class="celltag ${cls}">${tag}</div></td>`;
                }
                rowsHtml += `<tr>${rowHead}${cells}</tr>`;
            }
            matrixHtml = `<div class="matrixwrap"><table class="matrix"><thead><tr>${colHead.join('')}</tr></thead><tbody>${rowsHtml}</tbody></table></div>`;
        } else {
            matrixHtml = `<p class="skipnote">This chart is skipped: ${esc(skipByChart.get(chart.id) ?? 'no item could be made')}.</p>`;
        }

        const extraHtml = extras.length ? `
      <h4 class="extra-h">Admitted candidates the matrix did not pick</h4>
      <div class="grid">${extras.map(e => `
        <figure class="card ${e.cand.method}">
          <div class="plate">${e.embed}</div>
          <figcaption><span class="chip ${e.cand.method}">${e.cand.method}${e.cand.band ? ' · ' + e.cand.band : ''}${e.cand.dim ? ' · ' + e.cand.dim : ''}</span>
          <p class="why">${esc(e.cand.label)}</p></figcaption>
        </figure>`).join('')}</div>` : '';

        const refusalHtml = refusals.length
            ? `<p class="refusals">${refusals.map(esc).join('<br>')}</p>` : '';

        sections.push(`
  <section class="chart-type" id="${chart.id}">
    <h3>${esc(chart.spec.chartType)} <span class="extitle">— ${esc(ex.title)}</span></h3>
    <dl class="meta">
      <div><dt>Data type</dt><dd>${esc(ex.dataType)}</dd></div>
      <div><dt>Message</dt><dd>${esc(ex.message)}</dd></div>
      <div><dt>Curated</dt><dd>visual: ${esc(curated.visual.join(', ') || 'none')} · data: ${esc(curated.data.join(', ') || 'none')}</dd></div>
    </dl>
    ${matrixHtml}
    ${refusalHtml}
    ${extraHtml}
  </section>`);
    }

    const skippedTypes = `
  <section class="chart-type" id="skipped-types">
    <h3>Candlestick Chart · KPI Card <span class="extitle">— not quizzed</span></h3>
    <p class="skipnote">Candlestick: the reviewed lures (a close-only line; open/close reversal; big-day rotation)
    need machinery that does not exist yet — see "Deferred machinery" in docs/quiz-distractor-framework.md.
    KPI Card: one collapsed number has no look-alike space.</p>
  </section>`;

    const nav = charts.map(c => `<a href="#${c.id}">${esc(c.spec.chartType)}</a>`).join('');

    const html = `<title>Chart Perturbation Gallery</title>
<style>
:root{
  --paper:#faf9f7; --ink:#1c1d21; --ink-soft:#5c5e66; --line:#e3e1db;
  --plate:#ffffff; --plate-line:#dedcd5;
  --visual:#4753c6; --visual-soft:#eceefb;
  --data:#0e7a6e; --data-soft:#e4f2ef;
  --combined:#7A5EA8; --combined-soft:#f0ebf8;
  --banned:#b4483e; --banned-soft:#f9ecea;
  --chip-line:#c9c7c0;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --paper:#16171c; --ink:#e8e7e2; --ink-soft:#a2a4ad; --line:#2c2e36;
    --plate:#ffffff; --plate-line:#3a3c45;
    --visual:#98a2f0; --visual-soft:#232848;
    --data:#5fc6b8; --data-soft:#12332f;
    --combined:#b39ddb; --combined-soft:#2b2440;
    --banned:#e08a80; --banned-soft:#3a1f1c;
    --chip-line:#44464f;
  }
}
:root[data-theme="dark"]{
  --paper:#16171c; --ink:#e8e7e2; --ink-soft:#a2a4ad; --line:#2c2e36;
  --plate:#ffffff; --plate-line:#3a3c45;
  --visual:#98a2f0; --visual-soft:#232848;
  --data:#5fc6b8; --data-soft:#12332f;
  --combined:#b39ddb; --combined-soft:#2b2440;
  --banned:#e08a80; --banned-soft:#3a1f1c;
  --chip-line:#44464f;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
  font-family:Charter,Georgia,'Times New Roman',serif;font-size:16px;line-height:1.55}
h1,h2,h3,h4,.chip,.nav,.celltag,.axis-corner{font-family:'Avenir Next',Avenir,'Helvetica Neue',system-ui,sans-serif}
.wrap{max-width:1400px;margin:0 auto;padding:0 28px 96px}
header.page{padding:52px 0 8px;border-bottom:1px solid var(--line);margin-bottom:8px}
header.page h1{font-size:clamp(26px,4vw,38px);font-weight:600;letter-spacing:-.01em;margin:0 0 10px}
header.page p.lede{max-width:70ch;color:var(--ink-soft);margin:0 0 14px}
.def-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin:0 0 20px}
.def{border:1px solid var(--line);border-radius:8px;padding:14px 18px 10px}
.def-visual{border-top:3px solid var(--visual)} .def-data{border-top:3px solid var(--data)}
.def-combined{border-top:3px solid var(--combined)}
.def h2{font-size:12.5px;text-transform:uppercase;letter-spacing:.1em;margin:0 0 8px}
.def-visual h2{color:var(--visual)} .def-data h2{color:var(--data)} .def-combined h2{color:var(--combined)}
.def p{font-size:13.5px;color:var(--ink-soft);margin:0 0 8px;line-height:1.5}
.nav{position:sticky;top:0;z-index:5;background:var(--paper);border-bottom:1px solid var(--line);
  padding:8px 0;display:flex;flex-wrap:wrap;gap:3px 10px;font-size:12.5px}
.nav a{color:var(--ink);text-decoration:none;padding:2px 7px;border-radius:4px;white-space:nowrap}
.nav a:hover{background:var(--visual-soft)}
section.chart-type{padding:34px 0 14px;border-bottom:1px dashed var(--line);scroll-margin-top:56px}
.chart-type h3{font-size:23px;font-weight:600;margin:0 0 6px;letter-spacing:-.01em}
.extitle{font-size:15px;color:var(--ink-soft);font-weight:400;font-style:italic}
dl.meta{margin:8px 0 14px;display:grid;gap:4px}
dl.meta div{display:grid;grid-template-columns:92px 1fr;gap:12px;max-width:1000px}
dl.meta dt{font-family:'Avenir Next',Avenir,system-ui,sans-serif;font-size:10.5px;text-transform:uppercase;
  letter-spacing:.09em;color:var(--ink-soft);padding-top:4px}
dl.meta dd{margin:0;font-size:14.5px}
.matrixwrap{overflow-x:auto;margin:6px 0 10px}
table.matrix{border-collapse:separate;border-spacing:6px}
table.matrix th{font-family:'Avenir Next',Avenir,system-ui,sans-serif;font-size:11.5px;color:var(--ink-soft);
  font-weight:600;text-align:left;padding:2px 6px;vertical-align:bottom;max-width:240px}
.axis-corner{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-soft)}
td.cell{border:1px solid var(--line);border-radius:8px;padding:6px;background:var(--paper);min-width:240px;vertical-align:top}
td.cell.orig{border:2px solid var(--ink)}
td.cell.visual{border-top:3px solid var(--visual)}
td.cell.data{border-top:3px solid var(--data)}
td.cell.combined{border-top:3px solid var(--combined)}
.plate{background:var(--plate);border:1px solid var(--plate-line);border-radius:4px;padding:6px;
  display:flex;justify-content:center;overflow:hidden}
.plate img{max-width:100%;height:auto;max-height:230px;display:block}
.celltag{font-size:9.5px;letter-spacing:.08em;margin-top:5px;font-weight:600}
.celltag.orig{color:var(--ink)} .celltag.visual{color:var(--visual)}
.celltag.data{color:var(--data)} .celltag.combined{color:var(--combined)}
.chip{display:inline-block;font-size:11px;line-height:1;padding:4px 8px;border-radius:99px;border:1px solid var(--chip-line);font-weight:500}
.chip.visual{background:var(--visual-soft);color:var(--visual);border-color:transparent}
.chip.data{background:var(--data-soft);color:var(--data);border-color:transparent}
.chip.combined{background:var(--combined-soft);color:var(--combined);border-color:transparent}
.refusals{font-size:12.5px;color:var(--banned);line-height:1.9;border-left:3px solid var(--banned);
  padding:4px 0 4px 12px;margin:10px 0;max-width:80ch}
.extra-h{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--ink-soft);margin:16px 0 8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.card{margin:0;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--paper);padding:6px}
.card.visual{border-top:3px solid var(--visual)} .card.data{border-top:3px solid var(--data)}
.card.combined{border-top:3px solid var(--combined)}
figcaption{padding:7px 4px 4px}
p.why{margin:4px 0 0;font-size:13px;color:var(--ink-soft);line-height:1.45}
.skipnote{font-size:13.5px;color:var(--ink-soft);border-left:3px solid var(--banned);padding:4px 0 4px 12px;max-width:80ch}
footer{margin-top:48px;font-size:12.5px;color:var(--ink-soft)}
</style>
<div class="wrap">
<header class="page">
  <h1>Chart Perturbation Gallery</h1>
  <p class="lede">One example chart for each curated chart type, run through the SHIPPED quiz module
  (design v6, reviewed 2026-08-18): <code>buildQuizItems</code> from
  <code>src/lib/quiz-distractors</code> builds each option matrix below, rendered with the app's own
  chart assembler. What you see is what a participant gets.</p>
  <div class="def-grid">
    <div class="def def-visual"><h2>Visual perturbation</h2>
      <p>Keep the data; change the mark type, from the chart type's curated list. The finding stays.
      "Do they remember the tool?"</p></div>
    <div class="def def-data"><h2>Data perturbation</h2>
      <p>Keep the drawing; change what the data says, with the chart type's curated operators
      (direction / location / existence / strength). "Do they remember the finding?"</p></div>
    <div class="def def-combined"><h2>Combined perturbation</h2>
      <p>The visual lure's drawing over the data lure's rows — the cross cells of the matrix.
      A pick here encoded neither.</p></div>
  </div>
  <p class="lede">Each item aims for a 3×3 matrix: the original + 2 visual + 2 data + 4 combined.
  A chart type that admits only one lure on an axis shrinks toward 2×2. Red notes list the curated
  transformations this example's data refused, with the gate's reason.</p>
</header>
<nav class="nav">${nav}<a href="#skipped-types">Skipped types</a></nav>
${sections.join('\n')}
${skippedTypes}
<footer>${renderN} charts rendered with compileToVegaLite + vl2svg, seed ${SEED} · design v6 (reviewed 2026-08-18)
· companion to docs/quiz-distractor-framework.md</footer>
</div>`;

    fs.writeFileSync(htmlPath, html);
    const mb = (fs.statSync(htmlPath).size / 1024 / 1024).toFixed(2);
    console.log(`gallery → ${htmlPath} (${mb} MB, ${items.length} matrices, ${skipped.length} skipped)`);
    for (const s of skipped) console.log(`  skipped: ${s.title} [${s.chartType}] — ${s.reason}`);
}

main().catch(e => { console.error(e); process.exit(1); });
