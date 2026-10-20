"use strict";
/*
 * Live watch rooms.
 *
 * Flow
 *  1. People join a room with a 6-character code.
 *  2. The host picks a title. The server looks up where it streams (in the room's country).
 *  3. Each person says which streaming services they have. The server works out a "plan":
 *       free        a free option exists (e.g. YouTube): everyone can watch
 *       ready       one paid service that EVERYONE has carries the title
 *       missing     nobody-has-it-all: shows who is missing which service
 *       unavailable no streaming service carries it in this country
 *  4. Only when the plan is free or ready can the host start. Everyone is sent to the platform,
 *     marks "ready", then a shared countdown tells everyone when to press play.
 *  5. Voice chat uses WebRTC. The server only relays the signalling messages.
 *
 * PartyTime cannot control Netflix, Prime Video etc. (they do not allow it), so for those
 * platforms the sync is a shared countdown and a shared clock. YouTube links are embedded and
 * kept in sync automatically.
 */
const crypto = require("crypto");
const { attachWebSocket } = require("./ws");
const providers = require("./providers");
const store = require("./store");

const rooms = new Map();
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const EMOJI = ["🍿", "🚀", "❤️", "😂", "🤯", "👏", "🔥", "😱"];
const MAX_ROOMS = 500, MAX_MEMBERS = 12;
const COUNTDOWN_MS = 6000;

const newCode = () => {
  for (;;) {
    let c = "";
    for (let i = 0; i < 6; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
};
const cleanText = (s, max) => String(s || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1e6, v)) : null);
const norm = (n) => String(n).toLowerCase().trim();
const curPos = (r) => (r.state.playing ? Math.max(0, r.state.position + (Date.now() - r.state.at) / 1000) : r.state.position);

function youtubeId(url) {
  const s = String(url || "").trim();
  const m = s.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{11}$/.test(s) ? s : null;
}

const slim = (p) => ({ id: p.id, name: p.name, logo: p.logo, url: p.url, kinds: p.kinds, free: p.free, youtube: p.youtube });

/* Works out whether this group can watch the current title together. */
function plan(r) {
  if (r.media) return { status: "media" };
  if (!r.title) return { status: "nothing" };
  const a = r.avail;
  if (!a) return { status: "checking" };
  if (a.source === "error") return { status: "error", message: a.message };
  if (a.source === "none") return { status: "unknown" };
  const provs = a.providers || [];
  if (!provs.length) return { status: "unavailable" };
  const free = provs.filter((p) => p.free);
  if (free.length) return { status: "free", provider: slim(free[0]), options: free.map(slim) };
  const ms = [...r.members.values()];
  const waiting = ms.filter((m) => !m.declared).map((m) => m.name);
  if (waiting.length) return { status: "waiting", names: waiting, options: provs.map(slim) };
  const paid = provs.filter((p) => !p.free);
  const common = paid.find((p) => ms.every((m) => m.services.includes(norm(p.name))));
  if (common) return { status: "ready", provider: slim(common), options: paid.map(slim) };
  let best = null;
  for (const p of paid) {
    const miss = ms.filter((m) => !m.services.includes(norm(p.name))).map((m) => m.name);
    if (!best || miss.length < best.missing.length) best = { provider: slim(p), missing: miss };
  }
  return { status: "missing", provider: best.provider, missing: best.missing, options: paid.map(slim) };
}

function members(r) {
  return [...r.members.values()].map((m) => ({
    pid: m.pid, name: m.name, host: m.clientId === r.hostId, voice: m.voice, declared: m.declared,
    services: m.services, ready: !!(r.session && r.session.ready.has(m.clientId))
  }));
}
function sessionView(r) {
  const s = r.session; if (!s) return null;
  return { provider: s.provider, phase: s.phase, startAt: s.startAt || null };
}
function snapshot(r) {
  return {
    code: r.code, name: r.name, hostName: r.hostName, country: r.country, title: r.title, media: r.media,
    state: r.state, queue: r.queue, requests: r.requests, members: members(r), plan: plan(r), session: sessionView(r),
    chat: r.chat.slice(-60)
  };
}
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(r, obj) {
  const s = JSON.stringify(obj);
  for (const m of r.members.values()) for (const ws of m.sockets) if (ws.readyState === 1) ws.send(s);
}
const pushPlan = (r) => broadcast(r, { t: "plan", members: members(r), plan: plan(r), session: sessionView(r) });

async function setTitle(r, id) {
  const m = providers.light(await providers.details(id));
  r.title = m; r.media = null; r.avail = null; r.session = null;
  r.state = { playing: false, position: 0, at: Date.now() };
  broadcast(r, { t: "room", room: snapshot(r), serverNow: Date.now() });
  const token = (r.availToken = (r.availToken || 0) + 1);
  try {
    const a = await providers.availability(id, r.country);
    if (token === r.availToken) r.avail = a;
  } catch (e) {
    if (token === r.availToken) r.avail = { source: "error", message: e.message || "Could not check where this streams." };
  }
  if (token === r.availToken) pushPlan(r);
}

async function createRoom({ clientId, clientName, name, titleId, youtube, priv, country }) {
  if (!store.isClient(clientId)) throw new providers.ApiError(400, "BAD_CLIENT", "Missing client id.");
  if (rooms.size >= MAX_ROOMS) throw new providers.ApiError(503, "BUSY", "Too many active rooms. Try again later.");
  let media = null;
  if (youtube) {
    const id = youtubeId(youtube);
    if (!id) throw new providers.ApiError(400, "BAD_LINK", "That does not look like a YouTube link.");
    media = { type: "youtube", id };
  }
  if (titleId && !providers.isValidId(titleId)) throw new providers.ApiError(400, "BAD_ID", "Invalid title id.");
  const hostName = cleanText(clientName, 30) || "Host";
  const r = {
    code: newCode(), name: cleanText(name, 50) || "Movie night", hostId: clientId, hostName,
    country: /^[A-Z]{2}$/.test(country) ? country : "IN", title: null, avail: null, media, session: null,
    priv: !!priv, createdAt: Date.now(), emptySince: Date.now(),
    state: { playing: false, position: 0, at: Date.now() },
    members: new Map(), chat: [], queue: [], requests: []
  };
  if (titleId) {
    r.title = providers.light(await providers.details(titleId));
    if (!cleanText(name, 50)) r.name = r.title.title;
    r.availToken = 1;
    try { r.avail = await providers.availability(titleId, r.country); }
    catch (e) { r.avail = { source: "error", message: e.message || "Could not check where this streams." }; }
  }
  rooms.set(r.code, r);
  return r;
}

function listPublic() {
  return [...rooms.values()].filter((r) => !r.priv).sort((a, b) => b.members.size - a.members.size).slice(0, 24).map((r) => ({
    code: r.code, name: r.name, hostName: r.hostName, title: r.title, youtube: !!r.media,
    watching: r.members.size, playing: r.state.playing
  }));
}
const getRoom = (code) => rooms.get(String(code || "").toUpperCase());

function startCountdown(r) {
  const s = r.session; if (!s || s.phase !== "gather") return;
  s.phase = "countdown"; s.startAt = Date.now() + COUNTDOWN_MS;
  r.state = { playing: true, position: 0, at: s.startAt };
  pushPlan(r);
  broadcast(r, { t: "state", state: r.state, serverNow: Date.now() });
}

function attach(server) {
  attachWebSocket(server, "/ws", (ws, req) => {
    const u = new URL(req.url, "http://x");
    const r = getRoom(u.searchParams.get("code"));
    const clientId = u.searchParams.get("client");
    if (!r) return ws.close(4004, "Room not found");
    if (!store.isClient(clientId)) return ws.close(4001, "Bad client id");
    const name = cleanText(u.searchParams.get("name"), 30) || "Guest";

    let m = r.members.get(clientId);
    if (!m) {
      if (r.members.size >= MAX_MEMBERS) return ws.close(4003, "Room is full");
      m = { clientId, pid: crypto.randomBytes(6).toString("hex"), name, sockets: new Set(), voice: false, declared: false, services: [] };
      r.members.set(clientId, m);
    }
    m.name = name; m.sockets.add(ws); r.emptySince = null;
    if (clientId === r.hostId) r.hostName = name;
    const isHost = () => clientId === r.hostId;

    send(ws, { t: "init", room: snapshot(r), you: { host: isHost(), pid: m.pid }, serverNow: Date.now() });
    pushPlan(r);

    let stamps = [], rtcStamps = [];
    ws.on("message", async (raw) => {
      const now = Date.now();
      let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
      if (!msg || typeof msg.t !== "string") return;

      if (msg.t === "rtc") {   // voice-chat signalling: relay to one participant
        rtcStamps = rtcStamps.filter((t) => now - t < 10000); rtcStamps.push(now);
        if (rtcStamps.length > 300 || !msg.data || typeof msg.data !== "object" || typeof msg.to !== "string") return;
        const target = [...r.members.values()].find((x) => x.pid === msg.to);
        if (target) for (const s of target.sockets) send(s, { t: "rtc", from: m.pid, data: msg.data });
        return;
      }
      stamps = stamps.filter((t) => now - t < 10000); stamps.push(now);
      if (stamps.length > 40) return;

      switch (msg.t) {
        case "chat": {
          const text = cleanText(msg.text, 500); if (!text) return;
          const c = { id: crypto.randomUUID(), name: m.name, host: isHost(), text, ts: now, pos: Math.floor(curPos(r)) };
          r.chat.push(c); if (r.chat.length > 200) r.chat.shift();
          broadcast(r, { t: "chat", m: c }); break;
        }
        case "react":
          if (EMOJI.includes(msg.emoji)) broadcast(r, { t: "react", emoji: msg.emoji, name: m.name });
          break;
        case "voice":
          m.voice = !!msg.on; pushPlan(r); break;
        case "services": {
          const list = Array.isArray(msg.services) ? msg.services.slice(0, 60).map((s) => norm(cleanText(s, 60))).filter(Boolean) : [];
          m.services = [...new Set(list)]; m.declared = true; pushPlan(r); break;
        }
        case "play": case "pause": case "seek": case "heartbeat": {
          if (!isHost()) return;
          const pos = num(msg.position); if (pos === null) return;
          if (msg.t === "play") r.state = { playing: true, position: pos, at: now };
          else if (msg.t === "pause") r.state = { playing: false, position: pos, at: now };
          else if (msg.t === "seek") r.state = { playing: r.state.playing, position: pos, at: now };
          else {
            if (Math.abs(curPos(r) - pos) < 1.5) return;
            r.state = { playing: r.state.playing, position: pos, at: now };
          }
          broadcast(r, { t: "state", state: r.state, serverNow: now }); break;
        }
        case "settitle": {
          if (!isHost()) return;
          if (!providers.isValidId(msg.id)) return;
          try { await setTitle(r, msg.id); } catch (e) { send(ws, { t: "error", message: e.message }); }
          break;
        }
        case "setmedia": {
          if (!isHost()) return;
          const id = youtubeId(msg.url);
          if (!id) return send(ws, { t: "error", message: "That does not look like a YouTube link." });
          r.media = { type: "youtube", id }; r.title = null; r.avail = null; r.session = null;
          r.state = { playing: false, position: 0, at: now };
          broadcast(r, { t: "room", room: snapshot(r), serverNow: now }); break;
        }
        case "start": {       // host: send everyone to the platform
          if (!isHost() || r.media) return;
          const p = plan(r);
          if (p.status !== "ready" && p.status !== "free") return send(ws, { t: "error", message: "Not everyone can watch this together yet." });
          r.session = { provider: p.provider, phase: "gather", ready: new Set(), startAt: null };
          r.state = { playing: false, position: 0, at: now };
          pushPlan(r); break;
        }
        case "ready": {       // guest: I have the platform open and I'm ready to press play
          const s = r.session; if (!s || s.phase !== "gather") return;
          s.ready.add(clientId);
          if ([...r.members.values()].every((x) => s.ready.has(x.clientId))) startCountdown(r); else pushPlan(r);
          break;
        }
        case "force": {       // host: start the countdown even if someone is not ready
          if (!isHost()) return; startCountdown(r); break;
        }
        case "stop": {
          if (!isHost()) return;
          r.session = null; r.state = { playing: false, position: 0, at: now };
          pushPlan(r); broadcast(r, { t: "state", state: r.state, serverNow: now }); break;
        }
        case "request": {
          if (!providers.isValidId(msg.id)) return;
          let t; try { t = providers.light(await providers.details(msg.id)); } catch (e) { return send(ws, { t: "error", message: e.message }); }
          if (r.queue.length + r.requests.length >= 30) return send(ws, { t: "error", message: "The queue is full." });
          const item = { id: crypto.randomUUID(), by: m.name, title: t };
          (isHost() ? r.queue : r.requests).push(item);
          broadcast(r, { t: "queue", queue: r.queue, requests: r.requests }); break;
        }
        case "approve": case "dismiss": case "unqueue": {
          if (!isHost()) return;
          if (msg.t === "unqueue") r.queue = r.queue.filter((q) => q.id !== msg.id);
          else {
            const i = r.requests.findIndex((q) => q.id === msg.id);
            if (i > -1) { const [q] = r.requests.splice(i, 1); if (msg.t === "approve") r.queue.push(q); }
          }
          broadcast(r, { t: "queue", queue: r.queue, requests: r.requests }); break;
        }
        case "load": {
          if (!isHost()) return;
          const i = r.queue.findIndex((q) => q.id === msg.id); if (i < 0) return;
          const [q] = r.queue.splice(i, 1);
          broadcast(r, { t: "queue", queue: r.queue, requests: r.requests });
          try { await setTitle(r, q.title.id); } catch (e) { send(ws, { t: "error", message: e.message }); }
          break;
        }
      }
    });

    ws.on("close", () => {
      m.sockets.delete(ws);
      if (m.sockets.size === 0) {
        r.members.delete(clientId);
        if (r.session) r.session.ready.delete(clientId);
      }
      if (r.members.size === 0) r.emptySince = Date.now(); else pushPlan(r);
    });
    ws.on("error", () => {});
  }, 20000);

  setInterval(() => {
    for (const [code, r] of rooms) if (r.members.size === 0 && r.emptySince && Date.now() - r.emptySince > 30 * 60 * 1000) rooms.delete(code);
  }, 5 * 60 * 1000).unref();
}

module.exports = { createRoom, listPublic, getRoom, snapshot, attach, youtubeId, plan };
