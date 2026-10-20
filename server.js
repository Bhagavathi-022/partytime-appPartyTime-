"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");

// minimal .env loader (no dependency); real environment variables win
try {
  for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch (e) {}

const providers = require("./providers");
const rooms = require("./rooms");
const store = require("./store");

const PUBLIC = path.join(__dirname, "..", "public");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon"
};

/* ---- tiny router ---- */
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:([a-z]+)/gi, (_, k) => { keys.push(k); return "([^/]+)"; }) + "/?$");
  routes.push({ method, re, keys, handler });
}
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > 10240) { reject(new providers.ApiError(413, "TOO_BIG", "Request too large.")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(new providers.ApiError(400, "BAD_JSON", "Invalid JSON.")); } });
    req.on("error", reject);
  });
}

const needClient = (req) => {
  const c = req.query.clientId || (req.body && req.body.clientId);
  if (!store.isClient(c)) throw new providers.ApiError(400, "BAD_CLIENT", "Missing client id.");
  return c;
};

route("GET", "/api/status", async () => ({ provider: providers.active(), availability: providers.hasAvailability() }));
route("GET", "/api/config", async () => {
  // ICE servers for voice chat. STUN is free; add TURN_URL/TURN_USER/TURN_PASS for strict networks.
  const ice = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
  if (process.env.TURN_URL) ice.push({ urls: process.env.TURN_URL.split(","), username: process.env.TURN_USER || "", credential: process.env.TURN_PASS || "" });
  return { iceServers: ice, provider: providers.active(), availability: providers.hasAvailability() };
});
route("GET", "/api/browse", async (req) => providers.browse(req.query.type, req.query.page));
route("GET", "/api/availability/:id", async (req) => providers.availability(decodeURIComponent(req.params.id), String(req.query.country || "IN").toUpperCase()));
route("GET", "/api/featured", async () => ({ items: (await providers.featured()).map(providers.light) }));
route("GET", "/api/search", async (req) => {
  const q = String(req.query.q || "").trim().slice(0, 100);
  if (q.length < 2) return { items: [], total: 0, page: 1, pages: 1 };
  return providers.search(q, req.query.page, req.query.type);
});
route("GET", "/api/movie/:id", async (req) => providers.details(decodeURIComponent(req.params.id)));

route("GET", "/api/watchlist", async (req) => {
  const ids = store.getWatchlist(needClient(req));
  const items = (await Promise.all(ids.map((id) => providers.details(id).then(providers.light).catch(() => null)))).filter(Boolean);
  return { ids, items };
});
route("POST", "/api/watchlist", async (req) => {
  const c = needClient(req);
  if (!providers.isValidId(req.body.id)) throw new providers.ApiError(400, "BAD_ID", "Invalid film id.");
  store.addWatch(c, req.body.id); return { ok: true };
});
route("DELETE", "/api/watchlist/:id", async (req) => { store.removeWatch(needClient(req), decodeURIComponent(req.params.id)); return { ok: true }; });

route("GET", "/api/rooms", async () => ({ rooms: rooms.listPublic() }));
route("POST", "/api/rooms", async (req) => {
  const b = req.body || {};
  const r = await rooms.createRoom({ clientId: b.clientId, clientName: b.clientName, name: b.name, titleId: b.titleId, youtube: b.youtube, priv: b.private, country: b.country });
  return { code: r.code };
});
route("GET", "/api/rooms/:code", async (req) => {
  const r = rooms.getRoom(req.params.code);
  if (!r) throw new providers.ApiError(404, "NO_ROOM", "Room not found. It may have ended.");
  return { code: r.code, name: r.name, title: r.title };
});

/* ---- artwork proxy: the server fetches posters so they load even where TMDB's image host is blocked ---- */
const IMG_HOSTS = new Set(["image.tmdb.org", "m.media-amazon.com", "ia.media-imdb.com"]);
async function serveImage(req, res, url) {
  let target;
  try { target = new URL(url.searchParams.get("u") || ""); } catch (e) { target = null; }
  if (!target || target.protocol !== "https:" || !IMG_HOSTS.has(target.hostname) || target.port) { res.writeHead(400); return res.end("Bad image address"); }
  try {
    const r = await fetch(target, { redirect: "error", signal: AbortSignal.timeout(10000) });
    const type = r.headers.get("content-type") || "";
    if (!r.ok || !/^image\//.test(type)) { res.writeHead(404); return res.end("No image"); }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 3 * 1024 * 1024) { res.writeHead(413); return res.end("Too large"); }
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=604800, immutable", "X-Content-Type-Options": "nosniff", "Content-Length": buf.length });
    res.end(buf);
  } catch (e) { res.writeHead(502); res.end("Could not fetch image"); }
}

/* ---- static files ---- */
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/") rel = "/index.html";
  else if (!path.extname(rel)) rel += ".html";
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      const hit = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!hit) return sendJson(res, 404, { error: "Unknown API route.", code: "NOT_FOUND" });
      const m = url.pathname.match(hit.re);
      req.params = {}; hit.keys.forEach((k, i) => (req.params[k] = m[i + 1]));
      req.query = Object.fromEntries(url.searchParams);
      req.body = (req.method === "POST" || req.method === "DELETE") ? await readBody(req) : {};
      return sendJson(res, 200, await hit.handler(req));
    }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
    if (url.pathname === "/img") return serveImage(req, res, url);
    serveStatic(req, res, url.pathname);
  } catch (e) {
    if (!(e instanceof providers.ApiError)) console.error(e);
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e.status ? e.message : "Server error", code: e.code || "ERROR" });
  }
});
rooms.attach(server);

const PORT = parseInt(process.env.PORT, 10) || 3000;
if (require.main === module) {
  server.listen(PORT, "0.0.0.0", () => {
    const p = providers.active();
    console.log(`PartyTime running at http://localhost:${PORT}`);
    console.log(p ? `Movie data provider: ${p.toUpperCase()}` : "WARNING: no OMDB_API_KEY or TMDB_API_KEY set. Copy .env.example to .env and add a key.");
  });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { store.flush(); process.exit(0); });
}
module.exports = server;
