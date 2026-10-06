import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface TerminalJob {
  id: string; command: string; cwd: string; status: 'running' | 'exited';
  output: string; exitCode: number | null; process: ChildProcess;
}
export class Terminals extends EventEmitter {
  jobs = new Map<string, TerminalJob>();
  start(command: string, cwd: string) {
    if ([...this.jobs.values()].filter(j => j.status === 'running').length >= 8) throw new Error('Eight background terminals are already running');
    const child = spawn(process.env.SHELL ?? '/bin/sh', ['-lc', command], {
      cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const job: TerminalJob = { id: crypto.randomUUID().slice(0, 8), command, cwd, status: 'running', output: '', exitCode: null, process: child };
    this.jobs.set(job.id, job);
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8');
      stream?.on('data', (chunk: Buffer) => { job.output = (job.output + decoder.write(chunk)).slice(-128_000); this.emit('change'); });
      stream?.on('end', () => { job.output = (job.output + decoder.end()).slice(-128_000); this.emit('change'); });
    }
    child.on('error', (error) => { job.output += `\n${error.message}`; this.emit('change'); });
    child.on('close', (code) => { job.status = 'exited'; job.exitCode = code; this.emit('change'); });
    this.emit('change');
    return job;
  }
  get(id: string) { const job = this.jobs.get(id); if (!job) throw new Error(`Unknown terminal ${id}`); return job; }
  send(id: string, input: string) {
    const job = this.get(id);
    if (job.status !== 'running') throw new Error('Terminal has exited');
    job.process.stdin?.write(input);
  }
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
