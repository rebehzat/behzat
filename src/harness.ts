import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { Type, type TSchema } from 'typebox';
import type { AgentSession, ModelRuntime, ToolDefinition, SessionManager } from '@earendil-works/pi-coding-agent';
import type { AuthInteraction, AuthType } from '@earendil-works/pi-ai';
import { loadPi, type PiSdk } from './pi.ts';
import { type Config, type Effort, stateDir, saveConfig } from './config.ts';
import { resources } from './resources.ts';
import { Permissions } from './permissions.ts';
import { Terminals } from './terminals.ts';
import { TinyFish } from './tinyfish.ts';
import { Workflows, type WorkflowRun } from './workflows.ts';
import { Slots } from './tasks.ts';

const execute = promisify(execFile);
export interface Entry { id: string; role: 'user' | 'assistant' | 'tool' | 'notice'; text: string; active?: boolean }
export interface AgentTask { id: string; prompt: string; mode: string; status: 'queued' | 'running' | 'done' | 'failed'; output?: string; worktree?: string }
export class Harness extends EventEmitter {
  pi!: PiSdk;
  runtime!: ModelRuntime;
  session?: AgentSession;
  readonly permissions: Permissions;
  readonly terminals = new Terminals();
  readonly tinyfish = new TinyFish();
  readonly workflows: Workflows;
  readonly tasks = new Map<string, AgentTask>();
  readonly entries: Entry[] = [];
  busy = false;
  ultracode = false;
  lastError?: string;
  private slots: Slots;
  private agents = new Set<AgentSession>();
  private controllers = new Set<AbortController>();
  private unsubscribe?: () => void;
  private streamingEntry?: Entry;
  private closed = false;
  private folder: string;

  constructor(readonly cwd: string, readonly config: Config, readonly home = stateDir()) {
    super();
    this.permissions = new Permissions(config.approval);
    this.slots = new Slots(config.concurrency);
    this.folder = join(home, 'sessions', Buffer.from(cwd).toString('base64url'));
    this.workflows = new Workflows(join(home, 'workflows'), config.concurrency, (prompt, options) => this.runAgent(prompt, options));
    for (const emitter of [this.permissions, this.terminals, this.workflows]) emitter.on('change', () => this.emit('change'));
  }
  async initialize(options: { resume?: string; continue?: boolean; runtime?: ModelRuntime } = {}) {
    this.pi = await loadPi();
    this.runtime = options.runtime ?? await this.pi.ModelRuntime.create();
    if (this.runtime.getError()) this.notice(this.runtime.getError()!);
    const manager = options.resume ? this.pi.SessionManager.open(options.resume, this.folder, this.cwd)
      : options.continue ? this.pi.SessionManager.continueRecent(this.cwd, this.folder)
      : this.pi.SessionManager.create(this.cwd, this.folder);
    await this.open(manager);
  }
  private async open(manager: SessionManager) {
    this.unsubscribe?.();
    this.session?.dispose();
    const model = this.config.model ? this.findModel(this.config.model) : undefined;
    const { session, extensionsResult } = await this.pi.createAgentSession({
      cwd: this.cwd, agentDir: this.home, modelRuntime: this.runtime, model,
      thinkingLevel: this.config.effort, resourceLoader: await resources(this.pi, this.cwd),
      settingsManager: this.pi.SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 }, cacheWarming: 'off' }),
      sessionManager: manager, tools: this.tools(this.cwd).map(tool => tool.name), customTools: this.tools(this.cwd),
    });
    if (extensionsResult.extensions.length) { session.dispose(); throw new Error('Behzat refuses sessions with Pi extensions'); }
    this.session = session;
    this.entries.length = 0;
    for (const message of session.messages) {
      if (message.role === 'user' || message.role === 'assistant') {
        const text = typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
        if (text) this.entries.push({ id: crypto.randomUUID(), role: message.role, text });
      }
    }
    this.unsubscribe = session.subscribe(event => {
      if (event.type === 'message_start' && event.message.role === 'assistant') {
        this.streamingEntry = { id: crypto.randomUUID(), role: 'assistant', text: '', active: true };
        this.entries.push(this.streamingEntry);
      }
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta' && this.streamingEntry) this.streamingEntry.text += event.assistantMessageEvent.delta;
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const text = event.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
        if (this.streamingEntry) { this.streamingEntry.text = text; this.streamingEntry.active = false; }
        if (event.message.errorMessage) { this.lastError = event.message.errorMessage; this.notice(event.message.errorMessage); }
        this.streamingEntry = undefined;
      }
      if (event.type === 'tool_execution_start') this.entries.push({ id: event.toolCallId, role: 'tool', text: `${event.toolName} ${JSON.stringify(event.args).slice(0, 200)}`, active: true });
      if (event.type === 'tool_execution_end') {
        const entry = this.entries.find(entry => entry.id === event.toolCallId);
        if (entry) { entry.active = false; entry.text = `${event.isError ? 'Failed' : 'Done'} · ${entry.text}`; }
      }
      if (event.type === 'compaction_start') this.notice('Compacting context…');
      if (event.type === 'auto_retry_start') this.notice('Retrying provider request…');
      this.emit('change');
    });
    this.emit('change');
  }
  notice(text: string) { this.entries.push({ id: crypto.randomUUID(), role: 'notice', text }); this.emit('change'); }
  findModel(name: string) {
    const models = this.runtime.getModels();
    const model = models.find(model => `${model.provider}/${model.id}` === name) ?? models.find(model => model.id === name);
    if (!model) throw new Error(`Unknown Pi model ${name}. Use /models to choose.`);
    return model;
  }
  async setModel(name: string) {
    if (this.busy) throw new Error('Wait for the current turn or cancel before changing models');
    const model = this.findModel(name);
    await this.session!.setModel(model);
    this.config.model = `${model.provider}/${model.id}`;
    this.session!.setThinkingLevel(this.config.effort);
    await saveConfig(this.config); this.emit('change');
  }
  async setEffort(effort: Effort, ultra = false) {
    this.config.effort = effort;
    this.ultracode = ultra;
    this.session!.setThinkingLevel(effort);
    await saveConfig(this.config); this.emit('change');
  }
  async login(provider: string, type: AuthType, interaction: AuthInteraction) {
    await this.runtime.login(provider, type, interaction);
    this.notice(`Connected ${provider}`);
  }
  async prompt(text: string) {
    if (!this.session) throw new Error('Session not initialized');
    if (this.busy) {
      await this.session.followUp(text);
      this.entries.push({ id: crypto.randomUUID(), role: 'user', text: `[queued] ${text}` }); this.emit('change'); return;
    }
    this.busy = true; this.lastError = undefined;
    this.entries.push({ id: crypto.randomUUID(), role: 'user', text }); this.emit('change');
    const instruction = this.ultracode
      ? '\n\n[Behzat Ultracode is enabled. For a substantive task, author and launch a workflow_run DAG with independent investigation, adversarial verification, and synthesis stages. Use worktree mode only for editing stages. For a simple task answer directly. Await background reports before claiming completion.]'
      : '';
    try { await this.session.prompt(text + instruction); }
    finally { this.busy = false; this.emit('change'); }
  }
  async abort() {
    this.permissions.cancelAll();
    this.workflows.cancelAll();
    for (const controller of this.controllers) controller.abort(new Error('Cancelled'));
    await Promise.all([this.session?.abort(), ...[...this.agents].map(session => session.abort())]);
  }
  async newSession() { if (this.busy) throw new Error('Cancel the current turn first'); await this.open(this.pi.SessionManager.create(this.cwd, this.folder)); }
  async resume(path: string) { if (this.busy) throw new Error('Cancel the current turn first'); await this.open(this.pi.SessionManager.open(path, this.folder, this.cwd)); }
  async fork() {
    if (this.busy) throw new Error('Cancel the current turn first');
    if (!this.session?.sessionFile) throw new Error('Send a message before forking this session');
    await this.open(this.pi.SessionManager.forkFrom(this.session.sessionFile, this.cwd, this.folder));
  }
  async diff() { const { stdout } = await execute('git', ['diff', '--stat'], { cwd: this.cwd }); const patch = await execute('git', ['diff', '--no-ext-diff'], { cwd: this.cwd, maxBuffer: 2_000_000 }); return stdout + '\n' + patch.stdout; }
  sessions() { return this.pi.SessionManager.list(this.cwd, this.folder); }
  async runAgent(prompt: string, options: { mode: 'research' | 'worktree'; model?: string; signal?: AbortSignal }): Promise<string> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const task: AgentTask = { id: crypto.randomUUID().slice(0, 8), prompt, mode: options.mode, status: 'queued' };
    this.tasks.set(task.id, task); this.emit('change');
    try {
      return await this.slots.run(async () => {
        task.status = 'running'; this.emit('change');
        let cwd = this.cwd;
        if (options.mode === 'worktree') {
          await this.permissions.require('worktree', { task: task.id, prompt }, signal);
          cwd = join(this.home, 'worktrees', task.id);
          await mkdir(join(this.home, 'worktrees'), { recursive: true });
          await execute('git', ['worktree', 'add', '--detach', cwd, 'HEAD'], { cwd: this.cwd, signal });
          task.worktree = cwd;
        }
        const toolDefinitions = this.tools(cwd, true, options.mode === 'research');
        const { session, extensionsResult } = await this.pi.createAgentSession({
          cwd, agentDir: this.home, modelRuntime: this.runtime,
          model: options.model ? this.findModel(options.model) : this.session?.model,
          thinkingLevel: this.config.effort,
          resourceLoader: await resources(this.pi, cwd, 'You are a bounded Behzat subagent. Complete only the assigned task. Cite file paths and evidence. Return a concise report. Do not spawn agents.'),
          settingsManager: this.pi.SettingsManager.inMemory({ cacheWarming: 'off' }),
          sessionManager: this.pi.SessionManager.create(cwd, join(this.home, 'agents', task.id)),
          tools: toolDefinitions.map(tool => tool.name), customTools: toolDefinitions,
        });
        if (extensionsResult.extensions.length) { session.dispose(); throw new Error('Extensions are forbidden in subagents'); }
        this.agents.add(session);
        let turns = 0; let limited = false;
        const cancel = () => { void session.abort(); };
        signal.addEventListener('abort', cancel, { once: true });
        const unsubscribe = session.subscribe(event => {
          if (event.type === 'turn_end' && ++turns >= this.config.maxAgentTurns) { limited = true; void session.abort(); }
        });
        try {
          signal.throwIfAborted(); await session.prompt(prompt); signal.throwIfAborted();
          if (limited) throw new Error(`Subagent turn limit (${this.config.maxAgentTurns}) reached`);
          const last = session.messages.findLast(message => message.role === 'assistant');
          if (last?.role === 'assistant' && last.errorMessage) throw new Error(last.errorMessage);
          let output = session.getLastAssistantText() ?? '';
          if (task.worktree) output += `\n\nChanges preserved in ${task.worktree}. Inspect with git diff; integrate explicitly.`;
          task.status = 'done'; task.output = output.slice(-64000); this.emit('change'); return task.output;
        } finally { unsubscribe(); signal.removeEventListener('abort', cancel); this.agents.delete(session); session.dispose(); }
      }, signal);
    } catch (error) {
      task.status = 'failed'; task.output = error instanceof Error ? error.message : String(error); this.emit('change'); throw error;
    } finally { this.controllers.delete(controller); }
  }
  async launchWorkflow(definition: unknown) {
    await this.permissions.require('workflow', definition);
    const { run, completion } = await this.workflows.launch(definition, this.cwd);
    completion.then(result => this.deliverWorkflow(result)).catch(error => this.notice(`Workflow ${run.id} failed: ${error.message}`));
    return run.id;
  }
  private async deliverWorkflow(run: WorkflowRun) {
    const report = run.definition.stages.map(stage => `## ${stage.id}\n${run.results[stage.id].result ?? ''}`).join('\n\n').slice(-100000);
    this.notice(`Workflow ${run.definition.name} completed. Run /workflow show ${run.id} to inspect all stages.`);
    if (this.closed || !this.session) return;
    if (this.busy) await this.session.followUp(`Workflow ${run.id} completed. Synthesize the findings and state any remaining work:\n${report}`);
    else void this.prompt(`Workflow ${run.id} completed. Synthesize the findings and state any remaining work:\n${report}`).catch(error => this.notice(error.message));
  }
  private tools(cwd: string, child = false, readOnly = false): ToolDefinition[] {
    const pi = this.pi;
    const definitions: ToolDefinition[] = [pi.defineTool(pi.createReadToolDefinition(cwd)), pi.defineTool(pi.createGrepToolDefinition(cwd)), pi.defineTool(pi.createFindToolDefinition(cwd)), pi.defineTool(pi.createLsToolDefinition(cwd))];
    if (!readOnly) {
      const guard = <P extends TSchema, D, S>(definition: ToolDefinition<P, D, S>) => pi.defineTool({ ...definition, execute: async (id, input, signal, update, context) => {
          await this.permissions.require(definition.name, input, signal);
          return definition.execute(id, input, signal, update, context);
        } });
      definitions.push(guard(pi.createBashToolDefinition(cwd)), guard(pi.createWriteToolDefinition(cwd)), guard(pi.createEditToolDefinition(cwd)));
    }
    const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: (typeof value === 'string' ? value : JSON.stringify(value, null, 2)).slice(0, 64000) }], details: {} });
    definitions.push(pi.defineTool({
      name: 'web_search', label: 'TinyFish search', description: 'Search the web through TinyFish. Returns titles, snippets and source URLs.',
      parameters: Type.Object({ query: Type.String(), purpose: Type.Optional(Type.String()), include_domains: Type.Optional(Type.String()), exclude_domains: Type.Optional(Type.String()), domain_type: Type.Optional(Type.Union([Type.Literal('web'), Type.Literal('news'), Type.Literal('research_paper')])) }),
      execute: async (_id, input, signal) => result(await this.tinyfish.search(input, signal)),
    }), pi.defineTool({
      name: 'web_fetch', label: 'TinyFish fetch', description: 'Fetch up to ten source URLs as markdown through TinyFish.',
      parameters: Type.Object({ urls: Type.Array(Type.String(), { minItems: 1, maxItems: 10 }) }),
      execute: async (_id, input, signal) => result(await this.tinyfish.fetch(input.urls, signal)),
    }));
    if (child) return definitions;
    definitions.push(pi.defineTool({
      name: 'subagent', label: 'Subagent', description: 'Run an independent bounded agent. Research mode has read/search tools only. Worktree mode edits an isolated git worktree and returns its location.',
      parameters: Type.Object({ prompt: Type.String(), mode: Type.Optional(Type.Union([Type.Literal('research'), Type.Literal('worktree')])), model: Type.Optional(Type.String()) }),
      execute: async (_id, input, signal) => result(await this.runAgent(input.prompt, { mode: input.mode ?? 'research', model: input.model, signal })),
    }), pi.defineTool({
      name: 'workflow_run', label: 'Workflow', description: 'Launch a durable background workflow DAG. Supply name and stages with id, prompt, dependsOn, and mode (research or worktree). Use independent investigation, verification, and synthesis. Completion reports arrive automatically. Do not claim completed work before the report.',
      parameters: Type.Object({ name: Type.String(), stages: Type.Array(Type.Object({ id: Type.String(), prompt: Type.String(), dependsOn: Type.Optional(Type.Array(Type.String())), mode: Type.Optional(Type.Union([Type.Literal('research'), Type.Literal('worktree')])), model: Type.Optional(Type.String()) }), { maxItems: 100, minItems: 1 }) }),
      execute: async (_id, input) => result({ workflow: await this.launchWorkflow(input), status: 'running' }),
    }), pi.defineTool({
      name: 'terminal_start', label: 'Background terminal', description: 'Start a background shell command without blocking the conversation. Poll with terminal_read, send input with terminal_send, cancel with terminal_stop.',
      parameters: Type.Object({ command: Type.String() }),
      execute: async (_id, input, signal) => {
        await this.permissions.require('terminal_start', input, signal);
        const job = this.terminals.start(input.command, cwd); return result({ id: job.id, status: job.status });
      },
    }), pi.defineTool({
      name: 'terminal_read', label: 'Terminal output', description: 'Read bounded recent output and exit status from a background terminal.', parameters: Type.Object({ id: Type.String() }),
      execute: async (_id, input) => { const job = this.terminals.get(input.id); return result({ id: job.id, output: job.output, status: job.status, exitCode: job.exitCode }); },
    }), pi.defineTool({
      name: 'terminal_send', label: 'Terminal input', description: 'Send text to a background terminal stdin.', parameters: Type.Object({ id: Type.String(), input: Type.String() }),
      execute: async (_id, input, signal) => { await this.permissions.require('terminal_send', input, signal); this.terminals.send(input.id, input.input); return result('Sent'); },
    }), pi.defineTool({
      name: 'terminal_stop', label: 'Stop terminal', description: 'Terminate a background terminal and its process group.', parameters: Type.Object({ id: Type.String() }),
      execute: async (_id, input) => { this.terminals.stop(input.id); return result('Stopping'); },
    }));
    return definitions;
  }
  async close() {
    this.closed = true;
    await this.abort();
    await this.workflows.waitForIdle();
    this.terminals.close();
    await Promise.allSettled([...this.terminals.jobs.values()].map(job => job.exited));
    this.unsubscribe?.(); this.session?.dispose();
  }
}
