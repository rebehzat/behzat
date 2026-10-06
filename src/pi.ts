import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import type * as Pi from '@earendil-works/pi-coding-agent';

export type PiSdk = typeof Pi;
// The SDK is deliberately external to the executable. Pi can be updated without
// forking its source or recompiling the TUI; the release includes a pinned runtime.
export async function loadPi(): Promise<PiSdk> {
  if (process.env.BEHZAT_PI_PACKAGE) {
    return import(pathToFileURL(resolve(process.env.BEHZAT_PI_PACKAGE, 'dist/index.js')).href);
  }
  const executable = await realpath(process.execPath);
  const candidates = [
    join(dirname(executable), '../runtime/node_modules/@earendil-works/pi-coding-agent/dist/behzat-sdk.js'),
    join(homedir(), '.local/share/behzat/runtime/node_modules/@earendil-works/pi-coding-agent/dist/behzat-sdk.js'),
  ];
  for (const path of candidates) if (existsSync(path)) return import(pathToFileURL(path).href);
  return import(import.meta.resolve('@earendil-works/pi-coding-agent'));
}

export async function bundlePi(directory: string) {
  const dist = join(directory, 'node_modules/@earendil-works/pi-coding-agent/dist');
  const build = await Bun.build({ entrypoints: [join(dist, 'index.js')], target: 'bun', outdir: dist, naming: 'behzat-sdk.js' });
  if (!build.success) throw new AggregateError(build.logs, 'Pi SDK runtime bundle failed');
}
