import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { OAuthProvider } from './provider.js';
import { configureModel } from './configure.js';
import { Diagnostics } from './diagnostics.js';

type RunningServer = Awaited<ReturnType<typeof import('openai-oauth').startOpenAIOAuthServer>>;
type ServerLogEvent = import('openai-oauth').OpenAIOAuthServerLogEvent;
let ownedServer: RunningServer | undefined;
let starting: Promise<string> | undefined;
let serverLog: Diagnostics | undefined;

export function logServerEvent(log: Diagnostics, event: ServerLogEvent): void {
	switch (event.type) {
		case 'chat_request':
			log.log('info', `server request id=${event.requestId} model=${event.model ?? 'default'} messages=${event.messageCount} roles=${event.messageRoles.filter(role => ['system', 'developer', 'user', 'assistant', 'tool'].includes(role)).join(',')} tools=${event.toolCount} stream=${event.stream} effort=${event.reasoningEffort ?? 'default'}`);
			break;
		case 'chat_response':
			log.log('info', `server response id=${event.requestId} status=${event.status} duration=${event.durationMs}ms stream=${event.stream} finish=${event.finishReason ?? 'unknown'} inputTokens=${event.usage.inputTokens ?? 'unknown'} outputTokens=${event.usage.outputTokens ?? 'unknown'}`);
			break;
		case 'chat_error':
			const status = /\b(?:HTTP\s*|status\s*(?:[:=]\s*)?)([1-5]\d\d)\b/i.exec(event.message)?.[1];
			const code = /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR_[A-Z_]+)\b/.exec(event.message)?.[0];
			const errorKind = /\b(?:AI_[A-Za-z]+Error|[A-Za-z]+Error|fetch failed)\b/.exec(event.message)?.[0] ?? 'unknown';
			const category = /\b(?:invalid_image|unsupported_image|image_too_large|context_length_exceeded|invalid_request_error|rate_limit_exceeded)\b/i.exec(event.message)?.[0].toLowerCase()
				?? (/\b(?:payload too large|request entity too large)\b/i.test(event.message) ? 'payload-too-large'
					: /\b(?:timed out|timeout)\b/i.test(event.message) ? 'timeout'
						: /\b(?:socket hang up|connection closed|other side closed)\b/i.test(event.message) ? 'connection-closed'
							: /\b(?:failed to (?:convert|download|fetch|load) (?:image|url)|invalid (?:data )?url|unsupported (?:url|media type|mime type))\b/i.test(event.message) ? 'image-conversion'
							: /\bimage\b/i.test(event.message) ? 'image-error' : 'upstream-error');
			const fingerprint = createHash('sha256').update(event.message).digest('hex').slice(0, 12);
			const signals = ['authentication', 'authorization', 'credentials', 'token', 'quota', 'limit', 'rate', 'model', 'image', 'media', 'mime', 'format', 'base64', 'data', 'url', 'decode', 'encode', 'convert', 'upload', 'download', 'fetch', 'socket', 'connection', 'stream', 'response', 'request', 'payload', 'body', 'size', 'large', 'invalid', 'unsupported', 'missing', 'empty', 'expected', 'failed', 'parse', 'timeout', 'abort'].filter(word => new RegExp(`\\b${word}\\b`, 'i').test(event.message));
			log.log('error', `server error id=${event.requestId} duration=${event.durationMs}ms type=${errorKind} category=${category}${status ? ` status=${status}` : ''}${code ? ` code=${code}` : ''} signals=${signals.length ? signals.join(',') : 'none'} messageLength=${event.message.length} fingerprint=${fingerprint}`);
			break;
	}
}

export function configuredUrl(): string | undefined {
	const value = vscode.workspace.getConfiguration('code-openai-oauth').get<string>('serverUrl')?.trim();
	if (!value) { return undefined; }
	const url = new URL(value);
	if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || (url.pathname !== '/' && url.pathname !== '/v1')) {
		throw new Error('Server URL must be a loopback HTTP address ending in /v1 (or /).');
	}
	return `${url.origin}/v1`;
}

export async function serverUrl(log?: Diagnostics): Promise<string> {
	const external = configuredUrl();
	if (external) { return external; }
	if (ownedServer) { return ownedServer.url; }
	if (!starting) {
		starting = import('openai-oauth').then(module => module.startOpenAIOAuthServer({ host: '127.0.0.1', port: 0, requestLogger: event => { if (log) { logServerEvent(log, event); } } })).then(server => {
			ownedServer = server;
			serverLog = log;
			log?.log('info', `server started url=${server.url}`);
			server.server.on('error', error => {
				log?.log('error', `server listener error type=${error.name} code=${'code' in error && typeof error.code === 'string' && /^(?:EADDRINUSE|EACCES|ECONNRESET)$/.test(error.code) ? error.code : 'unknown'}`);
			});
			return server.url;
		}).catch(error => {
			log?.log('error', `server startup failed type=${error instanceof Error ? error.name : 'unknown'}`);
			throw error;
		}).finally(() => { starting = undefined; });
	}
	return starting;
}

export async function stopServer(): Promise<void> {
	if (starting) { await starting.catch(() => undefined); }
	const server = ownedServer;
	ownedServer = undefined;
	if (server) {
		try {
			await server.close();
			serverLog?.log('info', 'server stopped');
		} finally { serverLog = undefined; }
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel('OpenAI OAuth', { log: true });
	context.subscriptions.push(log);
	const diagnostics = new Diagnostics(log, context.globalStorageUri);
	context.subscriptions.push(diagnostics);
	diagnostics.log('info', 'extension activated');
	const provider = new OAuthProvider(() => serverUrl(diagnostics), diagnostics);
	context.subscriptions.push(provider, vscode.lm.registerLanguageModelChatProvider('openai-oauth', provider));
	context.subscriptions.push(vscode.commands.registerCommand('code-openai-oauth.showLogs', () => log.show()));
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
		} catch (error) { diagnostics.log('error', `sign-in failed type=${error instanceof Error ? error.name : 'unknown'}`); void vscode.window.showErrorMessage(`OpenAI OAuth sign-in failed: ${String(error)}`); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('code-openai-oauth.refreshModels', () => provider.refresh()));
	context.subscriptions.push(vscode.commands.registerCommand('code-openai-oauth.configureModel', () => configureModel(provider)));
	context.subscriptions.push(vscode.commands.registerCommand('code-openai-oauth.status', async () => {
		try {
			const url = await serverUrl(diagnostics);
			void vscode.window.showInformationMessage(`OpenAI OAuth server: ${url} (${configuredUrl() ? 'external' : 'extension-owned'})`);
		} catch (error) { diagnostics.log('error', `server status failed type=${error instanceof Error ? error.name : 'unknown'}`); void vscode.window.showErrorMessage(`OpenAI OAuth: ${String(error)}`); }
	}));
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('code-openai-oauth.serverUrl')) { void stopServer().then(() => provider.refresh()); }
		else if (event.affectsConfiguration('code-openai-oauth.modelOverrides')) { provider.refresh(); }
		if (event.affectsConfiguration('code-openai-oauth.diagnostics.retentionDays')) { diagnostics.updateRetention(); }
	}));
}

export async function deactivate(): Promise<void> { await stopServer(); }
