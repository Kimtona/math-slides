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

## 2026-11-06 — Stage 4: local model via Ollama (default provider, no API cost)

**Setup.** MacBook Air (Apple Silicon, 24 GB), Ollama 0.40.14, `qwen2.5vl:7b` (Q4_K_M, 6.0 GB), `temperature: 0`,
`num_ctx: 16384`, structured output through Ollama's `format` (JSON Schema). Test images (the user's own):
`test1.jpeg` (2219×1040 iPhone photo of paper, A→B→C diagram) and `test2.png` (1544×600 GoodNotes screenshot,
policy-gradient equation with red notes). Every model output below is kept unmodified in `examples/ollama-runs/`
(`*.ir.json` → `rawText` is the exact model text; `*.report.json` has timings and the checks).
Times are wall-clock for one recognition call on this machine; `load` is model loading.

Note on privacy: `test1.jpeg` carries EXIF GPS data. The original file is not copied into the repository; the app
and the CLI send a re-encoded PNG (no metadata) to the model, and only those re-encoded images appear in run logs.

### Experiment 1 — Claude prompt and schema unchanged, original resolution (`exp1/`)

| | test1 | test2 |
|---|---|---|
| time | 90.2 s (load 10.8, prompt 48.3 s for 3744 tokens, generation 30.0 s / 192 tokens) | 91.1 s (prompt 19.1 s / 1975 tok, gen 68.8 s / 454 tok) |
| result | 3 elements: the whole diagram as ONE text `"A → B → C"`, an arrow, `'중요'` | 6 elements, 7 overlap warnings |

Errors found:
- test1: circles and arrows not recognized as separate shapes; coordinates in **pixels** (e.g. x=1900) although the
  prompt asked for 0..1000 → clamped; `'중요'` read correctly.
- test2: equation emitted as plain Unicode **text** (not `math`), `r(τ)` read as `H(τ)`; an invented circle
  labelled `"1"` (from a tick mark); two notes merged and misread (`"일어나왔다면"`, `"바뀔까"`); and an element
  containing **a copy of the system prompt** ("math: one displayed equation, as LaTeX in "latex" …").
- Render: `exp1/test2.png` (overlapping, prompt text on the slide).

Cause analysis: Qwen2.5-VL is trained to answer boxes as absolute pixel `bbox_2d: [x1,y1,x2,y2]`; the long Claude
prompt with many optional fields and indirect relations is too much for a 7B model (it regurgitated it); full-size
images cost many visual tokens.

### Experiment 2 — local prompt + flat pixel format, 1024 px long edge (`exp2/`)

Change: `LOCAL_RECOGNIZE_SYSTEM` / `localRecognizeUser` (short; types title/text/math/circle/rectangle/arrow/line;
`bbox_2d` in pixels; shape label in `content`; `points` + `connects` for arrows; `explains` for notes; `unsure`),
converted to the shared IR by `electron/sketch-local.cjs`.

| | test1 | test2 |
|---|---|---|
| time | 96.9 s (prompt 16.1 s / 1489 tok, gen 76.5 s / 514 tok) | 104.6 s (prompt 16.5 s / 1495 tok, gen 72.8 s / 504 tok) |
| result | **3 circles with labels A/B/C, 2 arrows connected c→c, 1 line, `'중요'`** | title (blue) ✓, equation as `math` ✓, notes split per line |

Errors found:
- Coordinates exceeded the image (test1 x up to 1170 on a 1024 px image; test2 +41%) → clamped, circle C squashed.
- LaTeX not escaped in JSON: `\nabla` arrived as newline+`abla`, `\theta` as tab+`heta`.
- `\text{E}`, `\text{π}`, `\text{R}(τ)` (r→R misread); Korean notes misread (`"그 action의"` for "이",
  `"일관나중않나"` for "얼마나 좋았다") **with `unsure` empty** — self-reported uncertainty is not reliable.
- Generation dominates time (~6.5 tokens/s), and the JSON is pretty-printed.

### Experiment 3 — prompt: LaTeX notation rules, escape rule, "compact JSON" (`exp3/`)

test1: 98.3 s, same structure as exp2 (deterministic decoding), still 507 output tokens: **the "compact JSON"
instruction had no effect**. test2: **failed** — the request ended after exactly 5 minutes with "Could not reach
Ollama". The Ollama server log showed the model still generating (>1855 tokens, ~6.4 tok/s, i.e. runaway output) and
the server log line `--image-min-tokens 1024`. No output file exists for this failed run (failure files were added
afterwards).

Causes: (a) Node's `fetch` gives up after 300 s without response headers (non-streaming request); (b) the Ollama
runner upscales every image to ≥ 1024 visual tokens (28×28 px each ≈ 802,816 px). 1024×398 → ×1.42, 1024×480 → ×1.28:
exactly the coordinate excess seen in experiment 2.

Fixes: streamed responses (no header timeout, progress), `num_predict: 2048` cap with a clear error, failed runs
saved as `*.failed.json`, and **images resized to 802,816 px area** (`LOCAL_IMAGE_PIXELS`) so the model's pixel frame
is the image we sent; a uniform rescale stays as a safety net (never clipping).

### Experiment 4 — token-area sizing + streaming (`exp4/`, model output) and converter fixes (`exp4-fixed/`)

| | test1 (1309×613 sent) | test2 (1437×559 sent) |
|---|---|---|
| time | 95.2 s (prompt 15.7 s / 1542 tok, gen 78.6 s / 506 tok) | 103.7 s (prompt 15.7 s / 1548 tok, gen 87.4 s / 564 tok) |
| coordinates | inside the image (no rescale needed) | inside the image |
| LaTeX | — | `\nabla_{\theta}J(\theta) = \mathbb{E}_{\pi}[R(\tau) \cdot \nabla_{\theta} \log \pi_{\theta}(a\|s)]` (escaped ✓, only `r`→`R` wrong) |

Errors found in the conversion (not the model) and fixed, re-run offline from the saved model output with
`--ir` (no new model call):
1. My LaTeX repair turned a *real* leading newline into `\n` → "Undefined control sequence \n". Fix: a control
   character is restored as a command only when letters follow (`\n`+`abla`); otherwise it is whitespace.
2. A note written as `\rightarrow 행동확률의 gradient` showed the literal command. Fix: LaTeX commands inside plain
   notes become inline math (`$\rightarrow$`).
3. The model listed note lines (and even words of one line, `"이"` + `"action의"`) separately. Fix: deterministic
   merge — same-line words joined with a space, stacked lines of the same color joined with a line break.
4. Review policy: since the model never set `unsure` while misreading Korean, every Korean text and every equation
   from the local model is offered in *Check these* (as written, editable).

After (`exp4-fixed/test1.png`, `exp4-fixed/test2.png`): test1 — 3 outlined circles A/B/C, arrows A→B→C attached to the
outlines, the connector line, `'중요'` below; 0 errors/warnings. test2 — blue title, editable equation, left note
(2 lines) and right note (3 lines incl. the arrow) under the right terms; 0 errors/warnings; remaining recognition
errors (`R`, `그 action의`, `일관나중있다`, missing red tick lines) are flagged for review.

### GUI end-to-end with the real model (`tests/sketch-ollama-e2e.mjs`)

**Run 1 (`gui-e2e-1/`)** — app defaults: AI review on.
- test1: 94.0 s, 7 elements, checks clean → review skipped automatically (local policy). Apply ✓, one element moves
  alone ✓, text opens in the editor ✓, Undo restores the image ✓, Redo ✓.
- test2: 253.8 s = recognition 93.6 s + **review 114.7 s + 45.2 s**. The image the app sends (canvas resize) differs
  slightly from the CLI's (sips), and this run's LaTeX was worse: `\text{E}_{\tau}`, `\text{.}`, `\tau_{\theta}` (π read
  as τ) — the 7B model is sensitive to small input differences.
- **Bug found (mine):** the two separate notes `"그 action의"` and `"이 action의"` were joined into one line. The
  same-line test compared x and y distances in normalized IR units, which differ on a wide image (1437×559).
  Fix: compare in pixels and require a word-sized gap (≤ 0.6 line height); regression test added with these boxes.
- **Local AI review was useless here:** it claimed `"확률은 어떻게 바꿀까"` "is not present in the original" (it is),
  and its patches tried to *add* elements with existing ids, so all were rejected — 160 s for no change.
  Decision: with Ollama the AI review is **off by default** (checkbox still available); with Claude it stays on.

**Run 2 (`gui-e2e-2/`)** — after the fixes.
- test1: **75.2 s**, 7 elements (3 ellipses with labels, 2 arrows, 1 line, 1 text), 0 errors/warnings.
- test2: **77.9 s**, 4 elements (title, equation, 2 notes), 0 errors/warnings, 3 items in *Check these*.
- Apply / individual editing / Undo / Redo ✓ for both. Save `.mslides` (3 slides, 17 elements) ✓, PDF via the app's
  export (3 pages, 36 KB) ✓, PPTX (3 slides, 86 KB) ✓.
- Observed UX issue (not changed, as requested): converted elements fill the slide's content area, so on a slide that
  already has content (here the template's title/body placeholders) they overlap it.

### Summary of what the local model does and does not do (on these two images)

| check | result |
|---|---|
| handwritten text | Latin/short text ✓ (`[policy gradient]`, `A`/`B`/`C`, `'중요'`); Korean sentences partly wrong |
| equation → LaTeX | structure ✓ and renders; symbol errors (r→R; in one run E→`\text{E}`, π→τ) |
| shapes/arrows/connectors | circles ✓, arrows with endpoints ✓; red tick lines in test2 not detected |
| positions/relations | layout preserved ✓; arrow attachments ✓; note→term relations not produced |
| editable result | ✓ ordinary elements, LaTeX editable, Undo/Redo, save, PDF, PPTX |
| time | 75–104 s per image (generation ~6.5 tok/s is ~80 % of it) |

## 2026-11-06 — Stage 5: rebuild inside the image's frame (UX change)

**Problem (observed in GUI run 2).** Converted elements were fitted into the whole content area of the slide, so on a
slide with other content (the template's title/body placeholders) they covered it.

**Change.** The IR's 0..1000 coordinates (of the visible, cropped image) now map linearly onto the image element's
frame on the slide (`irToElements(ir, frame)`; x and y separately, so a stretched picture maps like the picture).
Elements are kept inside that frame; nothing else on the slide is modified; Apply inserts the elements at the image's
layer (stacking order of the other elements unchanged). The preview shows the result in place on the slide with the
image area dashed. New checks: `frame` (an element leaves the image area) and `overlap-existing` (it covers an existing
element). The command-line tool, which has no slide, keeps the content-area fit.

**Tests.** `tests/sketch-convert.mjs`: full-image box = frame, IR center = frame center, stretched frame, the A→B→C
fixture inside a lower-right frame with drawn positions and arrow attachments kept, overlap/frame checks.
`tests/sketch-dialog.mjs` (fixture model): frame used, elements inside it, template title/body deep-equal before/after,
inserted at the image layer, cropped image (only the visible half is sent; mapping onto the cropped frame).

**GUI run 3 (`gui-e2e-3/`, real model, image placed below the template's title/body).** test1 105.0 s, test2 99.2 s.
Both: every converted element inside the frame, nothing covers the title/body, other elements unchanged, Undo/Redo ✓,
save/PDF/PPTX ✓. **New problem found:** in test2 the right-hand note was wider than the space left in the frame and
was moved 107 px left, over the left-hand note (overlap warning 26 %). In the old full-slide placement there had been
room to the right.

**Fix.** A text box that does not fit between its written position and the frame edge now gets a smaller font
(down to 16 px) instead of being moved; a `fit` note says so. Regression test with the real model's boxes from that run.

**GUI run 4 (`gui-e2e-4/`).** test1 79.2 s, test2 96.7 s. 0 errors, 0 warnings for both; test2 note font 48 → 38 px,
notes side by side as drawn; inside the frame, title/body not covered and unchanged, Undo/Redo ✓, `.mslides` (3 slides,
17 elements), PDF (3 pages), PPTX (3 slides) ✓. (Recognition errors of the 7B model — `R`, `\text{E}_{\tau}`, π→τ,
Korean — are unchanged by this work and still flagged for review.)
