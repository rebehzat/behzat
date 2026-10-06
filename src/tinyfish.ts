import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicJson } from './config.ts';
import { z } from 'zod';

export const SearchQuery = z.object({
  query: z.string().min(1), purpose: z.string().max(2000).optional(),
  location: z.string().optional(), language: z.string().optional(),
  include_domains: z.string().optional(), exclude_domains: z.string().optional(),
  domain_type: z.enum(['web', 'news', 'research_paper']).optional(),
  page: z.number().int().min(0).max(10).optional(),
  recency_minutes: z.number().int().min(1).max(5256000).optional(),
});
export class TinyFish {
  constructor(private key = process.env.TINYFISH_API_KEY, private readonly fetcher: typeof fetch = fetch) {}
  get configured() { return Boolean(this.key); }
  async loadKey(home: string) {
    try { const value = JSON.parse(await readFile(join(home, 'tinyfish-auth.json'), 'utf8')); if (!this.key && typeof value.key === 'string') this.key = value.key; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Unable to read TinyFish credentials'); }
  }
  async saveKey(home: string, key: string) {
    await atomicJson(join(home, 'tinyfish-auth.json'), { key }); this.key = key;
  }
  private async request(url: string, options: RequestInit, signal?: AbortSignal) {
    if (!this.key) throw new Error('Use /apikey tinyfish or set TINYFISH_API_KEY to use web search and fetch.');
    const response = await this.fetcher(url, {
      ...options, headers: { ...options.headers, 'X-API-Key': this.key },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`TinyFish HTTP ${response.status}. ${response.status === 429 ? 'Rate limit reached; retry later.' : 'Check your key and account access.'}`);
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error('TinyFish response exceeds two megabytes');
    return JSON.parse(text) as unknown;
  }
  search(input: z.infer<typeof SearchQuery>, signal?: AbortSignal) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(SearchQuery.parse(input))) if (value !== undefined) params.set(key, String(value));
    return this.request(`https://api.search.tinyfish.ai?${params}`, {}, signal);
  }
  async fetch(urls: string[], signal?: AbortSignal) {
    z.array(z.url().refine(url => /^https?:\/\//.test(url))).min(1).max(10).parse(urls);
    return this.request('https://api.fetch.tinyfish.ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls, format: 'markdown', links: true }) }, signal);
  }
}
