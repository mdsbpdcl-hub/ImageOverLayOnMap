/* =====================================================================
   areaops.js — "Select area" tool.
   Drag a box (or draw a lasso) around part of the map, then:
     • Delete objects     – remove the selected objects
     • Cut out area       – like scissors: remove everything inside the area,
                            trimming lines and shapes exactly at its edge
     • Keep only area     – crop: remove everything outside, trimming at the edge
   Works on visible, unlocked objects (optionally only the active layer).
   Geometry is clipped with Turf (polygon-clipping); one Ctrl+Z undoes it.
   ===================================================================== */
"use strict";
(function (SM) {
  const A = {};
  SM.areaops = A;
  const opts = { shape: "box", rule: "touch", activeOnly: false };
  let area = null, preview = null, matchIds = [], lockedSkipped = 0;

  /* ---------------- geometry helpers ---------------- */
  /** A feature as a Turf feature (circles become 72-point polygons). */
  function toTurf(f) {
    const p = f.properties, g = f.geometry;
    if (p.kind === "circle") return turf.polygon([SM.geo.circleRing(g.coordinates, p.radius, 72)]);
    if (g.type === "Point") return turf.point(g.coordinates);
    if (g.type === "LineString") return turf.lineString(g.coordinates);
    return turf.polygon(g.coordinates);
  }
  function matches(f, poly, rule) {
    const t = toTurf(f);
    try {
      if (t.geometry.type === "Point") return turf.booleanPointInPolygon(t, poly);
      return rule === "inside" ? turf.booleanWithin(t, poly) : turf.booleanIntersects(t, poly);
    } catch (e) { return false; }
  }
  /**
   * Clip one feature. mode "erase" removes what is inside the area, "keep"
   * removes what is outside. Returns null (unchanged) or an array of
   * replacement geometries (empty = delete).
   */
  function clip(f, poly, mode) {
    const t = toTurf(f), type = t.geometry.type;
    const inside = (pt) => turf.booleanPointInPolygon(pt, poly);
    const wantInside = mode === "keep";
    if (type === "Point") return inside(t) === wantInside ? null : [];
    if (!turf.booleanIntersects(t, poly)) return wantInside ? [] : null; // entirely outside the area
    if (turf.booleanWithin(t, poly)) return wantInside ? null : []; // entirely inside the area
    if (type === "LineString") {
      const kept = splitLine(t.geometry.coordinates, poly.geometry.coordinates).filter((piece) => {
        let k = 0;
        while (k < piece.length - 2 && piece[k][0] === piece[k + 1][0] && piece[k][1] === piece[k + 1][1]) k++;
        const mid = [(piece[k][0] + piece[k + 1][0]) / 2, (piece[k][1] + piece[k + 1][1]) / 2];
        return inside(turf.point(mid)) === wantInside;
      }).map((c) => ({ type: "LineString", coordinates: c }));
      return kept.filter((g) => g.coordinates.length >= 2);
    }
    // polygons (and circles, which become polygons when cut)
    let res;
    try { res = mode === "keep" ? turf.intersect(turf.featureCollection([t, poly])) : turf.difference(turf.featureCollection([t, poly])); }
    catch (e) { return null; }
    if (!res) return [];
    const g = res.geometry;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    return polys.filter((r) => r[0] && r[0].length >= 4).map((rings) => ({ type: "Polygon", coordinates: rings }));
  }
  /** Split a line exactly where it crosses any edge of the area (no rounding). */
  function splitLine(coords, rings) {
    const edges = [];
    rings.forEach((r) => { for (let i = 0; i < r.length - 1; i++) edges.push([r[i], r[i + 1]]); });
    const pieces = [];
    let cur = [coords[0]];
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i], b = coords[i + 1], ts = [];
      const rx = b[0] - a[0], ry = b[1] - a[1];
      edges.forEach(([c, d]) => {
        const sx = d[0] - c[0], sy = d[1] - c[1], den = rx * sy - ry * sx;
        if (den === 0) return; // parallel
        const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den, u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
        if (t > 1e-12 && t < 1 - 1e-12 && u >= 0 && u <= 1) ts.push(t);
      });
      ts.sort((x, y) => x - y).forEach((t, j) => {
        if (j && t - ts[j - 1] < 1e-12) return;
        const p = [a[0] + t * rx, a[1] + t * ry];
        cur.push(p); pieces.push(cur); cur = [p];
      });
      cur.push(b);
    }
    pieces.push(cur);
    return pieces.filter((pc) => pc.length >= 2);
  }
  A._test = { clip, matches, splitLine };

  /* ---------------- scope ---------------- */
  function scope() {
    const lid = SM.state.project.activeLayerId;
    lockedSkipped = 0;
    return SM.store.features().filter((f) => {
      if (!SM.store.isVisible(f)) return false;
      if (opts.activeOnly && f.properties.layerId !== lid) return false;
      if (!SM.store.isEditable(f)) { lockedSkipped++; return false; }
      return true;
    });
  }

  /* ---------------- applying ---------------- */
  /** Run erase/keep on the current area. Returns counts. */
  A.apply = function (mode, poly) {
    poly = poly || area;
    if (!poly) return null;
    A.lastArea = poly;
    const targets = scope().filter((f) => (mode === "erase" ? matches(f, poly, "touch") : true));
    const plan = [];
    targets.forEach((f) => { const r = clip(f, poly, mode); if (r) plan.push([f.properties.id, r]); });
    if (!plan.length) { SM.toast(mode === "erase" ? "Nothing to cut inside this area" : "Everything is already inside this area"); return { cut: 0, removed: 0 }; }
    let removed = 0, cut = 0;
    const newIds = [];
    SM.store.change((p) => {
      plan.forEach(([id, geoms]) => {
        const i = p.features.findIndex((f) => f.properties.id === id);
        if (i < 0) return;
        const f = p.features[i];
        if (!geoms.length) { p.features.splice(i, 1); removed++; return; }
        cut++;
        const origEnd = f.geometry.type === "LineString" ? f.geometry.coordinates[f.geometry.coordinates.length - 1] : null;
        const made = geoms.map((g, k) => {
          const nf = k === 0 ? f : SM.clone(f);
          if (k > 0) { nf.properties.id = SM.uid(); nf.properties.group = null; }
          nf.geometry = g;
          if (nf.properties.kind === "circle" || nf.properties.kind === "rectangle") { nf.properties.kind = "polygon"; delete nf.properties.radius; }
          if (origEnd && (nf.properties.kind === "arrow" || nf.properties.style.arrow)) {
            const end = g.coordinates[g.coordinates.length - 1];
            const keepsTip = Math.abs(end[0] - origEnd[0]) < 1e-12 && Math.abs(end[1] - origEnd[1]) < 1e-12;
            if (!keepsTip) { nf.properties.kind = nf.properties.kind === "arrow" ? "polyline" : nf.properties.kind; nf.properties.style.arrow = false; }
          }
          newIds.push(nf.properties.id);
          return nf;
        });
        p.features.splice(i, 1, ...made);
      });
    });
    SM.store.clearSelection();
    SM.toast(`${mode === "erase" ? "Cut out" : "Cropped"}: ${cut} object(s) trimmed, ${removed} removed (Ctrl+Z to undo)` + (lockedSkipped ? ` · ${lockedSkipped} locked object(s) left alone` : ""), "ok", 4500);
    return { cut, removed };
  };

  /* ---------------- drawing the area ---------------- */
  const style = { color: "#ffeb3b", weight: 2, dashArray: "6 5", fillColor: "#ffeb3b", fillOpacity: 0.12, interactive: false, pmIgnore: true, snapIgnore: true };
  function clearArea() { if (preview) SM.map.removeLayer(preview); preview = null; area = null; matchIds = []; }
  A.clear = clearArea;

  /** Set the area from [lng,lat] ring and select what it catches. */
  A.setArea = function (ring) {
    if (ring.length < 4) return;
    if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring = ring.concat([ring[0]]);
    let poly = turf.polygon([ring]);
    if (turf.kinks(poly).features.length) { // a lasso that crosses itself: use its outline
      try { poly = turf.convex(turf.featureCollection(ring.map((c) => turf.point(c)))) || poly; } catch (e) { /* keep */ }
    }
    area = poly;
    if (preview) SM.map.removeLayer(preview);
    preview = L.polygon(area.geometry.coordinates[0].map((c) => [c[1], c[0]]), style).addTo(SM.map);
    matchIds = scope().filter((f) => matches(f, area, opts.rule)).map((f) => f.properties.id);
    SM.store.select(matchIds);
    showResult();
  };

  function init() {
    const wrap = SM.$("#map-wrap"), map = SM.map;
    let pts = null, startScreen = null, live = null, pid = null;
    const toLL = (cx, cy) => map.mouseEventToLatLng({ clientX: cx, clientY: cy });
    const ringOf = () => {
      if (opts.shape === "box") {
        const [x0, y0] = startScreen, [x1, y1] = pts;
        return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(([x, y]) => { const l = toLL(x, y); return [l.lng, l.lat]; });
      }
      return pts.map((l) => [l.lng, l.lat]);
    };
    wrap.addEventListener("pointerdown", (ev) => {
      if (SM.tools.current !== "area" || ev.button > 0) return;
      if (!ev.target.closest("#map") || ev.target.closest(".leaflet-control")) return;
      ev.preventDefault(); ev.stopPropagation();
      clearArea(); SM.store.clearSelection();
      pid = ev.pointerId;
      try { wrap.setPointerCapture(pid); } catch (e) { /* ignore */ }
      startScreen = [ev.clientX, ev.clientY];
      pts = opts.shape === "box" ? [ev.clientX, ev.clientY] : [toLL(ev.clientX, ev.clientY)];
      live = L.polygon([], style).addTo(map);
    }, true);
    wrap.addEventListener("pointermove", (ev) => {
      if (!live || ev.pointerId !== pid) return;
      if (opts.shape === "box") pts = [ev.clientX, ev.clientY];
      else {
        const last = map.latLngToContainerPoint(pts[pts.length - 1]), now = map.mouseEventToContainerPoint(ev);
        if (last.distanceTo(now) < 4) return;
        pts.push(toLL(ev.clientX, ev.clientY));
      }
      live.setLatLngs(ringOf().map((c) => [c[1], c[0]]));
    }, true);
    const end = (ev) => {
      if (!live || (ev && ev.pointerId !== pid)) return;
      map.removeLayer(live); live = null;
      try { wrap.releasePointerCapture(pid); } catch (e) { /* ignore */ }
      const tooSmall = opts.shape === "box" ? Math.hypot(pts[0] - startScreen[0], pts[1] - startScreen[1]) < 6 : pts.length < 3;
      if (tooSmall) { pts = null; showHint(); return; }
      A.setArea(ringOf());
      pts = null;
    };
    wrap.addEventListener("pointerup", end, true);
    wrap.addEventListener("pointercancel", () => { if (live) map.removeLayer(live); live = null; pts = null; }, true);
    SM.bus.on("tool", (t) => { if (t === "area") showHint(); else clearArea(); });
  }

  /* ---------------- hint bar UI ---------------- */
  function controls() {
    const seg = SM.el("div", { class: "seg" });
    [["box", "Box"], ["lasso", "Lasso"]].forEach(([v, t]) => {
      const b = SM.el("button", { class: opts.shape === v ? "on" : "", text: t, title: v === "box" ? "Drag a rectangle" : "Draw freely around the objects" });
      b.addEventListener("click", () => { opts.shape = v; showHint(); });
      seg.append(b);
    });
    const rule = SM.el("select", { title: "Which objects count as selected" },
      SM.el("option", { value: "touch", text: "touching the area", selected: opts.rule === "touch" }),
      SM.el("option", { value: "inside", text: "fully inside", selected: opts.rule === "inside" }));
    rule.addEventListener("change", () => { opts.rule = rule.value; if (area) A.setArea(area.geometry.coordinates[0]); });
    const only = SM.el("input", { type: "checkbox", checked: opts.activeOnly });
    only.addEventListener("change", () => { opts.activeOnly = only.checked; if (area) A.setArea(area.geometry.coordinates[0]); });
    return [seg, rule, SM.el("label", {}, only, "active layer only")];
  }
  function bar(text, extra) {
    const b = SM.$("#hintbar");
    b.classList.remove("hidden");
    SM.$("#hint-text").textContent = text;
    const ex = SM.$("#hint-extra");
    ex.innerHTML = "";
    ex.append(...extra);
    SM.$("#hint-undo").classList.add("hidden");
    SM.$("#hint-finish").classList.add("hidden");
  }
  function showHint() {
    if (SM.tools.current !== "area") return;
    bar(opts.shape === "box" ? "Hold the mouse button and drag a box over the part to select" : "Hold the mouse button and draw around the part to select", controls());
  }
  function showResult() {
    const n = matchIds.length;
    const btn = (label, cls, fn, title) => { const b = SM.el("button", { class: "mini-btn " + cls, text: label, title }); b.addEventListener("click", fn); return b; };
    bar(`${n} object${n === 1 ? "" : "s"} selected` + (lockedSkipped ? ` (${lockedSkipped} locked skipped)` : ""), [
      ...controls(),
      btn("Delete objects", "", () => { if (!matchIds.length) return; const k = SM.store.deleteFeatures(matchIds); SM.toast(`${k} object(s) deleted (Ctrl+Z to undo)`, "ok", 2500); clearArea(); showHint(); }, "Remove the selected objects completely"),
      btn("Cut out area", "primary", () => { A.apply("erase"); clearArea(); showHint(); }, "Remove everything inside the area; lines and shapes crossing its edge are cut exactly there"),
      btn("Keep only area", "", () => { A.apply("keep"); clearArea(); showHint(); }, "Crop: remove everything outside the area, cutting at its edge"),
    ]);
  }

  A.init = init;
})(window.SM);
