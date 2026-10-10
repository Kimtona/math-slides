# MathSlides

> **Write like Notion. Math like Overleaf. Present as slides.**

MathSlides is a compact macOS presentation editor for technical and research talks, built around one idea: spend less time making formatting decisions and more time writing the talk.

<p align="center">
  <img src="docs/readme/editor-overview.png" alt="The MathSlides editor with a research slide containing a plotted figure, a diagram made of shapes, and LaTeX equations" width="100%">
</p>

## Download for macOS

<p align="center">
  <a href="https://github.com/Kimtona/math-slides/releases/latest"><b>⬇ Download MathSlides for macOS</b></a><br>
  <sub>Free · runs locally · no account</sub>
</p>

**Requires:** a Mac with **Apple Silicon** (M1 or later) running **macOS 13 Ventura or newer**. Intel Macs are not supported.

1. **Download** `MathSlides-<version>-arm64.dmg` from the [latest release](https://github.com/Kimtona/math-slides/releases/latest) (listed under **Assets**).
2. **Open** the `.dmg` and drag **MathSlides** into the **Applications** folder. If you are a standard (non-administrator) user, Finder asks for an administrator's name and password to copy into Applications.
3. **Open MathSlides** from Applications. macOS says it can't verify that the app is free of malware, because MathSlides is free and not notarized by Apple. Click **Done**. **Do not click Move to Trash**, which would move the app to the Trash.
4. Open **System Settings → Privacy & Security** and scroll down to the **Security** section. Next to the message about MathSlides, click **Open Anyway**, and follow any prompt macOS shows (it may ask for an administrator's password or Touch ID). MathSlides then opens; if it doesn't, open it again from Applications.

You only need to do this once for the installed copy; after that MathSlides opens normally. MathSlides is signed ad-hoc (not with an Apple Developer ID) and is not notarized, which is why macOS asks for this one-time approval. Nothing in these steps turns off any macOS protection.

Button and menu names follow your system language. For example, in Korean **Done** is **완료**, **Move to Trash** is **휴지통으로 이동**, and **Open Anyway** is **그래도 열기**. These steps were tested on macOS 26; other macOS versions may word the dialogs slightly differently.

### Check your download (optional)

Every release includes a `SHA256SUMS` file next to the DMG. Download both into the same folder and run this in Terminal from that folder:

```bash
shasum -a 256 -c SHA256SUMS
```

It should print `MathSlides-<version>-arm64.dmg: OK`.

### Troubleshooting

**macOS says "MathSlides is damaged and can't be opened."** Please don't try to work around the message. A correct MathSlides download shows the "can't verify" warning from step 3, not "damaged". Releases before 1.1.0 were packaged with an invalid app signature that could cause this, so install the [latest release](https://github.com/Kimtona/math-slides/releases/latest). If you already have 1.1.0 or newer, check the artifact (both commands only read information):

1. Verify the DMG with `shasum -a 256 -c SHA256SUMS` as above. If it doesn't print `OK`, download it again from the official Releases page.
2. Check the installed app's signature:

   ```bash
   codesign --verify --deep --strict --verbose=2 /Applications/MathSlides.app
   ```

   It should report `valid on disk` and `satisfies its Designated Requirement`.

If either check fails, or the message persists, please [open an issue](https://github.com/Kimtona/math-slides/issues) with your macOS version and the output of both commands.

**There is no "Open Anyway" button.** The button appears in **Privacy & Security** after you have tried to open the app. Open MathSlides once more, then look again. On a Mac managed by an organization, an administrator may not allow it.

### Updating

MathSlides has no automatic updater; updates are manual. To update:

1. Download the newest `.dmg` from the [Releases page](https://github.com/Kimtona/math-slides/releases/latest).
2. Quit MathSlides, open the `.dmg`, and drag **MathSlides** into **Applications**, choosing **Replace**.
3. Open it again. Each version is a new, not-notarized build, so macOS may ask you to approve it once more (steps 3–4 above).

Your `.mslides` files are ordinary files wherever you saved them. Your autosave, recovery data, and personal shortcuts (saved colors, quick emojis, favorite math) are stored in your user data folder, not inside the app, so replacing the app keeps all of them.

<p align="center">
  <a href="#write-like-notion">Write</a> ·
  <a href="#math-like-overleaf">Math &amp; citations</a> ·
  <a href="#present-as-slides">Slides</a> ·
  <a href="#made-with-mathslides">Showcase</a> ·
  <a href="#development">Development</a>
</p>

---

## Why MathSlides?

Making a research talk involves many small, repeated decisions: what size this heading should be, where the equation or code tool lives, how to rebuild the section pages, how to format the references, how to recolor every slide for your lab. MathSlides turns each of these into a convention, so what remains is writing. It runs locally, with no account.

- **Write like Notion:** `#` to `####` pick from four fixed sizes, and `/math`, `/block`, `/code`, `/image` add research content without leaving the line you are typing.
- **Math like Overleaf:** LaTeX equations rendered as you type, and arXiv links that become citations and a References slide.
- **Present as slides:** an outline that generates section slides, one theme color for the whole deck, presentation mode, and PDF / PPTX export.

## Write like Notion

### Predictable text hierarchy

The idea is to skip the font-size decision. Type a Markdown prefix at the start of a line and the line takes its size from one fixed scale:

| You type | Size on the slide | Typical use |
|---|---|---|
| `# ` | **80** | Title |
| `## ` | **50** | Slide heading |
| `### ` | **30** | Subheading / template body |
| `#### ` | **25** | Body text |

Backspace at the start of the line reverts it. The same scale drives the built-in Title and Content templates, so every slide in a deck lines up. (Sizes are px on a 1280×720 slide. The exported 13.33″ widescreen deck is that slide at 96 px per inch, so 1 px = 0.75 pt in PowerPoint: 80 → 60 pt, 50 → 37.5 pt, 30 → 22.5 pt, 25 → 18.75 pt. You can change these sizes for new content in the [configuration file](#configuration).)

### Slash commands

Type `/` and keep writing. `/math`, `/block`, `/code`, and `/image` add an equation, a theorem or definition, highlighted code, and a captioned figure in the flow of your text, without a trip to the toolbar. Keep typing after `/` to filter:

<table>
<tr>
<td width="50%" valign="top"><img src="docs/readme/slash-menu.png" alt="The slash command menu listing Block equation, Inline equation, Code block, Callout, Block, Image and more"></td>
<td width="50%" valign="top"><img src="docs/readme/todo-command.png" alt="Typing /todo filters the menu down to the Todo command"><br><br><img src="docs/readme/todo-result.png" alt="The resulting todo list with one checked item and an inline equation"></td>
</tr>
<tr>
<td align="center"><sub>Type <code>/</code> to see every command.</sub></td>
<td align="center"><sub><code>/todo</code> + Enter turns the line into a checklist.</sub></td>
</tr>
</table>

| Command | Inserts |
|---|---|
| `/math` | Block equation (LaTeX, rendered live) |
| `/inline` | Inline equation (also `⌘⇧E`, or type `$$x^2$$`) |
| `/todo` | Checklist item. Click the box to check it off; Enter adds the next item |
| `/callout` | Rounded note panel with an emoji icon (💡 by default, any emoji via the picker) |
| `/block` | Beamer-style block: Block, Theorem, Definition, Lemma, Proposition, Example, Remark |
| `/code` | Code block with Plain Text / Python / C / Bash highlighting |
| `/image` | Image from a file, selected so **Caption** in the top bar adds its caption right away (drag-and-drop and `⌘V` paste also work) |
| `/bullet`, `/number` | Bulleted / numbered list (or just type `- ` / `1. `) |

`/code`, `/callout`, `/block`, `/image` and `/todo` are offered at the start of a line. Also: `| ` starts a quote, `**bold**` works as expected, `Tab` / `⇧Tab` indent list items, and the format bar adds colors, six highlight colors, and inline code to a selection.

## Math like Overleaf

### LaTeX, rendered as you type

Type `/math`, press Enter, and write LaTeX. Enter puts you back in your text.

<img src="docs/readme/math-equation.png" alt="The equation popover: LaTeX source in a text field, the rendered fraction directly above it on the slide" width="720">

- **Inline or display.** `/math` for display equations; `$$…$$`, `/inline`, or `⌘⇧E` (on selected text) for math inside a sentence, including inside shapes, callouts, and theorem blocks.
- **Vector everywhere.** Equations are rendered by [MathJax 3](https://www.mathjax.org/) to SVG, and the same SVG is used in the editor, presentation mode, the PDF, and the PPTX.
- **Optional helpers.** The `Ω` button opens a palette of symbols and templates (Greek, operators, `\mathbb{}`, fractions, matrices, `cases`, …). The ☆ button saves the current expression as a favorite you can reinsert from the palette.
- **Click to edit** any equation later. While the LaTeX is invalid, the last good render stays visible and the error is shown in the popover.

> **Scope:** this is MathJax's TeX input for *math* (most AMS-style math commands work). It is not a full LaTeX document engine: there is no document preamble, no packages beyond what MathJax provides, no shared macro file, and no Overleaf project import.

### arXiv citations → References slide

Every slide has a reference field in its bottom-right footer. Paste an **arXiv URL** there (or type one and press Enter), and MathSlides turns it into a citation:

<p align="center">
  <img src="docs/readme/citation-footer.png" alt="Slide footer before and after: a pasted arXiv URL becomes the short citation 'Deep Unsupervised Learning using Nonequilibrium Thermodynamics, Sohl-Dickstein et al., 2015'" width="100%">
</p>

<p align="center">
  <img src="docs/readme/showcase-references.png" alt="Automatically generated References slide listing three arXiv papers in compact author-year format" width="55%">
</p>

1. **Paste:** an `arxiv.org/abs/…`, `/pdf/…` or `/html/…` URL (a version such as `v7` is fine).
2. **Cite:** MathSlides fetches the title, authors, and year from arXiv and shows a short citation linked to the paper. The `×` on a citation removes it from that slide. Other text in the footer stays as a plain note.
3. **Collect:** a **References** slide is created at the end of the deck (before a Thank-you slide) and kept up to date. Each paper appears once even if cited on several slides, in compact author-year style, sorted by first author. A long list continues on *References (cont.)*, and the slide is removed when no citations remain (unless you added your own content to it).

This workflow is **arXiv-only** for now. Other links, DOI links, and bare arXiv IDs are not converted; they stay as plain footer text. Citations are author-year, not numbered, and fetching the metadata needs a network connection.

## Present as slides

The result is an ordinary 16:9 deck: everything on a slide can still be dragged, resized, and snapped into place with alignment guides.

### Outline → section slides

Write the outline of your talk once, and MathSlides builds and maintains a section-title slide for every part, much like a Beamer table of contents with section pages.

<img src="docs/readme/structure-sections.png" alt="An Outline slide with three numbered sections; the slide list shows the generated 'Part 1', 'Part 2' and 'Part 3' section slides" width="100%">

1. **Outline:** right-click a slide → **목차 슬라이드 추가** (*Add contents slide*) and type your sections as a numbered list: *Motivation, Method, Experiments, …*
2. **Generated:** each entry gets its own section-title slide, *Part 1. Motivation*, *Part 2. Method*, …, with the next part shown underneath. Rename, add, or reorder entries and these slides update automatically; remove an entry and its slide is deleted.
3. **Linked:** click an entry to jump to its section slide, in the editor, presentation mode, the PDF, and the PPTX.

Placement in the deck is up to you: new section slides are added near the end (before References), so drag each one to where its part begins.

### Theme color

The **Theme** control in the top bar (with nothing selected) sets one presentation-wide color:

<img src="docs/readme/theme-colors.png" alt="The Theme color palette with theme colors, standard colors, saved My Colors, and a custom HEX field, over a deck themed navy" width="600">

- It colors the title band, content-slide headers, section-slide backgrounds, and a thin footer accent, and keeps text on them readable.
- **Other Colors…** accepts any HEX value (or the picker/eyedropper), and **☆** saves it to **My Colors** for all your presentations. The same bar sets the presentation font (NanumSquare, Pretendard, Noto Serif KR).

## Made with MathSlides

A reading-group deck built in the current app. Everything below is regular MathSlides content: themed templates, typed Markdown shortcuts, slash-command blocks, LaTeX, a plotted figure inserted as an image, shapes, and arXiv citations. Its References slide is the one shown [above](#arxiv-citations--references-slide).

<p align="center">
  <img src="docs/readme/showcase-equations.png" alt="Slide 'The forward process' with a Definition block, a Remark block, two display equations and a callout" width="100%">
</p>

<table>
<tr>
<td width="50%"><img src="docs/readme/showcase-motivation.png" alt="Slide with highlighted bullet points, a callout, and a todo-style reading plan"></td>
<td width="50%"><img src="docs/readme/showcase-figure.png" alt="Slide with a density plot and caption, a three-box diagram with arrows, and bullets with inline math"></td>
</tr>
</table>

## Key features

- **Rich text:** bold, italic, underline, strike, text colors, six highlight colors, inline code, and lists.
- **Structured blocks:** callouts, Beamer-style theorem/definition blocks, todo lists, quotes, and syntax-highlighted code.
- **Figures and diagrams:** images with crop and captions, shapes with text, lines, arrows, adjustable block arrows, and standalone emoji (10 customizable quick emojis plus a full searchable picker).
- **Present and export:** full-screen presentation mode (`⌘↵` / `F5`), **PDF** with selectable text and vector equations (`⌘P`), and editable **PPTX** with native text boxes, shapes, and speaker notes (`⌘E`).
- **Personal shortcuts:** saved colors, favorite math expressions, and quick emojis are kept as your preferences across presentations.
- **Files:** autosave, `.mslides` documents (`⌘S` / `⌘O`) that open from Finder with a double-click, and recovery of displaced work.

> The app's menus and tooltips are currently in **Korean** (e.g. 내보내기 = Export, 발표 = Present). Slash commands, LaTeX, and keyboard shortcuts are the same in any language.

## Configuration

MathSlides has no Settings window. A small text file, `config.txt`, holds the defaults used for **new** content.

1. Press **`⌘,`** to open `config.txt` in your default text editor. The first time, MathSlides creates it for you with every setting at its built-in default (the table below explains each one).
2. Change a value and save the file.
3. Back in MathSlides, press **`⌘⇧,`** to apply it. No restart is needed, and MathSlides loads the file again by itself every time it starts.

Changes affect only what you create afterwards. Headings, text boxes, shapes and images that are already on your slides keep exactly the look they were created with.

The file lives in MathSlides' data folder (on macOS: `~/Library/Application Support/math-slides/config.txt`), outside your presentations, so it is never saved into a `.mslides` file and survives app updates.

```ini
# Typography
font = NanumSquare
heading-1 = 80
heading-2 = 50
heading-3 = 30
body-size = 25

# Shapes
shape-fill = none
shape-stroke = #000000
shape-stroke-width = 1px

# Images
image-radius-preset = 50px
```

| Setting | Built-in default | What it controls |
|---|---|---|
| `font` | `NanumSquare` (or `Pretendard`, `Noto Serif KR`) | Font of newly created text |
| `heading-1` / `heading-2` / `heading-3` | `80` / `50` / `30` | Size of new `#`, `##`, `###` lines and template titles |
| `body-size` | `25` | New text boxes, text inside new shapes, and `####` lines |
| `shape-fill` | `none` | Fill of new shapes: a HEX color like `#FFFFFF`, or `none` |
| `shape-stroke` | `#000000` | Outline color of new shapes |
| `shape-stroke-width` | `1px` | Outline width of new shapes |
| `image-radius-preset` | `50px` | The value the image corner-radius preset button applies |

**Syntax.** One `key = value` per line. Blank lines are ignored, and a line starting with `#` is a comment (put comments on their own line, not after a value). For font sizes, **write a plain number without `px` or `pt`**, for example `heading-1 = 80`. Plain numbers are exactly the numbers shown in MathSlides' font-size box in the toolbar, so `heading-1 = 80` gives a line that shows 80 there. *(Advanced, optional:)* a `px` or `pt` suffix is also accepted, with `pt` meaning PowerPoint points (1 pt = 4/3 px), so `60pt` is the same size as `80` and `100pt` would show 133.33. Older files that use `pt` keep working.

**Reset.** Delete a line (or put `#` in front of it) to bring back that setting's default, then press `⌘⇧,`. To reset everything, delete `config.txt` and press `⌘⇧,` (`⌘,` creates a fresh commented copy).

**If there is a mistake.** MathSlides shows a message such as `Config error on line 5: invalid heading-2: …` and keeps using the last settings that worked, so nothing is half-applied. Fix the line, save, and press `⌘⇧,` again. If the file is wrong when MathSlides starts, it runs with the built-in defaults and shows the same message; it never edits or deletes your file.

> The configuration file belongs to the desktop app. When running in a browser (development), the built-in defaults are used.

---

## Development

### Build the app from source

Most people should use the [download](#download-for-macos) above. To build your own copy you need an Apple Silicon Mac, [Node.js](https://nodejs.org/) 22 (LTS), and Git:

```bash
git clone https://github.com/Kimtona/math-slides.git
cd math-slides
npm install
npm run dist:mac
```

This creates, in the git-ignored `release/` folder, `MathSlides-<version>-arm64.dmg` and `mac-arm64/MathSlides.app`. A local build is signed ad-hoc like the release DMG and is not notarized, so the [first-launch approval](#download-for-macos) may apply to it too. To update a source checkout, run `git pull && npm install`; this does not change an app already installed in `/Applications`.

### Run and test

```bash
npm install
npm run app:dev     # Electron + Vite dev server with hot reload
npm run app         # production build, then launch in Electron
npm run dev         # browser only, http://localhost:5173 (use Chrome)
```

| Command | What it does |
|---|---|
| `npm run typecheck` | TypeScript check (`tsc -b`) |
| `npm run build` | Typecheck + production Vite build into `dist/` |
| `npm test` | Headless model tests + Electron GUI tests (hidden windows, isolated temporary profile; `MATHSLIDES_TEST_VISIBLE=1` to watch) |
| `npm run dist:mac` | Package the macOS app and `.dmg` into `release/` |
| `npm run dist:win` | Windows NSIS installer (configured, not yet validated) |

You can also double-click `MathSlides.command` in Finder to run the app from source.

**Stack:** React 18 + TypeScript + Vite · TipTap (ProseMirror) for rich text · MathJax 3 (SVG) for equations · zustand + immer for state and undo · IndexedDB autosave · pptxgenjs for PPTX · Electron for the desktop shell and `printToPDF`.

Contributors: start with [`CLAUDE.md`](CLAUDE.md) and [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md), which cover the architecture, persistence model, invariants, and validation status.

<details>
<summary><b>Keyboard and editing reference</b></summary>

| Action | How |
|---|---|
| Text box | Click an empty spot (nothing selected) or press `T` |
| Edit text | Click a selected box again, double-click, or `Enter` |
| Equation-only box | `M` or the toolbar's 수식 button |
| Image | Drag and drop, `⌘V`, `I`, or `/image` (PNG / JPEG / WebP / GIF / SVG) |
| Image resize / crop | Handle drag keeps ratio · `⌥`+drag free · `⇧`+drag crop · double-click to edit the crop |
| Resize text | Corner drag scales the font; the box height follows its content |
| Shapes | `R` rectangle · `O` ellipse · `L` line · `A` arrow (rounded rectangle and adjustable block arrow in the 도형 menu); double-click a shape to type in it |
| Snapping | Automatic. Hold `⌥` to disable, hold `⇧` on the idle canvas to preview guides |
| Align / distribute | 정렬 in the format bar: one object aligns to the slide, several to each other; distribute with 3+ |
| Undo / redo | `⌘Z` / `⌘⇧Z` |
| Copy / paste / duplicate | `⌘C` `⌘V` `⌘X` `⌘D`, arrows nudge (`⇧` = 10 px) |
| Z-order | `⌘]` `⌘[` (with `⇧` = to front/back) |
| Slides | In the slide list: `Enter` new, `⌘D` duplicate, `⌫` delete, drag to reorder, right-click for Title / contents (outline) / Thank-you slides |
| Save / open | `⌘S` / `⌘O` (`⌘⇧S` Save As) |

</details>

<details>
<summary><b>Export details and known limitations</b></summary>

- **PDF** (desktop app): every slide is rendered 1:1 and printed by Chromium to 960×540 pt pages with embedded fonts (selectable text) and vector equations.
- **PPTX:** text becomes editable PowerPoint text boxes (bold/italic/underline/color/bullets/highlight). Shapes, lines, callouts, blocks, todo checkboxes and code blocks become native shapes with editable text, and images keep native crop. Speaker notes are included.
- Equations in PPTX are SVG pictures (with a PNG fallback), not native PowerPoint equations.
- A PPTX line that contains inline equations is split into several positioned text boxes, so heavy editing in PowerPoint can disturb its layout.
- For PowerPoint to show the same font, install the font you used locally (e.g. NanumSquare). The editor and PDF already embed it.
- No rotation, grouping or tables. Crop is rectangular only.
- Fonts with Korean glyphs (including NanumSquare) display `\` as `₩` in normal text. Equations are unaffected.

</details>

### Releases (maintainers)

Pushing a version tag builds the DMG on GitHub Actions ([`release.yml`](.github/workflows/release.yml)) and attaches it to a **draft** GitHub Release; nothing is published automatically.

1. Set `version` in `package.json` (and the lockfile), commit, and push to `main`.
2. Tag and push: `git tag -a v1.1.0 -m "MathSlides v1.1.0" && git push origin v1.1.0`. A suffix such as `v1.1.0-rc.1` creates a prerelease draft.
3. The workflow checks that the tag matches `package.json`, runs typecheck, tests and build, and packages the DMG with an explicit ad-hoc signature (`mac.identity: "-"` in `package.json`; no Apple credentials). [`scripts/verify-macos-release.sh`](scripts/verify-macos-release.sh) then checks the DMG layout, the bundle metadata, a strictly valid code signature, the Gatekeeper assessment of a quarantined copy and a launch smoke test. It generates `SHA256SUMS`, uploads both files to a draft, and re-downloads them to confirm they match. It fails rather than touch an existing release.
4. Before publishing, try the draft on a fresh macOS user account or VM, downloading the DMG in Safari, and walk through the install steps above. You can also run the same checks locally: `scripts/verify-macos-release.sh release/MathSlides-<version>-arm64.dmg <version> release/SHA256SUMS`. Then publish the release manually on GitHub.

## Project status

- **Platform:** macOS on Apple Silicon is the primary, tested platform (current version **1.1.0**). A Windows installer configuration exists but has **not** been validated on a real Windows machine.
- **Distribution:** ad-hoc signed (not Developer-ID signed), un-notarized Apple Silicon DMGs via [GitHub Releases](https://github.com/Kimtona/math-slides/releases), updated manually; the first launch needs a one-time Open Anyway approval. Developer ID signing, notarization and automatic updates are not implemented.
- **Development stage:** in active use for real presentations. Fixes come from that day-to-day use. Planned work is tracked in [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) and [`docs/V2_PLAN.md`](docs/V2_PLAN.md).
