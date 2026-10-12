const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- Config (override with environment variables) ----------
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_USER = process.env.SAP_USER || 'sapuser';
const AUTH_PASS = process.env.SAP_PASS || 'sappass';
const SAP_AUTH = process.env.SAP_AUTH === 'true'; // require Basic Auth on /sap (off by default)
const ALLOW_IPS = (process.env.ALLOW_IPS || '').split(',').map((s) => s.trim()).filter(Boolean); // e.g. "172.23.0.13,127.0.0.1"; empty = accept any IP
const PROTECT_UI = process.env.PROTECT_UI !== 'false'; // require Basic Auth for the web UI
const MAX_MEMORY = parseInt(process.env.MAX_MEMORY || '500', 10); // requests kept in memory for the UI
const BODY_LIMIT = process.env.BODY_LIMIT || '50mb';
const LOG_DIR = path.join(__dirname, 'logs');

fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------- Storage ----------
const requests = []; // newest first

function logFile(date = new Date()) {
  const d = date.toISOString().slice(0, 10);
  return path.join(LOG_DIR, `requests-${d}.jsonl`);
}

function loadTodayLog() {
  const file = logFile();
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  for (const line of lines.slice(-MAX_MEMORY)) {
    try { requests.unshift(JSON.parse(line)); } catch { /* skip broken line */ }
  }
}
loadTodayLog();

function store(entry) {
  requests.unshift(entry);
  if (requests.length > MAX_MEMORY) requests.length = MAX_MEMORY;
  fs.appendFile(logFile(), JSON.stringify(entry) + '\n', (err) => {
    if (err) console.error('Failed to write log:', err);
  });
  broadcast(summary(entry));
}

function summary(e) {
  return {
    id: e.id, time: e.time, method: e.method, path: e.path, interface: e.interface,
    ip: e.ip, status: e.status, contentType: e.contentType, size: e.size, bodyType: e.bodyType,
  };
}

// ---------- Server-Sent Events (real-time push to browser) ----------
const clients = new Set();

function broadcast(data) {
  const msg = `event: request\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

// ---------- Basic Auth ----------
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function basicAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    if (idx >= 0 && safeEqual(user, AUTH_USER) && safeEqual(pass, AUTH_PASS)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="SAP Monitor", charset="UTF-8"');
  res.status(401).json({ status: 'ERROR', message: 'Unauthorized' });
}

// ---------- App ----------
const app = express();
app.disable('x-powered-by');

// SAP endpoint: /sap  (or /sap/<interface>)
// Every request is recorded (including GET / Connection Test and failed logins) so it shows up in /monitor.
// Body accepted as raw bytes for any content type (JSON, XML, text, ...)
function record(req, status) {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8').replace(/^﻿/, '') : ''; // strip UTF-8 BOM (some SAP code pages add it)
  const contentType = req.headers['content-type'] || '';

  let bodyType = 'text';
  if (/json/i.test(contentType) || /^\s*[{[]/.test(raw)) {
    try { JSON.parse(raw); bodyType = 'json'; } catch { /* not valid JSON */ }
  }
  if (bodyType === 'text' && (/xml/i.test(contentType) || /^\s*</.test(raw))) bodyType = 'xml';

  const headers = { ...req.headers };
  if (headers.authorization) headers.authorization = headers.authorization.replace(/ .*/, ' ***');

  const entry = {
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    method: req.method,
    path: req.originalUrl,
    interface: req.params.iface || 'sap',
    ip: (req.socket.remoteAddress || '').replace(/^::ffff:/, ''),
    status,
    contentType,
    size: Buffer.isBuffer(req.body) ? req.body.length : 0,
    bodyType,
    headers,
    query: req.query,
    body: raw,
  };
  store(entry);
  console.log(`[${entry.time}] ${status} ${entry.method} ${entry.path} ${entry.size}B (${bodyType}) from ${entry.ip} id=${entry.id}`);
  return entry;
}

app.all(['/sap', '/sap/:iface'], express.raw({ type: () => true, limit: BODY_LIMIT }), (req, res, next) => {
  if (ALLOW_IPS.length) {
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (!ALLOW_IPS.includes(ip)) {
      record(req, 403);
      return res.status(403).json({ status: 'ERROR', message: `IP ${ip} not allowed` });
    }
  }
  if (!SAP_AUTH) return next();
  let ok = false;
  basicAuth(req, res, () => { ok = true; });
  if (ok) return next();
  record(req, 401); // wrong/missing user or password (401 already sent by basicAuth)
});

// Response echoes what was received so the sender (e.g. ABAP) can verify the call end to end
app.post(['/sap', '/sap/:iface'], (req, res) => {
  const entry = record(req, 200);
  let received = entry.body;
  if (entry.bodyType === 'json') received = JSON.parse(entry.body);
  const result = {
    status: 'OK', id: entry.id, time: entry.time, interface: entry.interface,
    bodyType: entry.bodyType, size: entry.size, received,
  };
  if (/json/i.test(entry.contentType) && entry.bodyType !== 'json') result.warning = 'Content-Type is JSON but body is not valid JSON';
  res.status(200).json(result);
});

// GET /sap (or /sap/<interface>): latest received data as JSON. ?limit=N (default 50)
app.get(['/sap', '/sap/:iface'], (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, MAX_MEMORY);
  const list = req.params.iface ? requests.filter((r) => r.interface === req.params.iface) : requests;
  const data = list.slice(0, limit).map((e) => {
    let body = e.body;
    if (e.bodyType === 'json') { try { body = JSON.parse(e.body); } catch { /* keep raw */ } }
    return { id: e.id, time: e.time, method: e.method, path: e.path, interface: e.interface, ip: e.ip, contentType: e.contentType, body };
  });
  const entry = record(req, 200);
  res.json({ status: 'OK', id: entry.id, count: data.length, data });
});

// Other methods on /sap -> 405
app.all(['/sap', '/sap/:iface'], (req, res) => {
  record(req, 405);
  res.set('Allow', 'GET, POST').status(405).json({ status: 'ERROR', message: 'Method Not Allowed' });
});

// Body too large / other errors on inbound endpoint
app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(err.status || 500).json({ status: 'ERROR', message: err.message });
});

// ---------- Web UI: /monitor ----------
const ui = express.Router();
if (PROTECT_UI) ui.use(basicAuth);

ui.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

ui.get('/api/requests', (req, res) => res.json(requests.map(summary)));

ui.get('/api/requests/:id', (req, res) => {
  const e = requests.find((r) => r.id === req.params.id);
  if (!e) return res.status(404).json({ status: 'ERROR', message: 'Not found' });
  res.json(e);
});

ui.delete('/api/requests', (req, res) => {
  requests.length = 0; // clears the UI list only; log files are kept
  broadcast({ cleared: true });
  res.json({ status: 'OK' });
});

ui.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(': connected\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.use('/monitor', ui);
app.get('/', (req, res) => res.redirect('/monitor'));

app.listen(PORT, HOST, () => {
  console.log(`SAP Monitor listening on http://${HOST}:${PORT}`);
  console.log(`  GET/POST http://<server-ip>:${PORT}/sap   (auth: ${SAP_AUTH ? 'Basic ' + AUTH_USER : 'none'}, allowed IPs: ${ALLOW_IPS.join(', ') || 'any'})`);
  console.log(`  Monitor  http://<server-ip>:${PORT}/monitor`);
  console.log(`Logs: ${LOG_DIR}`);
});
