# OpenAI OAuth Models For VS Code

This TypeScript VS Code extension (VS Code 1.104+) exposes models available through the `openai-oauth` package in the Chat model picker. It uses a ChatGPT account's OAuth session through a local OpenAI-compatible API, not a separate OpenAI API key. It provides Chat models, not inline completions. See `README.md` for setup, settings, and user-facing behavior.

## Project Layout

- `src/extension.ts` activates the extension, registers commands and the Chat provider, and manages an extension-owned loopback server. `code-openai-oauth.serverUrl` can instead point to an existing loopback HTTP server; remote URLs are rejected.
- `src/provider.ts` discovers `/v1/models`, resolves model metadata and overrides, and hands Chat requests to `streamChat`. Discovery does not initiate sign-in.
- `src/stream.ts` converts VS Code messages to API requests, streams SSE responses, handles cancellation, and enforces the no-progress timeout.
- `src/configure.ts` implements per-model settings commands; `src/diagnostics.ts` manages metadata-only logging and archive retention.
- `src/test/extension.test.ts` contains VS Code extension-host tests with mocked HTTP responses. `esbuild.cjs` bundles the extension into `dist/extension.js`.

## Development

Requires Node.js 20+ and VS Code 1.104+. Run `npm install`, then `npm run compile` and press F5 to launch an Extension Development Host. Run `npm run check-types` and `npm run lint` for focused checks, `npm test` for the extension-host suite, and `npm run package` for the production bundle. Automated tests mock HTTP; a live Chat test requires working upstream OAuth credentials. Do not commit credentials or diagnostic archives.

## Debugging OpenAI OAuth Chat

When chat stops responding, start with the persistent **OpenAI OAuth** log. Run **OpenAI OAuth: Show Logs** from the Command Palette (or choose **OpenAI OAuth** in the Output panel). For older sessions, the extension also writes daily metadata-only archives under the extension's global storage `diagnostics/` directory (`%APPDATA%\Code\User\globalStorage\<extension-id>\diagnostics` on a typical Windows install). Run **Developer: Open Logs Folder** to inspect VS Code's window logs separately; check extension-host logs for process errors. VS Code manages its own log storage and rotation.

## Triage

1. Reproduce with a known model and record the time, model ID, whether tools were enabled, and the last log entry for that request ID. Do not paste prompts, responses, tokens, or auth files into an issue.
2. `chat resolving server` without `chat ... start` points to `serverUrl()` / local server startup in `src/extension.ts`. `model discovery started` without an HTTP status points to `/v1/models` in `src/provider.ts`.
3. `start` without `headers` points to the fetch/connection. `headers` without `first chunk` points to the server stream. `first chunk` without `done` points to an interrupted or stalled SSE stream; `idle timeout` includes the phase and aborts after the configured idle interval without network progress (default 180 seconds). Set `code-openai-oauth.diagnostics.level` to `debug` to include `headers` and `first chunk` milestones, or `trace` for per-chunk byte counts. `failed` includes phase, elapsed time, chunk/frame counts, and a sanitized error category. `cancelled` indicates VS Code cancelled the request. A request with no terminal event may indicate process termination; check extension-host logs and VS Code's **Developer: Toggle Developer Tools** console.
4. Compare with the server-side logs for the same time window. Run **OpenAI OAuth: Server Status** to see whether the endpoint is extension-owned or external. If external, check the server independently; if owned, check local startup and OAuth sign-in state. Never log raw SSE frames or request bodies: they can contain private chat text and credentials.

## Code And Checks

- `src/stream.ts`: request serialization, fetch, SSE decoding, progress reporting, cancellation and idle watchdog. `code-openai-oauth.idleTimeoutSeconds` (1-3600, default 180) controls the no-progress interval for new requests; it is not a total response deadline.
- `src/provider.ts`: model discovery and the handoff from VS Code to `streamChat`.
- `src/diagnostics.ts`: `code-openai-oauth.diagnostics.level` controls emitted detail (`off`, `error`, `warn`, `info`, `debug`, `trace`; default `info`). Discovery failures that leave the picker empty are warnings; trace records chunk sizes, never SSE content. VS Code's Output channel level can independently hide entries, while the extension archive follows this setting. `code-openai-oauth.diagnostics.retentionDays` keeps 0-365 days of extension-owned daily archives (default 7; 0 disables archiving and clears existing archives). Pruning runs on startup, setting changes and day rollover. VS Code's Output channel logs have independent VS Code-managed retention. No logs are written to the repository.
- `src/extension.ts`: server lifecycle, log channel and commands.
- Run `npm test` for the extension-host suite including stalled-stream coverage; use `npm run check-types` and `npm run lint` for quick focused checks. Tests mock fetch in `src/test/extension.test.ts`. Add a regression test for a new hang scenario before changing its control path.
