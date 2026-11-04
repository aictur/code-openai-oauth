# OpenAI OAuth Models for VS Code

[EvanZhouDev/openai-oauth](https://github.com/EvanZhouDev/openai-oauth) lets you sign in with your ChatGPT account and access the models available to that account through a local OpenAI-compatible API, using your subscription, without a separate OpenAI API key.

This VS Code extension brings those models into the Chat model picker so you can use them directly in the editor. It starts an extension-owned loopback server or connects to an existing local server, without modifying `chatLanguageModels.json`.

> [!NOTE]
> This project relies heavily on AI-assisted tools for development, including code generation and documentation. AI-generated contributions may contain errors; review and test the project before relying on it.

## Getting started

Requires VS Code 1.104+, Node.js 20+, and an account supported by the upstream project.

1. Run `npm install` and `npm run compile`, then press F5 to start the Extension Development Host.
2. Run **OpenAI OAuth: Sign In** from the Command Palette and finish sign-in in your browser. Upstream saves credentials in the Codex auth file, not extension settings.
3. Select an **OpenAI OAuth** model in the Chat model picker. Run **OpenAI OAuth: Refresh Models** after changing accounts. **OpenAI OAuth: Server Status** shows the endpoint.

Discovery never triggers browser sign-in. Authentication or upstream errors may leave the model picker empty; sign in and refresh to retry. The managed server stops on deactivation.

## Settings

On VS Code versions that support native model configuration menus, each model exposes **Reasoning level** in the chat model picker, with levels from `low` through `ultra`. A native selection takes precedence over the saved `modelOverrides` value. The menu defaults to the saved level when it is one of these choices, otherwise `medium`. This uses a runtime schema extension not present in the VS Code 1.104 public API; older versions retain the Command Palette workflow below.

Run **OpenAI OAuth: Configure Model** from the Command Palette, choose a model, then choose **Reasoning level** or **Maximum input tokens**. Changes are saved per model. Choose **Server default** or **Reset to default** to remove that override; cancellation leaves settings unchanged. The command updates workspace overrides when present, otherwise user settings, preserving other models and properties. Resetting a workspace override can reveal an inherited user value.

Maximum input tokens is the input capacity advertised to VS Code, not a combined input/output budget. It does not increase the model's actual capacity or truncate requests locally. Use a limit supported by your model.

- `code-openai-oauth.serverUrl`: Optional existing loopback HTTP server URL such as `http://127.0.0.1:10531/v1`. The extension does not own that server. Remote URLs are rejected because the upstream proxy uses your OAuth session without authenticating HTTP clients.
- `code-openai-oauth.idleTimeoutSeconds`: Seconds without network progress before a chat request aborts (1-3600, default 180). New requests pick up changes; this is not a total response deadline.
- `code-openai-oauth.diagnostics.level`: `off`, `error`, `warn`, `info` (default), `debug`, or `trace`, in increasing detail. Info includes outgoing JSON size, image count and bytes, extension-owned server startup and chat request/response summaries; debug adds connection and first-chunk milestones; trace adds per-chunk byte counts. Server startup, listener, and chat errors log safe categories and recognized HTTP status or transport codes at error level, not raw upstream error messages. Unknown server errors include allowlisted technical signals, a message length, and a short fingerprint to compare repeated failures without exposing their text. An image request with `cause=UND_ERR_SOCKET detail=local-server-closed-connection-before-headers` reached the local server but lost the connection before response headers; inspect nearby `server error` entries for a category or status. Logs contain metadata only, not chat content. An external server's internal logs are not captured; inspect that server separately. VS Code's Output channel log level may independently hide entries in the channel; the extension archive follows this setting.
- `code-openai-oauth.diagnostics.retentionDays`: Keep extension-owned daily archives for 0-365 days (default 7). Zero deletes existing archives and disables new ones. VS Code manages Output channel retention independently. Run **OpenAI OAuth: Show Logs** to see the current channel; archived logs live under the extension's global storage `diagnostics/` folder.
- `code-openai-oauth.modelOverrides`: Per-model token limits, reasoning effort, and capability flags. Example:

```json
{
	"code-openai-oauth.modelOverrides": {
		"gpt-5.6-sol": {
			"maxInputTokens": 272000,
			"maxOutputTokens": 128000,
			"reasoningEffort": "high",
			"toolCalling": true,
			"imageInput": false
		}
	}
}
```

Model IDs come from `/v1/models`. That endpoint does not report token limits or capabilities, so known IDs use catalog values and unknown IDs use a 32,000 input / 4,096 output fallback. Image input and tool calling are on by default. Set `imageInput` to `false` for a model that does not accept images; otherwise image requests to an unsupported model may fail upstream. Token counting is approximate. Adjust metadata to match your models.

Reasoning levels are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`. Support varies by model; unsupported levels can produce an upstream error. Omit `reasoningEffort` to use the server default. Invalid reasoning values are ignored; invalid token limits fall back to catalog values.

The extension provides Chat models, not inline completions or profile-scoped Custom Endpoint entries. Copilot organization policy or harness behavior may restrict third-party models. Upstream OAuth/model availability can change independently of this extension.

## Development

Development and CI require Node.js 22+. Install with `npm ci --ignore-scripts` to use the committed lockfile without running dependency lifecycle scripts.

Run `npm test` for VS Code extension-host tests, or select **Extension Tests** in Run and Debug to debug them in VS Code. Run `npm run compile` for a development build, and `npm run build:production` (or `npm run package`) for a minified build. Run `npm run install:local` to compile, package, and install a development VSIX into the VS Code instance on your `code` CLI path; reload that window to use the update. `vsce package` also runs the development build through `vscode:prepublish`. A live chat test needs working OAuth credentials; automated tests use mocked HTTP responses.

## CI and security

CI installs locked dependencies with lifecycle scripts disabled, tests under Xvfb, and builds the production bundle. A separate blocking audit checks production and development dependencies at every severity. Dependency Review rejects vulnerable dependency changes on pull requests; CodeQL runs security-and-quality analysis. Actions use immutable commit pins, checkout credentials are not persisted, and only CodeQL has security-event upload permission. Dependabot proposes weekly npm and action updates.

With Docker and the `gh act` extension installed, run:

```sh
gh act pull_request -W .github/workflows/ci.yml -j verify -P ubuntu-24.04=catthehacker/ubuntu:act-24.04
gh act pull_request -W .github/workflows/ci.yml -j audit -P ubuntu-24.04=catthehacker/ubuntu:act-24.04
```

The local runner image is a third-party execution environment, not the GitHub-hosted runner. Do not provide credentials or secrets to these local jobs. Dependency Review and CodeQL upload require validation on GitHub, not just act. Enable dependency graph, Dependabot alerts/security updates, and advanced CodeQL scanning in repository settings (disable default CodeQL setup when using this workflow). Private repositories may require an eligible security plan. Require **Verify**, **Dependency audit**, **Dependency review**, and **CodeQL** in the main branch ruleset, disallow bypasses, and require code-scanning results with the lowest available alert thresholds: a successful CodeQL upload alone does not block newly detected alerts. Require reviewed pull requests and SHA-pinned actions in repository Actions policy where available. Workflow files alone cannot enforce these owner-controlled settings.

Existing advisories are not suppressed: the audit gate remains red until dependencies are remediated. No automatic `audit fix --force`, lifecycle-script exceptions, or vulnerability allowlist is used. License restrictions are not imposed without a project-approved license policy.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). This extension uses [openai-oauth](https://github.com/EvanZhouDev/openai-oauth), also licensed under Apache 2.0. Upstream attribution is preserved in [NOTICE](NOTICE).
