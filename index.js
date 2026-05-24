const express = require("express");
const { v4: uuid } = require("uuid");

const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "05c37f4ac121e15c50dbe3c4bfe470517ce02f598430c0bfb8eb16712b1f70cc";

// ── State ──────────────────────────────────────────────────────────────────
const sessions = new Map();  // sessionId → { sessionId, sessionKey, label, createdAt, lastSeen, commandCount, status, studioInfo }
const keyIndex = new Map();  // sessionKey → sessionId
const queues   = new Map();  // sessionId → [{ commandId, command, args, createdAt }]
const results  = new Map();  // "sessionId:commandId" → { commandId, success, result, completedAt }
const waiters  = new Map();  // "sessionId:commandId" → [resolve, ...]

// Auto-cleanup results after 2 min
function scheduleCleanup(key) {
  setTimeout(() => results.delete(key), 120000);
}

// ── Auth middleware ────────────────────────────────────────────────────────
function isMaster(req) {
  return req.headers["x-api-key"] === API_KEY;
}

function getAuth(req) {
  const key = req.headers["x-api-key"];
  if (!key) return null;
  if (key === API_KEY) return { master: true };
  const sid = keyIndex.get(key);
  if (!sid) return null;
  return { sessionId: sid };
}

function requireAuth(req, res) {
  const auth = getAuth(req);
  if (!auth) { res.status(401).json({ error: "Unauthorized" }); return null; }
  return auth;
}

// ── CORS ───────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── POST /session ──────────────────────────────────────────────────────────
app.post("/session", (req, res) => {
  if (!isMaster(req)) return res.status(401).json({ error: "Master key required" });

  const sessionId = uuid();
  const sessionKey = uuid();
  const session = {
    sessionId, sessionKey,
    label: req.body.label || "unnamed",
    createdAt: Date.now(),
    lastSeen: null,
    commandCount: 0,
    status: "waiting",
    studioInfo: null,
  };

  sessions.set(sessionId, session);
  keyIndex.set(sessionKey, sessionId);
  queues.set(sessionId, []);

  res.json({ sessionId, sessionKey, label: session.label });
});

// ── GET /session/:id ───────────────────────────────────────────────────────
app.get("/session/:id", (req, res) => {
  if (!requireAuth(req, res)) return;
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  const queue = queues.get(req.params.id) || [];
  res.json({
    sessionId: session.sessionId, label: session.label,
    status: session.status, createdAt: session.createdAt,
    lastSeen: session.lastSeen, commandCount: session.commandCount,
    studioInfo: session.studioInfo, pendingCount: queue.length,
  });
});

// ── DELETE /session/:id ────────────────────────────────────────────────────
app.delete("/session/:id", (req, res) => {
  if (!requireAuth(req, res)) return;
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  sessions.delete(req.params.id);
  keyIndex.delete(session.sessionKey);
  queues.delete(req.params.id);
  res.json({ ok: true });
});

// ── GET /sessions ──────────────────────────────────────────────────────────
app.get("/sessions", (req, res) => {
  if (!isMaster(req)) return res.status(401).json({ error: "Master key required" });
  const list = [...sessions.values()].map(s => ({
    sessionId: s.sessionId, label: s.label, status: s.status,
    lastSeen: s.lastSeen, commandCount: s.commandCount, studioInfo: s.studioInfo,
  }));
  res.json(list);
});

// ── POST /session/:id/register ─────────────────────────────────────────────
app.post("/session/:id/register", (req, res) => {
  if (!requireAuth(req, res)) return;
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  session.status = "connected";
  session.lastSeen = Date.now();
  session.studioInfo = {
    gameId: req.body.gameId, placeId: req.body.placeId,
    placeVersion: req.body.placeVersion, placeName: req.body.placeName,
    pluginVersion: req.body.pluginVersion || "2.0",
  };
  res.json({ ok: true, sessionId: req.params.id });
});

// ── POST /session/:id/send ─────────────────────────────────────────────────
app.post("/session/:id/send", (req, res) => {
  if (!requireAuth(req, res)) return;
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (!req.body.command) return res.status(400).json({ error: "Missing 'command'" });

  const commandId = uuid();
  const entry = { commandId, command: req.body.command, args: req.body.args || {}, createdAt: Date.now() };

  const queue = queues.get(req.params.id) || [];
  queue.push(entry);
  queues.set(req.params.id, queue);
  session.commandCount++;

  res.json({ commandId, sessionId: req.params.id, queueDepth: queue.length });
});

// ── GET /session/:id/poll ──────────────────────────────────────────────────
app.get("/session/:id/poll", (req, res) => {
  if (!requireAuth(req, res)) return;
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  session.lastSeen = Date.now();
  session.status = "connected";

  const queue = queues.get(req.params.id) || [];
  if (queue.length === 0) return res.sendStatus(204);

  const next = queue.shift();
  res.json(next);
});

// ── POST /session/:id/result ───────────────────────────────────────────────
app.post("/session/:id/result", (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!req.body.commandId) return res.status(400).json({ error: "Missing commandId" });

  const key = `${req.params.id}:${req.body.commandId}`;
  const result = {
    commandId: req.body.commandId, success: req.body.success,
    result: req.body.result, completedAt: Date.now(),
  };
  results.set(key, result);
  scheduleCleanup(key);

  // Resolve any waiters
  const waiting = waiters.get(key);
  if (waiting) {
    waiting.forEach(resolve => resolve(result));
    waiters.delete(key);
  }

  res.json({ ok: true });
});

// ── GET /session/:id/result/:commandId ─────────────────────────────────────
app.get("/session/:id/result/:commandId", (req, res) => {
  if (!requireAuth(req, res)) return;

  const key = `${req.params.id}:${req.params.commandId}`;

  // Check if already available
  const existing = results.get(key);
  if (existing) {
    results.delete(key);
    return res.json(existing);
  }

  // Long-poll: wait up to 30s
  const timeout = setTimeout(() => {
    const w = waiters.get(key);
    if (w) {
      const idx = w.indexOf(resolve);
      if (idx >= 0) w.splice(idx, 1);
      if (w.length === 0) waiters.delete(key);
    }
    res.status(408).json({ error: "Timeout waiting for result" });
  }, 30000);

  const resolve = (result) => {
    clearTimeout(timeout);
    results.delete(key);
    res.json(result);
  };

  if (!waiters.has(key)) waiters.set(key, []);
  waiters.get(key).push(resolve);
});

// ── GET /status ────────────────────────────────────────────────────────────
app.get("/status", (req, res) => {
  res.json({
    status: "ok",
    sessions: sessions.size,
    uptime: process.uptime(),
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`CloudBridge server running on port ${PORT}`);
});
