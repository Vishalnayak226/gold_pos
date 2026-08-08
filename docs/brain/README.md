# The Project Brain

A single picture of the whole Gold POS platform — every file in the tree, grouped into regions,
wired together by the call graph graphify extracts from the source. It exists to answer
*"where does this live and what does it touch?"* without opening eighty files.

| File | What it is |
|---|---|
| **[BRAIN.md](BRAIN.md)** | The brain as a document: a lobe diagram, a region index, a wiring diagram, and a detail card per region. Renders in GitHub and VS Code. **Generated.** |
| **[brain.html](brain.html)** | The brain as an interactive page: filter by lobe, search any file or symbol, expand a region. Open it in a browser — no server, no internet, no CDN. **Generated.** |
| **[brain.map.json](brain.map.json)** | **The only file you edit.** Which regions exist, which files each one claims, and the connections no call graph can see. |
| **[build-brain.mjs](build-brain.mjs)** | The generator. Node stdlib only, no new dependency. |

---

## Redrawing it

```bash
node docs/brain/build-brain.mjs                # re-extract the graph, then redraw
node docs/brain/build-brain.mjs --skip-graph   # redraw from the graph as it stands
node docs/brain/build-brain.mjs --check        # also exit non-zero if any file has no region
```

Redraw after any change that **adds, moves, or deletes** files. It takes a couple of seconds and
costs nothing — `graphify update .` is AST-only, no API calls.

> Unlike the ERP project's equivalent, this needs no `%TEMP%` staging dance. That workaround
> exists because Windows Controlled Folder Access refuses writes under `Documents\` from
> *freshly-compiled, unrecognised* binaries. `node.exe` is already trusted, so it writes in place.

---

## Adding to it

The brain is designed so that **growth is usually a zero-line edit.** Four kinds of change, in
rough order of how often you will need them.

### 1. A new file in an area that already exists

Usually **nothing to do.** Regions claim by pattern, so `frontend/js/components/SchemeManager.js`
is claimed by the components region's existing `frontend/js/components/*.js` the moment it exists.
Redraw and it appears.

If the filename fits no existing pattern, the redraw tells you so, by name:

```
brainmap: 5 file(s) not claimed by any region:
  .gitignore
  backend/package.json
  ...
```

That list is also written into [§6 of BRAIN.md](BRAIN.md), so an unfiled file cannot quietly hide,
and `--check` exits non-zero on it. Add a pattern to whichever region owns it. **This property is
the entire point — never replace the globs with an explicit file list.**

### 2. A genuinely new area of the system

Append a region. This is the whole change:

```jsonc
{
  "id": "schemes",
  "lobe": "pos",
  "name": "Savings Schemes",
  "role": "One sentence on what this area is responsible for — it becomes the region's description in both outputs.",
  "match": ["backend/schemeEngine.js", "frontend/js/components/Scheme*.js"]
}
```

Order in the file does not matter. When two regions could claim the same file, **the more
specific pattern wins** (literal characters, `*` excluded), so a new `backend/test_*.js` pattern
beats a broad `backend/*.js` without reshuffling anything. To override that outright, set
`"priority": 100` — that is how Test Suites claims `backend/test_billing_math.js`, and how Agent
Operating Rules claims `docs/CLAUDE.md` off the docs regions.

Glob semantics: `*` matches within one path segment, `**` crosses `/`. So `docs/*PLAN.md` catches
`docs/PROJECT_PLAN.md` but not `docs/sub/X_PLAN.md`; `**README.md` catches every README at any depth.

### 3. One function that belongs somewhere other than its file

Files are the unit of ownership, but a shared file can donate individual symbols:

```jsonc
{ "id": "pricing", ..., "symbols": ["calculateMaking*", "roundToNearest"] }
```

Symbol patterns are checked **before** file patterns, so those functions are counted under the
region wherever they physically live. Reach for this when a single file genuinely spans two areas
— not as a substitute for splitting a file that should be split.

### 4. A connection no call graph will ever see

An AST extractor cannot see the browser calling the server, or a `.bat` file driving Node. Those
are stated by hand and drawn as thick `==>` arrows so they are never confused with measured ones:

```jsonc
{ "from": "pos-ui", "to": "pos-api", "label": "HTTP/JSON",
  "note": "The browser calls the Express router over the network." }
```

The `pathways` array is hand-written for the same reason: a call graph can tell you A reaches B,
but not that it happens third, or that it must.

**After any of these, redraw.** `brain.map.json` is validated on load — an unknown lobe, a
duplicate region id, or a link pointing at a region that does not exist fails loudly rather than
vanishing silently from a diagram.

---

## What it can and cannot tell you

Being clear about this is the point. A diagram that overstates its own accuracy is worse than none.

**Trustworthy:**

- **Which region owns a file.** Decided by pattern, verified against the working tree, 100% covered.
- **The overall shape.** That everything writes through `db.js`, that the API router is the hub,
  that tests reach pricing — these are aggregates over hundreds of relationships and are not
  sensitive to any single one being wrong.

**Verify before relying on it:**

- **Any single connection.** Cross-region edges are largely graphify `INFERRED` rather than
  `EXTRACTED` — a property of the extractor, which resolves calls *within* a file exactly and
  calls *across* files by name. Dotted arrows are entirely inferred. Confirm with grep before
  acting, exactly as `CLAUDE.md` §5 requires.

**Simply not visible:**

- **Anything graphify has no extractor for** — `.md`, `.yml`, `.bat`, `.sh`, `.pem`, `.json`,
  `.css`, `.html`. Those are filed into regions by path and counted, but contribute no symbols
  and no edges. Deploy & CI owns 14 files and shows almost no symbols for exactly this reason.
- **Runtime dispatch** — anything reached through a registry, an event name, or a table lookup
  rather than a direct call. The extension hook dispatcher is the obvious case here. Where it
  matters, write it down as a declared link.

---

## How it is put together

```
brain.map.json   ─┐
the working tree  ├─→  build-brain.mjs  ─→  BRAIN.md + brain.html
graph.json       ─┘
```

Three inputs, deliberately: **the map** says which regions exist, **the working tree** (via
`git ls-files`, so `.gitignore` is honoured for free) says which files exist so nothing goes
unowned unnoticed, and **the graph** says what calls what. Only the first is hand-written, so the
picture cannot drift away from the code the way a hand-drawn architecture diagram does.

The brain files itself under "Agent Operating Rules", so a change to the generator shows up in the
diagram like any other change.

## See also

- [`../FOUNDATION.md`](../FOUNDATION.md) — why the context rules are shaped this way.
- [`../ai_handover.md`](../ai_handover.md) §0 — read first if you are picking up development.
- `graphify explain "<symbol>"` — the same graph, one symbol at a time, from the terminal.
