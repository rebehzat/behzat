import { test, expect } from 'bun:test';
import { createTestRenderer } from '@opentui/core/testing';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalUI } from '../src/tui.ts';
import { Harness } from '../src/harness.ts';
import { Config } from '../src/config.ts';
import { TinyFish } from '../src/tinyfish.ts';
import { loadPi } from '../src/pi.ts';

async function setup(width = 110, height = 32) {
  const directory = await mkdtemp(join(tmpdir(), 'behzat-tui-'));
  const harness = new Harness(directory, Config.parse({ reducedMotion: true }), join(directory, 'state'));
  const pi = await loadPi(); harness.pi = pi;
  harness.runtime = await pi.ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const { session } = await pi.createAgentSession({ cwd: directory, modelRuntime: harness.runtime, sessionManager: pi.SessionManager.inMemory(directory), settingsManager: pi.SettingsManager.inMemory({}), resourceLoader: await (await import('../src/resources.ts')).resources(pi, directory), tools: [] });
  harness.session = session;
  const testRenderer = await createTestRenderer({ width, height, useMouse: true, kittyKeyboard: true });
  let quits = 0;
  const ui = new TerminalUI(testRenderer.renderer, harness, () => { quits++; });
  return { ...testRenderer, ui, harness, get quits() { return quits; }, cleanup: async () => { ui.close(); testRenderer.renderer.destroy(); await harness.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('quiet home layout hides inactive task panels at wide and narrow widths', async () => {
  const view = await setup();
  try {
    await view.renderOnce(); let frame = view.captureCharFrame();
    expect(frame).toContain('behzat'); expect(frame).toContain('Ask Behzat');
    expect(frame).not.toContain('ULTRACODE'); expect(frame).not.toContain('SUBAGENTS');
    view.resize(55, 24); await view.renderOnce(); frame = view.captureCharFrame();
    expect(frame).toContain('behzat'); expect(frame).toContain('Ask Behzat');
  } finally { await view.cleanup(); }
});

test('effort slider keyboard control and active task status are rendered', async () => {
  const view = await setup();
  try {
    view.mockInput.pressKey('e', { ctrl: true }); await view.renderOnce();
    expect(view.captureCharFrame()).toContain('Reasoning effort');
    view.mockInput.pressArrow('right'); await view.renderOnce();
    expect(view.captureCharFrame()).toContain('Selected: high');
    view.mockInput.pressEscape(); await Bun.sleep(40);
    view.harness.ultracode = true;
    view.harness.tasks.set('child', { id: 'child', prompt: 'inspect', mode: 'research', status: 'running' });
    view.ui.render(); await view.renderOnce();
    expect(view.captureCharFrame()).toContain('ULTRACODE'); expect(view.captureCharFrame()).toContain('1 subagent');
    expect(view.captureCharFrame()).toContain('SUBAGENTS');
    view.mockInput.pressKey('t', { ctrl: true }); await view.renderOnce();
    expect(view.captureCharFrame()).not.toContain('SUBAGENTS');
  } finally { await view.cleanup(); }
});

test('provider dialog preserves Pi provider list and secret entry is visually masked', async () => {
  const view = await setup();
  try {
    const login = view.ui.command('/login'); await Bun.sleep(5); await view.renderOnce();
    expect(view.captureCharFrame()).toContain('Connect a Pi provider');
    const cancelled = login.catch(error => error as Error);
    view.mockInput.pressEscape(); await Bun.sleep(40);
    const cancellation = await cancelled;
    expect(cancellation instanceof Error && cancellation.message).toBe('Cancelled');
    // Exercise the same login adapter through a controlled provider prompt, without
    // making an OAuth request or printing a credential in the transcript.
    const original = view.harness.login.bind(view.harness);
    view.harness.login = async (_provider, type, interaction) => {
      expect(type).toBe('api_key');
      const key = await interaction.prompt({ type: 'secret', message: 'Enter API key' });
      expect(key).toBe('private-test-key');
    };
    const request = view.ui.command('/apikey openai').catch(error => error as Error); await Bun.sleep(5);
    await view.renderOnce();
    if (view.captureCharFrame().includes('Login method')) { view.mockInput.pressArrow('down'); await Bun.sleep(10); view.mockInput.pressEnter(); await Bun.sleep(30); }
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain('Enter API key');
    await view.mockInput.typeText('private-test-key'); await view.renderOnce();
    const frame = view.captureCharFrame(); expect(frame).toContain('Enter API key'); expect(frame).not.toContain('private-test-key');
    view.mockInput.pressEnter(); await Bun.sleep(30); expect(await request).toBeUndefined(); view.harness.login = original;
    expect(view.harness.entries.some(entry => entry.text.includes('private-test-key'))).toBe(false);
  } finally { await view.cleanup(); }
});

test('agent question dialog accepts a suggested answer and dismisses cancellation', async () => {
  const view = await setup();
  try {
    const answer = view.harness.questions.ask('Which test scope?', ['Unit', 'Integration']);
    await Bun.sleep(25); await view.renderOnce();
    expect(view.captureCharFrame()).toContain('Which test scope?');
    view.mockInput.pressArrow('down'); view.mockInput.pressEnter();
    expect(await answer).toBe('Integration');
    await Bun.sleep(25);
    const declined = view.harness.questions.ask('Another question?').catch(error => error as Error);
    await Bun.sleep(25); view.mockInput.pressEscape();
    const error = await declined;
    if (!(error instanceof Error)) throw new Error('Expected question cancellation');
    expect(error.message).toBe('User declined to answer');
  } finally { await view.cleanup(); }
});

test('effort slider toggles Ultracode independently and cancelling preserves the session', async () => {
  const view = await setup();
  try {
    const select = view.ui.command('/effort'); await Bun.sleep(5);
    view.mockInput.pressArrow('left'); view.mockInput.pressTab(); await view.renderOnce();
    expect(view.captureCharFrame()).toContain('Selected: low');
    expect(view.captureCharFrame()).toContain('Ultracode: ON');
    view.mockInput.pressEnter(); await select;
    expect(view.harness.config.effort).toBe('low'); expect(view.harness.ultracode).toBe(true);
    await view.ui.command('/effort high'); expect(view.harness.ultracode).toBe(true);
    const cancelled = view.ui.command('/effort').catch(error => error as Error); await Bun.sleep(5);
    view.mockInput.pressTab(); view.mockInput.pressEscape(); await cancelled;
    expect(view.harness.ultracode).toBe(true); expect(view.harness.config.effort).toBe('high');
    await view.ui.command('/effort ultracode off'); expect(view.harness.ultracode).toBe(false);
  } finally { await view.cleanup(); }
});


test('Ctrl+D exits from the composer, a secret prompt, and active work', async () => {
  const view = await setup();
  try {
    view.mockInput.pressKey('d', { ctrl: true }); expect(view.quits).toBe(1);
    view.harness.busy = true;
    const key = view.ui.command('/apikey tinyfish').catch(() => {}); await Bun.sleep(5);
    view.mockInput.pressKey('d', { ctrl: true }); expect(view.quits).toBe(2);
    view.mockInput.pressEscape(); await key;
  } finally { await view.cleanup(); }
});

test('slash commands predict, select, complete, and execute without sending to the model', async () => {
  const view = await setup();
  try {
    await view.mockInput.typeText('/'); await Bun.sleep(40); await view.renderOnce();
    expect(view.captureCharFrame()).toContain('Search and switch Pi models');
    view.mockInput.pressArrow('down'); view.mockInput.pressTab(); await Bun.sleep(20);
    expect(view.ui.input.plainText).toBe('/login ');
    view.ui.input.setText('/term'); await Bun.sleep(20); view.mockInput.pressEnter();
    expect(view.ui.input.plainText).toBe('/terminal ');
    view.ui.input.setText('/appro'); await Bun.sleep(20); view.mockInput.pressEnter(); await Bun.sleep(20); await view.renderOnce();
    expect(view.captureCharFrame()).toContain('Tool approval mode');
    view.mockInput.pressArrow('down'); view.mockInput.pressEnter(); await Bun.sleep(30);
    expect(view.harness.permissions.mode).toBe('auto');
    expect(view.harness.entries.some(entry => entry.role === 'user')).toBe(false);
  } finally { await view.cleanup(); }
});

test('chooser searches provider catalog and TinyFish key persists privately without transcript exposure', async () => {
  const view = await setup();
  try {
    const choose = view.ui.command('/login').catch(() => {}); await Bun.sleep(5);
    await view.mockInput.typeText('anthropic'); await view.renderOnce();
    expect(view.captureCharFrame()).toContain('Anthropic');
    expect(view.captureCharFrame()).not.toContain('Amazon Bedrock');
    view.mockInput.pressEscape(); await choose;
    const request = view.ui.command('/apikey tinyfish'); await Bun.sleep(5);
    await view.mockInput.typeText('secret-tinyfish-test'); await view.renderOnce();
    expect(view.captureCharFrame()).not.toContain('secret-tinyfish-test');
    view.mockInput.pressEnter(); await request;
    const path = join(view.harness.home, 'tinyfish-auth.json');
    expect(JSON.parse(await readFile(path, 'utf8')).key).toBe('secret-tinyfish-test');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const restarted = new TinyFish('', (async (_url, options) => { expect(new Headers(options?.headers).get('X-API-Key')).toBe('secret-tinyfish-test'); return Response.json({ results: [] }); }) as typeof fetch);
    await restarted.loadKey(view.harness.home); await restarted.search({ query: 'test' });
    expect(view.harness.entries.some(entry => entry.text.includes('secret-tinyfish-test'))).toBe(false);
  } finally { await view.cleanup(); }
});

test('wide sidebar, bottom effort popover, and animated Ultracode survive terminal resizing', async () => {
  const view = await setup();
  try {
    await view.renderOnce(); expect(view.captureCharFrame()).toContain('PERMISSIONS');
    const select = view.ui.command('/effort').catch(() => {}); await Bun.sleep(5); await view.renderOnce();
    const lines = view.captureCharFrame().split('\n');
    expect(lines.findIndex(line => line.includes('Reasoning effort'))).toBeGreaterThan(12);
    view.mockInput.pressEscape(); await select;
    view.harness.config.reducedMotion = false; view.harness.ultracode = true; view.ui.render(); await view.renderOnce();
    const first = view.captureCharFrame(); const colors = JSON.stringify(view.captureSpans());
    await Bun.sleep(145); await view.renderOnce();
    expect(view.captureCharFrame()).not.toBe(first);
    expect(JSON.stringify(view.captureSpans())).not.toBe(colors);
    view.resize(55, 18); view.ui.render(); await view.renderOnce();
    expect(view.captureCharFrame()).toContain('Ask Behzat'); expect(view.captureCharFrame()).not.toContain('PERMISSIONS');
    const small = view.ui.command('/effort').catch(() => {}); await Bun.sleep(5); await view.renderOnce();
    expect(view.captureCharFrame()).toContain('Selected: medium');
    view.mockInput.pressEscape(); await small;
  } finally { await view.cleanup(); }
});


test('short command chooser keeps the selected item in view while navigating', async () => {
  const view = await setup(55, 18);
  try {
    const command = view.ui.command('/commands'); await Bun.sleep(5);
    for (let i = 0; i < 7; i++) view.mockInput.pressArrow('down');
    await view.renderOnce(); expect(view.captureCharFrame()).toContain('› /animations');
    view.mockInput.pressEnter(); await command; await Bun.sleep(20);
    await view.renderOnce(); expect(view.captureCharFrame()).toContain('Animations');
    view.mockInput.pressEscape();
  } finally { await view.cleanup(); }
});
