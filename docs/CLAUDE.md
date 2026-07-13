# NOTE: Please refer to `ai_handover.md` in this directory for the full architectural breakdown and current project state!

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- Use graphify to orient, not to conclude. For codebase questions, start with `graphify explain "<symbol>"` (single symbol, cheap and precise) or `graphify query "<question>"` (broader/relational — narrow with `--context call` and a low `--budget` since it can over-fetch on hub files). Use `graphify path "<A>" "<B>"` for how two things connect.
- Always verify with grep/Read before concluding, especially anything resting on an `[INFERRED]` edge — those are heuristic guesses, not parsed fact, and can be wrong or incomplete. `[EXTRACTED]` edges are parsed from source and safe to trust directly.
- If a graphify answer looks thin, contradicts what you find in the source, or the question is narrow enough that grep alone is obviously cheaper, fall back to grep/Read as the source of truth — never let a graph gap cause a missed answer.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
