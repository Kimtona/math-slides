# MathSlides

> **Write like Notion. Math like Overleaf. Present as slides.**

<p align="center">
  <a href="https://kimtona.github.io/math-slides/">
    <img src="docs/readme/demo-preview.webp" alt="An 18-second silent preview of MathSlides: typing on a slide, a LaTeX equation after /math, a Definition block, section slides generated from an outline, and the theme color changing across the whole deck" width="100%">
  </a>
</p>

<p align="center">
  <a href="https://kimtona.github.io/math-slides/"><b>▶ Watch the full video with music</b></a> (1 min)<br>
  <a href="https://github.com/Kimtona/math-slides/issues/new?template=bug_report.yml">🐞 Report a Bug</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/Kimtona/math-slides/issues/new?template=improvement.yml">💡 Suggest an Improvement</a><br>
  <sub>🎵 Music: <i>Cat Walk</i> by Arulo, from <a href="https://mixkit.co/free-stock-music/cat-walk-371/">Mixkit</a> (<a href="https://mixkit.co/license/#musicFree">Mixkit Stock Music Free License</a>). Not part of this repository's license.</sub>
</p>

## 📦 Installation

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

## 📝 Slash Commands

A local 16:9 slide editor, no account needed. App menus are in Korean; slash commands, LaTeX and shortcuts are language-independent.

Type `/` in a text box, then keep typing to filter. Commands marked ● only appear when `/` is the first character of a line.

| Command | Inserts |
|---|---|
| `/math` | Block equation |
| `/inline` | Inline equation (also `⌘⇧E` or `$$x^2$$`) |
| `/code` ● | Code block |
| `/callout` ● | 💡 Callout |
| `/block` ● | Theorem, Definition and other academic blocks |
| `/image` ● | 🖼 Image from a file |
| `/table` ● | 3×3 table |
| `/todo` ● | ☑️ Checklist item |
| `/divider` ● | Horizontal divider (also `---`) |
| `/bullet` | Bulleted list (also `- `) |
| `/number` | Numbered list (also `1. `) |

Extra search words: `/equation` `/latex` `/tex` `/note` `/tip` `/warning` `/theorem` `/definition` `/lemma` `/img` `/photo` `/grid` `/task` `/hr` `/ul` `/ol`.

✨ Beyond slash commands:

- 📝 **Text:** `#` `##` `###` `####` set sizes 80 / 50 / 30 / 25; bold, italic, underline, strike, text colors, 6 highlights, inline code, links (`⌘K` or a typed URL), `Tab` / `⇧Tab` to indent lists, `\| ` for a quote. Font size can also be set per paragraph, word or selection.
- 🧮 **Math:** LaTeX is rendered by MathJax as vectors in the editor, PDF and PPTX; a symbol palette and favorites are built in. Callouts take any emoji icon; code blocks support Plain Text / Python / C / Bash.
- 🖼 **Images and tables:** drag-and-drop or paste images; crop, corner radius, and an optional caption on images and tables.
- 🔷 **Shapes:** rectangle, rounded rectangle, ellipse, line, arrow, block arrow (double-click to type in a shape), plus emoji with 10 quick emojis and a searchable picker.
- 📐 **Layout:** snap and alignment guides, align / distribute, z-order, duplicate, nudge.
- 📑 **Contents slides:** right-click a slide in the list to add Title, Contents or Thank-you slides; each numbered Contents entry auto-generates a linked *Part N* slide.
- 📚 **arXiv references:** paste an arXiv URL in a slide's bottom-right reference field to get a citation and an auto-built References slide (arXiv only, needs network).
- 🎨 **Theme and style:** one theme color for the whole deck, a background color per slide, and fonts NanumSquare / Pretendard / Noto Serif KR.
- 🎤 **Present and export:** presentation mode, PDF with vector text, editable PPTX with speaker notes ([example PDF](docs/examples/denoising-diffusion-models.pdf)).
- 💾 **Files:** `.mslides` documents, autosave and recovery.

## ⌨️ Shortcuts

<details>
<summary>Keyboard Shortcuts</summary>

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

</details>

## 🔧 Configuration

MathSlides has no Settings window. A small text file, `config.txt`, sets the defaults for **new** content.

1. Press **`⌘,`** to open `config.txt` in your text editor (created on first use).
2. Edit a value and save.
3. Back in MathSlides, press **`⌘⇧,`** to apply it. No restart needed.

Existing content keeps its look. If a line is invalid, an error is shown and the last working settings stay active.

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

<sub>Building from source, tests and releases: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).</sub>
