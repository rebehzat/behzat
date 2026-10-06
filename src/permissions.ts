import { EventEmitter } from 'node:events';

export type ApprovalMode = 'ask' | 'auto' | 'plan';
export interface Approval { id: string; tool: string; input: unknown }
export class Permissions extends EventEmitter {
  mode: ApprovalMode;
  pending = new Map<string, { request: Approval; finish: (allowed: boolean) => void }>();
  constructor(mode: ApprovalMode = 'ask') { super(); this.mode = mode; }
  async require(tool: string, input: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.mode === 'plan') throw new Error(`Plan mode blocks ${tool}. Switch to ask or auto to execute.`);
    if (this.mode === 'auto') return;
    const allowed = await new Promise<boolean>((resolve, reject) => {
      const id = crypto.randomUUID();
      const request = { id, tool, input };
      const cleanup = () => { this.pending.delete(id); signal?.removeEventListener('abort', abort); this.emit('change'); };
      const abort = () => { cleanup(); reject(signal?.reason ?? new Error('Cancelled')); };
      this.pending.set(id, { request, finish: (value) => { cleanup(); resolve(value); } });
      signal?.addEventListener('abort', abort, { once: true });
      this.emit('request', request);
      this.emit('change');
    });
    if (!allowed) throw new Error(`User denied ${tool}`);
  }
  answer(id: string, allowed: boolean) { this.pending.get(id)?.finish(allowed); }
  cancelAll() { for (const pending of [...this.pending.values()]) pending.finish(false); }
}
