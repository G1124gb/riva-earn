const express = require('express');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = new Set((process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'riva-earn.sqlite');
require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  balance REAL NOT NULL DEFAULT 0,
  referred_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(telegram_id) REFERENCES users(telegram_id)
);
CREATE TABLE IF NOT EXISTS daily_claims (
  telegram_id TEXT NOT NULL,
  claim_date TEXT NOT NULL,
  amount REAL NOT NULL,
  PRIMARY KEY(telegram_id, claim_date),
  FOREIGN KEY(telegram_id) REFERENCES users(telegram_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title_en TEXT NOT NULL,
  title_am TEXT NOT NULL DEFAULT '',
  title_om TEXT NOT NULL DEFAULT '',
  description_en TEXT NOT NULL DEFAULT '',
  reward REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS task_completions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(telegram_id, task_id),
  FOREIGN KEY(telegram_id) REFERENCES users(telegram_id),
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL,
  amount REAL NOT NULL,
  method TEXT NOT NULL,
  account_detail TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(telegram_id) REFERENCES users(telegram_id)
);
`);

function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN) throw new Error('Server is not configured: BOT_TOKEN is missing.');
  if (!initData || typeof initData !== 'string') throw new Error('Open this app from your Telegram bot.');
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  const authDate = Number(params.get('auth_date') || 0);
  if (!hash || !authDate) throw new Error('Invalid Telegram login data.');
  // Reject stale initData older than 24 hours.
  if (Math.floor(Date.now() / 1000) - authDate > 86400) throw new Error('Telegram session expired. Close and reopen the Mini App.');
  params.delete('hash');
  params.delete('signature');
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const a = Buffer.from(calculatedHash, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Telegram login could not be verified.');
  const userText = params.get('user');
  if (!userText) throw new Error('Telegram user details are missing.');
  const user = JSON.parse(userText);
  if (!user.id) throw new Error('Telegram user ID is missing.');
  return { user, startParam: params.get('start_param') || '' };
}

function auth(req, res, next) {
  try {
    const initData = req.get('X-Telegram-Init-Data') || req.body?.initData;
    const verified = verifyTelegramInitData(initData);
    const u = verified.user;
    const existing = db.prepare('SELECT telegram_id FROM users WHERE telegram_id = ?').get(String(u.id));
    let referrer = null;
    const startParam = verified.startParam;
    if (!existing && startParam.startsWith('ref_')) {
      const candidate = startParam.slice(4);
      if (candidate && candidate !== String(u.id) && db.prepare('SELECT telegram_id FROM users WHERE telegram_id = ?').get(candidate)) referrer = candidate;
    }
    const insert = db.prepare(`INSERT INTO users (telegram_id, username, first_name, referred_by)
      VALUES (@id, @username, @first_name, @referrer)
      ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name, last_seen=CURRENT_TIMESTAMP`);
    insert.run({ id: String(u.id), username: u.username || '', first_name: u.first_name || '', referrer });
    req.telegramUser = u;
    req.telegramId = String(u.id);
    req.isAdmin = ADMIN_IDS.has(String(u.id));
    next();
  } catch (e) {
    res.status(401).json({ error: e.message || 'Authentication failed.' });
  }
}
app.use('/api', auth);

function userRow(id) {
  return db.prepare('SELECT telegram_id, username, first_name, language, balance, referred_by, created_at FROM users WHERE telegram_id = ?').get(id);
}
function addTransaction(id, type, amount, status, note) {
  db.prepare('INSERT INTO transactions (telegram_id,type,amount,status,note) VALUES (?,?,?,?,?)').run(id, type, amount, status, note);
}
function todayUTC() { return new Date().toISOString().slice(0, 10); }

app.get('/api/me', (req, res) => {
  const user = userRow(req.telegramId);
  const claims = db.prepare('SELECT claim_date FROM daily_claims WHERE telegram_id=? AND claim_date=?').get(req.telegramId, todayUTC());
  const pending = db.prepare("SELECT COUNT(*) AS n FROM withdrawals WHERE telegram_id=? AND status='pending'").get(req.telegramId).n;
  res.json({ user, isAdmin: req.isAdmin, claimedToday: !!claims, pendingWithdrawals: pending, dailyBonusETB: Number(process.env.DAILY_BONUS_ETB || 10) });
});

app.post('/api/language', (req, res) => {
  const lang = ['en','am','om'].includes(req.body.language) ? req.body.language : 'en';
  db.prepare('UPDATE users SET language=? WHERE telegram_id=?').run(lang, req.telegramId);
  res.json({ ok: true, language: lang });
});

app.post('/api/bonus', (req, res) => {
  const amount = Number(process.env.DAILY_BONUS_ETB || 10);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) return res.status(500).json({ error: 'Daily bonus amount is not configured correctly.' });
  const claim = db.transaction(() => {
    const already = db.prepare('SELECT 1 FROM daily_claims WHERE telegram_id=? AND claim_date=?').get(req.telegramId, todayUTC());
    if (already) return false;
    db.prepare('INSERT INTO daily_claims (telegram_id,claim_date,amount) VALUES (?,?,?)').run(req.telegramId, todayUTC(), amount);
    db.prepare('UPDATE users SET balance=balance+? WHERE telegram_id=?').run(amount, req.telegramId);
    addTransaction(req.telegramId, 'daily_bonus', amount, 'approved', 'Daily bonus ETB');
    return true;
  });
  try {
    if (!claim()) return res.status(409).json({ error: 'You have already claimed today’s bonus.' });
    res.json({ ok: true, amount, balance: userRow(req.telegramId).balance });
  } catch (e) { res.status(500).json({ error: 'Could not claim bonus. Please try again.' }); }
});

app.get('/api/tasks', (req, res) => {
  const lang = userRow(req.telegramId).language;
  const rows = db.prepare('SELECT * FROM tasks WHERE active=1 ORDER BY id DESC').all().map(t => ({
    id: t.id, title: lang === 'om' ? t.title_om : lang === 'am' ? (t.title_am || t.title_en) : t.title_en,
    description: t.description_en, reward: t.reward,
    status: (db.prepare('SELECT status FROM task_completions WHERE telegram_id=? AND task_id=?').get(req.telegramId, t.id) || {}).status || 'available'
  }));
  res.json({ tasks: rows });
});

app.post('/api/tasks/:id/complete', (req, res) => {
  const task = db.prepare('SELECT id FROM tasks WHERE id=? AND active=1').get(Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  try {
    db.prepare("INSERT INTO task_completions (telegram_id,task_id,status) VALUES (?,?, 'pending')").run(req.telegramId, task.id);
    res.json({ ok: true, message: 'Task submitted for administrator review.' });
  } catch { res.status(409).json({ error: 'You have already submitted this task.' }); }
});

app.get('/api/invite', (req, res) => {
  const botUsername = process.env.BOT_USERNAME;
  if (!botUsername) return res.status(503).json({ error: 'Set BOT_USERNAME in the server environment first.' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM users WHERE referred_by=?').get(req.telegramId).n;
  res.json({ link: `https://t.me/${botUsername}?startapp=ref_${req.telegramId}`, referrals: count });
});

app.post('/api/withdraw', (req, res) => {
  const amount = Number(req.body.amount);
  const method = String(req.body.method || '');
  const detail = String(req.body.accountDetail || '').trim().slice(0, 200);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) return res.status(400).json({ error: 'Enter a valid ETB amount.' });
  if (!['Telebirr','CBE','CBE Birr'].includes(method)) return res.status(400).json({ error: 'Choose a supported payment method.' });
  if (detail.length < 3) return res.status(400).json({ error: 'Enter the receiving account or phone number.' });
  const create = db.transaction(() => {
    const u = userRow(req.telegramId);
    if (u.balance < amount) throw new Error('INSUFFICIENT_BALANCE');
    db.prepare('UPDATE users SET balance=balance-? WHERE telegram_id=?').run(amount, req.telegramId);
    const result = db.prepare('INSERT INTO withdrawals (telegram_id,amount,method,account_detail) VALUES (?,?,?,?)').run(req.telegramId, amount, method, detail);
    addTransaction(req.telegramId, 'withdrawal', -amount, 'pending', `Withdrawal request #${result.lastInsertRowid}`);
    return result.lastInsertRowid;
  });
  try {
    const id = create();
    res.json({ ok: true, requestId: id, message: 'Withdrawal request submitted for administrator review.' });
  } catch (e) {
    if (e.message === 'INSUFFICIENT_BALANCE') return res.status(400).json({ error: 'Your available balance is too low.' });
    res.status(500).json({ error: 'Could not submit withdrawal request.' });
  }
});

app.get('/api/history', (req, res) => {
  const rows = db.prepare('SELECT type,amount,status,note,created_at FROM transactions WHERE telegram_id=? ORDER BY id DESC LIMIT 100').all(req.telegramId);
  res.json({ transactions: rows });
});

app.get('/api/admin/overview', (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Administrator access required.' });
  res.json({
    users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
    totalBalance: db.prepare('SELECT COALESCE(SUM(balance),0) n FROM users').get().n,
    pendingWithdrawals: db.prepare("SELECT COUNT(*) n FROM withdrawals WHERE status='pending'").get().n,
    pendingTasks: db.prepare("SELECT COUNT(*) n FROM task_completions WHERE status='pending'").get().n
  });
});
app.get('/api/admin/withdrawals', (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Administrator access required.' });
  res.json({ withdrawals: db.prepare(`SELECT w.*,u.username,u.first_name FROM withdrawals w JOIN users u ON u.telegram_id=w.telegram_id ORDER BY w.id DESC LIMIT 100`).all() });
});
app.post('/api/admin/withdrawals/:id/review', (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Administrator access required.' });
  const decision = req.body.decision;
  if (!['paid','rejected'].includes(decision)) return res.status(400).json({ error: 'Decision must be paid or rejected.' });
  const action = db.transaction(() => {
    const w = db.prepare("SELECT * FROM withdrawals WHERE id=? AND status='pending'").get(Number(req.params.id));
    if (!w) throw new Error('NOT_PENDING');
    db.prepare('UPDATE withdrawals SET status=? WHERE id=?').run(decision, w.id);
    if (decision === 'rejected') {
      db.prepare('UPDATE users SET balance=balance+? WHERE telegram_id=?').run(w.amount, w.telegram_id);
      addTransaction(w.telegram_id, 'withdrawal_refund', w.amount, 'approved', `Refund for rejected withdrawal #${w.id}`);
    } else {
      addTransaction(w.telegram_id, 'withdrawal_paid', 0, 'approved', `Administrator marked withdrawal #${w.id} as paid`);
    }
  });
  try { action(); res.json({ ok: true }); }
  catch (e) { res.status(409).json({ error: 'This request may already have been reviewed.' }); }
});
app.post('/api/admin/tasks', (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Administrator access required.' });
  const title = String(req.body.title || '').trim().slice(0,120);
  const titleAm = String(req.body.titleAm || title).trim().slice(0,120);
  const titleOm = String(req.body.titleOm || title).trim().slice(0,120);
  const description = String(req.body.description || '').trim().slice(0,500);
  const reward = Number(req.body.reward || 0);
  if (!title || !Number.isFinite(reward) || reward < 0 || reward > 100000) return res.status(400).json({ error: 'Provide a task title and valid reward.' });
  const result = db.prepare('INSERT INTO tasks (title_en,title_am,title_om,description_en,reward) VALUES (?,?,?,?,?)').run(title,titleAm,titleOm,description,reward);
  res.json({ ok: true, id: result.lastInsertRowid });
});
app.post('/api/admin/tasks/:id/review', (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Administrator access required.' });
  const decision = req.body.decision;
  if (!['approved','rejected'].includes(decision)) return res.status(400).json({ error: 'Decision must be approved or rejected.' });
  const action = db.transaction(() => {
    const c = db.prepare("SELECT * FROM task_completions WHERE id=? AND status='pending'").get(Number(req.params.id));
    if (!c) throw new Error('NOT_PENDING');
    db.prepare('UPDATE task_completions SET status=? WHERE id=?').run(decision,c.id);
    if (decision === 'approved') {
      const task = db.prepare('SELECT reward FROM tasks WHERE id=?').get(c.task_id);
      db.prepare('UPDATE users SET balance=balance+? WHERE telegram_id=?').run(task.reward,c.telegram_id);
      addTransaction(c.telegram_id,'task_reward',task.reward,'approved',`Reward for task #${c.task_id}`);
    }
  });
  try { action(); res.json({ok:true}); } catch { res.status(409).json({error:'Task completion may already have been reviewed.'}); }
});

app.get('/health', (_req,res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`RIVA EARN server listening on port ${PORT}`));
