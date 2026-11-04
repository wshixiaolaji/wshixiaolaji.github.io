const MAX_VIEWERS = 100;
const SESSION_RE = /^[a-f0-9]{32}$/i;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function corsHeaders(origin, env) {
  const allowed = env.ALLOWED_ORIGIN || "*";
  return {
    "access-control-allow-origin": allowed === "*" ? "*" : origin === allowed ? allowed : "null",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-max-age": "86400",
    "vary": "Origin",
  };
}

function withCors(response, origin, env) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(origin, env))) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function makeIceServers(env) {
  const servers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];
  const urls = (env.TURN_URLS || "").split(",").map((url) => url.trim()).filter(Boolean);
  if (!urls.length || !env.TURN_SHARED_SECRET) return servers;

  const expires = Math.floor(Date.now() / 1000) + 3600;
  const username = `${expires}:rtc-gpu-studio`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.TURN_SHARED_SECRET),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(username));
  const credential = btoa(String.fromCharCode(...new Uint8Array(signature)));
  servers.push({ urls, username, credential });
  return servers;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "*";
    if (allowed !== "*" && origin !== allowed && request.method !== "OPTIONS") return json({ error: "origin_not_allowed" }, 403);
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), origin, env);

    const url = new URL(request.url);
    if (url.pathname === "/api/ice-config" && request.method === "GET") {
      try { return withCors(json({ iceServers: await makeIceServers(env) }), origin, env); }
      catch { return withCors(json({ error: "ice_config_failed" }, 500), origin, env); }
    }

    if (url.pathname === "/api/sessions" && request.method === "POST") {
      const id = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const stub = env.SESSIONS.get(env.SESSIONS.idFromName(id));
      const response = await stub.fetch(`https://session.internal/api/sessions/${id}`, { method: "POST" });
      const payload = await response.json();
      return withCors(json({ ...payload, id }), origin, env);
    }

    const match = url.pathname.match(/^\/api\/sessions\/([a-f0-9]{32})(?:\/(join|messages|leave))?$/i);
    if (!match) return withCors(json({ error: "not_found" }, 404), origin, env);
    const id = match[1].toLowerCase();
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(id));
    return withCors(await stub.fetch(new Request(`https://session.internal${url.pathname}`, request)), origin, env);
  },
};

export class SessionCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.waiters = new Map();
    this.ready = state.blockConcurrencyWhile(async () => {
      this.session = await state.storage.get("session") || null;
    });
  }

  async save() {
    if (this.session) await this.state.storage.put("session", this.session);
    else await this.state.storage.delete("session");
  }

  wake(peer) {
    const waiter = this.waiters.get(peer);
    if (waiter) {
      this.waiters.delete(peer);
      waiter();
    }
  }

  enqueue(peer, message) {
    peer.queue.push(message);
    this.wake(peer.key);
  }

  async poll(peer) {
    if (!peer.queue.length) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.waiters.delete(peer.key);
          resolve();
        }, 18000);
        this.waiters.set(peer.key, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const messages = peer.queue.splice(0);
    await this.save();
    return messages;
  }

  peerFor(request) {
    const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!token || !this.session) return null;
    if (token === this.session.hostToken) {
      this.session.host.lastSeen = Date.now();
      return { role: "host", id: "host", state: this.session.host };
    }
    for (const [id, viewer] of Object.entries(this.session.viewers)) {
      if (token === viewer.token) {
        viewer.lastSeen = Date.now();
        return { role: "viewer", id, state: viewer };
      }
    }
    return null;
  }

  async fetch(request) {
    await this.ready;
    if (this.session && Date.now() - this.session.createdAt > 60 * 60 * 1000) {
      for (const viewer of Object.values(this.session.viewers)) this.enqueue(viewer, { type: "hangup" });
      this.session = null;
      await this.save();
    }
    const url = new URL(request.url);
    const path = url.pathname;
    const match = path.match(/^\/api\/sessions\/([a-f0-9]{32})(?:\/(join|messages|leave))?$/i);
    if (!match) return json({ error: "not_found" }, 404);
    const suffix = match[2] || "";

    if (request.method === "POST" && !suffix) {
      this.session = {
        hostToken: crypto.randomUUID().replaceAll("-", ""),
        host: { key: "host", queue: [], lastSeen: Date.now() },
        viewers: {},
        createdAt: Date.now(),
      };
      await this.save();
      return json({ token: this.session.hostToken, maxViewers: MAX_VIEWERS }, 201);
    }

    if (request.method === "POST" && suffix === "join") {
      if (!this.session || Date.now() - this.session.host.lastSeen > 60000) return json({ error: "host_offline" }, 410);
      for (const [id, viewer] of Object.entries(this.session.viewers)) {
        if (Date.now() - viewer.lastSeen > 60000) {
          delete this.session.viewers[id];
          this.enqueue(this.session.host, { type: "peer-left", peerId: id, viewerCount: Object.keys(this.session.viewers).length });
        }
      }
      if (Object.keys(this.session.viewers).length >= MAX_VIEWERS) return json({ error: "session_full", maxViewers: MAX_VIEWERS }, 409);
      const id = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
      const viewer = { key: id, token: crypto.randomUUID().replaceAll("-", ""), queue: [], lastSeen: Date.now() };
      this.session.viewers[id] = viewer;
      this.enqueue(this.session.host, { type: "peer-joined", peerId: id, viewerCount: Object.keys(this.session.viewers).length });
      await this.save();
      return json({ token: viewer.token, peerId: id, viewerCount: Object.keys(this.session.viewers).length, maxViewers: MAX_VIEWERS });
    }

    if (suffix === "messages" || suffix === "leave") {
      if (!this.session) return json({ error: "host_offline" }, 410);
      const peer = this.peerFor(request);
      if (!peer) return json({ error: "unauthorized" }, 401);
      await this.save();

      if (request.method === "GET" && suffix === "messages") return json({ messages: await this.poll(peer.state) });
      if (request.method === "POST" && suffix === "messages") {
        let message;
        try { message = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
        if (!["offer", "answer", "candidate"].includes(message.type)) return json({ error: "bad_message_type" }, 400);
        if (peer.role === "host") {
          if (!["offer", "candidate"].includes(message.type)) return json({ error: "bad_message_role" }, 400);
          const target = this.session.viewers[message.peerId];
          if (!target) return json({ error: "viewer_left" }, 410);
          this.enqueue(target, { type: message.type, data: message.data ?? null });
        } else {
          if (!["answer", "candidate"].includes(message.type)) return json({ error: "bad_message_role" }, 400);
          this.enqueue(this.session.host, { type: message.type, data: message.data ?? null, peerId: peer.id });
        }
        await this.save();
        return json({ ok: true }, 202);
      }
      if (request.method === "POST" && suffix === "leave") {
        if (peer.role === "host") {
          for (const viewer of Object.values(this.session.viewers)) this.enqueue(viewer, { type: "hangup" });
          this.session = null;
        } else {
          delete this.session.viewers[peer.id];
          this.enqueue(this.session.host, { type: "peer-left", peerId: peer.id, viewerCount: Object.keys(this.session.viewers).length });
        }
        await this.save();
        return json({ ok: true });
      }
    }
    return json({ error: "method_not_allowed" }, 405);
  }
}
