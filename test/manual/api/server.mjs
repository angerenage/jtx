import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import process from 'node:process';
import readline from 'node:readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manualDir = path.resolve(__dirname, '..');
const distDir = path.resolve(__dirname, '..', '..', '..', 'dist');
const port = Number(process.env.PORT || 5178);

// ---------- Utils ----------
const nowIso = () => new Date().toISOString();

const json = (res, code, payload) => {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
};

const text = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
};

const contentType = (p) => {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  if (p.endsWith('.map')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
};

const serveFile = async (res, filePath) => {
  try {
    const st = await stat(filePath);
    if (!st.isFile()) return text(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': contentType(filePath) });
    createReadStream(filePath).pipe(res);
  } catch (err) {
    if (err.code === 'ENOENT') return text(res, 404, 'Not found');
    text(res, 500, 'Internal server error');
  }
};

// static prefix server: serve /prefix/* from dir
const serveStatic = (prefix, dir) => async (req, res, url) => {
  const rel = url.pathname.slice(prefix.length);
  const filePath = path.join(dir, rel);
  await serveFile(res, filePath);
};

// ---------- In-memory data ----------
const STATUSES = ['new', 'processing', 'done', 'error'];
const rand = (n) => Math.floor(Math.random() * n);
const randomStatus = () => STATUSES[rand(STATUSES.length)];

const ITEMS = new Map();
for (let i = 1; i <= 20; i += 1) {
  ITEMS.set(i, {
    id: i,
    title: 'Item ' + i,
    status: randomStatus(),
    url: '/items/' + i,
    updatedAt: nowIso(),
  });
}

// ---------- Tiny router ----------
const routes = [];
const route = (method, match, handler) => routes.push({ method, match, handler });
// match can be string path or predicate (req, url) => boolean

route('GET', (req, url) => url.pathname === '/', (req, res) => {
  res.writeHead(302, { Location: '/manual/online.html' });
  res.end();
});

route('GET', (req, url) => url.pathname.startsWith('/manual/'), serveStatic('/manual/', manualDir));
route('GET', (req, url) => url.pathname.startsWith('/dist/'), serveStatic('/dist/', distDir));

// APIs
route('GET', '/api/ping', (req, res) => {
  json(res, 200, { message: 'pong', time: nowIso() });
});

route('GET', '/api/nested', (req, res) => {
  json(res, 200, {
    data: {
      meta: { server: 'jtx-test-api', time: nowIso() },
      items: [
        { id: 1, title: 'Alpha' },
        { id: 2, title: 'Beta' },
        { id: 3, title: 'Gamma' },
      ],
    },
  });
});

route('GET', '/api/empty', (req, res) => {
  res.writeHead(204).end();
});

route('GET', '/api/error', (req, res, url) => {
  const { searchParams } = url;
  const code = Number(searchParams.get('code') ?? '500');
  if (!Number.isFinite(code) || code < 100 || code > 599) {
    return json(res, 400, { error: 'Invalid status code', time: nowIso() });
  }
  const message = searchParams.get('message') || 'forced error ' + code;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: message, time: nowIso() }));
});

route('GET', '/api/echo-headers', (req, res) => {
  const received = {
    'X-Test': req.headers['x-test'] || null,
    'X-Token': req.headers['x-token'] || null,
  };
  json(res, 200, { received, time: nowIso() });
});

route('GET', '/api/items', (req, res, url) => {
  const q = (url.searchParams.get('q') || '').toLowerCase();
  const items = Array.from(ITEMS.values()).filter((it) => !q || it.title.toLowerCase().includes(q));
  json(res, 200, { items, count: items.length, time: nowIso() });
});

route('GET', '/api/items/updates', (req, res, url) => {
  const sp = url.searchParams;
  const clampInt = (v, d) => {
    const n = Number(v ?? d);
    return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : Math.max(1, Math.floor(d));
  };
  const min = clampInt(sp.get('min_count'), 1);
  const max = Math.max(min, clampInt(sp.get('max_count'), 5));
  const count = min + rand(max - min + 1);

  const ids = Array.from(ITEMS.keys());
  const updates = [];
  for (let i = 0; i < count; i += 1) {
    const id = ids[rand(ids.length)];
    const rec = ITEMS.get(id);
    if (!rec) continue;
    if (Math.random() < 0.7) rec.status = randomStatus();
    else rec.title += '!';
    rec.updatedAt = nowIso();
    updates.push({ id: rec.id, title: rec.title, status: rec.status, url: rec.url, updatedAt: rec.updatedAt });
  }
  json(res, 200, { updates, time: nowIso() });
});

route('GET', '/sse/news', (req, res) => {
  res.writeHead(200, {
    'Cache-Control': 'no-cache',
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
  });
  res.write('\n');

  let counter = 0;
  const timer = setInterval(() => {
    counter += 1;
    if (counter % 7 === 0) {
      res.write('event: news\n');
      res.write('data:\n\n');
      return;
    }
    const payload = { id: Date.now(), title: 'News #' + counter, counter, time: nowIso() };
    res.write('event: news\n');
    res.write('data: ' + JSON.stringify(payload) + '\n\n');
  }, 1000);

  const close = () => {
    clearInterval(timer);
    res.end();
  };
  req.on('close', close);
  req.on('error', close);
});

// ---------- Server ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host ?? 'localhost'));

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const ok = typeof r.match === 'string' ? url.pathname === r.match : r.match(req, url);
    if (!ok) continue;
    return r.handler(req, res, url);
  }
  text(res, 404, 'Not found');
});

const sockets = new Set();
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (socket) => {
  const send = (data) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(data));
  };

  send({ type: 'hello', time: nowIso() });

  const interval = setInterval(() => {
    send({
      type: 'tick',
      id: Date.now(),
      title: 'WS message ' + new Date().toLocaleTimeString(),
      time: nowIso(),
    });
  }, 1000);

  socket.on('message', (msg) => send({ type: 'echo', data: msg.toString(), time: nowIso() }));

  const cleanup = () => clearInterval(interval);
  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://' + (req.headers.host ?? 'localhost'));
  if (pathname !== '/ws/stream') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

server.listen(port, () => {
  console.log('JTX node test server listening on http://localhost:' + port);
});

// ---------- Graceful shutdown ----------
const shutdown = (code = 0) => {
  console.log('Shutting down...');

  wss.clients.forEach((client) => client.close());

  server.close(() => {
    sockets.forEach((s) => s.destroy());
    process.exit(code);
  });

  setTimeout(() => {
    sockets.forEach((s) => s.destroy());
    process.exit(code);
  }, 3000).unref();
};

if (process.platform === 'win32') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => process.emit('SIGINT'));
}

for (const sig of ['SIGINT', 'SIGBREAK', 'SIGTERM']) {
  try { process.on(sig, () => shutdown(0)); }
  catch { /* Unhandled signal */ }
}

process.on('message', (msg) => {
  if (msg === 'shutdown') shutdown(0);
});
