# MathSlides

A lightweight WYSIWYG slide editor for academic and research talks. You edit slides visually, like in Canva or PowerPoint, and type equations Notion-style with `/math`. Decks export to **PDF**, with vector text and equations, and to **PPTX**, with editable text boxes.

## Running it

```bash
cd ~/math-slides
npm install          # first time only

npm run app          # desktop app (Electron): one-click PDF export with a save dialog
npm run dev          # browser: open http://localhost:5173 (use Chrome)
```

You can also double-click `MathSlides.command` in Finder to launch the desktop app.

> For PPTX files to show the same font in PowerPoint, install **NanumSquare** on your Mac ([Naver Hangeul fonts](https://hangeul.naver.com/font)). The editor and PDF already embed the font, so they look right without it.

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
| Shapes | `R` rectangle, `O` ellipse, `L` line, `A` arrow |
| Resize | Image corners keep aspect ratio (`Shift` = free). Text corners scale the font |
| Snapping | Edges and centers of the slide and other objects (hold `Alt` to turn it off) |
| Lists | Type `- ` or `1. `, `Tab` / `⇧Tab` to indent |
| Undo/redo | `⌘Z` / `⌘⇧Z` (while editing text, these undo within the text) |
| Copy/paste/duplicate | `⌘C` `⌘V` `⌘X` `⌘D`, arrow keys nudge (`Shift` = 10px) |
| Z-order | `⌘]` `⌘[` (with `⇧` = to front/back) |
| Slides | Slide list: `Enter` new, `⌘D` duplicate, `⌫` delete, drag to reorder, right-click menu |
| Present | `⌘Enter` / `F5` |
| Save/open | Autosaves to the browser (IndexedDB). `⌘S` saves a `.mslides` file, `⌘O` opens one |
| Export | `⌘P` PDF, `⌘E` PPTX |

---

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
- Shapes and lines become native PowerPoint shapes (fill, outline, arrows, dashes). Images keep their original quality (WebP and similar formats are converted to PNG). Speaker notes are included.
- pptxgenjs writes multiple `<a:pPr>` per paragraph, which breaks the OOXML schema; this is cleaned up with JSZip after generation.
- Tested: the file opens in Microsoft PowerPoint for Mac without a repair prompt and renders correctly.

## Known limitations (MVP)

- No rotation, grouping, image cropping, or tables.
- Equations in PPTX are pictures, not native PowerPoint equations (OMML).
- In PPTX, a line containing inline equations becomes several separate text boxes, so editing the text in PowerPoint can disturb the layout.
- Font size and alignment are set per text box (no per-character sizes).
- Fonts with Korean glyphs (including NanumSquare) display `\` as `₩` in text. Inside equations this doesn't matter.
