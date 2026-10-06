import { test, expect } from 'bun:test';
import { createTestRenderer } from '@opentui/core/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalUI } from '../src/tui.ts';
import { Harness } from '../src/harness.ts';
import { Config } from '../src/config.ts';
import { loadPi } from '../src/pi.ts';

async function setup(width = 110) {
  const directory = await mkdtemp(join(tmpdir(), 'behzat-tui-'));
  const harness = new Harness(directory, Config.parse({ reducedMotion: true }), join(directory, 'state'));
  const pi = await loadPi(); harness.pi = pi;
  harness.runtime = await pi.ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const { session } = await pi.createAgentSession({ cwd: directory, modelRuntime: harness.runtime, sessionManager: pi.SessionManager.inMemory(directory), settingsManager: pi.SettingsManager.inMemory({}), resourceLoader: await (await import('../src/resources.ts')).resources(pi, directory), tools: [] });
  harness.session = session;
  const testRenderer = await createTestRenderer({ width, height: 32, useMouse: true, kittyKeyboard: true });
  const ui = new TerminalUI(testRenderer.renderer, harness, () => {});
  return { ...testRenderer, ui, harness, cleanup: async () => { ui.close(); testRenderer.renderer.destroy(); await harness.close(); await rm(directory, { recursive: true, force: true }); } };
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
    view.mockInput.pressKey('t', { ctrl: true }); await view.renderOnce();
    expect(view.captureCharFrame()).toContain('SUBAGENTS');
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
    view.harness.login = async (_provider, _type, interaction) => {
      const key = await interaction.prompt({ type: 'secret', message: 'Enter API key' });
      expect(key).toBe('private-test-key');
    };
    const request = view.ui.command('/login openai').catch(error => error as Error); await Bun.sleep(5);
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
