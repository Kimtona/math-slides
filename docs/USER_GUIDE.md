# MathSlides user guide

Feature details, slash commands, shortcuts and configuration (moved from the README; content unchanged).

## ✨ Features

A local 16:9 slide editor, no account needed. App menus are in Korean; slash commands, LaTeX and shortcuts are language-independent.

<table>
<tr>
<td width="50%" valign="top"><img src="readme/showcase-equations.png" alt="Slide 'The forward process' with a Definition block, a Remark block, two display equations and a callout"><br><b>🧮 LaTeX &amp; Structured Blocks</b><br>Live vector equations plus Theorem, Definition and callout blocks.</td>
<td width="50%" valign="top"><img src="readme/structure-sections.png" alt="An Outline slide with three numbered sections; the slide list shows the generated 'Part 1', 'Part 2' and 'Part 3' section slides"><br><b>📑 Automatic Contents &amp; Section Slides</b><br>Write the outline once; linked <i>Part N</i> slides are generated for you.</td>
</tr>
<tr>
<td width="50%" valign="top"><img src="readme/citation-footer.png" alt="Slide footer before and after: a pasted arXiv URL becomes the short citation 'Deep Unsupervised Learning using Nonequilibrium Thermodynamics, Sohl-Dickstein et al., 2015'"><br><b>📚 arXiv Citations</b><br>Paste an arXiv URL in the footer for a citation and an auto-built References slide.</td>
<td width="50%" valign="top"><img src="readme/theme-colors.png" alt="The Theme color palette with theme colors, standard colors, saved My Colors, and a custom HEX field, over a deck themed navy"><br><b>🎨 Themes &amp; Colors</b><br>Pick one theme color for the whole deck from presets, saved My Colors, or any HEX value.</td>
</tr>
</table>

> ⚙️ **Make MathSlides yours.**
>
> Customize heading sizes (`#`–`####`), fonts, and other defaults. Apply changes instantly—no restart needed.
>
> `⌘,` → Edit & save → `⌘ + Shift + ,`

<details>
<summary>🔍 More features</summary>

- 📝 **Text:** `#` `##` `###` `####` set sizes 80 / 50 / 30 / 25; bold, italic, underline, strike, text colors, 6 highlights, inline code, links (`⌘K` or a typed URL), `Tab` / `Shift + Tab` to indent lists, `\| ` for a quote. Font size can also be set per paragraph, word or selection.
- 🖼 **Images and tables:** drag-and-drop or paste images; crop, corner radius, and an optional caption on images and tables. Code blocks support Plain Text / Python / C / Bash.
- 🔷 **Shapes:** rectangle, rounded rectangle, ellipse, line, arrow, block arrow (double-click to type in a shape), plus emoji with 10 quick emojis and a searchable picker.
- 📐 **Layout:** alignment guides and snap, align / distribute, z-order, duplicate, nudge. Math has a symbol palette and favorites, and you can color individual symbols of an equation (drag over them, or Shift+← / → from the caret next to it, then use the Text Color palette).
- 🎨 **Style:** a background color per slide; fonts NanumSquare / Pretendard / Noto Serif KR.
- 🎤 **Present and export:** presentation mode, PDF with vector text, editable PPTX with speaker notes ([example PDF](examples/denoising-diffusion-models.pdf)).
- 💾 **Files:** `.mslides` documents, autosave and recovery. Right-click a slide in the list to add Title, Contents or Thank-you slides.

</details>

## 📝 Slash Commands

Type `/` in a text box, then keep typing to filter. Commands marked ● only appear when `/` is the first character of a line.

| Command | Inserts |
|---|---|
| `/math` | Block equation |
| `/inline` | Inline equation (also `⌘ + Shift + E` or `$$x^2$$`) |
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

## ⌨️ Shortcuts

<details>
<summary>Keyboard Shortcuts</summary>

| Action | Shortcut |
|---|---|
| New text box · equation · image | `T` · `M` · `I` (or click an empty spot for text) |
| Rectangle · ellipse · line · arrow | `R` · `O` · `L` · `A` |
| Bold · italic · underline · link | `⌘B` · `⌘I` · `⌘U` · `⌘K` |
| Inline equation | `⌘ + Shift + E` |
| Undo · redo | `⌘Z` · `⌘ + Shift + Z` |
| Copy · paste · cut · duplicate | `⌘C` · `⌘V` · `⌘X` · `⌘D` |
| Nudge (×10) | Arrow keys (`Shift + Arrow`) |
| Bring forward · send backward (to front / back) | `⌘]` · `⌘[` (add `Shift` for front / back) |
| Quick Draw: red highlight box (over anything; `Esc` cancels) | Hold `⌥ + Shift` and drag |
| Disable snapping · preview guides | Hold `⌥` while dragging · hold `Shift` on empty canvas |
| Present | `⌘↵` or `F5` |
| Export PDF · PPTX | `⌘P` · `⌘E` |
| Save · save as · open | `⌘S` · `⌘ + Shift + S` · `⌘O` |
| Open config file · apply it | `⌘,` · `⌘ + Shift + ,` |

</details>

## 🔧 Configuration

Press **`⌘,`** to make MathSlides yours: set the font sizes for `#`, `##`, `###` and `####`, pick the default font, and tune the default look of shapes and images.

1. **`⌘,`** opens `config.txt` in your text editor.
2. Change a value and save.
3. **`⌘ + Shift + ,`** in MathSlides applies it, with no restart.

```ini
# Font
font = NanumSquare

# Text sizes: #, ##, ###, ####
heading-1 = 80
heading-2 = 50
heading-3 = 30
body-size = 25

# Shapes and images
shape-fill = none
shape-stroke = #000000
shape-stroke-width = 1px
image-radius-preset = 50px
```

`font` can be NanumSquare, Pretendard or Noto Serif KR. Changes apply to new content only, and a mistake in the file is reported while your last working settings stay active.

<sub>Building from source, tests and releases: [docs/DEVELOPMENT.md](DEVELOPMENT.md).</sub>

