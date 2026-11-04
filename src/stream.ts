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

export async function streamChat(url: string, model: string, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken, effort?: ReasoningEffort): Promise<void> {
	const controller = new AbortController();
	const subscription = token.onCancellationRequested(() => controller.abort());
	try {
		if (token.isCancellationRequested) { return; }
		const response = await fetch(`${url}/chat/completions`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
			body: JSON.stringify({ model, messages: toMessages(messages), stream: true, reasoning_effort: effort,
				tools: options.tools?.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema ?? { type: 'object', properties: {} } } })),
				tool_choice: options.tools?.length ? options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto' : 'none' }),
		});
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
				buffer += decoder.decode(chunk.value, { stream: true });
				let boundary: number;
				while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
				const frame = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
				const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
				if (!data) { continue; }
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
		if (!done) { throw new Error('Chat stream ended without [DONE]'); }
		for (const call of calls.values()) {
			if (!call.name) { throw new Error('Tool call missing function name'); }
			const input: unknown = JSON.parse(call.arguments || '{}');
			if (!input || typeof input !== 'object' || Array.isArray(input)) { throw new Error('Tool call arguments must be an object'); }
			progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, input));
		}
	} finally { subscription.dispose(); }
}