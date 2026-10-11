# Development

Contributors: start with [`CLAUDE.md`](../CLAUDE.md) and [`PROJECT_STATUS.md`](PROJECT_STATUS.md) (architecture, persistence model, invariants, validation status). Users: see the [README](../README.md).

## Build the app from source

To build your own copy you need an Apple Silicon Mac, [Node.js](https://nodejs.org/) 22 (LTS), and Git:

```bash
git clone https://github.com/Kimtona/math-slides.git
cd math-slides
npm install
npm run dist:mac
```

This creates, in the git-ignored `release/` folder, `MathSlides-<version>-arm64.dmg` and `mac-arm64/MathSlides.app`. A local build is signed ad-hoc like the release DMG and is not notarized, so the [first-launch approval](../README.md#installation) may apply to it too. To update a source checkout, run `git pull && npm install`; this does not change an app already installed in `/Applications`.

## Run and test

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

## Export details and known limitations

- **PDF** (desktop app): every slide is rendered 1:1 and printed by Chromium to 960×540 pt pages with embedded fonts (selectable text) and vector equations.
- **PPTX:** text becomes editable PowerPoint text boxes (bold/italic/underline/color/bullets/highlight). Shapes, lines, callouts, blocks, todo checkboxes and code blocks become native shapes with editable text, and images keep native crop. Speaker notes are included.
- Equations in PPTX are SVG pictures (with a PNG fallback), not native PowerPoint equations.
- A PPTX line that contains inline equations is split into several positioned text boxes, so heavy editing in PowerPoint can disturb its layout.
- For PowerPoint to show the same font, install the font you used locally (e.g. NanumSquare). The editor and PDF already embed it.
- No rotation or grouping. Crop is rectangular only.
- Fonts with Korean glyphs (including NanumSquare) display `\` as `₩` in normal text. Equations are unaffected.

## Releases (maintainers)

Pushing a version tag builds the DMG on GitHub Actions ([`release.yml`](../.github/workflows/release.yml)) and attaches it to a **draft** GitHub Release; nothing is published automatically.

1. Set `version` in `package.json` (and the lockfile), commit, and push to `main`.
2. Tag and push: `git tag -a v1.1.0 -m "MathSlides v1.1.0" && git push origin v1.1.0`. A suffix such as `v1.1.0-rc.1` creates a prerelease draft.
3. The workflow checks that the tag matches `package.json`, runs typecheck, tests and build, and packages the DMG with an explicit ad-hoc signature (`mac.identity: "-"` in `package.json`; no Apple credentials). [`scripts/verify-macos-release.sh`](../scripts/verify-macos-release.sh) then checks the DMG layout, the bundle metadata, a strictly valid code signature, the Gatekeeper assessment of a quarantined copy and a launch smoke test. It generates `SHA256SUMS`, uploads both files to a draft, and re-downloads them to confirm they match. It fails rather than touch an existing release.
4. Before publishing, try the draft on a fresh macOS user account or VM, downloading the DMG in Safari, and walk through the [install steps](../README.md#installation). You can also run the same checks locally: `scripts/verify-macos-release.sh release/MathSlides-<version>-arm64.dmg <version> release/SHA256SUMS`. Then publish the release manually on GitHub.

### Dry run (no tag, no release)

To run the same build and checks without creating a tag or a GitHub Release:

- **Before `release.yml` is on `main`:** push your branch to a `dry-run/…` name, for example `git push origin my-branch:dry-run/my-check`, and delete it afterwards with `git push origin --delete dry-run/my-check`. (GitHub only offers a manual "Run workflow" button for workflows that exist on the default branch.)
- **After it is on `main`:** open **Actions → Release → Run workflow**, choose a branch, and optionally untick **Run typecheck and the full test suite** for a quicker packaging check. The same thing from a terminal: `gh workflow run release.yml --ref <branch> -f run_tests=false`.

A dry run uses the same `tests` and `package` jobs as a release, so it builds the same DMG and runs the same `scripts/verify-macos-release.sh`. It only has read access: the separate `release` job, which alone can create a draft release, runs only when a version tag is pushed (never for a manual run, even one started on a tag). The verified DMG and `SHA256SUMS` are kept for 14 days as an **artifact** on the workflow run page so you can download and try exactly that build.

## Project status

- **Platform:** macOS on Apple Silicon is the primary, tested platform. A Windows installer configuration exists but has **not** been validated on a real Windows machine.
- **Distribution:** ad-hoc signed (not Developer-ID signed), un-notarized Apple Silicon DMGs via [GitHub Releases](https://github.com/Kimtona/math-slides/releases), updated manually; the first launch needs a one-time Open Anyway approval. Developer ID signing, notarization and automatic updates are not implemented.
- **Development stage:** in active use for real presentations. Fixes come from that day-to-day use. Planned work is tracked in [`PROJECT_STATUS.md`](PROJECT_STATUS.md) and [`V2_PLAN.md`](V2_PLAN.md).
