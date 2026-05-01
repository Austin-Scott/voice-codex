import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { ControllerImageManager } from "./controllerImages.js";
import type { PtyThreadManager, McpThreadContext } from "./ptyManager.js";
import type { TurnSummaryManager } from "./summaries.js";

interface McpSession {
  threadId: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export class VoiceCodexMcpBridge {
  private server: http.Server | undefined;
  private port: number | undefined;
  private sessions = new Map<string, McpSession>();

  constructor(
    private readonly config: AppConfig,
    private readonly threads: PtyThreadManager,
    private readonly summaries: TurnSummaryManager,
    private readonly images: ControllerImageManager
  ) {}

  async listen(): Promise<void> {
    if (this.server) {
      return;
    }

    const app = express();
    app.all("/mcp/:threadId", (req, res) => {
      this.handleMcpRequest(req, res).catch((error: unknown) => {
        if (!res.headersSent) {
          res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
        }
      });
    });

    const server = http.createServer(app);
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.config.mcpPort, this.config.mcpHost, () => {
        server.off("error", reject);
        const address = server.address();
        this.port = typeof address === "object" && address ? address.port : this.config.mcpPort;
        resolve();
      });
    });
  }

  urlForThread(threadId: string, token: string): string {
    if (!this.port) {
      throw new Error("MCP bridge is not listening");
    }

    const url = new URL(`http://${hostForUrl(this.config.mcpHost)}:${this.port}/mcp/${encodeURIComponent(threadId)}`);
    url.searchParams.set("token", token);
    return url.toString();
  }

  displayUrl(): string {
    if (!this.port) {
      return "not listening";
    }
    return `http://${hostForUrl(this.config.mcpHost)}:${this.port}/mcp/<threadId>?token=<token>`;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      sessions.map((session) => session.server.close().catch(() => undefined))
    );
    if (!server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  async closeSessionsForThread(threadId: string): Promise<void> {
    const sessions = [...this.sessions.entries()].filter(([, session]) => session.threadId === threadId);
    for (const [sessionId, session] of sessions) {
      this.sessions.delete(sessionId);
      await session.server.close().catch(() => undefined);
    }
  }

  private async handleMcpRequest(req: Request, res: Response): Promise<void> {
    const context = this.getThreadContext(req);
    if (!context) {
      res.status(401).json({ error: "Invalid MCP thread credentials" });
      return;
    }

    const session = await this.getOrCreateSession(req, context);
    if (!session || session.threadId !== context.id) {
      res.status(404).json({ error: "Unknown MCP session" });
      return;
    }

    await session.transport.handleRequest(req, res);
  }

  private getThreadContext(req: Request): McpThreadContext | undefined {
    const threadId = String(req.params.threadId ?? "");
    const rawToken = req.query.token;
    const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    if (typeof token !== "string") {
      return undefined;
    }

    return this.threads.getMcpThreadContext(threadId, token);
  }

  private async getOrCreateSession(
    req: Request,
    thread: McpThreadContext
  ): Promise<McpSession | undefined> {
    const sessionId = req.header("mcp-session-id");
    if (sessionId) {
      return this.sessions.get(sessionId);
    }

    const mcpServer = this.createMcpServer(thread);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      allowedHosts: allowedHostsFor(this.config.mcpHost, this.port),
      enableDnsRebindingProtection: true,
      onsessioninitialized: (initializedSessionId) => {
        this.sessions.set(initializedSessionId, session);
      },
      onsessionclosed: (closedSessionId) => {
        this.sessions.delete(closedSessionId);
      }
    });
    const session: McpSession = {
      threadId: thread.id,
      server: mcpServer,
      transport
    };
    transport.onclose = () => {
      if (transport.sessionId) {
        this.sessions.delete(transport.sessionId);
      }
    };
    await mcpServer.connect(transport);
    return session;
  }

  private createMcpServer(thread: McpThreadContext): McpServer {
    const server = new McpServer({
      name: "voice-codex-controller",
      version: "0.1.0"
    });

    server.registerTool(
      "report_turn_summary",
      {
        title: "Report turn summary",
        description:
          "Call this just before finishing a turn to send the controller a concise summary of what happened.",
        inputSchema: {
          summary: z.string().min(1).max(4000),
          status: z.string().max(80).optional()
        }
      },
      ({ summary, status }) => {
        const created = this.summaries.create({
          thread,
          summary,
          status
        });
        return {
          content: [{ type: "text", text: `Stored turn summary ${created.id}.` }],
          structuredContent: { summary: created }
        };
      }
    );

    server.registerTool(
      "show_images",
      {
        title: "Show images in controller",
        description:
          "Display one or more image files from this workspace in the controller browser.",
        inputSchema: {
          paths: z.array(z.string().min(1)).min(1).max(12),
          title: z.string().max(140).optional(),
          caption: z.string().max(1000).optional()
        }
      },
      async ({ paths, title, caption }) => {
        const request = await this.images.createPresentation({
          thread,
          paths,
          title,
          caption
        });
        return {
          content: [
            {
              type: "text",
              text: `Displayed ${request.images.length} image${request.images.length === 1 ? "" : "s"} in the controller.`
            }
          ],
          structuredContent: { request }
        };
      }
    );

    return server;
  }
}

function hostForUrl(host: string): string {
  if (host.includes(":") && !host.startsWith("[")) {
    return `[${host}]`;
  }
  return host;
}

function allowedHostsFor(host: string, port: number | undefined): string[] {
  if (!port) {
    return [];
  }

  const hosts = new Set([`${host}:${port}`]);
  if (host === "127.0.0.1") {
    hosts.add(`localhost:${port}`);
  } else if (host === "localhost") {
    hosts.add(`127.0.0.1:${port}`);
  }
  return [...hosts];
}
