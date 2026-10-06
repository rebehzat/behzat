import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { atomicJson } from './config.ts';

const Todo = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), text: z.string().min(1).max(2000), status: z.enum(['pending', 'in_progress', 'done']) });
const Todos = z.array(Todo).max(100);
export type Todo = z.infer<typeof Todo>;
export class TodoList extends EventEmitter {
  items: Todo[] = [];
  private session?: string;
  private writes = Promise.resolve();
  constructor(private readonly directory: string) { super(); }
  async load(session: string) {
    await this.writes;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(session)) throw new Error('Invalid session ID');
    this.session = session;
    try { this.items = Todos.parse(JSON.parse(await readFile(join(this.directory, `${session}.json`), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.items = []; }
    this.emit('change');
  }
  async update(input: unknown) {
    const items = Todos.parse(input);
    if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('Duplicate task IDs');
    if (!this.session) throw new Error('No task-list session');
    const path = join(this.directory, `${this.session}.json`);
    this.items = items; this.emit('change');
    const write = this.writes.then(() => atomicJson(path, items));
    this.writes = write.catch(() => {});
    await write;
  }
  async close() { await this.writes; }
}
