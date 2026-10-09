const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { WebSocketServer, WebSocket } = require('ws');
const database = require('./database');

// ───────────── Config ─────────────
const PORT = process.env.PORT || 3000;
const GAME_DURATION = Number(process.env.GAME_DURATION_SEC) || 300;
const DEVICE_KEY = process.env.DEVICE_KEY || ''; // ถ้าตั้งไว้ ช่องทางของ ESP32 (HTTP / WS ดิบ) ต้องแนบ key
const MAX_CHIPS = 50;

const log = (tag, msg, extra = '') => console.log(`${new Date().toISOString()} [${tag}] ${msg}`, extra);

// ───────────── Global Game State ─────────────
const createState = (isGameActive = false) => ({
  score: 0,
  streak: 0,
  hp: 3,
  timeLeft: GAME_DURATION,
  currentAnswer: '',
  riddleId: null,    // ID โจทย์ที่กำลังเล่น (เช่น TAG_100)
  scannedChips: [],  // [{ uid, chipName, tagId, scannedAt, source }]
  isGameActive,
});

let state = createState();

// ───────────── App / Server ─────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.get('/', (_req, res) => res.redirect('/game.html'));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 20000,
});

const pushState = () => io.emit('server:state', state);

// ───────────── WebSocket ดิบ (/ws) — โปรโตคอล JSON เดิมของ Python ─────────────
// ให้ ESP32 firmware เดิมที่ส่ง {"action":"tag_scanned","tag_id":"..."} ใช้ต่อได้
const wss = new WebSocketServer({ noServer: true });

function legacyBroadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}
const legacySend = (ws, obj) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj));

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') return; // path อื่น (เช่น /socket.io) ให้ Socket.io จัดการเอง

  const key = url.searchParams.get('key') || req.headers['x-api-key'];
  if (DEVICE_KEY && key !== DEVICE_KEY) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const addr = req.socket.remoteAddress;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  log('WS', `[Client Connected] ${addr}`);

  ws.on('message', (raw) => {
    log('WS', `[Received] ${raw.toString().slice(0, 200)}`);

    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (e) {
      log('WS', `[Error] Invalid JSON format from ${addr}: ${e.message}`);
      return legacySend(ws, { status: 'error', message: 'Invalid JSON format' });
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;

    if (data.action === 'tag_scanned') {
      const res = processTag(data, 'esp32-ws');
      if (!res.ok) return legacySend(ws, { status: 'error', message: res.error });
      if (res.nextId) legacySend(ws, { action: 'write_tag', payload: res.nextId });
    } else {
      log('WS', `[Warning] Unknown action received: '${data.action}'`);
      legacySend(ws, { status: 'error', message: `Unknown action '${data.action}'` });
    }
  });

  ws.on('close', () => log('WS', `[Client Disconnected] ${addr}`));
  ws.on('error', (e) => log('WS', `[Error] ${addr}: ${e.message}`));
});

// กัน Render/proxy ตัดการเชื่อมต่อที่เงียบนาน + เก็บกวาด client ที่ตายแล้ว
const wsKeepAlive = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);
wsKeepAlive.unref();

// ───────────── Game Logic (เทียบเท่า handle_client ใน Python) ─────────────
// สุ่ม ID ข้ออื่นให้ ESP32 เขียนลงแท็ก (ไม่ซ้ำข้อปัจจุบัน)
function pickNextId(currentId) {
  const others = database.ids().filter((k) => k !== currentId);
  if (!others.length) {
    log('GAME', `[Warning] ไม่มี ID อื่นใน Database ให้สุ่มเขียนลงแท็ก`);
    return null;
  }
  return others[Math.floor(Math.random() * others.length)];
}

function startRiddle(riddle) {
  state.isGameActive = true;
  state.score = 1000;
  state.hp = 3;
  state.currentAnswer = '';
  state.riddleId = riddle.id;
  log('GAME', `เริ่มโจทย์ ${riddle.id}`);

  // ส่งให้ทุกเครื่อง (เหมือน broadcast เดิม) — หน้าเกมใช้ Socket.io, ESP32 เดิมใช้ WS ดิบ
  io.emit('server:start-game', riddle);
  legacyBroadcast({ action: 'start_game', status: 'success', data: riddle });
  pushState();
}

// ใช้ร่วมกันทุกช่องทาง: Socket.io, HTTP, WS ดิบ → คืน { ok, tagId, nextId } หรือ { ok:false, error, code }
function processTag(data, source) {
  const uid = data && typeof data.uid === 'string' ? data.uid.trim() : '';
  const tagId = database.extractTagId(data);

  if (!tagId) {
    log('NFC', `[Warning] [${source}] ไม่มี tag_id หรือรูปแบบไม่ถูกต้อง`, JSON.stringify(data));
    return { ok: false, code: 400, error: "Missing or invalid 'tag_id'" };
  }
  log('NFC', `[${source}] Extracted Clean Tag ID: '${tagId}'`, uid ? `uid=${uid}` : '');

  // บันทึกการสแกนไว้ให้เครื่องแม่เห็น แม้จะไม่พบโจทย์ (ช่วยดีบักแท็ก)
  const chip = { uid, chipName: tagId, tagId, scannedAt: Date.now(), source };
  state.scannedChips = [...state.scannedChips, chip].slice(-MAX_CHIPS);
  io.emit('server:nfc-scanned', chip);

  const riddle = database.findRiddle(tagId);
  if (!riddle) {
    log('NFC', `[Warning] ไม่พบ ID '${tagId}' ใน Database (Available IDs: ${database.ids().join(', ') || '-'})`);
    const error = `Tag ID '${tagId}' not found in database`;
    io.emit('server:scan-error', { tagId, message: error });
    pushState();
    return { ok: false, code: 404, error };
  }

  startRiddle(riddle);
  const nextId = pickNextId(riddle.id);
  if (nextId) log('GAME', `ให้ ESP32 เขียน ID ถัดไปลงแท็ก: ${nextId}`);
  return { ok: true, tagId: riddle.id, nextId };
}

function resetGame(by = 'unknown') {
  state = createState(false); // กลับสู่โหมดรอสแกนแท็ก
  log('MASTER', `รีเซ็ตเกม โดย ${by}`);
  io.emit('client:reset', state);
  pushState();
}

function forcePass(by = 'unknown') {
  state.currentAnswer = '';
  state.scannedChips = [];
  state.isGameActive = false;
  log('MASTER', `ข้ามข้อคำถาม โดย ${by}`);
  io.emit('client:force-pass');
  pushState();
}

// ───────────── HTTP API (ESP32 แบบ HTTP / ทดสอบด้วยเบราว์เซอร์) ─────────────
const deviceAuth = (req, res, next) => {
  if (!DEVICE_KEY) return next();
  const key = req.get('x-api-key') || req.query.key || (req.body && req.body.key);
  if (key !== DEVICE_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
};

// POST JSON/form หรือ GET ?tagData=TAG_100 (&uid=...)
app.all('/api/nfc-scanned', deviceAuth, (req, res) => {
  const result = processTag(req.method === 'GET' ? req.query : req.body, 'esp32-http');
  if (!result.ok) return res.status(result.code).json({ ok: false, error: result.error });
  res.json({ ok: true, tagId: result.tagId, writeTag: result.nextId });
});

app.get('/api/state', (_req, res) => res.json(state));
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime(), riddles: database.ids().length }));

// ───────────── Socket.io (หน้าเกม / เครื่องแม่ / ESP32 แบบ Socket.io) ─────────────
io.on('connection', (socket) => {
  log('CONN', `เชื่อมต่อ id=${socket.id} (ออนไลน์ ${io.engine.clientsCount})`);
  socket.emit('server:state', state);

  // payload: { uid?, tagData | tagId | chipName } — ดึง TAG_xxx ออกมาเหมือน extract_tag_id เดิม
  socket.on('client:nfc-scanned', (data, ack) => {
    const source = data && typeof data.source === 'string' ? data.source.slice(0, 30) : 'client';
    const res = processTag(data, source);

    // ส่งคำสั่งเขียนแท็กกลับไปยังอุปกรณ์ที่สแกน (เทียบเท่า action "write_tag")
    if (res.ok && res.nextId) socket.emit('server:write-tag', { payload: res.nextId });

    if (typeof ack === 'function') {
      ack(res.ok ? { ok: true, tagId: res.tagId, writeTag: res.nextId } : { ok: false, error: res.error });
    }
  });

  // เครื่องลูกเป็นเจ้าของรอบเกม (คะแนน/พลังชีวิต/คำตอบที่พิมพ์) แล้วรายงานขึ้นมา
  socket.on('client:update-state', (patch) => {
    if (!patch || typeof patch !== 'object') return;
    const roundEnded = patch.isGameActive === false && state.isGameActive;

    if (Number.isFinite(patch.score)) state.score = patch.score;
    if (Number.isFinite(patch.streak)) state.streak = patch.streak;
    if (Number.isFinite(patch.hp)) state.hp = Math.max(0, Math.min(3, patch.hp));
    if (Number.isFinite(patch.timeLeft)) state.timeLeft = Math.max(0, patch.timeLeft);
    if (typeof patch.currentAnswer === 'string') state.currentAnswer = patch.currentAnswer.slice(0, 200);
    if (typeof patch.isGameActive === 'boolean') state.isGameActive = patch.isGameActive;

    if (roundEnded) {
      state.scannedChips = [];
      io.emit('server:state', state);
    } else {
      socket.broadcast.emit('server:state', state);
    }
  });

  socket.on('master:remote-reset', () => resetGame(socket.id));
  socket.on('master:force-pass', () => forcePass(socket.id));

  socket.on('disconnect', (reason) => log('CONN', `ตัดการเชื่อมต่อ id=${socket.id} reason=${reason}`));
});

// ───────────── Start / Shutdown ─────────────
server.listen(PORT, () => {
  log('SERVER', `พร้อมใช้งานที่พอร์ต ${PORT}`);
  log('SERVER', `โหลดโจทย์ ${database.ids().length} ข้อ จาก ${database.DB_PATH}`);
  log('SERVER', 'Endpoints: Socket.io (/socket.io), WebSocket ดิบ (/ws), HTTP (/api/nfc-scanned)');
});

const shutdown = (sig) => {
  log('SERVER', `ได้รับ ${sig} กำลังปิดเซิร์ฟเวอร์...`);
  clearInterval(wsKeepAlive);
  for (const ws of wss.clients) ws.terminate();
  io.close(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));