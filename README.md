# MathSlides

> **Write like Notion. Math like Overleaf. Present as slides.**

<p align="center">
  <a href="https://kimtona.github.io/math-slides/">
    <img src="docs/readme/demo-preview.webp" alt="An 18-second silent preview of MathSlides: typing on a slide, a LaTeX equation after /math, a Definition block, section slides generated from an outline, and the theme color changing across the whole deck" width="100%">
  </a>
</p>

<p align="center">
  <a href="https://kimtona.github.io/math-slides/"><b>▶ Watch the full video with music</b></a> (1 min)<br>
  <sub>Music: <i>Cat Walk</i> by Arulo, from <a href="https://mixkit.co/free-stock-music/cat-walk-371/">Mixkit</a> (<a href="https://mixkit.co/license/#musicFree">Mixkit Stock Music Free License</a>). Not part of this repository's license.</sub>
</p>

## Installation

Free · No account · Apple Silicon (M1+) · macOS 13+

**[⬇️ Download the latest MathSlides (.dmg)](https://github.com/Kimtona/math-slides/releases/latest)**

1. **Open** the downloaded `.dmg` and drag **MathSlides** into **Applications**.
2. **Launch** it. If macOS shows a warning, click **Done** (not *Move to Trash*).
3. **Approve** it in **System Settings → Privacy & Security → Open Anyway**.

<p align="center">
  <img src="docs/readme/macos-open-anyway.png" alt="macOS System Settings, Privacy &amp; Security: the message that MathSlides.app was blocked, with the Open Anyway button (그래도 열기) on the right" width="560">
</p>

- The warning appears because the app is ad-hoc signed, not notarized. It is a one-time approval per installed version.
- The screenshot is from macOS 26 in Korean; wording differs by version and language (**Done** = 완료, **Open Anyway** = 그래도 열기).
- Standard (non-admin) users are asked for an administrator password when copying to Applications.
- There is no auto-updater. To update, install the newest `.dmg` over the old app (**Replace**). Your files, autosave and preferences are kept.

<details>
<summary>Troubleshooting</summary>

- **No "Open Anyway" button:** try opening the app once more, then check Privacy & Security again. Managed Macs may block it.
- **"MathSlides is damaged":** use version 1.1.0 or newer (earlier builds had an invalid signature), then verify the download and the installed app. Both commands only read information:

  ```bash
  shasum -a 256 -c SHA256SUMS   # in the folder with the DMG and SHA256SUMS from the release
  codesign --verify --deep --strict --verbose=2 /Applications/MathSlides.app
  ```

  If a check fails, [open an issue](https://github.com/Kimtona/math-slides/issues) with your macOS version and the output.

</details>

## Features

A local 16:9 slide editor with no account. The app's menus are in Korean; slash commands, LaTeX and shortcuts are language-independent.

| Area | What you get |
|---|---|
| **Text** | `#` `##` `###` `####` set sizes 80 / 50 / 30 / 25; bold, italic, underline, strike, colors, 6 highlights, inline code, links (`⌘K` or a typed URL), bullet / numbered lists (`Tab` / `⇧Tab` to indent), `\| ` quote, `---` divider |
| **Font size** | Per paragraph, and per word or selection |
| **Math** | Inline and block LaTeX (MathJax, vector everywhere), symbol palette, favorites |
| **Blocks** | Callout (any emoji icon), Beamer-style Block (Block, Theorem, Definition, Lemma, Proposition, Example, Remark), Todo checklist, code block (Plain Text / Python / C / Bash) |
| **Images** | Insert, drag-and-drop or paste; crop, corner radius, optional caption |
| **Tables** | Editable cells with inline formatting, optional caption |
| **Shapes** | Rectangle, rounded rectangle, ellipse, line, arrow, block arrow (double-click a shape to type in it), emoji with 10 quick emojis and a searchable picker |
| **Layout** | Snap and alignment guides, align / distribute, z-order, duplicate, nudge |
| **Deck** | Right-click a slide in the list to add Title, Contents or Thank-you slides; each numbered Contents entry auto-generates a linked *Part N* slide |
| **References** | Paste an arXiv URL in a slide's bottom-right reference field to get a citation and an auto-built References slide (arXiv only, needs network) |
| **Style** | One theme color for the deck, background color per slide, fonts NanumSquare / Pretendard / Noto Serif KR |
| **Present & export** | Presentation mode, PDF with vector text, editable PPTX with speaker notes ([example PDF](docs/examples/denoising-diffusion-models.pdf)) |
| **Files** | `.mslides` files, autosave and recovery |

### Slash commands

Type `/` in a text box, then keep typing to filter. Commands marked ● only appear when `/` is the first character of a line.

| Command | Inserts |
|---|---|
| `/math` | Block equation |
| `/inline` | Inline equation (also `⌘⇧E` or `$$x^2$$`) |
| `/code` ● | Code block |
| `/callout` ● | Callout |
| `/block` ● | Theorem, Definition and other academic blocks |
| `/image` ● | Image from a file |
| `/table` ● | 3×3 table |
| `/todo` ● | Checklist item |
| `/divider` ● | Horizontal divider (also `---`) |
| `/bullet` | Bulleted list (also `- `) |
| `/number` | Numbered list (also `1. `) |

Extra search words: `/equation` `/latex` `/tex` `/note` `/tip` `/warning` `/theorem` `/definition` `/lemma` `/img` `/photo` `/grid` `/task` `/hr` `/ul` `/ol`.

## Shortcuts & Configuration

| Action | Shortcut |
|---|---|
| New text box · equation · image | `T` · `M` · `I` (or click an empty spot for text) |
| Rectangle · ellipse · line · arrow | `R` · `O` · `L` · `A` |
| Bold · italic · underline · link | `⌘B` · `⌘I` · `⌘U` · `⌘K` |
| Inline equation | `⌘⇧E` |
| Undo · redo | `⌘Z` · `⌘⇧Z` |
| Copy · paste · cut · duplicate | `⌘C` · `⌘V` · `⌘X` · `⌘D` |
| Nudge (×10) | Arrow keys (`⇧`+Arrow) |
| Bring forward · send backward (to front / back) | `⌘]` · `⌘[` (`⇧`) |
| Disable snapping · preview guides | Hold `⌥` while dragging · hold `⇧` on empty canvas |
| Present | `⌘↵` or `F5` |
| Export PDF · PPTX | `⌘P` · `⌘E` |
| Save · save as · open | `⌘S` · `⌘⇧S` · `⌘O` |
| Open config file · apply it | `⌘,` · `⌘⇧,` |

**Configuration.** There is no Settings window. `⌘,` opens `config.txt` (created on first use) in your text editor; edit, save, then press `⌘⇧,` in MathSlides to apply. No restart needed, and only **new** content is affected. If a line is invalid, an error is shown and the last working settings stay active.

```ini
font = NanumSquare
heading-1 = 80
heading-2 = 50
heading-3 = 30
body-size = 25
shape-fill = none
shape-stroke = #000000
shape-stroke-width = 1px
image-radius-preset = 50px
```

One `key = value` per line; plain numbers are px. `font` is NanumSquare, Pretendard or Noto Serif KR; `shape-fill` is `none` or a HEX color. Put `#` comments on their own line, never after a value. Delete a line to restore its default. The file lives at `~/Library/Application Support/math-slides/config.txt`.

## Feedback

- 🐞 **[Report a Bug](https://github.com/Kimtona/math-slides/issues/new?template=bug_report.yml)**
- 💡 **[Suggest an Improvement](https://github.com/Kimtona/math-slides/issues/new?template=improvement.yml)**

<sub>Building from source, tests and releases: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).</sub>
