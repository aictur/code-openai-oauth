# OpenAI OAuth Models for VS Code

Expose models from [openai-oauth](https://github.com/EvanZhouDev/openai-oauth) in the VS Code Chat model picker. The extension starts an extension-owned loopback server or connects to an existing local server. It does not modify `chatLanguageModels.json`.

## Getting started

Requires VS Code 1.104+, Node.js 20+, and an account supported by the upstream project.

1. Run `npm install` and `npm run compile`, then press F5 to start the Extension Development Host.
2. Run **OpenAI OAuth: Sign In** from the Command Palette and finish sign-in in your browser. Upstream saves credentials in the Codex auth file, not extension settings.
3. Select an **OpenAI OAuth** model in the Chat model picker. Run **OpenAI OAuth: Refresh Models** after changing accounts. **OpenAI OAuth: Server Status** shows the endpoint.

Discovery never triggers browser sign-in. Authentication or upstream errors may leave the model picker empty; sign in and refresh to retry. The managed server stops on deactivation.

## Settings

- `code-openai-oauth.serverUrl`: Optional existing loopback HTTP server URL such as `http://127.0.0.1:10531/v1`. The extension does not own that server. Remote URLs are rejected because the upstream proxy uses your OAuth session without authenticating HTTP clients.
- `code-openai-oauth.modelOverrides`: Per-model token limits and capability flags. Example:

```json
{
	"code-openai-oauth.modelOverrides": {
		"gpt-5.6-sol": {
			"maxInputTokens": 272000,
			"maxOutputTokens": 128000,
			"toolCalling": true,
			"imageInput": true
		}
	}
}
```

Model IDs come from `/v1/models`. That endpoint does not report token limits or capabilities, so known IDs use catalog values and unknown IDs use a 32,000 input / 4,096 output fallback. Image input is off unless explicitly enabled; tool calling is on by default. Token counting is approximate. Adjust metadata to match your models.

The extension provides Chat models, not inline completions or profile-scoped Custom Endpoint entries. Copilot organization policy or harness behavior may restrict third-party models. Upstream OAuth/model availability can change independently of this extension.

## Development

Run `npm test` for VS Code tests, `npm run package` for a production build, and `npx @vscode/vsce package` for a VSIX. A live chat test needs working OAuth credentials; automated tests use mocked HTTP responses.
