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

## 2026-11-06 — Stage 6: LaTeX rendering of a paper capture (PPO / GRPO)

**Report.** Converting a screenshot of the GRPO paper (§4.1.1, `examples/sketches/ppo-grpo.png`) showed inline math as
`¥(π_{θ}¥)` / `₩(π_{θ}₩)`, and the PPO objective started with a stray "(".

**Reproduced before changing code** (same model, current code): `examples/latex-fix/before/` — CLI run 36.7 s
(`ppo-grpo.ir.json` keeps the model text), `ppo-grpo-cli.png` render, and a real-model GUI run (`before/gui/`, 51.7 s)
whose applied slide shows the same `₩(π_{θ}₩)` and two text boxes extending beyond the image area (x 8–1272).

**Tracing the string through the pipeline** (repr of the actual strings):

| stage | `π_θ` in the sentence | display equation start |
|---|---|---|
| model output (JSON) | `\(\pi_{\theta}\)` — correct LaTeX, `\(...\)` delimiters | `\\(J_{PPO}(\theta) = …` (an extra, mis-escaped delimiter) |
| local → IR (`wrapInlineCommands`) | **`\($\pi$_{$\theta$}\)`** — commands inside the existing delimiters were wrapped again | unchanged |
| text → nodes (`inlineNodes`) | only `$...$` was recognized → `\(`, `_{`, `}\)` stayed **plain text** | — |
| rendering | plain-text backslash drawn as **₩** by NanumSquare (Korean fonts draw U+005C as ₩, Japanese ones as ¥): the data was intact, the glyph is the font's | MathJax: `\\` = line break, then "(" → stray "(" |

So the model returned correct LaTeX; three MathSlides-side problems broke it:
1. `inlineNodes` (`src/sketch/convert.ts`) knew only `$...$`. Now `$...$`, `$$...$$`, `\(...\)`, `\[...\]` become
   `mathInline` nodes (the editor's existing MathJax inline math), content byte for byte; unbalanced delimiters stay text.
2. `wrapInlineCommands` (`electron/sketch-local.cjs`, added in experiment 4) wrapped commands inside existing math.
   Now it only touches text outside math spans.
3. Display math kept its delimiters. `stripMathDelimiters` (`src/sketch/ir.ts`, all providers) removes `$`, `$$`,
   `\(`, `\[`, the mis-escaped `\\(` and their closing forms — never content (a plain "(" stays).
   Also: a literal `\n` in local-model text is a line break only when no letter follows (`\nabla`, `\neq` stay).

**Sizes.** The paragraph came back as ONE line with a one-line box; the converter widened it to the whole slide.
Now text that would need > 30 % font reduction keeps its font and **wraps within the image area** (`wrap` note);
moderate overflow still shrinks (`fit`). Display equations are scaled by their real MathJax width to the available
width (frame, never beyond the slide; down to 10 px, else reported as `frame`). MathJax 3's SVG output has no automatic
line breaking, so long equations are scaled, not broken; the LaTeX is never changed.

**Tests.** `tests/sketch-convert.mjs`: MathJax renders `\nabla_\theta`, `\mathbb{E}`, `\pi_{\theta}`, `\epsilon`, `A_t`,
`\frac{a}{b}`, `\left[…\right]` and a combination (inline and display); every delimiter form → mathInline; inline math
in a sentence leaves no delimiter in the text; wrapping only outside math; delimiter stripping keeps content; JSON round
trip keeps every string; the **real PPO model output** (fixture `ppo-grpo.local.json`) in a frame: 6 inline equations
(`\pi_{\theta}`, `\pi_{\theta_{old}}`, `q, o`, `\pi_{\theta_{old}}`, `\varepsilon`, `A_t`), the display LaTeX equal to the model's minus the
stray delimiter, nothing outside the frame; long-equation scaling. `tests/sketch-latex.mjs` (Electron, replaying the
real output): 6 inline + 1 display SVG, 0 MathJax errors, no raw LaTeX/delimiter text; measured DOM boxes inside the
image area and the slide; title/body untouched; save → reopen identical LaTeX; PDF; PPTX alt text holds all 7 LaTeX
strings. With the three source files reverted, this test fails at "six inline equations rendered as SVG"; with the fix
it passes.

**After.** Re-conversion of the same saved model output: `examples/latex-fix/after/ppo-grpo-cli.png`; GUI (replay):
`after/gui/ppo-dialog-after.png`, `after/gui/ppo-applied-after.png`; **real model GUI run** (`after/gui-real/`): 73.9 s,
0 errors, 0 warnings, nothing outside the image area, title/body not covered, all inline math rendered.

**Recognition errors that remain (model, not rendering; prompts unchanged as requested):** `\mathcal{J}_{PPO}` read
as `J_{PPO}`; the section number "4.1.1." dropped from the heading; paragraph boxes reported as one line high.

## 2026-11-06 — Stage 7: FullDuplex sketch — curved arrows, lime highlighter, conversion time

**Input.** `~/Downloads/test3.jpeg` (iPhone photo, 1500×768, **EXIF with GPS**). The repository keeps
`examples/sketches/fullduplex.png`, re-encoded with all metadata chunks removed (only IHDR/IDAT/IEND/iCCP/cICP left).
Finding on the way: `sips -s format png` **keeps the photo's EXIF as an `eXIf` chunk**, so the README's earlier claim
that the CLI drops GPS was wrong (the app was never affected: it re-encodes through a canvas). The CLI now strips all
metadata chunks after `sips` (`scripts/png-raster.mjs`).

Original content: "FullDuplex" (center), "들으면서" in a lime highlighter loop (bottom left), "말하기" in a lime loop
(top right), "생각" with "≡" (bottom), black arrows 들으면서→FullDuplex (slightly bent), FullDuplex→말하기 (bent), and a
looping arrow from 생각 up to FullDuplex.

### Before (current code, real qwen2.5vl:7b) — `examples/fullduplex/before/`

CLI 114.7 s (prompt 16.7 s / 1623 tok, generation 85.8 s / 581 tok, load 11.0 s); GUI (`before/gui/`) 119.2 s with
recognition 119.0 s. Stage by stage (raw model text in `before/fullduplex.ir.json` → `rawText`):

| what | model output | local → IR | IR → elements | result |
|---|---|---|---|---|
| arrows | 2 × `arrow` (straight), no `curved_arrow`/`via`/`bend`; arrow to 말하기 **missing**; `connects` reversed | unchanged | straight lines | straight; one arrow missing, one misplaced |
| highlighters | 2 × `circle`, `color: "green"`, `explains: e1/e3` | `explains` **dropped for shapes** | `#2CA02C`, 3 px, opaque (IR has only 5 named colors, fixed width) | thin dark-green ellipses; 2 overlap warnings |

So: curvature is lost in the **model output** (the prompt already described curved arrows); the highlighter's color
name was right but MathSlides could not express a light, thick marker and dropped the `explains` relation. (In the
user's own run the loops came out black — with this model the color name varies between runs; measuring it from the
pixels removes that dependency.)

### Changes (no new shape type)

1. `src/sketch/ink.ts` (pure, tested on synthetic rasters), run on the exact image the model saw (app: canvas; CLI:
   decoded PNG):
   - colored outline of each shape: stroke color (most saturated quarter of its pixels, **white-balanced against the
     measured paper**: the photo's paper is ≈ #AFB1AD, the raw highlighter pixels ≈ #7E7F5D look olive on a white
     slide), thickness (median run across the outline), highlighter = light + thick. No colored stroke → nothing set.
   - straight `arrow`/`line` without control/bend: if the ink's middle lies consistently further from the chord than
     its ends (≥ 10 % of the chord), the stroke becomes a curve through that point. A uniform offset (model endpoints a
     few px off a straight stroke) is not a bend (unit test). Model-given `control`/`bend` are never replaced.
2. IR: optional `pen` (`pen`/`highlighter`), `colorHex`, `inkWidth`. Converter: highlighter = thick outline (measured
   width, 4–28 px) in the measured color; shapes are drawn under text, so a light opaque stroke looks like a marker —
   no opacity field needed. Measured `colorHex` wins over the named color for shapes and connectors.
3. Local format: `pen` field; `explains` on shapes/connectors is kept as an `annotates` relation. Validation: a
   highlighter overlapping text is intended (also when the model gives no `explains`).
4. Local prompt: highlighter marks (`pen`, `explains`), "hand-drawn arrows are often bent — use curved_arrow + via",
   "list every arrow".

Re-conversion of the **same** before-model output (`before-reconverted/`, no model call): highlighters #E4E49E and
#D0D18C, 10–11 px; the arrow the model called straight (the loop near 생각) bends 55 px in the ink → curve; 0 warnings.

### After (real model, new prompt) — `examples/fullduplex/after/`

CLI 114.6 s. The model now marks both loops `pen: "highlighter"` (new), but still writes every arrow as a straight
`arrow` (the curve wording did not change this 7B model's output), still omits the arrow to 말하기, and put the marked
word into `unsure` instead of `explains`. Pixel measurements: highlighters #E4E49E / #D3D38C (11 px), one arrow bends
49 px → curve. GUI (`after/gui/`): 112.1 s; 0 errors, 0 warnings; inside the image area, title/body untouched;
Undo/Redo, save (2 slides, 12 elements), PDF (2 pages), PPTX (2 slides) ✓.

Remaining (model limits): the arrow to 말하기 is not recognized; the recovered curve uses the model's endpoints, which
lie between the loop arrow and the 말하기 arrow; "≡" is read as "三".

### Conversion time: where did 218 s go?

New per-step timings (dialog tooltip, run log `20-summary.json`): `prepare`, `recognizeWall` (model call incl. IPC),
`ink`, `render` (convert + measure + screenshot), `reviewWall<n>`, `render<n>`, `other`. GUI after-run: prepare 0.05 s,
recognition 111.8 s, ink 0.11 s, render 0.09 s, other 0.003 s — i.e. everything but the model call is < 0.3 s.

Two code paths can add minutes after recognition:
- **AI review** (only if its checkbox is on; off by default with Ollama): each local review round took 45–115 s in
  earlier runs (stage 4: 114.7 s + 45.2 s), and it runs only when checks report warnings — which this sketch had
  before the highlighter fixes (2 overlap warnings).
- **A stalled `requestAnimationFrame`** (fixed): measuring the preview waited for two animation frames with no fallback.
  Measured with the real app's window settings: visible window 24 ms; **window hidden: not called within 8 s** (it
  resumes only when the window is shown again). Switching to another app during the ~50–110 s recognition therefore
  froze the conversion until the user came back. `nextFrame` now falls back to a 100 ms timer (same approach as the
  export code): 34 ms visible, 2.0 s hidden (background timers are slowed to ~1/s).

The user's 268 s run left no run log, so which of the two caused it cannot be shown; both are now visible in the step
timings, and the stall is fixed.

## 2026-11-06 — Stage 9: structure — tables, formatting, lists, headings, quotes (branch `feature/sketch-structured`)

**Goal.** A screenshot should become the editor's own structures, not loose text: table → `TableElement`, bold/italic/strike →
real marks, bullet/ordered list → `bulletList`/`orderedList`, heading → larger paragraph, quote → `blockquote`, equation → the
existing `mathInline`/`mathBlock`. No Markdown characters may remain as text, and no editor feature was re-implemented.

**What the editor already had (reused as is).** `TableElement {cols, rows: TableCell[][], headerRow}` with `newTable`, `scaleCols`,
`repairTable`, `tableProblems`; cells are plain rich text (marks only: no math, no lists). Marks `bold`/`italic`/`strike`/`underline`
(StarterKit + Underline). Lists `bulletList|orderedList > listItem > paragraph`. There is NO heading node: a heading is a paragraph
with a `fontSize` attribute (`headingSize(level)`). Quote = `blockquote`. PPTX: table → `<a:tbl>` (header row bold), runs carry
`b/i/strike`, lists → bullets/numbering.

**Baseline (current code, real model, `examples/structured/before/`).** The AI-model/submission table screenshot (906×446, user's
image; no EXIF) became **12 separate text boxes, 0 tables** (133.9 s). The model had read all 12 cells and their boxes correctly:
recognition was fine, grouping into a structure was missing.

**Implementation.**
- `src/sketch/ir.ts`: kind `table`; `IRSpan` (text + bold/italic/strike/underline), `IRBlock` (paragraph, heading level 1–4, quote, bullet,
  ordered), `IRTable {header, rows → cells → spans}`; JSON Schema for the Claude provider. Untrusted-input handling: only known fields
  survive, defaults never invent (header = false unless stated), ragged rows padded and reported, ≤ 40×12 cells, a table without usable
  rows becomes a plain note if it has text and is dropped otherwise.
- `src/sketch/convert.ts`: `blocksToDoc` / `spansToNodes` (marks, `$…$` → `mathInline`), `tableElement` (font from the source row pitch, column
  widths from the typeset text, header = the table's own header style). Headings are widened for their larger size.
- `electron/sketch-markup.cjs` + `sketch-local.cjs`: the local model writes `**bold**`, `*italic*`, `~~strike~~`, `- item`, `1. item`, `> quote`,
  `# heading` or a Markdown table, which are turned into spans/blocks/table BEFORE anything reaches the slide (equations protected). Conservative
  **grid detection** groups a model's separate cell boxes into one table (≥ 3 rows × ≥ 2 columns, equal cells per row, aligned left edges, ≥ 80 %
  of the page's text); consecutive one-item `list` elements become one list. Both are flagged for review.
- `src/sketch/validate.ts`: `tableProblems`; dialog notes for tables/formatted notes. Test input: `examples/sketches/ai-table.png`;
  `formatted-notes.png` is a **synthetic** screenshot rendered from `formatted-notes.html` (`scripts/html-to-png.mjs`) — the user supplied no formatted
  image.

**Real-model experiments (qwen2.5vl:7b, all outputs kept).**
1. Run 1 (`after/ai-table.failed.json`): the model listed the 12 cells, then looped on an empty `"table"` element until the 2048-token limit:
   **302 s and the whole answer was thrown away.** Fixes: (a) `salvageElements` keeps the *finished* elements of a cut-off answer (a half-written one is
   never completed), (b) loop detection aborts the stream when a short unit repeats ≥ 4× (a complete normal answer is not flagged), (c) an empty/garbage
   `table` (e.g. `":[["`) is dropped, not kept as a note.
2. Run 2 (`run2/`): table image 106.6 s → 1 native table, 12 cells exact. Formatted image 98.1 s → title, paragraph, quote recognized; **no
   bold/italic/strike markers**; every list item its own `list` element, bullets marked `ordered:true` → 5 plain boxes. Fix: merge consecutive aligned items into one list.
3. Run 3 (`run3/`, **rejected**): adding concrete JSON examples to the prompt made the model **copy the example's coordinates** (`[40,30,900,420]`…),
   output the table content three times over the whole image and drop the heading. Faster (44–47 s) only because the answers were shorter. Reverted.
4. In-app run (`gui-real/`): the model repeated the entire run of 12 cells (same ids and boxes) and stopped normally; the duplicates were fed to grid
   detection → a **6×4** table (wrong). Fix: elements with the same type, text and place are kept once (same words at another place stay). Real output
   kept as `tests/fixtures/sketch/ai-table.duplicated.json`.
5. In-app run after the fix (`gui-real2/`): **6×2 table, 12 cells exact, header row detected**, 162.4 s (the app and the CLI send slightly different
   pixels, so the model's answer — and its length — differs).

**Tests.** `tests/sketch-convert.mjs` (headless): marker parser, untrusted structures, table/formatted conversion, grid detection (positive, 2×2, misaligned,
partial page), looped and duplicated REAL outputs, list merging. `tests/sketch-structured-gui.mjs` (Electron, fixtures replayed — the table scenario replays the
real salvaged answer): one 6×2 table with exact cell texts, header weight 700 vs 400, editing one cell leaves the others and Undo restores it, save → reopen,
PDF, PPTX (`<a:tbl>` 6 rows/12 cells, bold header row); formatted notes: real bold/italic/strike marks, bullet + ordered list, blockquote, heading,
a bold word inside a table cell, save → reopen, PDF, PPTX runs/bullets/quote. One existing assertion used `table` as its "unsupported kind" example; it uses `chart` now.

**Real-model status (honest).** Recognized and converted: tables (via grid detection, not via the model's own `table` type, which it never filled
correctly), headings, quotes, lists (bullet vs. numbered is the model's guess — flagged). **Not recognized by the 7B model: bold, italic, strikethrough** — it wrote
no markers in any run; the conversion supports them (tested), the model does not see them. The Claude provider can use the structured `blocks` schema; it was not run.

## Stage 10 — the user's real composite screenshot (2026-11-06)

Input: `~/Downloads/test_composite.png` (copy: `examples/composite/test_composite.png`, 840×1580, sent as 653×1229). Real run, qwen2.5vl:7b, CLI: **244.9 s** (prompt eval 18.5 s, generation 225.4 s, 2018 input / 1481 output tokens ≈ 6.6 tok/s, model already loaded). Raw output kept verbatim in `tests/fixtures/sketch/test-composite.real.json`.

### What the model did vs. what the converter lost (traced stage by stage)
| Stage | Finding |
|---|---|
| VLM raw output | Recognised everything correctly, text exact: 10 table cells with consistent boxes, 3 bullet lines, 3 numbered lines, both equations. It typed ALL of them as plain `text` (no table/list/heading types), dropped the bullet glyphs, and wrote the display equation as LaTeX inside a `text`. |
| Adapter | **A (table):** `detectGridTable` required the grid to cover ≥ 80 % of all texts on the page → a page with headings/lists/equations never qualified. **B (lists):** `1. …` lines each became a one-item list (also the section headings `1. Model Configuration`…); unmarked bullets were never recognised. Display equation typed as text was wrapped as sentence + fragments of `\frac`, `\sum`. "Inline:" and its equation stayed two overlapping boxes. |
| Converter | Fine; but a 5-row table at the floor font (14 px) with default padding was taller than the space the tall page gave it and overlapped the next heading (padScale now fits it). |

### Changes
- `detectGridTable`: region-based — a run of ≥ 3 consecutive rows with equal cell count, aligned columns (left/right/centre), regular row pitch, non-overlapping cells; the first row is the header (flagged for review). Paragraph lines, list items, equations cannot form such a run (negative tests).
- `mergeListItems`: numbered items must count up (`3. Workflow` then `1. Upload` are not joined); tighter geometry; a lone `N. title` goes back to plain text. New `inferBulletLists`: ≥ 2 plain lines, one shared left edge, indented from the text margin, even pitch → bullet list, flagged "markers inferred".
- `looksLikeLatex`: a `text` that is pure LaTeX becomes a math element. A formula starting right after a short text on the same line joins that sentence as inline math.
- `convert.ts`: table `padScale` shrinks cell padding so the table keeps the height the sketch gave it.
- `Canvas.tsx` (problem C, earlier): a selected text box inside a group (right after Apply) picks equation symbols instead of moving the group; `tests/math-leaf-sketch.mjs` reproduces it with real mouse events.
- Test change: the old test "a grid that is only part of the page is left alone" encoded the very rule that broke composites; it now asserts the grid IS a table and the notes around it are not pulled in.

### Results
- Re-conversion of the REAL saved model output (no model call): native 5×2 table (10 cells exact), `bulletList` ×3, `orderedList` ×3, section headings stay plain lines, display equation = `mathBlock`, `Inline: $E = mc^2$` = one text with `mathInline`, 0 warnings. Verified in the real Electron GUI (replay of the real output): render, per-cell edit + undo, save/reopen, PDF, PPTX (5 `<a:tr>`, 10 `<a:tc>`, `buChar`, `buAutoNum`).
- Not recognised: the blockquote (the model gave no marker; only a plain indented line), bold of table header (no pixel analysis), header row is assumed.

### Speed (problem D) — measured, NOT solved
- Cost model: ~18 s fixed prompt evaluation (+ up to 9 s cold model load) + 6.6 tok/s. The JSON answer (26 elements with ids and four box numbers each) is 1481 tokens = 225 s. 60 s ⇒ ≤ ~290 generated tokens.
- One real experiment, short Markdown-only prompt (no boxes, no JSON): 176 output tokens, prompt 21.4 s, eval 24.3 s, load 9.3 s (cold), wall **55.3 s**; the transcription is exact incl. headings, table, both lists, `$…$`/`$$…$$` and the `>` quote. But it carries no positions, so it needs a new "document mode" (stack blocks vertically in the image frame). That is an architectural addition and was NOT made without approval. Output saved in the scratchpad only.

## Stage 11 — Document Mode (Markdown transcription) next to Layout Mode (2026-11-06)

Approved after the Stage 10 measurement (JSON with boxes: 1481 tokens = 225 s; Markdown: 176 tokens).

### Design
- Two modes coexist; **Document (fast)** is the default, **Layout (positions)** is unchanged. The dialog footer has the two buttons (`aria-pressed`, tooltips say what each does); switching re-converts. The choice is kept for the session. Claude provider: Layout only (Document Mode needs the local model path).
- Main: `recognizeDocument` (`electron/sketch-ai.cjs`) calls Ollama WITHOUT a JSON schema (`plain` option of `chatJSON`, `num_predict` 1200, same `num_ctx` as Layout Mode so switching does not reload the model) with the short Markdown prompt. `parseMarkdownDocument` (`sketch-markup.cjs`) → blocks (heading, paragraph, quote, bullet/ordered list, table, math; `$$` display and `\[ \]`, code fence stripped, consecutive duplicate blocks from a looping model dropped, ragged tables padded, nothing invented) → `documentToModelIR` → the same Structured IR (`layout: 'document'`, nominal boxes) → the same validation, preview, review list and Apply.
- Renderer (`src/sketch/document.ts`): one column (as wide as the image frame, at least 560 px) from the frame's top. All blocks are rendered once in the preview to MEASURE their real heights (the existing `measure` hook), then flowed top to bottom with gaps; a heading is never left alone at a slide's end; a table taller than a slide is split between rows (header repeats); **content that does not fit continues on new slides inserted after the current one in the same commit (one Undo removes them)**; a block taller than a whole slide is kept and warned about, never cut.
- Real model path measured, not the fixture only.

### Measurements — real GUI (Electron + Ollama qwen2.5vl:7b, `~/Downloads/test_composite.png`)
| Run | Total (click → preview) | Ollama | Notes |
|---|---|---|---|
| Document, same image ×3 | 42.2 / 23.6 / 23.9 s | run 1: load 6.9 s + prompt 11.5 s + eval 23.5 s (1127 in, 176 out tokens); runs 2–3: prompt 0.07 s | runs 2–3 hit Ollama's prompt cache (identical image+prompt) → NOT representative |
| Document, 3 distinct-pixel variants (resized 830/850/820 px wide), model warm | **35.2 / 35.3 / 35.1 s** | prompt 10.6–11.4 s + eval 23.5–24.4 s, 176 tokens each | identical Markdown (same hash) in all three; parse+IR+render ≈ 0.2 s; 0 warnings |
| Layout, original image | 215.0 s | (≈ 1400 generated tokens) | 12 elements; native table, bullet, ordered list, display + inline equation, 7 warnings |
Cold model start adds ≈ 7–9 s (observed 42.2 s). Layout Mode earlier: 244.9 s (CLI), 202+ s (user's GUI run).

### Accuracy on the composite screenshot
- Document: exact text everywhere; table 5×2 (header recognised from the `---` row), bullet ×3, ordered ×3, headings, `Inline: $E = mc^2$`, display equation, **blockquote** — all native. Layout positions are NOT kept (reading order only).
- Layout: everything except the blockquote (no marker from the model; plain line); table header assumed; bullets inferred from indentation (flagged).
- Limits: the one image is the only real-model sample for Document Mode (deterministic, 4 identical outputs); handwriting/diagrams/arrows are not Document Mode's job (use Layout); no bold/italic detection (7B).

## Stage 12 — converted equations did not enter the editing state on the first click (2026-11-06)

Report: an equation typed with `/math` is edited with a click (caret at its end, then symbol picking); the Document-Mode equation only showed the blue selection border.

**Investigation (real Electron, real mouse/keyboard events, no `startEditing` shortcuts — `tests/math-leaf-document.mjs`).** Compared typed vs converted equations: same data structure (a text element holding one `mathBlock`; a typed `/math` box holds only the equation at rest, the caret line exists only while editing); same hit-testing on every symbol (the equation is the topmost element); same flow select → click opens the LaTeX popover (caret at the end of the LaTeX) → Esc → caret after the equation; same drag-pick / Shift+→ / palette coloring; inline equation: caret after it + Shift+← picks its last symbol (identical for typed and converted). Held-button (20/120/400 ms) clicks, single and group selection: identical.

**Why `tests/math-leaf-sketch.mjs` passed anyway:** it enters edit mode with `store.startEditing(...)` and so skips the pointer path; the previous fix (symbol press inside a group) was reproduced with a real drag but only for a press ON a rendered symbol.

**The reproduced difference:** right after Apply every converted element is selected (a group). A click that lands on a box holding an equation but not on a rendered symbol (e.g. the sentence `Inline: …` right of its equation) took the "narrow the group to this element" branch of `startMove`: `editing:false, selection:1` = the blue border only. A typed equation is never in a group, so the same click edits it. (A click on a symbol was already fixed in Stage 10.) Failing run before the fix: `inline sentence, after the equation: one click after Apply enters the editing state: {"editing":false,"selection":1,…}`.

**Fix (`src/canvas/Canvas.tsx`, click branch of `startMove`):** a click without movement on a text box that contains an equation, inside a multi-selection, narrows the selection AND starts editing at the click point (the same as a click on an already selected box). Dragging still moves the group; boxes without equations keep the old narrowing behavior.

**Not found / limits:** I could not reproduce any other difference between typed and converted equations with synthetic input; if it still fails in the app, the exact click sequence and the slide it happens on are needed. Shift+←/→ stepping into an equation from a caret exists only for INLINE equations (caret directly after/before it); for a display equation (typed or converted) symbols are picked by dragging, then Shift+←/→ extends — that is existing behavior and unchanged.
