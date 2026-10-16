const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const COOKIE = 'ibraya_session';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  });
  next();
});

// ---------- helpers ----------

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function tokenFrom(req) {
  return parseCookies(req.headers.cookie)[COOKIE];
}

function setSessionCookie(req, res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: db.SESSION_TTL_MS,
  });
}

// What a driver is allowed to see about themselves.
function selfView(u) {
  return { id: u.id, name: u.name, phone: u.phone, role: u.role, roleLabel: db.ROLES[u.role] };
}

// What the admin sees about each user.
function adminView(u) {
  return {
    ...selfView(u),
    online: onlineCount(u.id) > 0,
    createdAt: u.created_at,
    location:
      u.lat == null
        ? null
        : { lat: u.lat, lng: u.lng, accuracy: u.accuracy, speed: u.speed, heading: u.heading, at: u.location_at },
  };
}

function auth(req, res, next) {
  const user = db.getSessionUser(tokenFrom(req));
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  next();
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// Simple in-memory brute-force protection for sign-in.
const attempts = new Map();
function tooManyAttempts(key) {
  const now = Date.now();
  const entry = attempts.get(key) || { count: 0, reset: now + 15 * 60 * 1000 };
  if (now > entry.reset) Object.assign(entry, { count: 0, reset: now + 15 * 60 * 1000 });
  entry.count++;
  attempts.set(key, entry);
  return entry.count > 10;
}

// ---------- API ----------

app.post('/api/register', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const phone = db.normalizePhone(req.body.phone);
  const password = String(req.body.password || '');

  if (!name) return res.status(400).json({ error: 'Please enter your name' });
  if (phone.replace('+', '').length < 7) return res.status(400).json({ error: 'Please enter a valid phone number' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (db.getUserByPhone(phone)) return res.status(409).json({ error: 'This phone number is already registered' });

  const user = db.createUser({ name, phone, password });
  setSessionCookie(req, res, db.createSession(user.id));
  notifyAdmins();
  res.json({ user: selfView(user) });
});

app.post('/api/login', (req, res) => {
  const phone = db.normalizePhone(req.body.phone);
  const password = String(req.body.password || '');
  if (tooManyAttempts(`${req.ip}|${phone}`)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }
  const user = db.getUserByPhone(phone);
  if (!user || !db.verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Wrong phone number or password' });
  }
  setSessionCookie(req, res, db.createSession(user.id));
  res.json({ user: selfView(user) });
});

app.post('/api/logout', (req, res) => {
  const token = tokenFrom(req);
  if (token) db.deleteSession(token);
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: selfView(req.user) }));

app.get('/api/roles', auth, adminOnly, (req, res) => res.json({ roles: db.ROLES }));

app.get('/api/users', auth, adminOnly, (req, res) => {
  res.json({ users: db.listUsers().map(adminView) });
});

app.patch('/api/users/:id/role', auth, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const role = String(req.body.role || '');
  const target = db.getUserById(id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!db.ROLES[role]) return res.status(400).json({ error: 'Unknown role' });
  if (target.id === req.user.id) {
    return res.status(400).json({ error: 'To give up admin, make another user the admin' });
  }

  const updated = db.changeRole(id, role);
  io.to(`user:${id}`).emit('role:changed', selfView(updated));
  if (role === 'admin') {
    // Previous admin (the requester) is now a driver and loses the live feed immediately.
    io.in(`user:${req.user.id}`).socketsLeave('admins');
    io.in(`user:${id}`).socketsJoin('admins');
    io.to(`user:${req.user.id}`).emit('role:changed', selfView(db.getUserById(req.user.id)));
  }
  notifyAdmins();
  res.json({ user: adminView(updated) });
});

app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own admin account' });
  if (!db.getUserById(id)) return res.status(404).json({ error: 'User not found' });
  db.deleteUser(id);
  io.to(`user:${id}`).emit('account:deleted');
  io.in(`user:${id}`).disconnectSockets(true);
  notifyAdmins();
  res.json({ ok: true });
});

// ---------- pages ----------

function page(file) {
  return (req, res) => res.sendFile(path.join(__dirname, 'public', file));
}

app.get('/', (req, res) => {
  const user = db.getSessionUser(tokenFrom(req));
  if (!user) return res.redirect('/login');
  res.redirect(user.role === 'admin' ? '/admin' : '/driver');
});
app.get('/login', page('login.html'));
app.get('/driver', page('driver.html'));
app.get('/admin', page('admin.html'));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.use('/vendor/leaflet', express.static(path.join(path.dirname(require.resolve('leaflet')))));

// ---------- realtime ----------

const online = new Map(); // userId -> number of open connections
const onlineCount = (id) => online.get(id) || 0;

function notifyAdmins() {
  io.to('admins').emit('users', db.listUsers().map(adminView));
}

io.use((socket, next) => {
  const user = db.getSessionUser(parseCookies(socket.handshake.headers.cookie)[COOKIE]);
  if (!user) return next(new Error('unauthorized'));
  socket.data.userId = user.id;
  next();
});

io.on('connection', (socket) => {
  const userId = socket.data.userId;
  const user = db.getUserById(userId);
  socket.join(`user:${userId}`);
  online.set(userId, onlineCount(userId) + 1);

  if (user.role === 'admin') {
    socket.join('admins');
    socket.emit('users', db.listUsers().map(adminView));
  }
  io.to('admins').emit('presence', { id: userId, online: true });

  socket.on('location', (loc) => {
    const current = db.getUserById(userId);
    if (!current || current.role === 'admin') return; // admin is not tracked
    const lat = Number(loc?.lat);
    const lng = Number(loc?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    const num = (v) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : null);
    const clean = { lat, lng, accuracy: num(loc.accuracy), speed: num(loc.speed), heading: num(loc.heading), at: Date.now() };
    db.setLocation(userId, clean);
    io.to('admins').emit('location', { id: userId, location: clean });
  });

  socket.on('disconnect', () => {
    const n = onlineCount(userId) - 1;
    if (n > 0) online.set(userId, n);
    else online.delete(userId);
    io.to('admins').emit('presence', { id: userId, online: n > 0 });
  });
});

server.listen(PORT, () => {
  console.log(`Ibraya Logistics Tracking running on http://localhost:${PORT}`);
});
