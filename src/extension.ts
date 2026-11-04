import * as vscode from 'vscode';
import { OAuthProvider } from './provider.js';

type RunningServer = Awaited<ReturnType<typeof import('openai-oauth').startOpenAIOAuthServer>>;
let ownedServer: RunningServer | undefined;
let starting: Promise<string> | undefined;

export function configuredUrl(): string | undefined {
	const value = vscode.workspace.getConfiguration('code-openai-oauth').get<string>('serverUrl')?.trim();
	if (!value) { return undefined; }
	const url = new URL(value);
	if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || (url.pathname !== '/' && url.pathname !== '/v1')) {
		throw new Error('Server URL must be a loopback HTTP address ending in /v1 (or /).');
	}
	return `${url.origin}/v1`;
}

export async function serverUrl(): Promise<string> {
	const external = configuredUrl();
	if (external) { return external; }
	if (ownedServer) { return ownedServer.url; }
	if (!starting) {
		starting = import('openai-oauth').then(module => module.startOpenAIOAuthServer({ host: '127.0.0.1', port: 0 })).then(server => {
			ownedServer = server;
			return server.url;
		}).finally(() => { starting = undefined; });
	}
	return starting;
}

export async function stopServer(): Promise<void> {
	if (starting) { await starting.catch(() => undefined); }
	const server = ownedServer;
	ownedServer = undefined;
	await server?.close();
}

export function activate(context: vscode.ExtensionContext): void {
	const provider = new OAuthProvider(serverUrl);
	context.subscriptions.push(provider, vscode.lm.registerLanguageModelChatProvider('openai-oauth', provider));
	context.subscriptions.push(vscode.commands.registerCommand('code-openai-oauth.signIn', async () => {
		const choice = await vscode.window.showWarningMessage('Sign in to OpenAI OAuth? This saves credentials in the upstream Codex auth file.', 'Sign In');
		if (choice !== 'Sign In') { return; }
		try {
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'OpenAI OAuth: waiting for browser sign-in', cancellable: true }, async (_progress, token) => {
				const controller = new AbortController();
				const subscription = token.onCancellationRequested(() => controller.abort());
				try {
					const { runOpenAIOAuthLogin } = await import('openai-oauth');
					await runOpenAIOAuthLogin({ signal: controller.signal, openBrowser: false, onMessage: message => {
						const match = message.match(/^OpenAI OAuth login URL: (.+)$/);
						if (match) { void vscode.env.openExternal(vscode.Uri.parse(match[1])); }
					} });
				} finally { subscription.dispose(); }
			});
			await stopServer();
			provider.refresh();
			void vscode.window.showInformationMessage('OpenAI OAuth sign-in completed.');
		} catch (error) { void vscode.window.showErrorMessage(`OpenAI OAuth sign-in failed: ${String(error)}`); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('code-openai-oauth.refreshModels', () => provider.refresh()));
	context.subscriptions.push(vscode.commands.registerCommand('code-openai-oauth.status', async () => {
		try {
			const url = await serverUrl();
			void vscode.window.showInformationMessage(`OpenAI OAuth server: ${url} (${configuredUrl() ? 'external' : 'extension-owned'})`);
		} catch (error) { void vscode.window.showErrorMessage(`OpenAI OAuth: ${String(error)}`); }
	}));
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('code-openai-oauth.serverUrl')) { void stopServer().then(() => provider.refresh()); }
		else if (event.affectsConfiguration('code-openai-oauth.modelOverrides')) { provider.refresh(); }
	}));
}

export async function deactivate(): Promise<void> { await stopServer(); }
