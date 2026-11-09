# Contributing to Skills Studio

The plugin lives in `plugins/skills-studio/`:

- `src/` — MCP server, file operations, and local Codex App Server integration.
- `ui/` — catalogue, editor, and side chat.
- `tests/` — file-operation, RPC, and UI tests.
- `scripts/` — build and installed-plugin launch scripts.

You need Node.js 20+ and npm. From the repository root:

```sh
cd plugins/skills-studio
npm ci
npm test
npm run check
```

`npm test` builds the plugin first. Commit updated `server.mjs` and `assets/app.html` after changing source files: these bundles are tracked so users can install the plugin without npm.

When adding or updating dependencies, update `THIRD_PARTY_NOTICES.txt` with the complete licenses of libraries included in the distributed bundles.

Describe the changed behavior and the checks you ran in your pull request. For UI changes, include a screenshot with demonstration data. Do not commit personal skills, chat history, Codex settings, tokens, backups, or images containing workspace data.

English is the default UI language. Keep English and Russian labels in sync, including placeholders, tooltips, accessibility labels, and status messages. Localize application messages only; skill content, user notes, paths, and chat messages must retain their original text. Test that switching languages preserves unsaved edits and drafts. Update both README versions for user-facing changes.

Create test data in temporary directories. Installation checks must use a separate Codex profile and leave user settings untouched. This repository has no automatic CI jobs; run the required checks locally.
