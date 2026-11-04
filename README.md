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
- `code-openai-oauth.modelOverrides`: Per-model token limits, reasoning effort, and capability flags. Example:

```json
{
	"code-openai-oauth.modelOverrides": {
		"gpt-5.6-sol": {
			"maxInputTokens": 272000,
			"maxOutputTokens": 128000,
			"reasoningEffort": "high",
			"toolCalling": true,
			"imageInput": true
		}
	}
}
```

Model IDs come from `/v1/models`. That endpoint does not report token limits or capabilities, so known IDs use catalog values and unknown IDs use a 32,000 input / 4,096 output fallback. Image input is off unless explicitly enabled; tool calling is on by default. Token counting is approximate. Adjust metadata to match your models.

Reasoning levels are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`. Support varies by model; unsupported levels can produce an upstream error. Omit `reasoningEffort` to use the server default. Invalid reasoning values are ignored; invalid token limits fall back to catalog values.

The extension provides Chat models, not inline completions or profile-scoped Custom Endpoint entries. Copilot organization policy or harness behavior may restrict third-party models. Upstream OAuth/model availability can change independently of this extension.

## Development

Run `npm test` for VS Code tests, `npm run package` for a production build, and `npx @vscode/vsce package` for a VSIX. A live chat test needs working OAuth credentials; automated tests use mocked HTTP responses.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). This extension uses [openai-oauth](https://github.com/EvanZhouDev/openai-oauth), also licensed under Apache 2.0. Upstream attribution is preserved in [NOTICE](NOTICE).
