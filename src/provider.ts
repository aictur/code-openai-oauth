import * as vscode from 'vscode';
import { streamChat } from './stream.js';

const catalog: Record<string, [number, number]> = {
	'gpt-5.5': [272000, 128000],
	'gpt-5.6-sol': [272000, 128000],
	'gpt-5.6-terra': [272000, 128000],
	'gpt-5.6-luna': [272000, 128000],
	'gpt-6-astra': [272000, 128000],
	'gpt-6-sol': [272000, 128000],
	'gpt-6-luna': [272000, 128000],
	'gpt-6.1-astra': [272000, 128000],
	'gpt-6.1-sol': [272000, 128000],
	'gpt-6.1-luna': [272000, 128000],
};

export class OAuthProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.emitter.event;
	private models: vscode.LanguageModelChatInformation[] = [];

	constructor(private readonly getUrl: () => Promise<string>) { }

	refresh(): void { this.models = []; this.emitter.fire(); }
	dispose(): void { this.emitter.dispose(); }

	async provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
		const controller = new AbortController();
		const subscription = token.onCancellationRequested(() => controller.abort());
		try {
			if (token.isCancellationRequested) { return []; }
			const url = await this.getUrl();
			const response = await fetch(`${url}/models`, { signal: controller.signal });
			if (!response.ok) { throw new Error(`Models endpoint returned HTTP ${response.status}`); }
			const body: unknown = await response.json();
			if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data)) { throw new Error('Invalid /v1/models response'); }
			const overrides = vscode.workspace.getConfiguration('code-openai-oauth').get<Record<string, Record<string, unknown>>>('modelOverrides', {});
			const ids = [...new Set(body.data.map((entry: unknown) => entry && typeof entry === 'object' && 'id' in entry ? entry.id : undefined).filter((id: unknown): id is string => typeof id === 'string' && id.length > 0))];
			this.models = ids.map(id => {
				const [input, output] = catalog[id] ?? [32000, 4096];
				const custom = overrides[id] ?? {};
				const limit = (value: unknown, fallback: number) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
				return {
					id, name: id, family: id, version: id,
					maxInputTokens: limit(custom.maxInputTokens, input), maxOutputTokens: limit(custom.maxOutputTokens, output),
					tooltip: `OpenAI OAuth (${catalog[id] ? 'catalog' : 'fallback'} token limits; configurable in settings)`,
					capabilities: { toolCalling: custom.toolCalling === false ? false : true, imageInput: custom.imageInput === true },
				};
			});
			return this.models;
		} catch (error) {
			if (!token.isCancellationRequested) { console.error('OpenAI OAuth model discovery:', error); }
			return this.models;
		} finally { subscription.dispose(); }
	}

	async provideLanguageModelChatResponse(model: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
		if (token.isCancellationRequested) { return; }
		await streamChat(await this.getUrl(), model.id, messages, options, progress, token);
	}

	async provideTokenCount(_model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
		const content = typeof text === 'string' ? text : JSON.stringify(text.content.map(part => part instanceof vscode.LanguageModelDataPart ? { mime: part.mimeType, bytes: part.data.length } : part));
		return Math.max(1, Math.ceil(content.length / 4));
	}
}