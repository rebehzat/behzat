import { EventEmitter } from 'node:events';
export interface Question { id: string; text: string; options: string[] }
export class Questions extends EventEmitter {
  readonly pending = new Map<string, { question: Question; finish: (answer?: string) => void }>();
  async ask(text: string, options: string[] = [], signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID(); const question = { id, text, options };
      const cleanup = () => { this.pending.delete(id); signal?.removeEventListener('abort', abort); this.emit('change'); };
      const abort = () => { cleanup(); reject(signal?.reason ?? new Error('Question cancelled')); };
      const finish = (answer?: string) => { cleanup(); answer === undefined ? reject(new Error('User declined to answer')) : resolve(answer); };
      this.pending.set(id, { question, finish }); signal?.addEventListener('abort', abort, { once: true });
      this.emit('request', question); this.emit('change');
    });
  }
  answer(id: string, value?: string) { this.pending.get(id)?.finish(value); }
  cancelAll() { for (const request of [...this.pending.values()]) request.finish(); }
}
