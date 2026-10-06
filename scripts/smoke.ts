import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const directory = await mkdtemp(join(tmpdir(), 'behzat-binary-'));
const server = Bun.serve({ port: 0, fetch: async request => {
  const body = await request.json() as { messages: { role: string }[] };
  const completed = body.messages.some(message => message.role === 'tool');
  const delta = completed ? { content: 'Binary tool dispatch verified.' } : { tool_calls: [{ index: 0, id: 'write-smoke', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'smoke-result.txt', content: 'compiled runtime works' }) } }] };
  const events = [
    { id: 'smoke', choices: [{ index: 0, delta, finish_reason: null }] },
    { id: 'smoke', choices: [{ index: 0, delta: {}, finish_reason: completed ? 'stop' : 'tool_calls' }] },
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
  console.log('Compiled binary: extension rejection, streamed model output, tool execution, plan enforcement and persistence pass.');
} finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
