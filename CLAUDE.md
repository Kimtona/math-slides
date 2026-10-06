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

## Testing discipline

Avoid excessive test execution during development.

- During implementation, prefer `npm run typecheck` and the smallest relevant focused test.
- Do not run the full `npm test` suite after every small change.
- Run `npm run build` when a meaningful implementation stage is complete, not after every edit.
- Run the full `npm test` suite at most once during final validation before a commit, unless the user explicitly asks otherwise.
- If the full suite fails, do not repeatedly rerun it. Investigate the failure and rerun only the failing or directly related focused test first. Rerun the full suite after a fix only when needed for final confidence.
- Do not create long-running polling, sampling, monitoring, retry, or repeated validation loops merely to verify that tests themselves are behaving.
- Prefer manual UI verification by the user for visual/interaction polish instead of repeatedly exercising the whole GUI suite.
- If sufficient validation has already been completed on the current tree, do not rerun tests merely because the work is being staged, committed, reorganized into commits, or pushed.
- Electron GUI tests run with hidden windows (`MATHSLIDES_TEST_HIDDEN`, set by `tests/electron-env.mjs`); set `MATHSLIDES_TEST_VISIBLE=1` to watch a run.
