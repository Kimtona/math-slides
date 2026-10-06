# MathSlides v2 Plan: Personalization

Handoff for the next development session. **Planning only: nothing here is implemented.** Read `CLAUDE.md` and `docs/PROJECT_STATUS.md` first; this document builds on them.

Baseline: tag `v1.0.0` (`5256656 "Update project status for v1"`). v1 is frozen; do not move or recreate the tag.

## 1. Direction

v1 established a compact presentation-editor foundation. v2 is **not** "PowerPoint with a big settings surface". The product principle stays:

> compact, direct-manipulation presentation editing with minimal UI.

v2 adds a **personalization layer** so MathSlides gradually adapts to one user's presentation style, without growing a large formatting/settings UI. Prefer fewer, smaller, well-placed controls over panels.

## 2. The three layers

Conceptually separate, even if they eventually share persistence infrastructure.

| Layer | Question it answers | Nature |
|---|---|---|
| **Preferences** | "What should MathSlides use by default?" | Global defaults for *newly created* content / editor behavior |
| **Favorites / My Library** | "What things do I want immediately available?" | Personal selections surfaced in existing pickers |
| **Templates / building blocks** | "What combinations or structures do I want to reuse?" | Reusable composed content (slides, styled groups) |

### 2.1 Preferences: global defaults
Persistent user-level defaults. Candidates: default presentation font, default text styling where appropriate, default shape fill/border, default Callout appearance, other compact editor preferences.

Rules:
- Preferences define **defaults for new things**. They never silently rewrite existing slide content or existing decks.
- Opening a v1 deck must look exactly as it did, regardless of the user's preferences.
- The UI stays small and intentional.

### 2.2 Favorites / My Library: reusable personal choices
Let the user shape the highest-value slots of the pickers MathSlides already has. Candidates: `My Colors`, favorite fonts, favorite Callout emojis, favorite Math Palette items, recently used items where useful, reusable visual assets.

Rules:
- Keep the compact picker UX; curated sets stay stable (Theme Colors, Standard Colors, the Math Palette categories, the Callout quick row).
- A favorites area is *added next to* the curated sets (e.g. a small `My Colors` row, a small favorites section in the Math Palette, preferred emojis taking the fastest-access Callout slots); it does not replace them.
- No heavy management UI unless clearly necessary (prefer "add/remove from the place you use it").
- A favorite is a *reference to a choice*, not a style that follows later: using one inserts the plain value, as today.

### 2.3 Templates / reusable building blocks
Reuse of combinations and structures rather than single values. Candidates: custom slide templates, reusable layouts, reusable styled text/shape/callout combinations, personal asset folders, user-defined presentation presets.

Rules:
- Lightweight. **No** template marketplace, **no** PowerPoint-style slide-master system unless future requirements clearly justify it.
- Instantiating a template produces ordinary slides/elements (no live link back to the template), so existing editing, export and structural reconciliation keep working unchanged.

## 3. v1 architecture relevant to v2 (inspected, no changes made)

### 3.1 Persistence: there is no user-scoped data yet
- All persistence is IndexedDB via `idb-keyval` in `src/store/persistence.ts`. Keys: `deck:v1` (working autosave), `recovery:v1` (bounded displaced work), `file:v1` (explicit `.mslides` association), `asset:<id>` (image assets), legacy `archive:v1`, and `deck:unreadable:<ts>` (unreadable autosave kept, never discarded).
- Everything stored today is **deck-scoped** or document-lifecycle state. There is no settings/preferences store and `localStorage` is not used. Preferences/favorites/templates would be the first **user-scoped** data and need their own key namespace (e.g. a separate versioned key per concern; names to be decided). They must not live inside `Deck`.
- The `.mslides` file is `{ format: 'mathslides', version: 1, deck, assets }` and `Deck.version` is `1`. Optional `Deck` fields (`fontFamily`, `themeColor`, `citations`, ...) are how v1 has grown backwards-compatibly: absent = old behavior.
- **Asset GC hazard:** a session-once garbage collector deletes every `asset:*` key not referenced by the current deck, undo history, recovery entries or legacy archive. A "personal assets" library that reuses the `asset:` namespace would be deleted. Library assets need a separate namespace or an explicit GC-protection rule (the same care v1 applies to the legacy archive).
- Autosave debounce / `pagehide` / lifecycle transitions persist the *deck*. User-scoped stores should save independently and must not touch deck autosave or recovery timing.

### 3.2 Existing extension points
| Area | Where | Notes for v2 |
|---|---|---|
| Color palettes | `src/model/colors.ts` (`PRESET_COLORS`, `THEME_COLORS`, `STANDARD_COLORS`, `HIGHLIGHT_COLORS`, `parseHex`), `src/ui/TextColorPalette.tsx`, `ColorButton` in `src/ui/controls.tsx` | `THEME_COLORS` is already commented "static for now: a future deck theme can supply columns with this same shape". A `My Colors` row is a natural addition to the shared palette UI; custom colors already flow through `Other Colors...` + `parseHex`. |
| Fonts | `src/model/fonts.ts` (`SLIDE_FONTS`, `DEFAULT_FONT`, `deckFont`, `fontStack`), `Deck.fontFamily`, per-range `textStyle.fontFamily` mark | Exactly 3 bundled fonts (NanumSquare default, Pretendard, Noto Serif KR). "Preferred default font" is only the *initial value for new decks*; `Deck.fontFamily` stays authoritative, and absent still means NanumSquare for old files. Favorite fonts is meaningless with 3 fonts unless more fonts are added (a separate decision). |
| Math Palette | `src/editor/mathPaletteItems.ts` (`MATH_CATEGORIES`, `applyMathItem`), `src/editor/MathPalette.tsx` | Category list is static data; a favorites category would be additive and reuse `applyMathItem` unchanged. |
| Callout icons | `CALLOUT_ICONS` / `DEFAULT_CALLOUT_ICON` in `src/editor/extensions.ts`, `src/editor/EmojiPicker.tsx` | Quick row is a fixed 10-emoji list; full picker already exists. Icon is stored per callout as an attribute, so preferences only affect new callouts. |
| Element / shape defaults | `src/model/defaults.ts` (`newText`, `newShape` fill = `HIGHLIGHT_COLORS[0]`, `newLine`, `DEFAULT_TEXT_COLOR`), `src/model/typography.ts` | Defaults are currently hardcoded constants in the factory functions: the obvious place for preferences to be read. Needs a decision on how a user-scoped preference reaches a pure model factory (parameter vs. module-level lookup) without making factories impure/untestable. |
| Slide creation | `newContentSlide`, `newTitleSlide`, `newTocSlide`, `newSubtitleSlide`, `newThanksSlide`, `addSlide` in `src/store/store.ts` | Template instantiation would go through `addSlide(afterId, slide)`, which already accepts a prebuilt slide and inserts it before trailing References/Thank You slides. |
| Theme | `src/model/theme.ts`, `Deck.themeColor` | Theme decorations are derived at render/export, never stored as elements. A "default theme color for new decks" is a preference; per-deck value remains in the deck. |
| Structural slides | `src/model/structure.ts` (`reconcileStructure`, `MANAGED_ROLES`), `src/model/referencesLayout.ts` | Slides of `kind` title/toc/subtitle/references/thanks are system-managed. Templates must not be able to create a second copy of a managed slide (see `plainSlideCopy`, which already demotes copies to ordinary slides). |
| Export | `src/export/pptx.ts`, `src/export/PrintRoot.tsx`, `src/export/run.ts`, `src/render/ElementView.tsx` | Everything exports from the same deck model. Personalization that only produces ordinary elements needs no exporter work; anything that adds a *new element type or render path* must be implemented in editor, thumbnails, presenter, PDF and PPTX together. |

## 4. v1 invariants v2 must preserve

From `PROJECT_STATUS.md` and v1 development:

- **Compact UI philosophy:** no large settings/formatting panels.
- **`.mslides` behavior:** extension and UTI `com.mathslides.presentation` (conforming to `public.data`, not `public.json`) unchanged; explicit Save only; autosave never overwrites `.mslides`; Save As is an independent document. **Do not change the file format without a concrete reason.** Prefer additive optional `Deck` fields and no `version` bump; v1 files must open unchanged and v1-era files should keep opening in v2.
- **Autosave / recovery semantics:** `deck:v1`, bounded `recovery:v1`, `file:v1` unchanged; restart restores working state; recovery is not a document manager; New/Open/Finder-open never silently destroy meaningful displaced work.
- **Archive protection:** legacy `archive:v1` is never casually deleted/migrated; assets it references stay GC-protected.
- **Deterministic structural behavior:** `reconcileStructure` (Sub-title, References pagination with ids `references`, `references-2`, ...) stays deterministic and idempotent; no measurement-driven feedback loops.
- **Editor / thumbnail / presentation / PDF / PPTX consistency:** one model, one render path per element.
- **Cross-platform:** macOS and Windows (Windows is still unvalidated); no OS-specific behavior in shared code.
- **No case-only filename collisions:** tracked paths (and import paths) must never differ only by case (v1 broke macOS builds this way: `MathPalette.tsx` vs `mathPalette.ts`, now `mathPaletteItems.ts`).
- **`currentSlideId` validity:** after any committed mutation `currentSlideId` refers to an existing slide (`keepCurrentValid` / `validCurrent` in `src/store/store.ts`, covered by `tests/current-slide.mjs`). Template instantiation and any new slide-producing path must go through `commit`/`addSlide`.
- **Safety rules:** tests use isolated temporary profiles and never touch real user data; do not replace `/Applications/MathSlides.app` unless asked; one focused commit per feature; no push without request.

## 5. Suggested phases (incremental; each phase is independently shippable)

Ordering is a recommendation after inspecting v1, not a commitment. Preferences first because it creates the user-scoped store that the later layers need; Favorites next because it is the smallest visible win on top of it; Templates last because it is the largest design surface and benefits from lessons learned.

### Phase A: Preferences foundation
- **Goal:** a user-scoped, versioned preferences store that new-content factories can read, with no effect on existing decks.
- **Likely first small feature:** *default presentation font for new decks* (reads at `initialDeck`/New Presentation; writes `Deck.fontFamily` only when it differs from the default). Smallest surface: one value, one existing field, no schema change.
- **Dependencies:** a decision on where preferences live (own IndexedDB key vs. alternatives, see §6) and how factories obtain them.
- **Risks / invariants:** must not alter opened/restored decks; must not interact with deck autosave/recovery; corrupt or missing preferences must silently fall back to v1 defaults; must not be read in a way that makes model factories non-deterministic in tests.
- **Do NOT build yet:** a settings window with many sections; per-element-type style presets; syncing across machines; import/export of preferences; "apply to all existing slides" (that is a separate, explicit action the user already has for fonts).

### Phase B: Favorites / My Library
- **Goal:** let the user's own choices occupy the fastest slots of existing pickers.
- **Likely first small feature:** `My Colors`, a short row in the shared color palette fed from user-scoped storage, seeded when the user picks `Other Colors...` (explicit "keep this color"). Colors are plain `#rrggbb` values, validated by the existing `parseHex`.
- **Dependencies:** Phase A's user-scoped store (or its storage helper); the palette component being shared by the text color, highlight, shape fill and border pickers.
- **Risks / invariants:** deck content still stores plain color values (a favorite never becomes a reference that breaks when removed); curated sets unchanged; must work identically in editor and exports (it will, since only the choice UI changes); bounded size.
- **Do NOT build yet:** drag-and-drop favorites management, folders, naming/tagging, cloud sync, favorites for fonts (only 3 fonts), Math Palette/emoji favorites before the color pattern proves out, personal image assets (see GC hazard).

### Phase C: Templates / reusable building blocks
- **Goal:** reuse a composed slide or styled element group without rebuilding it.
- **Likely first small feature:** "save current slide as a template" and "new slide from template" for *ordinary content slides only*, instantiated through `addSlide` with fresh ids (as `duplicateSlide` already regenerates element ids).
- **Dependencies:** user-scoped storage with its own versioning; decisions on how template images are stored (assets), and how a template slide relates to deck `themeColor`/`fontFamily`.
- **Risks / invariants:** instantiated content must be ordinary slides/elements with new ids; templates must never produce managed slides (`title`/`toc`/`subtitle`/`references`/`thanks`) or managed roles; theme decorations stay derived, not stored; templates that reference images must keep asset GC safe; v1 decks unaffected.
- **Do NOT build yet:** a master-slide/layout inheritance system, live template-to-slide linking, a template marketplace or sharing format, per-user template folders/management UI, presentation presets (consider after slide templates prove useful).

## 6. Open design questions (investigate before implementing)

1. **Where do user-scoped settings live?** A separate IndexedDB key (consistent with v1; note `PROJECT_STATUS.md` records that dev and packaged builds may share the same userData, so user-scoped data could be shared between them — see "Dev vs packaged storage separation") vs. a file in Electron's `userData` via the main process. What survives reinstall and what is shared between dev and packaged builds?
2. **Versioning/migration of user-scoped data:** key naming (`prefs:v1`-style, one key vs several), how unknown future fields are handled, and what happens when a newer app wrote data an older app reads.
3. **Deck-scoped vs user-scoped boundary:** which choices belong in the deck (so the file reproduces on another machine) and which only in preferences? Rule of thumb to confirm: anything that affects how an existing deck *renders* is deck-scoped; preferences only choose *initial values*.
4. **Future vs existing elements:** confirm the principle that personalization affects only newly created content, and decide where an explicit "apply to existing" action (if any) lives and how it interacts with undo.
5. **How defaults reach pure factories** (`newText`, `newShape`, `newContentSlide`): pass-in parameters, a resolved-defaults object in the store, or a module-level accessor, while keeping `reconcileStructure` and tests deterministic.
6. **Portability:** should preferences/favorites/templates ever travel inside `.mslides` or be exportable? Default answer for now: no, and no file-format change.
7. **Templates and assets:** how are template images stored and protected from the asset GC (§3.1)? Reference-count with deck assets, or a separate namespace?
8. **Templates vs structure:** how should a template interact with `Deck.sections`/TOC, citations, footers (`reference`, `citations`) and `themeColor`? Likely: templates contain only plain content.
9. **Math Palette favorites:** store items as `MathItem` values (`pre`/`post`/`wrap`) or as LaTeX strings? How are they deduplicated against the curated categories?
10. **Callout preferences:** what exactly is "default Callout appearance" (icon only, or also colors), given the Callout is a TipTap node with an icon attribute and fixed styling today?
11. **Font scope:** with only 3 bundled fonts, are "favorite fonts" worth anything before more fonts exist? Adding fonts has bundle-size, licensing (OFL files alongside) and PPTX/PDF implications.
12. **Windows:** none of this is validated on Windows; confirm storage choices behave the same there before relying on them.

## 7. Working rules for the v2 sessions

- Start from the clean `v1.0.0` state; work on a branch only when asked (none exists yet).
- One small phase item per commit; typecheck + build + focused tests; do not repeatedly run the full GUI suite on the busy shared Ubuntu machine (see `PROJECT_STATUS.md` validation status).
- Anything touching persistence is explained first and tested on isolated temporary profiles.
- Update `PROJECT_STATUS.md` and this plan only when a phase actually lands.
