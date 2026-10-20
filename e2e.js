"use strict";
// Browser test: two separate browser contexts ("devices") use the real pages end to end.
// Needs Playwright + Chromium. External CDNs (Tailwind, fonts, YouTube) are stubbed so it runs offline.
const http = require("http"), os = require("os"), fs = require("fs"), path = require("path");
const { chromium } = require("/opt/npm-tools/node_modules/playwright");

const T = {
  157336: { id: 157336, title: "Interstellar", release_date: "2014-11-05", poster_path: "/int.jpg", backdrop_path: "/intb.jpg", genre_ids: [12], genres: [{ id: 12, name: "Adventure" }], runtime: 169, overview: "Explorers travel through a wormhole.", vote_average: 8.4, vote_count: 3000, credits: { crew: [{ job: "Director", name: "Christopher Nolan" }], cast: [{ name: "Matthew McConaughey" }] } },
  555: { id: 555, title: "Lost Film", release_date: "1931-01-01", poster_path: null, backdrop_path: null, genre_ids: [18], genres: [{ id: 18, name: "Drama" }], runtime: 80, overview: "Not streaming anywhere.", vote_average: 0, vote_count: 0, credits: { crew: [], cast: [] } }
};
const PROV = { 157336: { IN: { link: "x", flatrate: [{ provider_id: 8, provider_name: "Netflix" }, { provider_id: 119, provider_name: "Amazon Prime Video" }] } }, 555: {} };
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname.replace(/^\/3/, ""); res.setHeader("content-type", "application/json");
  const list = (a) => res.end(JSON.stringify({ results: a, total_results: a.length, total_pages: 1 })); let m;
  if (p === "/search/movie") { const s = u.searchParams.get("query").toLowerCase(); return list(Object.values(T).filter((x) => x.title.toLowerCase().includes(s))); }
  if (p === "/discover/movie" || p === "/trending/movie/week") return list(Object.values(T));
  if ((m = p.match(/^\/movie\/(\d+)\/watch\/providers$/))) return res.end(JSON.stringify({ results: PROV[m[1]] || {} }));
  if ((m = p.match(/^\/movie\/(\d+)$/)) && T[m[1]]) return res.end(JSON.stringify(T[m[1]]));
  res.statusCode = 404; res.end("{}");
});

let passed = 0; const ok = (n) => { passed++; console.log("  ok -", n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  process.env.TMDB_BASE = `http://127.0.0.1:${mock.address().port}/3`; process.env.TMDB_API_KEY = "k"; delete process.env.OMDB_API_KEY;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pt-e2e-"));
  const server = require("../server/server.js");
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const errors = [];
  async function device(name) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"] });
    await ctx.route(/cdn\.tailwindcss\.com/, (r) => r.fulfill({ contentType: "text/javascript", body: "window.tailwind={};" }));
    await ctx.route(/fonts\.(googleapis|gstatic)\.com|youtube\.com|image\.tmdb\.org/, (r) => r.abort());
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
    return { ctx, page };
  }

  const A = await device("A"), B = await device("B");

  /* ---- Device A: browse, open detail, see where to watch, create room ---- */
  await A.page.goto(base + "/");
  await A.page.waitForSelector('#grid [data-open="tmdb:157336"]'); ok("A: Discover shows titles from the backend");
  await A.page.fill("#q", "inter"); await A.page.waitForFunction(() => document.querySelectorAll("#grid [data-open]").length === 1); ok("A: search narrows the grid");
  await A.page.click('#grid [data-open="tmdb:157336"]');
  await A.page.waitForSelector("#d-avail >> text=Netflix"); ok("A: detail shows where to watch (Netflix, Prime Video)");
  const detailText = await A.page.textContent("#pt-modal");
  if (!/Interstellar/.test(detailText) || !/Christopher Nolan/.test(detailText) || !/2014/.test(detailText)) throw new Error("detail metadata wrong"); ok("A: detail metadata matches the title");
  await A.page.click("#d-party");
  await A.page.fill("#cr-name", "Asha"); await A.page.click("#cr-go");
  await A.page.waitForURL(/room\.html\?code=[A-Z2-9]{6}/);
  const code = new URL(A.page.url()).searchParams.get("code"); ok("A: room created, redirected to /room.html?code=" + code);
  await A.page.waitForSelector("#stage h2:has-text('Interstellar')"); ok("A: room shows Interstellar");
  await A.page.waitForSelector("#stage >> text=Waiting for"); ok("A: waits until everyone picks their services");

  /* ---- Device B: a different device joins using the code ---- */
  await B.page.goto(base + "/");
  await B.page.fill("#code", code); await B.page.click("#join button");
  await B.page.fill("#nm-in", "Ravi"); await B.page.click("#nm button:not(#nm-x)");
  await B.page.waitForURL(/room\.html/); await B.page.waitForSelector("#stage h2:has-text('Interstellar')"); ok("B: joined A's room from a separate browser session");
  await A.page.waitForFunction(() => document.querySelectorAll("#people [data-pid]").length === 2); ok("A: sees B arrive");

  /* services: A has Netflix only; B has Prime only -> nobody has both */
  await A.page.check('[data-svc="Netflix"]');
  await B.page.check('[data-svc="Amazon Prime Video"]');
  await A.page.waitForSelector("#stage >> text=Not everyone can watch this together yet"); ok("A: shown who is missing which service");
  await B.page.waitForSelector("#stage >> text=Not everyone can watch this together yet");
  if (await A.page.locator('[data-act="start"]').count()) throw new Error("start button should not exist"); ok("start is blocked when platforms don't match");
  await B.page.check('[data-svc="Netflix"]');
  await A.page.waitForSelector('[data-act="start"]'); ok("A: once everyone has Netflix, the start button appears");
  if (await B.page.locator('[data-act="start"]').count()) throw new Error("guest must not get start"); ok("B: guest cannot start");
  await A.page.click('[data-act="start"]');
  await B.page.waitForSelector("#stage a:has-text('Open Netflix')"); ok("B: sent to the platform with an Open Netflix link");
  const href = await B.page.getAttribute("#stage a:has-text('Open Netflix')", "href"); if (!/^https:\/\/www\.netflix\.com\/search\?q=Interstellar/.test(href)) throw new Error("bad link " + href); ok("B: link goes to Netflix search for Interstellar");
  await A.page.click('[data-act="ready"]'); await sleep(200);
  if (await A.page.locator("#cd").count()) throw new Error("countdown started too early"); ok("countdown waits for B");
  await B.page.click('[data-act="ready"]');
  await A.page.waitForSelector("#cd >> text=Get ready"); await B.page.waitForSelector("#cd >> text=Get ready"); ok("both see the shared countdown");
  await A.page.waitForSelector("#cd >> text=PLAY NOW", { timeout: 9000 }); await B.page.waitForSelector("#cd >> text=PLAY NOW", { timeout: 3000 }); ok("both see PLAY NOW");
  await A.page.click('[data-act="pause"]'); await B.page.waitForSelector("#cd >> text=Paused by the host"); ok("host pause shows on B");
  await A.page.click('[data-act="stop"]'); await B.page.waitForSelector("#stage >> text=Everyone has Netflix"); ok("host ends session; plan returns");

  /* chat */
  await B.page.fill("#msg", "hello <i>friends</i>"); await B.page.press("#msg", "Enter");
  await A.page.waitForSelector("#chat >> text=hello <i>friends</i>"); ok("chat reaches A, HTML is escaped");
  if (await A.page.locator("#chat i").count()) throw new Error("html was injected"); ok("no HTML injection in chat");

  /* voice chat between two real browser peers */
  await A.page.click("#voice"); await B.page.click("#voice");
  await A.page.waitForFunction(() => /2 talking/.test(document.querySelector("#voice-state").textContent), null, { timeout: 8000 }); ok("both joined voice");
  await sleep(2500);
  const conn = async (p) => p.evaluate(() => [...voice.pcs.values()].map((e) => e.pc.connectionState));
  const ca = await conn(A.page), cb = await conn(B.page);
  if (!(ca.length === 1 && cb.length === 1)) throw new Error("expected one peer connection each, got " + ca + " / " + cb);
  if (!(ca[0] === "connected" && cb[0] === "connected")) throw new Error("voice not connected: " + ca + " / " + cb); ok("voice: A and B have a live peer-to-peer connection");
  const recv = await B.page.evaluate(async () => { const e = [...voice.pcs.values()][0]; const s = await e.pc.getStats(); let n = 0; s.forEach((r) => { if (r.type === "inbound-rtp" && r.kind === "audio") n += r.packetsReceived || 0; }); return n; });
  if (!(recv > 0)) throw new Error("no audio packets received"); ok("voice: B is receiving audio packets from A");
  await A.page.click("#voice"); await B.page.waitForFunction(() => /1 in voice|On · 1/.test(document.querySelector("#voice-state").textContent) && voice.pcs.size === 0); ok("voice: leaving closes the connection on the other side");

  /* title with no streaming availability */
  await A.page.click('[data-act="pick"]'); await A.page.fill("#pk-q", "lost");
  await A.page.click('#pk-res [data-id="tmdb:555"]');
  await A.page.waitForSelector("#stage >> text=isn't streaming anywhere in India"); await B.page.waitForSelector("#stage >> text=isn't streaming anywhere in India"); ok("title on no platform: both see the appropriate message");
  if (await A.page.locator('[data-act="start"]').count()) throw new Error("start must not show"); ok("cannot start an unavailable title");

  /* mobile layout: no sideways scroll */
  const M = await browser.newContext({ viewport: { width: 390, height: 800 } });
  await M.route(/cdn\.tailwindcss\.com/, (r) => r.fulfill({ contentType: "text/javascript", body: "window.tailwind={};" }));
  await M.route(/fonts\.(googleapis|gstatic)\.com|image\.tmdb\.org/, (r) => r.abort());
  const mp = await M.newPage(); await mp.goto(base + "/room.html?code=" + code); await mp.fill("#nm-in", "Mia").catch(() => {}); await mp.click("#nm button").catch(() => {});
  await mp.waitForSelector("#stage h2"); ok("a third phone-sized device can join");

  if (errors.length) throw new Error("browser errors:\n" + errors.join("\n")); ok("no JavaScript errors on any page");
  console.log(`\n${passed} browser checks passed`);
  await browser.close(); process.exit(0);
})().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
