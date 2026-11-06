# MathSlides v2.0.1 — release notes

Patch release. **Install this instead of v2.0.0.**

## Fixed
- **App failed to start (v2.0.0 DMG):** "A JavaScript error occurred in the main process — Cannot find module '@anthropic-ai/sdk'". The packaging configuration excluded `node_modules`, so the runtime dependency was missing from `app.asar`. It is now bundled. No app code changed; Ollama-based Sketch-to-Slides and all other features are unchanged.

## Release verification
- `scripts/verify-macos-release.sh` now loads the packaged `electron/*.cjs` modules from `app.asar` and fails if a runtime dependency is missing, and fails if the launch log reports a missing module.

Upgrade: install the new `.dmg` over the old app (**Replace**). Your files, autosave and preferences are kept. Everything else is as in [v2.0.0](RELEASE_NOTES_v2.0.0.md).
