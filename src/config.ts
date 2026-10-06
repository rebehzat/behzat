import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';

export const efforts = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = typeof efforts[number];
export const Config = z.object({
  model: z.string().optional(),
  effort: z.enum(efforts).default('medium'),
  approval: z.enum(['ask', 'auto', 'plan']).default('ask'),
  concurrency: z.number().int().min(1).max(16).default(4),
  maxAgentTurns: z.number().int().min(1).max(200).default(24),
  reducedMotion: z.boolean().default(false),
});
export type Config = z.infer<typeof Config>;
export function stateDir() {
  return process.env.BEHZAT_HOME ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'behzat');
}
export async function readConfig(): Promise<Config> {
  try { return Config.parse(JSON.parse(await readFile(join(stateDir(), 'config.json'), 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Config.parse({});
    throw error;
  }
}
export async function atomicJson(path: string, value: unknown) {
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}
export async function saveConfig(config: Config, directory = stateDir()) {
  await atomicJson(join(directory, 'config.json'), Config.parse(config));
}
