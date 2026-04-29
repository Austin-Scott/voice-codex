import cookie from "cookie";
import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
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
  const pin = String(req.body?.pin ?? "");
  const sessionId = pairing.pair(pin);
  if (!sessionId) {
    res.status(401).json({ error: "Invalid PIN" });
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
  const cwd = path.resolve(config.rootDir, String(req.body?.cwd ?? "."));
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    res.status(400).json({ error: "Working directory does not exist" });
    return;
  }

  const thread = threads.create({ name: req.body?.name, cwd });
  broadcast({
    type: "threads",
    threads: threads.list(),
    activeThreadId: threads.getActiveThreadId()
  });
  res.status(201).json({ thread });
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
  const urls = getServerUrls(config.port);
  console.log(`Voice Codex listening on HTTPS port ${config.port}`);
  console.log(`Pairing PIN: ${pairing.getPin()}`);
  console.log(`Certificate files: ${certificatePaths(config)}${certs.generated ? " (generated)" : ""}`);
  for (const url of urls) {
    console.log(`Open ${url}`);
  }
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
    threads.create({ name: event.name, cwd: path.resolve(config.rootDir, event.cwd) });
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
  const host = req.get("host") ?? `localhost:${config.port}`;
  const url = new URL(`https://${host}/`);
  url.searchParams.set("pin", pairing.getPin());

  return {
    pin: pairing.getPin(),
    url: url.toString(),
    qrDataUrl: await QRCode.toDataURL(url.toString(), { margin: 1, width: 260 })
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

function getServerUrls(port: number): string[] {
  const urls = [`https://localhost:${port}/`];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const item of interfaces ?? []) {
      if (item.family === "IPv4" && !item.internal) {
        urls.push(`https://${item.address}:${port}/`);
      }
    }
  }
  return urls;
}
