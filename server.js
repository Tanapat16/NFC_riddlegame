const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

// ───────────── Config ─────────────
const PORT = process.env.PORT || 3000; // Render กำหนด PORT ให้อัตโนมัติ
const GAME_DURATION = Number(process.env.GAME_DURATION_SEC) || 300;
const DEVICE_KEY = process.env.DEVICE_KEY || ''; // ถ้าตั้งไว้ ESP32 (HTTP) ต้องแนบ key มาด้วย
const MAX_CHIPS = 50;

const log = (tag, msg, extra = '') => console.log(`${new Date().toISOString()} [${tag}] ${msg}`, extra);

// ───────────── Global Game State ─────────────
const createState = (isGameActive = false) => ({
  score: 0,
  streak: 0,
  timeLeft: GAME_DURATION,
  currentAnswer: '',
  scannedChips: [], // [{ uid, chipName, scannedAt, source }]
  isGameActive,
});

let state = createState();

// ───────────── App / Server ─────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }, // ปรับเป็นโดเมนจริงเมื่อขึ้น production
  pingInterval: 10000,
  pingTimeout: 20000,
});

const pushState = () => io.emit('server:state', state);

// ───────────── Game Actions (ใช้ร่วมกันทุกช่องทาง) ─────────────
// source: 'web-serial' | 'esp32-socket' | 'esp32-http' | ...
function recordScan(data, source = 'unknown') {
  const uid = data && typeof data.uid === 'string' ? data.uid.trim() : '';
  const chipName = data && typeof data.chipName === 'string' ? data.chipName.trim() : '';
  if (!uid || !chipName) return null;

  const chip = { uid, chipName, scannedAt: Date.now(), source };
  state.scannedChips = [...state.scannedChips, chip].slice(-MAX_CHIPS);
  log('NFC', `[${source}] uid=${uid} chip=${chipName}`);

  io.emit('server:nfc-scanned', chip); // ทุกเครื่องรับรู้ทันที
  pushState();
  return chip;
}

function resetGame(by = 'unknown') {
  state = createState(true);
  log('MASTER', `รีเซ็ต/เริ่มเกมใหม่ โดย ${by}`);
  io.emit('client:reset', state); // สั่งเครื่องลูกรีเซ็ตและเริ่มนับเวลา
  pushState();
}

function forcePass(by = 'unknown') {
  state.currentAnswer = '';
  state.scannedChips = [];
  log('MASTER', `ข้ามข้อคำถาม โดย ${by}`);
  io.emit('client:force-pass');
  pushState();
}

// ───────────── HTTP API (ช่องทางสำรองสำหรับ ESP32 ที่ไม่มี Socket.io) ─────────────
const deviceAuth = (req, res, next) => {
  if (!DEVICE_KEY) return next();
  const key = req.get('x-api-key') || req.query.key || (req.body && req.body.key);
  if (key !== DEVICE_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
};

app.all('/api/nfc-scanned', deviceAuth, (req, res) => {
  const chip = recordScan(req.method === 'GET' ? req.query : req.body, 'esp32-http');
  if (!chip) return res.status(400).json({ ok: false, error: 'invalid_payload' });
  res.json({ ok: true, chip });
});

app.get('/api/state', (_req, res) => res.json(state));
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ───────────── Socket Events ─────────────
io.on('connection', (socket) => {
  log('CONN', `เชื่อมต่อ id=${socket.id} (ออนไลน์ ${io.engine.clientsCount})`);

  // ส่ง state ปัจจุบันให้ผู้เชื่อมต่อใหม่ทันที
  socket.emit('server:state', state);

  // เครื่องลูก (Web Serial) หรือ ESP32 ผ่าน Socket.io
  socket.on('client:nfc-scanned', (data, ack) => {
    const source = data && typeof data.source === 'string' ? data.source.slice(0, 30) : 'client';
    const chip = recordScan(data, source);
    if (typeof ack === 'function') ack(chip ? { ok: true } : { ok: false, error: 'invalid_payload' });
  });

  // เครื่องลูกส่งเวลา/คะแนน/ข้อความที่พิมพ์ → ส่งต่อให้เครื่องแม่มอนิเตอร์
  socket.on('client:update-state', (patch) => {
    if (!patch || typeof patch !== 'object') return;
    if (Number.isFinite(patch.score)) state.score = patch.score;
    if (Number.isFinite(patch.streak)) state.streak = patch.streak;
    if (Number.isFinite(patch.timeLeft)) state.timeLeft = Math.max(0, patch.timeLeft);
    if (typeof patch.currentAnswer === 'string') state.currentAnswer = patch.currentAnswer.slice(0, 200);
    if (typeof patch.isGameActive === 'boolean') state.isGameActive = patch.isGameActive;
    socket.broadcast.emit('server:state', state); // ทุกเครื่องยกเว้นต้นทาง
  });

  socket.on('master:remote-reset', () => resetGame(socket.id));
  socket.on('master:force-pass', () => forcePass(socket.id));

  socket.on('disconnect', (reason) => log('CONN', `ตัดการเชื่อมต่อ id=${socket.id} reason=${reason}`));
});

// ───────────── Start / Shutdown ─────────────
server.listen(PORT, () => log('SERVER', `พร้อมใช้งานที่พอร์ต ${PORT}`));

const shutdown = (sig) => {
  log('SERVER', `ได้รับ ${sig} กำลังปิดเซิร์ฟเวอร์...`);
  io.close(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));