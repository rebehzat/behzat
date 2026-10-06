#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { realpath, readFile, mkdir, cp, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Harness } from './harness.ts';
import { readConfig, efforts, stateDir, type Effort } from './config.ts';
import { loadPi, bundlePi } from './pi.ts';
import manifest from '../package.json';

const help = `behzat ${manifest.version} — an independent Pi harness

Usage: behzat [options] [prompt]
       behzat doctor | providers | login | update-pi VERSION

  -p, --print TEXT     Headless prompt; read stdin when TEXT is -
  --model PROVIDER/ID  Select a Pi model
  --effort LEVEL       off, minimal, low, medium, high, xhigh, max, ultracode
  --ultracode          Enable automatic workflow orchestration
  --auto-approve      Approve tools automatically
  --plan              Read/search only; block mutations and shell commands
  --continue          Continue the last session in this directory
  --resume FILE       Resume a saved Pi session
  --cwd DIRECTORY     Work in another directory
  --json              Stream headless events as JSON lines
  --reduced-motion    Disable animated status
  --version           Print version
  --help              Print help

TUI: /models /login /effort /workflows /terminal /help
TinyFish: set TINYFISH_API_KEY in your shell.
Pi extension loading is always disabled.
`;

async function main() {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    print: { type: 'string', short: 'p' }, model: { type: 'string' }, effort: { type: 'string' },
    'auto-approve': { type: 'boolean' }, plan: { type: 'boolean' }, ultracode: { type: 'boolean' },
    continue: { type: 'boolean' }, resume: { type: 'string' }, cwd: { type: 'string' },
    json: { type: 'boolean' }, 'reduced-motion': { type: 'boolean' },
  } });
  if (values.help) { process.stdout.write(help); return; }
  if (values.version) { console.log(`behzat ${manifest.version}`); return; }
  if (positionals[0] === 'update-pi') { await updatePi(positionals[1]); return; }
  if (positionals[0] === 'doctor' || positionals[0] === 'providers') {
    const pi = await loadPi();
    const runtime = await pi.ModelRuntime.create();
    if (positionals[0] === 'providers') {
      console.log(runtime.getProviders().map(provider => `${provider.id}\t${provider.name}\t${provider.auth.oauth ? 'oauth ' : ''}${provider.auth.apiKey?.login ? 'api_key' : 'ambient'}`).join('\n')); return;
    }
    console.log(JSON.stringify({ behzat: manifest.version, pi: 'external SDK', extensions: 0, providers: runtime.getProviders().length, models: runtime.getModels().length, connectedModels: runtime.getAvailableSnapshot().length, tinyfish: Boolean(process.env.TINYFISH_API_KEY), state: stateDir(), runtimeError: runtime.getError() ?? null }, null, 2)); return;
  }
  const cwd = await realpath(resolve(values.cwd ?? process.cwd()));
  const config = await readConfig();
  if (values.model) config.model = values.model;
  if (values['auto-approve']) config.approval = 'auto';
  if (values.plan) config.approval = 'plan';
  if (values['reduced-motion']) config.reducedMotion = true;
  if (values.effort && values.effort !== 'ultracode') {
    if (!efforts.includes(values.effort as Effort)) throw new Error(`Unknown effort ${values.effort}`);
    config.effort = values.effort as Effort;
  }
  if (values.effort === 'ultracode') config.effort = 'xhigh';
  const harness = new Harness(cwd, config);
  harness.ultracode = Boolean(values.ultracode || values.effort === 'ultracode');
  await harness.initialize({ resume: values.resume, continue: values.continue });
  if (values.print !== undefined) {
    harness.permissions.on('request', request => { harness.permissions.answer(request.id, false); });
    harness.session!.subscribe(event => {
      if (values.json) process.stdout.write(JSON.stringify(event) + '\n');
      else if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') process.stdout.write(event.assistantMessageEvent.delta);
    });
    const prompt = values.print === '-' ? await new Response(Bun.stdin.stream()).text() : values.print;
    const stop = () => { void harness.abort(); };
    process.once('SIGINT', stop);
    try {
      await harness.prompt(prompt);
      // Workflows may have been launched by the first turn. Wait for all background
      // reports and synthesis before exiting the headless process.
      while (harness.busy || [...harness.workflows.runs.values()].some(run => run.status === 'running')) await Bun.sleep(50);
      if (harness.lastError || [...harness.workflows.runs.values()].some(run => run.status === 'failed')) process.exitCode = 1;
      if (!values.json) process.stdout.write('\n');
    } finally { const emitter: NodeJS.EventEmitter = process; emitter.removeListener('SIGINT', stop); await harness.close(); }
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) { await harness.close(); throw new Error('Interactive mode needs a terminal. Use behzat -p "prompt" for headless mode.'); }
  const { createCliRenderer } = await import('@opentui/core');
  const { TerminalUI } = await import('./tui.ts');
  let quitting = false;
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 60, maxFps: 60, useMouse: true, consoleMode: 'disabled', backgroundColor: '#0a0a0a' });
  const ui = new TerminalUI(renderer, harness, () => {
    if (quitting) return; quitting = true;
    void harness.close().finally(() => { ui.close(); renderer.destroy(); });
  });
  if (positionals[0] === 'login') void ui.command('/login').catch(error => harness.notice(error.message));
  else if (positionals.length) void harness.prompt(positionals.join(' ')).catch(error => harness.notice(error.message));
}

async function updatePi(version?: string) {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Usage: behzat update-pi X.Y.Z (choose an explicit stable release)');
  const executable = await realpath(process.execPath);
  const runtime = join(dirname(executable), '../runtime');
  if (!executable.includes('/behzat/') || !(await Bun.file(join(runtime, 'package.json')).exists())) throw new Error('Use the installed Behzat binary for runtime updates. Source development: update package.json and bun.lock through a PR.');
  const current = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8'));
  const npm = Bun.spawn(['npm', 'install', '--prefix', runtime, '--ignore-scripts', '--save-exact', `@earendil-works/pi-coding-agent@${version}`], { stdout: 'inherit', stderr: 'inherit' });
  if (await npm.exited) throw new Error('Pi update failed');
  try {
    await bundlePi(runtime);
    const check = Bun.spawn([executable, 'doctor'], { stdout: 'inherit', stderr: 'inherit' });
    if (await check.exited) throw new Error('Updated Pi SDK failed compatibility smoke check');
  } catch (error) {
    const previous = current.dependencies['@earendil-works/pi-coding-agent'];
    const rollback = Bun.spawn(['npm', 'install', '--prefix', runtime, '--ignore-scripts', '--save-exact', `@earendil-works/pi-coding-agent@${previous}`], { stdout: 'inherit', stderr: 'inherit' });
    await rollback.exited; await bundlePi(runtime); throw error;
  }
  console.log(`Pi updated to ${version}. Restart Behzat to use it.`);
}
main().catch(error => { console.error(`behzat: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
