/* =====================================================================
   util.js — namespace, event bus, DOM helpers, formatting, dialogs
   ===================================================================== */
"use strict";
window.SM = window.SM || {};

(function (SM) {
  /* ---------- event bus ---------- */
  const handlers = {};
  SM.bus = {
    on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); },
    emit(evt, data) { (handlers[evt] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(evt, e); } }); },
  };

  /* ---------- DOM ---------- */
  SM.$ = (sel, root) => (root || document).querySelector(sel);
  SM.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  SM.el = function (tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "html") e.innerHTML = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  };
  SM.icon = (name, cls) => {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    if (cls) s.setAttribute("class", cls);
    const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
    u.setAttribute("href", "#i-" + name);
    s.appendChild(u);
    return s;
  };
  SM.esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- misc ---------- */
  SM.uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  SM.clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
  SM.debounce = (fn, ms) => {
    let t;
    const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    d.flush = (...a) => { clearTimeout(t); fn(...a); };
    d.cancel = () => clearTimeout(t);
    return d;
  };
  SM.clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  SM.downloadBlob = function (blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = SM.el("a", { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  SM.safeName = (s) => (String(s || "satmap").replace(/[^\w.\- ]+/g, "_").trim() || "satmap").slice(0, 80);

  /* ---------- settings (browser storage) ---------- */
  const SETTINGS_KEY = "satmap.settings";
  const DEFAULT_SETTINGS = {
    lengthUnit: "auto",       // auto | m | km | ft | yd | mi | auto-ft
    areaUnit: "auto",         // auto | m2 | ha | km2 | acre | decimal | ft2 | yd2
    coordFormat: "dd",        // dd | dms
    snapping: true,
    snapDistance: 15,
    keepTool: false,          // stay in drawing tool after finishing a shape
    measureLabels: "selected",// off | selected | all
    autosaveSeconds: 2,
    apiKeys: {},              // per-browser keys for optional imagery providers
    defaultStyle: { color: "#ffcc00", weight: 3, opacity: 1, dash: "solid", fill: true, fillColor: "#ffcc00", fillOpacity: 0.25, arrow: false },
  };
  SM.settings = Object.assign(SM.clone(DEFAULT_SETTINGS), (() => {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); } catch (e) { return {}; }
  })());
  if (SM.settings.units === "imperial") { SM.settings.lengthUnit = "auto-ft"; SM.settings.areaUnit = "acre"; } // older setting
  delete SM.settings.units;
  SM.saveSettings = () => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SM.settings)); } catch (e) { /* storage full or blocked */ }
    SM.bus.emit("settings", SM.settings);
  };

  /* ---------- formatting ---------- */
  const fmtNum = (v, d) => Number(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
  SM.fmtNum = fmtNum;
  /* Units. Exact international definitions: 1 ft = 0.3048 m, 1 acre = 4046.8564224 m²,
     1 decimal (dismil) = 1/100 acre, 1 gaj = 1 square yard. */
  SM.LENGTH_UNITS = [
    ["auto", "Auto (m / km)"], ["m", "Metres (m)"], ["km", "Kilometres (km)"],
    ["ft", "Feet (ft)"], ["yd", "Yards (yd)"], ["mi", "Miles (mi)"], ["auto-ft", "Auto (ft / mi)"],
  ];
  SM.AREA_UNITS = [
    ["auto", "Auto (m² / ha / km²)"], ["m2", "Square metres (m²)"], ["ha", "Hectares (ha)"], ["km2", "Square km (km²)"],
    ["acre", "Acres"], ["decimal", "Decimal / dismil"], ["ft2", "Square feet (ft²)"], ["yd2", "Square yards / gaj (yd²)"],
  ];
  const LEN = { m: [1, 2, "m"], km: [1000, 3, "km"], ft: [0.3048, 1, "ft"], yd: [0.9144, 1, "yd"], mi: [1609.344, 3, "mi"] };
  const AREA = { m2: [1, 1, "m²"], ha: [1e4, 4, "ha"], km2: [1e6, 4, "km²"], acre: [4046.8564224, 4, "acres"], decimal: [40.468564224, 2, "decimal"], ft2: [0.09290304, 0, "ft²"], yd2: [0.83612736, 1, "yd²"] };
  SM.fmtLength = function (m, unit) {
    unit = unit || SM.settings.lengthUnit || "auto";
    if (LEN[unit]) { const [f, d, sym] = LEN[unit]; return fmtNum(m / f, d) + " " + sym; }
    if (unit === "auto-ft") { const ft = m / 0.3048; return ft >= 5280 ? fmtNum(ft / 5280, 3) + " mi" : fmtNum(ft, 1) + " ft"; }
    return m >= 1000 ? fmtNum(m / 1000, 3) + " km" : fmtNum(m, m < 10 ? 2 : 1) + " m";
  };
  SM.fmtArea = function (m2, unit) {
    unit = unit || SM.settings.areaUnit || "auto";
    if (AREA[unit]) { const [f, d, sym] = AREA[unit]; return fmtNum(m2 / f, d) + " " + sym; }
    if (m2 >= 1e6) return fmtNum(m2 / 1e6, 3) + " km²";
    if (m2 >= 1e4) return fmtNum(m2 / 1e4, 3) + " ha";
    return fmtNum(m2, 1) + " m²";
  };
  SM.unitShort = (kind) => {
    const u = kind === "area" ? SM.settings.areaUnit : SM.settings.lengthUnit;
    if (!u || u === "auto") return kind === "area" ? "m²/ha" : "m/km";
    if (u === "auto-ft") return "ft/mi";
    return (kind === "area" ? AREA[u] : LEN[u])[2];
  };
  /** True when lengths are shown in feet/yards/miles (used for scale bars). */
  SM.imperialLengths = () => ["ft", "yd", "mi", "auto-ft"].includes(SM.settings.lengthUnit);
  SM.setUnit = function (kind, value) {
    SM.settings[kind === "area" ? "areaUnit" : "lengthUnit"] = value;
    SM.saveSettings();
  };
  /** A <select> bound to the length or area unit setting. */
  SM.unitSelect = function (kind, cls) {
    const list = kind === "area" ? SM.AREA_UNITS : SM.LENGTH_UNITS, cur = kind === "area" ? SM.settings.areaUnit : SM.settings.lengthUnit;
    const s = SM.el("select", { class: cls || "unit-sel", title: kind === "area" ? "Area unit" : "Length unit" },
      list.map(([v, t]) => SM.el("option", { value: v, text: t, selected: v === cur })));
    s.addEventListener("change", () => SM.setUnit(kind, s.value));
    return s;
  };
  SM.toDMS = function (v, isLat) {
    const h = isLat ? (v >= 0 ? "N" : "S") : (v >= 0 ? "E" : "W");
    v = Math.abs(v);
    let d = Math.floor(v), mFloat = (v - d) * 60, m = Math.floor(mFloat), s = (mFloat - m) * 60;
    if (s >= 59.995) { s = 0; m += 1; }
    if (m >= 60) { m = 0; d += 1; }
    return `${d}°${String(m).padStart(2, "0")}′${s.toFixed(2).padStart(5, "0")}″${h}`;
  };
  SM.fmtLatLng = function (lat, lng, fmt) {
    fmt = fmt || SM.settings.coordFormat;
    if (fmt === "dms") return SM.toDMS(lat, true) + "  " + SM.toDMS(lng, false);
    return lat.toFixed(6) + ", " + lng.toFixed(6);
  };

  /** Parse "25.59, 85.13" / "25.59 85.13" / "25°35'48"N 85°8'15"E" / "N25.59 E85.13" → {lat,lng} or null */
  SM.parseLatLng = function (text) {
    if (!text) return null;
    let s = String(text).trim().replace(/[\u2032\u2019]/g, "'").replace(/[\u2033\u201d]/g, '"');
    const dmsRe = /(\d+(?:\.\d+)?)\s*[°d:\s]\s*(?:(\d+(?:\.\d+)?)\s*['m:\s]\s*)?(?:(\d+(?:\.\d+)?)\s*["s]?\s*)?([NSEW])/gi;
    const dms = [...s.matchAll(dmsRe)];
    if (dms.length === 2) {
      const vals = dms.map((m) => {
        let v = parseFloat(m[1]) + (parseFloat(m[2] || 0) / 60) + (parseFloat(m[3] || 0) / 3600);
        const h = m[4].toUpperCase();
        if (h === "S" || h === "W") v = -v;
        return { v, axis: h === "N" || h === "S" ? "lat" : "lng" };
      });
      const lat = vals.find((x) => x.axis === "lat"), lng = vals.find((x) => x.axis === "lng");
      if (lat && lng && Math.abs(lat.v) <= 90 && Math.abs(lng.v) <= 180) return { lat: lat.v, lng: lng.v };
    }
    // hemisphere prefixed/suffixed decimals: N25.5 E85.1 or 25.5N 85.1E
    const hem = [...s.matchAll(/([NSEW])?\s*(-?\d+(?:\.\d+)?)\s*([NSEW])?/gi)].filter((m) => m[1] || m[3]);
    if (hem.length === 2) {
      let lat = null, lng = null;
      for (const m of hem) {
        const h = (m[1] || m[3]).toUpperCase();
        let v = parseFloat(m[2]);
        if (h === "S" || h === "W") v = -Math.abs(v);
        if (h === "N" || h === "S") lat = v; else lng = v;
      }
      if (lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }
    const m = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) {
      const a = parseFloat(m[1]), b = parseFloat(m[2]);
      if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lng: b };
      if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return { lat: b, lng: a, swapped: true };
    }
    return null;
  };

  /* ---------- toast ---------- */
  SM.toast = function (msg, type, ms) {
    const t = SM.el("div", { class: "toast " + (type || ""), text: msg });
    SM.$("#toast-stack").appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; }, (ms || 3200) - 300);
    setTimeout(() => t.remove(), ms || 3200);
  };

  /* ---------- modal dialogs ---------- */
  SM.modal = function ({ title, body, buttons, wide, onClose }) {
    const root = SM.$("#modal-root");
    const back = SM.el("div", { class: "modal-back" });
    const box = SM.el("div", { class: "modal" + (wide ? " wide" : ""), role: "dialog", "aria-modal": "true" });
    const close = (val) => { back.remove(); document.removeEventListener("keydown", onKey, true); if (onClose) onClose(val); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(null); } };
    document.addEventListener("keydown", onKey, true);
    const head = SM.el("div", { class: "modal-head" }, SM.el("h2", { text: title }),
      SM.el("button", { class: "icon-btn", title: "Close", onclick: () => close(null) }, SM.icon("x")));
    const bodyEl = SM.el("div", { class: "modal-body" });
    if (typeof body === "string") bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
    const foot = SM.el("div", { class: "modal-foot" });
    (buttons || [{ label: "Close" }]).forEach((b) => {
      const btn = SM.el("button", { class: "btn " + (b.cls || ""), text: b.label });
      btn.addEventListener("click", async () => {
        if (b.action) {
          const r = await b.action(bodyEl, btn);
          if (r === false) return; // keep dialog open
        }
        close(b.value ?? true);
      });
      foot.append(btn);
    });
    box.append(head, bodyEl, foot);
    back.append(box);
    back.addEventListener("mousedown", (e) => { if (e.target === back) close(null); });
    root.append(back);
    const first = bodyEl.querySelector("input:not([type=checkbox]):not([type=radio]),select,textarea");
    if (first) setTimeout(() => first.focus(), 30);
    return { close, body: bodyEl, foot };
  };
  SM.confirm = (title, message, okLabel, danger) => new Promise((res) => {
    SM.modal({
      title, body: SM.el("p", { text: message, style: { margin: 0 } }),
      buttons: [{ label: "Cancel", value: false }, { label: okLabel || "OK", cls: danger ? "primary danger" : "primary", value: true }],
      onClose: (v) => res(!!v),
    });
  });
  SM.prompt = (title, label, value) => new Promise((res) => {
    const inp = SM.el("input", { class: "field", value: value || "" });
    let result = null;
    const m = SM.modal({
      title, body: SM.el("div", {}, SM.el("label", { class: "muted", text: label }), inp),
      buttons: [{ label: "Cancel" }, { label: "OK", cls: "primary", action: () => { result = inp.value; } }],
      onClose: () => res(result),
    });
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { result = inp.value; m.close(); } });
  });

  /* ---------- dropdown menus ---------- */
  SM.attachMenu = function (button, menu) {
    // menus use position:fixed so they are never clipped by scrolling bars
    const place = () => {
      const r = button.getBoundingClientRect();
      menu.style.top = r.bottom + 6 + "px";
      const w = menu.offsetWidth || 240;
      let left = menu.classList.contains("right") ? r.right - w : r.left;
      menu.style.left = SM.clamp(left, 8, window.innerWidth - w - 8) + "px";
    };
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !menu.classList.contains("open");
      SM.$$(".menu.open").forEach((m) => m.classList.remove("open"));
      if (open) { menu.classList.add("open"); place(); }
    });
    menu.addEventListener("click", (e) => { if (e.target.closest("button")) menu.classList.remove("open"); });
  };
  document.addEventListener("click", () => SM.$$(".menu.open").forEach((m) => m.classList.remove("open")));
})(window.SM);
