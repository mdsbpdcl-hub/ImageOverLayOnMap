/* =====================================================================
   render.js — turns project features into Leaflet layers and keeps them
   in sync; handles selection visuals, vertex editing, dragging (including
   moving several selected objects together) and on-map decorations
   (arrow heads, measurement labels).
   ===================================================================== */
"use strict";
(function (SM) {
  const R = {};
  SM.render = R;
  const reg = new Map(); // id -> { layer, hash, decor }
  let measureGroup = null;
  let orderSig = "";
  let dragCtx = null, justDragged = { id: null, t: 0 };

  R.init = function () {
    measureGroup = L.layerGroup().addTo(SM.map);
    SM.bus.on("change", () => R.sync());
    SM.bus.on("selection", () => { R.applySelection(); R.refreshMeasureLabels(); });
    SM.bus.on("tool", () => R.applySelection());
    SM.bus.on("settings", () => { R.refreshMeasureLabels(); });
    SM.map.on("zoomend", () => { reg.forEach((e, id) => updateArrow(id)); R.refreshMeasureLabels(); });
  };
  R.layerOf = (id) => (reg.get(id) || {}).layer;

  /* ---------------- panes (one per drawing layer, ordered) ---------------- */
  function paneName(lid) { return "sm-" + lid; }
  function ensurePane(lid) {
    const n = paneName(lid);
    if (!SM.map.getPane(n)) SM.map.createPane(n);
    return n;
  }
  function updatePanes() {
    SM.store.layers().forEach((l, i) => {
      const pane = SM.map.getPane(ensurePane(l.id));
      pane.style.zIndex = String(Math.min(410 + i * 2, 590));
    });
  }

  /* ---------------- style helpers ---------------- */
  function dash(style) {
    const w = Math.max(1, style.weight || 1);
    if (style.dash === "dashed") return `${w * 3} ${w * 2}`;
    if (style.dash === "dotted") return `0.5 ${w * 2}`;
    return null;
  }
  R.pathOptions = function (f, pane) {
    const s = f.properties.style, k = f.properties.kind;
    const area = k === "polygon" || k === "rectangle" || k === "circle";
    return {
      pane, color: s.color, weight: s.weight, opacity: s.opacity,
      fill: area, fillColor: s.fillColor, fillOpacity: area ? (s.fill ? s.fillOpacity : 0) : 0,
      dashArray: dash(s), lineCap: s.dash === "dotted" ? "round" : "round", lineJoin: "round",
      bubblingMouseEvents: false,
    };
  };
  function luminance(hex) {
    const h = (hex || "#fff").replace("#", "");
    const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  R.labelStyle = function (lab) {
    const haloColor = luminance(lab.color) > 0.45 ? "0,0,0" : "255,255,255";
    const halo = lab.halo ? `text-shadow:0 0 3px rgba(${haloColor},.95),0 0 2px rgba(${haloColor},.95),0 0 6px rgba(${haloColor},.6);` : "";
    return `font-size:${lab.size}px;color:${lab.color};font-weight:${lab.bold ? 700 : 500};font-style:${lab.italic ? "italic" : "normal"};text-align:${lab.align};${halo}`;
  };
  function labelHtml(f) {
    const lab = f.properties.label;
    const text = lab.text || f.properties.name;
    return `<div style="${R.labelStyle(lab)}">${SM.esc(text)}</div>`;
  }
  R.pinSvg = (color) => `<svg viewBox="0 0 30 38"><path d="M15 37C15 37 28 23.5 28 14A13 13 0 0 0 2 14C2 23.5 15 37 15 37Z" fill="${color}" stroke="#fff" stroke-width="2"/><circle cx="15" cy="14" r="5" fill="#fff"/></svg>`;
  function textIcon(f) {
    const lab = f.properties.label;
    const tx = lab.align === "left" ? "0%" : lab.align === "right" ? "-100%" : "-50%";
    const off = lab.offset || [0, 0];
    const html = `<div class="sm-text-inner" style="transform:translate(calc(${tx} + ${off[0]}px), calc(-50% + ${off[1]}px));${R.labelStyle(lab)}">${SM.esc(lab.text || "Text")}</div>`;
    return L.divIcon({ className: "sm-text", html, iconSize: null });
  }

  /* ---------------- build ---------------- */
  const ll = (c) => [c[1], c[0]];
  function build(f) {
    const p = f.properties, g = f.geometry, pane = ensurePane(p.layerId);
    let layer;
    if (p.kind === "marker") {
      layer = L.marker(ll(g.coordinates), { pane, icon: L.divIcon({ className: "sm-pin", html: R.pinSvg(p.style.color), iconSize: [30, 38], iconAnchor: [15, 37] }), draggable: false, bubblingMouseEvents: false });
    } else if (p.kind === "text") {
      layer = L.marker(ll(g.coordinates), { pane, icon: textIcon(f), draggable: false, bubblingMouseEvents: false });
    } else if (p.kind === "circle") {
      layer = L.circle(ll(g.coordinates), Object.assign({ radius: p.radius || 1 }, R.pathOptions(f, pane)));
    } else if (p.kind === "rectangle" && g.type === "Polygon") {
      layer = L.rectangle(L.latLngBounds(g.coordinates[0].map(ll)), R.pathOptions(f, pane));
    } else if (g.type === "Polygon") {
      layer = L.polygon(g.coordinates.map((r) => r.slice(0, -1).map(ll)), R.pathOptions(f, pane));
    } else if (g.type === "LineString") {
      layer = L.polyline(g.coordinates.map(ll), R.pathOptions(f, pane));
    } else return null;

    layer._smId = p.id;
    if (p.label.show && p.kind !== "text") {
      const off = p.label.offset || [0, 0];
      layer.bindTooltip(labelHtml(f), {
        permanent: true, interactive: false, className: "sm-label",
        direction: p.kind === "marker" ? "bottom" : "center",
        offset: p.kind === "marker" ? [off[0], 4 + off[1]] : off,
      });
    }
    wire(layer, p.id);
    return layer;
  }

  function wire(layer, id) {
    layer.on("click", (e) => { L.DomEvent.stopPropagation(e); SM.tools.onFeatureClick(id, e); });
    layer.on("dblclick", (e) => { L.DomEvent.stopPropagation(e); });
    // vertex editing
    layer.on("pm:edit", () => {
      const key = justDragged.id === id && Date.now() - justDragged.t < 800 ? "drag:" + id : "edit:" + id;
      writeBack(id, key);
    });
    layer.on("pm:markerdrag pm:vertexadded pm:vertexremoved pm:change", () => { updateArrow(id); R.refreshMeasureLabels(id); });
    // dragging (paths via Geoman, markers via Leaflet)
    const start = () => dragStart(id), move = () => dragMove(id), end = () => dragEnd(id);
    layer.on("pm:dragstart", start); layer.on("pm:drag", move); layer.on("pm:dragend", end);
    if (layer instanceof L.Marker) { layer.on("dragstart", start); layer.on("drag", move); layer.on("dragend", end); }
  }

  /* ---------------- sync store -> map ---------------- */
  R.sync = function () {
    if (!SM.state.project) return;
    updatePanes();
    const seen = new Set();
    let rebuilt = false;
    SM.store.features().forEach((f) => {
      const id = f.properties.id;
      if (!SM.store.isVisible(f)) return;
      seen.add(id);
      const hash = JSON.stringify(f);
      const e = reg.get(id);
      if (e && e.hash === hash) return;
      if (e) removeEntry(id);
      const layer = build(f);
      if (!layer) return;
      layer.addTo(SM.map);
      reg.set(id, { layer, hash, decor: null });
      updateArrow(id);
      rebuilt = true;
    });
    for (const id of [...reg.keys()]) if (!seen.has(id)) removeEntry(id);
    // stacking order inside each pane follows the feature array order
    const sig = SM.store.features().map((f) => f.properties.id).join(",");
    if (rebuilt || sig !== orderSig) {
      orderSig = sig;
      SM.store.features().forEach((f, i) => {
        const e = reg.get(f.properties.id);
        if (!e) return;
        if (e.layer.bringToFront) e.layer.bringToFront();
        if (e.layer.setZIndexOffset) e.layer.setZIndexOffset(i);
      });
    }
    R.applySelection();
    R.refreshMeasureLabels();
  };
  function removeEntry(id) {
    const e = reg.get(id);
    if (!e) return;
    if (e.layer.pm && e.layer.pm.enabled && e.layer.pm.enabled()) e.layer.pm.disable();
    SM.map.removeLayer(e.layer);
    if (e.decor) SM.map.removeLayer(e.decor);
    reg.delete(id);
  }

  /* ---------------- selection & edit state ---------------- */
  const pmOpts = () => ({
    snappable: SM.settings.snapping, snapDistance: SM.settings.snapDistance,
    allowSelfIntersection: true, removeVertexOn: "contextmenu", preventMarkerRemoval: false,
  });
  R.applySelection = function () {
    const sel = SM.state.selection;
    const tool = SM.tools ? SM.tools.current : "select";
    const single = sel.size === 1;
    reg.forEach((e, id) => {
      const f = SM.store.feature(id);
      const isSel = sel.has(id);
      const el = e.layer._path || e.layer._icon;
      if (el) el.classList.toggle("sm-selected", isSel);
      const editable = isSel && SM.store.isEditable(f);
      const wantVertices = editable && single && (tool === "select" || tool === "edit") && !(e.layer instanceof L.Marker);
      const wantDrag = editable && (tool === "select" || tool === "move");
      setEdit(e.layer, wantVertices, wantDrag);
    });
  };
  function setEdit(layer, vertices, drag) {
    if (layer instanceof L.Marker) {
      if (drag) layer.dragging && layer.dragging.enable(); else layer.dragging && layer.dragging.disable();
      return;
    }
    if (!layer.pm) return;
    const st = layer._smEdit || "";
    const want = (vertices ? "v" : "") + (drag ? "d" : "");
    if (st === want) return;
    if (layer.pm.enabled()) layer.pm.disable();
    if (layer.pm.layerDragEnabled && layer.pm.layerDragEnabled()) layer.pm.disableLayerDrag();
    // Geoman needs drag enabled first, then vertex editing, for both to be active
    if (drag) layer.pm.enableLayerDrag();
    if (vertices) layer.pm.enable(Object.assign(pmOpts(), { draggable: drag }));
    layer._smEdit = want;
  }
  R.resetEditState = function () { reg.forEach((e) => { e.layer._smEdit = null; }); R.applySelection(); };

  /* ---------------- geometry write-back ---------------- */
  const toC = (p) => [p.lng, p.lat];
  function closeRing(r) { const c = r.map(toC); if (c.length && (c[0][0] !== c[c.length - 1][0] || c[0][1] !== c[c.length - 1][1])) c.push(c[0].slice()); return c; }
  function normalizeLng(geom) {
    // keep longitudes in −180…180 when drawn on a wrapped world copy
    const pts = geom.type === "Point" ? [geom.coordinates] : geom.type === "LineString" ? geom.coordinates : geom.coordinates.flat();
    const mean = pts.reduce((s, c) => s + c[0], 0) / pts.length;
    const shift = Math.round(mean / 360) * 360;
    if (shift) pts.forEach((c) => { c[0] -= shift; });
    return geom;
  }
  R.geomFromLayer = function (layer, kind) {
    if (layer instanceof L.Circle) { const c = layer.getLatLng(); return { geometry: normalizeLng({ type: "Point", coordinates: [c.lng, c.lat] }), radius: layer.getRadius() }; }
    if (layer instanceof L.Marker) { const c = layer.getLatLng(); return { geometry: normalizeLng({ type: "Point", coordinates: [c.lng, c.lat] }) }; }
    if (layer instanceof L.Polygon) {
      let rings = layer.getLatLngs();
      if (rings.length && !Array.isArray(rings[0])) rings = [rings];
      if (Array.isArray(rings[0][0])) rings = rings[0]; // multipolygon: keep first part
      return { geometry: normalizeLng({ type: "Polygon", coordinates: rings.filter((r) => r.length >= 3).map(closeRing) }) };
    }
    if (layer instanceof L.Polyline) {
      let pts = layer.getLatLngs();
      if (Array.isArray(pts[0])) pts = pts[0];
      return { geometry: normalizeLng({ type: "LineString", coordinates: pts.map(toC) }) };
    }
    return null;
  };
  function writeBack(id, coalesceKey) {
    const e = reg.get(id), f = SM.store.feature(id);
    if (!e || !f) return;
    const g = R.geomFromLayer(e.layer, f.properties.kind);
    if (!g || !validGeom(g.geometry)) return;
    SM.store.change(() => {
      f.geometry = g.geometry;
      if (g.radius !== undefined) f.properties.radius = g.radius;
      e.hash = JSON.stringify(f); // map already shows this geometry: don't rebuild
    }, { coalesce: coalesceKey, ids: [id], source: "edit" });
    updateArrow(id);
  }
  function validGeom(g) {
    if (g.type === "LineString") return g.coordinates.length >= 2;
    if (g.type === "Polygon") return g.coordinates.length && g.coordinates[0].length >= 4;
    return true;
  }

  /* ---------------- moving several selected objects together ---------------- */
  function anchorOf(layer) {
    if (layer.getLatLng) return layer.getLatLng();
    return layer.getBounds().getCenter();
  }
  function dragStart(id) {
    const e = reg.get(id);
    if (!e) return;
    const others = [...SM.state.selection].filter((x) => x !== id && reg.has(x) && SM.store.isEditable(SM.store.feature(x)));
    dragCtx = { id, start: SM.map.project(anchorOf(e.layer)), others: others.map((x) => ({ id: x, geom: SM.clone(SM.store.feature(x).geometry) })) };
  }
  R.translateGeom = function (geom, dx, dy) {
    const z = SM.map.getZoom();
    const mv = (c) => { const p = SM.map.project([c[1], c[0]], z).add([dx, dy]); const q = SM.map.unproject(p, z); return [q.lng, q.lat]; };
    const g = SM.clone(geom);
    if (g.type === "Point") g.coordinates = mv(g.coordinates);
    else if (g.type === "LineString") g.coordinates = g.coordinates.map(mv);
    else if (g.type === "Polygon") g.coordinates = g.coordinates.map((r) => r.map(mv));
    return g;
  };
  function applyGeomToLayer(layer, f, geom) {
    if (layer instanceof L.Marker || layer instanceof L.Circle) layer.setLatLng(ll(geom.coordinates));
    else if (layer instanceof L.Rectangle) layer.setBounds(L.latLngBounds(geom.coordinates[0].map(ll)));
    else if (layer instanceof L.Polygon) layer.setLatLngs(geom.coordinates.map((r) => r.slice(0, -1).map(ll)));
    else if (layer instanceof L.Polyline) layer.setLatLngs(geom.coordinates.map(ll));
  }
  function dragMove(id) {
    if (!dragCtx || dragCtx.id !== id) return;
    const d = SM.map.project(anchorOf(reg.get(id).layer)).subtract(dragCtx.start);
    dragCtx.others.forEach((o) => {
      const e = reg.get(o.id), f = SM.store.feature(o.id);
      if (e && f) { applyGeomToLayer(e.layer, f, R.translateGeom(o.geom, d.x, d.y)); updateArrow(o.id); }
    });
    updateArrow(id);
  }
  function dragEnd(id) {
    const e = reg.get(id), f = SM.store.feature(id);
    if (!e || !f) { dragCtx = null; return; }
    const ctx = dragCtx && dragCtx.id === id ? dragCtx : null;
    const d = ctx ? SM.map.project(anchorOf(e.layer)).subtract(ctx.start) : null;
    const g = R.geomFromLayer(e.layer, f.properties.kind);
    SM.store.change(() => {
      if (g) { f.geometry = g.geometry; if (g.radius !== undefined) f.properties.radius = g.radius; e.hash = JSON.stringify(f); }
      if (ctx) ctx.others.forEach((o) => { const of = SM.store.feature(o.id); if (of) of.geometry = R.translateGeom(o.geom, d.x, d.y); });
    }, { coalesce: "drag:" + id, source: "drag" });
    justDragged = { id, t: Date.now() };
    dragCtx = null;
  }

  /* ---------------- arrow heads ---------------- */
  function updateArrow(id) {
    const e = reg.get(id), f = SM.store.feature(id);
    if (!e) return;
    const wants = f && (f.properties.kind === "arrow" || f.properties.style.arrow) && e.layer instanceof L.Polyline && !(e.layer instanceof L.Polygon);
    if (!wants) { if (e.decor) { SM.map.removeLayer(e.decor); e.decor = null; } return; }
    let pts = e.layer.getLatLngs();
    if (Array.isArray(pts[0])) pts = pts[0];
    if (pts.length < 2) return;
    const end = SM.map.latLngToLayerPoint(pts[pts.length - 1]);
    let prev = null;
    for (let i = pts.length - 2; i >= 0; i--) { prev = SM.map.latLngToLayerPoint(pts[i]); if (prev.distanceTo(end) > 10) break; }
    const ang = (Math.atan2(end.y - prev.y, end.x - prev.x) * 180) / Math.PI;
    const s = f.properties.style, size = 12 + s.weight * 2.4;
    const html = `<svg width="${size}" height="${size}" viewBox="0 0 20 20" style="transform-origin:100% 50%;transform:rotate(${ang}deg);overflow:visible;display:block"><path d="M20 10 L2 1 L6 10 L2 19 Z" fill="${s.color}" fill-opacity="${s.opacity}" stroke="none"/></svg>`;
    const icon = L.divIcon({ className: "sm-arrowhead", html, iconSize: [size, size], iconAnchor: [size, size / 2] }); // tip = anchor = line end
    if (!e.decor) e.decor = L.marker(pts[pts.length - 1], { icon, interactive: false, pmIgnore: true, snapIgnore: true, pane: e.layer.options.pane, keyboard: false }).addTo(SM.map);
    else { e.decor.setLatLng(pts[pts.length - 1]); e.decor.setIcon(icon); }
  }

  /* ---------------- measurement labels on the map ---------------- */
  R.refreshMeasureLabels = function () {
    if (!measureGroup) return;
    measureGroup.clearLayers();
    const mode = SM.settings.measureLabels;
    if (mode === "off") return;
    let ids = mode === "all" ? [...reg.keys()] : [...SM.state.selection].filter((id) => reg.has(id));
    ids = ids.slice(0, mode === "all" ? 400 : 40);
    let budget = 600;
    ids.forEach((id) => {
      const e = reg.get(id), f = SM.store.feature(id);
      if (!e || !f || budget <= 0) return;
      const live = R.geomFromLayer(e.layer, f.properties.kind);
      if (!live) return;
      const tmp = { geometry: live.geometry, properties: Object.assign({}, f.properties, live.radius !== undefined ? { radius: live.radius } : {}) };
      const add = (latlng, text) => { budget--; measureGroup.addLayer(L.marker(latlng, { interactive: false, pmIgnore: true, snapIgnore: true, keyboard: false, icon: L.divIcon({ className: "", html: `<div class="sm-measure-label" style="transform:translate(-50%,-50%);display:inline-block">${text}</div>`, iconSize: null }) })); };
      const g = tmp.geometry, k = tmp.properties.kind;
      if (k === "circle") {
        const r = tmp.properties.radius;
        const edge = SM.geo.destination(g.coordinates, 90, r / 2);
        add([edge[1], edge[0]], "r " + SM.fmtLength(r));
        add([g.coordinates[1], g.coordinates[0]], SM.fmtArea(Math.PI * r * r));
        return;
      }
      if (g.type === "LineString" || g.type === "Polygon") {
        const coords = g.type === "LineString" ? g.coordinates : g.coordinates[0];
        const segs = SM.geo.segments(coords);
        const pxMin = 46; // skip labels on segments too short on screen
        if (segs.length <= 80 && k !== "freehand") {
          for (let i = 1; i < coords.length; i++) {
            const a = SM.map.latLngToLayerPoint(ll(coords[i - 1])), b = SM.map.latLngToLayerPoint(ll(coords[i]));
            if (a.distanceTo(b) < pxMin) continue;
            add(SM.map.layerPointToLatLng(a.add(b).divideBy(2)), SM.fmtLength(segs[i - 1]));
          }
        }
        if (g.type === "LineString") {
          const tot = segs.reduce((s, x) => s + x, 0);
          if (segs.length > 1 || k === "freehand") { const last = coords[coords.length - 1]; add([last[1], last[0]], "Σ " + SM.fmtLength(tot)); }
        } else {
          const c = e.layer.getBounds().getCenter();
          add(c, SM.fmtArea(SM.geo.polygonArea(g.coordinates)));
        }
      }
    });
  };
})(window.SM);
