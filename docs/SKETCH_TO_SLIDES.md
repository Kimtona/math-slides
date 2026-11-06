> **v2.0.0 note:** this reference was written for the coordinate-based **Layout Mode**. The default is now **Document Mode** (Markdown transcription, set top to bottom) — see the [README](../README.md#sketch-to-slides) and [SKETCH_ASSIGNMENT_NOTES.md](SKETCH_ASSIGNMENT_NOTES.md). Layout Mode and everything below still apply to it.

# Sketch-to-Slides — detailed reference

*Think on paper. Present with MathSlides.* Draw a slide on paper or in GoodNotes, paste the photo or screenshot on a slide, select it and press **Convert to Editable Slide** (image toolbar). A vision model (local via Ollama by default, or Claude) reads the sketch and MathSlides rebuilds it from ordinary, editable elements: text boxes, LaTeX equations (`/math` blocks, never pictures), outlined shapes with their labels, arrows and connector lines, in the ink colors and the layout you drew.

## Setup

By default the sketch is read by a **local vision model through [Ollama](https://ollama.com)**: free, offline after the
download, and the image never leaves your computer. Claude (Anthropic API) can be chosen instead in **AI settings…**
(more accurate, paid).

**Local model (default)**

1. Install Ollama (macOS: download the app from ollama.com, or `brew install ollama`) and start it (the app, or `ollama serve`).
   It listens on `http://localhost:11434`.
2. Download the vision model (≈ 6 GB; runs on an Apple Silicon Mac with 16 GB+ RAM):
   ```bash
   ollama pull qwen2.5vl:7b
   ```
3. `npm install`, then `npm run app`. Nothing else to configure; no key.

**Two conversion modes** (switch in the dialog footer; the choice is kept for the session):

| | Document (fast, default) | Layout (positions) |
|---|---|---|
| Reads | the screenshot as Markdown: headings, tables, bullet / numbered lists, `>` quotes, `$…$` / `$$…$$` equations | every element with its position (JSON) |
| Result | native table, `bulletList` / `orderedList`, `blockquote`, editable equations, set top to bottom in reading order; content that does not fit continues on new slides (one Undo removes them) | elements where they were drawn, inside the image's frame |
| Time (real GUI, `test_composite.png`, MacBook M-series) | **≈ 35 s** (42 s with a cold model) | **≈ 215 s** |
| Best for | screenshots, typed notes, documents | sketches, diagrams, arrows, handwriting |

The difference is output length: Layout writes ≈ 1,400 tokens (ids and coordinates), Document ≈ 176, at ≈ 7 tokens/s. Conditions,
Ollama counters and commands: `examples/composite/measurements/README.md`; assignment-style summary: `docs/SKETCH_ASSIGNMENT_NOTES.md`.
The first call after starting Ollama also loads the model (≈ 7–9 s).

**Claude (optional)**: choose *Claude* in **AI settings…** and enter an Anthropic API key (stored encrypted with the OS
keychain via Electron `safeStorage` as `ai-key.bin` in the app's user-data folder), or start the app with
`ANTHROPIC_API_KEY=sk-ant-...`. The key lives only in the Electron main process; nothing is hard-coded.

Environment overrides (optional): `MATHSLIDES_SKETCH_PROVIDER=ollama|anthropic`, `MATHSLIDES_OLLAMA_MODEL=<name>`,
`OLLAMA_HOST=<host:port>`, `MATHSLIDES_SKETCH_MODEL=<Claude model id>` (default `claude-opus-5-5`),
`MATHSLIDES_SKETCH_LOG=<dir>` to keep a log of every conversion (input image, raw model output, IR, checks, review
screenshots and patches, timings). The feature needs the desktop app (`npm run app`); in browser dev mode the button
is disabled.

**What to expect from the local 7B model** (details and all raw outputs: `docs/SKETCH_DEVLOG.md`,
`examples/ollama-runs/`): diagrams (circles, labels, arrows, connectors) and short text are recognized well; the
equation comes out as editable, renderable LaTeX but with occasional symbol errors (e.g. `r`→`R`); Korean handwriting
is partly misread. That is why every equation and every Korean text from the local model appears under **Check these**
for a quick look before Apply. The AI review loop is off by default with the local model (it did not find real
errors in testing and costs 1–2 minutes); the checkbox turns it on.

## Using it

1. Paste (`⌘V`) or drop the sketch image on a slide (crop it first if it contains more than the slide).
2. Select it → **Convert to Editable Slide**. The dialog shows the original next to the editable result.
3. Look at **Check these**: equations, and anything the model could not read with certainty. For an ambiguous symbol you get *As written* (what is literally on the page, used by default) and *Inferred* (the model's reading from context, e.g. a probable typo). You can edit any text or LaTeX right there.
4. **Apply** replaces the image with the elements (one `⌘Z` brings the image back); **Apply, keep image** keeps it; **Cancel** changes nothing.

The elements are rebuilt **where the image is**: inside its frame on the slide, in the same relative positions (a cropped
image uses its visible part; a stretched one maps like the picture). Nothing else on the slide is moved or changed, so
place or resize the sketch where you want the result before converting. The preview shows the slide with the image area
dashed; *Checks* warns if something would leave that area or cover existing content. Text that needs more room than the
handwriting gets a slightly smaller font rather than being moved onto its neighbours.

## How it works

```text
image ─► vision model (Ollama or Claude, JSON) ─► IR ─► converter ─► deterministic checks ─► preview
                                              ▲                                          │
                                              └──── patches ◄── AI review (≤ 2 rounds) ◄─┘ (original + screenshot)
```

- **IR** (`src/sketch/ir.ts`): elements with kind (`text`/`math`/`shape`/`arrow`/`line`), coordinates normalized 0..1000, text or LaTeX, arrow endpoints and the ids they attach to, relations (`inside`, `annotates`), role (title/label/annotation/body), ink color, and a review flag. The flag is *not* a probability; it only marks what a human should check. The model never writes `.mslides` JSON.
- **Converter** (`src/sketch/convert.ts`): IR coordinates map onto the image's frame on the slide (the command-line tool, which has no slide, fits the content into the slide instead); equation size from MathJax's real typeset size; text inside a shape becomes the shape's text; arrows attached to shapes start and end on their outlines. No auto-beautify (alignment, spacing) yet.
- **Pixel measurements** (`src/sketch/ink.ts`): colored outlines are measured on the image the model saw — color (stroke core, white-balanced against the paper, so a dim photo still gives the color as drawn), thickness, and whether it is a highlighter (light + thick) — and straight arrows that clearly bend in the ink become curves. Nothing is invented: no measurement, no change; a model-given control point or bend is kept. Highlighters are thick light outlines under the text (shapes are drawn first, so no transparency is needed).
- **Structure** (tables, formatting, lists): a screenshot of a table becomes the editor's own **Table** (rows × columns, header row, cells editable one by one); bold / italic / strikethrough become real marks; bullet and numbered lists become real lists; a heading becomes a larger paragraph; a quoted passage becomes a block quote; equations stay `/math` equations. Nothing is left as Markdown characters or as a picture. The local model's answer is hardened first: a cut-off or looping answer keeps only its finished elements, repeated elements are dropped, and separate cell boxes that form a grid are grouped into one table (the result is flagged for review). With the 7B model, tables, headings, quotes and lists are recovered; **bold/italic/strikethrough are not recognized** (it writes no formatting). Not supported yet: merged cells, math or lists inside table cells, nested lists.
- **Math in text**: inline math written as `$...$`, `$$...$$`, `\(...\)` or `\[...\]` becomes the editor's inline equations (MathJax); display equations lose only their delimiters. Long equations are scaled by their real typeset width to fit; paragraphs wrap within the image area.
- **Checks** (`src/sketch/validate.ts`): structure, slide bounds, leaving the image area, covering existing slide content, LaTeX that does not render, unsupported elements, unintended overlaps (labels in shapes, notes on what they annotate and connectors are allowed to touch).
- **AI review**: a second request compares the original with a screenshot of the converted slide (+ the IR and the check results) and returns patches for real conversion errors only, never "improvements" to the writer's content.
- Prompts: `electron/sketch-prompts.cjs` (Claude prompt + a shorter local-model prompt). Model calls: `electron/sketch-ai.cjs` (Claude) and `electron/sketch-ollama.cjs` (Ollama); the local model's flat pixel format is converted to the IR by `electron/sketch-local.cjs`. Settings, key storage and IPC: `electron/sketch-main.cjs`.

## Command line (no GUI)

```bash
npm run sketch -- examples/sketches/policy-gradient.png --out sketch-out             # local model (Ollama)
ANTHROPIC_API_KEY=sk-ant-... npm run sketch -- my-sketch.png --provider anthropic     # Claude
# offline, from a saved model output (no model call; also re-applies the local-format conversion):
npm run sketch -- examples/sketches/diagram-abc.png --ir examples/ollama-runs/exp4/test1.ir.json
node scripts/render-mslides.mjs sketch-out/policy-gradient.mslides out.png          # look at the result
```

It writes `<name>.ir.json` (raw model text and output), `<name>.mslides` (open it in MathSlides) and `<name>.report.json`
(checks, timings, token usage); a failed model call leaves `<name>.failed.json`. Like the app, it resizes the image for
the model (macOS `sips`, then all PNG metadata chunks — EXIF incl. GPS, text — are removed; `sips` alone keeps EXIF), and runs the same pixel measurements as the app. The AI review loop needs the rendered slide, so it runs in
the app only.

## Tests

`node tests/sketch-convert.mjs` (IR parsing, local-model format, conversion, LaTeX handling, checks; headless), `node tests/sketch-dialog.mjs` (the dialog end to end in Electron) and `node tests/sketch-latex.mjs` (a real model output for a paper capture replayed in Electron: inline/display math rendering, layout, save/reopen, PDF, PPTX). With Ollama running, `node tests/sketch-ollama-e2e.mjs <out-dir> <image>...` drives the real app with the real local model (convert → Apply → edit → Undo/Redo → save, PDF, PPTX) and writes screenshots, outputs and measured times to `<out-dir>` (not part of `npm test`). The GUI test replaces the model with a fixture (`MATHSLIDES_SKETCH_FAKE=<ir.json>`, shown as "fake (test fixture)" in the dialog), so it needs no key or network. The fixtures in `tests/fixtures/sketch/` are hand-written expected recognitions, not model output.

## Measuring time saved

For a fair comparison, use the same sketch for both: (1) with a stopwatch, rebuild it by hand in MathSlides until it matches the sketch; (2) with a stopwatch, convert it and fix whatever needs fixing until it matches. Record both times and the number of manual fixes in `docs/SKETCH_DEVLOG.md`. The dialog shows the conversion time, and the run log has per-step timings.

