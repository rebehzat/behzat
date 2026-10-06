export class Slots {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const abort = () => { this.waiting = this.waiting.filter(item => item !== ready); reject(signal?.reason); };
        this.waiting.push(ready);
        signal?.addEventListener('abort', abort, { once: true });
      });
    } else this.active++;
    try { signal?.throwIfAborted(); return await fn(); }
    finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }
}
