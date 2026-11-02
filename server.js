// Fondul Clasei — server local, fără dependențe externe (Node 22+ cu node:sqlite)
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });

// Secret pentru semnarea cookie-ului de sesiune; se generează o dată și se păstrează în volum.
const secretFile = path.join(DATA_DIR, '.session-secret');
let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  SECRET = fs.readFileSync(secretFile, 'utf8').trim();
}

/* ---------------- baza de date ---------------- */
const db = new DatabaseSync(path.join(DATA_DIR, 'fond.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS students (id TEXT PRIMARY KEY, name TEXT NOT NULL, nr INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS expenses (id TEXT PRIMARY KEY, title TEXT NOT NULL, date TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
    alloc TEXT NOT NULL DEFAULT '{}', ord INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, student_id TEXT NOT NULL, amount REAL NOT NULL, date TEXT NOT NULL DEFAULT '',
    method TEXT NOT NULL DEFAULT 'transfer', note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY, student_id TEXT NOT NULL, amount REAL NOT NULL, date TEXT NOT NULL DEFAULT '',
    method TEXT NOT NULL DEFAULT 'transfer', note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL DEFAULT '{}');
`);

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Datele inițiale (importul din Excel) se încarcă doar dacă baza e goală.
function seedIfEmpty() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM students').get().n;
  const seedFile = path.join(__dirname, 'seed.json');
  if (n > 0 || !fs.existsSync(seedFile) || process.env.SKIP_SEED === '1') return;
  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  tx(() => {
    const s = db.prepare('INSERT INTO students (id,name,nr) VALUES (?,?,?)');
    seed.students.forEach(x => s.run(x.id, x.name, x.nr));
    const e = db.prepare('INSERT INTO expenses (id,title,date,note,alloc,ord,created_at) VALUES (?,?,?,?,?,?,?)');
    seed.expenses.forEach(x => e.run(x.id, x.title, x.date || '', x.note || '', JSON.stringify(x.alloc), x.order || 0, x.createdAt || 0));
    const p = db.prepare('INSERT INTO payments (id,student_id,amount,date,method,note,created_at) VALUES (?,?,?,?,?,?,?)');
    seed.payments.forEach(x => p.run(x.id, x.studentId, x.amount, x.date || '', x.method || 'import', x.note || '', x.createdAt || 0));
    const c = db.prepare('INSERT INTO claims (id,student_id,amount,date,method,note,created_at) VALUES (?,?,?,?,?,?,?)');
    (seed.claims || []).forEach(x => c.run(x.id, x.studentId, x.amount, x.date || '', x.method || 'transfer', x.note || '', x.createdAt || 0));
    db.prepare('INSERT OR REPLACE INTO settings (id,data) VALUES (1,?)').run(JSON.stringify(seed.settings || {}));
  });
  console.log(`Date inițiale importate: ${seed.students.length} elevi, ${seed.expenses.length} cheltuieli, ${seed.payments.length} plăți.`);
}
seedIfEmpty();

function state() {
  const students = db.prepare('SELECT id,name,nr FROM students ORDER BY nr, name').all();
  const expenses = db.prepare('SELECT * FROM expenses').all().map(r => ({
    id: r.id, title: r.title, date: r.date, note: r.note, alloc: JSON.parse(r.alloc), order: r.ord, createdAt: r.created_at }));
  const mapPay = r => ({ id: r.id, studentId: r.student_id, amount: r.amount, date: r.date, method: r.method, note: r.note, createdAt: r.created_at });
  const payments = db.prepare('SELECT * FROM payments').all().map(mapPay);
  const claims = db.prepare('SELECT * FROM claims ORDER BY created_at').all().map(mapPay);
  const row = db.prepare('SELECT data FROM settings WHERE id = 1').get();
  return { students, expenses, payments, claims, settings: row ? JSON.parse(row.data) : {} };
}

/* ---------------- validare ---------------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = msg => { throw new HttpError(400, msg); };
const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const money = v => { const n = Math.round(Number(v) * 100) / 100; if (!Number.isFinite(n) || n <= 0 || n > 1e6) bad('Sumă invalidă'); return n; };
const dateStr = v => { const s = str(v, 10); if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) bad('Dată invalidă'); return s; };
const METHODS = ['transfer', 'revolut', 'numerar', 'import'];
const method = v => METHODS.includes(v) ? v : 'transfer';
const idOk = id => /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : bad('Id invalid');
const newId = p => p + crypto.randomBytes(6).toString('hex');
const studentExists = id => !!db.prepare('SELECT 1 FROM students WHERE id = ?').get(id);

function cleanPayment(b) {
  const studentId = str(b.studentId, 64);
  if (!studentExists(studentId)) bad('Elev inexistent');
  return { studentId, amount: money(b.amount), date: dateStr(b.date), method: method(b.method), note: str(b.note), createdAt: Number(b.createdAt) || Date.now() };
}
function cleanExpense(b) {
  const title = str(b.title, 200); if (!title) bad('Lipsește denumirea');
  const alloc = {};
  for (const [k, v] of Object.entries(b.alloc || {})) {
    if (!studentExists(k)) continue;
    const n = Math.round(Number(v) * 100) / 100;
    if (Number.isFinite(n) && n > 0 && n <= 1e6) alloc[k] = n;
  }
  if (!Object.keys(alloc).length) bad('Pune o sumă la cel puțin un elev');
  return { title, date: dateStr(b.date), note: str(b.note), alloc, order: Number(b.order) || 0, createdAt: Number(b.createdAt) || Date.now() };
}

/* ---------------- sesiune casier ---------------- */
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function makeToken() { const exp = String(Date.now() + SESSION_DAYS * 864e5); return exp + '.' + sign('admin.' + exp); }
function isAdmin(req) {
  const m = /(?:^|;\s*)fc_sess=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign('admin.' + exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function passwordOk(p) {
  if (!ADMIN_PASSWORD) return false;
  const h = s => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(p), h(ADMIN_PASSWORD));
}
// Limitare simplă a încercărilor de autentificare, pe IP.
const attempts = new Map();
function throttle(ip) {
  const now = Date.now(); const a = (attempts.get(ip) || []).filter(t => now - t < 15 * 60e3);
  if (a.length >= 10) throw new HttpError(429, 'Prea multe încercări. Mai încearcă peste 15 minute.');
  a.push(now); attempts.set(ip, a);
}

/* ---------------- notificări live (SSE) ---------------- */
const clients = new Set();
function broadcast() { for (const res of clients) res.write('event: changed\ndata: 1\n\n'); }
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25e3).unref();

/* ---------------- HTTP ---------------- */
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 512e3) { reject(new HttpError(413, 'Cerere prea mare')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'JSON invalid')); } });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Nu există');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

function csv() {
  const s = state();
  const c = v => Math.round(Number(v || 0) * 100);
  const n = x => (x / 100).toFixed(2).replace('.', ',');
  const q = v => `"${String(v).replace(/"/g, '""')}"`;
  const k = e => e.order > 0 ? e.order : 1e9;
  const ex = [...s.expenses].sort((a, b) => (k(a) - k(b)) || (a.date || '').localeCompare(b.date || '') || (a.createdAt - b.createdAt));
  const lines = [['Nr. Crt', 'Nume și prenume', 'TOTAL VIRAT', 'SOLD', ...ex.map(e => e.title)].map(q).join(';')];
  for (const st of s.students) {
    const paid = s.payments.filter(p => p.studentId === st.id).reduce((a, p) => a + c(p.amount), 0);
    const spent = s.expenses.reduce((a, e) => a + c(e.alloc[st.id]), 0);
    lines.push([st.nr, st.name, n(paid), n(paid - spent), ...ex.map(e => n(c(e.alloc[st.id])))].map(q).join(';'));
  }
  return '﻿' + lines.join('\r\n');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (!p.startsWith('/api/')) return req.method === 'GET' ? serveStatic(req, res) : send(res, 405, 'Metodă nepermisă');

  try {
    const admin = isAdmin(req);
    const needAdmin = () => { if (!admin) throw new HttpError(401, 'Doar casierul poate face asta. Autentifică-te.'); };
    const M = req.method;
    const seg = p.split('/').slice(2); // ['students', ':id', ...]
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const done = (body = { ok: true }) => { broadcast(); send(res, 200, body); };

    if (p === '/api/state' && M === 'GET') return send(res, 200, { ...state(), admin, adminEnabled: !!ADMIN_PASSWORD });
    if (p === '/api/events' && M === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': ok\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (p === '/api/login' && M === 'POST') {
      throttle(ip);
      const b = await readBody(req);
      if (!ADMIN_PASSWORD) throw new HttpError(503, 'Parola de casier nu e setată pe server (ADMIN_PASSWORD).');
      if (!passwordOk(b.password)) throw new HttpError(401, 'Parolă greșită.');
      attempts.delete(ip);
      const secure = (req.headers['x-forwarded-proto'] || '') === 'https' ? '; Secure' : '';
      return send(res, 200, { ok: true }, { 'Set-Cookie': `fc_sess=${makeToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}` });
    }
    if (p === '/api/logout' && M === 'POST') return send(res, 200, { ok: true }, { 'Set-Cookie': 'fc_sess=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    if (p === '/api/export.csv' && M === 'GET') {
      needAdmin();
      const d = new Date().toISOString().slice(0, 10);
      return send(res, 200, csv(), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="fondul-clasei-${d}.csv"` });
    }

    // Anunț de plată de la părinte: public, dar limitat.
    if (p === '/api/claims' && M === 'POST') {
      const pending = db.prepare('SELECT COUNT(*) AS n FROM claims').get().n;
      if (pending >= 300) throw new HttpError(429, 'Sunt prea multe anunțuri neconfirmate. Anunță casierul direct.');
      const c = cleanPayment(await readBody(req)); c.createdAt = Date.now();
      db.prepare('INSERT INTO claims (id,student_id,amount,date,method,note,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(newId('c'), c.studentId, c.amount, c.date, c.method === 'import' ? 'transfer' : c.method, c.note, c.createdAt);
      return done();
    }

    // De aici în jos: doar casierul.
    needAdmin();
    const [coll, rawId, action] = seg;
    const id = rawId ? idOk(rawId) : null;

    if (coll === 'settings' && M === 'PUT') {
      const b = await readBody(req); const out = {};
      ['className', 'school', 'beneficiar', 'iban', 'bank', 'revolut', 'contact', 'payNote'].forEach(k => out[k] = str(b[k]));
      db.prepare('INSERT OR REPLACE INTO settings (id,data) VALUES (1,?)').run(JSON.stringify(out));
      return done();
    }
    if (coll === 'students') {
      if (M === 'PUT' && id) {
        const b = await readBody(req); const name = str(b.name, 120); const nr = Math.trunc(Number(b.nr));
        if (!name || !(nr > 0)) bad('Nume și număr obligatorii');
        db.prepare('INSERT INTO students (id,name,nr) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, nr=excluded.nr').run(id, name, nr);
        return done();
      }
      if (M === 'DELETE' && id) {
        const used = db.prepare('SELECT 1 FROM payments WHERE student_id=? UNION SELECT 1 FROM claims WHERE student_id=?').get(id, id)
          || db.prepare('SELECT alloc FROM expenses').all().some(r => id in JSON.parse(r.alloc));
        if (used) bad('Elevul are plăți sau cheltuieli. Șterge-le întâi.');
        db.prepare('DELETE FROM students WHERE id=?').run(id); return done();
      }
    }
    if (coll === 'expenses') {
      if (M === 'POST' && !id) {
        const e = cleanExpense(await readBody(req));
        db.prepare('INSERT INTO expenses (id,title,date,note,alloc,ord,created_at) VALUES (?,?,?,?,?,?,?)').run(newId('e'), e.title, e.date, e.note, JSON.stringify(e.alloc), e.order, e.createdAt);
        return done();
      }
      if (M === 'PUT' && id) {
        const e = cleanExpense(await readBody(req));
        const r = db.prepare('UPDATE expenses SET title=?,date=?,note=?,alloc=?,ord=? WHERE id=?').run(e.title, e.date, e.note, JSON.stringify(e.alloc), e.order, id);
        if (!r.changes) throw new HttpError(404, 'Cheltuiala nu mai există');
        return done();
      }
      if (M === 'DELETE' && id) { db.prepare('DELETE FROM expenses WHERE id=?').run(id); return done(); }
    }
    if (coll === 'payments') {
      if (M === 'POST' && !id) {
        const x = cleanPayment(await readBody(req));
        db.prepare('INSERT INTO payments (id,student_id,amount,date,method,note,created_at) VALUES (?,?,?,?,?,?,?)').run(newId('p'), x.studentId, x.amount, x.date, x.method, x.note, x.createdAt);
        return done();
      }
      if (M === 'PUT' && id) {
        const x = cleanPayment(await readBody(req));
        const r = db.prepare('UPDATE payments SET student_id=?,amount=?,date=?,method=?,note=? WHERE id=?').run(x.studentId, x.amount, x.date, x.method, x.note, id);
        if (!r.changes) throw new HttpError(404, 'Plata nu mai există');
        return done();
      }
      if (M === 'DELETE' && id) { db.prepare('DELETE FROM payments WHERE id=?').run(id); return done(); }
    }
    if (coll === 'claims' && id) {
      if (M === 'DELETE' && !action) { db.prepare('DELETE FROM claims WHERE id=?').run(id); return done(); }
      if (M === 'POST' && action === 'confirm') {
        const x = cleanPayment(await readBody(req));
        tx(() => {
          const r = db.prepare('DELETE FROM claims WHERE id=?').run(id);
          if (!r.changes) throw new HttpError(409, 'Anunțul a fost deja procesat');
          db.prepare('INSERT INTO payments (id,student_id,amount,date,method,note,created_at) VALUES (?,?,?,?,?,?,?)').run(newId('p'), x.studentId, x.amount, x.date, x.method, x.note, Date.now());
        });
        return done();
      }
    }
    throw new HttpError(404, 'Rută necunoscută');
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    send(res, status, { error: status === 500 ? 'Eroare internă' : e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Fondul Clasei rulează pe http://localhost:${PORT}`);
  if (!ADMIN_PASSWORD) console.warn('ATENȚIE: ADMIN_PASSWORD nu e setat — nimeni nu se poate autentifica drept casier.');
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
