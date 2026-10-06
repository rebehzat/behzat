import { readdir, readFile, mkdir, cp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const notices: string[] = [
  '# Third-party notices',
  'Behzat is MIT licensed. The OpenCode theme asset is copied from anomalyco/opencode v2 at the commit recorded in upstream.json. Its full MIT notice is in licenses/opencode-MIT.txt. Pi is used without source modifications; its MIT notice is in licenses/pi-MIT.txt.',
  'Claude Code public documentation informed an independent implementation. No Claude Code source or proprietary artwork is included. Behzat is not affiliated with Anthropic or OpenCode.',
  'The binary contains the Bun runtime (MIT); its license is at https://github.com/oven-sh/bun/blob/main/LICENSE.md. Installed packages and their notices are listed below. The release retains node_modules notices, including transitive licenses.',
  '| Package | Version | Declared license |', '| --- | --- | --- |',
];
const packages: string[] = [];
for (const entry of await readdir(join(root, 'node_modules'), { withFileTypes: true })) {
  if (entry.name.startsWith('.')) continue;
  if (entry.name.startsWith('@')) {
    for (const child of await readdir(join(root, 'node_modules', entry.name))) packages.push(join(entry.name, child));
  } else packages.push(entry.name);
}
await mkdir(join(root, 'licenses/dependencies'), { recursive: true });
for (const name of packages.sort()) {
  const directory = join(root, 'node_modules', name);
  try {
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    notices.push(`| ${pkg.name} | ${pkg.version} | ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? pkg.licenses ?? 'See package notices')} |`);
    for (const file of await readdir(directory)) if (/^(license|licence|copying|notice)(\.|$)/i.test(file)) {
      const target = join(root, 'licenses/dependencies', name.replace(/[/@]/g, '_') + '-' + file);
      await cp(join(directory, file), target, { recursive: true });
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
await writeFile(join(root, 'THIRD_PARTY_NOTICES.md'), notices.join('\n\n') + '\n');
console.log(`Recorded ${packages.length} dependency notices`);
