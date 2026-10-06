import { mkdir, cp, writeFile, readFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import manifest from '../package.json';
import { bundlePi } from '../src/pi.ts';

const root = join(import.meta.dir, '..');
const output = join(root, 'dist/package');
await mkdir(join(output, 'bin'), { recursive: true });
const build = await Bun.build({ entrypoints: [join(root, 'src/cli.ts')], target: 'bun', minify: true, compile: { outfile: join(output, 'bin/behzat') } });
if (!build.success) throw new AggregateError(build.logs, 'Binary compilation failed');
await chmod(join(output, 'bin/behzat'), 0o755);
await mkdir(join(output, 'runtime'), { recursive: true });
await cp(join(root, 'node_modules'), join(output, 'runtime/node_modules'), { recursive: true });
await bundlePi(join(output, 'runtime'));
await writeFile(join(output, 'runtime/package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { '@earendil-works/pi-coding-agent': manifest.dependencies['@earendil-works/pi-coding-agent'] } }, null, 2));
for (const name of ['LICENSE', 'README.md', 'upstream.json', 'THIRD_PARTY_NOTICES.md', 'licenses']) await cp(join(root, name), join(output, name), { recursive: true });
await cp(join(root, 'scripts/install.sh'), join(output, 'install.sh'));
console.log(`Built ${output}/bin/behzat with an independently updateable Pi runtime`);
