/* PartyTime shared helpers (used by index.html and room.html). */
(function () {
  const PT = (window.PT = {});

  /* ---- storage that never throws ---- */
  const mem = {};
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return mem[k] || null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { mem[k] = v; } }
  };
  PT.ls = ls;
  function rid() { const a = new Uint8Array(16); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join(""); }
  PT.clientId = ls.get("pt_client") || (function () { const v = rid(); ls.set("pt_client", v); return v; })();
  PT.getName = () => ls.get("pt_name") || "";
  PT.setName = (n) => ls.set("pt_name", String(n || "").trim().slice(0, 30));
  PT.getCountry = () => ls.get("pt_country") || "IN";
  PT.setCountry = (c) => ls.set("pt_country", c);
  PT.getServices = () => { try { const v = JSON.parse(ls.get("pt_services") || "null"); return Array.isArray(v) ? v : null; } catch (e) { return null; } };
  PT.setServices = (a) => ls.set("pt_services", JSON.stringify(a));

  PT.COUNTRIES = [["IN", "India"], ["US", "United States"], ["GB", "United Kingdom"], ["CA", "Canada"], ["AU", "Australia"], ["NZ", "New Zealand"], ["DE", "Germany"], ["FR", "France"], ["ES", "Spain"], ["IT", "Italy"], ["NL", "Netherlands"], ["SE", "Sweden"], ["BR", "Brazil"], ["MX", "Mexico"], ["JP", "Japan"], ["KR", "South Korea"], ["SG", "Singapore"], ["ID", "Indonesia"], ["PH", "Philippines"], ["AE", "United Arab Emirates"], ["ZA", "South Africa"], ["TR", "Turkey"]];
  PT.countryName = (c) => (PT.COUNTRIES.find((x) => x[0] === c) || [c, c])[1];
  PT.countryOptions = (sel) => PT.COUNTRIES.map(([c, n]) => `<option value="${c}"${c === sel ? " selected" : ""}>${n}</option>`).join("");

  /* ---- safety ---- */
  PT.esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const IMG_OK = /^https:\/\/(image\.tmdb\.org|m\.media-amazon\.com|ia\.media-imdb\.com)\//;
  PT.safeImg = (u) => (typeof u === "string" && IMG_OK.test(u) ? "/img?u=" + encodeURIComponent(u) : null);
  PT.safeUrl = (u) => (typeof u === "string" && /^https:\/\//.test(u) ? u : null);

  /* ---- API ---- */
  PT.api = async function (path, opt) {
    let r;
    try { r = await fetch(path, Object.assign({ headers: { "content-type": "application/json" } }, opt || {})); }
    catch (e) { throw new Error("Can't reach the PartyTime server. Check your connection and try again."); }
    let b = null; try { b = await r.json(); } catch (e) {}
    if (!r.ok) { const err = new Error((b && b.error) || "Something went wrong (" + r.status + ")."); err.code = b && b.code; throw err; }
    return b;
  };
  PT.post = (p, o) => PT.api(p, { method: "POST", body: JSON.stringify(o) });

  /* ---- artwork: only ever the poster/backdrop that came with the title record ---- */
  PT.placeholder = (t, small) => `<div class="w-full h-full flex flex-col items-center justify-center text-center gap-0.5 p-2 bg-surface-container-high text-on-surface-variant"><span class="font-headline-sm ${small ? "text-[11px]" : "text-[14px]"} text-white leading-tight">${PT.esc(t.title)}</span>${t.year ? `<span class="font-metric-badge text-[10px]">${t.year}</span>` : ""}${small ? "" : '<span class="font-metric-badge text-[10px] text-outline">No artwork</span>'}</div>`;
  PT.poster = (t, small) => { const p = PT.safeImg(t.poster); return p ? `<img class="w-full h-full object-contain bg-surface-container-lowest" src="${PT.esc(p)}" alt="${PT.esc(t.title)}${t.year ? " (" + t.year + ")" : ""} poster" loading="lazy">` : PT.placeholder(t, small); };
  PT.wide = (t, small) => {
    const b = PT.safeImg(t.backdrop), p = PT.safeImg(t.poster);
    if (b) return `<img class="w-full h-full object-contain bg-surface-container-lowest" src="${PT.esc(b)}" alt="${PT.esc(t.title)} still" loading="lazy">`;
    if (p) return `<div class="w-full h-full bg-surface-container-lowest flex items-center justify-center"><img class="h-full w-auto max-w-full object-contain" src="${PT.esc(p)}" alt="${PT.esc(t.title)} poster" loading="lazy"></div>`;
    return PT.placeholder(t, small);
  };
  PT.kindLabel = (t) => (t.documentary ? "Documentary" : t.kind === "tv" ? "TV series" : "Movie");
  PT.providerUrl = (p, title) => PT.safeUrl(p.url) || "https://www.google.com/search?q=" + encodeURIComponent("watch " + title + " on " + p.name);
  PT.fmtTime = (s) => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ":" : "") + String(m).padStart(h ? 2 : 1, "0") + ":" + String(x).padStart(2, "0"); };

  /* ---- toast + modal ---- */
  PT.toast = function (msg) {
    let t = document.getElementById("pt-toast");
    if (!t) { t = document.createElement("div"); t.id = "pt-toast"; t.setAttribute("role", "status"); t.className = "fixed left-1/2 -translate-x-1/2 bottom-6 z-[100] max-w-[92vw] px-4 py-2.5 rounded-xl bg-surface-container-high border border-primary/30 text-on-surface shadow-2xl font-body-sm text-body-sm"; document.body.appendChild(t); }
    t.textContent = msg; t.style.display = "block"; clearTimeout(t._h); t._h = setTimeout(() => (t.style.display = "none"), 4500);
  };
  PT.modal = function (html, opts) {
    PT.closeModal();
    const o = document.createElement("div");
    o.id = "pt-modal"; if (opts && opts.sticky) o.dataset.sticky = "1"; o.className = "fixed inset-0 z-[90] bg-black/70 backdrop-blur-sm flex items-start sm:items-center justify-center p-3 overflow-y-auto";
    o.innerHTML = `<div role="dialog" aria-modal="true" class="w-full ${(opts && opts.wide) || "max-w-lg"} my-auto bg-[#181E29] border border-[#2A3140] rounded-2xl shadow-2xl">${html}</div>`;
    o.addEventListener("mousedown", (e) => { if (e.target === o && !(opts && opts.sticky)) PT.closeModal(); });
    document.body.appendChild(o);
    document.addEventListener("keydown", PT._esc);
    const f = o.querySelector("[autofocus],input,button"); if (f) f.focus();
    return o;
  };
  PT._esc = (e) => { const m = document.getElementById("pt-modal"); if (e.key === "Escape" && m && !m.dataset.sticky) PT.closeModal(); };
  PT.closeModal = function () { const o = document.getElementById("pt-modal"); if (o) o.remove(); document.removeEventListener("keydown", PT._esc); };

  PT.copy = async function (text, okMsg) {
    try { await navigator.clipboard.writeText(text); PT.toast(okMsg || "Copied"); }
    catch (e) { PT.toast("Copy this: " + text); }
  };

  PT.ic = (n, cls) => `<span class="material-symbols-outlined ${cls || ""}">${n}</span>`;
  PT.initials = (n) => String(n || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

  /* ---- "Where to watch" panel (used on the Discover page) ---- */
  PT.availabilityHtml = function (a, title, country) {
    const cn = PT.esc(PT.countryName(country));
    if (a.source === "none") return `<p class="text-on-surface-variant font-body-sm">Streaming availability is switched off on this server. It needs a TMDB API key.</p>`;
    if (!a.providers.length) return `<div class="p-3 rounded-xl bg-surface-container border border-outline-variant/30"><p class="text-white font-label-action">Not streaming anywhere in ${cn} right now</p><p class="text-on-surface-variant font-body-sm mt-1">${PT.esc(title)} isn't on any streaming, rental or purchase service we can see in ${cn}. It might be in cinemas, only on disc, or not licensed here yet. Try another country, or pick a different title.</p></div>`;
    const groups = [["free", "Free"], ["subscription", "With a subscription"], ["paid", "Rent or buy"]];
    const bucket = (p) => (p.free ? "free" : p.subscription ? "subscription" : "paid");
    return groups.map(([k, label]) => {
      const list = a.providers.filter((p) => bucket(p) === k); if (!list.length) return "";
      return `<div class="mb-2"><p class="font-metric-badge text-[11px] uppercase tracking-wider text-secondary mb-1.5">${label}</p><div class="flex flex-wrap gap-2">${list.map((p) => `<span class="inline-flex items-center gap-2 pl-1 pr-3 py-1 rounded-full bg-surface-container border border-outline-variant/30 font-body-sm text-white">${PT.safeImg(p.logo) ? `<img src="${PT.esc(PT.safeImg(p.logo))}" alt="" class="w-6 h-6 rounded-full">` : '<span class="w-6 h-6 rounded-full bg-surface-container-high"></span>'}${PT.esc(p.name)}</span>`).join("")}</div></div>`;
    }).join("");
  };
})();
