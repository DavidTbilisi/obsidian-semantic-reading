// Minimal MCP server over HTTP. Hand-rolled (no SDK) to keep the bundle small.
// Supports: initialize, tools/list + tools/call, resources/list + resources/read
// + resources/templates/list, prompts/list + prompts/get — all JSON-RPC 2.0 over
// a single POST endpoint. A GET on the same endpoint opens an SSE stream used to
// push server→client notifications (resources/list_changed) per the Streamable
// HTTP transport.
//
// Binds to 127.0.0.1 only. Optional Bearer token in Authorization header.
// Desktop-only — Obsidian mobile has no Node http module.
//
// Protocol reference: https://modelcontextprotocol.io/specification

import { Platform } from 'obsidian';
import { paginate } from './pagination';

export interface McpServerOptions {
  enabled: boolean;
  port: number;
  token: string;       // empty string disables auth
  allowWrites: boolean; // gate write-scoped tools (sr_apply_tag, sr_review_card, …)
}

export const DEFAULT_MCP_OPTIONS: McpServerOptions = {
  enabled: false,
  port: 8745,
  token: '',
  allowWrites: false,
};

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type ToolScope = 'read' | 'write';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
  scope?: ToolScope;   // defaults to 'read'; 'write' tools are gated by allowWrites
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

// MCP resources + prompts (axis 3). Resources expose vault content (concept
// hubs, open questions, notes) for direct attachment; prompts expose the AI
// tag-suggest / synthesis templates.
export interface ResourceDef {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceTemplateDef {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

export interface PromptArgumentDef {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptDef {
  name: string;
  description: string;
  arguments?: PromptArgumentDef[];
}

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

export interface PromptResult {
  description?: string;
  messages: PromptMessage[];
}

export interface ServerContext {
  serverName: string;
  serverVersion: string;
  tools: ToolDefinition[];
  handlers: Record<string, ToolHandler>;
  // Resources — dynamic (the concept set changes), so a function.
  resources: () => ResourceDef[];
  resourceTemplates: ResourceTemplateDef[];
  readResource: (uri: string) => Promise<ResourceContent> | ResourceContent;
  // Prompts.
  prompts: PromptDef[];
  getPrompt: (name: string, args: Record<string, unknown>) => Promise<PromptResult> | PromptResult;
  // Subscribe to index changes for resources/list_changed notifications.
  // Returns an unsubscribe fn. Optional — when absent, no notifications fire.
  onChange?: (cb: () => void) => () => void;
}

// Loose typing for Node's http module — pulled in via window.require because
// we run inside Obsidian's Electron renderer rather than vanilla Node.
type NodeHttpServer = {
  listen(port: number, host: string, cb: () => void): void;
  close(cb?: () => void): void;
  once(event: 'error', cb: (err: Error) => void): void;
};

// An open SSE response we push notifications to.
type SseResponse = {
  writeHead: (status: number, headers?: Record<string, string | number>) => void;
  write: (chunk: string) => void;
  end: (body?: string) => void;
};

export class McpServer {
  private httpServer: NodeHttpServer | null = null;
  private ctx: ServerContext;
  private currentPort = 0;
  private opts: McpServerOptions = DEFAULT_MCP_OPTIONS;
  private sseClients = new Set<SseResponse>();
  private unsubscribe: (() => void) | null = null;

  constructor(ctx: ServerContext) {
    this.ctx = ctx;
  }

  isRunning(): boolean {
    return !!this.httpServer;
  }

  runningPort(): number {
    return this.currentPort;
  }

  async start(opts: McpServerOptions): Promise<void> {
    await this.stop();
    if (!opts.enabled) return;
    if (!Platform.isDesktop) {
      console.warn('[sr-mcp] MCP server only runs on desktop Obsidian; ignoring.');
      return;
    }
    const req = (typeof window !== 'undefined' && (window as unknown as { require?: (m: string) => unknown }).require) || null;
    if (!req) throw new Error('node:require unavailable — cannot start MCP server');
    const http = req('http') as {
      createServer: (h: (req: unknown, res: unknown) => void) => NodeHttpServer;
    };
    if (!http?.createServer) throw new Error('node:http not available');

    this.opts = opts;
    const server = http.createServer((rawReq: unknown, rawRes: unknown) => {
      this.handle(rawReq, rawRes, opts.token).catch(err => {
        console.error('[sr-mcp] request handler error', err);
        try {
          (rawRes as { writeHead: (s: number) => void; end: (b?: string) => void }).writeHead(500);
          (rawRes as { writeHead: (s: number) => void; end: (b?: string) => void }).end('Internal error');
        } catch { /* ignore */ }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port, '127.0.0.1', () => resolve());
    });

    this.httpServer = server;
    this.currentPort = opts.port;
    // Broadcast resources/list_changed whenever the vault index changes.
    if (this.ctx.onChange) {
      this.unsubscribe = this.ctx.onChange(() => this.broadcast('notifications/resources/list_changed'));
    }
    console.log(`[sr-mcp] listening on http://127.0.0.1:${opts.port}`);
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
    for (const c of this.sseClients) { try { c.end(); } catch { /* ignore */ } }
    this.sseClients.clear();
    const s = this.httpServer;
    if (!s) return;
    this.httpServer = null;
    this.currentPort = 0;
    await new Promise<void>(resolve => s.close(() => resolve()));
  }

  // Push a JSON-RPC notification (no id) to every connected SSE client.
  private broadcast(method: string): void {
    if (!this.sseClients.size) return;
    const payload = `data: ${JSON.stringify({ jsonrpc: '2.0', method })}\n\n`;
    for (const res of this.sseClients) {
      try { res.write(payload); } catch { this.sseClients.delete(res); }
    }
  }

  private async handle(rawReq: unknown, rawRes: unknown, token: string): Promise<void> {
    const req = rawReq as {
      method?: string;
      headers: Record<string, string | string[] | undefined>;
      on: (event: string, cb: (data?: unknown) => void) => void;
    };
    const res = rawRes as SseResponse;

    if (token) {
      const auth = (req.headers['authorization'] as string | undefined) || '';
      if (auth !== 'Bearer ' + token) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized');
        return;
      }
    }

    // GET → open an SSE notification stream (server→client push channel).
    if (req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(': sr-mcp connected\n\n');
      this.sseClients.add(res);
      req.on('close', () => { this.sseClients.delete(res); });
      return; // keep the connection open
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method not allowed — POST (JSON-RPC) or GET (SSE) only');
      return;
    }

    const body = await new Promise<string>((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      req.on('data', (c) => chunks.push(c as Uint8Array));
      req.on('end', () => {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const buf = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { buf.set(c, off); off += c.length; }
        resolve(new TextDecoder().decode(buf));
      });
      req.on('error', (err) => reject(err as Error));
    });

    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(body) as JsonRpcRequest;
    } catch {
      this.send(res, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
      this.send(res, { jsonrpc: '2.0', id: parsed.id ?? null, error: { code: -32600, message: 'Invalid request' } });
      return;
    }

    const out = await this.dispatch(parsed);
    if (parsed.id === undefined || parsed.id === null) {
      // JSON-RPC notification — no response body.
      res.writeHead(204);
      res.end();
      return;
    }
    this.send(res, { jsonrpc: '2.0', id: parsed.id, ...out });
  }

  private send(res: { writeHead: (s: number, h?: Record<string, string | number>) => void; end: (b?: string) => void }, body: JsonRpcResponse): void {
    const json = JSON.stringify(body);
    const bytes = new TextEncoder().encode(json).length;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': bytes });
    res.end(json);
  }

  // Public-facing tools: hide write-scoped tools unless writes are allowed, and
  // drop the internal `scope` field from the wire shape.
  private visibleTools(): Array<Pick<ToolDefinition, 'name' | 'description' | 'inputSchema'>> {
    return this.ctx.tools
      .filter(t => (t.scope ?? 'read') === 'read' || this.opts.allowWrites)
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  private async dispatch(req: JsonRpcRequest): Promise<Partial<JsonRpcResponse>> {
    const params = (req.params || {}) as Record<string, unknown>;
    const cursor = typeof params.cursor === 'string' ? params.cursor : undefined;
    switch (req.method) {
      case 'initialize':
        return {
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: { listChanged: false },
              resources: { listChanged: true },
              prompts: { listChanged: false },
            },
            serverInfo: { name: this.ctx.serverName, version: this.ctx.serverVersion },
          },
        };
      case 'initialized':
      case 'notifications/initialized':
      case 'ping':
        return { result: {} };
      case 'tools/list': {
        const page = paginate(this.visibleTools(), cursor);
        return { result: { tools: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) } };
      }
      case 'tools/call': {
        const p = (req.params || {}) as { name?: string; arguments?: Record<string, unknown> };
        const name = p.name || '';
        const def = this.ctx.tools.find(t => t.name === name);
        const handler = this.ctx.handlers[name];
        if (!def || !handler) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
        if ((def.scope ?? 'read') === 'write' && !this.opts.allowWrites) {
          return {
            result: {
              content: [{ type: 'text', text: `Tool "${name}" requires write access. Enable "Allow write tools" in the plugin's MCP settings.` }],
              isError: true,
            },
          };
        }
        try {
          const out = await handler(p.arguments || {});
          const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
          return { result: { content: [{ type: 'text', text }], isError: false } };
        } catch (err) {
          const msg = (err instanceof Error) ? err.message : String(err);
          return { result: { content: [{ type: 'text', text: msg }], isError: true } };
        }
      }
      case 'resources/list': {
        const page = paginate(this.ctx.resources(), cursor);
        return { result: { resources: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) } };
      }
      case 'resources/templates/list':
        return { result: { resourceTemplates: this.ctx.resourceTemplates } };
      case 'resources/read': {
        const uri = String(params.uri || '');
        if (!uri) return { error: { code: -32602, message: 'uri is required' } };
        try {
          const content = await this.ctx.readResource(uri);
          return { result: { contents: [content] } };
        } catch (err) {
          const msg = (err instanceof Error) ? err.message : String(err);
          return { error: { code: -32002, message: msg } };
        }
      }
      case 'prompts/list': {
        const page = paginate(this.ctx.prompts, cursor);
        return { result: { prompts: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) } };
      }
      case 'prompts/get': {
        const name = String(params.name || '');
        const args = (params.arguments as Record<string, unknown>) || {};
        try {
          const result = await this.ctx.getPrompt(name, args);
          return { result };
        } catch (err) {
          const msg = (err instanceof Error) ? err.message : String(err);
          return { error: { code: -32602, message: msg } };
        }
      }
      default:
        return { error: { code: -32601, message: `Method not found: ${req.method}` } };
    }
  }
}
