import * as vscode from 'vscode';
import { OAuthProvider } from './provider.js';
import { reasoningEffort, reasoningEfforts } from './stream.js';

type Overrides = Record<string, Record<string, unknown>>;

export function mergeOverride(current: Overrides, model: string, property: string, value: unknown): Overrides {
	const result = { ...current, [model]: { ...current[model] } };
	if (value === undefined) { delete result[model][property]; }
	else { result[model][property] = value; }
	if (!Object.keys(result[model]).length) { delete result[model]; }
	return result;
}

export function validateContext(value: string): string | undefined {
	const parsed = Number(value);
	return /^\d+$/.test(value) && Number.isSafeInteger(parsed) && parsed > 0 ? undefined : 'Enter a positive whole number of tokens (up to 9007199254740991).';
}

export async function configureModel(provider: OAuthProvider): Promise<void> {
	const source = new vscode.CancellationTokenSource();
	try {
		const models = await provider.provideLanguageModelChatInformation({ silent: false }, source.token);
		if (!models.length) { void vscode.window.showWarningMessage('No OpenAI OAuth models available. Sign in and refresh models, then try again.'); return; }
		const selected = await vscode.window.showQuickPick(models.map(model => ({ label: model.id, description: `${model.maxInputTokens} input tokens`, model })), { title: 'OpenAI OAuth: Configure Model' });
		if (!selected) { return; }
		const configuration = vscode.workspace.getConfiguration('code-openai-oauth');
		const current = configuration.get<Overrides>('modelOverrides', {})[selected.model.id] ?? {};
		const setting = await vscode.window.showQuickPick([
			{ label: 'Reasoning level', description: reasoningEffort(current.reasoningEffort) ?? 'Server default', property: 'reasoningEffort' },
			{ label: 'Maximum input tokens', description: String(selected.model.maxInputTokens), property: 'maxInputTokens' },
		], { title: selected.label });
		if (!setting) { return; }
		let value: unknown;
		if (setting.property === 'reasoningEffort') {
			const choice = await vscode.window.showQuickPick([
				{ label: 'Server default', value: undefined as string | undefined },
				...reasoningEfforts.map(effort => ({ label: effort, value: effort })),
			], { title: `${selected.label}: Reasoning level`, placeHolder: 'Supported levels vary by model' });
			if (!choice) { return; }
			value = choice.value;
		} else {
			const choice = await vscode.window.showQuickPick(['Set maximum input tokens', 'Reset to default'], { title: `${selected.label}: Maximum input tokens` });
			if (!choice) { return; }
			if (choice === 'Set maximum input tokens') {
				const input = await vscode.window.showInputBox({ title: `${selected.label}: Maximum input tokens`, value: String(selected.model.maxInputTokens), validateInput: validateContext });
				if (input === undefined) { return; }
				value = Number(input);
			}
		}
		const inspected = configuration.inspect<Overrides>('modelOverrides');
		const target = inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
		const own = target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue;
		await configuration.update('modelOverrides', mergeOverride(own ?? {}, selected.model.id, setting.property, value), target);
	} catch (error) { void vscode.window.showErrorMessage(`OpenAI OAuth configuration failed: ${String(error)}`); }
	finally { source.dispose(); }
}