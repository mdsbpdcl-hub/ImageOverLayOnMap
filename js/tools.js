/* =====================================================================
   tools.js — drawing & interaction tools
   select / move / edit / freehand / polyline / polygon / rectangle /
   circle / marker / text / arrow / measure / measure-area / delete
   ===================================================================== */
"use strict";
(function (SM) {
  const T = { current: "select" };
  SM.tools = T;

  const DRAW_SHAPES = { polyline: "Line", arrow: "Line", polygon: "Polygon", rectangle: "Rectangle", circle: "Circle" };
  const LABELS = { select: "Select", move: "Move", edit: "Edit vertices", freehand: "Freehand", polyline: "Polyline", polygon: "Polygon", rectangle: "Rectangle", circle: "Circle", marker: "Marker", text: "Text", arrow: "Arrow", measure: "Measure distance", "measure-area": "Measure area", delete: "Delete", area: "Select area" };
  const HINTS = {
    select: null, move: null, edit: null,
    freehand: "Press and drag to draw · release to finish",
    polyline: "Click to add points · double-click or Finish to end",
    arrow: "Click to add points · double-click or Finish to end (arrow at last point)",
    polygon: "Click to add corners · click the first point, double-click or Finish to close",
    rectangle: "Click one corner, then the opposite corner",
    circle: "Click the centre, then click to set the radius — or type a radius and click once",
    marker: "Click on the map to place a marker",
    text: "Click on the map to place a text label",
    measure: "Click points to measure · double-click to finish",
    "measure-area": "Click corners to measure area · double-click to finish",
    delete: "Click objects to delete them",
  };

  T.init = function () {
    const map = SM.map;
    map.pm.setGlobalOptions({ snappable: SM.settings.snapping, snapDistance: SM.settings.snapDistance, allowSelfIntersection: true, removeVertexOn: "contextmenu" });
    map.pm.setLang("en");
    SM.bus.on("settings", () => map.pm.setGlobalOptions({ snappable: SM.settings.snapping, snapDistance: SM.settings.snapDistance, allowSelfIntersection: true, removeVertexOn: "contextmenu" }));

    SM.$$("#toolbar button[data-tool]").forEach((b) => b.addEventListener("click", () => T.set(b.dataset.tool)));
    SM.$("#hint-cancel").addEventListener("click", () => T.cancel());
    SM.$("#hint-finish").addEventListener("click", () => T.finish());
    SM.$("#hint-undo").addEventListener("click", () => T.undoPoint());

    map.on("pm:create", onCreate);
    map.on("click", onMapClick);
    map.on("pm:vertexadded", () => setTimeout(updateHintButtons, 0));
    initFreehand();
    initBoxSelect();
    initMeasure();
    T.set("select");
  };

  /* ---------------- switching ---------------- */
  T.set = function (tool) {
    if (!LABELS[tool]) return;
    if (SM.overlays && SM.overlays.aligning()) SM.overlays.endAlign(false);
    const map = SM.map;
    if (map.pm.globalDrawModeEnabled()) map.pm.disableDraw();
    if (T.current.startsWith("measure") && tool !== T.current) measure.clear();
    T.current = tool;
    SM.$$("#toolbar button[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
    const c = map.getContainer();
    c.classList.toggle("tool-draw", ["polyline", "polygon", "rectangle", "circle", "marker", "text", "arrow", "measure", "measure-area"].includes(tool));
    c.classList.toggle("tool-freehand", tool === "freehand");
    c.classList.toggle("tool-delete", tool === "delete");
    c.classList.toggle("tool-area", tool === "area");
    if (tool === "freehand" || tool === "area") map.dragging.disable(); else map.dragging.enable();
    const drawing = !!DRAW_SHAPES[tool] || tool.startsWith("measure");
    if (drawing) map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();

    if (DRAW_SHAPES[tool]) startGeomanDraw(tool);
    if (tool.startsWith("measure")) measure.start(tool === "measure-area" ? "area" : "line");
    showHint(tool);
    SM.$("#st-tool").textContent = "Tool: " + LABELS[tool];
    SM.bus.emit("tool", tool);
  };
  T.cancel = function () {
    if (SM.overlays.aligning()) { SM.overlays.endAlign(false); return; }
    if (SM.map.pm.globalDrawModeEnabled()) SM.map.pm.disableDraw();
    if (T.current.startsWith("measure")) measure.clear();
    T.set("select");
  };

  function activeDraw() {
    const shape = DRAW_SHAPES[T.current];
    return shape ? SM.map.pm.Draw[shape] : null;
  }
  T.finish = function () {
    if (SM.overlays.aligning()) { SM.overlays.endAlign(true); return; }
    if (T.current.startsWith("measure")) { measure.finish(); return; }
    const d = activeDraw();
    if (d && d._finishShape && d._layer && d._layer.getLatLngs) {
      const n = d._layer.getLatLngs().length;
      if ((T.current === "polygon" && n < 3) || n < 2) { SM.toast("Add more points first"); return; }
      d._finishShape();
    } else T.set("select");
  };
  T.undoPoint = function () {
    if (SM.overlays.aligning()) { SM.overlays.alignUndo(); return; }
    if (T.current.startsWith("measure")) { measure.undo(); return; }
    const d = activeDraw();
    if (d && d._removeLastVertex) d._removeLastVertex();
    updateHintButtons();
  };

  function showHint(tool) {
    const bar = SM.$("#hintbar"), text = HINTS[tool];
    bar.classList.toggle("hidden", !text);
    if (!text) return;
    SM.$("#hint-text").textContent = text;
    const extra = SM.$("#hint-extra");
    extra.innerHTML = "";
    if (tool === "circle") {
      const inp = SM.el("input", { type: "number", min: 0, step: "any", placeholder: "radius m", id: "circle-radius", title: "Fixed radius in metres (optional)" });
      extra.append(inp);
    }
    const multi = ["polyline", "polygon", "arrow", "measure", "measure-area"].includes(tool);
    SM.$("#hint-undo").classList.toggle("hidden", !multi);
    SM.$("#hint-finish").classList.toggle("hidden", !multi);
  }
  function updateHintButtons() { /* reserved for state-dependent hint buttons */ }

  /* ---------------- Geoman drawing ---------------- */
  function startGeomanDraw(tool) {
    const st = SM.store.defaultStyle(tool);
    const path = { color: st.color, weight: st.weight, opacity: st.opacity, fillColor: st.fillColor, fillOpacity: st.fill ? st.fillOpacity : 0 };
    SM.map.pm.enableDraw(DRAW_SHAPES[tool], {
      snappable: SM.settings.snapping, snapDistance: SM.settings.snapDistance,
      allowSelfIntersection: true, finishOn: tool === "rectangle" || tool === "circle" ? null : "dblclick",
      templineStyle: { color: st.color, weight: st.weight }, hintlineStyle: { color: st.color, dashArray: [6, 6], weight: 2 },
      pathOptions: path, tooltips: true, continueDrawing: false, markerStyle: { draggable: false },
    });
  }

  function onCreate(e) {
    const tool = T.current;
    const layer = e.layer;
    SM.map.removeLayer(layer);
    const kind = tool === "arrow" ? "arrow" : ({ Line: "polyline", Polygon: "polygon", Rectangle: "rectangle", Circle: "circle" })[e.shape];
    if (!kind) return;
    const g = SM.render.geomFromLayer(layer, kind);
    if (!g) return;
    if (kind === "polygon" && window.turf) {
      try { if (turf.kinks(turf.polygon(g.geometry.coordinates)).features.length) SM.toast("Note: this polygon crosses itself — area may be unexpected; KML export repairs it automatically", "", 4500); } catch (err) { /* ignore */ }
    }
    if (kind === "circle" && !(g.radius > 0)) return;
    const f = SM.store.addFeature(g.geometry, kind, g.radius !== undefined ? { radius: g.radius } : undefined);
    afterCreate(f, tool);
  }

  function afterCreate(f, tool) {
    if (SM.settings.keepTool) {
      SM.store.select(f.properties.id);
      if (DRAW_SHAPES[tool]) setTimeout(() => startGeomanDraw(tool), 0);
      SM.tools.current = tool;
    } else {
      T.set("select");
      SM.store.select(f.properties.id);
    }
    if (f.properties.kind === "text") SM.bus.emit("focus-text");
  }

  /* ---------------- clicks ---------------- */
  function onMapClick(e) {
    if (SM.overlays.alignClick(e)) return;
    const tool = T.current;
    const ll = e.latlng;
    if (tool === "marker" || tool === "text") {
      const f = SM.store.addFeature({ type: "Point", coordinates: [SM.mapview.wrapLng(ll.lng), ll.lat] }, tool);
      afterCreate(f, tool);
      return;
    }
    if (tool === "circle") {
      const r = parseFloat((SM.$("#circle-radius") || {}).value);
      if (r > 0) {
        SM.map.pm.disableDraw();
        const f = SM.store.addFeature({ type: "Point", coordinates: [SM.mapview.wrapLng(ll.lng), ll.lat] }, "circle", { radius: r });
        afterCreate(f, "circle");
      }
      return;
    }
    if (["select", "move", "edit", "delete"].includes(tool) && !e.originalEvent.shiftKey) SM.store.clearSelection();
  }

  T.onFeatureClick = function (id, e) {
    const tool = T.current;
    const oe = e.originalEvent || {};
    if (tool === "delete") {
      const ids = SM.state.selection.has(id) ? [...SM.state.selection] : [id];
      const n = SM.store.deleteFeatures(ids);
      if (n) SM.toast(n + " object" + (n > 1 ? "s" : "") + " deleted (Ctrl+Z to undo)", "", 2200);
      return;
    }
    if (DRAW_SHAPES[tool] || tool === "freehand" || tool.startsWith("measure") || tool === "marker" || tool === "text") return;
    if (oe.shiftKey || oe.ctrlKey || oe.metaKey) SM.store.select(id, "toggle");
    else if (!(SM.state.selection.has(id) && SM.state.selection.size > 1 && T.current !== "edit")) SM.store.select(id);
    SM.bus.emit("open-props");
  };

  /* ---------------- freehand pen ---------------- */
  function initFreehand() {
    const wrap = SM.$("#map-wrap"), map = SM.map;
    let pts = null, preview = null, pointerId = null;
    const lineStyle = () => { const s = SM.store.defaultStyle("freehand"); return { color: s.color, weight: s.weight, opacity: s.opacity, interactive: false, pmIgnore: true }; };
    wrap.addEventListener("pointerdown", (ev) => {
      if (T.current !== "freehand" || ev.button > 0) return;
      if (!ev.target.closest("#map") || ev.target.closest(".leaflet-control")) return;
      if (pts) { cancel(); return; } // second finger: abort stroke (allows pinch)
      ev.preventDefault();
      pointerId = ev.pointerId;
      try { wrap.setPointerCapture(pointerId); } catch (e) { /* ignore */ }
      pts = [map.mouseEventToLatLng(ev)];
      preview = L.polyline(pts, lineStyle()).addTo(map);
    }, true);
    wrap.addEventListener("pointermove", (ev) => {
      if (!pts || ev.pointerId !== pointerId) return;
      const llNew = map.mouseEventToLatLng(ev);
      const a = map.latLngToContainerPoint(pts[pts.length - 1]), b = map.latLngToContainerPoint(llNew);
      if (a.distanceTo(b) < 2) return;
      pts.push(llNew);
      preview.addLatLng(llNew);
    }, true);
    const end = (ev) => {
      if (!pts || (ev && ev.pointerId !== pointerId)) return;
      const raw = pts;
      cancel();
      if (raw.length < 2) return;
      const simplified = simplifyPx(raw, 1.2);
      if (simplified.length < 2) return;
      const f = SM.store.addFeature({ type: "LineString", coordinates: simplified.map((p) => [SM.mapview.wrapLng(p.lng), p.lat]) }, "freehand");
      if (SM.settings.keepTool) SM.store.select(f.properties.id); else afterCreate(f, "freehand");
    };
    function cancel() {
      if (preview) map.removeLayer(preview);
      preview = null; pts = null;
      try { if (pointerId !== null) wrap.releasePointerCapture(pointerId); } catch (e) { /* ignore */ }
      pointerId = null;
    }
    wrap.addEventListener("pointerup", end, true);
    wrap.addEventListener("pointercancel", () => cancel(), true);
  }
  /** Douglas–Peucker in screen pixels: removes jitter but keeps the drawn shape. */
  function simplifyPx(latlngs, tol) {
    const pts = latlngs.map((p) => SM.map.latLngToLayerPoint(p));
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [s, e] = stack.pop();
      let maxD = 0, idx = -1;
      for (let i = s + 1; i < e; i++) { const d = L.LineUtil.pointToSegmentDistance(pts[i], pts[s], pts[e]); if (d > maxD) { maxD = d; idx = i; } }
      if (maxD > tol && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
    }
    return latlngs.filter((_, i) => keep[i]);
  }

  /* ---------------- shift + drag box selection ---------------- */
  function initBoxSelect() {
    const wrap = SM.$("#map-wrap"), map = SM.map;
    let start = null, box = null;
    wrap.addEventListener("mousedown", (ev) => {
      if (!ev.shiftKey || !["select", "move", "edit"].includes(T.current)) return;
      if (!ev.target.closest("#map") || ev.target.closest(".leaflet-interactive,.leaflet-control,.leaflet-marker-icon")) return;
      ev.stopPropagation(); ev.preventDefault();
      start = map.mouseEventToContainerPoint(ev);
      box = SM.el("div", { class: "sm-select-box" });
      SM.$("#map").appendChild(box);
      const move = (e2) => {
        const p = map.mouseEventToContainerPoint(e2);
        Object.assign(box.style, { left: Math.min(p.x, start.x) + "px", top: Math.min(p.y, start.y) + "px", width: Math.abs(p.x - start.x) + "px", height: Math.abs(p.y - start.y) + "px" });
      };
      const up = (e2) => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        const p = map.mouseEventToContainerPoint(e2);
        box.remove(); box = null;
        if (p.distanceTo(start) < 4) return;
        const bounds = L.latLngBounds(map.containerPointToLatLng(start), map.containerPointToLatLng(p));
        const ids = SM.store.features().filter((f) => SM.store.isVisible(f)).filter((f) => {
          const fb = SM.mapview.boundsOf([f]);
          return fb && bounds.intersects(fb);
        }).map((f) => f.properties.id);
        SM.store.select(ids, "add");
        if (ids.length) SM.toast(ids.length + " object(s) selected", "", 1500);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    }, true);
  }

  /* ---------------- measurement tool ---------------- */
  const measure = {};
  function initMeasure() {
    const map = SM.map;
    const grp = L.layerGroup().addTo(map);
    let mode = "line", pts = [], line = null, hover = null, done = false;
    const box = SM.$("#measure-box");
    const style = { color: "#00e5ff", weight: 3, dashArray: "8 6", interactive: false, pmIgnore: true, fillColor: "#00e5ff", fillOpacity: 0.15 };

    measure.start = (m) => { measure.clear(); mode = m; box.classList.remove("hidden"); render(); };
    measure.clear = () => { grp.clearLayers(); pts = []; line = null; hover = null; done = false; box.classList.add("hidden"); };
    measure.undo = () => { if (done) done = false; pts.pop(); redraw(); };
    measure.finish = () => {
      if (pts.length < (mode === "area" ? 3 : 2)) { SM.toast("Add more points first"); return; }
      done = true; hover = null; redraw(); refine();
    };

    map.on("click", (e) => {
      if (!T.current.startsWith("measure")) return;
      if (done) { pts = []; done = false; }
      pts.push(e.latlng); redraw();
    });
    map.on("mousemove", (e) => { if (T.current.startsWith("measure") && !done && pts.length) { hover = e.latlng; redraw(); } });
    map.on("dblclick", (e) => {
      if (!T.current.startsWith("measure")) return;
      L.DomEvent.stop(e);
      // a double-click also produced two clicks: drop the duplicate vertex
      if (pts.length >= 2 && map.latLngToContainerPoint(pts[pts.length - 1]).distanceTo(map.latLngToContainerPoint(pts[pts.length - 2])) < 6) pts.pop();
      measure.finish();
    });

    function coords(withHover) {
      const arr = pts.map((p) => [p.lng, p.lat]);
      if (withHover && hover) arr.push([hover.lng, hover.lat]);
      return arr;
    }
    function redraw() {
      grp.clearLayers();
      const c = coords(true);
      const lls = c.map((x) => [x[1], x[0]]);
      if (lls.length >= 2) {
        line = mode === "area" && lls.length >= 3 ? L.polygon(lls, style) : L.polyline(lls, style);
        grp.addLayer(line);
      }
      pts.forEach((p) => grp.addLayer(L.circleMarker(p, { radius: 4, color: "#00e5ff", fillColor: "#fff", fillOpacity: 1, weight: 2, interactive: false, pmIgnore: true })));
      render();
    }
    let lastExact = null;
    SM.bus.on("settings", () => { if (!box.classList.contains("hidden")) render(lastExact); });
    // two handy alternatives to the chosen unit
    const altLen = () => (SM.imperialLengths() ? ["m", "km"] : ["ft", "yd"]);
    const altArea = () => ["ha", "acre", "decimal", "m2", "ft2"].filter((u) => u !== SM.settings.areaUnit).slice(0, 3);
    function render(exact) {
      lastExact = exact || null;
      const c = coords(!done);
      const segs = SM.geo.segments(c);
      const total = segs.reduce((s, x) => s + x, 0);
      let html = `<div class="mrow"><span>${mode === "area" ? "Area measurement" : "Distance"}</span><span class="muted">${pts.length} pts</span></div>`;
      if (mode === "line") {
        html += `<div><b>${SM.fmtLength(exact ? exact.length_m : total)}</b></div>`;
        html += `<div class="mrow muted">${altLen().map((u) => `<span>${SM.fmtLength(exact ? exact.length_m : total, u)}</span>`).join("")}</div>`;
        if (segs.length) html += `<div class="muted">Last segment: ${SM.fmtLength(segs[segs.length - 1])}</div>`;
      } else {
        const ring = c.length >= 3 ? [...c, c[0]] : null;
        const area = exact ? exact.area_m2 : ring ? SM.geo.polygonArea([ring]) : 0;
        const per = exact ? exact.perimeter_m : ring ? SM.geo.lineLength(ring) : total;
        html += `<div><b>${SM.fmtArea(area)}</b></div>`;
        html += `<div class="mrow muted">${altArea().map((u) => `<span>${SM.fmtArea(area, u)}</span>`).join("")}</div>`;
        html += `<div class="muted">Perimeter: ${SM.fmtLength(per)}</div>`;
      }
      if (exact) html += `<div class="muted" style="font-size:11px">WGS84 ellipsoid (geodesic)</div>`;
      html += `<div class="mactions">${done ? `<button class="mini-btn primary" id="m-save">Save as ${mode === "area" ? "polygon" : "line"}</button>` : ""}<button class="mini-btn" id="m-clear">Clear</button></div>`;
      box.innerHTML = html;
      box.querySelector(".mrow").append(SM.el("span", { class: "unit-pickers" }, mode === "area" ? SM.unitSelect("area") : SM.unitSelect("length")));
      const sv = SM.$("#m-save");
      if (sv) sv.onclick = () => {
        const cc = coords(false);
        const geom = mode === "area" ? { type: "Polygon", coordinates: [[...cc, cc[0]]] } : { type: "LineString", coordinates: cc };
        const f = SM.store.addFeature(geom, mode === "area" ? "polygon" : "polyline", { name: mode === "area" ? "Measured area" : "Measured line" });
        measure.clear(); T.set("select"); SM.store.select(f.properties.id);
      };
      SM.$("#m-clear").onclick = () => { measure.clear(); box.classList.remove("hidden"); render(); };
    }
    async function refine() {
      const cc = coords(false);
      const geom = mode === "area" ? { type: "Polygon", coordinates: [[...cc, cc[0]]] } : { type: "LineString", coordinates: cc };
      render();
      try {
        const r = await SM.api.measure([{ type: "Feature", geometry: geom, properties: { kind: mode === "area" ? "polygon" : "polyline" } }]);
        if (done && r[0] && !r[0].error) render(r[0]);
      } catch (e) { /* offline: browser values stay */ }
    }
  }
})(window.SM);
