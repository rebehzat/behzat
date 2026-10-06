import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { Client, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import manifest from '../package.json';

const environmentNames = z.record(z.string(), z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/));
const Server = z.discriminatedUnion('transport', [
  z.object({ transport: z.literal('stdio'), command: z.string().min(1), args: z.array(z.string()).default([]), env: environmentNames.default({}) }),
  z.object({ transport: z.literal('http'), url: z.string().url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol)), headers: environmentNames.default({}) }),
]);
const File = z.object({ servers: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), Server) });
export type McpServerConfig = z.infer<typeof Server>;
interface Connection { client: Client; tools: Tool[] }
export class Mcp extends EventEmitter {
  readonly connections = new Map<string, Connection>();
  private connecting = new Map<string, AbortController>();
  constructor(private readonly directory: string) { super(); }
  async configured() {
    try { return File.parse(JSON.parse(await readFile(join(this.directory, 'mcp.json'), 'utf8'))).servers; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('Invalid Behzat mcp.json; check the documented configuration format'); }
  }
  async connect(name: string, cwd: string, signal?: AbortSignal) {
    if (this.connections.has(name)) return;
    if (this.connecting.has(name)) throw new Error(`MCP ${name} is already connecting`);
    const server = (await this.configured())[name];
    if (!server) throw new Error(`MCP server ${name} is not configured in mcp.json`);
    const resolveEnvironment = (references: Record<string, string>) => Object.fromEntries(Object.entries(references).map(([key, variable]) => {
      const value = process.env[variable];
      if (value === undefined) throw new Error(`Set environment variable ${variable} before connecting MCP ${name}`);
      return [key, value];
    }));
    const transport = server.transport === 'stdio'
      ? new StdioClientTransport({ command: server.command, args: server.args, cwd, env: { ...getDefaultEnvironment(), ...resolveEnvironment(server.env) }, stderr: 'pipe', maxBufferSize: 2_000_000 })
      : new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: resolveEnvironment(server.headers), redirect: 'error' } });
    // Drain process stderr without injecting server logs or credentials into the TUI.
    if (transport instanceof StdioClientTransport) transport.stderr?.on('data', () => {});
    const client = new Client({ name: 'behzat', version: manifest.version });
    const controller = new AbortController(); this.connecting.set(name, controller); this.emit('change');
    try {
      const stop = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      await client.connect(transport, { signal: stop, timeout: 15000 });
      const result = await client.listTools(undefined, { signal: stop, timeout: 15000 });
      stop.throwIfAborted();
      this.connections.set(name, { client, tools: result.tools.slice(0, 1000) });
      client.onclose = () => { if (this.connections.get(name)?.client === client) { this.connections.delete(name); this.emit('change'); } };
    } catch {
      await client.close().catch(() => {});
      throw new Error(`MCP ${name} could not connect or list tools. Check its command, URL and credentials.`);
    } finally { this.connecting.delete(name); this.emit('change'); }
  }
  tools(name?: string) {
    if (name && !this.connections.has(name)) throw new Error(`Connect MCP ${name} first`);
    return [...this.connections].filter(([id]) => !name || id === name).flatMap(([server, connection]) => connection.tools.map(tool => ({ server, name: tool.name, description: tool.description, inputSchema: tool.inputSchema })));
  }
  async call(name: string, tool: string, input: Record<string, unknown>, signal?: AbortSignal) {
    const connection = this.connections.get(name);
    if (!connection) throw new Error(`Connect MCP ${name} first`);
    if (!connection.tools.some(item => item.name === tool)) throw new Error(`Unknown MCP tool ${name}/${tool}`);
    signal?.throwIfAborted();
    try {
      const result = await connection.client.callTool({ name: tool, arguments: input }, { signal, timeout: 60000 });
      const serialized = JSON.stringify(result);
      if (Buffer.byteLength(serialized) > 2_000_000) throw new Error('oversized');
      return serialized.slice(0, 64000);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      // A remote error can echo authentication material; keep it out of transcripts.
      throw new Error(`MCP ${name}/${tool} failed, timed out, or returned an oversized result`);
    }
  }
  async disconnect(name: string) {
    this.connecting.get(name)?.abort();
    const connection = this.connections.get(name); this.connections.delete(name); this.emit('change');
    if (connection) await connection.client.close();
  }
  cancelConnections() { for (const controller of this.connecting.values()) controller.abort(); }
  async close() { this.cancelConnections(); await Promise.allSettled([...this.connections.keys()].map(name => this.disconnect(name))); }
}
