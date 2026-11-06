/* =====================================================================
   print.js — PNG and PDF map export.
   Renders the map itself onto a canvas (tiles fetched with CORS + drawn
   objects re-drawn from their geographic coordinates), so output is
   crisp at any DPI and a chosen scale (1:N) is honoured exactly at the
   map centre without stretching. Page layout via jsPDF.
   ===================================================================== */
"use strict";
(function (SM) {
  const PR = {};
  SM.print = PR;
  const EARTH_C = 40075016.686; // equatorial circumference (m), Web Mercator
  const PAPER = { A4: [210, 297], A3: [297, 420] };

  /* ---------------- Web Mercator helpers (256 px tiles) ---------------- */
  const worldX = (lng, z) => ((lng + 180) / 360) * 256 * Math.pow(2, z);
  const worldY = (lat, z) => {
    const s = Math.sin((SM.clamp(lat, -85.05113, 85.05113) * Math.PI) / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * Math.pow(2, z);
  };
  const unX = (x, z) => (x / (256 * Math.pow(2, z))) * 360 - 180;
  const unY = (y, z) => { const n = Math.PI - (2 * Math.PI * y) / (256 * Math.pow(2, z)); return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };
  const mppAt = (lat, z) => (EARTH_C * Math.cos((lat * Math.PI) / 180)) / (256 * Math.pow(2, z));
  const zoomForMpp = (lat, mpp) => Math.log2((EARTH_C * Math.cos((lat * Math.PI) / 180)) / (256 * mpp));
  PR.niceScale = function (n) {
    const steps = [1, 1.25, 2, 2.5, 5];
    const p = Math.pow(10, Math.floor(Math.log10(n)));
    for (const m of [...steps, 10]) if (m * p >= n - 1e-9) return m * p;
    return 10 * p;
  };

  /* ---------------- tile loading ---------------- */
  async function loadTiles(jobs, onProgress) {
    let done = 0, failed = 0;
    const out = new Array(jobs.length);
    let next = 0;
    async function worker() {
      while (next < jobs.length) {
        const i = next++;
        try {
          const r = await fetch(jobs[i].url, { mode: "cors", credentials: "omit" });
          if (!r.ok) throw new Error(r.status);
          out[i] = await createImageBitmap(await r.blob());
        } catch (e) { failed++; out[i] = null; }
        done++;
        if (onProgress) onProgress(done / jobs.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(8, jobs.length) }, worker));
    return { images: out, failed };
  }

  /* ---------------- core renderer ---------------- */
  /**
   * opts: center {lat,lng}, zoom (fractional), width, height (px), k (style scale),
   *       basemap (provider) or null, features, measure (bool), grid (bool), onProgress
   */
  PR.renderCanvas = async function (opts) {
    const { center, zoom: z, width: w, height: h, k } = opts;
    const cv = document.createElement("canvas");
    cv.width = Math.round(w); cv.height = Math.round(h);
    const ctx = cv.getContext("2d");
    ctx.fillStyle = opts.basemap ? "#20242c" : "#ffffff";
    ctx.fillRect(0, 0, w, h);
    const ox = worldX(center.lng, z) - w / 2, oy = worldY(center.lat, z) - h / 2;
    const toPx = (c) => [worldX(c[0], z) - ox, worldY(c[1], z) - oy];
    let failed = 0, total = 0;

    if (opts.basemap) {
      for (const lyr of opts.basemap.layers) {
        const tz = Math.max(0, Math.min(Math.round(z), lyr.maxNativeZoom || 19));
        const s = Math.pow(2, z - tz), n = Math.pow(2, tz), size = 256 * s;
        const x0 = Math.floor(ox / size), x1 = Math.floor((ox + w) / size);
        const y0 = Math.max(0, Math.floor(oy / size)), y1 = Math.min(n - 1, Math.floor((oy + h) / size));
        const subs = (lyr.subdomains || "abc").split("");
        const jobs = [];
        for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
          const wx = ((tx % n) + n) % n;
          const url = lyr.url.replace("{z}", tz).replace("{x}", wx).replace("{y}", ty).replace("{s}", subs[Math.abs(wx + ty) % subs.length]).replace("{r}", "");
          jobs.push({ url, dx: tx * size - ox, dy: ty * size - oy, size });
        }
        if (jobs.length > 2500) throw new Error("This print would need " + jobs.length + " imagery tiles. Choose a smaller scale, paper size or DPI.");
        total += jobs.length;
        const res = await loadTiles(jobs, opts.onProgress);
        failed += res.failed;
        res.images.forEach((img, i) => { if (img) ctx.drawImage(img, jobs[i].dx, jobs[i].dy, jobs[i].size + 0.5, jobs[i].size + 0.5); });
      }
    }

    if (SM.overlays && opts.pictures !== false) { await SM.overlays.whenImagesReady(); SM.overlays.drawOnCanvas(ctx, toPx); }
    if (opts.grid) drawGraticule(ctx, w, h, z, ox, oy, k);
    (opts.features || []).forEach((f) => { try { drawFeature(ctx, f, toPx, k, z); } catch (e) { console.warn("print feature", e); } });
    if (opts.measure) (opts.features || []).forEach((f) => { try { drawMeasure(ctx, f, toPx, k); } catch (e) { /* skip */ } });

    return {
      canvas: cv, failed, total,
      mpp: mppAt(center.lat, z),
      toLatLng: (x, y) => ({ lat: unY(y + oy, z), lng: unX(x + ox, z) }),
    };
  };

  function dashFor(s, k) {
    const wd = Math.max(1, s.weight) * k;
    if (s.dash === "dashed") return [wd * 3, wd * 2];
    if (s.dash === "dotted") return [0.1, wd * 2];
    return [];
  }
  const rgba = (hex, a) => { const h = (hex || "#000").replace("#", ""); return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`; };
  const lum = (hex) => { const h = (hex || "#fff").replace("#", ""); return (0.2126 * parseInt(h.slice(0, 2), 16) + 0.7152 * parseInt(h.slice(2, 4), 16) + 0.0722 * parseInt(h.slice(4, 6), 16)) / 255; };
  const PIN = typeof Path2D !== "undefined" ? new Path2D("M15 37C15 37 28 23.5 28 14A13 13 0 0 0 2 14C2 23.5 15 37 15 37Z") : null;

  function drawText(ctx, text, x, y, lab, k, align, baseline) {
    if (!text) return;
    ctx.save();
    ctx.font = `${lab.italic ? "italic " : ""}${lab.bold ? "700" : "500"} ${lab.size * k}px Outfit, "Segoe UI", Arial, sans-serif`;
    ctx.textAlign = align || lab.align || "center";
    ctx.textBaseline = baseline || "middle";
    const lines = String(text).split("\n"), lh = lab.size * k * 1.15;
    const y0 = y - ((lines.length - 1) * lh) / (baseline === "top" ? 1e9 : 2);
    lines.forEach((ln, i) => {
      const yy = baseline === "top" ? y + i * lh : y0 + i * lh;
      if (lab.halo) { ctx.lineWidth = 3.2 * k; ctx.lineJoin = "round"; ctx.strokeStyle = lum(lab.color) > 0.45 ? "rgba(0,0,0,.9)" : "rgba(255,255,255,.95)"; ctx.strokeText(ln, x, yy); }
      ctx.fillStyle = lab.color; ctx.fillText(ln, x, yy);
    });
    ctx.restore();
  }

  function drawFeature(ctx, f, toPx, k) {
    const p = f.properties, s = p.style, g = f.geometry, kind = p.kind;
    ctx.save();
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    if (kind === "marker") {
      const [x, y] = toPx(g.coordinates);
      ctx.translate(x - 15 * k, y - 37 * k); ctx.scale(k, k);
      ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = 3;
      ctx.fillStyle = s.color; ctx.fill(PIN); ctx.shadowBlur = 0;
      ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.stroke(PIN);
      ctx.beginPath(); ctx.arc(15, 14, 5, 0, 2 * Math.PI); ctx.fillStyle = "#fff"; ctx.fill();
      ctx.restore();
      if (p.label.show) { const off = p.label.offset || [0, 0]; drawText(ctx, p.label.text || p.name, x + off[0] * k, y + (6 + off[1]) * k, p.label, k, "center", "top"); }
      return;
    }
    if (kind === "text") {
      const [x, y] = toPx(g.coordinates), off = p.label.offset || [0, 0];
      drawText(ctx, p.label.text, x + off[0] * k, y + off[1] * k, p.label, k);
      ctx.restore();
      return;
    }
    let rings;
    if (kind === "circle") rings = [SM.geo.circleRing(g.coordinates, p.radius, 120)];
    else if (g.type === "Polygon") rings = g.coordinates;
    else rings = null;
    ctx.beginPath();
    if (rings) rings.forEach((r) => r.forEach((c, i) => { const [x, y] = toPx(c); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }) || ctx.closePath());
    else g.coordinates.forEach((c, i) => { const [x, y] = toPx(c); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    if (rings && s.fill && s.fillOpacity > 0) { ctx.fillStyle = rgba(s.fillColor, s.fillOpacity); ctx.fill("evenodd"); }
    if (s.weight > 0) {
      ctx.setLineDash(dashFor(s, k)); ctx.lineWidth = s.weight * k; ctx.strokeStyle = rgba(s.color, s.opacity); ctx.stroke();
    }
    ctx.setLineDash([]);
    if (!rings && (kind === "arrow" || s.arrow) && g.coordinates.length > 1) {
      const pts = g.coordinates.map(toPx), end = pts[pts.length - 1];
      let prev = pts[pts.length - 2];
      for (let i = pts.length - 2; i >= 0; i--) { prev = pts[i]; if (Math.hypot(end[0] - prev[0], end[1] - prev[1]) > 10 * k) break; }
      const ang = Math.atan2(end[1] - prev[1], end[0] - prev[0]), size = (12 + s.weight * 2.4) * k;
      ctx.translate(end[0], end[1]); ctx.rotate(ang);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-size * 0.9, -size * 0.45); ctx.lineTo(-size * 0.7, 0); ctx.lineTo(-size * 0.9, size * 0.45); ctx.closePath();
      ctx.fillStyle = rgba(s.color, s.opacity); ctx.fill();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.restore();
    if (p.label.show) {
      let c;
      if (kind === "circle") c = toPx(g.coordinates);
      else if (rings) { const ps = rings[0].map(toPx); c = [ps.reduce((a, q) => a + q[0], 0) / ps.length, ps.reduce((a, q) => a + q[1], 0) / ps.length]; }
      else { const ps = g.coordinates.map(toPx); c = ps[Math.floor(ps.length / 2)]; if (ps.length === 2) c = [(ps[0][0] + ps[1][0]) / 2, (ps[0][1] + ps[1][1]) / 2]; }
      const off = p.label.offset || [0, 0];
      drawText(ctx, p.label.text || p.name, c[0] + off[0] * k, c[1] + off[1] * k, p.label, k, "center");
    }
  }

  function badge(ctx, text, x, y, k) {
    ctx.save();
    ctx.font = `600 ${11 * k}px Outfit, "Segoe UI", Arial, sans-serif`;
    const tw = ctx.measureText(text).width, ph = 15 * k, pw = tw + 10 * k;
    ctx.fillStyle = "rgba(29,35,48,.85)";
    ctx.fillRect(x - pw / 2, y - ph / 2, pw, ph);
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, x, y + 0.5);
    ctx.restore();
  }
  function drawMeasure(ctx, f, toPx, k) {
    const g = f.geometry, kind = f.properties.kind;
    if (kind === "circle") { const [x, y] = toPx(g.coordinates); badge(ctx, "r " + SM.fmtLength(f.properties.radius), x, y + 14 * k, k); return; }
    if (g.type === "Point") return;
    const coords = g.type === "Polygon" ? g.coordinates[0] : g.coordinates;
    const segs = SM.geo.segments(coords);
    if (kind !== "freehand" && segs.length <= 60) {
      for (let i = 1; i < coords.length; i++) {
        const a = toPx(coords[i - 1]), b = toPx(coords[i]);
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 60 * k) continue;
        badge(ctx, SM.fmtLength(segs[i - 1]), (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, k);
      }
    }
    if (g.type === "Polygon") {
      const ps = coords.map(toPx);
      badge(ctx, SM.fmtArea(SM.geo.polygonArea(g.coordinates)), ps.reduce((s, q) => s + q[0], 0) / ps.length, ps.reduce((s, q) => s + q[1], 0) / ps.length + 16 * k, k);
    } else if (segs.length > 1 || kind === "freehand") {
      const e = toPx(coords[coords.length - 1]);
      badge(ctx, "Total " + SM.fmtLength(segs.reduce((s, x) => s + x, 0)), e[0], e[1] - 16 * k, k);
    }
  }

  function drawGraticule(ctx, w, h, z, ox, oy, k) {
    const north = unY(oy, z), south = unY(oy + h, z), west = unX(ox, z), east = unX(ox + w, z);
    const step = SM.mapview.gridInterval(Math.min(north - south, east - west));
    const dec = Math.max(0, Math.ceil(-Math.log10(step)));
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,.75)"; ctx.lineWidth = 0.8 * k; ctx.setLineDash([4 * k, 4 * k]);
    ctx.font = `500 ${9.5 * k}px Outfit, "Segoe UI", Arial, sans-serif`;
    const lbl = (t, x, y, al, bl) => { ctx.save(); ctx.setLineDash([]); ctx.textAlign = al; ctx.textBaseline = bl; ctx.lineWidth = 3 * k; ctx.strokeStyle = "rgba(0,0,0,.85)"; ctx.strokeText(t, x, y); ctx.fillStyle = "#fff"; ctx.fillText(t, x, y); ctx.restore(); };
    for (let lat = Math.ceil(south / step) * step; lat <= north; lat += step) {
      const y = worldY(lat, z) - oy;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      lbl(lat.toFixed(dec) + "°" + (lat >= 0 ? "N" : "S"), 4 * k, y - 3 * k, "left", "bottom");
    }
    for (let lng = Math.ceil(west / step) * step; lng <= east; lng += step) {
      const x = worldX(lng, z) - ox;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      const L = SM.mapview.wrapLng(lng);
      lbl(Math.abs(L).toFixed(dec) + "°" + (L >= 0 ? "E" : "W"), x + 3 * k, 4 * k, "left", "top");
    }
    ctx.restore();
  }

  /* ---------------- legend data ---------------- */
  function legendEntries(feats) {
    const out = [], seen = new Map();
    SM.store.layers().slice().reverse().forEach((l) => {
      const fs = feats.filter((f) => f.properties.layerId === l.id && f.properties.kind !== "text");
      fs.forEach((f) => {
        const p = f.properties, area = ["polygon", "rectangle", "circle"].includes(p.kind);
        const type = p.kind === "marker" ? "point" : area ? "area" : "line";
        const key = l.id + "|" + type + "|" + p.style.color + "|" + (area ? p.style.fillColor + p.style.fill : "") + "|" + p.style.dash;
        if (seen.has(key)) { seen.get(key).count++; return; }
        const e = { layer: l.name, type, style: p.style, name: p.name, count: 1 };
        seen.set(key, e); out.push(e);
      });
    });
    return out.map((e) => ({ ...e, label: e.count === 1 && e.name ? e.name : e.layer + (e.count > 1 ? ` (${e.count})` : "") }));
  }

  /* ---------------- dialog ---------------- */
  PR.dialog = function (format) {
    const p = SM.state.project;
    const title = SM.el("input", { class: "field", value: p.name });
    const subtitle = SM.el("input", { class: "field", placeholder: "optional — e.g. Site layout, Ward 12" });
    const fmt = SM.el("select", { class: "field" }, SM.el("option", { value: "pdf", text: "PDF document", selected: format === "pdf" }), SM.el("option", { value: "png", text: "PNG image", selected: format === "png" }));
    const paper = SM.el("select", { class: "field" }, SM.el("option", { value: "A4", text: "A4" }), SM.el("option", { value: "A3", text: "A3" }));
    const orient = SM.el("select", { class: "field" }, SM.el("option", { value: "landscape", text: "Landscape" }), SM.el("option", { value: "portrait", text: "Portrait" }));
    const scaleMode = SM.el("select", { class: "field" },
      SM.el("option", { value: "fit", text: "Fit current view (rounded to a standard scale)" }),
      SM.el("option", { value: "fitall", text: "Fit all objects (standard scale)" }),
      SM.el("option", { value: "fixed", text: "True scale — enter 1:N" }));
    const scaleN = SM.el("input", { class: "field", type: "number", min: 50, step: 50, value: PR.niceScale(SM.mapview.screenScale() / 2), disabled: true });
    const dpi = SM.el("select", { class: "field" }, [[150, "150 dpi (fast)"], [200, "200 dpi (recommended)"], [300, "300 dpi (high quality)"]].map(([v, t]) => SM.el("option", { value: v, text: t, selected: v === 200 })));
    const pngSize = SM.el("select", { class: "field" }, [[1, "Screen size"], [2, "2× (sharp)"], [3, "3× (very sharp)"]].map(([v, t]) => SM.el("option", { value: v, text: t, selected: v === 2 })));
    const cb = (label, on) => { const i = SM.el("input", { type: "checkbox", checked: on }); return [i, SM.el("label", { class: "check" }, i, label)]; };
    const base = SM.currentBase = SM.mapview.currentBasemap();
    const [cBase, lBase] = cb("Satellite / base map background", !!(base && base.print_allowed !== false));
    const [cLegend, lLegend] = cb("Legend", true);
    const [cNorth, lNorth] = cb("North arrow", true);
    const [cScale, lScale] = cb("Scale bar", true);
    const [cGrid, lGrid] = cb("Coordinate grid", false);
    const [cMeas, lMeas] = cb("Distance / area annotations", false);
    const [cDate, lDate] = cb("Date of export", true);
    const [cSel, lSel] = cb(`Only selected objects (${SM.state.selection.size})`, false);
    if (!SM.state.selection.size) cSel.disabled = true;
    const pdfOnly = [];
    const r = (label, ctrl, isPdf) => { const a = SM.el("label", { text: label }); if (isPdf) pdfOnly.push(a, ctrl); return [a, ctrl]; };
    const pngOnly = r("Image size", pngSize);
    const body = SM.el("div", { class: "form-grid" },
      ...r("Title", title), ...r("Subtitle", subtitle), ...r("Format", fmt),
      ...r("Paper", paper, true), ...r("Orientation", orient, true), ...r("Scale", scaleMode, true), ...r("Scale 1:", scaleN, true), ...r("Resolution", dpi, true),
      ...pngOnly,
      SM.el("label", { text: "Include" }),
      SM.el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 10px" } }, lBase, lLegend, lNorth, lScale, lGrid, lMeas, lDate, lSel),
      SM.el("div", { class: "full muted", text: "Imagery appears in the export when the provider allows browser access (Esri and OpenStreetMap do). Please respect each provider's attribution and terms of use — the attribution is printed automatically." }),
      SM.el("div", { class: "full" }, SM.el("div", { class: "progress hidden", id: "print-progress" }, SM.el("div"))));
    const sync = () => {
      const isPdf = fmt.value === "pdf";
      pdfOnly.forEach((e) => e.classList.toggle("hidden", !isPdf));
      pngOnly.forEach((e) => e.classList.toggle("hidden", isPdf));
      scaleN.disabled = scaleMode.value !== "fixed";
    };
    fmt.addEventListener("change", sync); scaleMode.addEventListener("change", sync); sync();
    SM.modal({
      title: "Export map image", body,
      buttons: [{ label: "Cancel" }, {
        label: "Create", cls: "primary", action: async (_, btn) => {
          btn.disabled = true; btn.textContent = "Rendering…";
          const prog = SM.$("#print-progress"); prog.classList.remove("hidden");
          const onProgress = (x) => { prog.firstChild.style.width = Math.round(x * 100) + "%"; };
          const opt = {
            title: title.value.trim(), subtitle: subtitle.value.trim(),
            basemap: cBase.checked ? base : null, legend: cLegend.checked, north: cNorth.checked, scalebar: cScale.checked,
            grid: cGrid.checked, measure: cMeas.checked, date: cDate.checked, onlySelected: cSel.checked, onProgress,
          };
          try {
            if (fmt.value === "png") await PR.exportPNG(Object.assign(opt, { mult: +pngSize.value }));
            else await PR.exportPDF(Object.assign(opt, { paper: paper.value, orientation: orient.value, scaleMode: scaleMode.value, scaleN: +scaleN.value, dpi: +dpi.value }));
          } catch (e) {
            SM.toast("Export failed: " + e.message, "error", 7000);
            btn.disabled = false; btn.textContent = "Create";
            return false;
          }
        },
      }],
    });
  };

  function exportFeatures(onlySelected) {
    let feats = SM.store.features().filter(SM.store.isVisible);
    if (onlySelected) feats = feats.filter((f) => SM.state.selection.has(f.properties.id));
    // draw in layer order (bottom → top), then array order within a layer
    const order = new Map(SM.store.layers().map((l, i) => [l.id, i]));
    return feats.map((f, i) => [f, i]).sort((a, b) => order.get(a[0].properties.layerId) - order.get(b[0].properties.layerId) || a[1] - b[1]).map((x) => x[0]);
  }
  const attributionText = (bm) => bm ? bm.layers.map((l) => (l.attribution || "").replace(/<[^>]+>/g, "").replace(/&copy;/g, "©").replace(/&amp;/g, "&")).join(" | ") : "";
  function niceLength(maxM) {
    const p = Math.pow(10, Math.floor(Math.log10(maxM)));
    for (const m of [5, 2.5, 2, 1]) if (m * p <= maxM) return m * p;
    return p;
  }
  const lenLabel = (m) => (m >= 1000 ? +(m / 1000).toFixed(2) + " km" : +m.toFixed(1) + " m");

  /* ---------------- PNG ---------------- */
  PR.exportPNG = async function (o) {
    const size = SM.map.getSize(), mult = o.mult || 2;
    const c = SM.map.getCenter();
    const res = await PR.renderCanvas({
      center: { lat: c.lat, lng: c.lng }, zoom: SM.map.getZoom() + Math.log2(mult),
      width: size.x * mult, height: size.y * mult, k: mult, basemap: o.basemap,
      features: exportFeatures(o.onlySelected), measure: o.measure, grid: o.grid, onProgress: o.onProgress,
    });
    const cv = res.canvas, ctx = cv.getContext("2d"), k = mult, W = cv.width, H = cv.height;
    const panel = (x, y, w, h) => { ctx.save(); ctx.fillStyle = "rgba(255,255,255,.9)"; ctx.shadowColor = "rgba(0,0,0,.25)"; ctx.shadowBlur = 6 * k; roundRect(ctx, x, y, w, h, 8 * k); ctx.fill(); ctx.restore(); };
    ctx.textBaseline = "alphabetic";
    if (o.title || o.subtitle || o.date) {
      ctx.font = `700 ${18 * k}px Outfit, "Segoe UI", Arial`;
      const tw = Math.max(ctx.measureText(o.title).width, 200 * k);
      panel(12 * k, 12 * k, tw + 28 * k, (o.subtitle || o.date ? 52 : 34) * k);
      ctx.fillStyle = "#1d2330"; ctx.fillText(o.title, 26 * k, 36 * k);
      ctx.font = `400 ${11.5 * k}px Outfit, "Segoe UI", Arial`; ctx.fillStyle = "#555";
      ctx.fillText([o.subtitle, o.date ? new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : ""].filter(Boolean).join(" · "), 26 * k, 54 * k);
    }
    if (o.north) drawNorthCanvas(ctx, W - 40 * k, 20 * k, k);
    if (o.scalebar) {
      const L = niceLength(res.mpp * 150 * k), px = L / res.mpp;
      panel(12 * k, H - 46 * k, px + 30 * k, 34 * k);
      ctx.fillStyle = "#1d2330";
      ctx.fillRect(26 * k, H - 24 * k, px / 2, 5 * k); ctx.strokeStyle = "#1d2330"; ctx.lineWidth = 1 * k; ctx.strokeRect(26 * k, H - 24 * k, px, 5 * k);
      ctx.font = `500 ${10 * k}px Outfit, "Segoe UI", Arial`; ctx.textAlign = "center";
      ctx.fillText("0", 26 * k, H - 28 * k); ctx.fillText(lenLabel(L), 26 * k + px, H - 28 * k);
      ctx.textAlign = "left";
    }
    if (o.legend) {
      const entries = legendEntries(exportFeatures(o.onlySelected)).slice(0, 14);
      if (entries.length) {
        const lh = 18 * k, bw = 200 * k, bh = 26 * k + entries.length * lh;
        const x = W - bw - 12 * k, y = H - bh - 30 * k;
        panel(x, y, bw, bh);
        ctx.fillStyle = "#1d2330"; ctx.font = `600 ${11 * k}px Outfit, "Segoe UI", Arial`; ctx.fillText("Legend", x + 12 * k, y + 18 * k);
        entries.forEach((e, i) => {
          const yy = y + 26 * k + i * lh;
          legendSymbolCanvas(ctx, e, x + 12 * k, yy, 22 * k, 12 * k, k);
          ctx.fillStyle = "#1d2330"; ctx.font = `400 ${10.5 * k}px Outfit, "Segoe UI", Arial`;
          ctx.fillText(truncate(ctx, e.label, bw - 50 * k), x + 42 * k, yy + 10 * k);
        });
      }
    }
    const attr = attributionText(o.basemap);
    if (attr) { ctx.font = `400 ${9 * k}px Outfit, Arial`; ctx.textAlign = "right"; ctx.fillStyle = "rgba(255,255,255,.85)"; const tw = ctx.measureText(attr).width; ctx.fillRect(W - tw - 10 * k, H - 15 * k, tw + 10 * k, 15 * k); ctx.fillStyle = "#333"; ctx.fillText(attr, W - 5 * k, H - 4 * k); ctx.textAlign = "left"; }
    const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
    SM.downloadBlob(blob, SM.safeName(o.title || SM.state.project.name) + ".png");
    reportTiles(res);
  };
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function truncate(ctx, t, max) { if (ctx.measureText(t).width <= max) return t; while (t.length > 1 && ctx.measureText(t + "…").width > max) t = t.slice(0, -1); return t + "…"; }
  function drawNorthCanvas(ctx, x, y, k) {
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,.9)"; ctx.beginPath(); ctx.arc(x + 14 * k, y + 22 * k, 20 * k, 0, 2 * Math.PI); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x + 14 * k, y + 6 * k); ctx.lineTo(x + 22 * k, y + 32 * k); ctx.lineTo(x + 14 * k, y + 26 * k); ctx.closePath(); ctx.fillStyle = "#1d2330"; ctx.fill();
    ctx.beginPath(); ctx.moveTo(x + 14 * k, y + 6 * k); ctx.lineTo(x + 6 * k, y + 32 * k); ctx.lineTo(x + 14 * k, y + 26 * k); ctx.closePath(); ctx.fillStyle = "#9aa3b2"; ctx.fill();
    ctx.fillStyle = "#1d2330"; ctx.font = `700 ${10 * k}px Outfit, Arial`; ctx.textAlign = "center"; ctx.fillText("N", x + 14 * k, y + 40 * k);
    ctx.restore();
  }
  function legendSymbolCanvas(ctx, e, x, y, w, h, k) {
    ctx.save();
    const s = e.style;
    if (e.type === "point") { ctx.translate(x + w / 2 - 6 * k, y - 1 * k); ctx.scale(k * 0.4, k * 0.4); ctx.fillStyle = s.color; ctx.fill(PIN); }
    else if (e.type === "area") { ctx.fillStyle = rgba(s.fillColor, s.fill ? Math.max(s.fillOpacity, 0.15) : 0); ctx.fillRect(x, y, w, h); ctx.lineWidth = Math.min(s.weight, 3) * k; ctx.strokeStyle = rgba(s.color, s.opacity); ctx.setLineDash(dashFor(s, k * 0.6)); ctx.strokeRect(x, y, w, h); }
    else { ctx.beginPath(); ctx.moveTo(x, y + h / 2); ctx.lineTo(x + w, y + h / 2); ctx.lineWidth = Math.min(s.weight, 5) * k; ctx.strokeStyle = rgba(s.color, s.opacity); ctx.setLineDash(dashFor(s, k * 0.6)); ctx.lineCap = "round"; ctx.stroke(); }
    ctx.restore();
  }
  function reportTiles(res) {
    if (res.total && res.failed === res.total) SM.toast("Map exported, but the imagery provider blocked tile access, so the background is empty. Try another base map.", "error", 7000);
    else if (res.failed) SM.toast(`Map exported (${res.failed} of ${res.total} imagery tiles could not be loaded)`, "", 5000);
    else SM.toast("Map exported", "ok", 2000);
  }

  /* ---------------- PDF ---------------- */
  PR.exportPDF = async function (o) {
    if (!window.jspdf) throw new Error("PDF library not loaded");
    const [pw0, ph0] = PAPER[o.paper] || PAPER.A4;
    const land = o.orientation === "landscape";
    const PW = land ? ph0 : pw0, PH = land ? pw0 : ph0;
    const M = 10, titleH = o.title || o.subtitle ? 15 : 4, footH = 30;
    const frame = { x: M, y: M + titleH, w: PW - 2 * M, h: PH - 2 * M - titleH - footH - 3 };
    const dpi = o.dpi || 200, pxPerMm = dpi / 25.4;
    const fwPx = Math.round(frame.w * pxPerMm), fhPx = Math.round(frame.h * pxPerMm);
    const feats = exportFeatures(o.onlySelected);

    // ---- determine centre and scale ----
    let center, N;
    if (o.scaleMode === "fixed") {
      const c = SM.map.getCenter(); center = { lat: c.lat, lng: c.lng };
      N = Math.max(10, o.scaleN || 1000);
    } else {
      let b;
      if (o.scaleMode === "fitall") { b = SM.mapview.boundsOf(feats); if (!b) throw new Error("There are no objects to fit"); b = b.pad(0.06); }
      else b = SM.map.getBounds();
      const cc = b.getCenter(); center = { lat: cc.lat, lng: cc.lng };
      const bw = Math.max(1e-9, worldX(b.getEast(), 0) - worldX(b.getWest(), 0)), bh = Math.max(1e-9, worldY(b.getSouth(), 0) - worldY(b.getNorth(), 0));
      const zFit = Math.log2(Math.min(fwPx / bw, fhPx / bh));
      N = PR.niceScale(mppAt(center.lat, zFit) * dpi / 0.0254);
    }
    const mpp = (N * 0.0254) / dpi;       // ground metres per output pixel
    const zoom = zoomForMpp(center.lat, mpp);
    if (zoom > 23) throw new Error("Scale too large for the imagery — choose a smaller scale (bigger N)");

    const res = await PR.renderCanvas({ center, zoom, width: fwPx, height: fhPx, k: dpi / 96, basemap: o.basemap, features: feats, measure: o.measure, grid: o.grid, onProgress: o.onProgress });

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: land ? "landscape" : "portrait", unit: "mm", format: o.paper.toLowerCase(), compress: true });
    doc.setProperties({ title: o.title || SM.state.project.name, creator: "SatMap GIS" });
    // title block
    if (titleH > 4) {
      doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(29, 35, 48);
      doc.text(o.title || "", M, M + 6);
      if (o.subtitle) { doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(90); doc.text(o.subtitle, M, M + 11.5); }
    }
    if (o.date) { doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(90); doc.text("Date: " + new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }), PW - M, M + 6, { align: "right" }); }
    // map image
    const img = o.basemap ? res.canvas.toDataURL("image/jpeg", 0.9) : res.canvas.toDataURL("image/png");
    doc.addImage(img, o.basemap ? "JPEG" : "PNG", frame.x, frame.y, frame.w, frame.h, undefined, "FAST");
    doc.setDrawColor(29, 35, 48); doc.setLineWidth(0.4); doc.rect(frame.x, frame.y, frame.w, frame.h);
    // corner coordinates
    const nw = res.toLatLng(0, 0), se = res.toLatLng(fwPx, fhPx);
    doc.setFontSize(6.5); doc.setTextColor(60);
    doc.text(`${nw.lat.toFixed(5)}°, ${SM.mapview.wrapLng(nw.lng).toFixed(5)}°`, frame.x + 0.5, frame.y - 1);
    doc.text(`${se.lat.toFixed(5)}°, ${SM.mapview.wrapLng(se.lng).toFixed(5)}°`, frame.x + frame.w - 0.5, frame.y + frame.h + 3, { align: "right" });

    // footer
    const fy = frame.y + frame.h + 5;
    const colW = (PW - 2 * M) / 4;
    // legend (left two columns)
    if (o.legend) {
      const entries = legendEntries(feats);
      doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(29, 35, 48); doc.text("Legend", M, fy + 2);
      doc.setFont("helvetica", "normal"); doc.setFontSize(7.2);
      const perCol = 5, cols = 2, maxItems = perCol * cols;
      entries.slice(0, maxItems).forEach((e, i) => {
        const cx = M + Math.floor(i / perCol) * colW, cy = fy + 5 + (i % perCol) * 4.6;
        legendSymbolPdf(doc, e, cx, cy, 7, 3);
        doc.setTextColor(29, 35, 48);
        const t = doc.splitTextToSize(e.label, colW - 11)[0];
        doc.text(t, cx + 9, cy + 2.4);
      });
      if (entries.length > maxItems) { doc.setTextColor(120); doc.text(`+ ${entries.length - maxItems} more`, M, fy + 5 + perCol * 4.6 + 1); }
      if (!entries.length) { doc.setTextColor(120); doc.text("No drawn objects", M, fy + 6); }
    }
    // scale bar + north arrow (third column)
    const sx = M + colW * 2 + 2;
    if (o.scalebar) {
      const maxMm = colW - 20, L = niceLength((maxMm / 1000) * N), barMm = (L / N) * 1000;
      doc.setFontSize(7.5); doc.setTextColor(29, 35, 48); doc.setFont("helvetica", "bold");
      doc.text(`Scale 1:${Math.round(N).toLocaleString("en-IN")}`, sx, fy + 2);
      doc.setFont("helvetica", "normal"); doc.setFontSize(6.5); doc.setTextColor(90);
      doc.text(`at ${o.paper} · true at map centre (lat ${center.lat.toFixed(3)}°)`, sx, fy + 5.5);
      const by = fy + 10;
      doc.setLineWidth(0.25); doc.setDrawColor(29, 35, 48);
      for (let i = 0; i < 4; i++) {
        doc.setFillColor(i % 2 ? 255 : 29, i % 2 ? 255 : 35, i % 2 ? 255 : 48);
        doc.rect(sx + (barMm / 4) * i, by, barMm / 4, 1.8, "FD");
      }
      doc.setFontSize(6.5); doc.setTextColor(29, 35, 48);
      doc.text("0", sx, by + 5, { align: "center" });
      doc.text(lenLabel(L / 2), sx + barMm / 2, by + 5, { align: "center" });
      doc.text(lenLabel(L), sx + barMm, by + 5, { align: "center" });
    }
    if (o.north) {
      const nx = M + colW * 3 - 9, ny = fy + 1;
      doc.setFillColor(29, 35, 48); doc.triangle(nx, ny, nx + 3.5, ny + 11, nx, ny + 8.5, "F");
      doc.setFillColor(154, 163, 178); doc.triangle(nx, ny, nx - 3.5, ny + 11, nx, ny + 8.5, "F");
      doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(29, 35, 48); doc.text("N", nx, ny + 15.5, { align: "center" });
    }
    // info column
    const ix = M + colW * 3 + 2;
    doc.setFont("helvetica", "normal"); doc.setFontSize(6.8); doc.setTextColor(60);
    const cLat = center.lat.toFixed(6), cLng = SM.mapview.wrapLng(center.lng).toFixed(6);
    const info = [
      `Centre: ${cLat}°, ${cLng}°`,
      `NW: ${nw.lat.toFixed(5)}°, ${SM.mapview.wrapLng(nw.lng).toFixed(5)}°`,
      `SE: ${se.lat.toFixed(5)}°, ${SM.mapview.wrapLng(se.lng).toFixed(5)}°`,
      "Datum WGS84 · Web Mercator (EPSG:3857)",
      `Project: ${SM.state.project.name}`,
    ];
    info.forEach((t, i) => doc.text(doc.splitTextToSize(t, colW - 3)[0], ix, fy + 2 + i * 3.6));
    const attr = attributionText(o.basemap);
    doc.setFontSize(5.8); doc.setTextColor(120);
    const attrLines = doc.splitTextToSize((attr ? "Base map: " + attr + " · " : "") + "Made with SatMap GIS", PW - 2 * M);
    doc.text(attrLines.slice(0, 2), M, PH - M + 3);

    doc.save(SM.safeName(o.title || SM.state.project.name) + ".pdf");
    reportTiles(res);
  };
  function hexRgb(h) { h = (h || "#000").replace("#", ""); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  function legendSymbolPdf(doc, e, x, y, w, h) {
    const s = e.style, [r, g, b] = hexRgb(s.color);
    doc.setLineWidth(Math.min(Math.max(s.weight, 0.5), 4) * 0.18);
    doc.setDrawColor(r, g, b);
    if (e.type === "point") { doc.setFillColor(r, g, b); doc.circle(x + w / 2, y + h / 2, 1.3, "F"); }
    else if (e.type === "area") {
      const [fr, fg, fb] = hexRgb(s.fillColor), a = s.fill ? Math.max(s.fillOpacity, 0.15) : 0;
      // blend fill colour with white to emulate opacity
      doc.setFillColor(Math.round(255 - (255 - fr) * a), Math.round(255 - (255 - fg) * a), Math.round(255 - (255 - fb) * a));
      doc.rect(x, y, w, h, "FD");
    } else { doc.line(x, y + h / 2, x + w, y + h / 2); }
  }
})(window.SM);
