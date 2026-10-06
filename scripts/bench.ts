import { createTestRenderer } from '@opentui/core/testing';
import { Harness } from '../src/harness.ts';
import { TerminalUI } from '../src/tui.ts';
import { Config } from '../src/config.ts';

const harness = new Harness('/tmp/behzat-benchmark', Config.parse({ reducedMotion: true }));
for (let i = 0; i < 400; i++) harness.entries.push({ id: String(i), role: i % 2 ? 'assistant' : 'user', text: `Message ${i}\nA small coding update with **markdown**, a path, and a result.` });
const test = await createTestRenderer({ width: 120, height: 40 });
const ui = new TerminalUI(test.renderer, harness, () => {});
try {
  await test.renderOnce();
  const durations: number[] = [];
  for (let i = 0; i < 100; i++) {
    harness.entries[399].text += ' token';
    const start = performance.now(); ui.render(); await test.renderOnce(); durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  console.log(JSON.stringify({ visibleHistory: 400, streamingUpdates: 100, medianMs: durations[50], p95Ms: durations[95], maximumMs: durations[99], note: 'Local native test-renderer measurement; model/network latency and comparisons with Codex are outside this benchmark.' }, null, 2));
} finally { ui.close(); test.renderer.destroy(); }
