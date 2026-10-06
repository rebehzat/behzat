import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const directory = await mkdtemp(join(tmpdir(), 'behzat-binary-'));
const server = Bun.serve({ port: 0, fetch: async request => {
  if (new URL(request.url).pathname === '/mcp') {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const message = await request.json() as { id?: number; method: string };
    if (message.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'binary-mcp', version: '1' } };
    else if (message.method === 'tools/list') result = { tools: [{ name: 'verify', inputSchema: { type: 'object' } }] };
    else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: 'Compiled MCP HTTP verified' }] };
    else return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Not found' } });
    return Response.json({ jsonrpc: '2.0', id: message.id, result });
  }
  const body = await request.json() as { messages: { role: string; content?: unknown }[] };
  const completed = body.messages.some(message => message.role === 'tool');
  const integration = JSON.stringify(body.messages).includes('Exercise MCP tools');
  const steps = [
    { name: 'mcp_connect', input: { server: 'local' } },
    { name: 'mcp_call', input: { server: 'local', tool: 'verify', input: {} } },
    { name: 'todo_update', input: { tasks: [{ id: 'smoke', text: 'Verify the binary integrations', status: 'done' }] } },
    { name: 'ask_user', input: { question: 'Headless questions should decline' } },
  ];
  const count = body.messages.filter(message => message.role === 'tool').length;
  const step = steps[count];
  const delta = integration
    ? step ? { tool_calls: [{ index: 0, id: `integration-${count}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.input) } }] }
      : { content: 'Binary integrations verified: ' + JSON.stringify(body.messages.filter(message => message.role === 'tool').map(message => message.content)) }
    : completed ? { content: 'Binary tool dispatch verified.' } : { tool_calls: [{ index: 0, id: 'write-smoke', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'smoke-result.txt', content: 'compiled runtime works' }) } }] };
  const events = [
    { id: 'smoke', choices: [{ index: 0, delta, finish_reason: null }] },
    { id: 'smoke', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }] },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
} });
try {
  const agentDir = join(directory, 'pi');
  await mkdir(join(agentDir, 'extensions'), { recursive: true });
  await writeFile(join(agentDir, 'extensions/poison.ts'), 'throw new Error("GLOBAL EXTENSION LOADED")');
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'behzat-smoke': {
    baseUrl: server.url.toString(), api: 'openai-completions', apiKey: 'local-smoke-key',
    models: [{ id: 'fake', name: 'Local smoke model', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
  } } }));
  const executable = resolve(process.argv[2] ?? 'dist/package/bin/behzat');
  for (const mode of ['--plan', '--auto-approve']) {
    const child = Bun.spawn([executable, '--cwd', directory, '--model', 'behzat-smoke/fake', mode, '-p', 'Write smoke-result.txt'], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, BEHZAT_HOME: join(directory, 'state'), PI_OFFLINE: '1' }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code || !stdout.includes('Binary tool dispatch verified')) throw new Error(`Binary smoke failed (${code}): ${stdout}\n${stderr}`);
    const exists = await Bun.file(join(directory, 'smoke-result.txt')).exists();
    if (exists !== (mode === '--auto-approve')) throw new Error(`Binary ${mode} approval enforcement failed`);
  }
  if (await readFile(join(directory, 'smoke-result.txt'), 'utf8') !== 'compiled runtime works') throw new Error('Binary output did not match');
  await writeFile(join(directory, 'state/mcp.json'), JSON.stringify({ servers: { local: { transport: 'http', url: new URL('mcp', server.url).toString() } } }));
  const integration = Bun.spawn([executable, '--cwd', directory, '--model', 'behzat-smoke/fake', '--auto-approve', '-p', 'Exercise MCP tools'], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, BEHZAT_HOME: join(directory, 'state'), PI_OFFLINE: '1' }, stdout: 'pipe', stderr: 'pipe',
  });
  const [output, errors, exit] = await Promise.all([new Response(integration.stdout).text(), new Response(integration.stderr).text(), integration.exited]);
  if (exit || !output.includes('Compiled MCP HTTP verified') || !output.includes('User declined to answer')) throw new Error(`Binary integrations failed: ${output}\n${errors}`);
  const tasks = await readdir(join(directory, 'state/todos'));
  if (!tasks.length || !(await Promise.all(tasks.map(async name => readFile(join(directory, 'state/todos', name), 'utf8')))).some(text => text.includes('Verify the binary integrations'))) throw new Error('Binary task persistence failed');
  console.log('Compiled binary: extensions, streaming, tools, plan mode, MCP, task persistence and headless questions pass.');
} finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
