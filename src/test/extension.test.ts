import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { OAuthProvider } from '../provider.js';
import { Diagnostics } from '../diagnostics.js';
import { logServerEvent } from '../extension.js';
import { reasoningEffort, streamChat, toMessages } from '../stream.js';
import { mergeOverride, validateContext } from '../configure.js';

suite('OpenAI OAuth chat', () => {
	test('uses non-streaming JSON for GPT-6 and GPT-6.1 only', async () => {
		const originalFetch = globalThis.fetch;
		const source = new vscode.CancellationTokenSource();
		try {
			for (const model of ['gpt-6', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6.1', 'gpt-6.1-sol', 'gpt-6.1-astra', 'gpt-6.1-luna', 'gpt-5.6-sol', 'gpt-6.10-sol']) {
				const expectedStreaming = ['gpt-5.6-sol', 'gpt-6.10-sol'].includes(model);
				const parts: vscode.LanguageModelResponsePart[] = [];
				globalThis.fetch = async (_url, init) => {
					assert.strictEqual(JSON.parse(String(init?.body)).stream, expectedStreaming);
					return expectedStreaming ? new Response('data: [DONE]\n\n') : Response.json({ choices: [{ message: { content: 'Hello', tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: '{"value":1}' } }] } }] });
				};
				await streamChat('http://127.0.0.1:10531/v1', model, [], { toolMode: vscode.LanguageModelChatToolMode.Auto }, { report: part => parts.push(part) }, source.token);
				if (!expectedStreaming) {
					assert.deepStrictEqual(parts, [new vscode.LanguageModelTextPart('Hello'), new vscode.LanguageModelToolCallPart('call-1', 'lookup', { value: 1 })]);
				}
			}
		} finally { source.dispose(); globalThis.fetch = originalFetch; }
	});

	test('validates context sizes and preserves unrelated model settings', () => {
		for (const value of ['1', '272000', '9007199254740991']) { assert.strictEqual(validateContext(value), undefined); }
		for (const value of ['', '0', '-1', '1.5', '1e5', 'Infinity', '9007199254740992']) { assert.ok(validateContext(value)); }
		const original = { first: { imageInput: true, reasoningEffort: 'low' }, second: { maxInputTokens: 4000 } };
		const updated = mergeOverride(original, 'first', 'maxInputTokens', 8000);
		assert.deepStrictEqual(updated, { first: { imageInput: true, reasoningEffort: 'low', maxInputTokens: 8000 }, second: { maxInputTokens: 4000 } });
		assert.strictEqual(original.first.reasoningEffort, 'low');
		assert.deepStrictEqual(mergeOverride(updated, 'first', 'maxInputTokens', undefined), original);
		assert.deepStrictEqual(mergeOverride({ only: { reasoningEffort: 'low' } }, 'only', 'reasoningEffort', undefined), {});
	});

	test('sends only validated reasoning levels and omits the server default', async () => {
		const originalFetch = globalThis.fetch;
		const requests: Record<string, unknown>[] = [];
		const source = new vscode.CancellationTokenSource();
		globalThis.fetch = async (_url, init) => {
			requests.push(JSON.parse(String(init?.body)));
			return new Response('data: [DONE]\n\n');
		};
		try {
			for (const value of ['high', undefined, 'invalid', 'none']) {
				await streamChat('http://127.0.0.1:10531/v1', 'test-model', [], { toolMode: vscode.LanguageModelChatToolMode.Auto }, { report: () => undefined }, source.token, reasoningEffort(value));
			}
			assert.strictEqual(requests[0].reasoning_effort, 'high');
			assert.ok(!('reasoning_effort' in requests[1]));
			assert.ok(!('reasoning_effort' in requests[2]));
			assert.strictEqual(requests[3].reasoning_effort, 'none');
			assert.ok(requests.every(request => !('maxInputTokens' in request)));
		} finally { source.dispose(); globalThis.fetch = originalFetch; }
	});

	test('activates the ESM extension and registers its commands', async () => {
		const extension = vscode.extensions.all.find(candidate => candidate.packageJSON.name === 'code-openai-oauth' && candidate.extensionPath.replace(/\\/g, '/').endsWith('/code-openai-oauth'));
		assert.ok(extension, 'Development extension is installed');
		await extension.activate();
		assert.ok(extension.isActive);
		assert.ok((await vscode.commands.getCommands(true)).includes('code-openai-oauth.signIn'));
		assert.ok((await vscode.commands.getCommands(true)).includes('code-openai-oauth.configureModel'));
		assert.ok((await vscode.commands.getCommands(true)).includes('code-openai-oauth.showLogs'));
	});

	test('discovers every unique model including unknown IDs', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => Response.json({ object: 'list', data: [{ id: 'gpt-5.5' }, { id: 'future-model' }, { id: 'future-model' }] });
		const provider = new OAuthProvider(async () => 'http://127.0.0.1:10531/v1');
		try {
			const models = await provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);
			assert.deepStrictEqual(models.map(model => model.id), ['gpt-5.5', 'future-model']);
			assert.ok(models.every(model => model.capabilities?.imageInput === true));
			assert.strictEqual(models[1].maxInputTokens, 32000);
			assert.strictEqual(models[0].configurationSchema.properties.reasoningEffort.title, 'Reasoning level');
			assert.strictEqual(models[0].configurationSchema.properties.reasoningEffort.group, 'navigation');
			assert.ok(models[0].configurationSchema.properties.reasoningEffort.enum.includes('high'));
			assert.deepStrictEqual(models[0].configurationSchema.properties.reasoningEffort.enum, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
			assert.deepStrictEqual(models[0].configurationSchema.properties.reasoningEffort.enumItemLabels, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
			assert.strictEqual(models[0].configurationSchema.properties.reasoningEffort.default, 'medium');
		} finally { provider.dispose(); globalThis.fetch = originalFetch; }
	});

	test('applies saved context and reasoning only to the configured model', async function () {
		this.timeout(15000);
		const configuration = vscode.workspace.getConfiguration('code-openai-oauth');
		const original = configuration.inspect('modelOverrides')?.globalValue;
		const originalFetch = globalThis.fetch;
		const provider = new OAuthProvider(async () => 'http://127.0.0.1:10531/v1');
		const source = new vscode.CancellationTokenSource();
		const requests: Record<string, unknown>[] = [];
		globalThis.fetch = async (_url, init) => {
			if (!init?.body) { return Response.json({ data: [{ id: 'configured-test-model' }, { id: 'untouched-test-model' }] }); }
			requests.push(JSON.parse(String(init.body)));
			return new Response('data: [DONE]\n\n');
		};
		try {
			await configuration.update('modelOverrides', { 'configured-test-model': { maxInputTokens: 8192, reasoningEffort: 'low', imageInput: false } }, vscode.ConfigurationTarget.Global);
			const models = await provider.provideLanguageModelChatInformation({ silent: true }, source.token);
			assert.strictEqual(models[0].maxInputTokens, 8192);
			assert.strictEqual(models[1].maxInputTokens, 32000);
			assert.strictEqual(models[0].capabilities?.imageInput, false);
			assert.strictEqual(models[1].capabilities?.imageInput, true);
			for (const model of models) {
				await provider.provideLanguageModelChatResponse(model, [], { toolMode: vscode.LanguageModelChatToolMode.Auto }, { report: () => undefined }, source.token);
			}
			assert.strictEqual(requests[0].reasoning_effort, 'low');
			assert.ok(!('reasoning_effort' in requests[1]));
			for (const effort of ['high', 'none', 'default', 'invalid']) {
				await provider.provideLanguageModelChatResponse(models[0], [], { toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { reasoningEffort: effort } }, { report: () => undefined }, source.token);
			}
			assert.deepStrictEqual(requests.slice(2).map(request => request.reasoning_effort), ['high', 'none', 'low', 'low']);
			await configuration.update('modelOverrides', {}, vscode.ConfigurationTarget.Global);
			assert.strictEqual((await provider.provideLanguageModelChatInformation({ silent: true }, source.token))[0].maxInputTokens, 32000);
		} finally {
			await configuration.update('modelOverrides', original, vscode.ConfigurationTarget.Global);
			source.dispose(); provider.dispose(); globalThis.fetch = originalFetch;
		}
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

	test('sends user images alongside text in chat requests', async () => {
		const originalFetch = globalThis.fetch;
		let request: Record<string, unknown> = {};
		const events: string[] = [];
		globalThis.fetch = async (_url, init) => {
			request = JSON.parse(String(init?.body));
			return new Response('data: [DONE]\n\n');
		};
		try {
			const messages = [vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelTextPart('What is in this image?'),
				vscode.LanguageModelDataPart.image(new Uint8Array([0, 1, 255]), 'image/png'),
			])];
			await streamChat('http://127.0.0.1:10531/v1', 'test-model', messages, { toolMode: vscode.LanguageModelChatToolMode.Auto }, { report: () => undefined }, new vscode.CancellationTokenSource().token, undefined, event => events.push(event));
			assert.ok(events.some(event => /request bytes=\d+ images=1 imageBytes=3/.test(event)));
			assert.deepStrictEqual(request.messages, [{ role: 'user', content: [
				{ type: 'text', text: 'What is in this image?' },
				{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAH/' } },
			] }]);
		} finally { globalThis.fetch = originalFetch; }
	});

	test('identifies network failures after serializing an image without logging content', async () => {
		const originalFetch = globalThis.fetch;
		const events: string[] = [];
		globalThis.fetch = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('private URL'), { code: 'ECONNRESET' }) }); };
		try {
			await assert.rejects(streamChat('http://127.0.0.1:10531/v1', 'test-model', [vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelTextPart('private prompt'),
				vscode.LanguageModelDataPart.image(new Uint8Array([0, 1, 255]), 'image/png'),
			])], { toolMode: vscode.LanguageModelChatToolMode.Auto }, { report: () => undefined }, new vscode.CancellationTokenSource().token, undefined, event => events.push(event)), TypeError);
			assert.ok(events.some(event => event.includes('failed phase=fetch') && event.includes('reason=TypeError cause=ECONNRESET')));
			assert.ok(!events.join('\n').includes('private'));
		} finally { globalThis.fetch = originalFetch; }
	});

	test('identifies a closed server connection before image response headers', async () => {
		const originalFetch = globalThis.fetch;
		const events: string[] = [];
		globalThis.fetch = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('private URL'), { code: 'UND_ERR_SOCKET' }) }); };
		try {
			await assert.rejects(streamChat('http://127.0.0.1:10531/v1', 'test-model', [vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelTextPart('private prompt'),
				vscode.LanguageModelDataPart.image(new Uint8Array([0, 1, 255]), 'image/png'),
			])], { toolMode: vscode.LanguageModelChatToolMode.Auto }, { report: () => undefined }, new vscode.CancellationTokenSource().token, undefined, event => events.push(event)), TypeError);
			assert.ok(events.some(event => event.includes('cause=UND_ERR_SOCKET detail=local-server-closed-connection-before-headers')));
			assert.ok(!events.join('\n').includes('private'));
		} finally { globalThis.fetch = originalFetch; }
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

	test('records stream progress and aborts an idle response without logging content', async () => {
		const originalFetch = globalThis.fetch;
		const events: string[] = [];
		const secret = 'private prompt text';
		globalThis.fetch = async (_url, init) => new Response(new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"private reply"}}]}\n\n'));
				init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
			},
		}));
		try {
			await assert.rejects(streamChat('http://127.0.0.1:10531/v1', 'test-model', [{ role: vscode.LanguageModelChatMessageRole.User, name: undefined, content: [new vscode.LanguageModelTextPart(secret)] }], { toolMode: vscode.LanguageModelChatToolMode.Auto }, { report: () => undefined }, new vscode.CancellationTokenSource().token, undefined, (event, level) => events.push(`${level} ${event}`), 30), /idle for 30ms during stream/);
			assert.ok(events.some(event => event.includes('first chunk')));
			assert.ok(events.some(event => /^trace .* chunk=1 bytes=\d+/.test(event)));
			assert.ok(events.some(event => event.includes('idle timeout phase=stream')));
			assert.ok(events.some(event => event.includes('reason=idle-timeout')));
			assert.ok(!events.join('\n').includes(secret));
			assert.ok(!events.join('\n').includes('private reply'));
		} finally { globalThis.fetch = originalFetch; }
	});

	test('aborts an in-flight request when cancelled', async () => {
		const originalFetch = globalThis.fetch;
		const source = new vscode.CancellationTokenSource();
		const events: string[] = [];
		let fetchStarted: () => void = () => undefined;
		const started = new Promise<void>(resolve => { fetchStarted = resolve; });
		globalThis.fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
			fetchStarted();
		});
		try {
			const request = streamChat('http://127.0.0.1:10531/v1', 'test-model', [], { toolMode: vscode.LanguageModelChatToolMode.Auto }, { report: () => undefined }, source.token, undefined, event => events.push(event));
			await started;
			source.cancel();
			await assert.rejects(request, { name: 'AbortError' });
			assert.ok(events.some(event => event.includes('cancelled phase=fetch')));
			assert.ok(events.some(event => event.includes('failed phase=fetch') && event.includes('reason=AbortError')));
			assert.ok(!events.some(event => event.includes('idle timeout')));
		} finally { source.dispose(); globalThis.fetch = originalFetch; }
	});

	test('rejects a stream that closes without the completion marker', async () => {
		const originalFetch = globalThis.fetch;
		const parts: vscode.LanguageModelResponsePart[] = [];
		globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
		try {
			await assert.rejects(streamChat('http://127.0.0.1:10531/v1', 'test-model', [], { toolMode: vscode.LanguageModelChatToolMode.Auto }, { report: part => parts.push(part) }, new vscode.CancellationTokenSource().token), /Chat stream ended without \[DONE\]/);
			assert.deepStrictEqual(parts.map(part => (part as vscode.LanguageModelTextPart).value), ['partial']);
		} finally { globalThis.fetch = originalFetch; }
	});

	test('uses the configured idle timeout for new chat requests', async function () {
		this.timeout(15000);
		const configuration = vscode.workspace.getConfiguration('code-openai-oauth');
		const original = configuration.inspect('idleTimeoutSeconds')?.globalValue;
		const originalFetch = globalThis.fetch;
		const provider = new OAuthProvider(async () => 'http://127.0.0.1:10531/v1');
		const source = new vscode.CancellationTokenSource();
		globalThis.fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
		});
		try {
			await configuration.update('idleTimeoutSeconds', 1, vscode.ConfigurationTarget.Global);
			await assert.rejects(provider.provideLanguageModelChatResponse({ id: 'test-model' } as vscode.LanguageModelChatInformation, [], { toolMode: vscode.LanguageModelChatToolMode.Auto }, { report: () => undefined }, source.token), /idle for 1000ms during fetch/);
		} finally {
			await configuration.update('idleTimeoutSeconds', original, vscode.ConfigurationTarget.Global);
			source.dispose(); provider.dispose(); globalThis.fetch = originalFetch;
		}
	});

	test('filters diagnostic levels and prunes the extension archive', async function () {
		this.timeout(15000);
		const configuration = vscode.workspace.getConfiguration('code-openai-oauth');
		const originalLevel = configuration.inspect('diagnostics.level')?.globalValue;
		const originalRetention = configuration.inspect('diagnostics.retentionDays')?.globalValue;
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-diagnostics-'));
		const channel = vscode.window.createOutputChannel('OpenAI OAuth test', { log: true });
		const archive = path.join(directory, 'diagnostics');
		try {
			await configuration.update('diagnostics.level', 'error', vscode.ConfigurationTarget.Global);
			await configuration.update('diagnostics.retentionDays', 7, vscode.ConfigurationTarget.Global);
			const diagnostics = new Diagnostics(channel, vscode.Uri.file(directory));
			await diagnostics.flush();
			await fs.writeFile(path.join(archive, '2000-01-01.log'), 'old');
			diagnostics.log('info', 'hidden');
			diagnostics.log('warn', 'hidden warning');
			diagnostics.log('error', 'visible');
			await diagnostics.flush();
			const today = new Date().toISOString().slice(0, 10);
			assert.match(await fs.readFile(path.join(archive, `${today}.log`), 'utf8'), /visible/);
			assert.ok(!(await fs.readFile(path.join(archive, `${today}.log`), 'utf8')).includes('hidden'));
			await configuration.update('diagnostics.level', 'warn', vscode.ConfigurationTarget.Global);
			diagnostics.log('warn', 'recoverable');
			diagnostics.log('info', 'hidden info');
			await diagnostics.flush();
			assert.match(await fs.readFile(path.join(archive, `${today}.log`), 'utf8'), /\[warn\] recoverable/);
			assert.ok(!(await fs.readFile(path.join(archive, `${today}.log`), 'utf8')).includes('hidden info'));
			await configuration.update('diagnostics.level', 'info', vscode.ConfigurationTarget.Global);
			logServerEvent(diagnostics, { type: 'chat_response', requestId: 'server-info', path: '/v1/chat/completions', status: 200, durationMs: 42, stream: true, usage: { inputTokens: 4, outputTokens: 2 } });
			await diagnostics.flush();
			assert.match(await fs.readFile(path.join(archive, `${today}.log`), 'utf8'), /\[info\] server response id=server-info status=200 duration=42ms/);
			await configuration.update('diagnostics.level', 'trace', vscode.ConfigurationTarget.Global);
			diagnostics.log('trace', 'chunk=1 bytes=42');
			logServerEvent(diagnostics, { type: 'chat_request', requestId: 'server-1', path: '/v1/chat/completions', bodyKeys: ['messages'], messageCount: 1, messageRoles: ['user'], model: 'test-model', stream: true, toolCount: 0 });
			logServerEvent(diagnostics, { type: 'chat_response', requestId: 'server-1', path: '/v1/chat/completions', status: 200, durationMs: 42, stream: true, usage: { inputTokens: 4, outputTokens: 2 } });
			logServerEvent(diagnostics, { type: 'chat_error', requestId: 'server-2', path: '/v1/chat/completions', durationMs: 10, message: 'private prompt and credential' });
			logServerEvent(diagnostics, { type: 'chat_error', requestId: 'server-3', path: '/v1/chat/completions', durationMs: 11, message: 'HTTP 413: UND_ERR_SOCKET private prompt' });
			logServerEvent(diagnostics, { type: 'chat_error', requestId: 'server-4', path: '/v1/chat/completions', durationMs: 12, message: 'private prompt invalid_image' });
			logServerEvent(diagnostics, { type: 'chat_error', requestId: 'server-5', path: '/v1/chat/completions', durationMs: 13, message: 'Image rejected: private URL' });
			logServerEvent(diagnostics, { type: 'chat_error', requestId: 'server-6', path: '/v1/chat/completions', durationMs: 9, message: 'AI_DownloadError: Failed to download URL data:image/png;base64,PRIVATE' });
			await diagnostics.flush();
			const log = await fs.readFile(path.join(archive, `${today}.log`), 'utf8');
			assert.match(log, /\[trace\] chunk=1 bytes=42/);
			assert.match(log, /server request id=server-1 model=test-model messages=1 roles=user tools=0 stream=true/);
			assert.match(log, /server response id=server-1 status=200 duration=42ms stream=true.*inputTokens=4 outputTokens=2/);
			assert.match(log, /server error id=server-2 duration=10ms type=unknown category=upstream-error/);
			assert.match(log, /server error id=server-3 duration=11ms type=unknown category=upstream-error status=413 code=UND_ERR_SOCKET/);
			assert.match(log, /server error id=server-4 duration=12ms type=unknown category=invalid_image/);
			assert.match(log, /server error id=server-5 duration=13ms type=unknown category=image-error/);
			assert.match(log, /server error id=server-6 duration=9ms type=AI_DownloadError category=image-conversion signals=image,base64,data,url,download,failed messageLength=\d+ fingerprint=[0-9a-f]{12}/);
			assert.ok(!log.includes('private prompt and credential'));
			assert.ok(!log.includes('private prompt'));
			assert.ok(!log.includes('PRIVATE'));
			await assert.rejects(fs.access(path.join(archive, '2000-01-01.log')));
			await configuration.update('diagnostics.retentionDays', 0, vscode.ConfigurationTarget.Global);
			diagnostics.updateRetention();
			await diagnostics.flush();
			await assert.rejects(fs.access(path.join(archive, `${today}.log`)));
			diagnostics.dispose();
		} finally {
			channel.dispose();
			await configuration.update('diagnostics.level', originalLevel, vscode.ConfigurationTarget.Global);
			await configuration.update('diagnostics.retentionDays', originalRetention, vscode.ConfigurationTarget.Global);
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
