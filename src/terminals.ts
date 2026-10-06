import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

export interface TerminalJob {
  id: string; command: string; cwd: string; status: 'running' | 'exited';
  output: string; exitCode: number | null; process: Bun.Subprocess;
  terminal: Bun.Terminal; exited: Promise<number>;
}
export class Terminals extends EventEmitter {
  jobs = new Map<string, TerminalJob>();
  start(command: string, cwd: string) {
    if ([...this.jobs.values()].filter(j => j.status === 'running').length >= 8) throw new Error('Eight background terminals are already running');
    const decoder = new StringDecoder('utf8');
    let output = '';
    let job: TerminalJob | undefined;
    const terminal = new Bun.Terminal({ cols: 120, rows: 30, data: (_terminal, bytes) => {
      output = (output + decoder.write(Buffer.from(bytes))).slice(-128_000);
      if (job) job.output = output;
      this.emit('change');
    } });
    const child = Bun.spawn([process.env.SHELL ?? '/bin/sh', '-lc', command], { cwd, terminal, detached: true });
    job = { id: crypto.randomUUID().slice(0, 8), command, cwd, status: 'running', output, exitCode: null, process: child, terminal, exited: child.exited };
    this.jobs.set(job.id, job);
    const current = job;
    current.exited = child.exited.then(code => {
      current.status = 'exited'; current.exitCode = code;
      current.output = (output + decoder.end()).slice(-128_000);
      terminal.close(); this.emit('change'); return code;
    });
    this.emit('change');
    return job;
  }
  get(id: string) { const job = this.jobs.get(id); if (!job) throw new Error(`Unknown terminal ${id}`); return job; }
  send(id: string, input: string) {
    const job = this.get(id);
    if (job.status !== 'running') throw new Error('Terminal has exited');
    job.terminal.write(input);
  }
  resize(id: string, columns: number, rows: number) { this.get(id).terminal.resize(columns, rows); }
  stop(id: string) {
    const job = this.get(id);
    if (job.status !== 'running') return;
    this.kill(job, 'SIGTERM');
    const timer = setTimeout(() => { if (job.status === 'running') this.kill(job, 'SIGKILL'); }, 1500);
    timer.unref();
  }
  private kill(job: TerminalJob, signal: NodeJS.Signals) {
    try {
      if (process.platform !== 'win32' && job.process.pid) process.kill(-job.process.pid, signal);
      else job.process.kill(signal);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  close() { for (const job of this.jobs.values()) this.stop(job.id); }
}
