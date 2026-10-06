import { test, expect } from 'bun:test';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Permissions } from '../src/permissions.ts';
import { Workflows, validateWorkflow } from '../src/workflows.ts';
import { Terminals } from '../src/terminals.ts';
import { Slots } from '../src/tasks.ts';
import { TinyFish } from '../src/tinyfish.ts';
import { resources } from '../src/resources.ts';
import { loadPi } from '../src/pi.ts';

test('mutations require approval, cancellation removes pending requests, plan never approves', async () => {
  const permissions = new Permissions();
  const prompt = once(permissions, 'request');
  const run = permissions.require('bash', { command: 'touch file' });
  const [request] = await prompt;
  permissions.answer(request.id, false);
  await expect(run).rejects.toThrow('denied');
  const controller = new AbortController();
  const cancelled = permissions.require('edit', {}, controller.signal);
  controller.abort(new Error('stop'));
  await expect(cancelled).rejects.toThrow('stop');
  expect(permissions.pending.size).toBe(0);
  permissions.mode = 'plan';
  await expect(permissions.require('bash', {})).rejects.toThrow('Plan mode');
  permissions.mode = 'auto';
  await permissions.require('bash', {});
});

test('workflow validates dependency identity and cycles before starting agents', () => {
  expect(() => validateWorkflow({ name: 'bad', stages: [{ id: 'a', prompt: 'x', dependsOn: ['b'] }] })).toThrow('Missing');
  expect(() => validateWorkflow({ name: 'bad', stages: [{ id: 'a', prompt: 'x', dependsOn: ['a'] }] })).toThrow('cycle');
  expect(() => validateWorkflow({ name: 'bad', stages: [{ id: 'a', prompt: 'x' }, { id: 'a', prompt: 'x' }] })).toThrow('Duplicate');
});

test('parallel workflow checkpoints outputs and resume skips completed stages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'behzat-workflow-'));
  let concurrent = 0; let maximum = 0; const calls: string[] = [];
  const workflows = new Workflows(dir, 2, async (prompt) => {
    concurrent++; maximum = Math.max(maximum, concurrent); calls.push(prompt);
    await Bun.sleep(5); concurrent--; return `report:${prompt}`;
  });
  try {
    const run = await workflows.start({ name: 'test', stages: [{ id: 'a', prompt: 'a' }, { id: 'b', prompt: 'b' }, { id: 'c', prompt: 'c', dependsOn: ['a', 'b'] }] }, dir);
    expect(maximum).toBe(2);
    expect(run.status).toBe('done');
    expect(calls[2]).toContain('report:a');
    const saved = JSON.parse(await readFile(join(dir, `${run.id}.json`), 'utf8'));
    expect(saved.results.c.status).toBe('done');
    await workflows.resume(run.id, dir);
    expect(calls.length).toBe(3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('failed workflow blocks dependents and a new runtime can resume it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'behzat-resume-'));
  try {
    const failed = new Workflows(dir, 1, async () => { throw new Error('network down'); });
    await expect(failed.start({ name: 'test', stages: [{ id: 'a', prompt: 'first' }, { id: 'b', prompt: 'second', dependsOn: ['a'] }] }, dir)).rejects.toThrow('failed');
    const [saved] = await failed.listSaved();
    expect(saved.results.b.status).toBe('pending');
    const recovered = new Workflows(dir, 1, async () => 'recovered');
    const run = await recovered.resume(saved.id, dir);
    expect(run.status).toBe('done');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('agent slots keep global concurrency bounded and remove cancelled waiters', async () => {
  const slots = new Slots(1);
  let finish!: () => void;
  const first = slots.run(() => new Promise<void>(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const second = slots.run(async () => 'must not run', controller.signal);
  controller.abort(new Error('cancelled'));
  await expect(second).rejects.toThrow('cancelled');
  finish(); await first;
  expect(await slots.run(async () => 'third')).toBe('third');
});

test('background shell captures UTF-8, exit status, stdin and process cancellation', async () => {
  const terminals = new Terminals();
  try {
    const job = terminals.start('read line; printf "received:%s:✓" "$line"', tmpdir());
    const finished = once(job.process, 'close');
    terminals.send(job.id, 'hello\n'); await finished;
    expect(job.output).toContain('received:hello:✓'); expect(job.exitCode).toBe(0);
    const waiting = terminals.start('sleep 30', tmpdir());
    const stopped = once(waiting.process, 'close'); terminals.stop(waiting.id); await stopped;
    expect(waiting.status).toBe('exited');
  } finally { terminals.close(); }
});

test('TinyFish matches official endpoint and header and masks error bodies', async () => {
  let url = ''; let header = '';
  const server = Bun.serve({ port: 0, fetch: request => {
    url = request.url; header = request.headers.get('X-API-Key') ?? '';
    return Response.json({ results: [{ title: 'result', url: 'https://example.com' }] });
  } });
  const proxy: typeof fetch = ((input, options) => {
    const target = new URL(String(input));
    return fetch(`${server.url}${target.pathname.slice(1)}${target.search}`, options);
  }) as typeof fetch;
  try {
    await new TinyFish('test-secret', proxy).search({ query: 'a & b', include_domains: 'example.com' });
    expect(new URL(url).searchParams.get('query')).toBe('a & b'); expect(header).toBe('test-secret');
    await expect(new TinyFish(undefined, proxy).search({ query: 'x' })).rejects.toThrow('TINYFISH_API_KEY');
    await expect(new TinyFish('key', proxy).fetch(['file:///etc/passwd'])).rejects.toThrow();
  } finally { server.stop(true); }
});

test('poisoned project extensions are never loaded, even after reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'behzat-extensions-'));
  try {
    await mkdir(join(dir, '.pi/extensions'), { recursive: true });
    await writeFile(join(dir, '.pi/extensions/poison.ts'), 'throw new Error("EXTENSION EXECUTED")');
    await writeFile(join(dir, 'AGENTS.md'), 'Project instructions');
    const pi = await loadPi();
    const loader = await resources(pi, dir);
    const runtime = await pi.ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    const { session, extensionsResult } = await pi.createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, resourceLoader: loader, sessionManager: pi.SessionManager.inMemory(dir), settingsManager: pi.SettingsManager.inMemory({}), tools: [] });
    try {
      expect(extensionsResult.extensions).toEqual([]);
      await loader.reload(); expect(loader.getExtensions().extensions).toEqual([]);
      expect(session.systemPrompt).toContain('Project instructions');
      expect(runtime.getProviders().length).toBeGreaterThan(10);
      expect(runtime.getProviders().some(provider => provider.id === 'openai-codex' && provider.auth.oauth)).toBe(true);
    } finally { session.dispose(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
