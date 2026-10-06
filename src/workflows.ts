import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { z } from 'zod';
import { atomicJson } from './config.ts';

const Stage = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  prompt: z.string().min(1).max(32000),
  dependsOn: z.array(z.string()).default([]),
  mode: z.enum(['research', 'worktree']).default('research'),
  model: z.string().optional(),
});
export const Workflow = z.object({ name: z.string().min(1).max(100), stages: z.array(Stage).min(1).max(100) });
export type Workflow = z.infer<typeof Workflow>;
export interface StageResult { status: 'pending' | 'running' | 'done' | 'failed'; result?: string; error?: string }
export interface WorkflowRun {
  id: string; cwd: string; definition: Workflow;
  status: 'running' | 'done' | 'failed' | 'cancelled'; results: Record<string, StageResult>;
}
export type AgentRunner = (prompt: string, options: { mode: 'research' | 'worktree'; model?: string; signal: AbortSignal }) => Promise<string>;

export function validateWorkflow(input: unknown): Workflow {
  const workflow = Workflow.parse(input);
  const ids = new Set(workflow.stages.map(stage => stage.id));
  if (ids.size !== workflow.stages.length) throw new Error('Duplicate workflow stage IDs');
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('Workflow dependency cycle');
    if (visited.has(id)) return;
    const stage = workflow.stages.find(stage => stage.id === id);
    if (!stage) throw new Error(`Missing workflow dependency ${id}`);
    visiting.add(id);
    stage.dependsOn.forEach(visit);
    visiting.delete(id); visited.add(id);
  };
  ids.forEach(visit);
  return workflow;
}

export class Workflows extends EventEmitter {
  runs = new Map<string, WorkflowRun>();
  private controllers = new Map<string, AbortController>();
  private executions = new Set<Promise<WorkflowRun>>();
  constructor(private readonly directory: string, private readonly concurrency: number, private readonly runner: AgentRunner) { super(); }
  async start(input: unknown, cwd: string) {
    const { completion } = await this.launch(input, cwd);
    return completion;
  }
  async launch(input: unknown, cwd: string) {
    const definition = validateWorkflow(input);
    const run: WorkflowRun = { id: crypto.randomUUID(), cwd, definition, status: 'running', results: {} };
    for (const stage of definition.stages) run.results[stage.id] = { status: 'pending' };
    await this.save(run);
    this.runs.set(run.id, run);
    const completion = this.track(this.execute(run));
    return { run, completion };
  }
  async resume(id: string, cwd: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid workflow ID');
    if (this.controllers.has(id)) throw new Error('Workflow is already running');
    const run = JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8')) as WorkflowRun;
    run.definition = validateWorkflow(run.definition);
    if (run.cwd !== cwd) throw new Error(`Workflow belongs to ${run.cwd}`);
    for (const stage of run.definition.stages) if (run.results[stage.id]?.status !== 'done') run.results[stage.id] = { status: 'pending' };
    run.status = 'running';
    this.runs.set(id, run);
    return this.track(this.execute(run));
  }
  async listSaved(): Promise<WorkflowRun[]> {
    try {
      const files = await readdir(this.directory);
      return Promise.all(files.filter(file => /^[a-f0-9-]{36}\.json$/.test(file)).map(async file => JSON.parse(await readFile(join(this.directory, file), 'utf8')) as WorkflowRun));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  cancel(id: string) { this.controllers.get(id)?.abort(new Error('Workflow cancelled')); }
  cancelAll() { for (const controller of this.controllers.values()) controller.abort(new Error('Harness closing')); }
  async waitForIdle() { await Promise.allSettled([...this.executions]); }
  private track(completion: Promise<WorkflowRun>) {
    this.executions.add(completion);
    completion.then(() => this.executions.delete(completion), () => this.executions.delete(completion));
    return completion;
  }
  private async save(run: WorkflowRun) { await atomicJson(join(this.directory, `${run.id}.json`), run); }
  private async execute(run: WorkflowRun) {
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    this.emit('change');
    // Serial checkpoint writes prevent parallel agents replacing a newer snapshot.
    let checkpoint = Promise.resolve();
    const save = () => {
      const snapshot = structuredClone(run);
      checkpoint = checkpoint.then(() => this.save(snapshot));
      return checkpoint;
    };
    try {
      while (Object.values(run.results).some(result => result.status !== 'done')) {
        controller.signal.throwIfAborted();
        const ready = run.definition.stages.filter(stage => run.results[stage.id].status === 'pending' && stage.dependsOn.every(id => run.results[id].status === 'done')).slice(0, this.concurrency);
        if (!ready.length) throw new Error('Workflow blocked by failed dependencies');
        await Promise.all(ready.map(async stage => {
          run.results[stage.id] = { status: 'running' }; this.emit('change'); await save();
          try {
            const context = stage.dependsOn.map(id => `Dependency ${id}:\n${run.results[id].result}`).join('\n\n');
            const result = await this.runner(`${stage.prompt}\n\n${context}`, { mode: stage.mode, model: stage.model, signal: controller.signal });
            run.results[stage.id] = { status: 'done', result };
          } catch (error) { run.results[stage.id] = { status: 'failed', error: error instanceof Error ? error.message : String(error) }; }
          this.emit('change'); await save();
        }));
        if (Object.values(run.results).some(result => result.status === 'failed')) throw new Error('One or more workflow stages failed');
      }
      run.status = 'done';
    } catch (error) {
      run.status = controller.signal.aborted ? 'cancelled' : 'failed';
      throw error;
    } finally {
      this.controllers.delete(run.id);
      await save();
      this.emit('change');
    }
    return run;
  }
}
