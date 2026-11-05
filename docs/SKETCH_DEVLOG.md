# Sketch-to-Slides development log

Append-only record of what actually happened while building Sketch-to-Slides (used for the course report).
Only real runs, real errors and real measurements go here. Dates are local (KST).

## 2026-11-06 — Stage 1: IR, layout mapping, converter, deterministic validation

**Design decision.** The vision model will never write `.mslides` JSON. It returns a small IR
(`src/sketch/ir.ts`: kind, normalized 0..1000 bbox, text/LaTeX, arrow endpoints + attached ids, relations,
ink color, review flag). A deterministic converter (`src/sketch/convert.ts`) maps it to existing elements:
`ShapeElement` (outlined, label as shape text), `LineElement` (arrows/connectors), `TextElement` with
`mathBlock`/`mathInline` nodes. No schema change to MathSlides was needed.

**Coordinate mapping.** IR coordinates are normalized so they do not depend on the resolution the model saw.
The union of all element boxes is fitted into the slide content area (48 px side margin, 40 px top, footer kept free)
with ONE uniform scale → relative layout and aspect ratio are preserved. A sketch with a `title` element is
top-aligned; a bare diagram is centered vertically. Equations are sized with MathJax's real typeset size
(`renderTex` widthEm/heightEm) so the typeset equation covers the written one.

**Test setup.** Two hand-written IR fixtures (`tests/fixtures/sketch/*.ir.json`, clearly marked as NOT model output)
describe a correct recognition of the two example sketches; `tests/sketch-convert.mjs` checks structure, layout order,
connectors, bounds, LaTeX and overlap rules.

**Finding 1 (real, from inspecting converted geometry).** First version mapped handwriting ink height directly to
font size. Example A's annotation `'중요'` became a 72 px text box — larger than the circle labels — because
handwriting is much larger than slide text. Fix: per-role maximum font size (`ROLE_MAX_FONT`: title 72, label 60,
body 48, annotation 40). After: annotation 40 px, labels 60/60/32 px.
