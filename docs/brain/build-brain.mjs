#!/usr/bin/env node
// Redraws the project brain: docs/brain/BRAIN.md + docs/brain/brain.html.
//
//   node docs/brain/build-brain.mjs                # re-extract the graph, then redraw
//   node docs/brain/build-brain.mjs --skip-graph   # redraw from the graph as it stands
//   node docs/brain/build-brain.mjs --check        # also exit non-zero if a file has no region
//
// Three inputs, deliberately: brain.map.json says which regions exist, the working tree says
// which files exist (so nothing goes unowned without being named), and graphify-out/graph.json
// says what calls what. Only the first is hand-written, so the picture cannot drift away from
// the code the way a hand-drawn architecture diagram does.
//
// Node stdlib only — no new dependency, per CLAUDE.md §0.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BRAIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(BRAIN_DIR, '..', '..');

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const SKIP_GRAPH = argv.includes('--skip-graph');
const outIdx = argv.indexOf('--out');
const OUT_DIR = outIdx !== -1 ? path.resolve(argv[outIdx + 1]) : BRAIN_DIR;

const die = (msg) => { console.error(`brainmap: ${msg}`); process.exit(2); };

// ── inputs ──────────────────────────────────────────────────────────────────

function loadMap() {
  const p = path.join(BRAIN_DIR, 'brain.map.json');
  if (!fs.existsSync(p)) die('brain.map.json not found');
  let map;
  try { map = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { die(`brain.map.json is not valid JSON: ${e.message}`); }

  const lobeIds = new Set((map.lobes ?? []).map((l) => l.id));
  const seen = new Set();
  for (const r of map.regions ?? []) {
    if (!r.id) die('a region has no id');
    if (seen.has(r.id)) die(`duplicate region id: ${r.id}`);
    seen.add(r.id);
    if (!lobeIds.has(r.lobe)) die(`region "${r.id}" claims unknown lobe "${r.lobe}"`);
    if (!Array.isArray(r.match) || r.match.length === 0) die(`region "${r.id}" has no match patterns`);
  }
  for (const l of map.links ?? []) {
    if (!seen.has(l.from)) die(`link declares unknown region "${l.from}"`);
    if (!seen.has(l.to)) die(`link declares unknown region "${l.to}"`);
  }
  for (const p of map.pathways ?? []) {
    for (const s of p.steps ?? []) if (!seen.has(s)) die(`pathway "${p.name}" names unknown region "${s}"`);
  }
  return map;
}

// The working tree as git sees it: tracked plus deliberately-untracked, never ignored.
function listFiles() {
  const git = (args) => {
    try { return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return null; }
  };
  const tracked = git(['ls-files']);
  if (tracked === null) die('git not available — the file census needs it');
  const untracked = git(['ls-files', '--others', '--exclude-standard']) ?? '';
  const all = (tracked + '\n' + untracked)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(all)].sort();
}

function loadGraph() {
  const p = path.join(REPO_ROOT, 'graphify-out', 'graph.json');
  if (!fs.existsSync(p)) return { nodes: [], links: [], missing: true };
  try {
    const g = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { nodes: g.nodes ?? [], links: g.links ?? g.edges ?? [], missing: false };
  } catch (e) {
    console.warn(`brainmap: could not read graph.json (${e.message}) — drawing files only`);
    return { nodes: [], links: [], missing: true };
  }
}

// ── matching ────────────────────────────────────────────────────────────────

// `**` matches across directory separators, `*` does not. Specificity is the count of
// literal (non-wildcard) characters, so a more specific pattern wins without reshuffling
// the map. `priority` overrides specificity outright.
function toRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i++; } else { out += '[^/]*'; }
    } else if ('\\^$+?.()|{}[]'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp('^' + out + '$');
}

function compile(map) {
  return (map.regions ?? []).map((r) => ({
    ...r,
    priority: r.priority ?? 0,
    _file: r.match.map((g) => ({ glob: g, re: toRegExp(g), spec: g.replace(/\*/g, '').length })),
    _symbol: (r.symbols ?? []).map((g) => ({ glob: g, re: toRegExp(g), spec: g.replace(/\*/g, '').length })),
  }));
}

function claimFile(regions, file) {
  let best = null;
  for (const r of regions) {
    for (const p of r._file) {
      if (!p.re.test(file)) continue;
      if (!best || r.priority > best.priority || (r.priority === best.priority && p.spec > best.spec)) {
        best = { region: r, spec: p.spec, priority: r.priority };
      }
    }
  }
  return best?.region ?? null;
}

function claimSymbol(regions, label) {
  let best = null;
  for (const r of regions) {
    for (const p of r._symbol) {
      if (!p.re.test(label)) continue;
      if (!best || p.spec > best.spec) best = { region: r, spec: p.spec };
    }
  }
  return best?.region ?? null;
}

// ── build ───────────────────────────────────────────────────────────────────

function build(map, regions, files, graph) {
  const byId = new Map(regions.map((r) => [r.id, r]));
  const state = new Map(regions.map((r) => [r.id, { files: [], symbols: [], out: new Map() }]));

  const unclaimed = [];
  for (const f of files) {
    const r = claimFile(regions, f);
    if (r) state.get(r.id).files.push(f);
    else unclaimed.push(f);
  }

  // node id -> region, by symbol pattern first, then by the file the symbol lives in
  const nodeRegion = new Map();
  const degree = new Map();
  for (const n of graph.nodes) {
    const bySymbol = n.label ? claimSymbol(regions, n.label) : null;
    const r = bySymbol ?? (n.source_file ? claimFile(regions, n.source_file.replace(/\\/g, '/')) : null);
    if (!r) continue;
    nodeRegion.set(n.id, r.id);
    state.get(r.id).symbols.push({ id: n.id, label: n.label, file: n.source_file, loc: n.source_location });
  }

  let crossEdges = 0;
  for (const e of graph.links) {
    const a = nodeRegion.get(e.source);
    const b = nodeRegion.get(e.target);
    if (!a || !b) continue;
    if (a === b) { degree.set(e.source, (degree.get(e.source) ?? 0) + 1); degree.set(e.target, (degree.get(e.target) ?? 0) + 1); continue; }
    crossEdges++;
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    const out = state.get(a).out;
    const cur = out.get(b) ?? { count: 0, extracted: 0, relations: new Set() };
    cur.count++;
    if (e.confidence === 'EXTRACTED') cur.extracted++;
    if (e.relation) cur.relations.add(e.relation);
    out.set(b, cur);
  }

  for (const s of state.values()) {
    s.symbols.sort((x, y) => (degree.get(y.id) ?? 0) - (degree.get(x.id) ?? 0) || String(x.label).localeCompare(String(y.label)));
    s.files.sort();
  }

  return { byId, state, unclaimed, crossEdges, degree };
}

// ── render: BRAIN.md ────────────────────────────────────────────────────────

const mid = (id) => id.replace(/[^A-Za-z0-9]/g, '_');
// Mermaid takes `"` as a label delimiter and chokes on unquoted (), so every label is
// emitted quoted with inner quotes downgraded.
const esc = (s) => String(s).replace(/"/g, "'");
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function renderMarkdown(map, regions, built, stats) {
  const { byId, state, unclaimed } = built;
  const L = [];
  const lobes = map.lobes ?? [];
  const regionsOf = (lobeId) => regions.filter((r) => r.lobe === lobeId);

  L.push(`# ${map.project ?? 'Project'} — Project Brain`);
  L.push('');
  L.push('> **This is a map. Do not read it cover to cover.** Grep it for the region, file, or symbol');
  L.push('> you need and read only that block. Generated by `docs/brain/build-brain.mjs` — do not edit');
  L.push('> this file; edit `brain.map.json` and redraw.');
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  L.push(`| Redrawn | ${stats.date} |`);
  L.push(`| Files in tree | ${stats.files} |`);
  L.push(`| Regions / lobes | ${regions.length} / ${lobes.length} |`);
  L.push(`| Coverage | ${stats.coverage} (${unclaimed.length} unclaimed) |`);
  L.push(`| Symbols filed | ${stats.symbols} |`);
  L.push(`| Cross-region relationships | ${stats.crossEdges} |`);
  L.push('');
  L.push('---');
  L.push('');

  // 1. Lobes
  L.push('## 1. The shape of it');
  L.push('');
  L.push('```mermaid');
  L.push('flowchart TB');
  for (const lo of lobes) {
    L.push(`  subgraph ${mid(lo.id)}["${esc(lo.name)}"]`);
    L.push('    direction LR');
    for (const r of regionsOf(lo.id)) {
      const n = state.get(r.id).files.length;
      L.push(`    ${mid(r.id)}["${esc(r.name)}<br/><small>${plural(n, 'file')}</small>"]`);
    }
    L.push('  end');
  }
  L.push('```');
  L.push('');
  for (const lo of lobes) L.push(`- **${lo.name}** — ${lo.blurb}`);
  L.push('');

  // 2. Index
  L.push('## 2. Region index');
  L.push('');
  L.push('| Region | Lobe | Files | Symbols | Reaches |');
  L.push('|---|---|---:|---:|---|');
  for (const r of regions) {
    const s = state.get(r.id);
    const reaches = [...s.out.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 3)
      .map(([to]) => byId.get(to).name).join(', ') || '—';
    L.push(`| [${r.name}](#${anchor(r.name, r.id)}) | ${byId.get(r.id) ? (lobes.find((l) => l.id === r.lobe)?.name ?? r.lobe) : r.lobe} | ${s.files.length} | ${s.symbols.length} | ${reaches} |`);
  }
  L.push('');

  // 3. Wiring
  L.push('## 3. How the regions are wired');
  L.push('');
  L.push('Solid arrows contain at least one relationship parsed straight from source; dotted arrows are');
  L.push('entirely inferred by name and must be confirmed with grep before you rely on one. Thick arrows');
  L.push('are declared by hand in `brain.map.json` — connections no call graph can see.');
  L.push('');
  L.push('```mermaid');
  L.push('flowchart LR');
  const edges = [];
  const involved = new Set();
  for (const r of regions) {
    const s = state.get(r.id);
    const top = [...s.out.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 4);
    for (const [to, info] of top) {
      edges.push(`  ${mid(r.id)} ${info.extracted > 0 ? '-->' : '-.->'}|"${info.count}"| ${mid(to)}`);
      involved.add(r.id); involved.add(to);
    }
  }
  for (const l of map.links ?? []) {
    edges.push(`  ${mid(l.from)} ==>|"${esc(l.label)}"| ${mid(l.to)}`);
    involved.add(l.from); involved.add(l.to);
  }
  for (const id of involved) L.push(`  ${mid(id)}["${esc(byId.get(id).name)}"]`);
  L.push(...edges);
  L.push('```');
  L.push('');

  // 4. Pathways
  if ((map.pathways ?? []).length) {
    L.push('## 4. Pathways');
    L.push('');
    L.push('A call graph can tell you that A reaches B. It cannot tell you that it happens third, or that');
    L.push('it must. These orderings are asserted by hand.');
    L.push('');
    for (const p of map.pathways) {
      L.push(`- **${p.name}:** ${p.steps.map((s) => byId.get(s).name).join(' → ')}`);
      if (p.note) L.push(`  <br/>${p.note}`);
    }
    L.push('');
  }

  // 5. Detail
  L.push('## 5. Regions in detail');
  L.push('');
  for (const lo of lobes) {
    L.push(`### ${lo.name}`);
    L.push('');
    for (const r of regionsOf(lo.id)) {
      const s = state.get(r.id);
      L.push(`#### ${r.name}`);
      L.push('');
      L.push(`\`${r.id}\` · ${plural(s.files.length, 'file')} · ${plural(s.symbols.length, 'symbol')}`);
      L.push('');
      L.push(r.role);
      L.push('');
      if (s.files.length) {
        L.push('<details><summary>Files</summary>');
        L.push('');
        for (const f of s.files) L.push(`- \`${f}\``);
        L.push('');
        L.push('</details>');
        L.push('');
      }
      if (s.symbols.length) {
        const top = s.symbols.slice(0, 10).map((x) => `\`${x.label}\``).join(', ');
        L.push(`**Busiest symbols:** ${top}${s.symbols.length > 10 ? ` … +${s.symbols.length - 10}` : ''}`);
        L.push('');
      }
      const out = [...s.out.entries()].sort((a, b) => b[1].count - a[1].count);
      if (out.length) {
        L.push(`**Reaches:** ${out.map(([to, i]) => `${byId.get(to).name} (${i.count}${i.extracted ? '' : ', inferred only'})`).join(' · ')}`);
        L.push('');
      }
      const declared = (map.links ?? []).filter((l) => l.from === r.id || l.to === r.id);
      for (const d of declared) {
        L.push(`> **Declared link** ${byId.get(d.from).name} → ${byId.get(d.to).name} (${d.label}). ${d.note ?? ''}`);
        L.push('');
      }
    }
  }

  // 6. Gaps
  L.push('## 6. What the brain does not know yet');
  L.push('');
  if (unclaimed.length === 0) {
    L.push('Every file in the working tree is claimed by a region.');
  } else {
    L.push(`${unclaimed.length} file(s) are claimed by no region. Add a pattern to whichever region owns them:`);
    L.push('');
    for (const f of unclaimed) L.push(`- \`${f}\``);
  }
  L.push('');
  L.push('Also invisible here, structurally:');
  L.push('');
  L.push('- **Anything graphify has no extractor for** — `.md`, `.yml`, `.bat`, `.sh`, `.pem`, `.json`. Those');
  L.push('  files are filed into regions by path and counted, but contribute no symbols and no edges. A');
  L.push('  region can be substantial and show few symbols for exactly this reason.');
  L.push('- **Runtime dispatch** — anything reached through a registry, an event name, or a table lookup');
  L.push('  rather than a direct call. Where it matters, it is written down as a declared link.');
  L.push('');

  return L.join('\n');
}

function anchor(name, id) {
  return name.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-');
}

// ── render: brain.html ──────────────────────────────────────────────────────

function renderHtml(map, regions, built, stats) {
  const { byId, state, unclaimed } = built;
  const data = {
    project: map.project ?? 'Project',
    stats,
    lobes: map.lobes ?? [],
    unclaimed,
    links: (map.links ?? []).map((l) => ({ ...l, fromName: byId.get(l.from).name, toName: byId.get(l.to).name })),
    pathways: (map.pathways ?? []).map((p) => ({ ...p, names: p.steps.map((s) => byId.get(s).name) })),
    regions: regions.map((r) => {
      const s = state.get(r.id);
      return {
        id: r.id, name: r.name, lobe: r.lobe, role: r.role,
        files: s.files,
        symbols: s.symbols.slice(0, 40).map((x) => ({ label: x.label, file: x.file, loc: x.loc })),
        symbolCount: s.symbols.length,
        out: [...s.out.entries()].sort((a, b) => b[1].count - a[1].count)
          .map(([to, i]) => ({ to, name: byId.get(to).name, count: i.count, extracted: i.extracted })),
      };
    }),
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${data.project} — Project Brain</title>
<style>
  :root {
    --bg:#fbfaf8; --panel:#ffffff; --ink:#1c1a17; --muted:#6b6560; --line:#e3ded7;
    --accent:#8a5a2b; --accent-soft:#f2e8dc; --warn:#9a5b2f;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg:#16151a; --panel:#1e1d24; --ink:#eceaf2; --muted:#9c96a8; --line:#312f3a;
      --accent:#d8a76a; --accent-soft:#2a2431; --warn:#e0a06a;
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  header { padding:28px 24px 18px; border-bottom:1px solid var(--line); }
  h1 { margin:0 0 6px; font-size:22px; letter-spacing:-0.01em; }
  .sub { color:var(--muted); font-size:13px; }
  .wrap { max-width:1180px; margin:0 auto; padding:0 24px 64px; }
  .bar { position:sticky; top:0; z-index:5; background:var(--bg); padding:14px 0; border-bottom:1px solid var(--line); display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  input[type=search] { flex:1 1 260px; min-width:200px; padding:9px 12px; border:1px solid var(--line); border-radius:8px; background:var(--panel); color:var(--ink); font-size:14px; }
  .chip { padding:6px 11px; border:1px solid var(--line); border-radius:999px; background:var(--panel); color:var(--muted); cursor:pointer; font-size:12.5px; }
  .chip[aria-pressed="true"] { background:var(--accent-soft); border-color:var(--accent); color:var(--ink); }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:14px; margin-top:20px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:15px 16px; }
  .card h3 { margin:0 0 4px; font-size:15.5px; }
  .card .meta { color:var(--muted); font-size:12px; margin-bottom:8px; }
  .card p { margin:0 0 10px; font-size:13.5px; color:var(--ink); }
  .lst { font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted); max-height:0; overflow:hidden; transition:max-height .18s ease; }
  .card.open .lst { max-height:1400px; overflow:auto; }
  .lst div { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .hit { background:var(--accent-soft); }
  .tag { display:inline-block; font-size:11px; padding:2px 7px; border-radius:999px; background:var(--accent-soft); color:var(--accent); margin:0 5px 5px 0; }
  .tag.inf { opacity:.65; }
  .toggle { border:0; background:none; color:var(--accent); cursor:pointer; padding:0; font-size:12.5px; }
  section h2 { font-size:14px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:34px 0 10px; }
  .flat { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; font-size:13.5px; }
  .flat li { margin-bottom:6px; }
  code { font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--accent-soft); padding:1px 5px; border-radius:5px; }
</style>
</head>
<body>
<header><div class="wrap" style="padding-bottom:0">
  <h1>${data.project} — Project Brain</h1>
  <div class="sub">${stats.files} files · ${regions.length} regions · ${stats.coverage} covered · ${stats.crossEdges} cross-region relationships · redrawn ${stats.date}</div>
  <div class="sub" style="margin-top:6px">Generated from <code>brain.map.json</code> + the working tree + <code>graphify-out/graph.json</code>. Click a region to expand its files.</div>
</div></header>
<div class="wrap">
  <div class="bar">
    <input type="search" id="q" placeholder="Search a file, symbol, or region…" autocomplete="off">
    <span id="chips"></span>
  </div>
  <div class="grid" id="grid"></div>
  <section>
    <h2>Declared links — what no call graph can see</h2>
    <ul class="flat" id="links"></ul>
  </section>
  <section>
    <h2>Pathways — asserted ordering</h2>
    <ul class="flat" id="paths"></ul>
  </section>
  <section>
    <h2>Not yet filed</h2>
    <div class="flat" id="unclaimed"></div>
  </section>
</div>
<script>
const D = ${JSON.stringify(data)};
const grid = document.getElementById('grid');
const chips = document.getElementById('chips');
let lobeFilter = null, q = '';

for (const lo of D.lobes) {
  const b = document.createElement('button');
  b.className = 'chip'; b.textContent = lo.name; b.setAttribute('aria-pressed','false');
  b.onclick = () => { lobeFilter = lobeFilter === lo.id ? null : lo.id;
    [...chips.children].forEach(c => c.setAttribute('aria-pressed', String(c === b && lobeFilter === lo.id)));
    draw(); };
  chips.appendChild(b);
}

function draw() {
  grid.innerHTML = '';
  const needle = q.trim().toLowerCase();
  for (const r of D.regions) {
    if (lobeFilter && r.lobe !== lobeFilter) continue;
    const fileHits = needle ? r.files.filter(f => f.toLowerCase().includes(needle)) : [];
    const symHits  = needle ? r.symbols.filter(s => String(s.label).toLowerCase().includes(needle)) : [];
    const nameHit  = needle && r.name.toLowerCase().includes(needle);
    if (needle && !fileHits.length && !symHits.length && !nameHit) continue;

    const c = document.createElement('div');
    c.className = 'card' + (needle ? ' open' : '');
    const conns = r.out.map(o => '<span class="tag' + (o.extracted ? '' : ' inf') + '">' + o.name + ' ' + o.count + '</span>').join('');
    c.innerHTML =
      '<h3>' + r.name + '</h3>' +
      '<div class="meta">' + r.files.length + ' files · ' + r.symbolCount + ' symbols · <code>' + r.id + '</code></div>' +
      '<p>' + r.role + '</p>' + conns +
      '<div style="margin-top:8px"><button class="toggle">files &amp; symbols</button></div>' +
      '<div class="lst">' +
        (needle ? fileHits : r.files).map(f => '<div class="' + (needle ? 'hit' : '') + '">' + f + '</div>').join('') +
        (needle ? symHits : r.symbols).map(s => '<div class="' + (needle ? 'hit' : '') + '" style="opacity:.8">' + s.label + ' &nbsp;<span style="opacity:.55">' + (s.file || '') + ' ' + (s.loc || '') + '</span></div>').join('') +
      '</div>';
    c.querySelector('.toggle').onclick = () => c.classList.toggle('open');
    grid.appendChild(c);
  }
  if (!grid.children.length) grid.innerHTML = '<div class="flat">Nothing matches that.</div>';
}

document.getElementById('q').addEventListener('input', e => { q = e.target.value; draw(); });
document.getElementById('links').innerHTML = D.links.map(l =>
  '<li><strong>' + l.fromName + ' → ' + l.toName + '</strong> — <code>' + l.label + '</code><br>' + (l.note || '') + '</li>').join('');
document.getElementById('paths').innerHTML = D.pathways.map(p =>
  '<li><strong>' + p.name + ':</strong> ' + p.names.join(' → ') + '<br>' + (p.note || '') + '</li>').join('');
document.getElementById('unclaimed').innerHTML = D.unclaimed.length
  ? '<ul>' + D.unclaimed.map(f => '<li><code>' + f + '</code></li>').join('') + '</ul>'
  : 'Every file in the working tree is claimed by a region.';
draw();
</script>
</body>
</html>
`;
}

// ── main ────────────────────────────────────────────────────────────────────

if (!SKIP_GRAPH) {
  // No `shell: true` with an args array — that concatenates unescaped (DEP0190). Direct exec
  // first; on Windows fall back to a single shell string so a .cmd/.ps1 shim is still found.
  let r = spawnSync('graphify', ['update', '.'], { cwd: REPO_ROOT, stdio: 'ignore' });
  if (r.error?.code === 'ENOENT' && process.platform === 'win32') {
    r = spawnSync('graphify update .', { cwd: REPO_ROOT, stdio: 'ignore', shell: true });
  }
  if (r.status === 0) console.log('==> graphify update . (graph re-extracted)');
  else console.log('==> graphify not available or failed — drawing from the existing graph.json');
}

const map = loadMap();
const regions = compile(map);
const files = listFiles();
const graph = loadGraph();
const built = build(map, regions, files, graph);

const claimed = files.length - built.unclaimed.length;
const stats = {
  date: new Date().toISOString().slice(0, 10),
  files: files.length,
  coverage: files.length ? ((claimed / files.length) * 100).toFixed(1) + '%' : '—',
  symbols: [...built.state.values()].reduce((n, s) => n + s.symbols.length, 0),
  crossEdges: built.crossEdges,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'BRAIN.md'), renderMarkdown(map, regions, built, stats), 'utf8');
fs.writeFileSync(path.join(OUT_DIR, 'brain.html'), renderHtml(map, regions, built, stats), 'utf8');

console.log(`brainmap: ${stats.files} files, ${regions.length} regions, coverage ${stats.coverage}, ${stats.symbols} symbols, ${stats.crossEdges} cross-region relationships`);
console.log(`    wrote ${path.relative(REPO_ROOT, path.join(OUT_DIR, 'BRAIN.md'))} and ${path.relative(REPO_ROOT, path.join(OUT_DIR, 'brain.html'))}`);

if (built.unclaimed.length) {
  console.log(`brainmap: ${built.unclaimed.length} file(s) not claimed by any region:`);
  for (const f of built.unclaimed) console.log('  ' + f);
  if (CHECK) process.exit(1);
}
