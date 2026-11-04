import * as assert from 'assert';
import * as vscode from 'vscode';
import { OAuthProvider } from '../provider.js';
import { streamChat, toMessages } from '../stream.js';

suite('OpenAI OAuth chat', () => {
	test('activates the ESM extension and registers its commands', async () => {
		const extension = vscode.extensions.all.find(candidate => candidate.packageJSON.name === 'code-openai-oauth' && candidate.extensionPath.replace(/\\/g, '/').endsWith('/code-openai-oauth'));
		assert.ok(extension, 'Development extension is installed');
		await extension.activate();
		assert.ok(extension.isActive);
		assert.ok((await vscode.commands.getCommands(true)).includes('code-openai-oauth.signIn'));
	});

	test('discovers every unique model including unknown IDs', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => Response.json({ object: 'list', data: [{ id: 'gpt-5.5' }, { id: 'future-model' }, { id: 'future-model' }] });
		const provider = new OAuthProvider(async () => 'http://127.0.0.1:10531/v1');
		try {
			const models = await provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);
			assert.deepStrictEqual(models.map(model => model.id), ['gpt-5.5', 'future-model']);
			assert.strictEqual(models[1].maxInputTokens, 32000);
		} finally { provider.dispose(); globalThis.fetch = originalFetch; }
	});

	test('uses catalog limits for GPT-6.1 variants returned by the server', async () => {
		const originalFetch = globalThis.fetch;
		const ids = ['gpt-6.1-astra', 'gpt-6.1-sol', 'gpt-6.1-luna'];
		globalThis.fetch = async () => Response.json({ object: 'list', data: ids.map(id => ({ id })) });
		const provider = new OAuthProvider(async () => 'http://127.0.0.1:10531/v1');
		try {
			const models = await provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);
			assert.deepStrictEqual(models.map(model => model.id), ids);
			for (const model of models) {
				assert.strictEqual(model.maxInputTokens, 272000);
				assert.strictEqual(model.maxOutputTokens, 128000);
			}
		} finally { provider.dispose(); globalThis.fetch = originalFetch; }
	});

	test('preserves tool call and tool result order', () => {
		const messages = [
			{ role: vscode.LanguageModelChatMessageRole.Assistant, name: undefined, content: [new vscode.LanguageModelToolCallPart('call-1', 'lookup', { query: 'hello' })] },
			{ role: vscode.LanguageModelChatMessageRole.User, name: undefined, content: [new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('found')])] },
		];
		assert.deepStrictEqual(toMessages(messages), [
			{ role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"query":"hello"}' } }] },
			{ role: 'tool', tool_call_id: 'call-1', content: 'found' },
		]);
	});

	test('streams split text and tool argument frames', async () => {
		const originalFetch = globalThis.fetch;
		const encoder = new TextEncoder();
		let request: Record<string, unknown> = {};
		const frames = [
			{ choices: [{ delta: { content: 'hello' } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'lookup', arguments: '{"query":' } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"world"}' } }] } }] },
		];
		const data = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
		globalThis.fetch = async (_url, init) => {
			request = JSON.parse(String(init?.body));
			return new Response(new ReadableStream({ start(controller) {
				for (const character of data) { controller.enqueue(encoder.encode(character)); }
				controller.close();
			} }), { status: 200 });
		};
		try {
			const parts: vscode.LanguageModelResponsePart[] = [];
			await streamChat('http://127.0.0.1:10531/v1', 'test-model', [], { toolMode: vscode.LanguageModelChatToolMode.Required, tools: [{ name: 'lookup', description: 'Look up', inputSchema: { type: 'object' } }] }, { report: part => parts.push(part) }, new vscode.CancellationTokenSource().token);
			assert.strictEqual(request.tool_choice, 'required');
			assert.deepStrictEqual(parts.map(part => part instanceof vscode.LanguageModelTextPart ? part.value : (part as vscode.LanguageModelToolCallPart).input), ['hello', { query: 'world' }]);
		} finally { globalThis.fetch = originalFetch; }
	});
});
