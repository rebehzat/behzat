import { test, expect } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Harness } from '../src/harness.ts';
import { Config } from '../src/config.ts';
import { loadPi } from '../src/pi.ts';

async function fixture(approval: 'ask' | 'auto' | 'plan', workflow = false, tool = 'write') {
  const directory = await mkdtemp(join(tmpdir(), 'behzat-harness-'));
  let requests = 0;
  const bodies: unknown[] = [];
  const server = Bun.serve({ port: 0, fetch: async request => {
    const input = await request.json() as { messages: { role: string }[] };
    requests++;
    bodies.push(input);
    const completed = input.messages.some(message => message.role === 'tool');
    const initial = JSON.stringify(input.messages).includes('Launch the review');
    const synthesis = JSON.stringify(input.messages.at(-1)).includes('Do not start another workflow');
    if (workflow && !initial) await Bun.sleep(30);
    const delta = workflow
      ? synthesis ? { content: 'Synthesis complete.' }
        : completed ? { content: 'Waiting for workflow report.' }
        : initial ? { tool_calls: [{ index: 0, id: 'workflow-1', type: 'function', function: { name: 'workflow_run', arguments: JSON.stringify({ name: 'review', stages: [{ id: 'inspect', prompt: 'Inspect the code' }] }) } }] }
        : { content: 'Independent verified finding.' }
      : completed ? { content: 'The tool result has been checked.' } : { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: tool, arguments: JSON.stringify(tool === 'write' ? { path: 'result.txt', content: 'verified write' } : { server: 'fixture', tool: 'echo', input: { text: 'hello' } }) } }] };
    const chunks = [
      { id: 'fake', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] },
      { id: 'fake', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  const pi = await loadPi();
  const runtime = await pi.ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider('behzat-test', { api: 'openai-completions', baseUrl: server.url.toString(), apiKey: 'local-test-key', models: [{ id: 'fake', name: 'Fake local model', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }] });
  const harness = new Harness(directory, Config.parse({ model: 'behzat-test/fake', approval }), join(directory, 'state'));
  await harness.initialize({ runtime });
  return { harness, directory, bodies, requests: () => requests, close: async () => { await harness.close(); server.stop(true); await rm(directory, { recursive: true, force: true }); } };
}

test('Ultracode workflow runs real subagents and synthesizes without recursively orchestrating', async () => {
  const run = await fixture('auto', true);
  try {
    run.harness.ultracode = true;
    await run.harness.prompt('Launch the review');
    await run.harness.workflows.waitForIdle();
    for (let i = 0; i < 200 && run.harness.busy; i++) await Bun.sleep(5);
    expect(run.harness.session!.getLastAssistantText()).toBe('Synthesis complete.');
    expect(run.harness.tasks.size).toBe(1);
    expect([...run.harness.workflows.runs.values()][0].status).toBe('done');
    const last = run.bodies.at(-1) as { messages: unknown[] };
    expect(JSON.stringify(last.messages.at(-1))).toContain('Independent verified finding.');
    expect(JSON.stringify(last.messages.at(-1))).not.toContain('[Behzat Ultracode');
    expect(run.requests()).toBe(4);
  } finally { await run.close(); }
});

test('real Pi tool dispatch cannot bypass ask or plan guards', async () => {
  for (const tool of ['write', 'mcp_call']) {
  for (const mode of ['ask', 'plan'] as const) {
    const fixtureRun = await fixture(mode, false, tool);
    try {
      let remoteCalls = 0;
      fixtureRun.harness.mcp.call = async () => { remoteCalls++; return 'Should not execute'; };
      let approvals = 0;
      fixtureRun.harness.permissions.on('request', request => { approvals++; fixtureRun.harness.permissions.answer(request.id, false); });
      await fixtureRun.harness.prompt('Write result.txt');
      expect(await Bun.file(join(fixtureRun.directory, 'result.txt')).exists()).toBe(false);
      expect(approvals).toBe(mode === 'ask' ? 1 : 0);
      expect(remoteCalls).toBe(0);
      expect(fixtureRun.requests()).toBe(2);
      expect(fixtureRun.harness.session!.getLastAssistantText()).toContain('checked');
    } finally { await fixtureRun.close(); }
  }
  }
});

test('auto approval dispatch writes, streams, and persists a resumable session', async () => {
  const fixtureRun = await fixture('auto');
  try {
    await fixtureRun.harness.prompt('Write result.txt');
    expect(await readFile(join(fixtureRun.directory, 'result.txt'), 'utf8')).toBe('verified write');
    expect(fixtureRun.harness.entries.some(entry => entry.role === 'assistant' && entry.text.includes('checked'))).toBe(true);
    const path = fixtureRun.harness.session!.sessionFile!;
    await fixtureRun.harness.resume(path);
    expect(fixtureRun.harness.session!.getLastAssistantText()).toContain('checked');
    expect(fixtureRun.harness.session!.getActiveToolNames()).toContain('workflow_run');
  } finally { await fixtureRun.close(); }
});

test('cancel aborts a real Pi OAuth login waiting outside a prompt', async () => {
  const run = await fixture('ask');
  try {
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    let signal!: AbortSignal;
    const native = run.harness.runtime.getProvider('openai-codex')!;
    run.harness.runtime.registerNativeProvider({ ...native, id: 'behzat-auth-fixture', name: 'Auth fixture', auth: { oauth: {
      ...native.auth.oauth!, login: async interaction => {
        signal = interaction.signal; ready();
        return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
    } } });
    const login = run.harness.login('behzat-auth-fixture', 'oauth', { prompt: async () => '', notify: () => {} }).catch(error => error as Error);
    await started; expect(run.harness.authenticating).toBe('behzat-auth-fixture');
    await run.harness.abort();
    expect(signal.aborted).toBe(true); expect(await login).toBeInstanceOf(Error);
    expect(run.harness.authenticating).toBeUndefined();
    expect(run.harness.entries.some(entry => entry.text === 'Connected behzat-auth-fixture')).toBe(false);
  } finally { await run.close(); }
});
