import cookie from "cookie";
import express, { type NextFunction, type Request, type Response } from "express";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import multer from "multer";
import QRCode from "qrcode";
import { WebSocketServer, type WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import type { ClientEvent, ServerEvent } from "../shared/protocol.js";
import { certificatePaths, ensureCertificate } from "./certs.js";
import { loadConfig } from "./config.js";
import { assertExistingDirectory, createDirectory, listDirectories } from "./fsBrowser.js";
import { normalizeKeystrokes } from "./keystrokes.js";
import { createRealtimeAnswer, transcribeAudio } from "./openai.js";
import { PairingManager, SESSION_COOKIE } from "./pairing.js";
import { ProposalManager } from "./proposals.js";
import { PtyThreadManager } from "./ptyManager.js";

const config = loadConfig();
const app = express();
const pairing = new PairingManager();
const threads = new PtyThreadManager(config);
const proposals = new ProposalManager(threads);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

app.get(
  "/api/session",
  asyncHandler(async (req, res) => {
    const sessionId = getSessionId(req);
    res.json({
      paired: pairing.hasController(),
      isController: pairing.isController(sessionId),
      pairing: await buildPairingInfo(req),
      activeThreadId: threads.getActiveThreadId()
    });
  })
);

app.post("/api/pair", (req, res) => {
  const token = String(req.body?.token ?? "");
  const sessionId = pairing.pair(token);
  if (!sessionId) {
    res.status(401).json({ error: "Invalid pairing token" });
    return;
  }

  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/"
  });
  res.json({ ok: true });
});

app.post(
  "/api/realtime/session",
  requireController,
  express.text({ type: ["application/sdp", "text/plain"], limit: "2mb" }),
  asyncHandler(async (req, res) => {
    const answer = await createRealtimeAnswer(config, req.body);
    res.type("application/sdp").send(answer);
  })
);

app.post(
  "/api/transcribe",
  requireController,
  upload.single("audio"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "Missing audio file" });
      return;
    }

    const text = await transcribeAudio(
      config,
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname
    );
    res.json({ text });
  })
);

app.get("/api/threads", requireController, (_req, res) => {
  res.json({ threads: threads.list(), activeThreadId: threads.getActiveThreadId() });
});

app.post("/api/threads", requireController, (req, res) => {
  try {
    const thread = createManagedThread(String(req.body?.cwd ?? config.workspaceRoot), req.body?.name);
    res.status(201).json({ thread });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/fs/directories", requireController, (req, res) => {
  try {
    res.json({ listing: listDirectories(config.workspaceRoot, String(req.query.path ?? "")) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/fs/directories", requireController, (req, res) => {
  try {
    res
      .status(201)
      .json({
        listing: createDirectory(
          config.workspaceRoot,
          String(req.body?.parentPath ?? config.workspaceRoot),
          String(req.body?.name ?? "")
        )
      });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/threads/:id/select", requireController, (req, res) => {
  const threadId = String(req.params.id);
  const thread = threads.select(threadId);
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  broadcast({
    type: "threads",
    threads: threads.list(),
    activeThreadId: threads.getActiveThreadId()
  });
  res.json({ thread });
});

app.post("/api/threads/:id/stop", requireController, (req, res) => {
  const thread = threads.stop(String(req.params.id));
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  res.json({ thread });
});

app.get("/api/threads/:id/read", requireController, (req, res) => {
  const lines = Number(req.query.lines ?? "80");
  const threadId = String(req.params.id);
  const text = threads.readPlain(threadId, Number.isFinite(lines) ? lines : 80);
  if (text === undefined) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  res.json({ threadId, text });
});

app.post("/api/proposals", requireController, (req, res) => {
  try {
    const proposal = proposals.create({
      threadId: String(req.body?.threadId ?? ""),
      keystrokes: normalizeKeystrokes(req.body?.keystrokes),
      displayText: String(req.body?.displayText ?? ""),
      reason: String(req.body?.reason ?? "")
    });
    res.status(201).json({ proposal });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/proposals/:id/resolve", requireController, (req, res) => {
  const decision = req.body?.decision === "approve" ? "approve" : "reject";
  try {
    const proposal = proposals.resolve(String(req.params.id), decision);
    res.json({ proposal });
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

if (process.env.NODE_ENV === "production") {
  const clientDir = path.join(config.rootDir, "dist-client");
  app.use(express.static(clientDir));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) {
      next();
      return;
    }
    res.sendFile(path.join(clientDir, "index.html"));
  });
} else {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa"
  });
  app.use(vite.middlewares);
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  res.status(500).json({ error: message });
});

const certs = ensureCertificate(config);
const server = https.createServer({ cert: certs.cert, key: certs.key }, app);
const wss = new WebSocketServer({ noServer: true });
const sockets = new Set<WebSocket>();

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `https://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const sessionId = getSessionIdFromHeader(req.headers.cookie);
  if (!pairing.isController(sessionId)) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  sockets.add(ws);
  send(ws, {
    type: "threads",
    threads: threads.list(),
    activeThreadId: threads.getActiveThreadId()
  });

  for (const proposal of proposals.listPending()) {
    send(ws, { type: "proposal.created", proposal });
  }

  ws.on("message", (raw) => {
    handleClientEvent(ws, raw.toString());
  });

  ws.on("close", () => {
    sockets.delete(ws);
  });
});

threads.on("delta", ({ threadId, data }: { threadId: string; data: string }) => {
  broadcast({ type: "terminal.delta", threadId, data });
});

threads.on("thread", (thread) => {
  broadcast({ type: "thread.status", thread });
});

threads.on("threads", () => {
  broadcast({
    type: "threads",
    threads: threads.list(),
    activeThreadId: threads.getActiveThreadId()
  });
});

proposals.on("created", (proposal) => {
  broadcast({ type: "proposal.created", proposal });
});

proposals.on("resolved", (proposal) => {
  broadcast({ type: "proposal.resolved", proposal });
});

server.listen(config.port, config.host, () => {
  const qrDisplayUrl = getQrDisplayUrl(config.port);
  const localControllerUrl = getLocalControllerUrl(config.port);
  console.log(`Voice Codex listening on HTTPS port ${config.port}`);
  console.log(`Certificate files: ${certificatePaths(config)}${certs.generated ? " (generated)" : ""}`);
  console.log(`Show QR for remote controller: ${qrDisplayUrl}`);
  console.log(`Pair local browser immediately: ${localControllerUrl}`);
});

function handleClientEvent(ws: WebSocket, raw: string): void {
  let event: ClientEvent;
  try {
    event = JSON.parse(raw) as ClientEvent;
  } catch {
    send(ws, { type: "error", message: "Invalid WebSocket JSON" });
    return;
  }

  if (event.type === "terminal.input") {
    if (!threads.write(event.threadId, event.data)) {
      send(ws, { type: "error", message: "Unable to write to terminal" });
    }
    return;
  }

  if (event.type === "terminal.resize") {
    threads.resize(event.threadId, event.cols, event.rows);
    return;
  }

  if (event.type === "thread.select") {
    const thread = threads.select(event.threadId);
    if (!thread) {
      send(ws, { type: "error", message: "Thread not found" });
      return;
    }

    const snapshot = threads.getSnapshot(event.threadId);
    if (snapshot) {
      send(ws, {
        type: "terminal.snapshot",
        threadId: event.threadId,
        data: snapshot.raw,
        plainText: snapshot.plain
      });
    }
    return;
  }

  if (event.type === "thread.create") {
    try {
      createManagedThread(event.cwd, event.name);
    } catch (error) {
      send(ws, { type: "error", message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (event.type === "proposal.approve" || event.type === "proposal.reject") {
    try {
      proposals.resolve(event.proposalId, event.type === "proposal.approve" ? "approve" : "reject");
    } catch (error) {
      send(ws, { type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }
}

function requireController(req: Request, res: Response, next: NextFunction): void {
  if (!pairing.isController(getSessionId(req))) {
    res.status(401).json({ error: "Pair this browser before controlling Codex." });
    return;
  }
  next();
}

function createManagedThread(cwdInput: string, nameInput?: unknown) {
  const cwd = assertExistingDirectory(config.workspaceRoot, cwdInput);
  const requestedName = typeof nameInput === "string" ? nameInput.trim() : "";
  const baseName = requestedName || path.basename(cwd) || "Codex";
  const thread = threads.create({ name: uniqueThreadName(baseName), cwd });
  broadcast({
    type: "threads",
    threads: threads.list(),
    activeThreadId: threads.getActiveThreadId()
  });
  return thread;
}

function uniqueThreadName(baseName: string): string {
  const existing = new Set(threads.list().map((thread) => thread.name));
  if (!existing.has(baseName)) {
    return baseName;
  }

  for (let index = 2; ; index += 1) {
    const candidate = `${baseName} (${index})`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
}

function getSessionId(req: Request): string | undefined {
  return getSessionIdFromHeader(req.headers.cookie);
}

function getSessionIdFromHeader(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  return cookie.parse(header)[SESSION_COOKIE];
}

async function buildPairingInfo(req: Request) {
  const controllerUrl = canDisplayPairingQr(req) ? getRemoteControllerUrl(req) : undefined;

  return {
    controllerUrl,
    qrDataUrl: controllerUrl
      ? await QRCode.toDataURL(controllerUrl, { margin: 1, width: 900 })
      : undefined,
    qrDisplayUrl: getQrDisplayUrl(config.port),
    localControllerUrl: canDisplayPairingQr(req) ? getLocalControllerUrl(config.port) : undefined
  };
}

function send(ws: WebSocket, event: ServerEvent): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

function broadcast(event: ServerEvent): void {
  for (const ws of sockets) {
    send(ws, event);
  }
}

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

function getQrDisplayUrl(port: number): string {
  return `https://localhost:${port}/pair`;
}

function getLocalControllerUrl(port: number): string {
  const url = new URL(`https://localhost:${port}/`);
  url.searchParams.set("pair", pairing.getToken());
  return url.toString();
}

function getRemoteControllerUrl(req: Request): string {
  const requestedHost = normalizePairHost(req.query.pairHost, config.port);
  if (requestedHost) {
    return withPairingToken(requestedHost);
  }

  const publicUrl = process.env.VOICE_CODEX_PUBLIC_URL?.trim();
  if (publicUrl) {
    return withPairingToken(publicUrl);
  }

  const requestHost = req.get("host");
  if (requestHost && !isLoopbackHost(requestHost)) {
    return withPairingToken(`https://${requestHost}/`);
  }

  const remoteHost = getPreferredRemoteHost(config.port);
  return withPairingToken(`https://${remoteHost}/`);
}

function withPairingToken(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = "/";
  url.searchParams.set("pair", pairing.getToken());
  return url.toString();
}

function getPreferredRemoteHost(port: number): string {
  const candidates: string[] = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const item of interfaces ?? []) {
      if (item.family === "IPv4" && !item.internal) {
        candidates.push(item.address);
      }
    }
  }

  const lanAddress = candidates.find(is192168Address) ?? candidates.find(isPrivateLanAddress);
  return `${lanAddress ?? candidates[0] ?? "localhost"}:${port}`;
}

function normalizePairHost(value: unknown, port: number): string | undefined {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const raw = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!raw) {
    return undefined;
  }

  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    url.protocol = "https:";
    if (!url.port && !raw.match(/:\d+(?:\/|$)/)) {
      url.port = String(port);
    }
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function is192168Address(address: string): boolean {
  return address.startsWith("192.168.");
}

function isPrivateLanAddress(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }

  const [first, second] = parts;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || first === 192 && second === 168;
}

function canDisplayPairingQr(req: Request): boolean {
  const host = req.get("host");
  if (!host) {
    return true;
  }

  return isLoopbackHost(host);
}

function isLoopbackHost(host: string): boolean {
  const hostname = extractHostname(host).toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function extractHostname(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end >= 0 ? host.slice(1, end) : host;
  }

  return host.split(":")[0] ?? host;
}
