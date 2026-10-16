// SQLite storage using Node's built-in driver (no native build step needed).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'ibraya.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    phone         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'driver',
    lat           REAL,
    lng           REAL,
    accuracy      REAL,
    speed         REAL,
    heading       REAL,
    location_at   INTEGER,
    created_at    INTEGER NOT NULL
  );
  -- Guarantees there can never be more than one admin.
  CREATE UNIQUE INDEX IF NOT EXISTS one_admin ON users(role) WHERE role = 'admin';

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
`);

const ROLES = {
  admin: 'Admin',
  driver: 'Driver',
  import_driver: 'Import Driver',
  export_driver: 'Export Driver',
};

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Keep a leading "+" and digits only, so "+971 50-123 4567" and "+971501234567" match.
function normalizePhone(raw) {
  const s = String(raw || '').trim();
  const digits = s.replace(/\D/g, '');
  return (s.startsWith('+') ? '+' : '') + digits;
}

const stmts = {
  countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
  insertUser: db.prepare(
    'INSERT INTO users (name, phone, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)'
  ),
  byPhone: db.prepare('SELECT * FROM users WHERE phone = ?'),
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
  all: db.prepare('SELECT * FROM users ORDER BY role = \'admin\' DESC, name COLLATE NOCASE'),
  setRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
  demoteAdmin: db.prepare("UPDATE users SET role = 'driver' WHERE role = 'admin'"),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
  setLocation: db.prepare(
    'UPDATE users SET lat = ?, lng = ?, accuracy = ?, speed = ?, heading = ?, location_at = ? WHERE id = ?'
  ),
  insertSession: db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'),
  sessionUser: db.prepare(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?'
  ),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
};

function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// The very first account ever created becomes the admin.
function createUser({ name, phone, password }) {
  return transaction(() => {
    const isFirst = stmts.countUsers.get().n === 0;
    const role = isFirst ? 'admin' : 'driver';
    const info = stmts.insertUser.run(name, phone, hashPassword(password), role, Date.now());
    return stmts.byId.get(info.lastInsertRowid);
  });
}

// Making someone admin hands the role over: the current admin becomes a driver.
function changeRole(userId, role) {
  return transaction(() => {
    if (role === 'admin') stmts.demoteAdmin.run();
    stmts.setRole.run(role, userId);
    return stmts.byId.get(userId);
  });
}

function createSession(userId) {
  stmts.purgeSessions.run(Date.now());
  const token = crypto.randomBytes(32).toString('hex');
  stmts.insertSession.run(token, userId, Date.now() + SESSION_TTL_MS);
  return token;
}

module.exports = {
  ROLES,
  SESSION_TTL_MS,
  normalizePhone,
  verifyPassword,
  createUser,
  changeRole,
  createSession,
  getUserByPhone: (phone) => stmts.byPhone.get(phone),
  getUserById: (id) => stmts.byId.get(id),
  listUsers: () => stmts.all.all(),
  deleteUser: (id) => stmts.deleteUser.run(id),
  getSessionUser: (token) => (token ? stmts.sessionUser.get(token, Date.now()) : undefined),
  deleteSession: (token) => stmts.deleteSession.run(token),
  setLocation: (id, loc) =>
    stmts.setLocation.run(loc.lat, loc.lng, loc.accuracy, loc.speed, loc.heading, loc.at, id),
};
