# MathSlides v2.0.0 — release notes

**Highlight: Sketch-to-Slides.** Paste a screenshot or a photo of a hand-drawn slide, press *Convert to Editable Slide*, and get native, editable MathSlides elements instead of a picture. A vision-language model running on your own computer (Ollama, default `qwen2.5vl:7b`) reads the image; Claude is an optional alternative.

## New in 2.0.0

**Sketch-to-Slides** (new)
- Two conversion modes, selectable in the dialog:
  - **Document mode** (default): the image is read as Markdown and rebuilt top to bottom — headings, a native **Table** (header row, per-cell editing), real **bullet / numbered lists**, **block quotes**, editable **inline and display equations**. Content that does not fit continues on new slides (one Undo removes them).
  - **Layout mode**: every element with its position, rebuilt inside the image's frame — text, equations, shapes, arrows, curves, tables, lists.
- Preview next to the original, a **Check these** list (equations and Korean text are always offered for review), deterministic checks (LaTeX renders, bounds, overlaps), optional AI review (off by default with the local model), single-step Apply / Undo.
- Local by default: free, offline after the model download, the image stays on the computer. Optional Claude provider (API key stored with the OS keychain or `ANTHROPIC_API_KEY`).
- Command-line tool `npm run sketch` (Layout pipeline, offline re-conversion from a saved model output) and an optional per-conversion run log (`MATHSLIDES_SKETCH_LOG`).
- Measured on one real screenshot in the real app (MacBook Apple Silicon): Document mode ≈ 35 s (42–47 s with a cold model), Layout mode ≈ 215 s. Conditions: `examples/composite/measurements/README.md`.

**Editor additions made along the way**
- Curved lines and curved arrows (quadratic Bézier).
- Per-symbol equation colors (drag over symbols or Shift+← / →, then the Text Color palette) — also on equations created by Sketch-to-Slides.
- A click on an equation box right after Apply edits it immediately (instead of only narrowing the selection).

**Existing features are unchanged** (equations, structured blocks, text, tables, images, shapes, themes, presentation mode, PDF / PPTX export, `.mslides` files, configuration).

## Compatibility and known limits

- **Breaking changes: none known.** `.mslides` stays format version 1. Documents that contain curved lines / arrows or per-symbol equation colors were created with new element data; MathSlides 1.3.x may not display them as intended. Older documents open unchanged.
- New runtime dependency: `@anthropic-ai/sdk` (used only by the optional Claude provider).
- Platform: Apple Silicon Mac, macOS 13+. Release DMGs are ad-hoc signed and not notarized (one-time *Open Anyway* approval); no auto-updater. Windows packaging is configured but not validated.
- Sketch-to-Slides needs Ollama with `qwen2.5vl:7b` (≈ 6 GB) for the default setup.
- Document mode: verified on one real screenshot, positions of the original are not kept, not meant for hand-drawn diagrams. Layout mode: ≈ 3.5 minutes for a dense page, no block-quote recognition, first table row assumed to be the header, bullet markers inferred from indentation.
- The 7B model does not see bold / italic / strikethrough and partly misreads Korean handwriting; equations can contain symbol errors.

## Verification (previously completed, not re-run for this release)

On commit `6db351a` (2026-11-06): `npm run typecheck` exit 0, `npm run build` exit 0, `npm test` exit 0 on the merged `main`; real-model, real-app runs of `test_composite.png` (Document mode 35.1–35.3 s warm ×3, 46.9 s final check; Layout mode 215.0 s) with the full Apply → Undo/Redo → save/reopen → PDF → PPTX path. Evidence: `docs/SKETCH_DEVLOG.md` (Stages 9–13), `examples/composite/measurements/`.
For this release preparation only version metadata and documentation changed; see the checks listed in the release summary.

## Upgrade

Install the new DMG over the old app (**Replace**); files, autosave and preferences are kept. To use Sketch-to-Slides: install Ollama and run `ollama pull qwen2.5vl:7b` (see the README).
