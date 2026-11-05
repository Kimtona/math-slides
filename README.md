# MathSlides

A lightweight WYSIWYG slide editor for academic and research talks. You edit slides visually, like in Canva or PowerPoint, and type equations Notion-style with `/math`. Decks export to **PDF**, with vector text and equations, and to **PPTX**, with editable text boxes.

## Running it

```bash
cd ~/math-slides
npm install          # first time only

npm run app          # desktop app (Electron): one-click PDF export with a save dialog
npm run dist:mac     # packaged macOS build (electron-builder): release/mac-arm64/MathSlides.app + MathSlides-<version>-arm64.dmg (unsigned)
npm run dist:win     # Windows NSIS installer (.exe) — run on Windows (not validated yet)
npm run dev          # browser: open http://localhost:5173 (use Chrome)
```

You can also double-click `MathSlides.command` in Finder to launch the desktop app.

> Fonts: NanumSquare (default), Pretendard and Noto Serif KR are bundled (SIL OFL, see `src/fonts/`). The **글꼴** control (left of Theme, nothing selected) sets the font of every text in the presentation and overrides per-text fonts; the font control next to the text size changes only the selected text. For PPTX files to show the same font in PowerPoint, install the font you used (NanumSquare: [Naver Hangeul fonts](https://hangeul.naver.com/font)). The editor and PDF already embed the fonts, so they look right without it.

## Building and installing the macOS app

```bash
npm run dist:mac
```

The build is written to `release/`. On Apple Silicon the main outputs are:

- `release/mac-arm64/MathSlides.app`
- `release/MathSlides-<version>-arm64.dmg` (the filename includes the current `package.json` version)

To install the local build:

1. Open the generated `.dmg`.
2. Drag `MathSlides.app` into the **Applications** folder.
3. Launch MathSlides from Applications (optionally keep it in the Dock).

The macOS build is currently unsigned and not notarized, so macOS may show a security warning the first time you open it. `release/` is generated output and is intentionally ignored by Git.

## Documents and autosave

- **Autosave** is internal (IndexedDB) and never writes your `.mslides` file. It keeps the working presentation, so quitting, reopening the window (Dock) or reloading restores it with the same `Deck.id`.
- **새 프레젠테이션** creates a new presentation (new `Deck.id`); the previous one is kept in a small internal recovery slot if it contains real changes (blank decks are not kept).
- **열기** keeps the current presentation in the recovery slot first, keeps the file's `Deck.id`, and makes that file the current file.
- **저장** writes the current `.mslides` file (the picker appears only when there is none or it can't be written). The current file is remembered across restarts.
- **다른 이름으로 저장** creates an independent presentation: a new `Deck.id`, written into the new file; the original file is not touched.

`.mslides` is registered as a MathSlides document type in the packaged app (macOS `CFBundleDocumentTypes`; Windows through the installer's file association). Double-clicking a `.mslides` file launches or reuses MathSlides and opens it through the same path as **열기…**: the current presentation is preserved first, the file's `Deck.id` is kept, and Save writes back to that file. The Electron main process only reads/writes `.mslides` documents it was asked to open. The document icon (`build/icons/mslides.icns` / `.ico`, generated from `mslides-doc-1024.png` by `make-doc-icon.cjs`) is bundled with an exported type `com.mathslides.presentation` (declared in `build.mac.extendInfo`), which is what lets Finder show it instead of a generic document. The type conforms to `public.data` (not `public.json`) on purpose: although the file is JSON internally, declaring it as JSON/text makes Finder and Quick Look render the raw JSON as the file's thumbnail.

## How to use it

| Action | How |
|---|---|
| Text box | Click an empty spot on the slide (when nothing is selected), or press `T` |
| Edit text | Click a selected box again, double-click it, or press `Enter` |
| **Block equation** | Type `/math` in text → `Enter` → type LaTeX (live rendering) → `Enter` |
| Inline equation | `/inline`, `⌘⇧E` (turns selected text into an equation), or `$$x^2$$` |
| Edit an equation | Click (or double-click) the equation → the LaTeX popover opens again |
| Equation-only box | `M` or the toolbar's 수식 button |
| Image | Drag and drop, `⌘V` (paste a screenshot), or `I`. PNG/JPEG/WebP/GIF/SVG |
| Shape text | Double-click a shape to type inside it (centered, wraps within the shape, the shape never grows). Supports the usual inline formatting (bold, italic, underline, strike, color, highlight, inline code), multiple lines and undo/redo; Escape or a click outside leaves editing. The text is stored on the shape (`ShapeElement.doc`, optional `textStyle`), so it moves/resizes/deletes with it. PPTX: one native shape holding native editable text |
| Shape fill | New shapes are filled with the Highlight light yellow (`HIGHLIGHT_COLORS[0]`, `src/model/colors.ts`); the toolbar **채우기** popover offers the same pastel palette as Highlight plus *None / Remove Fill*. Existing shapes keep their saved fill. Border colors are unchanged |
| Theme color | The slide toolbar's **Theme** control (left of 배경색, same palette as Text Color) sets one presentation-wide color (`Deck.themeColor`, default White = no decorations). It paints derived, non-selectable decorations: a band behind the title on the Title slide, a header band on content slides, a full-color background on section-divider (Sub-title) slides and a thin footer accent. Text on them switches to black/white by contrast (only for default-colored text; colors you chose are kept). Layout lives in `src/model/theme.ts`; PPTX gets native rectangles |
| Todo | Type `/todo` at the start of a line and press Enter. A checkbox + rich text block: click the box to check/uncheck (checked = filled box in the Theme Color — or the editor blue when the theme is White — with muted gray, struck-through text; your marks are not rewritten). Enter adds a new unchecked todo, Enter on an empty todo or Backspace at its start returns to a paragraph. Stored as a `todoItem` node with a `checked` attribute; PPTX: native checkbox shape + editable text |
| Image resize | Handle drag = keep aspect ratio · `⌥ Option`+drag = free resize · `⇧ Shift`+drag = **crop** |
| Crop edit | Double-click the image (or `Enter`): drag = move the image inside the frame, wheel/pinch or blue dots = zoom, white handles = crop frame. `Esc` / `Enter` / outside click = done |
| Object colors | Shape Fill/Border, line color, and slide background: preset palette |
| Text color | Toolbar **A** → Theme Colors (base colors + shades), Standard Colors, or Other Colors… (visual picker + 3/6-digit HEX). A selected text range gets its own color; with only a caret, or with the box selected, the box's default color changes (block equations and list markers follow). Striped indicator = mixed colors |
| Highlight | Highlighter icon next to text color → six light colors or None / Remove Highlight. Selected range → that range; caret only → applies to the text you type next; box selected → the whole box |
| Inline code | **</>** toggles Notion-style inline code (monospace, muted red, light gray background). Combines with text color (overrides the default red), highlight, and emphasis. ⌘E stays PPTX export |
| Shapes | `R` rectangle, `O` ellipse, `L` line, `A` arrow |
| Resize | Text corners scale the font. Shapes: `Shift` = keep aspect ratio |
| Snapping | Edges and centers of the slide and other objects (hold `Alt` to turn it off). Hold `Shift` on the idle canvas to preview the same alignment guides before placing something (editor-only; not while editing text; Shift-click on empty canvas still places a text box) |
| Text sizes | At the start of a line: `# ` 80 · `## ` 50 · `### ` 30 · `#### ` 25 (Backspace at the line start reverts). Sizes live in `src/model/typography.ts` |
| Code block | Type `/code` at the start of a line and press Enter (slash menu). Multi-line monospace code with indentation kept; Enter adds a line, triple Enter or ↓ at the end leaves the block. Separate from inline code. New blocks are 16pt (a property of the block; the font-size field edits it while the caret is inside) and Plain Text. A subtle selector at the block's top-right (editor only) picks Plain Text / Python / C / Bash (no auto-detection); syntax colors are derived from text + language (highlight.js via lowlight), never stored. Tab / Shift+Tab indent / outdent the selected lines by 4 spaces. Languages live in `src/editor/codeHighlight.ts` — add one grammar + list entry to extend |
| Callout | Type `/callout` at the start of a line and press Enter. A subtle rounded panel with an icon (default 💡) and rich text (marks, math, multi-line; Enter on an empty last line leaves it). Click the icon (editor only) to pick one of 10 presets; the icon is stored on the block, not in its text. Native background shape + editable icon/text in PPTX |
| Academic block | Type `/block` at the start of a line and press Enter. A Beamer-style block: colored header (type, optional title) over a tinted rich-text body. Click the header's type (editor only) to switch Block / Theorem / Definition / Lemma / Proposition / Example / Remark; type the optional title in the header. Colors follow semantic families (Theorem, Lemma, Proposition share blue; Definition teal; Example green; Remark amber; Block gray) from `src/model/academicBlocks.ts`. `type` and `title` are attributes of one node. PPTX: native header/body shapes with editable text |
| Image | Toolbar **이미지** and `/image` (line start, Enter) open the same file picker (cancel inserts nothing). Select an image and use **Caption** in the top bar for an optional plain-text caption (14, muted, left-aligned directly below the image, same left edge and width; `Add a caption...` is editor-only). **Remove Caption** deletes it; deleting the image removes both. Stored as `ImageElement.caption`; empty = none. PPTX: native picture plus an editable caption text box |
| Quote | Type `| ` at the start of a line. Thin left line, no quotation marks; Enter continues the quote, Enter on an empty line leaves it. `P(A | B)` mid-line stays text |
| Lists | Type `- ` or `1. `, `Tab` / `⇧Tab` to indent |
| Footer | Slide number `n/total` bottom-left (automatic). Click the bottom-right to type a reference (citation) for that slide |
| Templates | New presentation = Title Slide; each added slide = Content Slide (title + body). Template boxes are ordinary text boxes |
| Title | Editing the Title Slide's main title renames the presentation (default export file name) |
| Table of Contents | Right-click a slide → 목차 슬라이드 추가. Each numbered item is a section and gets its own Sub-title slide ("Part n. …" 80 + next section 30), kept in sync automatically (rename / insert / delete / reorder). Click an entry to jump to its Sub-title slide (double-click to edit). Contents slides are never touched |
| Citations | Paste or type an arXiv URL (`/abs/`, `/pdf/`, `.pdf`, `v7`) into the bottom-right reference field → short citation ("Title, Vaswani et al., 2017") linked to the paper. A References slide (full APA-style entries, deduplicated by arXiv id) is maintained automatically before an optional Thank You slide (right-click → 감사 슬라이드 추가) |
| Undo/redo | `⌘Z` / `⌘⇧Z` (while editing text, these undo within the text) |
| Copy/paste/duplicate | `⌘C` `⌘V` `⌘X` `⌘D`, arrow keys nudge (`Shift` = 10px) |
| Z-order | `⌘]` `⌘[` (with `⇧` = to front/back) |
| Slides | Slide list: `Enter` new, `⌘D` duplicate, `⌫` delete, drag to reorder, right-click menu |
| Present | `⌘Enter` / `F5` |
| Save/open | Autosaves continuously (IndexedDB). Every launch and ∑ → 새 프레젠테이션 starts a fresh presentation; a launch restores the working presentation; New/Open keep displaced work in a recovery slot (at most 3, shown only as ∑ → 직전 작업 복구). `⌘S` saves a `.mslides` file, `⌘O` opens one |
| Export | `⌘P` PDF, `⌘E` PPTX |

---

## Sketch-to-Slides (AI)

*Think on paper. Present with MathSlides.* Draw a slide on paper or in GoodNotes, paste the photo or screenshot on a slide, select it and press **Convert to Editable Slide** (image toolbar). A vision model (local via Ollama by default, or Claude) reads the sketch and MathSlides rebuilds it from ordinary, editable elements: text boxes, LaTeX equations (`/math` blocks, never pictures), outlined shapes with their labels, arrows and connector lines, in the ink colors and the layout you drew.

### Setup

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

Expect about **75–105 s per sketch** on a MacBook Air M-series with 24 GB (measured; most of it is the model writing
its answer). The first call after starting Ollama also loads the model (≈ 3–15 s).

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

### Using it

1. Paste (`⌘V`) or drop the sketch image on a slide (crop it first if it contains more than the slide).
2. Select it → **Convert to Editable Slide**. The dialog shows the original next to the editable result.
3. Look at **Check these**: equations, and anything the model could not read with certainty. For an ambiguous symbol you get *As written* (what is literally on the page, used by default) and *Inferred* (the model's reading from context, e.g. a probable typo). You can edit any text or LaTeX right there.
4. **Apply** replaces the image with the elements (one `⌘Z` brings the image back); **Apply, keep image** keeps it; **Cancel** changes nothing.

### How it works

```text
image ─► vision model (Ollama or Claude, JSON) ─► IR ─► converter ─► deterministic checks ─► preview
                                              ▲                                          │
                                              └──── patches ◄── AI review (≤ 2 rounds) ◄─┘ (original + screenshot)
```

- **IR** (`src/sketch/ir.ts`): elements with kind (`text`/`math`/`shape`/`arrow`/`line`), coordinates normalized 0..1000, text or LaTeX, arrow endpoints and the ids they attach to, relations (`inside`, `annotates`), role (title/label/annotation/body), ink color, and a review flag. The flag is *not* a probability; it only marks what a human should check. The model never writes `.mslides` JSON.
- **Converter** (`src/sketch/convert.ts`): one uniform scale fits the sketch's content into the slide (layout and aspect ratio kept, nothing leaves the slide); equation size from MathJax's real typeset size; text inside a shape becomes the shape's text; arrows attached to shapes start and end on their outlines. No auto-beautify (alignment, spacing) yet.
- **Checks** (`src/sketch/validate.ts`): structure, slide bounds, LaTeX that does not render, unsupported elements, unintended overlaps (labels in shapes, notes on what they annotate and connectors are allowed to touch).
- **AI review**: a second request compares the original with a screenshot of the converted slide (+ the IR and the check results) and returns patches for real conversion errors only, never "improvements" to the writer's content.
- Prompts: `electron/sketch-prompts.cjs` (Claude prompt + a shorter local-model prompt). Model calls: `electron/sketch-ai.cjs` (Claude) and `electron/sketch-ollama.cjs` (Ollama); the local model's flat pixel format is converted to the IR by `electron/sketch-local.cjs`. Settings, key storage and IPC: `electron/sketch-main.cjs`.

### Command line (no GUI)

```bash
npm run sketch -- examples/sketches/policy-gradient.png --out sketch-out             # local model (Ollama)
ANTHROPIC_API_KEY=sk-ant-... npm run sketch -- my-sketch.png --provider anthropic     # Claude
# offline, from a saved model output (no model call; also re-applies the local-format conversion):
npm run sketch -- examples/sketches/diagram-abc.png --ir examples/ollama-runs/exp4/test1.ir.json
node scripts/render-mslides.mjs sketch-out/policy-gradient.mslides out.png          # look at the result
```

It writes `<name>.ir.json` (raw model text and output), `<name>.mslides` (open it in MathSlides) and `<name>.report.json`
(checks, timings, token usage); a failed model call leaves `<name>.failed.json`. Like the app, it resizes the image for
the model (macOS `sips`; metadata such as GPS is dropped). The AI review loop needs the rendered slide, so it runs in
the app only.

### Tests

`node tests/sketch-convert.mjs` (IR parsing, local-model format, conversion, checks; headless) and `node tests/sketch-dialog.mjs` (the dialog end to end in Electron). With Ollama running, `node tests/sketch-ollama-e2e.mjs <out-dir> <image>...` drives the real app with the real local model (convert → Apply → edit → Undo/Redo → save, PDF, PPTX) and writes screenshots, outputs and measured times to `<out-dir>` (not part of `npm test`). The GUI test replaces the model with a fixture (`MATHSLIDES_SKETCH_FAKE=<ir.json>`, shown as "fake (test fixture)" in the dialog), so it needs no key or network. The fixtures in `tests/fixtures/sketch/` are hand-written expected recognitions, not model output.

### Measuring time saved

For a fair comparison, use the same sketch for both: (1) with a stopwatch, rebuild it by hand in MathSlides until it matches the sketch; (2) with a stopwatch, convert it and fix whatever needs fixing until it matches. Record both times and the number of manual fixes in `docs/SKETCH_DEVLOG.md`. The dialog shows the conversion time, and the run log has per-step timings.

## Design

### 1. Architecture and tech stack

```
React 18 + TypeScript + Vite        UI
TipTap (ProseMirror)                rich text inside each text box, /math commands, inline/block math nodes
MathJax 3 (SVG output)              LaTeX → self-contained SVG paths
zustand + immer                     document state, snapshot-based undo/redo (structural sharing)
idb-keyval (IndexedDB)              autosave (deck JSON and images stored separately)
pptxgenjs + JSZip                   PPTX generation and XML fix-ups
Electron (optional shell)           webContents.printToPDF → one-click vector PDF
```

**KaTeX or MathJax?** KaTeX is what Notion uses and it's fast, but it outputs HTML + CSS + web fonts, which can't be put into PowerPoint as vector graphics. MathJax's SVG output (`fontCache: 'none'`) is a self-contained set of `<path>`s, so **the same SVG is used in the editor, the PDF, and the PPTX**: what you see is exactly what gets exported. It renders an equation in about 2 ms, so live preview while typing is as smooth as Notion.

### 2. Components and data structures

```
src/
  model/types.ts        Deck / Slide / SlideElement (text | image | shape | line)
  model/geometry.ts     bounding boxes, snapping
  model/colors.ts       preset palette (the only place colors are defined)
  model/typography.ts   TYPOGRAPHY (h1/h2/h3/body) and footer constants, shared by # shortcuts and templates
  model/imageCrop.ts    crop math (frame ↔ full-image rectangle)
  store/store.ts        state, history (commit / live / gesture), slide operations
  store/persistence.ts  autosave, .mslides files
  math/mathjax.ts       renderTex(latex, display) → SVG (em units, cached)
  editor/               TipTap extensions, math nodes, SlashMenu, MathPopover, TextEditor
  canvas/               Canvas (drag/resize/marquee/snap), insert, arrange (align/distribute)
  render/               StaticText / ElementView: read-only rendering (thumbnails, presentation, export)
  export/               PrintRoot (1:1 DOM), pptx.ts, run.ts
  ui/                   Toolbar, PropsBar, Navigator, Presenter, shortcuts
```

- Slide coordinates are **1280×720 CSS px**. Since 1280px = 13.333in, this matches PowerPoint's widescreen size exactly (1px = 1/96in = 0.75pt).
- `TextElement.doc` is ProseMirror JSON. Math lives in the document as `mathInline` / `mathBlock` nodes with a `{latex}` attribute.
- Text box height is automatic, measured from the content. A box widens automatically if an equation is wider than it.
- Undo: every change produces a new immutable deck, and the previous deck goes on the `past` stack. Continuous actions such as dragging or a text-editing session become one history entry, between `beginGesture` and `endGesture`.
- Images are stored once in a separate `assets` map; elements reference them by `assetId`.
- `Slide.reference` (optional) is the per-slide citation. The slide number is never stored; it's computed from the slide's position.
- `Deck.titleElementId` (optional) explicitly links the Title Slide's main title box to `Deck.title`: editing that box's text updates the title (older files without it don't sync).
- Per-line font sizes from `#` shortcuts are a paragraph attribute (`fontSize`).
- Table of Contents: the TOC box's list items carry stable `sectionId`s; `Deck.sections` maps section → Sub-title slide id (`Slide.kind = 'subtitle'`). Citations: `Slide.citations` (ids) + `Deck.citations` (metadata, keyed `arxiv:<id>`). `model/structure.ts` reconciles Sub-title / References slides inside every change, so undo/redo snapshots stay consistent.
- Links: TOC entries are `#slide-<id>` (internal PDF link / PowerPoint slide jump), citations link to `https://arxiv.org/abs/<id>`. arXiv has no CORS headers: the desktop app fetches via the main process, `npm run dev` via a Vite proxy.
- Image crop is non-destructive: `ImageElement.crop = {x, y, w, h}` is the visible part of the original as fractions (0–1). It's optional, so files without it open as uncropped. It maps 1:1 to PowerPoint's `srcRect`.

### 3. How `/math` works

1. A ProseMirror transaction listener detects `/query` before the cursor and shows the slash menu (Block / Inline equation, lists).
2. On `Enter`: if the paragraph is empty, it becomes a `mathBlock`; otherwise the equation is inserted after it (or the paragraph is split at the cursor). An inline equation is inserted at the cursor.
3. The node is selected and the **MathPopover** (a LaTeX textarea) opens below it. Each keystroke calls `setNodeMarkup`, so the equation re-renders immediately on the slide. While the LaTeX is invalid, the last valid render stays visible (dimmed) and the error message appears in the popover.
4. `Enter` / `Esc` / clicking outside finishes the equation, and the cursor moves after it (a new paragraph is added after a block equation if needed). An empty equation is deleted.
5. Clicking the equation, double-clicking it while the box isn't being edited, or pressing `Enter` when it's selected opens the popover again.

### 4. Images

- Sources: drag and drop (placed at the drop point), the clipboard (`⌘V`, including while editing text), or the file picker. Several images at once are cascaded.
- They are inserted at their original resolution, scaled to fit 70% of the slide (never upscaled).
- Corner handles keep the aspect ratio (`Shift` = free resize). The "원본 비율" (original ratio) button restores it.
- They are stored as data URLs in IndexedDB and in the `.mslides` file. Unused images are cleaned up automatically.

### 5. Export

**PDF**: every slide is rendered at 1:1 in a hidden `PrintRoot`, with `@page { size: 1280px 720px }`.
- Desktop app: Chromium `printToPDF` → save dialog. Result: 960×540pt pages, **embedded fonts (selectable text) and vector equations**.
- Browser: the print dialog opens; choose "PDF로 저장" (Save as PDF). File → Print works too.

**PPTX**: built from `PrintRoot` by **measuring the browser layout** (`getBoundingClientRect`) and placing everything in the same spots.
- Text: runs of consecutive plain paragraphs become **one editable PowerPoint text box**, keeping bold, italic, underline, color, bullets, numbering, line spacing and alignment.
- Block equations become **SVG pictures** (PowerPoint 365 keeps them as vectors; a high-resolution PNG fallback is included).
- Paragraphs with inline equations: PowerPoint can't put a picture inside a text run, so each line is split at the equations. The text pieces become small text boxes and the equations become SVGs, all at their measured positions.
- Shapes and lines become native PowerPoint shapes (fill / no fill, outline, arrows, dashes). Images keep their original quality (WebP and similar formats are converted to PNG). Cropped images use **PowerPoint's native crop** (`<a:srcRect>`): the original is embedded, so the crop can still be adjusted in PowerPoint. Speaker notes are included.
- pptxgenjs writes multiple `<a:pPr>` per paragraph, which breaks the OOXML schema; this is cleaned up with JSZip after generation.
- Tested: the file opens in Microsoft PowerPoint for Mac without a repair prompt and renders correctly.

## Known limitations (MVP)

- PPTX: code blocks are a native rounded rectangle plus editable Menlo text with one colored run per syntax token (same tokenizer; the language selector is not exported); quotes are editable text plus a native line.
- PPTX: text highlight and the inline-code background are native PowerPoint text highlights; inline code is editable Menlo text. PowerPoint does not reproduce the code padding / rounded corners, and may substitute Menlo on systems without it.
- No rotation, grouping, or tables. Crop is rectangular only (no mask shapes).
- Equations in PPTX are pictures, not native PowerPoint equations (OMML).
- In PPTX, a line containing inline equations becomes several separate text boxes, so editing the text in PowerPoint can disturb the layout.
- Font size and alignment are set per text box (no per-character sizes).
- Fonts with Korean glyphs (including NanumSquare) display `\` as `₩` in text. Inside equations this doesn't matter.

## Rich-text validation

Run `npm run typecheck`, `npm run build`, and `npm test` with installed dependencies and a graphical desktop session. The integration test starts Electron with a **temporary user-data directory**, so it never reads or writes your usual autosave/recovery data. Toolbar clicks and typing use native (DevTools) input events; some setup steps call the app's store directly. OS file dialogs and arXiv responses are supplied at their boundaries; application serialization, metadata parsing, and export generation run normally.

It checks selection retention, palette contents, HEX validation, mixed-color indicators, formatting combinations and undo/redo, HTML serialization, autosave/restart/recovery, `.mslides` save/open, heading and math shortcuts, TOC navigation, citation deduplication, and PDF/PPTX exports. PPTX assertions inspect editable runs, native highlights, fonts, and hyperlinks. Screenshots and test files are retained in the temporary output directory printed at completion; `MATHSLIDES_TEST_OUTPUT` can select another output directory. PDF/PPTX visual inspection is separate from these automated assertions.

All color palettes (object presets, Theme/Standard text colors, highlights) live in `src/model/colors.ts`; inline-code styling lives in `src/model/textFormatting.ts`. Highlight/code marks live in `src/editor/formattingMarks.ts` and are stored inside the existing ProseMirror document JSON, with no new storage format.

For manual checks in an isolated desktop profile, run `npm test -- --interactive` and press Ctrl-C when finished.
