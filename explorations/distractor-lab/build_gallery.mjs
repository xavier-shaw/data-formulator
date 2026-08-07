// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * distractor-lab/build_gallery.mjs — assemble the comparison gallery.
 *
 * Usage:  node build_gallery.mjs <outDir> <gallery.html>
 * Reads <outDir>/manifest.json and <outDir>/svg/*.svg, emits a single
 * self-contained HTML page (all charts inlined).
 */

import * as fs from 'fs';
import * as path from 'path';

const [outDir, htmlPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf-8'));

// Refuse to build a gallery from an unguarded manifest — the whole point of
// the drop report is that it is present and honest.
if (!manifest.charts?.length) throw new Error('manifest has no charts');
if (!manifest.drops) throw new Error('manifest predates the render-identity guard; re-run main.ts');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const svgOf = (file) => {
    const raw = fs.readFileSync(path.join(outDir, 'svg', file.replace('.vl.json', '.svg')), 'utf-8')
        .replace(/^<\?xml[^>]*\?>\s*/, '');
    // Single <img> node per chart (instead of thousands of inline SVG nodes)
    // keeps the page paintable with 250+ charts; data URI keeps it self-contained.
    return `<img alt="" loading="lazy" decoding="async" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw)}">`;
};
const fmt = (n) => (Math.round(n * 100) / 100).toString();

const METHOD_INFO = {
    'enumeration': {
        name: 'Enumeration',
        short: 'plausible-chart sweep',
        desc: 'CompassQL-style sweep of plausible charts over the same derived table — every dimension × measure × chart-form cell, seeded by Flint’s own encoding recommender. “Which of the charts DF could have shown did you actually see?”',
    },
    'graphscape': {
        name: 'GraphScape walks',
        short: 'controlled edit distance',
        desc: 'Atomic spec edits (re-sort, transpose, mark change, field replacement) composed to hit near / mid / far distance bands, with GraphScape-ordered costs. The workhorse for the misrecall-distance analysis. Sort goes on the <i>category</i> channel with a <code>sortBy</code> channel reference, which is what produces a by-value order — on the measure channel it compiles to a sort of a quantitative scale and never changes the render.',
    },
    'data-perturb': {
        name: 'Data perturbation',
        short: 'same form, different values',
        desc: 'Identical spec, perturbed values: rank swaps, full pattern inversion, flattened / exaggerated effects, peak shifts, single-label substitution. Spec distance is 0 by construction — these isolate memory of the pattern from memory of the form.',
    },
    'sibling-measure': {
        name: 'Sibling measure',
        short: 'real unplotted columns',
        desc: 'The participant’s own transform computed more columns than they plotted (incidents, any_damage_rate, totals). Swapping the measure to a real sibling column yields an internally-consistent chart of true data they never saw.',
    },
    'session-hybrid': {
        name: 'Session hybrid',
        short: 'interference lures',
        desc: 'This chart’s visual form × another session chart’s content (shared measure or dimension). Models interference between similar analyses within the session — the classic source of recognition errors.',
    },
};
const METHOD_ORDER = ['graphscape', 'enumeration', 'data-perturb', 'sibling-measure', 'session-hybrid'];

// ── overview scatter ─────────────────────────────────────────────────────

function buildScatter() {
    const pts = [];
    for (const c of manifest.charts) {
        for (const d of c.distractors) {
            pts.push({ x: d.specDist, y: d.dataDist, m: d.method, t: `${c.title} — ${d.label}` });
        }
    }
    const W = 760, H = 330, ML = 52, MR = 16, MT = 18, MB = 44;
    const maxX = Math.max(...pts.map(p => p.x), 4) + 0.4;
    const iw = W - ML - MR, ih = H - MT - MB;
    const px = (x) => ML + (x / maxX) * iw;
    const py = (y) => MT + (1 - y) * ih;
    // deterministic jitter to relieve overplotting at exact-zero rows
    const jit = (s) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 997; return (h / 997 - 0.5); };

    let dots = '';
    for (const p of pts) {
        const jx = jit(p.t) * 7, jy = jit(p.t + 'y') * 7;
        dots += `<circle cx="${(px(p.x) + jx).toFixed(1)}" cy="${(py(p.y) + jy).toFixed(1)}" r="4" class="pt pt-${p.m}"><title>${esc(p.t)}  (spec ${p.x}, data ${p.y})</title></circle>`;
    }
    let xticks = '';
    for (let x = 0; x <= Math.floor(maxX); x++) {
        xticks += `<line x1="${px(x)}" y1="${MT}" x2="${px(x)}" y2="${MT + ih}" class="grid"/><text x="${px(x)}" y="${H - MB + 16}" class="tick">${x}</text>`;
    }
    let yticks = '';
    for (const y of [0, 0.25, 0.5, 0.75, 1]) {
        yticks += `<line x1="${ML}" y1="${py(y)}" x2="${ML + iw}" y2="${py(y)}" class="grid"/><text x="${ML - 8}" y="${py(y) + 4}" text-anchor="end" class="tick">${y}</text>`;
    }
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Distractor distance map" style="width:100%;max-width:${W}px">
${yticks}${xticks}
<text x="${ML + iw / 2}" y="${H - 8}" class="axis">spec distance (GraphScape-style edit cost) →</text>
<text x="14" y="${MT + ih / 2}" class="axis" transform="rotate(-90 14 ${MT + ih / 2})">data distance →</text>
<text x="${ML + 8}" y="${py(0.97)}" class="quad">pattern lures — same form, different story</text>
<text x="${px(maxX) - 8}" y="${py(0.03) - 6}" text-anchor="end" class="quad">form lures — same story, different form</text>
${dots}
</svg>`;
}

// ── distractor card ──────────────────────────────────────────────────────

function card(c, d) {
    const edits = (d.edits ?? []).slice(0, 4).map(e =>
        `<li><span class="op">${esc(e.op)}</span> ${esc(e.detail)} <span class="cost">+${fmt(e.cost)}</span></li>`).join('');
    const more = (d.edits?.length ?? 0) > 4 ? `<li class="more">… ${d.edits.length - 4} more</li>` : '';
    const dataNote = d.dataEditNote ? `<li><span class="op">DATA</span> ${esc(d.dataEditNote)}</li>` : '';
    const caveat = d.caveat ? `<p class="caveat" title="${esc(d.caveat)}">seen-both caveat — needs “final version?” phrasing</p>` : '';
    const order = d.dataDetail?.order
        ? `<span title="Kendall-tau distance of the displayed row order, read off the compiled spec">order <b>${fmt(d.dataDetail.order)}</b></span>` : '';
    const also = (d.alsoFoundBy ?? []).length
        ? `<p class="also">also reached by ${d.alsoFoundBy.map(a => `<span class="mchip m-${a.method}">${METHOD_INFO[a.method].name}</span>`).join(' ')}</p>` : '';
    return `<figure class="card m-${d.method}" id="card-${d.id}" data-method="${d.method}" data-chart="${c.id}"
  data-spec="${d.specDist}" data-data="${d.dataDist}" data-label="${esc(d.label)}">
  <div class="chartbox">${svgOf(d.specFile)}</div>
  <figcaption>
    <p class="cardtitle">${esc(d.label)}</p>
    <p class="dist"><span title="GraphScape-style edit cost vs the original">spec <b>${fmt(d.specDist)}</b></span>
       <span title="rank / magnitude / label change of plotted values">data <b>${fmt(d.dataDist)}</b></span>${order}</p>
    <ul class="edits">${edits}${more}${dataNote}</ul>
    <p class="why">${esc(d.rationale)}</p>
    ${also}
    ${caveat}
  </figcaption>
</figure>`;
}

// ── per-chart section ────────────────────────────────────────────────────

function section(c, idx) {
    const groups = METHOD_ORDER
        .map(m => ({ m, ds: c.distractors.filter(d => d.method === m) }))
        .filter(g => g.ds.length);
    const enc = Object.entries(c.encodings).map(([ch, e]) => `${ch}: ${e.field}`).join(' · ');
    // Collapsible: keeps the document short enough for constrained compositors
    // (a 22k-px page overflows tile memory in embedded viewers) and matches
    // the inspect-one-chart-at-a-time workflow.
    return `<section class="chart-section" id="sec-${c.id}">
  <details class="secdetails"${idx === 0 ? ' open' : ''}>
  <summary>
    <h2>${esc(c.title)}</h2>
    <span class="meta"><span class="typechip">${esc(c.chartType)}</span>
      <span class="count">${c.distractors.length} lures</span></span>
  </summary>
  <p class="meta secmeta"><span class="mono">${esc(enc)}</span>
    <button class="quizbtn" data-chart="${c.id}">Preview quiz item</button></p>
  <div class="secbody">
    <figure class="card original" id="card-${c.id}_orig">
      <div class="chartbox">${svgOf(c.origSpecFile)}</div>
      <figcaption><p class="cardtitle">ORIGINAL — what the participant saw</p></figcaption>
    </figure>
    <div class="groups">
      ${groups.map(g => `<div class="mgroup">
        <h3 class="mlabel m-${g.m}">${METHOD_INFO[g.m].name}</h3>
        <div class="cards">${g.ds.map(d => card(c, d)).join('\n')}</div>
      </div>`).join('\n')}
    </div>
  </div>
  </details>
</section>`;
}

// ── page ─────────────────────────────────────────────────────────────────

const totalLures = manifest.charts.reduce((s, c) => s + c.distractors.length, 0);
const methodCounts = {};
for (const c of manifest.charts) for (const d of c.distractors)
    methodCounts[d.method] = (methodCounts[d.method] ?? 0) + 1;

const quizData = {};
for (const c of manifest.charts) {
    quizData[c.id] = {
        title: c.title,
        distractors: c.distractors.map(d => ({ id: d.id, method: d.method, label: d.label, spec: d.specDist, data: d.dataDist, caveat: !!d.caveat })),
    };
}

const html = `<meta charset="utf-8">
<title>Distractor Lab — FAA Wildlife Strikes</title>
<style>
:root {
  --paper: #FAFAF8; --panel: #FFFFFF; --ink: #23262B; --ink-2: #5A6068; --ink-3: #8B9199;
  --line: #E3E4E0; --accent: #2B5EA7; --accent-soft: #E8EEF7;
  --m-enumeration: #8A63BF; --m-graphscape: #C4652A; --m-data-perturb: #2E8B6B;
  --m-sibling-measure: #B5504B; --m-session-hybrid: #9C8425;
  --warn-bg: #FBF3DC; --warn-ink: #7A5D12;
}
@media (prefers-color-scheme: dark) { :root {
  --paper: #16181D; --panel: #1E2127; --ink: #E6E5E0; --ink-2: #A8ADB5; --ink-3: #767C85;
  --line: #2E323A; --accent: #7BA3D9; --accent-soft: #223349;
  --m-enumeration: #A98BD6; --m-graphscape: #D98A55; --m-data-perturb: #5BAE8F;
  --m-sibling-measure: #CD7A75; --m-session-hybrid: #B9A34E;
  --warn-bg: #38300F; --warn-ink: #D8BC62;
}}
:root[data-theme="light"] {
  --paper: #FAFAF8; --panel: #FFFFFF; --ink: #23262B; --ink-2: #5A6068; --ink-3: #8B9199;
  --line: #E3E4E0; --accent: #2B5EA7; --accent-soft: #E8EEF7;
  --m-enumeration: #8A63BF; --m-graphscape: #C4652A; --m-data-perturb: #2E8B6B;
  --m-sibling-measure: #B5504B; --m-session-hybrid: #9C8425;
  --warn-bg: #FBF3DC; --warn-ink: #7A5D12;
}
:root[data-theme="dark"] {
  --paper: #16181D; --panel: #1E2127; --ink: #E6E5E0; --ink-2: #A8ADB5; --ink-3: #767C85;
  --line: #2E323A; --accent: #7BA3D9; --accent-soft: #223349;
  --m-enumeration: #A98BD6; --m-graphscape: #D98A55; --m-data-perturb: #5BAE8F;
  --m-sibling-measure: #CD7A75; --m-session-hybrid: #B9A34E;
  --warn-bg: #38300F; --warn-ink: #D8BC62;
}
* { box-sizing: border-box; }
body { background: var(--paper); color: var(--ink); margin: 0;
  font: 15px/1.55 -apple-system, "Segoe UI", system-ui, sans-serif; }
h1, h2, h3 { font-family: "Avenir Next", "Seravek", -apple-system, "Segoe UI", system-ui, sans-serif; text-wrap: balance; }
.mono, .edits, .dist, .tick { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-variant-numeric: tabular-nums; }

.wrap { max-width: 1280px; margin: 0 auto; padding: 0 20px 80px; }
.page-head { padding: 40px 0 8px; border-bottom: 1px solid var(--line); }
.page-head h1 { font-size: 27px; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.01em; }
.page-head .sub { color: var(--ink-2); max-width: 72ch; margin: 0 0 4px; }
.page-head .facts { color: var(--ink-3); font-size: 13px; }

.methods { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin: 22px 0; }
.mcard { background: var(--panel); border: 1px solid var(--line); border-top: 3px solid var(--mc); border-radius: 6px; padding: 12px 14px; }
.mcard h3 { margin: 0 0 2px; font-size: 14.5px; color: var(--mc); }
.mcard .n { color: var(--ink-3); font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; }
.mcard p { margin: 6px 0 0; font-size: 13px; color: var(--ink-2); }
.m-enumeration { --mc: var(--m-enumeration); } .m-graphscape { --mc: var(--m-graphscape); }
.m-data-perturb { --mc: var(--m-data-perturb); } .m-sibling-measure { --mc: var(--m-sibling-measure); }
.m-session-hybrid { --mc: var(--m-session-hybrid); }

.overview { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px 20px; margin: 10px 0 26px; }
.overview h2 { margin: 0 0 4px; font-size: 18px; }
.overview .cap { color: var(--ink-2); font-size: 13.5px; max-width: 90ch; margin: 2px 0 12px; }
.pt { opacity: 0.72; } .pt:hover { opacity: 1; }
.pt-enumeration { fill: var(--m-enumeration); } .pt-graphscape { fill: var(--m-graphscape); }
.pt-data-perturb { fill: var(--m-data-perturb); } .pt-sibling-measure { fill: var(--m-sibling-measure); }
.pt-session-hybrid { fill: var(--m-session-hybrid); }
.grid { stroke: var(--line); stroke-width: 0.7; } .tick { fill: var(--ink-3); font-size: 11px; text-anchor: middle; }
.axis { fill: var(--ink-2); font-size: 12.5px; text-anchor: middle; }
.quad { fill: var(--ink-3); font-size: 12px; font-style: italic; }

.layout { display: grid; grid-template-columns: 220px 1fr; gap: 28px; align-items: start; }
.rail { position: sticky; top: 12px; max-height: calc(100vh - 24px); overflow-y: auto;
  border-right: 1px solid var(--line); padding: 8px 14px 8px 0; font-size: 13px; }
.rail h3 { margin: 4px 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-3); }
.rail a { display: block; color: var(--ink-2); text-decoration: none; padding: 4px 6px; border-radius: 4px; border-left: 2px solid transparent; }
.rail a:hover, .rail a:focus-visible { color: var(--accent); background: var(--accent-soft); }
.filters { margin-bottom: 14px; display: flex; flex-wrap: wrap; gap: 6px; }
.fbtn { font-size: 12px; padding: 3px 9px; border-radius: 99px; cursor: pointer;
  border: 1px solid var(--mc, var(--line)); background: transparent; color: var(--mc, var(--ink-2)); }
.fbtn[aria-pressed="true"] { background: var(--mc, var(--ink-2)); color: var(--paper); }

.chart-section { border-bottom: 1px solid var(--line); }
.card { content-visibility: auto; contain-intrinsic-size: auto 420px; }
.secdetails { padding: 10px 0; }
.secdetails summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px;
  cursor: pointer; padding: 10px 6px; border-radius: 6px; list-style: none; }
.secdetails summary::-webkit-details-marker { display: none; }
.secdetails summary::before { content: "▸"; color: var(--ink-3); font-size: 13px; }
.secdetails[open] summary::before { content: "▾"; color: var(--accent); }
.secdetails summary:hover, .secdetails summary:focus-visible { background: var(--accent-soft); }
.secdetails summary h2 { font-size: 17px; margin: 0; display: inline; }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; color: var(--ink-3); font-size: 12.5px; }
.secmeta { margin: 2px 0 14px 24px; }
.typechip { background: var(--accent-soft); color: var(--accent); border-radius: 4px; padding: 2px 8px; font-weight: 600; font-size: 12px; }
.count { letter-spacing: 0.04em; }
.quizbtn { margin-left: auto; font-size: 12.5px; padding: 5px 12px; border-radius: 5px; cursor: pointer;
  border: 1px solid var(--accent); color: var(--accent); background: transparent; font-weight: 600; }
.quizbtn:hover, .quizbtn:focus-visible { background: var(--accent); color: var(--paper); }

.secbody { display: grid; grid-template-columns: 240px 1fr; gap: 20px; align-items: start; }
@media (max-width: 900px) { .layout, .secbody { grid-template-columns: 1fr; } .rail { position: static; border-right: 0; } }
.original { border: 2px solid var(--accent); position: sticky; top: 12px; }
.original .cardtitle { color: var(--accent); font-weight: 700; letter-spacing: 0.04em; font-size: 11.5px; }

.mgroup { margin-bottom: 18px; }
.mlabel { font-size: 12px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--mc); margin: 0 0 8px; }
.cards { display: flex; flex-wrap: wrap; gap: 14px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 7px; margin: 0;
  width: 236px; padding: 8px; display: flex; flex-direction: column; }
.card.m-enumeration, .card.m-graphscape, .card.m-data-perturb, .card.m-sibling-measure, .card.m-session-hybrid { border-top: 3px solid var(--mc); }
.chartbox { background: #fff; border-radius: 4px; display: flex; justify-content: center; align-items: center;
  min-height: 150px; overflow: hidden; }
.chartbox svg, .chartbox img { max-width: 100%; height: auto; max-height: 240px; }
.cardtitle { font-size: 12.5px; margin: 8px 0 2px; line-height: 1.35; }
.mchip { display: inline-block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--mc); border: 1px solid var(--mc); border-radius: 3px; padding: 0 4px; }
.also { font-size: 11px; color: var(--ink-3); margin: 6px 0 0; }
.guard { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px 20px; margin: 0 0 26px; }
.guard h2 { margin: 0 0 4px; font-size: 17px; }
.guard p { color: var(--ink-2); font-size: 13.5px; max-width: 92ch; margin: 2px 0 12px; }
.guard table { border-collapse: collapse; font-size: 12.5px; width: 100%; }
.guard th { text-align: left; color: var(--ink-3); font-weight: 600; font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.05em; padding: 4px 12px 4px 0; border-bottom: 1px solid var(--line); }
.guard td { padding: 4px 12px 4px 0; border-bottom: 1px solid var(--line); color: var(--ink-2); }
.guard td b { color: var(--ink); font-variant-numeric: tabular-nums; }
.guardwrap { overflow-x: auto; }
.dist { font-size: 12px; color: var(--ink-2); margin: 0 0 4px; display: flex; gap: 12px; }
.dist b { color: var(--ink); }
.edits { list-style: none; margin: 0; padding: 0; font-size: 11px; color: var(--ink-2); }
.edits li { padding: 1px 0; } .edits .more { color: var(--ink-3); }
.op { color: var(--mc, var(--accent)); font-weight: 700; font-size: 10px; letter-spacing: 0.04em; }
.cost { color: var(--ink-3); float: right; }
.why { font-size: 12px; color: var(--ink-3); margin: 6px 0 0; }
.caveat { font-size: 11px; background: var(--warn-bg); color: var(--warn-ink); border-radius: 4px; padding: 3px 7px; margin: 6px 0 0; }

dialog.quiz { border: 1px solid var(--line); border-radius: 10px; background: var(--paper); color: var(--ink);
  max-width: 860px; width: 92vw; padding: 20px; }
dialog.quiz::backdrop { background: rgba(10, 12, 16, 0.55); }
.quiz h2 { margin: 0 0 2px; font-size: 17px; }
.quiz .qsub { color: var(--ink-2); font-size: 13px; margin: 0 0 14px; }
.qgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 640px) { .qgrid { grid-template-columns: 1fr; } }
.qopt { border: 2px solid var(--line); border-radius: 8px; background: var(--panel); cursor: pointer; padding: 8px; }
.qopt .chartbox { pointer-events: none; }
.qopt:hover, .qopt:focus-visible { border-color: var(--accent); }
.quiz.revealed .qopt { cursor: default; }
.quiz.revealed .qopt.is-orig { border-color: #2E8B57; box-shadow: 0 0 0 2px #2E8B5744; }
.quiz.revealed .qopt.picked-wrong { border-color: #C0392B; }
.qverdict { min-height: 44px; margin: 12px 0 0; font-size: 13.5px; }
.qverdict .mono { font-size: 12.5px; }
.qactions { display: flex; gap: 8px; margin-top: 8px; }
.qactions button { font-size: 13px; padding: 6px 14px; border-radius: 5px; cursor: pointer;
  border: 1px solid var(--line); background: var(--panel); color: var(--ink); }
.qactions button:hover { border-color: var(--accent); color: var(--accent); }

.notes { margin-top: 30px; color: var(--ink-2); font-size: 13.5px; max-width: 84ch; }
.notes h2 { font-size: 16px; color: var(--ink); }
.notes code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12.5px; background: var(--panel); border: 1px solid var(--line); border-radius: 3px; padding: 0 4px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
</style>

<div class="wrap">
<header class="page-head">
  <h1>Distractor Lab — chart-recognition quiz over Nic’s FAA Wildlife Strikes analysis</h1>
  <p class="sub">Five ways to generate “which chart did you actually see?” lures for every chart in the study session.
  All lures are compiled and rendered by Data Formulator’s own chart pipeline (Flint), so they are visually
  in-distribution with the originals. Every lure is scored on two orthogonal axes: <b>spec distance</b>
  (GraphScape-style edit cost — how different the visual form is) and <b>data distance</b> (how different the
  plotted values are). When a participant picks a lure, those two numbers say <i>what</i> they mis-remembered.</p>
  <p class="facts">${manifest.charts.length} session charts · ${totalLures} distractors · methods: ${METHOD_ORDER.map(m => `${METHOD_INFO[m].name} ${methodCounts[m] ?? 0}`).join(' · ')}</p>
</header>

<div class="methods">
${METHOD_ORDER.map(m => `<div class="mcard m-${m}">
  <h3>${METHOD_INFO[m].name}</h3><span class="n">${methodCounts[m] ?? 0} lures · ${METHOD_INFO[m].short}</span>
  <p>${METHOD_INFO[m].desc}</p>
</div>`).join('\n')}
</div>

<div class="guard">
  <h2>Render-identity guard</h2>
  <p>A lure that renders <i>pixel-identical</i> to the original is a broken quiz item — the participant
  would be shown two correct answers. Spec-level identity does not catch these (a “Bar Chart” and a
  “Stacked Bar Chart” with no color channel are different specs that render the same), so every candidate
  is rendered and hashed, and anything matching the original — or a lure already kept — is dropped.
  The build fails if any survive. This table is what the guard removed on this run.</p>
  <div class="guardwrap"><table>
    <thead><tr><th>Reason</th><th>Dropped</th><th>What it was</th></tr></thead>
    <tbody>
      <tr><td>identical to original</td><td><b>${manifest.dropSummary?.['identical-to-original'] ?? 0}</b></td>
        <td>degenerate edits — e.g. perturbing a measure that is all zeros, or a mark swap the compiler collapses back</td></tr>
      <tr><td>duplicate of a kept lure</td><td><b>${manifest.dropSummary?.['duplicate-of-kept-lure'] ?? 0}</b></td>
        <td>two methods reaching the same chart; first keeps it, the other is recorded as “also reached by”</td></tr>
      <tr><td>degenerate render</td><td><b>${manifest.dropSummary?.['degenerate-render'] ?? 0}</b></td>
        <td>chart drew <code>NaN</code>/<code>undefined</code> labels — visibly broken, so a participant could eliminate it on sight and inflate accuracy</td></tr>
      ${manifest.dropSummary?.['render-failed'] ? `<tr><td>render failed</td><td><b>${manifest.dropSummary['render-failed']}</b></td><td>candidate did not survive Vega-Lite rendering</td></tr>` : ''}
      ${manifest.dropSummary?.['compile-failed'] ? `<tr><td>compile failed</td><td><b>${manifest.dropSummary['compile-failed']}</b></td><td>candidate did not compile to a valid spec</td></tr>` : ''}
    </tbody>
  </table></div>
</div>

<div class="overview">
  <h2>Distance map — what each method probes</h2>
  <p class="cap">Each dot is one distractor, positioned by its distance from the original chart.
  The two axes are the two kinds of memory the quiz can separate: methods hugging the x-axis test
  <i>form</i> memory (same values, different look), methods hugging the y-axis test <i>pattern</i> memory
  (same look, different values). Session hybrids and compound GraphScape walks land in the middle — they change both.
  Small jitter added to relieve overplotting; hover a dot for its identity.</p>
  ${buildScatter()}
</div>

<div class="layout">
<nav class="rail">
  <h3>Filter methods</h3>
  <div class="filters">
    ${METHOD_ORDER.map(m => `<button class="fbtn m-${m}" data-method="${m}" aria-pressed="true">${METHOD_INFO[m].name}</button>`).join('\n')}
  </div>
  <h3>Session charts</h3>
  ${manifest.charts.map(c => `<a href="#sec-${c.id}">${esc(c.title)}</a>`).join('\n')}
</nav>

<main>
${manifest.charts.map(section).join('\n')}

<div class="notes">
  <h2>Where Flint fits</h2>
  <p>Every method above generates at the <i>semantic</i> level (chart type + field encodings) and compiles through
  Flint’s assembler — that is what guarantees each lure is a coherent, DF-native chart rather than a broken
  Vega-Lite mutation. Enumeration is additionally seeded by <code>vlRecommendEncodings</code> (Flint’s own
  recommender), and mark transitions reuse <code>vlAdaptChart</code>, Flint’s channel-adaptation logic.
  A production QuizGenAgent can author further <i>semantically plausible</i> lures as Flint specs directly
  (e.g. “confuse the rate with the count”) — the sibling-measure and session-hybrid methods are the
  deterministic core of that idea.</p>
  <h2>Order is a spec property, not a data property</h2>
  <p>A re-sorted lure changes no values, so <code>dataDistance</code> — which keys rows by category —
  scores it 0, and a spec diff recovers nothing because the rows are untouched. Left alone it would land at
  <code>(0, 0)</code>: the coordinate that means “identical”, which would quietly delete every order-based
  misrecall from the analysis. Two fixes: generators <i>declare</i> edits a diff cannot recover (so a re-sort
  costs 0.5 on the spec axis, matching GraphScape's treatment of sort), and the reported
  <code>order</code> figure is a Kendall-tau distance computed from the <i>compiled</i> spec — the only place
  the displayed sequence is knowable, since a Bar Table re-sorts into an explicit domain array no matter what
  order its rows arrive in.</p>
  <h2>Distances</h2>
  <p><b>Spec distance</b> sums GraphScape-ordered edit costs recovered by diffing lure vs original:
  sort flip 0.5 · within-family mark swap 1.0 · transpose 1.0 · channel move 1.2 · add/remove encoding 1.4 ·
  cross-family mark 1.8–2.6 · field replacement 2.0–2.8. <b>Data distance</b> is
  max(rank disagreement, normalized magnitude change, label turnover) of the plotted values, in [0, 1].
  In the study, the (spec, data) coordinates of the lure a participant chooses — averaged over misses —
  estimate what they actually encoded: form, pattern, or neither.</p>
</div>
</main>
</div>
</div>

<dialog class="quiz" id="quizDialog">
  <h2 id="quizTitle"></h2>
  <p class="qsub">Which of these did the participant’s session actually contain? Click your answer.</p>
  <div class="qgrid" id="quizGrid"></div>
  <p class="qverdict" id="quizVerdict"></p>
  <div class="qactions">
    <button id="quizResample">Resample lures</button>
    <button id="quizClose">Close</button>
  </div>
</dialog>

<script>
const QUIZ = ${JSON.stringify(quizData)};

// rail navigation: open the target section's details, then scroll
document.querySelectorAll('.rail a[href^="#sec-"]').forEach(a => {
  a.addEventListener('click', (ev) => {
    ev.preventDefault();
    const sec = document.querySelector(a.getAttribute('href'));
    if (!sec) return;
    sec.querySelector('.secdetails').open = true;
    sec.scrollIntoView({ block: 'start' });
  });
});

// method filters
document.querySelectorAll('.fbtn').forEach(btn => {
  btn.addEventListener('click', () => {
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    const m = btn.dataset.method;
    document.querySelectorAll('.card[data-method="' + m + '"]').forEach(c => { c.style.display = on ? '' : 'none'; });
    document.querySelectorAll('.mgroup').forEach(g => {
      const anyVisible = [...g.querySelectorAll('.card')].some(c => c.style.display !== 'none');
      g.style.display = anyVisible ? '' : 'none';
    });
  });
});

// quiz preview
const dlg = document.getElementById('quizDialog');
const grid = document.getElementById('quizGrid');
const verdict = document.getElementById('quizVerdict');
let currentChart = null;

function sampleQuiz(chartId) {
  const info = QUIZ[chartId];
  const pool = info.distractors.filter(d => !d.caveat);
  // prefer three distinct methods; within a method pick the hardest (lowest combined distance)
  const byMethod = new Map();
  for (const d of pool) {
    const k = d.method;
    if (!byMethod.has(k) || (d.spec + d.data) < (byMethod.get(k).spec + byMethod.get(k).data)) byMethod.set(k, d);
  }
  const methods = [...byMethod.keys()];
  for (let i = methods.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [methods[i], methods[j]] = [methods[j], methods[i]]; }
  const lures = methods.slice(0, 3).map(m => byMethod.get(m));
  while (lures.length < 3 && pool.length > lures.length) {
    const next = pool.find(d => !lures.includes(d));
    if (!next) break; lures.push(next);
  }
  const options = [{ id: chartId + '_orig', orig: true }, ...lures.map(d => ({ id: d.id, orig: false, d }))];
  for (let i = options.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [options[i], options[j]] = [options[j], options[i]]; }
  return options;
}

function openQuiz(chartId) {
  currentChart = chartId;
  const info = QUIZ[chartId];
  document.getElementById('quizTitle').textContent = info.title;
  dlg.classList.remove('revealed');
  verdict.textContent = '';
  grid.innerHTML = '';
  for (const opt of sampleQuiz(chartId)) {
    const src = document.querySelector('#card-' + CSS.escape(opt.id) + ' .chartbox');
    const el = document.createElement('button');
    el.className = 'qopt' + (opt.orig ? ' is-orig' : '');
    el.appendChild(src.cloneNode(true));
    el.addEventListener('click', () => {
      if (dlg.classList.contains('revealed')) return;
      dlg.classList.add('revealed');
      if (opt.orig) {
        verdict.innerHTML = '<b>Correct</b> — that is the chart from the session.';
      } else {
        el.classList.add('picked-wrong');
        verdict.innerHTML = '<b>Miss.</b> Chosen lure: <span class="mono">' + opt.d.label +
          '</span> (' + opt.d.method + ') at <span class="mono">spec ' + opt.d.spec + ', data ' + opt.d.data +
          '</span> — in the study this pair of numbers is the misrecall-distance datapoint.';
      }
    });
    grid.appendChild(el);
  }
  if (!dlg.open) dlg.showModal();
}

document.querySelectorAll('.quizbtn').forEach(b => b.addEventListener('click', () => openQuiz(b.dataset.chart)));
document.getElementById('quizResample').addEventListener('click', () => openQuiz(currentChart));
document.getElementById('quizClose').addEventListener('click', () => dlg.close());
</script>`;

fs.writeFileSync(htmlPath, html);
const mb = (fs.statSync(htmlPath).size / 1024 / 1024).toFixed(2);
console.log(`gallery → ${htmlPath} (${mb} MB, ${manifest.charts.length} charts, ${totalLures} lures)`);
