"use strict";
// End-to-end test of the backend. Uses local stand-ins for TMDB and OMDb (test fixtures only),
// so it needs no keys and no internet. Requires Node 22+ (global WebSocket client).
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

/* ---------- fake TMDB ---------- */
const T = {
  157336: { id: 157336, title: "Interstellar", release_date: "2014-11-05", poster_path: "/int.jpg", backdrop_path: "/intb.jpg", genre_ids: [12, 18, 878], genres: [{ id: 12, name: "Adventure" }, { id: 18, name: "Drama" }, { id: 878, name: "Science Fiction" }], runtime: 169, overview: "Explorers travel through a wormhole.", vote_average: 8.4, vote_count: 30000, credits: { crew: [{ job: "Director", name: "Christopher Nolan" }], cast: [{ name: "Matthew McConaughey" }] } },
  27205: { id: 27205, title: "Inception", release_date: "2010-07-15", poster_path: "/inc.jpg", backdrop_path: null, genre_ids: [28], genres: [{ id: 28, name: "Action" }], runtime: 148, overview: "Dream heist.", vote_average: 8.3, vote_count: 3000, credits: { crew: [], cast: [] } },
  999: { id: 999, title: "Free Film", release_date: "2019-01-01", poster_path: null, backdrop_path: null, genre_ids: [18], genres: [{ id: 18, name: "Drama" }], runtime: 90, overview: "Free to watch.", vote_average: 0, vote_count: 0, credits: { crew: [], cast: [] } },
  555: { id: 555, title: "Lost Film", release_date: "1931-01-01", poster_path: null, backdrop_path: null, genre_ids: [18], genres: [{ id: 18, name: "Drama" }], runtime: 80, overview: "Not streaming anywhere.", vote_average: 0, vote_count: 0, credits: { crew: [], cast: [] } },
  777: { id: 777, title: "Planet Doc", release_date: "2020-05-05", poster_path: null, backdrop_path: null, genre_ids: [99], genres: [{ id: 99, name: "Documentary" }], runtime: 60, overview: "A documentary.", vote_average: 7, vote_count: 10, credits: { crew: [], cast: [] } }
};
const PROV = {
  157336: { IN: { link: "https://www.themoviedb.org/movie/157336/watch?locale=IN", flatrate: [{ provider_id: 8, provider_name: "Netflix", logo_path: "/n.jpg" }, { provider_id: 119, provider_name: "Amazon Prime Video", logo_path: "/a.jpg" }], rent: [{ provider_id: 2, provider_name: "Apple TV", logo_path: "/t.jpg" }] } },
  27205: { IN: { link: "https://x", flatrate: [{ provider_id: 8, provider_name: "Netflix" }] } },
  999: { IN: { link: "https://x", free: [{ provider_id: 192, provider_name: "YouTube" }] } },
  555: {},
  777: { IN: { link: "https://x", ads: [{ provider_id: 192, provider_name: "YouTube" }] } }
};
const tmdbMock = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname.replace(/^\/3/, ""), q = u.searchParams;
  res.setHeader("content-type", "application/json");
  if (q.get("api_key") !== "tmdbkey") { res.statusCode = 401; return res.end("{}"); }
  const list = (arr) => res.end(JSON.stringify({ results: arr, total_results: arr.length, total_pages: 1 }));
  let m;
  if (p === "/search/movie") { const s = q.get("query").toLowerCase(); return list(Object.values(T).filter((x) => x.title.toLowerCase().includes(s))); }
  if (p === "/search/tv") return list([{ id: 42, name: "Planet Series", first_air_date: "2021-01-01", poster_path: null, backdrop_path: null, genre_ids: [99] }]);
  if (p === "/discover/movie") return list(q.get("with_genres") === "99" ? [T[777]] : Object.values(T));
  if (p === "/discover/tv") return list([{ id: 42, name: "Planet Series", first_air_date: "2021-01-01", poster_path: null, backdrop_path: null }]);
  if (p === "/trending/movie/week") return list([T[157336], T[27205]]);
  if ((m = p.match(/^\/movie\/(\d+)\/watch\/providers$/))) return res.end(JSON.stringify({ results: PROV[m[1]] || {} }));
  if ((m = p.match(/^\/movie\/(\d+)$/))) { if (T[m[1]]) return res.end(JSON.stringify(T[m[1]])); res.statusCode = 404; return res.end("{}"); }
  if ((m = p.match(/^\/find\/(tt\d+)$/))) return res.end(JSON.stringify({ movie_results: m[1] === "tt0816692" ? [{ id: 157336 }] : [], tv_results: [] }));
  res.statusCode = 404; res.end("{}");
});

/* ---------- fake OMDb ---------- */
const OM = { tt0816692: { Title: "Interstellar", Year: "2014", Runtime: "169 min", Genre: "Adventure, Drama, Sci-Fi", Director: "Christopher Nolan", Actors: "M. McConaughey", Plot: "Explorers.", Poster: "N/A", imdbRating: "8.7", imdbID: "tt0816692", Type: "movie", Response: "True" } };
const omdbMock = http.createServer((req, res) => {
  const q = new URL(req.url, "http://x").searchParams; res.setHeader("content-type", "application/json");
  if (q.get("apikey") !== "omdbkey") return res.end(JSON.stringify({ Response: "False", Error: "Invalid API key!" }));
  if (q.get("s")) return res.end(JSON.stringify({ Response: "True", totalResults: "1", Search: [{ Title: "Interstellar", Year: "2014", imdbID: "tt0816692", Type: "movie", Poster: "N/A" }] }));
  res.end(JSON.stringify(OM[q.get("i")] || { Response: "False", Error: "Incorrect IMDb ID." }));
});

let passed = 0;
const ok = (n) => { passed++; console.log("  ok -", n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await Promise.all([new Promise((r) => tmdbMock.listen(0, "127.0.0.1", r)), new Promise((r) => omdbMock.listen(0, "127.0.0.1", r))]);
  process.env.TMDB_BASE = `http://127.0.0.1:${tmdbMock.address().port}/3`;
  process.env.OMDB_BASE = `http://127.0.0.1:${omdbMock.address().port}/`;
  process.env.TMDB_API_KEY = "tmdbkey"; process.env.OMDB_API_KEY = "omdbkey";
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pt-"));
  const server = require("../server/server.js");
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`, port = server.address().port;
  const j = async (p, o) => { const r = await fetch(base + p, o); return { s: r.status, b: await r.json().catch(() => null) }; };
  const post = (p, b) => j(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

  /* ----- catalogue ----- */
  let r = await j("/api/status"); assert.strictEqual(r.b.provider, "tmdb"); assert.strictEqual(r.b.availability, true); ok("TMDB preferred when both keys set");
  r = await j("/api/search?q=inter"); assert.strictEqual(r.b.items[0].title, "Interstellar"); assert.strictEqual(r.b.items[0].year, 2014); ok("search finds a movie");
  r = await j("/api/search?q=planet&type=documentary"); assert.ok(r.b.items.some((x) => x.title === "Planet Doc")); assert.ok(!r.b.items.some((x) => x.title === "Interstellar")); ok("documentary search filters to documentaries");
  r = await j("/api/search?q=planet&type=tv"); assert.strictEqual(r.b.items[0].id, "tmdbtv:42"); assert.strictEqual(r.b.items[0].kind, "tv"); ok("series search works");
  r = await j("/api/browse?type=documentary"); assert.deepStrictEqual(r.b.items.map((x) => x.title), ["Planet Doc"]); ok("browse documentaries");
  r = await j("/api/movie/tmdb:157336"); assert.strictEqual(r.b.director, "Christopher Nolan"); assert.deepStrictEqual(r.b.rating, { value: 8.4, source: "TMDB" }); assert.strictEqual(r.b.poster, "https://image.tmdb.org/t/p/w500/int.jpg"); ok("details complete, poster from the same record");
  assert.strictEqual((await j("/api/movie/bogus")).s, 400); assert.strictEqual((await j("/api/movie/tmdb:1")).s, 404); ok("bad id and unknown title handled");

  /* ----- where to watch ----- */
  r = await j("/api/availability/tmdb:157336?country=IN");
  assert.deepStrictEqual(r.b.providers.map((p) => p.name), ["Netflix", "Amazon Prime Video", "Apple TV"]);
  assert.ok(r.b.providers[0].subscription && !r.b.providers[0].free); assert.match(r.b.providers[0].url, /netflix\.com\/search\?q=Interstellar/); ok("subscription platforms listed with redirect links");
  r = await j("/api/availability/tmdb:999?country=IN"); assert.ok(r.b.providers[0].free); ok("free title detected");
  r = await j("/api/availability/tmdb:777?country=IN"); assert.ok(r.b.providers[0].free && r.b.providers[0].youtube); ok("YouTube (free with ads) treated as free");
  r = await j("/api/availability/tmdb:555?country=IN"); assert.deepStrictEqual(r.b.providers, []); ok("title on no platform returns empty list");
  r = await j("/api/availability/imdb:tt0816692?country=IN"); assert.strictEqual(r.b.providers.length, 3); ok("IMDb ids map to TMDB for availability");

  /* ----- watchlist ----- */
  const cid = "client-abcdef123456";
  await post("/api/watchlist", { clientId: cid, id: "tmdb:157336" });
  r = await j("/api/watchlist?clientId=" + cid); assert.strictEqual(r.b.items[0].title, "Interstellar"); ok("watchlist add + read");
  await j("/api/watchlist/tmdb:157336?clientId=" + cid, { method: "DELETE" });
  assert.deepStrictEqual((await j("/api/watchlist?clientId=" + cid)).b.ids, []); ok("watchlist remove");

  /* ----- rooms over WebSocket ----- */
  const wsUrl = (c, id, name) => `ws://127.0.0.1:${port}/ws?code=${c}&client=${id}&name=${name}`;
  const open = (url) => new Promise((res, rej) => { const ws = new WebSocket(url), got = []; ws.onmessage = (e) => got.push(JSON.parse(e.data)); ws.onopen = () => res({ ws, got }); ws.onerror = () => rej(new Error("ws error")); });
  const wait = async (fn, ms = 2500) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(15); } throw new Error("timeout: " + fn); };
  const lastPlan = (c) => c.got.filter((m) => m.t === "plan").pop();
  const hostId = "host-client-0000001", gId = "guest-client-000001", g2Id = "guest-client-000002";
  const send = (c, o) => c.ws.send(JSON.stringify(o));

  r = await post("/api/rooms", { clientId: hostId, clientName: "Host", titleId: "tmdb:157336", country: "IN" });
  const code = r.b.code; assert.match(code, /^[A-Z2-9]{6}$/); ok("room created with a title");
  assert.strictEqual((await post("/api/rooms", { clientId: hostId, youtube: "https://example.com/x" })).s, 400); ok("non-YouTube link rejected");

  const host = await open(wsUrl(code, hostId, "Host"));
  const init = await wait(() => host.got.find((m) => m.t === "init"));
  assert.strictEqual(init.you.host, true); assert.strictEqual(init.room.title.title, "Interstellar"); assert.ok(!JSON.stringify(init).includes(hostId)); ok("host joins; private client id never sent to clients");
  const guest = await open(wsUrl(code, gId, "Asha"));
  assert.strictEqual((await wait(() => guest.got.find((m) => m.t === "init"))).you.host, false); ok("guest joins as non-host");

  await wait(() => lastPlan(host).plan.status === "waiting");
  assert.deepStrictEqual(lastPlan(host).plan.names.sort(), ["Asha", "Host"]); ok("plan waits until everyone says which services they have");

  send(host, { t: "services", services: ["Netflix"] });
  send(guest, { t: "services", services: ["Amazon Prime Video"] });
  await wait(() => lastPlan(host).plan.status === "missing");
  let pl = lastPlan(host).plan; assert.ok(pl.missing.length === 1); ok("no common service: plan says who is missing which");
  send(host, { t: "start" }); await sleep(120);
  assert.ok(host.got.some((m) => m.t === "error") && !lastPlan(host).session); ok("host cannot start when someone lacks the platform");

  send(guest, { t: "services", services: ["Netflix", "Hotstar"] });
  await wait(() => lastPlan(host).plan.status === "ready");
  assert.strictEqual(lastPlan(host).plan.provider.name, "Netflix"); assert.match(lastPlan(host).plan.provider.url, /netflix/); ok("everyone has Netflix: ready, with the platform link");

  send(guest, { t: "start" }); await sleep(120); assert.ok(!lastPlan(guest).session); ok("guest cannot start the session");
  send(host, { t: "start" });
  await wait(() => lastPlan(guest).session && lastPlan(guest).session.phase === "gather"); ok("host starts: everyone is sent to the platform");
  send(host, { t: "ready" }); await sleep(80); assert.strictEqual(lastPlan(host).session.phase, "gather"); ok("countdown waits for everyone to be ready");
  send(guest, { t: "ready" });
  const cd = await wait(() => { const p = lastPlan(guest); return p.session && p.session.phase === "countdown" && p; });
  assert.ok(cd.session.startAt > Date.now() - 1000); ok("all ready: shared countdown starts");
  const st = await wait(() => guest.got.filter((m) => m.t === "state").pop());
  assert.strictEqual(st.state.playing, true); ok("shared clock starts at the countdown");
  send(host, { t: "pause", position: 90 });
  await wait(() => guest.got.filter((m) => m.t === "state").pop().state.playing === false); ok("host pause is relayed");
  send(host, { t: "stop" }); await wait(() => lastPlan(guest).session === null); ok("host can end the session");

  /* chat + reactions + queue */
  send(guest, { t: "chat", text: "  hi <b>all</b>  " });
  const chat = await wait(() => host.got.find((m) => m.t === "chat")); assert.strictEqual(chat.m.text, "hi <b>all</b>"); assert.strictEqual(chat.m.name, "Asha"); ok("chat delivered with sender name");
  send(guest, { t: "react", emoji: "🍿" }); await wait(() => host.got.find((m) => m.t === "react")); ok("reaction broadcast");
  send(guest, { t: "request", id: "tmdb:27205" });
  const rq = await wait(() => host.got.filter((m) => m.t === "queue").pop()?.requests?.length === 1 && host.got.filter((m) => m.t === "queue").pop());
  send(host, { t: "approve", id: rq.requests[0].id });
  const aq = await wait(() => guest.got.filter((m) => m.t === "queue").pop()?.queue?.length === 1 && guest.got.filter((m) => m.t === "queue").pop());
  send(host, { t: "load", id: aq.queue[0].id });
  const loaded = await wait(() => guest.got.filter((m) => m.t === "room").pop()?.room.title.title === "Inception" && guest.got.filter((m) => m.t === "room").pop()); ok("request, approve and load next title");
  await wait(() => lastPlan(host).plan.status === "ready"); assert.strictEqual(lastPlan(host).plan.provider.name, "Netflix"); ok("new title re-checks availability for the group");

  /* free + unavailable titles */
  send(host, { t: "settitle", id: "tmdb:999" });
  await wait(() => lastPlan(host).plan.status === "free"); ok("free title: plan is free, no subscription needed");
  send(host, { t: "settitle", id: "tmdb:555" });
  await wait(() => lastPlan(host).plan.status === "unavailable"); ok("title on no platform: plan is unavailable");
  send(host, { t: "start" }); await sleep(100); assert.ok(!lastPlan(host).session); ok("cannot start an unavailable title");

  /* voice signalling */
  send(host, { t: "voice", on: true }); send(guest, { t: "voice", on: true });
  await wait(() => lastPlan(host).members.filter((m) => m.voice).length === 2); ok("voice state shared with the room");
  const guestPid = lastPlan(host).members.find((m) => m.name === "Asha").pid;
  send(host, { t: "rtc", to: guestPid, data: { sdp: { type: "offer", sdp: "v=0".padEnd(6000, "x") } } });
  const rtc = await wait(() => guest.got.find((m) => m.t === "rtc")); assert.strictEqual(rtc.data.sdp.type, "offer"); ok("voice signalling relayed (large SDP allowed)");
  send(host, { t: "rtc", to: "nobody", data: {} }); await sleep(60); ok("signalling to unknown peer ignored");

  /* limits */
  const g2 = await open(wsUrl(code, g2Id, "Ravi")); const closed = new Promise((res) => (g2.ws.onclose = res));
  g2.ws.send("x".repeat(30000)); await closed; ok("oversized message closes that socket only");
  assert.strictEqual((await j("/api/status")).s, 200); ok("server healthy after bad input");
  await new Promise((res) => { const w = new WebSocket(wsUrl("ZZZZZZ", hostId, "X")); w.onclose = (e) => { assert.strictEqual(e.code, 4004); res(); }; }); ok("joining a missing room refused");

  /* artwork proxy only fetches known image hosts */
  for (const bad of ["http://image.tmdb.org/t/p/w500/x.jpg", "https://evil.example.com/x.jpg", "https://image.tmdb.org:8080/x.jpg", "file:///etc/passwd", "https://127.0.0.1/x", ""]) {
    assert.strictEqual((await fetch(base + "/img?u=" + encodeURIComponent(bad))).status, 400, bad);
  }
  ok("image proxy refuses anything but known poster hosts");

  /* config + static */
  r = await j("/api/config"); assert.ok(r.b.iceServers[0].urls.length); ok("voice config served");
  assert.strictEqual((await fetch(base + "/")).status, 200); assert.notStrictEqual((await fetch(base + "/..%2fserver/server.js")).status, 200); ok("static files served, path traversal blocked");

  /* ----- OMDb-only mode ----- */
  delete process.env.TMDB_API_KEY;
  r = await j("/api/status"); assert.strictEqual(r.b.provider, "omdb"); assert.strictEqual(r.b.availability, false); ok("OMDb-only mode reports no availability data");
  r = await j("/api/search?q=inter"); assert.strictEqual(r.b.items[0].id, "imdb:tt0816692"); ok("OMDb search works");
  r = await j("/api/availability/imdb:tt0816692?country=IN"); assert.strictEqual(r.b.source, "none"); ok("availability honestly reports it is unknown without TMDB");
  process.env.OMDB_API_KEY = "bad"; r = await j("/api/search?q=nolan"); assert.strictEqual(r.b.code, "KEY_INVALID"); ok("bad key gives a clear message");

  console.log(`\n${passed} checks passed`);
  process.exit(0);
})().catch((e) => { console.error("\nFAILED:", e.message); console.error(e.stack); process.exit(1); });
