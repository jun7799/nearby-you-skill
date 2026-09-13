// db.js — SQLite 初始化、建表与 CRUD 封装
// secret 只存 sha256 哈希，绝不存明文

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'data.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS profiles (
  id          TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  nickname    TEXT NOT NULL,
  bio         TEXT NOT NULL DEFAULT '',
  agent_info  TEXT NOT NULL DEFAULT '',
  contact     TEXT NOT NULL DEFAULT '',
  lat         REAL,
  lon         REAL,
  address     TEXT NOT NULL DEFAULT '',
  city        TEXT NOT NULL DEFAULT '',
  loc_source  TEXT NOT NULL DEFAULT '',
  ip_hash     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profiles_ip_hash ON profiles(ip_hash);
CREATE INDEX IF NOT EXISTS idx_profiles_updated_at ON profiles(updated_at);
`);

// ---- 工具 ----

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function newId() {
  return crypto.randomUUID();
}

// 明文 secret 只在创建响应里出现一次，之后只留哈希
function newSecret() {
  return crypto.randomBytes(24).toString('base64url');
}

function nowIso() {
  return new Date().toISOString();
}

// ---- CRUD ----

function countByIpHash(ipHash) {
  return db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE ip_hash = ?').get(ipHash).n;
}

function countAll() {
  return db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n;
}

function insertProfile(p) {
  db.prepare(`
    INSERT INTO profiles (id, secret_hash, nickname, bio, agent_info, contact,
                          lat, lon, address, city, loc_source, ip_hash, created_at, updated_at)
    VALUES (@id, @secret_hash, @nickname, @bio, @agent_info, @contact,
            @lat, @lon, @address, @city, @loc_source, @ip_hash, @created_at, @updated_at)
  `).run(p);
}

function getProfile(id) {
  return db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
}

// 动态更新白名单字段（绝不允许更新 id / secret_hash / source_ip / created_at）
const UPDATABLE = ['nickname', 'bio', 'agent_info', 'contact',
                   'lat', 'lon', 'address', 'city', 'loc_source', 'updated_at'];

function updateProfile(id, fields) {
  const keys = Object.keys(fields).filter((k) => UPDATABLE.includes(k));
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE profiles SET ${sets} WHERE id = @id`).run({ id, ...fields });
}

function deleteProfile(id) {
  db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
}

// nearby 查询用：全量取回，距离在 JS 里算（数据量小，毫秒级）
function allProfiles() {
  return db.prepare('SELECT * FROM profiles').all();
}

module.exports = {
  sha256, newId, newSecret, nowIso,
  countByIpHash, countAll, insertProfile, getProfile, updateProfile, deleteProfile, allProfiles,
};
