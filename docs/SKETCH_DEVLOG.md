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

## 2026-11-06 — Stage 2/3: AI bridge, dialog, end-to-end test with a fixture model

**AI bridge.** Claude (`claude-opus-5-5`) is called from the Electron main process with the official SDK,
structured JSON output (`output_config.format` = the IR JSON Schema), effort `high`, and server-side refusal
fallback. The key comes from `ANTHROPIC_API_KEY` or is stored encrypted with `safeStorage`; the renderer only sees
where it comes from. Prompts: `electron/sketch-prompts.cjs` (transcription-first; literal reading always used,
alternative only in `review.inferred`).

**Dialog.** Image props bar → *Convert to Editable Slide* → preview (original | converted) → review list (as written /
inferred, editable text and LaTeX) → checks → *Apply* (replaces the image in one commit = one undo step) /
*Apply, keep image* / *Cancel*. The AI review screenshots the rendered preview (`webContents.capturePage`),
sends original + rendering + IR + deterministic issues, applies the returned patches and re-validates (≤ 2 rounds).

**Test without network.** `MATHSLIDES_SKETCH_FAKE=<IR json>` replaces the model with a fixture (labelled
"fake (test fixture)" in the dialog). `tests/sketch-dialog.mjs` drives the real Electron window.

**Finding 2 (real, caught by the GUI test).** The run log was missing `00-input.png` in fake mode: the fixture branch
returned before the input image was logged. Fix: validate and log the input before choosing fake/real.
After the fix all checks pass (recognition → preview → review round, user edit, Apply + single-step undo/redo,
Apply-keep, Cancel, run log, PPTX export with native text).

Rendered preview of the policy-gradient fixture (from the run log) matched the sketch's layout: blue title top-left,
equation centered under it, red notes under `r(τ)` and `∇θ log πθ(a|s)` with their tick lines, arrow note below.
