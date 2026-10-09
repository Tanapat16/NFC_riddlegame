const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'database.json');

// เทียบเท่า load_database() ใน Python: โหลด list ของโจทย์ แล้วทำเป็น Map ค้นหาด้วย id
function loadDatabase() {
  try {
    const list = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    if (!Array.isArray(list)) throw new Error('database.json ต้องเป็น Array');
    const map = new Map();
    for (const item of list) {
      if (item && item.id != null) map.set(String(item.id), item);
      else console.warn('[Warning] ข้ามรายการที่ไม่มี "id":', JSON.stringify(item).slice(0, 80));
    }
    return map;
  } catch (err) {
    if (err.code === 'ENOENT') console.error(`[Error] ไม่พบไฟล์ ${DB_PATH}`);
    else if (err instanceof SyntaxError) console.error('[Error] รูปแบบไฟล์ database.json ไม่ถูกต้อง:', err.message);
    else console.error('[Error] โหลด database.json ไม่สำเร็จ:', err.message);
    return new Map();
  }
}

const db = loadDatabase();

const ids = () => [...db.keys()];

// ค้นหาแบบตรงตัวก่อน ถ้าไม่พบลองไม่สนตัวพิมพ์เล็ก/ใหญ่
function findRiddle(tagId) {
  if (db.has(tagId)) return db.get(tagId);
  const upper = String(tagId).toUpperCase();
  for (const [k, v] of db) if (k.toUpperCase() === upper) return v;
  return null;
}

// เทียบเท่า extract_tag_id() ใน Python
// รองรับ tag_id / TAG_id / tagID / tag_ID (+ tagId, tagData, chipName ที่ใช้ใน Socket.io)
// และแกะข้อความซ้อน เช่น ' "id": "TAG_100" ' ให้เหลือ TAG_100
function extractTagId(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  const raw = [data.tag_id, data.TAG_id, data.tagID, data.tag_ID, data.tagId, data.tagData, data.chipName]
    .find((v) => v !== undefined && v !== null && String(v).trim() !== '');
  if (raw === undefined) return null;

  const str = String(raw).trim();
  const m = str.match(/TAG_[\p{L}\p{N}_]+/iu);
  if (m) return m[0].toUpperCase();
  return str || null;
}

module.exports = { db, ids, findRiddle, extractTagId, DB_PATH };