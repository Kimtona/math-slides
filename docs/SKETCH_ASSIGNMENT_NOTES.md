# Sketch-to-Slides — notes for the AI-automation assignment

Everything here is recorded from real runs (details and raw outputs: `docs/SKETCH_DEVLOG.md`, `examples/`, `tests/fixtures/sketch/`).
Nothing is estimated unless it says so.

## 1. What the feature automates
Making a slide from a hand-drawn sketch or a screenshot used to mean rebuilding every title, table, list, equation, shape and arrow by hand.
Now: paste the image on a slide → **Convert to Editable Slide** → native, editable MathSlides elements (text with real lists / quotes /
headings, native tables, editable LaTeX equations with per-symbol color, shapes and arrows) → preview with a "check these" list →
**Apply** (one Undo restores the image). Result saves to `.mslides`, exports to PDF and PPTX like anything else.

## 2. Workflow
```text
image ─► (preprocess: crop, downscale to ≈1024 visual tokens)
      ─► vision model (local Ollama qwen2.5vl:7b by default; Claude optional)
           ├─ Layout Mode   : JSON, every element with a box ─► localToModelIR ─► IR ─► irToElements (placement from coordinates)
           └─ Document Mode : Markdown, no positions ─► parseMarkdownDocument ─► IR ─► documentToElements (flow from measured heights, more slides on overflow)
      ─► deterministic validation (LaTeX renders, bounds, overlaps) ─► preview + "Check these" ─► Apply (one undo step)
      ─► ordinary elements: edit, color equation symbols, save, PDF, PPTX
```
Code map: `electron/sketch-{main,ai,ollama,local,markup,prompts}.cjs` (model calls, adapters), `src/sketch/{ir,convert,document,validate,ink,session,bridge}.ts`, `src/ui/SketchDialog.tsx`.

## 3. AI tools and models used
- **Product model (runs inside the feature):** `qwen2.5vl:7b` through Ollama (local, free, offline); optional Claude (Anthropic API, `claude-opus-5-5`) — not used for the measurements below.
- **Development assistant:** Claude Code (Claude Sonnet 5.5) wrote, ran and debugged the code and tests under review of the author; every run, error and timing in the devlog is from the real session.
- Local image/prompt details: prompts `electron/sketch-prompts.cjs`; images are resized to ≈1024 visual tokens, `temperature 0`.

## 4. Problems met and how they were solved (chronological, evidence in the devlog)
| Problem | Cause (measured) | Fix |
|---|---|---|
| 7B model drifts coordinates, loops, writes LaTeX with control characters | experiments 2–3 | flat pixel format + uniform rescale, repetition detection + salvage of finished elements, LaTeX escape repair |
| Formulas from paper captures broke (inline `\(..\)`, wide display math) | adapter wrapped fragments | math-span aware wrapping; fit by MathJax width |
| Converted result floated away from the image | elements fitted to the whole slide | rebuild inside the image's frame |
| Looping/duplicated table answers lost or doubled content | model repeated cells | salvage + duplicate removal before grid detection |
| Composite screenshot: no table, no lists (Stage 10) | grid rule needed ≥80 % of page; `1.` headings became lists; bullets had no glyph | region-based grid detection, counted list merging, bullet inference from indentation, LaTeX-as-text → math |
| 215–245 s per conversion | JSON with boxes = ≈1,400 generated tokens at ≈6.6 tok/s | **Document Mode**: Markdown without positions (176 tokens) |
| Converted equations could not be partly colored (Stage 10, 12) | after Apply all elements are a group selection; presses/clicks narrowed the group instead of entering edit mode | `Canvas.tsx` `startMove` hand-over; tests use real mouse events (the earlier test called `startEditing` directly and missed it) |

## 5. Document Mode vs Layout Mode (same image, real GUI)
| | Layout (positions) | Document (fast, default) |
|---|---|---|
| Output | JSON, id + type + 4 coordinates per element | Markdown, no coordinates |
| Output tokens (`test_composite.png`) | ≈1,400 | 176 |
| Click → preview | **215.0 s** (earlier CLI 244.9 s, user's first GUI run 202+ s) | **35.1–35.3 s** warm (42.2 s with a cold model; 23.6–23.9 s only because of Ollama's prompt cache) |
| Table / bullets / ordered list / equations | native (after the Stage-10 fixes) | native |
| Blockquote | **not recognized** (no marker from the model) | native `blockquote` |
| Table header | assumed first row | from the Markdown `---` row |
| Positions of the original | kept | not kept (reading order, top to bottom; continues on new slides if too long) |
| Best for | sketches, diagrams, arrows, handwriting | screenshots / typed notes / documents |
Why 215 s vs 35 s: generation speed is ≈6.6–7.5 tokens/s on the test machine; time ≈ prompt evaluation (≈11–18 s) + output tokens ÷ speed. Conditions, Ollama counters and the exact commands: `examples/composite/measurements/README.md`.

## 6. Tests and fixtures (what each proves)
- **Real model output, replayed (no model call):** `tests/fixtures/sketch/test-composite.real.json` (Layout JSON), `test-composite.document.real.json` (Markdown), `ai-table.looped-raw.json`, `ai-table.duplicated.json`, `formatted-notes.real-run2.json`, `ppo-grpo.local.json`, `fullduplex.ir.json`.
- **Hand-written fixtures:** `formatted-notes.local.json`; parser edge cases and negative tests (paragraph lines never become a table) in `tests/sketch-convert.mjs`.
- **Real Electron GUI, replayed model:** `tests/sketch-structured-gui.mjs` (table, lists, quote, equations, Document Mode, overflow slides, Undo/Redo, save/reopen, PDF, PPTX), `tests/math-leaf-sketch.mjs`, `tests/math-leaf-document.mjs` (real mouse/keyboard, typed `/math` vs converted equation).
- **Real model + real GUI (manual, minutes):** `tests/sketch-ollama-e2e.mjs`; results in `examples/composite/measurements/`.
- Gates: `npm run typecheck`, `npm run build`, `npm test` (all exit 0 on the final tree; see the integration commit message).

## 7. Run and reproduce
```bash
ollama pull qwen2.5vl:7b && ollama serve        # once
npm install && npm run app                       # paste an image on a slide → Convert to Editable Slide (Document Mode is the default; switch in the footer)
npm test                                         # replayed model outputs, no Ollama needed
node tests/sketch-ollama-e2e.mjs out ~/Downloads/test_composite.png    # real model, real GUI (copy of the image: examples/composite/test_composite.png)
node scripts/sketch2slides.mjs examples/composite/test_composite.png --ir examples/composite/real-before/test_composite.ir.json   # offline re-conversion of the saved Layout output
```

## 8. Limits (as of the final tree)
- Document Mode is verified on one real screenshot (deterministic output); hand-drawn pages, diagrams, arrows need Layout Mode. Document Mode does not keep the original positions.
- The 7B model does not see bold/italic/strikethrough; Korean handwriting is partly misread; every equation and Korean text is offered for review.
- Layout Mode: blockquote not recognized, table header assumed, bullets inferred from indentation (flagged).
- 60 s is reached only in Document Mode; Layout Mode stays ≈3.5 min with this model. A smaller model or OCR + layout detection was not measured.
- Shift+←/→ steps into an equation only from a caret next to an inline equation; display equations are picked by dragging (existing behavior).

## 9. Commits worth citing
`e638e41` IR + layout converter · `7aaf63a` Ollama default provider · `bd801e3` frame placement · `651c252` LaTeX fixes · `362062a` pixel-based colors/bends · `4ef4d47` `b02f038` per-symbol equation colors (port) · `821c5d5` `8eae918` structure (tables, lists) · `87f7a70` composite screenshot recovery · `c95ecd2` Document Mode · `c62a36f` equation click after Apply.
