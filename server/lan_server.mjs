import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const sessions = new Map();
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
};

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('request_too_large');
  }
  return raw ? JSON.parse(raw) : {};
}

function peerFor(room, req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (token && token === room.hostToken) { room.host.lastSeen = Date.now(); return { role: 'host', state: room.host }; }
  if (token) {
    for (const [id, viewer] of room.viewers) {
      if (token === viewer.token) { viewer.lastSeen = Date.now(); return { role: 'viewer', id, state: viewer }; }
    }
  }
  return null;
}

function enqueue(peer, message) {
  peer.queue.push(message);
  peer.waiter?.();
  peer.waiter = null;
}

async function poll(peer) {
  if (peer.queue.length) return peer.queue.splice(0);
  await new Promise(resolveWait => {
    const timeout = setTimeout(() => {
      peer.waiter = null;
      resolveWait();
    }, 18_000);
    peer.waiter = () => {
      clearTimeout(timeout);
      resolveWait();
    };
  });
  return peer.queue.splice(0);
}

const MAX_VIEWERS = 100;

function serveStatic(req, res, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { res.writeHead(400).end('Bad path'); return; }
  const relative = normalize(decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, ''));
  const file = resolve(join(root, relative));
  if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end('Forbidden'); return; }
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end('Not found'); return; }
  res.writeHead(200, {
    'content-type': mime[extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': extname(file) === '.html' ? 'no-store' : 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { json(res, 400, { error: 'bad_url' }); return; }
  const path = url.pathname;
  try {
    if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true });

    if (req.method === 'POST' && path === '/api/sessions') {
      const id = randomBytes(16).toString('hex');
      const session = {
        hostToken: randomBytes(24).toString('hex'),
        host: { queue: [], waiter: null, lastSeen: Date.now() },
        viewers: new Map(), createdAt: Date.now(),
      };
      sessions.set(id, session);
      return json(res, 201, { id, token: session.hostToken, maxViewers: MAX_VIEWERS });
    }

    if (req.method === 'GET' && path === '/api/ice-config') {
      return json(res, 200, { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] });
    }

    const sessionMatch = path.match(/^\/api\/sessions\/([a-f0-9]{32})(?:\/(join|messages|leave))?$/i);

    if (sessionMatch && req.method === 'POST' && sessionMatch[2] === 'join') {
      const session = sessions.get(sessionMatch[1].toLowerCase());
      if (!session || Date.now() - session.host.lastSeen > 60_000) return json(res, 410, { error: 'host_offline' });
      const now = Date.now();
      for (const [id, viewer] of session.viewers) {
        if (now - viewer.lastSeen > 60_000) {
          session.viewers.delete(id);
          enqueue(session.host, { type: 'peer-left', peerId: id, viewerCount: session.viewers.size });
        }
      }
      if (session.viewers.size >= MAX_VIEWERS) return json(res, 409, { error: 'session_full', maxViewers: MAX_VIEWERS });
      const id = randomBytes(8).toString('hex');
      const viewer = { token: randomBytes(24).toString('hex'), queue: [], waiter: null, lastSeen: now };
      session.viewers.set(id, viewer);
      enqueue(session.host, { type: 'peer-joined', peerId: id, viewerCount: session.viewers.size });
      return json(res, 200, { token: viewer.token, peerId: id, viewerCount: session.viewers.size, maxViewers: MAX_VIEWERS });
    }

    if (sessionMatch && ['messages', 'leave'].includes(sessionMatch[2])) {
      const id = sessionMatch[1].toLowerCase();
      const session = sessions.get(id);
      if (!session) return json(res, 410, { error: 'host_offline' });
      const peer = peerFor(session, req);
      if (!peer) return json(res, 401, { error: 'unauthorized' });
      if (req.method === 'GET' && sessionMatch[2] === 'messages') {
        return json(res, 200, { messages: await poll(peer.state) });
      }
      if (req.method === 'POST' && sessionMatch[2] === 'messages') {
        const message = await body(req);
        if (!['offer', 'answer', 'candidate'].includes(message.type)) return json(res, 400, { error: 'bad_message_type' });
        if (peer.role === 'host') {
          if (!['offer', 'candidate'].includes(message.type)) return json(res, 400, { error: 'bad_message_role' });
          const target = session.viewers.get(message.peerId);
          if (!target) return json(res, 410, { error: 'viewer_left' });
          enqueue(target, { type: message.type, data: message.data ?? null });
        } else {
          if (!['answer', 'candidate'].includes(message.type)) return json(res, 400, { error: 'bad_message_role' });
          enqueue(session.host, { type: message.type, data: message.data ?? null, peerId: peer.id });
        }
        return json(res, 202, { ok: true });
      }
      if (req.method === 'POST' && sessionMatch[2] === 'leave') {
        if (peer.role === 'host') {
          for (const viewer of session.viewers.values()) enqueue(viewer, { type: 'hangup' });
          sessions.delete(id);
        } else {
          session.viewers.delete(peer.id);
          enqueue(session.host, { type: 'peer-left', peerId: peer.id, viewerCount: session.viewers.size });
        }
        return json(res, 200, { ok: true });
      }
    }

    if (path.startsWith('/api/')) return json(res, 404, { error: 'not_found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method_not_allowed' });
    if (req.method === 'HEAD') return res.writeHead(200).end();
    return serveStatic(req, res, path);
  } catch (error) {
    if (error.message === 'request_too_large') return json(res, 413, { error: 'request_too_large' });
    if (error instanceof SyntaxError) return json(res, 400, { error: 'invalid_json' });
    console.error(error);
    return json(res, 500, { error: 'server_error' });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions) {
    if (now - session.createdAt > 60 * 60 * 1000) {
      for (const viewer of session.viewers.values()) enqueue(viewer, { type: 'hangup' });
      sessions.delete(sessionId);
      continue;
    }
    for (const [id, viewer] of session.viewers) {
      if (now - viewer.lastSeen > 60_000) {
        session.viewers.delete(id);
        enqueue(viewer, { type: 'hangup' });
        enqueue(session.host, { type: 'peer-left', peerId: id, viewerCount: session.viewers.size });
      }
    }
  }
}, 60_000).unref();

const port = Number(process.env.RTC_LAN_PORT || 8787);
server.listen(port, '127.0.0.1', () => console.log(`RTC LAN server listening on 127.0.0.1:${port}`));

