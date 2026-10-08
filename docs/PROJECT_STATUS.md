# MathSlides Project Status

## Current stable checkpoint

`c9a50d3 "Keep current slide valid after reconciliation"` — the MathSlides **v1 candidate** (code checkpoint; the later `Update project status for v1` commit only changes this document; check `git log`).

Since the previously documented checkpoint (`7871abf "Move math palette button to the left of the equation footer"`) the commits are:

- `68190fb` Make slash command menu scrollable
- `66f4b3e` Use compact author format for References
- `ba8955e` Generalize References slide handling
- `d814b23` Split overflowing References across slides
- `101542d` Fix Math Palette filename collision on macOS
- `c9a50d3` Keep current slide valid after reconciliation

The persistence/lifecycle architecture below is unchanged since `3e74a25 "Redesign autosave recovery"`, whose recovery UX was manually tested in the installed macOS app (launch; no "Previous Presentations" list in the ∑ menu; unsaved edit + New Presentation creates recovery state; "직전 작업 복구" restores the displaced presentation with the edit preserved).

### Validation status of the v1 candidate

- **macOS (real MacBook):** testing there found the Math Palette filename collision (fixed, `101542d`). After the fix `npm run app` builds and launches; the editor starts fast and feels responsive; References split correctly into `References` / `References (cont.)`, stay within the slide bounds, and collapse again when citations are removed.
- **Current-slide invariant fix (`c9a50d3`):** `npm run typecheck`, `npm run build` and `node tests/current-slide.mjs` passed.
- **References work (`66f4b3e`–`d814b23`):** its focused Stage 1/2/3 checks (in `tests/rich-text.mjs`) and typecheck/build passed during development.
- **Full Electron GUI suite (`tests/rich-text.mjs`): NOT confirmed complete on the final tree.** It was not repeatedly rerun on the busy shared Ubuntu machine because of observed environmental/timing flakiness; the failures seen were unrelated to the features above. Do not claim a full green run until it has actually been observed (e.g. under Xvfb on an idle machine).
- The packaged-app (`dist:mac`) build was not redone for this candidate; `/Applications/MathSlides.app` was not replaced.

## Current product state

MathSlides is an Electron desktop app (React + TipTap + MathJax SVG) for academic slide decks, with a WYSIWYG semantic editor, an editable `.mslides` document format, PDF export, editable PPTX export, presentation mode, thumbnails, autosave, undo/redo and slash commands (`/math`, `/code`, `/callout`, `/block`, `/todo`, `/image`, ...).

Implemented editor features: Code Block, Callout, Academic Blocks, Todo, Image + optional caption, editable text inside shapes, alignment guides (incl. Shift preview), presentation-wide Theme Color, Title Slide insertion, TOC slide, Thank You slide, PowerPoint-style color controls where appropriate, presentation font selection. Shapes: Rectangle, Rounded Rectangle, Ellipse, Line/Arrow and an adjustable Block Arrow (`두꺼운 화살표`: `ShapeElement.shape: 'blockArrow'` with optional `shaft`/`head` ratios; geometry in `src/model/blockArrow.ts`, two canvas adjustment handles, exported to PPTX as a freeform). Text boxes (incl. equation/code content) and images have a box background (full shared palette, 없음) and an optional instance border (`borderColor?`, one 2px solid line, drawn as an outline centered on the bounds; native rectangle in PPTX). Shapes keep their own stroke. Callout icons: the quick row plus a `⋯` button that opens a full searchable emoji picker (`src/editor/EmojiPicker.tsx`, data from `emojibase-data` en/compact, lazy-loaded chunk, standard Unicode groups); the picked Unicode string goes through the same `icon` attribute and history step as the quick icons — no schema change. Equation editing: the popover keeps direct LaTeX typing as the primary workflow and has an optional, hidden-by-default `Ω` button at the left of its footer (before the hint text; `Done ↵` stays alone on the right) that opens the compact Math Palette (`src/editor/MathPalette.tsx`, data + pure insertion logic `applyMathItem` in `src/editor/mathPaletteItems.ts` — named so it never differs from `MathPalette.tsx` only by case, which broke macOS builds, wired in `MathPopover.tsx`). Categories 자주 사용 / 그리스 / 연산 / 스타일 / 구조; cells show the symbol rendered through the existing `renderTex` MathJax path (LaTeX only as hover hint). Insertion is cursor-aware and keeps focus in the textarea: symbols replace the selection / insert at the caret (a bare control word gets a trailing space only if it would fuse with a following letter or ends the text); wrapper templates (`\mathbf{}`, `\mathbb{}`, `\mathcal{}`, `\hat{}`, `\bar{}`, `\text{}`, `\boxed{}`, `\sqrt{}`, norm, fraction) wrap a selection, otherwise put the caret inside the first braces (fraction with a selection: selection becomes the numerator, caret in the denominator); sum/integral/cases/matrix replace the selection and place the caret in the first slot. Escape or an outside click inside the popover closes only the palette; Enter/Shift+Enter/Escape on the equation behave as before. No schema change. Not implemented: `\` command autocomplete, search, history, custom palettes.

**Slash menu** (`src/editor/SlashMenu.tsx`): the command list scrolls (max height 340 px, never taller than the room on its side of the caret) and flips above the caret when there is little room below; ArrowUp/Down keep the active command in view (only keyboard moves scroll the list, hover does not).

**References** are generated, system-managed slides (`kind: 'references'`) built from slide citations by `reconcileStructure` (`src/model/structure.ts`). Entry text is derived from the structured citation metadata (`displayCitation` in `src/citations/format.ts`) in a compact form: 1 author `Vaswani, A. (2017)`, 2 authors `Vaswani, A., & Shazeer, N. (2017)`, 3+ `Vaswani, A. et al. (2017)`, then `Title. arXiv:ID.`; a stored `fullCitation` is only a fallback when metadata is missing. Entries are alphabetical and deduplicated by citation id. **Pagination:** an overflowing bibliography is split greedily across consecutive slides titled `References` and `References (cont.)`, using a deterministic text-only height estimate (`src/model/referencesLayout.ts`: no DOM/font measurement, deliberately slightly pessimistic; never produces empty pages; tune constants there). Page n has the deterministic id `references` (n=1) or `references-n`; an older single References slide with any id stands in for page 1. When pages shrink, a generated slide holding only managed text is removed, but one that also has user-added content survives with its list emptied (and is reused if pages grow again); the slide is deleted automatically only when its citations go, and `deleteSlide` refuses to delete a References slide that still holds references. New slides are inserted before the trailing References / Thank You slides. References are ordinary slides with ordinary text elements (roles `references-title` / `references-list`), so editor, thumbnails, presentation mode, PDF and PPTX share one model and render path — no References-specific renderer or exporter.

**Store invariant:** after any `commit` / `live` mutation (including structure reconciliation) `currentSlideId` refers to an existing slide (`keepCurrentValid` in `src/store/store.ts`). If the current slide survives it is left untouched; if it was removed (e.g. a `references-3` page collapses) the slide now at its old index (clamped) becomes current and the selection is cleared — the same rule as undo/redo/`deleteSlide`. Undo/redo use the same `validCurrent` helper via `fixup`.

See `README.md` for usage; source layout: `src/{canvas,editor,export,model,render,store,ui}`, `electron/`, tests in `tests/` (`rich-text.mjs` Electron GUI suite; `current-slide.mjs` headless store test).

## Desktop document lifecycle

**Explicit documents.** `.mslides` files are user-managed: Open, Save, Save As, Finder, double-click. Autosave never overwrites them; Save / Cmd+S writes the file; Save As creates an independent logical document with a new `Deck.id`.

**Startup.** Reopening MathSlides restores the working state from internal autosave. A restart alone creates no new presentation and no recovery entry.

**Finder integration (macOS).**
- extension `.mslides`, UTI `com.mathslides.presentation`, conforming to `public.data` (NOT `public.json`)
- double-click opens in MathSlides; an already-running instance receives open-file requests
- the opened file becomes the current file association; later Save writes to it

The `public.data` relationship is important. Do NOT change it back to `public.json`: that made macOS Quick Look / Finder show raw JSON text thumbnails.

## Document icon

Complete and verified in Finder: landscape ~16:9 light blue-gray card, centered blue (`#2F6FEB`) MathSlides ∑, no text, no folded corner. Generated by `build/icons/make-doc-icon.cjs` (master PNG + `.icns` + `.ico`). Some existing files may show an older cached icon until Finder refreshes them. Do not touch the UTI/document-type setup to work around Finder's per-file icon cache.

## Persistence / recovery architecture

All in IndexedDB (idb-keyval), implemented in `src/store/persistence.ts`.

- **`deck:v1`** — current working-presentation autosave. Updated by a 500 ms debounce while editing, on `pagehide`, and around lifecycle transitions. Restored at startup with the same `Deck.id`. Never overwrites explicit `.mslides`.
- **`recovery:v1`** — bounded displaced-work recovery. When New Presentation / Open / Finder-open replaces meaningful (non-pristine) work, that deck is first stored here: max 3 entries, newest first, one per `Deck.id`. The ∑ menu shows only `직전 작업 복구` while entries exist; it swaps the newest entry with the current work (both decks sit in the stack until the swap completes, so a crash cannot lose either). This is deliberately NOT a history browser.
- **`file:v1`** — current explicit `.mslides` association (file handle or native path + `Deck.id`). Holds no presentation content.
- **`archive:v1`** — LEGACY ONLY. The old unbounded "Previous Presentations" storage. No longer written, shown, or used for recovery, and intentionally NOT deleted. Entries may be the only copy of work never saved as `.mslides`. Do not casually delete, clear, migrate or garbage-collect it; any cleanup needs a separate explicitly approved migration (a safe design: export meaningful entries to `.mslides` first). Assets referenced only by legacy archive entries are protected from asset GC while it is retained — keep it that way.

Abnormal-exit detection does not exist (no reliable signal in the current architecture); crashes restore silently from `deck:v1`, losing at most the last ~500 ms of edits.

User-visible: `.mslides` → Open / Save / Save As / Finder. Internal: `deck:v1`, `recovery:v1`, `file:v1`, and preserved legacy `archive:v1`. Users should not need to understand internal storage; recovery prevents data loss and is not a document manager.

## Important invariants

Preserve unless a task explicitly redesigns them.

- `.mslides` stays the document extension; UTI stays `com.mathslides.presentation`, conforming to `public.data`.
- Finder double-click opening keeps working.
- Save is explicit; autosave never overwrites `.mslides`; Save As makes an independent document.
- Restart restores the current working state.
- New/Open/Finder-open never silently destroy meaningful displaced work.
- `recovery:v1` stays bounded; internal autosave history never reappears as a document list.
- Legacy `archive:v1` is not destructively removed without an explicit migration.
- Persistence tests use isolated temporary profiles and never touch the user's real data or existing `.mslides` files.
- Do not replace `/Applications/MathSlides.app` unless explicitly requested.
- Tracked file names must not differ only by case (macOS is case-insensitive); the same applies to import paths.
- `currentSlideId` always refers to an existing slide after any committed deck mutation (see Store invariant).
- Generated References slides keep deterministic ids and are not special-cased in rendering/export.

## Packaging / distribution state

Electron + electron-builder.

- macOS: `npm run app` builds and launches from source (validated on a real MacBook); packaged `.app` and `.dmg` build (`npm run dist:mac`, output in git-ignored `release/`), installable as `/Applications/MathSlides.app`; app icon, `.mslides` document icon and Finder association work; lifecycle/recovery UX manually validated in the packaged app.
- Windows: NSIS configuration exists but has NOT been validated on a real Windows install.
- Releases: `.github/workflows/release.yml` runs on `vX.Y.Z` / `vX.Y.Z-suffix` tags (must equal `package.json` version). On a macOS runner it runs `npm ci`, typecheck, the full `npm test`, build, then `electron-builder --mac dmg --arm64 --publish never`, and creates a **draft** GitHub Release (prerelease if the tag has a suffix) with `MathSlides-<version>-arm64.dmg`. It uses only the built-in `GITHUB_TOKEN` (`contents: write`), fails if a release for the tag exists, and never moves tags. Publishing is manual. Users download the DMG and update by replacing the app; user data (IndexedDB in userData `math-slides`, `.mslides` files) lives outside the bundle and survives replacement, provided `package.json` `name` and `appId` stay unchanged.
- The app is ad-hoc signed only (no Developer ID, `spctl` rejects it); first launch needs System Settings → Privacy & Security → Open Anyway (README documents this and the `xattr -dr com.apple.quarantine` fallback). Minimum macOS 13.0, arm64 only.
- Not implemented: Developer ID signing, notarization, auto-update. Do not add unless requested.

## Development environment

The Ubuntu development machine is validated for normal development: Node v22.23.2, npm 10.9.8, Electron 44.5.1; `npm run typecheck` and `npm run build` pass. The GUI suite (`tests/rich-text.mjs`) passed in earlier sessions but is timing-sensitive on this busy shared machine and has not been confirmed complete on the v1 candidate (see Validation status). `npm test` runs `tests/current-slide.mjs` (headless, no display needed) and then the GUI suite. The GUI suite launches real Electron windows, so on this shared Ubuntu machine run it under Xvfb, not on the live desktop:

`xvfb-run -a -s "-screen 0 1920x1080x24" npm test`

The test harness already uses an isolated temporary `userData` profile and its own debug port. macOS-specific packaging, `/Applications/MathSlides.app` replacement and final macOS verification stay on the Mac.

## Current development phase: dogfooding

The user keeps the packaged MathSlides pinned in the Dock and uses it for real work. Prefer fixing concrete issues found in real use over speculative redesigns. For a reported UX issue: reproduce/inspect the path, make the smallest coherent fix, preserve lifecycle/document behavior, test, and create a focused checkpoint.

## Further work candidates (not committed requirements)

1. ~~Presentation font selection~~ — DONE: exactly NanumSquare (default), Pretendard, Noto Serif KR, bundled in `src/fonts/` (OFL licenses alongside). `Deck.fontFamily` (absent = NanumSquare) drives the slide `--slide-font`; the top-bar 글꼴 control is an explicit "apply to all text" that also clears every per-range font (`textStyle.fontFamily` mark); the font control in the text toolbar changes only the selected range. Math and inline-code typography stay separate. No weights beyond 400/700 for the new fonts.
2. **Notion / Markdown / Google Docs → MathSlides import** — map `#`/`##`/`###`, paragraphs, callouts, code, todo, images to the Deck model; one-way import first; needs a design pass.
3. **Finder first-slide thumbnails** — needs a macOS Quick Look Thumbnail Extension; preferably the renderer produces the preview and the native extension only reads it (avoid a Swift re-implementation of the renderer). May motivate evolving `.mslides` into a package (`presentation.json`, `preview.png`, `assets/`). Needs an architecture pass.
4. **Windows validation** — NSIS installer, association, icon, double-click, Open/Save/Save As, restart restoration, recovery.
5. **Legacy archive cleanup** — low priority; see `archive:v1` above; design a safe export/migration first.
6. **Dev vs packaged storage separation** — dev and packaged builds may share the same userData; changing it needs migration planning.

## Preferred feature workflow

1. Start from a clean checkpoint.
2. Inspect only relevant code; for lifecycle/data-safety work, explain existing behavior before changing it.
3. Reuse existing architecture; avoid unrelated refactoring; implement one focused feature.
4. Run TypeScript checking, the production build and `npm test`; add focused tests (temporary isolated Electron profiles for persistence).
5. Create ONE focused local commit; do not push.
6. For significant UX changes, package/install and validate manually when requested; create the remote checkpoint only after approval.
