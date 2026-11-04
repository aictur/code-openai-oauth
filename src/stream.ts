import * as vscode from 'vscode';

export function toMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): object[] {
	const result: object[] = [];
	for (const message of messages) {
		const content: object[] = [];
		const calls: object[] = [];
		const results: object[] = [];
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) { content.push({ type: 'text', text: part.value }); }
			else if (part instanceof vscode.LanguageModelDataPart) {
				if (!part.mimeType.startsWith('image/')) { throw new Error(`Unsupported input MIME type: ${part.mimeType}`); }
				if (message.role !== vscode.LanguageModelChatMessageRole.User) { throw new Error('Images are only supported in user messages'); }
				content.push({ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}` } });
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				if (message.role !== vscode.LanguageModelChatMessageRole.Assistant) { throw new Error('Tool calls must be assistant messages'); }
				calls.push({ id: part.callId, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input) } });
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				if (message.role !== vscode.LanguageModelChatMessageRole.User) { throw new Error('Tool results must be user messages'); }
				results.push({ role: 'tool', tool_call_id: part.callId, content: part.content.map(item => item instanceof vscode.LanguageModelTextPart ? item.value : JSON.stringify(item)).join('\n') });
			} else { throw new Error('Unsupported message content part'); }
		}
		if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			result.push({ role: 'assistant', content: content.map(item => (item as { text?: string }).text ?? '').join(''), ...(calls.length ? { tool_calls: calls } : {}) });
		} else if (content.length) {
			result.push({ role: 'user', content });
		}
		result.push(...results);
	}
	return result;
}

export const reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type ReasoningEffort = typeof reasoningEfforts[number];

export function reasoningEffort(value: unknown): ReasoningEffort | undefined {
	return reasoningEfforts.find(effort => effort === value);
}

export async function streamChat(url: string, model: string, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken, effort?: ReasoningEffort, log?: (message: string, level: 'error' | 'info' | 'debug' | 'trace') => void, idleTimeoutMs = 180000): Promise<void> {
	const controller = new AbortController();
	const subscription = token.onCancellationRequested(() => controller.abort());
	const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const started = Date.now();
	let phase = 'fetch';
	let chunks = 0;
	let frames = 0;
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout>;
	const resetTimer = () => {
		clearTimeout(timer);
		timer = setTimeout(() => { timedOut = true; log?.(`chat ${requestId} idle timeout phase=${phase} after=${idleTimeoutMs}ms`, 'error'); controller.abort(); }, idleTimeoutMs);
	};
	try {
		if (token.isCancellationRequested) { return; }
		log?.(`chat ${requestId} start model=${model} messages=${messages.length} tools=${options.tools?.length ?? 0}`, 'info');
		resetTimer();
		phase = 'serialize';
		const streaming = !/^gpt-6(?:\.1)?(?:-|$)/.test(model);
		const imageParts = messages.flatMap(message => message.content).filter((part): part is vscode.LanguageModelDataPart => part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/'));
		const body = JSON.stringify({ model, messages: toMessages(messages), stream: streaming, reasoning_effort: effort,
			tools: options.tools?.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema ?? { type: 'object', properties: {} } } })),
			tool_choice: options.tools?.length ? options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto' : 'none' });
		log?.(`chat ${requestId} request bytes=${Buffer.byteLength(body)} images=${imageParts.length} imageBytes=${imageParts.reduce((total, part) => total + part.data.byteLength, 0)}`, 'info');
		phase = 'fetch';
		const response = await fetch(`${url}/chat/completions`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
			body,
		});
		log?.(`chat ${requestId} headers status=${response.status} elapsed=${Date.now() - started}ms`, 'debug');
		phase = 'stream';
		resetTimer();
		if (!response.ok || !response.body) { throw new Error(`Chat request failed (HTTP ${response.status}): ${(await response.text()).slice(0, 500)}`); }
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		const calls = new Map<number, { id: string; name: string; arguments: string }>();
		let done = false;
		try {
			while (!done && !token.isCancellationRequested) {
				const chunk = await reader.read();
				if (chunk.done) { break; }
				chunks++;
				if (chunks === 1) { log?.(`chat ${requestId} first chunk elapsed=${Date.now() - started}ms`, 'debug'); }
				log?.(`chat ${requestId} chunk=${chunks} bytes=${chunk.value.byteLength} elapsed=${Date.now() - started}ms`, 'trace');
				resetTimer();
				buffer += decoder.decode(chunk.value, { stream: true });
				if (!streaming) { continue; }
				let boundary: number;
				while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
				const frame = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
				const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
				if (!data) { continue; }
				frames++;
				if (data === '[DONE]') { done = true; break; }
				const payload = JSON.parse(data);
				if (payload.error) { throw new Error(payload.error.message ?? 'Stream error'); }
				for (const choice of payload.choices ?? []) {
					if (choice.delta?.content) { progress.report(new vscode.LanguageModelTextPart(choice.delta.content)); }
					for (const call of choice.delta?.tool_calls ?? []) {
						const previous = calls.get(call.index) ?? { id: '', name: '', arguments: '' };
						previous.id = call.id ?? previous.id;
						previous.name += call.function?.name ?? '';
						previous.arguments += call.function?.arguments ?? '';
						calls.set(call.index, previous);
					}
				}
				}
			}
		} finally {
			if (done || token.isCancellationRequested) { await reader.cancel().catch(() => undefined); }
			reader.releaseLock();
		}
		if (token.isCancellationRequested) { return; }
		if (!streaming) {
			const payload = JSON.parse(buffer + decoder.decode());
			if (payload.error) { throw new Error(payload.error.message ?? 'Chat error'); }
			if (!Array.isArray(payload.choices) || !payload.choices.length) { throw new Error('Chat response missing choices'); }
			for (const choice of payload.choices) {
				if (choice.message?.content) { progress.report(new vscode.LanguageModelTextPart(choice.message.content)); }
				for (const call of choice.message?.tool_calls ?? []) {
					calls.set(calls.size, { id: call.id, name: call.function?.name, arguments: call.function?.arguments ?? '' });
				}
			}
			done = true;
		}
		if (!done) { throw new Error('Chat stream ended without [DONE]'); }
		for (const call of calls.values()) {
			if (!call.name) { throw new Error('Tool call missing function name'); }
			const input: unknown = JSON.parse(call.arguments || '{}');
			if (!input || typeof input !== 'object' || Array.isArray(input)) { throw new Error('Tool call arguments must be an object'); }
			progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, input));
		}
		log?.(`chat ${requestId} done elapsed=${Date.now() - started}ms chunks=${chunks} frames=${frames} toolCalls=${calls.size}`, 'info');
	} catch (error) {
		const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
		const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(cause.code) ? cause.code : undefined;
		log?.(`chat ${requestId} failed phase=${phase} elapsed=${Date.now() - started}ms chunks=${chunks} frames=${frames} reason=${timedOut ? 'idle-timeout' : error instanceof Error ? error.name : 'unknown'}${code ? ` cause=${code}` : ''}${code === 'UND_ERR_SOCKET' && phase === 'fetch' ? ' detail=local-server-closed-connection-before-headers' : ''}`, 'error');
		if (timedOut) { throw new Error(`Chat request idle for ${idleTimeoutMs}ms during ${phase}`); }
		throw error;
	} finally {
		clearTimeout(timer!);
		if (token.isCancellationRequested) { log?.(`chat ${requestId} cancelled phase=${phase} elapsed=${Date.now() - started}ms`, 'info'); }
		subscription.dispose();
	}
}