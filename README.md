<h1>
  <img src="docs/readme/logo.png" alt="MathSlides logo" width="48" height="48" align="absmiddle">
  MathSlides
</h1>

> **Write like Notion. Math like Overleaf. Present as slides.**

<h3 align="center">
  Simple is Best.<br>
  Less formatting, more thinking. 💙
</h3>

<p align="center">
  <a href="https://kimtona.github.io/math-slides/">
    <img src="docs/readme/demo-preview.webp" alt="An 18-second silent preview of MathSlides: typing on a slide, a LaTeX equation after /math, a Definition block, section slides generated from an outline, and the theme color changing across the whole deck" width="100%">
  </a>
</p>

<h3 align="center">
  <a href="https://kimtona.github.io/math-slides/">🎬 Watch the Full Video</a> <sub>(1 min)</sub>
</h3>

<p align="center">
  <a href="https://github.com/Kimtona/math-slides/issues/new?template=bug_report.yml">🐞 Report a Bug</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/Kimtona/math-slides/issues/new?template=improvement.yml">💡 Suggest an Improvement</a><br>
  <sub>🎵 Music: <i>Cat Walk</i> by Arulo, from <a href="https://mixkit.co/free-stock-music/cat-walk-371/">Mixkit</a> (<a href="https://mixkit.co/license/#musicFree">Mixkit Stock Music Free License</a>). Not part of this repository's license.</sub>
</p>


## Project Overview

**MathSlides** is a local 16:9 slide editor for researchers and students who write technical presentations: Notion-style typing, LaTeX equations as live vector graphics, structured blocks (Theorem, Definition, callouts), and export to PDF and editable PPTX. It runs offline as a desktop app (Electron + React + TipTap + MathJax); documents are plain `.mslides` files and nothing needs an account.

**v2.0.0 adds Sketch-to-Slides**: paste a screenshot or a photo of a hand-drawn slide, press *Convert to Editable Slide*, and get **native, editable MathSlides elements** — not the image pasted back in. A vision-language model that runs on your own computer (via Ollama) reads the image; MathSlides rebuilds text, lists, tables, equations and diagrams as ordinary elements you keep editing.

## Key Features

Existing (before v2.0.0), details in the [user guide](docs/USER_GUIDE.md):

- 🧮 LaTeX equations (`/math`, `/inline`) with a symbol palette, favorites and per-symbol colors; Theorem / Definition / callout blocks
- 📝 Notion-style text (headings, lists, quotes, code blocks, links, colors, highlights), tables, images with crop / radius / captions, shapes, arrows, emoji
- 📑 Automatic contents and section slides, arXiv citations, theme colors, alignment guides and snapping, Quick Draw highlight boxes
- 🎤 Presentation mode, PDF with vector text, editable PPTX, `.mslides` files with autosave and recovery, user configuration (`⌘,`)

New in v2.0.0:

- 🖊️ **Sketch-to-Slides** with two conversion modes (Document and Layout), local model by default, optional Claude
- 〰️ Curved lines and curved arrows (quadratic Bézier)
- 🎨 Per-symbol equation colors also work on equations created by Sketch-to-Slides

Release notes and compatibility: [docs/RELEASE_NOTES_v2.0.0.md](docs/RELEASE_NOTES_v2.0.0.md).

## Sketch-to-Slides

Select an image on a slide → **Convert to Editable Slide** (image toolbar). The dialog shows the original next to the editable result and a **Check these** list (every equation and every Korean text from the local model is offered for review). **Apply** replaces the image with the elements in one undo step.

| | **Document mode** (default) | **Layout mode** |
|---|---|---|
| What the model writes | The screenshot as Markdown: `#` headings, `\|` tables, `-` / `1.` lists, `>` quotes, `$…$` / `$$…$$` math | Every element with its position (JSON) |
| Result | Native table, `bulletList` / `orderedList`, `blockquote`, editable `mathInline` / `mathBlock`, headings; set top to bottom in reading order. Content that does not fit continues on new slides (one Undo removes them) | Elements where they were drawn, inside the image's frame: text, math, shapes, arrows, curves, tables, lists |
| Time, `examples/composite/test_composite.png` (real app, MacBook Apple Silicon, `qwen2.5vl:7b`) | ≈ 35 s warm (42–47 s when the model must be loaded first) | ≈ 215 s |
| Best for | Screenshots, typed notes, documents | Hand-drawn sketches, diagrams, arrows |
| Keeps original positions | No | Yes |

Both modes produce the same kind of result: ordinary MathSlides elements. Measurement conditions and raw counters: [`examples/composite/measurements/README.md`](examples/composite/measurements/README.md). Detailed reference: [docs/SKETCH_TO_SLIDES.md](docs/SKETCH_TO_SLIDES.md).

## Architecture and Workflow

```text
image ─► preprocess (crop, resize to ≈1024 visual tokens, metadata stripped)
      ─► vision-language model (Ollama qwen2.5vl:7b locally; Claude optional)
           ├─ Document mode: Markdown ─► parseMarkdownDocument ─► IR ─► flow from measured heights (new slides on overflow)
           └─ Layout mode  : JSON + boxes ─► adapter ─► IR ─► placement from coordinates
      ─► deterministic checks (LaTeX renders, bounds, overlaps) ─► preview + "Check these"
      ─► Apply: native elements (Table, bulletList/orderedList, blockquote, mathInline/mathBlock, shapes, lines)
```

- Main process: `electron/sketch-*.cjs` (model calls over IPC, prompts, adapters, Markdown parser). Renderer: `src/sketch/*.ts` (IR, conversion, placement, validation, session) and `src/ui/SketchDialog.tsx`.
- Nothing is re-implemented for the result: it uses the editor's own Table, list and quote nodes, the MathJax equation nodes and the normal shape / line elements, so autosave, `.mslides`, Undo, PDF and PPTX work unchanged.
- The image never leaves your computer with the default local model. Claude (Anthropic API) is optional and sends the image to the API.

## Prerequisites

- **Mac with Apple Silicon, macOS 13+** (the supported platform; release builds are Apple Silicon DMGs). Windows packaging is configured but not validated.
- **Node.js 22 (LTS)** and Git (to run from source).
- **[Ollama](https://ollama.com)** and the model `qwen2.5vl:7b` (≈ 6 GB download). Measurements were taken on an Apple Silicon MacBook with 24 GB of memory; a Mac with 16 GB+ is expected to be enough but was not measured.
- Optional: an Anthropic API key (only for the Claude provider).

## Installation

**Use the app (no build):** follow [Installing the app](#installing-the-app) below.

**Run from source (needed to reproduce Sketch-to-Slides):**

```bash
git clone https://github.com/Kimtona/math-slides.git
cd math-slides
npm install
```

## Local VLM Setup

```bash
brew install ollama          # or download the app from https://ollama.com
ollama serve                 # skip if the Ollama app is already running (listens on http://localhost:11434)
ollama pull qwen2.5vl:7b
```

No key or other configuration is needed: Ollama and `qwen2.5vl:7b` are the defaults. Optional overrides:

| Setting | How |
|---|---|
| Provider / model / host | **AI settings…** in the dialog, or `MATHSLIDES_SKETCH_PROVIDER=ollama\|anthropic`, `MATHSLIDES_OLLAMA_MODEL=<name>`, `OLLAMA_HOST=<host:port>` |
| Claude | **AI settings…** → *Claude* + API key (stored encrypted with the OS keychain), or start with `ANTHROPIC_API_KEY=…` (model `MATHSLIDES_SKETCH_MODEL`, default `claude-opus-5-5`) |
| Run log of every conversion (input, raw model output, IR, checks, timings) | `MATHSLIDES_SKETCH_LOG=<dir>` |

The first conversion after Ollama has been idle also loads the model (≈ 7–9 s).

## Quick Start and Reproduction

1. Make sure Ollama is running and the model is pulled (above).
2. Start the desktop app (the feature needs Electron; the browser dev mode disables the button):
   ```bash
   npm run app
   ```
3. Insert the example screenshot on a slide: drag [`examples/composite/test_composite.png`](examples/composite/test_composite.png) onto the slide (or paste it, or `/image`).
4. Select the image → **Convert to Editable Slide**. Document mode is selected by default; the footer switches to Layout mode (re-converts).
5. Review the **Check these** list, then press **Apply**. `⌘Z` brings the image back.
6. Verify that the result is editable element by element: click a table cell and type; edit a list item; click an equation and change its LaTeX (or drag over some of its symbols and pick a text color); move a heading on its own.

Without a GUI, the saved real model output can be converted again (no model call):

```bash
npm run sketch -- examples/composite/test_composite.png --ir examples/composite/real-before/test_composite.ir.json --out sketch-out
```

and `npm run sketch -- <image> --out sketch-out` runs the Layout-mode pipeline with the local model (the Document mode lives in the app). Re-measuring the 215 s vs 35 s comparison: [`examples/composite/measurements/README.md`](examples/composite/measurements/README.md).

## Example Input and Output

Input: [`examples/composite/test_composite.png`](examples/composite/test_composite.png) — a screenshot with a title, five section headings, a 5 × 2 table with a header row, a 3-item bullet list, a 3-item numbered list, an inline equation, a display equation and a block quote.

Output of Document mode on the real model (verified in the real app, 2026-11-06):

| In the image | Becomes |
|---|---|
| Title and `1.`–`5.` headings | larger paragraphs, in reading order |
| 5 × 2 table | one native **Table** (header row, 10 cells editable one by one) |
| Bullet list / numbered list | `bulletList` / `orderedList` with 3 `listItem`s each |
| `Inline: E = mc²` | text with an inline equation (`mathInline`) |
| Display equation | `mathBlock` (LaTeX `L = \frac{1}{N} \sum_{i=1}^{N} (y_i - \hat{y}_i)^2`) |
| Quote | `blockquote` |

The content is longer than one slide, so it continues on one more slide. Other example images (hand-drawn diagrams, a paper capture, a table screenshot) are in `examples/sketches/`; the raw model outputs of every real run are kept in `examples/` and `tests/fixtures/sketch/`.

## Testing

| Command | What it covers |
|---|---|
| `npm run typecheck` | TypeScript check |
| `npm run build` | Typecheck + production build |
| `npm test` | Headless model tests and Electron GUI tests (hidden windows, temporary profiles). Sketch-to-Slides tests replay **recorded real model outputs** from `tests/fixtures/sketch/`, so Ollama is not needed |
| `node tests/sketch-ollama-e2e.mjs <out-dir> <image>` | Real model + real app (minutes; needs Ollama). `SKETCH_MODE=layout` selects Layout mode |

Sketch-specific tests: `sketch-convert` (parsers, adapters, placement; headless), `sketch-structured-gui` (tables, lists, quote, equations, Document mode, overflow, Undo, save/reopen, PDF, PPTX), `math-leaf-sketch` and `math-leaf-document` (equation editing driven by real mouse and keyboard events). Recorded results and evidence: [docs/SKETCH_DEVLOG.md](docs/SKETCH_DEVLOG.md), [docs/SKETCH_ASSIGNMENT_NOTES.md](docs/SKETCH_ASSIGNMENT_NOTES.md).

## Known Limitations

- Document mode is verified on one real screenshot; it does not keep the original positions, and it is not meant for hand-drawn diagrams or arrows (use Layout mode).
- Layout mode takes about 3.5 minutes on this model for a dense page; it does not recognize block quotes, assumes the first table row is a header, and infers bullet markers from indentation (flagged for review).
- The local 7B model does not see bold, italic or strikethrough, and misreads Korean handwriting in part; equations may contain symbol errors. That is why equations and Korean text are always offered for review.
- Document mode is available with the local model only; the Claude provider uses Layout mode.
- Shift+← / → steps into an equation from a caret only for inline equations; display equations are picked by dragging over their symbols.
- Releases are ad-hoc signed and not notarized (one-time *Open Anyway* approval); there is no auto-updater. App menus are in Korean.
- Timing numbers depend on the machine; they were measured on one MacBook.

## Repository Structure

```text
electron/            main process: window, IPC, Sketch-to-Slides model calls, prompts, adapters (sketch-*.cjs)
src/                 renderer: model/, store/, canvas/, editor/ (TipTap), math/ (MathJax), render/, export/ (PDF, PPTX),
                     sketch/ (IR, conversion, Document-mode placement, validation, session), ui/
tests/               headless and Electron GUI tests; tests/fixtures/sketch/ = recorded real model outputs
scripts/             sketch2slides.mjs (CLI), render-mslides.mjs, macOS release verification
examples/            sample images and recorded runs (composite/, sketches/, ollama-runs/, ...)
docs/                USER_GUIDE, SKETCH_TO_SLIDES, SKETCH_DEVLOG, SKETCH_ASSIGNMENT_NOTES, DEVELOPMENT, PROJECT_STATUS, V2_PLAN, RELEASE_NOTES_v2.0.0
```

Building from source, tests and releases: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

<a id="installing-the-app"></a>

## Installing the app

Free · No account · Apple Silicon (M1+) · macOS 13+

**[⬇️ Download the latest MathSlides (.dmg)](https://github.com/Kimtona/math-slides/releases/latest)**

1. 📥 **Open** the downloaded `.dmg` and drag **MathSlides** into **Applications**.
2. 🚀 **Launch** it. If macOS shows a warning, click **Done** (not *Move to Trash*).
3. 🔓 **Approve** it in **System Settings → Privacy & Security → Open Anyway**.

<p align="center">
  <img src="docs/readme/macos-open-anyway.png" alt="macOS System Settings, Privacy &amp; Security: the message that MathSlides.app was blocked, with the Open Anyway button (그래도 열기) on the right" width="560">
</p>

4. 🎉 **Done:** from then on, open MathSlides as usual.

- The warning appears because the app is ad-hoc signed, not notarized. It is a one-time approval per installed version.
- The screenshot is from macOS 26 in Korean; wording differs by version and language (**Done** = 완료, **Open Anyway** = 그래도 열기).
- Standard (non-admin) users are asked for an administrator password when copying to Applications.
- There is no auto-updater. To update, install the newest `.dmg` over the old app (**Replace**). Your files, autosave and preferences are kept.

<details>
<summary>🩺 Troubleshooting</summary>

- **No "Open Anyway" button:** try opening the app once more, then check Privacy & Security again. Managed Macs may block it.
- **"MathSlides is damaged":** use version 1.1.0 or newer (earlier builds had an invalid signature), then verify the download and the installed app. Both commands only read information:

  ```bash
  shasum -a 256 -c SHA256SUMS   # in the folder with the DMG and SHA256SUMS from the release
  codesign --verify --deep --strict --verbose=2 /Applications/MathSlides.app
  ```

  If a check fails, [open an issue](https://github.com/Kimtona/math-slides/issues) with your macOS version and the output.

</details>


## 🗺️ Roadmap

Ideas for future updates:

- 🪟 **Windows Support** — Bring MathSlides to Windows.
- 📝 **Notion → MathSlides** — Turn Notion notes into presentation slides automatically.
- 🏷️ **More Slash Commands** — Add `/badge` and other presentation-friendly blocks.

Have an idea of your own? [Suggest an Improvement](https://github.com/Kimtona/math-slides/issues/new?template=improvement.yml).

---

<p align="center">
  Made with ❤️ for researchers.<br>
  If you find MathSlides useful, consider giving it a ⭐!
</p>
