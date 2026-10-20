"use strict";
/*
 * Movie data providers. API keys stay on the server and never reach the browser.
 *
 *  - TMDB (TMDB_API_KEY): movies, series, documentaries, trending, backdrops and
 *    "where to watch" availability per country (watch-provider data from JustWatch).
 *  - OMDb (OMDB_API_KEY): search and details by IMDb id, posters. No availability data.
 *
 * Every title, year, poster and description comes from ONE provider record fetched by
 * id, so artwork can never belong to a different title than the one shown.
 */

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

// Well-known films shown on the home page when OMDb is the provider (OMDb has no "trending").
const FEATURED_IMDB = [
  "tt0816692", "tt1375666", "tt0468569", "tt15398776", "tt15239678", "tt9362722",
  "tt6710474", "tt2397535", "tt1130884", "tt2278388", "tt0111161", "tt0068646",
  "tt0110912", "tt0133093", "tt6751668", "tt2582802", "tt0172495", "tt0137523",
  "tt0245429", "tt7286456", "tt4154796", "tt1745960", "tt8178634", "tt1187043",
  "tt5074352", "tt4849438"
];

const TTL = 6 * 3600 * 1000;
const cache = new Map();
async function memo(key, fn, ttl = TTL) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.v;
  const v = await fn();
  cache.set(key, { v, exp: Date.now() + ttl });
  if (cache.size > 4000) cache.delete(cache.keys().next().value);
  return v;
}

function cfg() {
  return {
    omdbKey: (process.env.OMDB_API_KEY || "").trim(),
    tmdbKey: (process.env.TMDB_API_KEY || "").trim(),
    omdbBase: process.env.OMDB_BASE || "https://www.omdbapi.com/",
    tmdbBase: process.env.TMDB_BASE || "https://api.themoviedb.org/3"
  };
}
const active = () => { const c = cfg(); return c.tmdbKey ? "tmdb" : c.omdbKey ? "omdb" : null; };
const hasAvailability = () => !!cfg().tmdbKey;

async function fetchJson(url) {
  let r;
  try { r = await fetch(url, { signal: AbortSignal.timeout(12000) }); }
  catch (e) {
    throw new ApiError(502, "UPSTREAM_UNREACHABLE", "Could not reach the movie data service. Check the server's internet connection.");
  }
  let body = null;
  try { body = await r.json(); } catch (e) {}
  return { status: r.status, body };
}

const ID_RE = /^(imdb:tt\d{5,10}|tmdb:\d{1,9}|tmdbtv:\d{1,9})$/;
const isValidId = (id) => typeof id === "string" && ID_RE.test(id);
const clean = (v) => (v && v !== "N/A" ? String(v) : null);
const yearOf = (s) => { const y = parseInt(String(s || "").slice(0, 4), 10); return Number.isFinite(y) ? y : null; };
const TYPES = ["movie", "tv", "documentary"];

/* ---------------- OMDb ---------------- */
async function omdb(params) {
  const c = cfg();
  const u = new URL(c.omdbBase);
  u.searchParams.set("apikey", c.omdbKey);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const { status, body } = await fetchJson(u);
  const err = (body && body.Error) || "";
  if (status === 401 || /invalid api key/i.test(err))
    throw new ApiError(502, "KEY_INVALID", "OMDb rejected the API key. Check OMDB_API_KEY, and make sure you clicked the activation link in the OMDb email.");
  if (status === 429 || /request limit/i.test(err))
    throw new ApiError(429, "RATE_LIMIT", "The daily OMDb request limit was reached. Try again tomorrow or use a TMDB key.");
  return body || {};
}
function fromOmdb(d) {
  const genres = clean(d.Genre) ? d.Genre.split(",").map((s) => s.trim()) : [];
  return {
    id: "imdb:" + d.imdbID, kind: d.Type === "series" ? "tv" : "movie", title: d.Title, year: yearOf(d.Year),
    poster: clean(d.Poster), backdrop: null,
    plot: clean(d.Plot), director: clean(d.Director), cast: clean(d.Actors), genres,
    documentary: genres.includes("Documentary"),
    runtime: parseInt(d.Runtime, 10) || null, rated: clean(d.Rated),
    language: clean(d.Language), country: clean(d.Country),
    rating: clean(d.imdbRating) ? { value: Number(d.imdbRating), source: "IMDb" } : null
  };
}

/* ---------------- TMDB ---------------- */
const TIMG = "https://image.tmdb.org/t/p/";
async function tmdb(path, params = {}) {
  const c = cfg();
  const u = new URL(c.tmdbBase + path);
  u.searchParams.set("api_key", c.tmdbKey);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const { status, body } = await fetchJson(u);
  if (status === 401) throw new ApiError(502, "KEY_INVALID", "TMDB rejected the API key. Check TMDB_API_KEY (use the v3 API Key).");
  if (status === 429) throw new ApiError(429, "RATE_LIMIT", "TMDB rate limit reached. Try again shortly.");
  if (status === 404) throw new ApiError(404, "NOT_FOUND", "Title not found.");
  return body || {};
}
function lightTmdb(r, kind) {
  return {
    id: (kind === "tv" ? "tmdbtv:" : "tmdb:") + r.id, kind,
    title: kind === "tv" ? r.name : r.title, year: yearOf(kind === "tv" ? r.first_air_date : r.release_date),
    poster: r.poster_path ? TIMG + "w500" + r.poster_path : null,
    backdrop: r.backdrop_path ? TIMG + "w780" + r.backdrop_path : null
  };
}
function fromTmdb(d, kind) {
  const crew = (d.credits && d.credits.crew) || [], cast = (d.credits && d.credits.cast) || [];
  const dirs = kind === "tv" ? (d.created_by || []).map((p) => p.name) : crew.filter((p) => p.job === "Director").map((p) => p.name);
  const genres = (d.genres || []).map((g) => g.name);
  return Object.assign(lightTmdb(d, kind), {
    plot: d.overview || null, director: dirs.length ? dirs.join(", ") : null,
    cast: cast.slice(0, 5).map((p) => p.name).join(", ") || null, genres,
    documentary: (d.genres || []).some((g) => g.id === 99),
    runtime: kind === "tv" ? ((d.episode_run_time || [])[0] || null) : (d.runtime || null), rated: null,
    language: d.spoken_languages && d.spoken_languages[0] ? d.spoken_languages[0].english_name : null,
    country: d.production_countries && d.production_countries[0] ? d.production_countries[0].name : null,
    rating: d.vote_count > 0 ? { value: Math.round(d.vote_average * 10) / 10, source: "TMDB" } : null
  });
}

/* ---------------- public API ---------------- */
function needKey() {
  throw new ApiError(503, "NO_KEY", "No movie API key is configured on the server. Add OMDB_API_KEY or TMDB_API_KEY to the .env file and restart.");
}
const clampPage = (p) => Math.max(1, Math.min(100, parseInt(p, 10) || 1));

async function search(q, page = 1, type = "movie") {
  const p = active(); if (!p) needKey();
  page = clampPage(page); if (!TYPES.includes(type)) type = "movie";
  return memo(`s:${p}:${type}:${q.toLowerCase()}:${page}`, async () => {
    if (p === "tmdb") {
      const args = { query: q, page, include_adult: "false" };
      if (type === "movie") {
        const d = await tmdb("/search/movie", args);
        return { items: (d.results || []).map((r) => lightTmdb(r, "movie")), total: d.total_results || 0, page, pages: Math.min(d.total_pages || 1, 100) };
      }
      if (type === "tv") {
        const d = await tmdb("/search/tv", args);
        return { items: (d.results || []).map((r) => lightTmdb(r, "tv")), total: d.total_results || 0, page, pages: Math.min(d.total_pages || 1, 100) };
      }
      const [m, t] = await Promise.all([tmdb("/search/movie", args), tmdb("/search/tv", args)]);
      const docs = (list, kind) => (list.results || []).filter((r) => (r.genre_ids || []).includes(99)).map((r) => Object.assign(lightTmdb(r, kind), { pop: r.popularity || 0 }));
      const items = docs(m, "movie").concat(docs(t, "tv")).sort((a, b) => b.pop - a.pop).map(({ pop, ...x }) => x);
      return { items, total: null, page, pages: Math.min(Math.max(m.total_pages || 1, t.total_pages || 1), 100) };
    }
    // OMDb
    const omdbType = type === "movie" ? "movie" : type === "tv" ? "series" : undefined;
    const d = await omdb(Object.assign({ s: q, page }, omdbType ? { type: omdbType } : {}));
    if (d.Response === "False") return { items: [], total: 0, page, pages: 1 };
    const total = parseInt(d.totalResults, 10) || 0;
    let items = (d.Search || []).filter((r) => r.Type === "movie" || r.Type === "series").map((r) => ({
      id: "imdb:" + r.imdbID, kind: r.Type === "series" ? "tv" : "movie", title: r.Title, year: yearOf(r.Year), poster: clean(r.Poster), backdrop: null
    }));
    if (type === "documentary") {
      const full = await Promise.all(items.map((i) => details(i.id).catch(() => null)));
      items = full.filter((m) => m && m.documentary).map(light);
    }
    return { items, total: type === "documentary" ? null : total, page, pages: Math.min(Math.ceil(total / 10) || 1, 100) };
  }, 30 * 60 * 1000);
}

async function details(id) {
  if (!isValidId(id)) throw new ApiError(400, "BAD_ID", "Invalid title id.");
  const c = cfg();
  return memo("d:" + id, async () => {
    if (id.startsWith("tmdb:") || id.startsWith("tmdbtv:")) {
      if (!c.tmdbKey) needKey();
      const tv = id.startsWith("tmdbtv:");
      const d = await tmdb((tv ? "/tv/" : "/movie/") + id.split(":")[1], { append_to_response: "credits" });
      return fromTmdb(d, tv ? "tv" : "movie");
    }
    if (!c.omdbKey) needKey();
    const d = await omdb({ i: id.slice(5), plot: "full" });
    if (d.Response === "False") throw new ApiError(404, "NOT_FOUND", "Title not found.");
    return fromOmdb(d);
  });
}

async function browse(type = "movie", page = 1) {
  const p = active(); if (!p) needKey();
  page = clampPage(page); if (!TYPES.includes(type)) type = "movie";
  if (p === "omdb") {
    if (type !== "movie") throw new ApiError(501, "NO_BROWSE", "Browsing this category needs a TMDB key. You can still search by title.");
    return { items: (await featured()).map(light), page: 1, pages: 1 };
  }
  return memo(`b:${type}:${page}`, async () => {
    if (type === "tv") {
      const d = await tmdb("/discover/tv", { sort_by: "popularity.desc", page, "vote_count.gte": 50 });
      return { items: (d.results || []).map((r) => lightTmdb(r, "tv")), page, pages: Math.min(d.total_pages || 1, 100) };
    }
    const args = { sort_by: "popularity.desc", page, include_adult: "false", "vote_count.gte": 50 };
    if (type === "documentary") args.with_genres = "99";
    const d = await tmdb("/discover/movie", args);
    return { items: (d.results || []).map((r) => lightTmdb(r, "movie")), page, pages: Math.min(d.total_pages || 1, 100) };
  }, 3600 * 1000);
}

async function featured() {
  const p = active(); if (!p) needKey();
  return memo("featured:" + p, async () => {
    if (p === "tmdb") {
      const d = await tmdb("/trending/movie/week");
      return (d.results || []).slice(0, 20).map((r) => lightTmdb(r, "movie"));
    }
    const out = [];
    for (let i = 0; i < FEATURED_IMDB.length; i += 6) {
      const batch = await Promise.all(FEATURED_IMDB.slice(i, i + 6).map((id) => details("imdb:" + id).catch(() => null)));
      out.push(...batch.filter(Boolean));
    }
    return out;
  }, 3 * 3600 * 1000);
}

/* ---------------- where to watch ---------------- */
// Search pages for well-known platforms. Anything not listed falls back to the JustWatch page for the title.
const PLATFORM_SEARCH = [
  [/netflix/i, (q) => "https://www.netflix.com/search?q=" + q],
  [/amazon (prime )?video|prime video/i, (q) => "https://www.primevideo.com/search/?phrase=" + q],
  [/^youtube/i, (q) => "https://www.youtube.com/results?search_query=" + q],
  [/google play/i, (q) => "https://play.google.com/store/search?c=movies&q=" + q],
  [/apple tv/i, (q) => "https://tv.apple.com/search?term=" + q]
];
const isYouTube = (name) => /^youtube$/i.test(String(name).trim());
function platformUrl(name, title) {
  const q = encodeURIComponent(title);
  for (const [re, fn] of PLATFORM_SEARCH) if (re.test(name)) return fn(q);
  return null;
}
const KIND_ORDER = ["flatrate", "free", "ads", "rent", "buy"];

async function availability(id, country) {
  country = /^[A-Z]{2}$/.test(country) ? country : "IN";
  if (!isValidId(id)) throw new ApiError(400, "BAD_ID", "Invalid title id.");
  if (!hasAvailability()) return { source: "none", country, providers: [], link: null, reason: "NO_TMDB" };
  const m = await details(id);
  return memo(`a:${id}:${country}`, async () => {
    let kind = id.startsWith("tmdbtv:") ? "tv" : "movie", tid = id.includes(":tt") ? null : id.split(":")[1];
    if (!tid) {
      const f = await tmdb("/find/" + id.slice(5), { external_source: "imdb_id" });
      const hit = (f.movie_results || [])[0] || (f.tv_results || [])[0];
      if (!hit) return { source: "justwatch", country, providers: [], link: null, mapped: false };
      kind = (f.movie_results || [])[0] ? "movie" : "tv"; tid = hit.id;
    }
    const d = await tmdb(`/${kind}/${tid}/watch/providers`);
    const r = (d.results || {})[country];
    if (!r) return { source: "justwatch", country, providers: [], link: null, mapped: true };
    const byId = new Map();
    for (const k of KIND_ORDER) for (const p of r[k] || []) {
      const e = byId.get(p.provider_id) || { id: p.provider_id, name: p.provider_name, logo: p.logo_path ? TIMG + "w92" + p.logo_path : null, kinds: [] };
      const kk = k === "ads" ? "free" : k;
      if (!e.kinds.includes(kk)) e.kinds.push(kk);
      byId.set(p.provider_id, e);
    }
    const providers = [...byId.values()].map((p) => Object.assign(p, {
      url: platformUrl(p.name, m.title), youtube: isYouTube(p.name),
      free: p.kinds.includes("free"), subscription: p.kinds.includes("flatrate")
    })).sort((a, b) => KIND_ORDER.indexOf(a.kinds[0]) - KIND_ORDER.indexOf(b.kinds[0]));
    return { source: "justwatch", country, providers, link: r.link || null, mapped: true };
  }, 3 * 3600 * 1000);
}

const light = (m) => ({ id: m.id, kind: m.kind, title: m.title, year: m.year, poster: m.poster, backdrop: m.backdrop });
module.exports = { ApiError, search, details, browse, featured, availability, active, hasAvailability, isValidId, light, platformUrl };
