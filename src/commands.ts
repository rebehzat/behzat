export interface Command { name: string; description: string; usage?: string; children?: string[] }
export const commands: Command[] = [
  { name: '/models', description: 'Search and switch Pi models' },
  { name: '/login', description: 'Connect a provider with OAuth or an API key' },
  { name: '/apikey', description: 'Enter a masked provider or TinyFish API key' },
  { name: '/logout', description: 'Disconnect a provider' },
  { name: '/effort', description: 'Adjust reasoning effort and Ultracode', children: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] },
  { name: '/ultracode', description: 'Toggle Ultracode orchestration', children: ['on', 'off'] },
  { name: '/approval', description: 'Choose ask, auto approve, or plan mode', children: ['ask', 'auto', 'plan'] },
  { name: '/animations', description: 'Enable or disable animated status', children: ['on', 'off'] },
  { name: '/sidebar', description: 'Show or hide the session sidebar' },
  { name: '/commands', description: 'Search all commands' },
  { name: '/stop', description: 'Cancel active work, agents, and workflows' },
  { name: '/rename', description: 'Name the current session' },
  { name: '/new', description: 'Start a new session' },
  { name: '/resume', description: 'Search saved sessions' },
  { name: '/fork', description: 'Fork the current session' },
  { name: '/compact', description: 'Compact session context' },
  { name: '/context', description: 'Inspect context and session usage' },
  { name: '/export', description: 'Export the session to JSONL' },
  { name: '/diff', description: 'Show working tree changes' },
  { name: '/tasks', description: 'Show subagents, workflows, and terminals' },
  { name: '/subagent', description: 'Launch a background subagent', usage: '[worktree] PROMPT' },
  { name: '/workflow', description: 'Run or manage a saved workflow', usage: 'run FILE | resume ID | show ID | cancel ID', children: ['run', 'resume', 'show', 'cancel'] },
  { name: '/workflows', description: 'List saved workflows' },
  { name: '/deep-research', description: 'Research, challenge, verify, and synthesize', usage: 'QUESTION' },
  { name: '/terminal', description: 'Manage background terminals', usage: 'start COMMAND | read ID | stop ID | send ID TEXT', children: ['start', 'list', 'read', 'stop', 'send'] },
  { name: '/skill', description: 'Choose a project Markdown skill' },
  { name: '/todos', description: 'Show the session task list' },
  { name: '/mcp', description: 'Manage MCP connections and tools', children: ['list', 'connect', 'disconnect', 'tools'] },
  { name: '/help', description: 'Show commands and keyboard shortcuts' },
  { name: '/quit', description: 'Save and exit Behzat' },
];
export function match<T>(items: T[], query: string, label: (item: T) => string): T[] {
  const needle = query.toLowerCase().trim();
  return items.map((item, index) => {
    const text = label(item).toLowerCase();
    let score = text.startsWith(needle) ? 0 : text.includes(needle) ? 1 : 2;
    let cursor = 0;
    if (score === 2) for (const char of needle) { const at = text.indexOf(char, cursor); if (at < 0) { score = 3; break; } cursor = at + 1; }
    return { item, score, index };
  }).filter(item => item.score < 3).sort((a, b) => a.score - b.score || a.index - b.index).map(item => item.item);
}
