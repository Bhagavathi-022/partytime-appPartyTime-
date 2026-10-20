"use strict";
// Tiny JSON-file store (no native dependencies, works on Windows/macOS/Linux).
const fs = require("fs");
const path = require("path");

const FILE = path.join(process.env.DATA_DIR || path.join(__dirname, "..", "data"), "db.json");
let db = { watchlists: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(FILE, "utf8"))); } catch (e) {}

let timer = null;
function persist() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE + ".tmp", JSON.stringify(db));
      fs.renameSync(FILE + ".tmp", FILE);
    } catch (e) { console.error("Could not save data:", e.message); }
  }, 250);
}
function flush() { clearTimeout(timer); try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) {} }

const CLIENT_RE = /^[A-Za-z0-9-]{8,64}$/;
const isClient = (c) => typeof c === "string" && CLIENT_RE.test(c);

module.exports = {
  isClient, flush,
  getWatchlist: (c) => (db.watchlists[c] || []).slice(),
  addWatch(c, id) {
    const l = db.watchlists[c] || (db.watchlists[c] = []);
    if (!l.includes(id)) { l.unshift(id); if (l.length > 500) l.length = 500; persist(); }
  },
  removeWatch(c, id) {
    const l = db.watchlists[c]; if (!l) return;
    db.watchlists[c] = l.filter((x) => x !== id); persist();
  }
};
