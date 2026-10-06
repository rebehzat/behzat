import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mcp } from '../src/mcp.ts';
import { TodoList } from '../src/todos.ts';
import { Questions } from '../src/questions.ts';

test('task lists survive resume, remain session-scoped, and reject ambiguous IDs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'behzat-todos-'));
  try {
    const list = new TodoList(dir);
    await list.load('session-a');
    await list.update([{ id: 'verify', text: 'Run tests', status: 'in_progress' }]);
    const recovered = new TodoList(dir); await recovered.load('session-a');
    expect(recovered.items[0].text).toBe('Run tests');
    await recovered.load('session-b'); expect(recovered.items).toEqual([]);
    await expect(recovered.update([{ id: 'a', text: 'one', status: 'pending' }, { id: 'a', text: 'two', status: 'done' }])).rejects.toThrow('Duplicate');
    await expect(recovered.load('../../bad')).rejects.toThrow('Invalid');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('user questions resolve answers and remove aborted requests', async () => {
  const questions = new Questions();
  questions.once('request', question => questions.answer(question.id, 'Use option B'));
  expect(await questions.ask('Which option?', ['A', 'B'])).toBe('Use option B');
  const controller = new AbortController();
  const pending = questions.ask('More detail?', [], controller.signal);
  controller.abort(new Error('cancelled'));
  await expect(pending).rejects.toThrow('cancelled'); expect(questions.pending.size).toBe(0);
});

test('official MCP client connects a real stdio server, discovers tools, calls and closes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'behzat-mcp-'));
  const mcp = new Mcp(dir);
  try {
    const script = join(dir, 'server.js');
    await writeFile(script, `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  else if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] };
  else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: 'echo:' + message.params.arguments.text }] };
  else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Not found' } }) + '\\n'); return; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});`);
    await writeFile(join(dir, 'mcp.json'), JSON.stringify({ servers: { fixture: { transport: 'stdio', command: process.execPath, args: [script] } } }));
    await mcp.connect('fixture', dir);
    expect(mcp.tools()[0].name).toBe('echo');
    expect(await mcp.call('fixture', 'echo', { text: 'hello ✓' })).toContain('echo:hello ✓');
    await expect(mcp.call('fixture', 'missing', {})).rejects.toThrow('Unknown');
    await mcp.disconnect('fixture'); expect(mcp.connections.size).toBe(0);
  } finally { await mcp.close(); await rm(dir, { recursive: true, force: true }); }
});

test('MCP HTTP resolves credentials from environment and masks protocol errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'behzat-mcp-http-'));
  const mcp = new Mcp(dir); let authorization = '';
  const server = Bun.serve({ port: 0, fetch: async request => {
    authorization = request.headers.get('Authorization') ?? '';
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const message = await request.json() as { id?: number; method: string };
    if (message.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1' } };
    else if (message.method === 'tools/list') result = { tools: [{ name: 'fail', inputSchema: { type: 'object' } }] };
    else return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'test-credential-must-not-leak' } });
    return Response.json({ jsonrpc: '2.0', id: message.id, result });
  } });
  const previous = process.env.BEHZAT_MCP_FIXTURE_TOKEN;
  process.env.BEHZAT_MCP_FIXTURE_TOKEN = 'Bearer test-credential-must-not-leak';
  try {
    await writeFile(join(dir, 'mcp.json'), JSON.stringify({ servers: { local: { transport: 'http', url: server.url.toString(), headers: { Authorization: 'BEHZAT_MCP_FIXTURE_TOKEN' } } } }));
    await mcp.connect('local', dir);
    expect(authorization).toBe('Bearer test-credential-must-not-leak');
    const error = await mcp.call('local', 'fail', {}).catch(error => error as Error);
    if (!(error instanceof Error)) throw new Error('Expected a protocol error');
    expect(error.message).toContain('failed'); expect(error.message).not.toContain('test-credential');
  } finally {
    await mcp.close(); server.stop(true); await rm(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.BEHZAT_MCP_FIXTURE_TOKEN; else process.env.BEHZAT_MCP_FIXTURE_TOKEN = previous;
  }
});
