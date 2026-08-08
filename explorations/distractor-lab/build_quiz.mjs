// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * distractor-lab/build_quiz.mjs — a chart-recognition QUIZ artifact.
 *
 * Usage:  node build_quiz.mjs <outDir> <quiz.html> [topN]
 *
 * Unlike build_gallery.mjs (which compares every method side by side), this
 * makes a playable quiz: one question per chart, four options (the real chart
 * + three hardest distractors), and it records whether each pick is right or
 * wrong. Charts are chosen by FOCUS TIME (state.chartUsage) — the ones the
 * participant looked at longest — and only "fair" charts are used (see below).
 *
 * Selection rules:
 *   • rank charts by focusMs, descending
 *   • keep a chart only if the correct answer is NOT the only one of its chart
 *     family (otherwise "pick the only map" is a giveaway, not a memory test)
 *   • take the top `topN` that pass (default 12)
 *
 * Per question the three distractors are the CLOSEST available (smallest
 * spec+data distance) — the hardest to tell apart — deduped by render.
 */

import * as fs from 'fs';
import * as path from 'path';

const [outDir, htmlPath, topNArg] = process.argv.slice(2);
if (!outDir || !htmlPath) {
    console.error('usage: node build_quiz.mjs <outDir> <quiz.html> [topN]');
    process.exit(1);
}
const TOP_N = Number(topNArg ?? 12);

const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf-8'));

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (n) => (Math.round(n * 100) / 100).toString();
function imgOf(specFile) {
    const raw = fs.readFileSync(path.join(outDir, 'svg', specFile.replace('.vl.json', '.svg')), 'utf-8')
        .replace(/^<\?xml[^>]*\?>\s*/, '');
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw)}`;
}

// ── chart families (for the "not the only one of its kind" fairness rule) ──
const FAMILY = {
    'Bar Chart': 'bar', 'Bar Table': 'bar', 'Grouped Bar Chart': 'bar', 'Stacked Bar Chart': 'bar',
    'Lollipop Chart': 'bar', 'Pyramid Chart': 'bar', 'Histogram': 'bar', 'Waterfall Chart': 'bar',
    'Line Chart': 'line', 'Area Chart': 'line', 'Bump Chart': 'line', 'Streamgraph': 'line',
    'Scatter Plot': 'point', 'Strip Plot': 'point', 'Ranged Dot Plot': 'point', 'Regression': 'point',
    'Pie Chart': 'radial', 'Rose Chart': 'radial', 'Radar Chart': 'radial',
    'Heatmap': 'grid', 'US Map': 'geo', 'World Map': 'geo',
};
const famOf = (t) => FAMILY[t] ?? 'other';

const METHOD_NAME = {
    'enumeration': 'Enumeration', 'graphscape': 'GraphScape walk',
    'data-perturb': 'Data perturbation', 'sibling-measure': 'Sibling measure',
    'session-hybrid': 'Session hybrid',
};

// ── build the question set ────────────────────────────────────────────────

// Methods the quiz must not draw distractors from. data-perturb keeps the exact
// chart form and nudges values (spec 0, small data distance); the change is too
// subtle to notice, so it makes trivially-missed "gotcha" items rather than a
// real recognition test. It stays in the gallery (a method showcase) but is
// barred from the quiz.
const QUIZ_EXCLUDE_METHODS = new Set(['data-perturb']);

const secs = (ms) => Math.round((ms ?? 0) / 1000);

/** pick the 3 hardest distractors: nearest by (spec+data), deduped by render */
function pickDistractors(chart) {
    const pool = (chart.distractors ?? [])
        .filter(d => !d.caveat && !QUIZ_EXCLUDE_METHODS.has(d.method))
        .sort((a, b) => (a.specDist + a.dataDist) - (b.specDist + b.dataDist));
    const seen = new Set();
    const out = [];
    for (const d of pool) {
        if (seen.has(d.renderHash)) continue;
        seen.add(d.renderHash);
        out.push(d);
        if (out.length === 3) break;
    }
    return out;
}

const ranked = [...manifest.charts]
    .filter(c => c.quizEligible)
    .sort((a, b) => (b.focusMs ?? 0) - (a.focusMs ?? 0));

const questions = [];
const excluded = [];
for (const c of ranked) {
    const distractors = pickDistractors(c);
    const familyRepresented = distractors.some(d => famOf(d.chartType) === famOf(c.chartType));
    if (distractors.length < 3) { excluded.push({ title: c.title, reason: 'fewer than 3 distinct distractors' }); continue; }
    if (!familyRepresented) { excluded.push({ title: c.title, reason: `no distractor shares its family (${famOf(c.chartType)}) — would be a giveaway` }); continue; }
    questions.push({
        chartId: c.id,
        title: c.title,
        chartType: c.chartType,
        focusMs: c.focusMs,
        correct: { id: `${c.id}_orig`, img: imgOf(c.origSpecFile) },
        options: distractors.map(d => ({
            id: d.id, img: imgOf(d.specFile),
            method: d.method, methodName: METHOD_NAME[d.method] ?? d.method,
            label: d.label, spec: d.specDist, data: d.dataDist,
        })),
    });
    if (questions.length >= TOP_N) break;
}

if (questions.length === 0) { console.error('no quiz-worthy charts found'); process.exit(1); }

// Data the page needs. Images are baked into each option node in the DOM;
// this table drives scoring, order shuffling, and the results screen.
const QUIZ = questions.map((q, i) => ({
    n: i + 1,
    chartId: q.chartId,
    title: q.title,
    chartType: q.chartType,
    focusSec: secs(q.focusMs),
    correctId: q.correct.id,
    distractors: q.options.map(o => ({ id: o.id, method: o.method, methodName: o.methodName, label: o.label, spec: o.spec, data: o.data })),
}));

// ── option cards (images live in the DOM; JS shows/hides + shuffles) ──────

function optionNode(id, img) {
    return `<button class="opt" data-id="${id}"><img alt="" loading="lazy" decoding="async" src="${img}"></button>`;
}
function questionSlide(q, idx) {
    const opts = [q.correct, ...q.options];
    return `<div class="slide" data-q="${idx}" hidden>
  <div class="qgrid">
    ${opts.map(o => optionNode(o.id, o.img)).join('\n    ')}
  </div>
</div>`;
}

const slides = questions.map(questionSlide).join('\n');
const focusRange = `${secs(questions[questions.length - 1].focusMs)}–${secs(questions[0].focusMs)}s`;

const html = `<meta charset="utf-8">
<title>Chart-Recognition Quiz — Yuwei FAA</title>
<style>
:root {
  --paper:#FAFAF8; --panel:#FFFFFF; --ink:#23262B; --ink-2:#5A6068; --ink-3:#8B9199;
  --line:#E3E4E0; --accent:#2B5EA7; --accent-soft:#E8EEF7;
  --good:#2E8B57; --good-soft:#E5F2EA; --bad:#C0392B; --bad-soft:#FBEAE8;
}
@media (prefers-color-scheme: dark) { :root {
  --paper:#16181D; --panel:#1E2127; --ink:#E6E5E0; --ink-2:#A8ADB5; --ink-3:#767C85;
  --line:#2E323A; --accent:#7BA3D9; --accent-soft:#223349;
  --good:#5FB98A; --good-soft:#1C2E24; --bad:#E0776E; --bad-soft:#3A211E;
}}
:root[data-theme="light"] {
  --paper:#FAFAF8; --panel:#FFFFFF; --ink:#23262B; --ink-2:#5A6068; --ink-3:#8B9199;
  --line:#E3E4E0; --accent:#2B5EA7; --accent-soft:#E8EEF7;
  --good:#2E8B57; --good-soft:#E5F2EA; --bad:#C0392B; --bad-soft:#FBEAE8;
}
:root[data-theme="dark"] {
  --paper:#16181D; --panel:#1E2127; --ink:#E6E5E0; --ink-2:#A8ADB5; --ink-3:#767C85;
  --line:#2E323A; --accent:#7BA3D9; --accent-soft:#223349;
  --good:#5FB98A; --good-soft:#1C2E24; --bad:#E0776E; --bad-soft:#3A211E;
}
* { box-sizing:border-box; }
body { background:var(--paper); color:var(--ink); margin:0;
  font:15px/1.55 -apple-system,"Segoe UI",system-ui,sans-serif; }
h1,h2 { font-family:"Avenir Next","Seravek",-apple-system,system-ui,sans-serif; text-wrap:balance; }
.mono { font-family:ui-monospace,"SF Mono",Menlo,monospace; font-variant-numeric:tabular-nums; }
.wrap { max-width:900px; margin:0 auto; padding:28px 20px 80px; }

/* progress */
.top { display:flex; align-items:center; gap:14px; margin-bottom:20px; }
.top h1 { font-size:18px; margin:0; font-weight:600; }
.bar { flex:1; height:7px; background:var(--line); border-radius:99px; overflow:hidden; }
.bar span { display:block; height:100%; width:0; background:var(--accent); transition:width .25s ease; }
.count { font-size:13px; color:var(--ink-3); white-space:nowrap; font-variant-numeric:tabular-nums; }

/* start + results panels */
.panel { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:26px 28px; }
.panel h2 { margin:0 0 8px; font-size:20px; }
.panel p { color:var(--ink-2); margin:0 0 12px; max-width:64ch; }
.btn { font:inherit; font-size:14px; font-weight:600; padding:9px 18px; border-radius:7px; cursor:pointer;
  border:1px solid var(--accent); background:var(--accent); color:#fff; }
.btn:hover { filter:brightness(1.06); }
.btn.ghost { background:transparent; color:var(--accent); }
.btn:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-top:8px; }

/* question */
.qhead { font-size:16px; margin:0 0 14px; }
.qgrid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
@media (max-width:620px){ .qgrid { grid-template-columns:1fr; } }
.opt { padding:10px; background:#fff; border:2px solid var(--line); border-radius:10px; cursor:pointer;
  display:flex; align-items:center; justify-content:center; min-height:180px; transition:border-color .12s; }
.opt img { max-width:100%; max-height:230px; height:auto; }
.opt:hover:not(:disabled) { border-color:var(--accent); }
.opt:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.opt:disabled { cursor:default; }
.opt.pick-correct { border-color:var(--good); box-shadow:0 0 0 3px var(--good-soft); }
.opt.pick-wrong   { border-color:var(--bad);  box-shadow:0 0 0 3px var(--bad-soft); }
.opt.reveal-correct { border-color:var(--good); }

.verdict { margin:16px 0 0; min-height:26px; font-size:14px; }
.verdict.good { color:var(--good); } .verdict.bad { color:var(--bad); }
.verdict .mono { color:var(--ink-2); }
.nav { display:flex; justify-content:flex-end; margin-top:14px; }

/* results */
.score { font-size:44px; font-weight:700; letter-spacing:-.02em; margin:4px 0 2px; }
.score small { font-size:17px; color:var(--ink-3); font-weight:500; }
.rtable { width:100%; border-collapse:collapse; font-size:13px; margin-top:14px; }
.rtable th { text-align:left; color:var(--ink-3); font-weight:600; font-size:11px; text-transform:uppercase;
  letter-spacing:.04em; padding:6px 10px 6px 0; border-bottom:1px solid var(--line); }
.rtable td { padding:7px 10px 7px 0; border-bottom:1px solid var(--line); color:var(--ink-2); vertical-align:top; }
.rtable .ok { color:var(--good); font-weight:600; } .rtable .no { color:var(--bad); font-weight:600; }
.rwrap { overflow-x:auto; }
.hint { font-size:12.5px; color:var(--ink-3); margin-top:10px; }
@media (prefers-reduced-motion: reduce){ *{ transition:none !important; } }
</style>

<div class="wrap">
  <div class="top">
    <h1>Which chart did you make?</h1>
    <div class="bar"><span id="progressBar"></span></div>
    <div class="count" id="progressText"></div>
  </div>

  <div class="panel" id="startPanel">
    <h2>Chart-recognition quiz</h2>
    <p>This quiz shows ${questions.length} of the charts from the <b>Yuwei FAA</b> session — the ones with the
    most focus time (${focusRange}). For each one you see four charts: the real one and three look-alikes made
    by the distractor methods. Pick the chart you think you actually made.</p>
    <p class="hint">Each wrong pick is recorded with how far the look-alike sits from the real chart, on the
    form axis (<span class="mono">spec</span>) and the values axis (<span class="mono">data</span>). You can
    download all your answers at the end.</p>
    <div class="row"><button class="btn" id="startBtn">Start quiz</button></div>
  </div>

  <div id="quizArea" hidden>
    <p class="qhead" id="qhead"></p>
    ${slides}
    <p class="verdict" id="verdict"></p>
    <div class="nav"><button class="btn" id="nextBtn" hidden>Next</button></div>
  </div>

  <div class="panel" id="resultPanel" hidden>
    <h2>Results</h2>
    <div class="score" id="scoreLine"></div>
    <p id="scoreSub" class="hint"></p>
    <div class="rwrap"><table class="rtable" id="resultTable"></table></div>
    <div class="row">
      <button class="btn" id="downloadBtn">Download answers (JSON)</button>
      <button class="btn ghost" id="restartBtn">Restart</button>
    </div>
    <p class="hint">On a miss, the look-alike's <span class="mono">(spec, data)</span> distance is the
    misrecall datapoint: a small <span class="mono">spec</span> means you kept the form but not the values;
    a small <span class="mono">data</span> means the reverse.</p>
  </div>
</div>

<script>
const QUIZ = ${JSON.stringify(QUIZ)};
const shuffle = (a) => { for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; };

const answers = [];          // {n, chartId, title, chartType, correct: bool, picked, method, spec, data}
let cur = 0;

const startPanel = document.getElementById('startPanel');
const quizArea = document.getElementById('quizArea');
const resultPanel = document.getElementById('resultPanel');
const qhead = document.getElementById('qhead');
const verdict = document.getElementById('verdict');
const nextBtn = document.getElementById('nextBtn');
const bar = document.getElementById('progressBar');
const ptext = document.getElementById('progressText');
const slides = [...document.querySelectorAll('.slide')];

function showProgress() {
  const done = Math.min(cur, QUIZ.length);
  bar.style.width = (100 * done / QUIZ.length) + '%';
  ptext.textContent = Math.min(cur + 1, QUIZ.length) + ' / ' + QUIZ.length;
}

function renderQuestion(i) {
  const q = QUIZ[i];
  slides.forEach(s => s.hidden = (+s.dataset.q !== i));
  qhead.textContent = 'Question ' + (i + 1) + ' — you spent about ' + q.focusSec + 's on this chart in the session.';
  verdict.textContent = ''; verdict.className = 'verdict';
  nextBtn.hidden = true;
  nextBtn.textContent = (i === QUIZ.length - 1) ? 'See results' : 'Next';
  showProgress();

  const slide = slides[i];
  const opts = [...slide.querySelectorAll('.opt')];
  opts.forEach(o => { o.disabled = false; o.className = 'opt'; });
  shuffle(opts).forEach(o => slide.querySelector('.qgrid').appendChild(o)); // reorder DOM

  opts.forEach(o => {
    o.onclick = () => {
      if (o.disabled) return;
      const pickedId = o.dataset.id;
      const isCorrect = pickedId === q.correctId;
      opts.forEach(x => {
        x.disabled = true;
        if (x.dataset.id === q.correctId) x.classList.add('reveal-correct');
      });
      o.classList.add(isCorrect ? 'pick-correct' : 'pick-wrong');

      const chosen = q.distractors.find(d => d.id === pickedId);
      answers[i] = {
        n: q.n, chartId: q.chartId, title: q.title, chartType: q.chartType,
        correct: isCorrect, pickedId,
        method: chosen ? chosen.method : null,
        methodName: chosen ? chosen.methodName : null,
        label: chosen ? chosen.label : null,
        spec: chosen ? chosen.spec : 0, data: chosen ? chosen.data : 0,
      };
      if (isCorrect) {
        verdict.className = 'verdict good';
        verdict.textContent = 'Correct — that is the chart from the session.';
      } else {
        verdict.className = 'verdict bad';
        verdict.innerHTML = 'Not this one. You picked a <b>' + chosen.methodName + '</b> look-alike ' +
          '(<span class="mono">spec ' + chosen.spec + ', data ' + chosen.data + '</span>). ' +
          'The real chart is outlined in green.';
      }
      nextBtn.hidden = false;
      nextBtn.focus();
    };
  });
}

function finish() {
  quizArea.hidden = true;
  resultPanel.hidden = false;
  bar.style.width = '100%';
  ptext.textContent = QUIZ.length + ' / ' + QUIZ.length;
  const correct = answers.filter(a => a && a.correct).length;
  document.getElementById('scoreLine').innerHTML = correct + ' <small>/ ' + QUIZ.length + ' correct</small>';
  const misses = answers.filter(a => a && !a.correct);
  document.getElementById('scoreSub').textContent = misses.length
    ? misses.length + ' miss' + (misses.length > 1 ? 'es' : '') + ' — see which look-alikes fooled you below.'
    : 'No misses — you recognized every chart.';

  const rows = answers.map(a => {
    if (!a) return '';
    const badge = a.correct ? '<span class="ok">✓ correct</span>' : '<span class="no">✗ missed</span>';
    const detail = a.correct ? '—'
      : a.methodName + ' <span class="mono">(spec ' + a.spec + ', data ' + a.data + ')</span>';
    return '<tr><td>' + a.n + '</td><td>' + a.title + '</td><td>' + a.chartType + '</td><td>' + badge + '</td><td>' + detail + '</td></tr>';
  }).join('');
  document.getElementById('resultTable').innerHTML =
    '<thead><tr><th>#</th><th>Chart</th><th>Type</th><th>Result</th><th>If missed: look-alike chosen</th></tr></thead><tbody>' + rows + '</tbody>';
}

document.getElementById('startBtn').onclick = () => {
  startPanel.hidden = true; quizArea.hidden = false; cur = 0; renderQuestion(0);
};
nextBtn.onclick = () => {
  cur++;
  if (cur >= QUIZ.length) finish();
  else renderQuestion(cur);
};
document.getElementById('restartBtn').onclick = () => {
  answers.length = 0; cur = 0; resultPanel.hidden = true;
  startPanel.hidden = false; bar.style.width = '0'; ptext.textContent = '';
};
document.getElementById('downloadBtn').onclick = () => {
  const payload = {
    session: ${JSON.stringify(manifest.generatedFor)},
    generatedSeed: ${JSON.stringify(manifest.seed ?? null)},
    total: QUIZ.length,
    correct: answers.filter(a => a && a.correct).length,
    answers,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'quiz-answers.json'; a.click();
  URL.revokeObjectURL(url);
};
</script>`;

fs.writeFileSync(htmlPath, html);
const mb = (fs.statSync(htmlPath).size / 1024 / 1024).toFixed(2);
console.log(`quiz → ${htmlPath} (${mb} MB, ${questions.length} questions)`);
console.log('questions (by focus time):');
questions.forEach((q, i) => console.log(`  ${i + 1}. ${secs(q.focusMs)}s  ${q.chartType} — ${q.title}`));
if (excluded.length) {
    console.log('excluded from quiz:');
    for (const e of excluded) console.log(`  - ${e.title}: ${e.reason}`);
}
