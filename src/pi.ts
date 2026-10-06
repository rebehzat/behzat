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
    join(dirname(executable), '../runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js'),
    join(homedir(), '.local/share/behzat/runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js'),
  ];
  for (const path of candidates) if (existsSync(path)) return import(pathToFileURL(path).href);
  return import(import.meta.resolve('@earendil-works/pi-coding-agent'));
}
