# MathSlides Development Instructions

Before starting substantial work on this repository, read:

- `docs/PROJECT_STATUS.md`

That document contains the current stable checkpoint, architecture, persistence model, important invariants, known legacy-data constraints, and planned further work.

## Development rules

- Inspect only the code paths relevant to the requested task.
- Reuse existing architecture and patterns where possible.
- Avoid unrelated refactoring or redesign.
- Preserve existing behavior unless the task explicitly changes it.
- Run TypeScript checking (`npm run typecheck`) after implementation.
- Run the production build (`npm run build`).
- Run `npm test`.
- Add focused runtime validation when appropriate.
- For persistence/lifecycle testing, use isolated temporary Electron `userData` profiles.
- Never use the user's real MathSlides data for destructive automated testing.
- Do not replace `/Applications/MathSlides.app` unless explicitly requested.
- Prefer one focused commit per completed feature.
- Do not amend an already approved checkpoint unless explicitly requested.
- Do not push unless explicitly requested.
- For significant UX/lifecycle features, prefer manual validation of the packaged app before creating the remote checkpoint.
