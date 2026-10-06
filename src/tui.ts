import {
  BoxRenderable, TextRenderable, TextareaRenderable, InputRenderable,
  ScrollBoxRenderable, MarkdownRenderable, SyntaxStyle,
  type CliRenderer, type KeyEvent, type PasteEvent, t, fg,
} from '@opentui/core';
import { basename, resolve, join } from 'node:path';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import type { AuthPrompt } from '@earendil-works/pi-ai';
import { Harness } from './harness.ts';
import { efforts, saveConfig, stateDir, type Effort } from './config.ts';
import { palette as p, rainbow, cleanTerminalText } from './theme.ts';
import type { Question } from './questions.ts';

interface Choice { label: string; detail?: string; value: string }
interface Dialog {
  kind: 'choose' | 'input' | 'effort'; title: string; choices: Choice[]; selected: number;
  secret?: boolean; resolve: (value: string) => void; reject: (error: Error) => void;
}
const commands = [
  '/models', '/login', '/logout', '/effort', '/ultracode', '/approval', '/new', '/resume', '/fork',
  '/compact', '/context', '/export', '/diff', '/tasks', '/subagent', '/workflow', '/workflows',
  '/deep-research', '/terminal', '/skill', '/todos', '/mcp', '/help', '/quit',
];

export class TerminalUI {
  readonly root: BoxRenderable;
  readonly input: TextareaRenderable;
  readonly history: ScrollBoxRenderable;
  private header: TextRenderable;
  private footer: TextRenderable;
  private live: TextRenderable;
  private hints: TextRenderable;
  private sidebar: BoxRenderable;
  private sideText: TextRenderable;
  private modal: BoxRenderable;
  private modalTitle: TextRenderable;
  private modalList: TextRenderable;
  private modalInput: InputRenderable;
  private secretMask: TextRenderable;
  private dialog?: Dialog;
  private presentingQuestion = false;
  private secretValue = '';
  private details = false;
  private phase = 0;
  private timer: ReturnType<typeof setInterval>;
  private scheduled?: ReturnType<typeof setTimeout>;
  private rows = new Map<string, { box: BoxRenderable; text: MarkdownRenderable | TextRenderable; value: string }>();
  private style = SyntaxStyle.fromStyles({
    default: { fg: p.text }, 'markup.heading': { fg: p.primary, bold: true },
    'markup.strong': { bold: true }, 'markup.italic': { italic: true },
    'markup.link': { fg: p.accent }, 'markup.raw': { fg: p.success },
    'punctuation': { fg: p.muted },
  });
  private change = () => this.schedule();
  private keypress = (key: KeyEvent) => this.key(key);
  private paste = (event: PasteEvent) => {
    if (!this.dialog?.secret) return;
    event.preventDefault();
    this.secretValue += new TextDecoder().decode(event.bytes).replace(/[\r\n]/g, '');
    this.modalInput.value = '•'.repeat(Math.min(this.secretValue.length, 60));
  };
  private closed = false;
  private historyItems: string[] = [];
  private historyIndex = 0;

  constructor(readonly renderer: CliRenderer, readonly harness: Harness, private readonly quit: () => void) {
    this.root = new BoxRenderable(renderer, { id: 'behzat', width: '100%', height: '100%', flexDirection: 'column', paddingX: 2, backgroundColor: p.background });
    renderer.root.add(this.root);
    this.header = new TextRenderable(renderer, { id: 'header', content: '', height: 2, flexShrink: 0, fg: p.muted });
    this.root.add(this.header);
    const body = new BoxRenderable(renderer, { id: 'body', flexGrow: 1, minHeight: 0, flexDirection: 'row' });
    this.root.add(body);
    this.history = new ScrollBoxRenderable(renderer, { id: 'transcript', flexGrow: 1, minWidth: 0, scrollY: true, stickyScroll: true, stickyStart: 'bottom', viewportCulling: true, contentOptions: { gap: 1, paddingRight: 1 } });
    body.add(this.history);
    this.sidebar = new BoxRenderable(renderer, { id: 'sidebar', width: 32, visible: false, border: ['left'], borderColor: p.border, paddingLeft: 2 });
    this.sideText = new TextRenderable(renderer, { id: 'task-details', content: '', fg: p.muted, wrapMode: 'word' });
    this.sidebar.add(this.sideText); body.add(this.sidebar);
    this.live = new TextRenderable(renderer, { id: 'live-status', content: '', height: 1, flexShrink: 0, visible: false });
    this.root.add(this.live);
    const composer = new BoxRenderable(renderer, { id: 'composer', flexDirection: 'column', backgroundColor: p.panel, border: ['left'], borderColor: p.primary, paddingX: 2, paddingY: 1, height: 6, flexShrink: 0 });
    this.root.add(composer);
    this.input = new TextareaRenderable(renderer, {
      id: 'prompt', height: 3, width: '100%', backgroundColor: p.panel, textColor: p.text,
      focusedBackgroundColor: p.panel, placeholder: 'Ask Behzat…   / commands',
      keyBindings: [{ name: 'return', action: 'submit' }, { name: 'return', shift: true, action: 'newline' }],
      onSubmit: () => { void this.submit(); },
    });
    composer.add(this.input);
    this.footer = new TextRenderable(renderer, { id: 'footer', content: '', height: 1, fg: p.muted });
    composer.add(this.footer);
    this.hints = new TextRenderable(renderer, { id: 'hints', content: 'ctrl+p commands   ctrl+e effort   shift+tab approvals   esc cancel', height: 1, flexShrink: 0, fg: p.muted, truncate: true });
    this.root.add(this.hints);
    this.modal = new BoxRenderable(renderer, { id: 'dialog', position: 'absolute', top: '12%', left: '5%', width: '90%', maxHeight: '75%', padding: 2, border: true, borderColor: p.border, backgroundColor: p.panel, zIndex: 10, visible: false });
    this.modalTitle = new TextRenderable(renderer, { id: 'dialog-title', content: '', fg: p.primary, marginBottom: 1 });
    this.modalList = new TextRenderable(renderer, { id: 'dialog-choices', content: '', fg: p.text, wrapMode: 'word', onMouseDown: event => this.selectSlider(event.x), onMouseDrag: event => this.selectSlider(event.x) });
    this.modalInput = new InputRenderable(renderer, { id: 'dialog-input', backgroundColor: p.panel, textColor: p.text, focusedBackgroundColor: p.panel, maxLength: 16000, placeholder: 'Type here…' });
    this.secretMask = new TextRenderable(renderer, { id: 'secret-mask', content: '', fg: p.text, visible: false });
    this.modal.add(this.modalTitle); this.modal.add(this.modalList); this.modal.add(this.secretMask); this.modal.add(this.modalInput);
    this.root.add(this.modal);
    this.modalInput.on('input', () => this.drawDialog());
    this.input.on('content-change', () => this.schedule());
    harness.on('change', this.change);
    renderer.keyInput.on('keypress', this.keypress);
    renderer.keyInput.on('paste', this.paste);
    renderer.on('resize', this.change);
    this.timer = setInterval(() => {
      if (!harness.config.reducedMotion && (harness.ultracode || harness.busy || this.activeTasks() || this.dialog?.kind === 'effort')) { this.phase++; this.schedule(); }
    }, 120);
    this.input.focus(); this.render();
  }
  private activeTasks() {
    return [...this.harness.tasks.values()].some(task => task.status === 'running' || task.status === 'queued') || [...this.harness.workflows.runs.values()].some(run => run.status === 'running') || [...this.harness.terminals.jobs.values()].some(job => job.status === 'running');
  }
  private schedule() {
    if (this.closed || this.scheduled) return;
    this.scheduled = setTimeout(() => { this.scheduled = undefined; this.render(); }, 16);
  }
  render() {
    const h = this.harness;
    const session = h.session;
    this.header.content = t`${fg(p.text)('behzat')}  ${basename(h.cwd)}${session?.sessionManager.getSessionName() ? ` · ${session.sessionManager.getSessionName()}` : ''}`;
    const entries = h.entries.slice(-400);
    const ids = new Set(entries.map(entry => entry.id));
    for (const [id, row] of this.rows) if (!ids.has(id)) { row.box.destroyRecursively(); this.rows.delete(id); }
    if (!entries.length && !this.rows.has('welcome')) {
      const box = new BoxRenderable(this.renderer, { id: 'welcome', marginTop: 3, paddingX: 2 });
      const text = new TextRenderable(this.renderer, { id: 'welcome-text', fg: p.muted, content: 'behzat\n\nBuild, investigate, and verify.\n\n/models  Choose a Pi model\n/login   Connect a provider\n/effort  Reasoning and Ultracode\n\nEnter to send · Shift+Enter for a new line', wrapMode: 'word' });
      box.add(text); this.history.add(box); this.rows.set('welcome', { box, text, value: '' });
    }
    if (entries.length && this.rows.has('welcome')) { this.rows.get('welcome')!.box.destroyRecursively(); this.rows.delete('welcome'); }
    for (const entry of entries) {
      let row = this.rows.get(entry.id);
      if (!row) {
        const box = new BoxRenderable(this.renderer, { id: `entry-${entry.id}`, paddingX: entry.role === 'user' ? 2 : 0, paddingY: entry.role === 'user' ? 1 : 0, backgroundColor: entry.role === 'user' ? p.panel : undefined, flexShrink: 0 });
        const text = entry.role === 'assistant'
          ? new MarkdownRenderable(this.renderer, { id: `text-${entry.id}`, content: '', syntaxStyle: this.style, fg: p.text, streaming: Boolean(entry.active), conceal: true })
          : new TextRenderable(this.renderer, { id: `text-${entry.id}`, content: '', fg: entry.role === 'tool' || entry.role === 'notice' ? p.muted : p.text, wrapMode: 'word' });
        box.add(text); this.history.add(box); row = { box, text, value: '' }; this.rows.set(entry.id, row);
      }
      const value = cleanTerminalText(entry.text || (entry.active ? 'Thinking…' : ''));
      if (row.value !== value) { row.text.content = value; row.value = value; }
      if (row.text instanceof MarkdownRenderable) row.text.streaming = Boolean(entry.active);
    }
    const usage = session?.getContextUsage();
    const stats = session?.getSessionStats();
    const model = session?.model;
    this.footer.content = `${h.permissions.mode}  ·  ${model ? `${model.provider}/${model.id}` : 'Choose a model'}  ·  ${session?.thinkingLevel ?? h.config.effort}${usage?.percent !== null && usage?.percent !== undefined ? `  ·  ${Math.round(usage.percent)}% context` : ''}${stats?.cost ? `  ·  $${stats.cost.toFixed(3)}` : ''}`;
    const agents = [...h.tasks.values()].filter(task => task.status === 'running' || task.status === 'queued').length;
    const workflows = [...h.workflows.runs.values()].filter(run => run.status === 'running').length;
    const terminals = [...h.terminals.jobs.values()].filter(job => job.status === 'running').length;
    const status = [h.busy ? `${['·', '•', '●', '•'][this.phase % 4]} working` : '', workflows ? `${workflows} workflow${workflows > 1 ? 's' : ''}` : '', agents ? `${agents} subagent${agents > 1 ? 's' : ''}` : '', terminals ? `${terminals} terminal${terminals > 1 ? 's' : ''}` : ''].filter(Boolean).join('  ·  ');
    const ultra = 'ULTRACODE'.split('').map((letter, index) => fg(rainbow[(index + this.phase) % rainbow.length])(letter));
    this.live.content = h.ultracode ? t`${ultra[0]}${ultra[1]}${ultra[2]}${ultra[3]}${ultra[4]}${ultra[5]}${ultra[6]}${ultra[7]}${ultra[8]}  ${status}` : status;
    this.live.visible = Boolean(status || h.ultracode);
    this.sidebar.visible = this.details && this.renderer.width >= 90;
    this.sideText.content = this.taskSummary();
    if (!this.dialog && h.permissions.pending.size) {
      const approval = [...h.permissions.pending.values()][0].request;
      this.hints.content = `ctrl+y allow · ctrl+n deny · ${approval.tool} ${JSON.stringify(approval.input).slice(0, 160)}`;
      this.hints.fg = p.primary;
    } else {
      const input = this.input.plainText;
      const suggestions = input.startsWith('/') && !input.includes(' ') ? commands.filter(command => command.startsWith(input)).slice(0, 5) : [];
      this.hints.content = suggestions.length ? suggestions.join('   ') : 'ctrl+p commands   ctrl+e effort   shift+tab approvals   esc cancel';
      this.hints.fg = p.muted;
    }
    this.drawDialog();
    if (!this.dialog && !this.presentingQuestion && h.questions.pending.size) {
      const question = [...h.questions.pending.values()][0].question;
      void this.showQuestion(question);
    }
  }
  private async showQuestion(question: Question) {
    this.presentingQuestion = true;
    this.harness.notice(question.text);
    try {
      const custom = '__behzat_custom_answer__';
      let answer = question.options.length ? await this.choose(cleanTerminalText(question.text).slice(0, 160), [...question.options.map((label, i) => ({ label: cleanTerminalText(label), value: String(i) })), { label: 'Type an answer…', value: custom }]) : custom;
      if (answer === custom) answer = await this.showDialog({ kind: 'input', title: 'Your answer', choices: [], selected: 0 });
      else answer = question.options[Number(answer)];
      this.harness.questions.answer(question.id, answer);
    } catch { this.harness.questions.answer(question.id); }
    finally { this.presentingQuestion = false; this.schedule(); }
  }
  private selectSlider(x: number) {
    if (this.dialog?.kind !== 'effort') return;
    this.dialog.selected = Math.max(0, Math.min(this.dialog.choices.length - 1, Math.floor((x - this.modalList.x) / 8)));
    this.drawDialog();
  }
  private taskSummary() {
    const h = this.harness;
    const sections: string[] = [];
    if (h.todos.items.length) sections.push('TASK LIST\n' + h.todos.items.map(item => `${item.status === 'done' ? '✓' : item.status === 'in_progress' ? '●' : '○'} ${item.text}`).join('\n'));
    if (h.mcp.connections.size) sections.push('MCP\n' + [...h.mcp.connections].map(([name, connection]) => `${name} · ${connection.tools.length} tools`).join('\n'));
    if (h.permissions.pending.size) sections.push('APPROVALS\n' + [...h.permissions.pending.values()].map(({ request }) => `${request.tool}\n${JSON.stringify(request.input).slice(0, 1500)}`).join('\n\n'));
    if (h.workflows.runs.size) sections.push('WORKFLOWS\n' + [...h.workflows.runs.values()].slice(-5).map(run => `${run.id.slice(0, 8)} ${run.definition.name}\n${run.status} · ${Object.values(run.results).filter(result => result.status === 'done').length}/${run.definition.stages.length}`).join('\n\n'));
    if (h.tasks.size) sections.push('SUBAGENTS\n' + [...h.tasks.values()].slice(-8).map(task => `${task.id} ${task.status}\n${task.prompt.slice(0, 70)}`).join('\n\n'));
    if (h.terminals.jobs.size) sections.push('TERMINALS\n' + [...h.terminals.jobs.values()].slice(-5).map(job => `${job.id} ${job.status}\n${job.command.slice(0, 70)}`).join('\n\n'));
    return cleanTerminalText(sections.join('\n\n') || 'No active tasks.');
  }
  private async submit() {
    const text = this.input.plainText.trim();
    if (!text) return;
    this.input.setText(''); this.historyItems.push(text); this.historyIndex = this.historyItems.length;
    try { if (text.startsWith('/')) await this.command(text); else await this.harness.prompt(text); }
    catch (error) { this.harness.notice(error instanceof Error ? error.message : String(error)); }
  }
  private key(key: KeyEvent) {
    if (this.dialog) {
      const dialog = this.dialog;
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) { key.preventDefault(); this.finishDialog(undefined); return; }
      if (key.name === 'return') { key.preventDefault(); this.finishDialog(dialog.kind === 'input' ? (dialog.secret ? this.secretValue : this.modalInput.value) : dialog.choices[dialog.selected]?.value); return; }
      if (dialog.secret) {
        key.preventDefault();
        if (key.name === 'backspace') this.secretValue = this.secretValue.slice(0, -1);
        else if (key.ctrl && key.name === 'u') this.secretValue = '';
        else if (!key.ctrl && !key.meta && (key.name.length === 1 || key.name === 'space')) {
          this.secretValue += key.name === 'space' ? ' ' : key.shift ? key.name.toUpperCase() : key.name;
        }
        this.modalInput.value = '•'.repeat(Math.min(this.secretValue.length, 60)); return;
      }
      if (dialog.kind !== 'input') {
        const direction = key.name === 'up' || key.name === 'left' ? -1 : key.name === 'down' || key.name === 'right' ? 1 : 0;
        if (direction) { key.preventDefault(); dialog.selected = (dialog.selected + direction + dialog.choices.length) % dialog.choices.length; this.drawDialog(); }
        if (key.name === 'tab' && dialog.kind === 'choose') { key.preventDefault(); dialog.selected = (dialog.selected + 1) % dialog.choices.length; this.drawDialog(); }
      }
      return;
    }
    if (key.ctrl && (key.name === 'y' || key.name === 'n')) {
      key.preventDefault(); const pending = [...this.harness.permissions.pending.values()][0];
      if (pending) this.harness.permissions.answer(pending.request.id, key.name === 'y'); return;
    }
    if (key.ctrl && key.name === 'p') { key.preventDefault(); void this.choose('Commands', commands.map(value => ({ label: value, value }))).then(value => this.command(value)).catch(error => this.harness.notice(error.message)); }
    else if (key.ctrl && key.name === 'e') { key.preventDefault(); void this.effort().catch(() => {}); }
    else if (key.ctrl && key.name === 't') { key.preventDefault(); this.details = !this.details; this.render(); }
    else if (key.name === 'tab' && key.shift) {
      key.preventDefault(); const modes = ['ask', 'auto', 'plan'] as const;
      this.harness.permissions.mode = modes[(modes.indexOf(this.harness.permissions.mode) + 1) % modes.length];
      this.harness.config.approval = this.harness.permissions.mode; void saveConfig(this.harness.config); this.render();
    } else if (key.name === 'escape') { key.preventDefault(); void this.harness.abort(); }
    else if (key.ctrl && key.name === 'c') {
      key.preventDefault(); if (this.harness.busy || this.activeTasks()) void this.harness.abort(); else this.quit();
    } else if (key.name === 'pageup' || key.name === 'pagedown') { key.preventDefault(); this.history.scrollBy(key.name === 'pageup' ? -10 : 10); }
    else if ((key.name === 'up' || key.name === 'down') && (key.ctrl || !this.input.plainText)) {
      key.preventDefault(); this.historyIndex = Math.max(0, Math.min(this.historyItems.length, this.historyIndex + (key.name === 'up' ? -1 : 1)));
      this.input.setText(this.historyItems[this.historyIndex] ?? '');
    } else if (key.name === 'tab' && this.input.plainText.startsWith('/')) {
      const completion = commands.find(command => command.startsWith(this.input.plainText));
      if (completion) { key.preventDefault(); this.input.setText(completion + ' '); }
    }
  }
  private choose(title: string, choices: Choice[], selected = 0) {
    if (!choices.length) return Promise.reject(new Error('No options available'));
    return this.showDialog({ kind: 'choose', title, choices, selected });
  }
  private showDialog(dialog: Omit<Dialog, 'resolve' | 'reject'>) {
    if (this.dialog) return Promise.reject(new Error('Close the current dialog first'));
    this.input.blur(); this.modalInput.value = ''; this.secretValue = '';
    return new Promise<string>((resolve, reject) => {
      this.dialog = { ...dialog, resolve, reject }; this.drawDialog();
      if (dialog.kind === 'input') this.modalInput.focus();
    });
  }
  private drawDialog() {
    const dialog = this.dialog;
    this.modal.visible = Boolean(dialog);
    if (!dialog) return;
    this.modalTitle.content = `${dialog.title}\nEnter confirm · Esc close`;
    this.modalInput.visible = dialog.kind === 'input';
    this.secretMask.visible = false;
    this.modalInput.textColor = p.text;
    this.modalInput.focusedTextColor = p.text;
    if (dialog.kind === 'input') this.modalList.content = '';
    else if (dialog.kind === 'effort') {
      const track = this.renderer.width >= 80 ? `${dialog.choices.map((_item, i) => i === dialog.selected ? '  ●     ' : '  ─     ').join('')}\n${dialog.choices.map(item => item.label.padEnd(8)).join('')}\n\n` : '';
      const selected = dialog.choices[dialog.selected].value;
      const info = `${track}Selected: ${selected}\nActual model effort: ${this.harness.session?.thinkingLevel ?? 'off'}\nUltracode adds automatic workflow orchestration.`;
      this.modalList.content = selected === 'ultracode' ? t`${fg(rainbow[this.phase % rainbow.length])(info)}` : info;
    } else {
      const begin = Math.max(0, dialog.selected - 5);
      this.modalList.content = dialog.choices.slice(begin, begin + 12).map((choice, i) => `${begin + i === dialog.selected ? '›' : ' '} ${choice.label}${choice.detail ? `  ${choice.detail}` : ''}`).join('\n');
    }
  }
  private finishDialog(value?: string) {
    const dialog = this.dialog;
    if (!dialog) return;
    this.dialog = undefined; this.modalInput.value = ''; this.secretValue = ''; this.modalInput.blur(); this.modal.visible = false; this.input.focus();
    if (value !== undefined) dialog.resolve(value); else dialog.reject(new Error('Cancelled'));
    this.schedule();
  }
  private async effort() {
    const choices = [...efforts.map(value => ({ label: value, value })), { label: 'ultra', value: 'ultracode' }];
    const value = await this.showDialog({ kind: 'effort', title: 'Reasoning effort · ← → or click the slider', choices, selected: this.harness.ultracode ? choices.length - 1 : efforts.indexOf(this.harness.config.effort) });
    await this.harness.setEffort(value === 'ultracode' ? 'xhigh' : value as Effort, value === 'ultracode');
  }
  private async authPrompt(prompt: AuthPrompt) {
    if (prompt.signal?.aborted) throw new Error('Login cancelled');
    const abort = () => this.finishDialog(undefined);
    prompt.signal?.addEventListener('abort', abort, { once: true });
    try {
      return prompt.type === 'select' ? await this.choose(prompt.message, prompt.options.map(option => ({ label: option.label, detail: option.description, value: option.id })))
        : await this.showDialog({ kind: 'input', title: prompt.message, choices: [], selected: 0, secret: prompt.type === 'secret' });
    } finally { prompt.signal?.removeEventListener('abort', abort); }
  }
  async command(text: string) {
    const space = text.indexOf(' ');
    const command = space < 0 ? text : text.slice(0, space);
    const args = space < 0 ? '' : text.slice(space + 1).trim();
    const h = this.harness;
    if (command === '/quit') { this.quit(); return; }
    if (command === '/help') { h.notice(commands.join('\n') + '\n\n/terminal start COMMAND | read ID | stop ID | send ID TEXT\n/workflow run FILE | show ID | resume ID | cancel ID\n/subagent [worktree] PROMPT\n/approval ask | auto | plan'); return; }
    if (command === '/models') {
      const available = new Set(h.runtime.getAvailableSnapshot().map(model => `${model.provider}/${model.id}`));
      const all = h.runtime.getModels();
      const value = args || await this.choose('Pi models · connected providers first', [...all].sort((a, b) => Number(available.has(`${b.provider}/${b.id}`)) - Number(available.has(`${a.provider}/${a.id}`))).map(model => ({ label: `${model.provider}/${model.id}`, detail: available.has(`${model.provider}/${model.id}`) ? 'connected' : 'login required', value: `${model.provider}/${model.id}` })));
      await h.setModel(value); return;
    }
    if (command === '/login') {
      if (h.busy) throw new Error('Cancel the current turn before logging in');
      const provider = args || await this.choose('Connect a Pi provider', h.runtime.getProviders().map(provider => ({ label: provider.name, value: provider.id })));
      const auth = h.runtime.getProvider(provider)?.auth;
      if (!auth) throw new Error(`Unknown provider ${provider}`);
      const types: Choice[] = [];
      if (auth.oauth) types.push({ label: 'Subscription / OAuth', value: 'oauth' });
      if (auth.apiKey?.login) types.push({ label: 'API key', value: 'api_key' });
      if (!types.length) { h.notice('This provider uses ambient credentials. Configure its environment/profile and restart Behzat.'); return; }
      const type = types.length === 1 ? types[0].value : await this.choose('Login method', types);
      const controller = new AbortController();
      await h.login(provider, type as 'oauth' | 'api_key', { signal: controller.signal, prompt: prompt => this.authPrompt(prompt), notify: event => {
        if (event.type === 'auth_url') h.notice(`Open in your browser: ${event.url}\n${event.instructions ?? ''}`);
        else if (event.type === 'device_code') h.notice(`Open ${event.verificationUri}\nCode: ${event.userCode}`);
        else h.notice(event.message);
      } }); return;
    }
    if (command === '/logout') { const provider = args || await this.choose('Disconnect provider', h.runtime.getProviders().map(provider => ({ label: provider.name, value: provider.id }))); await h.runtime.logout(provider); h.notice(`Disconnected ${provider}`); return; }
    if (command === '/effort') { if (!args) await this.effort(); else if (args === 'ultracode') await h.setEffort('xhigh', true); else if (efforts.includes(args as Effort)) await h.setEffort(args as Effort); else throw new Error('Unknown effort'); return; }
    if (command === '/ultracode') { h.ultracode = args === 'on' || (args !== 'off' && !h.ultracode); this.render(); return; }
    if (command === '/approval') {
      const mode = args || await this.choose('Tool approval mode', ['ask', 'auto', 'plan'].map(value => ({ label: value, value })));
      if (!['ask', 'auto', 'plan'].includes(mode)) throw new Error('Choose ask, auto, or plan');
      h.permissions.mode = mode as 'ask' | 'auto' | 'plan'; h.config.approval = h.permissions.mode; await saveConfig(h.config); this.render(); return;
    }
    if (command === '/new') { await h.newSession(); return; }
    if (command === '/resume') { const path = args || await this.choose('Resume session', (await h.sessions()).map(session => ({ label: session.name ?? session.firstMessage.slice(0, 80), detail: session.modified.toLocaleString(), value: session.path }))); await h.resume(path); return; }
    if (command === '/fork') { await h.fork(); return; }
    if (command === '/compact') { await h.session!.compact(args || undefined); h.notice('Context compacted'); return; }
    if (command === '/context') { h.notice(JSON.stringify({ model: h.session?.model?.id, effort: h.session?.thinkingLevel, usage: h.session?.getContextUsage(), stats: h.session?.getSessionStats(), extensions: 0 }, null, 2)); return; }
    if (command === '/export') { const path = h.session!.exportToJsonl(args ? resolve(h.cwd, args) : undefined); h.notice(`Exported ${path}`); return; }
    if (command === '/diff') { h.notice(await h.diff()); return; }
    if (command === '/tasks') { this.details = !this.details; if (this.renderer.width < 90) h.notice(this.taskSummary()); this.render(); return; }
    if (command === '/todos') { h.notice(h.todos.items.map(item => `${item.status} ${item.id}: ${item.text}`).join('\n') || 'No task list for this session'); return; }
    if (command === '/mcp') {
      const [action, name] = args.split(/\s+/, 2);
      if (action === 'connect' && name) { await h.connectMcp(name); h.notice(`Connected MCP ${name} · ${h.mcp.tools(name).length} tools`); }
      else if (action === 'disconnect' && name) { await h.mcp.disconnect(name); h.notice(`Disconnected MCP ${name}`); }
      else if (action === 'tools') h.notice(JSON.stringify(h.mcp.tools(name), null, 2));
      else if (!action || action === 'list') h.notice(Object.keys(await h.mcp.configured()).map(id => `${id} ${h.mcp.connections.has(id) ? 'connected' : 'disconnected'}`).join('\n') || `Configure servers in ${join(h.home, 'mcp.json')}`);
      else throw new Error('Usage: /mcp list | connect NAME | disconnect NAME | tools [NAME]');
      return;
    }
    if (command === '/subagent') {
      const worktree = args.startsWith('worktree ');
      const prompt = worktree ? args.slice(9) : args;
      if (!prompt) throw new Error('Usage: /subagent [worktree] PROMPT');
      void h.runAgent(prompt, { mode: worktree ? 'worktree' : 'research' }).then(output => h.notice(output)).catch(error => h.notice(error.message)); return;
    }
    if (command === '/workflows') { h.notice((await h.workflows.listSaved()).map(run => `${run.id} ${run.status} ${run.definition.name}`).join('\n') || 'No saved workflows'); return; }
    if (command === '/workflow') {
      const [action, value] = args.split(/\s+/, 2);
      if (action === 'run' && value) h.notice(`Started workflow ${await h.launchWorkflow(JSON.parse(await readFile(resolve(h.cwd, value), 'utf8')))}`);
      else if (action === 'resume' && value) void h.workflows.resume(value, h.cwd).then(run => h.notice(JSON.stringify(run.results, null, 2))).catch(error => h.notice(error.message));
      else if (action === 'cancel' && value) h.workflows.cancel(value);
      else if (action === 'show' && value) { const run = (await h.workflows.listSaved()).find(run => run.id === value || run.id.startsWith(value)); if (!run) throw new Error('Workflow not found'); h.notice(JSON.stringify(run, null, 2)); }
      else throw new Error('Usage: /workflow run FILE | resume ID | cancel ID | show ID'); return;
    }
    if (command === '/deep-research') {
      if (!args) throw new Error('Usage: /deep-research QUESTION');
      h.notice(`Started workflow ${await h.launchWorkflow({ name: `Research: ${args.slice(0, 80)}`, stages: [
        { id: 'research', prompt: `Use web_search and web_fetch to investigate: ${args}. Cite primary sources and record uncertainties.` },
        { id: 'counterpoint', prompt: `Independently investigate competing explanations and contrary evidence for: ${args}. Cite sources.` },
        { id: 'verify', dependsOn: ['research', 'counterpoint'], prompt: 'Cross-check every important claim against source evidence. Identify unsupported claims, errors, and unresolved disagreements.' },
        { id: 'synthesize', dependsOn: ['verify'], prompt: `Produce a concise cited report answering: ${args}. Include uncertainty. Only treat verified evidence as established.` },
      ] })}`); return;
    }
    if (command === '/terminal') {
      const separator = args.indexOf(' '); const action = separator < 0 ? args : args.slice(0, separator); const value = separator < 0 ? '' : args.slice(separator + 1);
      if (action === 'start' && value) { await h.permissions.require('terminal_start', { command: value }); const job = h.terminals.start(value, h.cwd); h.notice(`Terminal ${job.id} started`); }
      else if (action === 'stop') h.terminals.stop(value);
      else if (action === 'read') { const job = h.terminals.get(value); h.notice(`${job.id} ${job.status} exit=${job.exitCode}\n${job.output}`); }
      else if (action === 'send') { const i = value.indexOf(' '); await h.permissions.require('terminal_send', value); h.terminals.send(value.slice(0, i), value.slice(i + 1) + '\n'); }
      else throw new Error('Usage: /terminal start COMMAND | read ID | stop ID | send ID TEXT'); return;
    }
    if (command === '/skill') {
      const directories = [join(h.cwd, '.behzat/skills'), join(h.cwd, '.claude/skills')];
      const skills: Choice[] = [];
      for (const dir of directories) {
        try { for (const entry of await readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) skills.push({ label: entry.name, value: join(dir, entry.name, 'SKILL.md') }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const path = args ? skills.find(skill => skill.label === args)?.value : await this.choose('Markdown skills', skills);
      if (!path) throw new Error('Skill not found'); await h.prompt(`Follow these task instructions:\n${await readFile(path, 'utf8')}`); return;
    }
    throw new Error(`Unknown command ${command}. Use /help.`);
  }
  close() {
    this.closed = true; clearInterval(this.timer); if (this.scheduled) clearTimeout(this.scheduled);
    this.finishDialog(undefined); this.harness.off('change', this.change); this.renderer.off('resize', this.change); this.renderer.keyInput.off('keypress', this.keypress); this.renderer.keyInput.off('paste', this.paste);
    this.root.destroyRecursively(); this.style.destroy();
  }
}
