import { test, expect } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Harness } from '../src/harness.ts';
import { Config } from '../src/config.ts';
import { loadPi } from '../src/pi.ts';

async function fixture(approval: 'ask' | 'auto' | 'plan') {
  const directory = await mkdtemp(join(tmpdir(), 'behzat-harness-'));
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch: async request => {
    const input = await request.json() as { messages: { role: string }[] };
    requests++;
    const completed = input.messages.some(message => message.role === 'tool');
    const delta = completed ? { content: 'The tool result has been checked.' } : { tool_calls: [{ index: 0, id: 'write-1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'result.txt', content: 'verified write' }) } }] };
    const chunks = [
      { id: 'fake', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] },
      { id: 'fake', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: completed ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  const pi = await loadPi();
  const runtime = await pi.ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider('behzat-test', { api: 'openai-completions', baseUrl: server.url.toString(), apiKey: 'local-test-key', models: [{ id: 'fake', name: 'Fake local model', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }] });
  const harness = new Harness(directory, Config.parse({ model: 'behzat-test/fake', approval }), join(directory, 'state'));
  await harness.initialize({ runtime });
  return { harness, directory, requests: () => requests, close: async () => { await harness.close(); server.stop(true); await rm(directory, { recursive: true, force: true }); } };
}

test('real Pi tool dispatch cannot bypass ask or plan guards', async () => {
  for (const mode of ['ask', 'plan'] as const) {
    const fixtureRun = await fixture(mode);
    try {
      let approvals = 0;
      fixtureRun.harness.permissions.on('request', request => { approvals++; fixtureRun.harness.permissions.answer(request.id, false); });
      await fixtureRun.harness.prompt('Write result.txt');
      expect(await Bun.file(join(fixtureRun.directory, 'result.txt')).exists()).toBe(false);
      expect(approvals).toBe(mode === 'ask' ? 1 : 0);
      expect(fixtureRun.requests()).toBe(2);
      expect(fixtureRun.harness.session!.getLastAssistantText()).toContain('checked');
    } finally { await fixtureRun.close(); }
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
