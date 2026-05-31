// Minimal MCP server over HTTP. Hand-rolled (no SDK) to avoid bundling the
// MCP SDK's transport stack — we only need initialize / tools/list / tools/call,
// all over plain JSON-RPC 2.0 on a single POST endpoint.
//
// Binds to 127.0.0.1 only. Optional Bearer token in Authorization header.
// Desktop-only — Obsidian mobile has no Node http module.
//
// Protocol reference: https://modelcontextprotocol.io/specification

import { Platform } from 'obsidian';

export interface McpServerOptions {
  enabled: boolean;
  port: number;
  token: string;       // empty string disables auth
}

export const DEFAULT_MCP_OPTIONS: McpServerOptions = {
  enabled: false,
  port: 8745,
  token: '',
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

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

export interface ServerContext {
  serverName: string;
  serverVersion: string;
  tools: ToolDefinition[];
  handlers: Record<string, ToolHandler>;
}

// Loose typing for Node's http module — pulled in via window.require because
// we run inside Obsidian's Electron renderer rather than vanilla Node.
type NodeHttpServer = {
  listen(port: number, host: string, cb: () => void): void;
  close(cb?: () => void): void;
  once(event: 'error', cb: (err: Error) => void): void;
};

export class McpServer {
  private httpServer: NodeHttpServer | null = null;
  private ctx: ServerContext;
  private currentPort = 0;

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
    console.log(`[sr-mcp] listening on http://127.0.0.1:${opts.port}`);
  }

  async stop(): Promise<void> {
    const s = this.httpServer;
    if (!s) return;
    this.httpServer = null;
    this.currentPort = 0;
    await new Promise<void>(resolve => s.close(() => resolve()));
  }

  private async handle(rawReq: unknown, rawRes: unknown, token: string): Promise<void> {
    const req = rawReq as {
      method?: string;
      headers: Record<string, string | string[] | undefined>;
      on: (event: string, cb: (data?: unknown) => void) => void;
    };
    const res = rawRes as {
      writeHead: (status: number, headers?: Record<string, string | number>) => void;
      end: (body?: string) => void;
    };

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method not allowed — POST only');
      return;
    }
    if (token) {
      const auth = (req.headers['authorization'] as string | undefined) || '';
      if (auth !== 'Bearer ' + token) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized');
        return;
      }
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

  private async dispatch(req: JsonRpcRequest): Promise<Partial<JsonRpcResponse>> {
    switch (req.method) {
      case 'initialize':
        return {
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: this.ctx.serverName, version: this.ctx.serverVersion },
          },
        };
      case 'initialized':
      case 'notifications/initialized':
      case 'ping':
        return { result: {} };
      case 'tools/list':
        return { result: { tools: this.ctx.tools } };
      case 'tools/call': {
        const params = (req.params || {}) as { name?: string; arguments?: Record<string, unknown> };
        const name = params.name || '';
        const handler = this.ctx.handlers[name];
        if (!handler) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
        try {
          const out = await handler(params.arguments || {});
          const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
          return { result: { content: [{ type: 'text', text }], isError: false } };
        } catch (err) {
          const msg = (err instanceof Error) ? err.message : String(err);
          return { result: { content: [{ type: 'text', text: msg }], isError: true } };
        }
      }
      default:
        return { error: { code: -32601, message: `Method not found: ${req.method}` } };
    }
  }
}
