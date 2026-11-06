/* =====================================================================
   props.js — right sidebar: properties of the selected object(s):
   name, description, layer, styling, labels, measurements, coordinates
   and editing actions. Changes apply to the map immediately.
   ===================================================================== */
"use strict";
(function (SM) {
  const PR = {};
  SM.props = PR;
  const root = () => SM.$("#props");
  const AREA = ["polygon", "rectangle", "circle"], LINE = ["polyline", "freehand", "arrow"];

  PR.init = function () {
    SM.bus.on("selection", () => PR.render());
    SM.bus.on("change", SM.debounce((ev) => {
      if (ev && ev.source === "props") { refreshMeasurements(); return; }
      const focused = document.activeElement && root().contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
      if (focused) refreshMeasurements(); else PR.render();
    }, 120));
    SM.bus.on("focus-text", () => setTimeout(() => { const t = SM.$("#prop-label-text"); if (t) { t.focus(); t.select(); } }, 60));
    SM.bus.on("open-props", () => { const rp = SM.$("#right-panel"); if (window.innerWidth <= 760) rp.classList.add("mobile-open"); });
    SM.bus.on("settings", () => PR.render());
    SM.bus.on("align", () => PR.render());
    SM.bus.on("overlay-moved", SM.debounce(() => PR.render(), 150));
  };

  /* ---------------- control builders ---------------- */
  const row = (label, ...ctrls) => SM.el("div", { class: "prow" }, SM.el("label", { text: label }), SM.el("div", { class: "ctrl" }, ...ctrls));
  function color(value, on) {
    const i = SM.el("input", { type: "color", value: value || "#000000" });
    i.addEventListener("input", () => on(i.value));
    return i;
  }
  function range(min, max, step, value, on, fmt) {
    const i = SM.el("input", { type: "range", min, max, step, value });
    const v = SM.el("span", { class: "val", text: fmt ? fmt(value) : value });
    i.addEventListener("input", () => { v.textContent = fmt ? fmt(+i.value) : i.value; on(+i.value); });
    return [i, v];
  }
  function seg(options, value, on) {
    const box = SM.el("div", { class: "seg" });
    options.forEach(([val, label, title]) => {
      const b = SM.el("button", { class: val === value ? "on" : "", text: label, title: title || "" });
      b.addEventListener("click", () => { SM.$$("button", box).forEach((x) => x.classList.remove("on")); b.classList.add("on"); on(val); });
      box.append(b);
    });
    return box;
  }
  function check(label, value, on) {
    const i = SM.el("input", { type: "checkbox" });
    i.checked = !!value;
    i.addEventListener("change", () => on(i.checked));
    return SM.el("label", { class: "check" }, i, label);
  }
  function text(value, on, attrs) {
    const i = SM.el("input", Object.assign({ type: "text", value: value || "" }, attrs || {}));
    i.addEventListener("input", () => on(i.value));
    return i;
  }
  function btn(icon, label, fn, cls) {
    const b = SM.el("button", { class: "mini-btn " + (cls || "") }, icon ? SM.icon(icon) : null, label);
    b.addEventListener("click", fn);
    return b;
  }
  const group = (title, ...kids) => SM.el("div", { class: "pgroup" }, SM.el("h4", {}, ...(Array.isArray(title) ? title : [title])), ...kids);
  const pct = (v) => Math.round(v * 100) + "%";

  /** Apply a change to the given features (one undo step per control burst). */
  function upd(ids, key, fn) {
    SM.store.updateMany(ids, fn, { coalesce: "props:" + key + ":" + ids.join(","), source: "props" });
  }

  /* ---------------- main render ---------------- */
  PR.render = function () {
    const el = root();
    if (!el || !SM.state.project) return;
    el.innerHTML = "";
    if (SM.state.overlaySel && SM.overlays.renderProps(el)) return;
    const sel = SM.store.selected();
    if (!sel.length) return renderNothing(el);
    if (sel.length === 1) return renderSingle(el, sel[0]);
    return renderMulti(el, sel);
  };

  function renderNothing(el) {
    const ds = SM.settings.defaultStyle;
    const save = () => SM.saveSettings();
    el.append(group("Project",
      SM.el("div", { class: "meas" },
        mline("Layers", SM.store.layers().length),
        mline("Objects", SM.store.features().length),
        mline("Base map", (SM.mapview.currentBasemap() || {}).name || "—"))),
      group("Default style for new objects",
        row("Line colour", color(ds.color, (v) => { ds.color = v; save(); })),
        row("Fill colour", color(ds.fillColor, (v) => { ds.fillColor = v; save(); })),
        row("Width", ...range(1, 16, 0.5, ds.weight, (v) => { ds.weight = v; save(); })),
        row("Fill opacity", ...range(0, 1, 0.05, ds.fillOpacity, (v) => { ds.fillOpacity = v; save(); }, pct))),
      group("Quick help", SM.el("div", { class: "tips", html: `
        <ul>
          <li>Pick a tool on the left toolbar and draw on the map.</li>
          <li>Click an object to select it; drag it to move, drag its white handles to reshape.</li>
          <li>Click a small midpoint handle to insert a vertex, right-click a vertex to delete it.</li>
          <li><kbd>Shift</kbd>+click or <kbd>Shift</kbd>+drag to select several objects.</li>
          <li><kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd> undo / redo, <kbd>Del</kbd> deletes, <kbd>Ctrl</kbd>+<kbd>D</kbd> duplicates, <kbd>Esc</kbd> cancels.</li>
          <li><b>Pictures, site plans, AutoCAD and Shapefiles:</b> click <b>Add</b> under “Pictures &amp; plans”, drag files onto the map, or paste a screenshot with <kbd>Ctrl</kbd>+<kbd>V</kbd>.</li>
          <li>Tools: <kbd>V</kbd> select <kbd>G</kbd> move <kbd>E</kbd> edit <kbd>F</kbd> pen <kbd>L</kbd> line <kbd>P</kbd> polygon <kbd>R</kbd> rectangle <kbd>C</kbd> circle <kbd>M</kbd> marker <kbd>T</kbd> text <kbd>A</kbd> arrow <kbd>D</kbd> measure.</li>
        </ul>` })));
  }

  function renderSingle(el, f) {
    const p = f.properties, ids = [p.id], kind = p.kind, editable = SM.store.isEditable(f);
    const layerSel = layerSelect(ids, p.layerId);

    // --- identity ---
    const desc = SM.el("textarea", { rows: 2, placeholder: "Description (exported to KML)" });
    desc.value = p.description || "";
    desc.addEventListener("input", () => upd(ids, "desc", (x) => { x.properties.description = desc.value; }));
    el.append(group([SM.el("span", { text: "Object" }), SM.el("span", { class: "kind-badge", text: SM.KIND_NAMES[kind] })],
      kind !== "text" ? row("Name", text(p.name, (v) => upd(ids, "name", (x) => { x.properties.name = v; }), { placeholder: "Name" })) : null,
      row("Description", desc),
      row("Layer", layerSel),
      !editable ? SM.el("div", { class: "warn-box", text: p.locked ? "This object is locked. Unlock it to move or edit it." : "Its layer is locked. Unlock the layer to edit." }) : null));

    // --- style ---
    if (kind === "marker") {
      el.append(group("Marker", row("Colour", color(p.style.color, (v) => upd(ids, "color", (x) => { x.properties.style.color = v; })))));
    } else if (kind !== "text") {
      const st = p.style, isArea = AREA.includes(kind);
      el.append(group(isArea ? "Border" : "Line",
        row("Colour", color(st.color, (v) => upd(ids, "color", (x) => { x.properties.style.color = v; }))),
        row("Width", ...range(isArea ? 0 : 0.5, 20, 0.5, st.weight, (v) => upd(ids, "weight", (x) => { x.properties.style.weight = v; }), (v) => v + " px")),
        row("Opacity", ...range(0, 1, 0.05, st.opacity, (v) => upd(ids, "opacity", (x) => { x.properties.style.opacity = v; }), pct)),
        row("Pattern", seg([["solid", "Solid"], ["dashed", "Dashed"], ["dotted", "Dotted"]], st.dash, (v) => upd(ids, "dash", (x) => { x.properties.style.dash = v; }))),
        LINE.includes(kind) && kind !== "arrow" ? row("", check("Arrow at end", st.arrow, (v) => upd(ids, "arrow", (x) => { x.properties.style.arrow = v; }))) : null));
      if (isArea) {
        el.append(group("Fill",
          row("", check("Fill shape", st.fill, (v) => upd(ids, "fill", (x) => { x.properties.style.fill = v; }))),
          row("Colour", color(st.fillColor, (v) => upd(ids, "fillColor", (x) => { x.properties.style.fillColor = v; x.properties.style.fill = true; }))),
          row("Opacity", ...range(0, 1, 0.05, st.fillOpacity, (v) => upd(ids, "fillOpacity", (x) => { x.properties.style.fillOpacity = v; x.properties.style.fill = v > 0; }), pct))));
      }
      if (kind === "circle") {
        const r = SM.el("input", { type: "number", min: 0.01, step: "any", value: +p.radius.toFixed(3), disabled: !editable });
        r.addEventListener("change", () => { const v = parseFloat(r.value); if (v > 0) upd(ids, "radius", (x) => { x.properties.radius = v; }); });
        el.append(group("Circle", row("Radius (m)", r)));
      }
    }

    // --- label ---
    el.append(labelGroup(f, ids));
    // --- measurements ---
    el.append(SM.el("div", { class: "pgroup", id: "meas-group" }));
    refreshMeasurements();
    // --- coordinates ---
    el.append(coordsGroup(f, editable));
    // --- actions ---
    el.append(actionsGroup([f]));
  }

  function labelGroup(f, ids) {
    const p = f.properties, lab = p.label, isText = p.kind === "text";
    const L_ = (key, fn) => upd(ids, "label-" + key, (x) => fn(x.properties.label));
    let textCtrl;
    if (isText) {
      textCtrl = SM.el("textarea", { id: "prop-label-text", rows: 2 });
      textCtrl.value = lab.text || "";
      textCtrl.addEventListener("input", () => L_("text", (l) => { l.text = textCtrl.value; }));
    } else {
      textCtrl = text(lab.text, (v) => L_("text", (l) => { l.text = v; }), { placeholder: "(uses the name)", id: "prop-label-text" });
    }
    const off = lab.offset || [0, 0];
    const ox = SM.el("input", { type: "number", step: 1, value: off[0], title: "Horizontal offset (px)" });
    const oy = SM.el("input", { type: "number", step: 1, value: off[1], title: "Vertical offset (px)" });
    const setOff = () => L_("offset", (l) => { l.offset = [parseFloat(ox.value) || 0, parseFloat(oy.value) || 0]; });
    ox.addEventListener("change", setOff); oy.addEventListener("change", setOff);
    return group(isText ? "Text" : "Label",
      !isText ? row("", check("Show label on map", lab.show, (v) => L_("show", (l) => { l.show = v; if (v && !l.text && !p.name) l.text = SM.KIND_NAMES[p.kind]; }))) : null,
      row(isText ? "Text" : "Text", textCtrl),
      row("Size", ...range(8, 72, 1, lab.size, (v) => L_("size", (l) => { l.size = v; }), (v) => v + " px")),
      row("Colour", color(lab.color, (v) => L_("color", (l) => { l.color = v; })), check("Halo", lab.halo, (v) => L_("halo", (l) => { l.halo = v; }))),
      row("Style", check("Bold", lab.bold, (v) => L_("bold", (l) => { l.bold = v; })), check("Italic", lab.italic, (v) => L_("italic", (l) => { l.italic = v; }))),
      row("Align", seg([["left", "Left"], ["center", "Centre"], ["right", "Right"]], lab.align, (v) => L_("align", (l) => { l.align = v; }))),
      row("Offset x/y", ox, oy));
  }

  function layerSelect(ids, current) {
    const s = SM.el("select");
    [...SM.store.layers()].reverse().forEach((l) => s.append(SM.el("option", { value: l.id, text: l.name + (l.locked ? " (locked)" : ""), selected: l.id === current })));
    if (!current) s.prepend(SM.el("option", { value: "", text: "— mixed —", selected: true }));
    s.addEventListener("change", () => { if (s.value) SM.store.updateMany(ids, (x) => { x.properties.layerId = s.value; }, { source: "props-layer" }); });
    return s;
  }

  /* ---------------- measurements ---------------- */
  const mline = (k, v) => SM.el("div", { class: "mline" }, SM.el("span", { text: k }), SM.el("span", { text: v }));
  let measureSeq = 0;
  const refineMeasure = SM.debounce(async (f, seq) => {
    try {
      const r = await SM.api.measure([f]);
      if (seq === measureSeq && r[0] && !r[0].error) fillMeasurements(f, r[0], true);
    } catch (e) { /* offline — browser values remain */ }
  }, 350);
  function refreshMeasurements() {
    const box = SM.$("#meas-group");
    const sel = SM.store.selected();
    if (!box || sel.length !== 1) return;
    const f = sel[0];
    fillMeasurements(f, SM.geo.measureFeature(f), false);
    if (f.geometry.type !== "Point" || f.properties.kind === "circle") refineMeasure(SM.clone(f), ++measureSeq);
  }
  function fillMeasurements(f, m, exact) {
    const box = SM.$("#meas-group");
    if (!box) return;
    box.innerHTML = "";
    box.append(SM.el("h4", { text: "Measurements" }));
    const wrap = SM.el("div", { class: "meas" });
    if (m.length_m !== undefined) {
      wrap.append(mline("Length", SM.fmtLength(m.length_m, "m")), mline("", SM.fmtLength(m.length_m, "km")), mline("", SM.fmtLength(m.length_m, "ft")));
    }
    if (m.radius_m !== undefined) wrap.append(mline("Radius", SM.fmtLength(m.radius_m)), mline("Diameter", SM.fmtLength(m.radius_m * 2)));
    if (m.area_m2 !== undefined) {
      wrap.append(mline("Area", SM.fmtArea(m.area_m2, "m2")), mline("", SM.fmtArea(m.area_m2, "ha")), mline("", SM.fmtArea(m.area_m2, "acre")), mline("", SM.fmtArea(m.area_m2, "km2")));
      if (m.perimeter_m !== undefined) wrap.append(mline("Perimeter", SM.fmtLength(m.perimeter_m)));
    }
    if (m.center) wrap.append(mline(f.properties.kind === "circle" ? "Centre" : "Position", SM.fmtLatLng(m.center[1], m.center[0], "dd")));
    if (m.segments_m && m.segments_m.length > 1 && f.properties.kind !== "freehand") {
      const list = SM.el("div", { class: "seg-list" });
      m.segments_m.forEach((d, i) => list.append(SM.el("div", { text: `Segment ${i + 1}: ${SM.fmtLength(d)}` })));
      wrap.append(SM.el("div", { class: "mline" }, SM.el("span", { text: "Segments" }), SM.el("span", { text: m.segments_m.length })), list);
    }
    wrap.append(SM.el("div", { class: "note", text: "Geodesic on the WGS84 ellipsoid" }));
    box.append(wrap);
  }

  /* ---------------- coordinates ---------------- */
  function coordsGroup(f, editable) {
    const g = f.geometry, p = f.properties, ids = [p.id];
    const box = SM.el("div", { class: "coords-wrap" });
    const setGeom = (fn) => SM.store.updateFeature(p.id, (x) => fn(x.geometry), { source: "coords" });
    const num = (v, onchange) => {
      const i = SM.el("input", { type: "number", step: "any", value: (+v).toFixed(7), disabled: !editable });
      i.addEventListener("change", () => { const n = parseFloat(i.value); if (isFinite(n)) onchange(n); else i.value = (+v).toFixed(7); });
      return i;
    };
    const valid = (lat, lng) => Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    if (g.type === "Point") {
      const [lng, lat] = g.coordinates;
      box.append(row("Latitude", num(lat, (v) => { if (valid(v, lng)) setGeom((G) => { G.coordinates[1] = v; }); else SM.toast("Latitude must be −90…90", "error"); })),
        row("Longitude", num(lng, (v) => { if (valid(lat, v)) setGeom((G) => { G.coordinates[0] = v; }); else SM.toast("Longitude must be −180…180", "error"); })),
        row("Paste", text("", () => {}, { placeholder: "lat, lng or DMS — press Enter", onkeydown: (e) => {
          if (e.key !== "Enter") return;
          const ll = SM.parseLatLng(e.target.value);
          if (!ll) { SM.toast("Could not read that coordinate", "error"); return; }
          setGeom((G) => { G.coordinates = [ll.lng, ll.lat]; });
        } })));
      return group("Coordinates (WGS84)", box);
    }
    const ring = g.type === "Polygon";
    const coords = ring ? g.coordinates[0].slice(0, -1) : g.coordinates;
    if (coords.length > 300) {
      box.append(SM.el("div", { class: "muted", text: `${coords.length} vertices — too many to list. Use the Edit tool on the map, or export to GeoJSON/KML for a full list.` }));
      return group("Coordinates (WGS84)", box);
    }
    const tbl = SM.el("table", { class: "coords-table" });
    tbl.append(SM.el("tr", {}, SM.el("td", { text: "#" }), SM.el("td", { class: "muted", text: "Latitude" }), SM.el("td", { class: "muted", text: "Longitude" }), SM.el("td")));
    coords.forEach((c, i) => {
      const setV = (axis, v) => {
        const lat = axis === 1 ? v : c[1], lng = axis === 0 ? v : c[0];
        if (!valid(lat, lng)) { SM.toast("Latitude −90…90, longitude −180…180", "error"); return; }
        setGeom((G) => {
          if (ring) { G.coordinates[0][i][axis] = v; if (i === 0) G.coordinates[0][G.coordinates[0].length - 1][axis] = v; }
          else G.coordinates[i][axis] = v;
        });
      };
      const min = ring ? (p.kind === "rectangle" ? 99 : 3) : 2;
      const del = SM.el("button", { class: "ib", title: "Delete vertex", disabled: !editable || coords.length <= min }, SM.icon("x"));
      del.addEventListener("click", () => setGeom((G) => {
        if (ring) { const r = G.coordinates[0].slice(0, -1); r.splice(i, 1); r.push(r[0].slice()); G.coordinates[0] = r; }
        else G.coordinates.splice(i, 1);
      }));
      tbl.append(SM.el("tr", {}, SM.el("td", { text: i + 1 }), SM.el("td", {}, num(c[1], (v) => setV(1, v))), SM.el("td", {}, num(c[0], (v) => setV(0, v))), SM.el("td", {}, p.kind === "rectangle" ? null : del)));
    });
    box.append(tbl);
    const note = p.kind === "rectangle" ? SM.el("div", { class: "muted", text: "Rectangles stay axis-aligned; convert to a polygon to edit corners freely." }) : null;
    const conv = p.kind === "rectangle" && editable ? btn("polygon", "Convert to polygon", () => SM.store.updateFeature(p.id, (x) => { x.properties.kind = "polygon"; })) : null;
    return group("Coordinates (WGS84)", box, note, conv);
  }

  /* ---------------- actions ---------------- */
  function actionsGroup(feats) {
    const ids = feats.map((f) => f.properties.id);
    const anyLocked = feats.some((f) => f.properties.locked);
    const grouped = feats.some((f) => f.properties.group);
    return group("Actions", SM.el("div", { class: "actions" },
      btn("fit", "Zoom to", () => SM.mapview.fitFeatures(feats, 19)),
      btn("copy", "Duplicate", () => PR.duplicate(ids)),
      btn("brush", "Copy style", () => { PR.copyStyle(feats[0]); }),
      btn("brush", "Paste style", () => PR.pasteStyle(ids), SM.state.styleClipboard ? "" : "disabled-look"),
      btn("up", "To front", () => PR.reorder(ids, "front")),
      btn("down", "To back", () => PR.reorder(ids, "back")),
      feats.length > 1 ? btn("group", "Group", () => PR.group(ids)) : null,
      grouped ? btn("group", "Ungroup", () => PR.ungroup(ids)) : null,
      btn(anyLocked ? "unlock" : "lock", anyLocked ? "Unlock" : "Lock", () => SM.store.updateMany(ids, (x) => { x.properties.locked = !anyLocked; })),
      btn("eyeoff", "Hide", () => { SM.store.updateMany(ids, (x) => { x.properties.hidden = true; }); SM.store.clearSelection(); }),
      btn("trash", "Delete", () => SM.store.deleteFeatures(ids), "danger")));
  }

  function renderMulti(el, feats) {
    const ids = feats.map((f) => f.properties.id);
    const first = feats[0].properties.style;
    const layers = new Set(feats.map((f) => f.properties.layerId));
    const kinds = {};
    feats.forEach((f) => { kinds[f.properties.kind] = (kinds[f.properties.kind] || 0) + 1; });
    el.append(group([SM.el("span", { text: "Selection" }), SM.el("span", { class: "kind-badge", text: feats.length + " objects" })],
      SM.el("div", { class: "muted", text: Object.entries(kinds).map(([k, n]) => `${n} ${SM.KIND_NAMES[k]}`).join(" · ") }),
      row("Layer", layerSelect(ids, layers.size === 1 ? [...layers][0] : ""))));
    const S = (key, fn) => upd(ids, key, (x) => fn(x.properties.style, x.properties));
    el.append(group("Style (applies to all)",
      row("Line colour", color(first.color, (v) => S("color", (s) => { s.color = v; }))),
      row("Width", ...range(0, 20, 0.5, first.weight, (v) => S("weight", (s) => { s.weight = v; }), (v) => v + " px")),
      row("Opacity", ...range(0, 1, 0.05, first.opacity, (v) => S("opacity", (s) => { s.opacity = v; }), pct)),
      row("Pattern", seg([["solid", "Solid"], ["dashed", "Dashed"], ["dotted", "Dotted"]], first.dash, (v) => S("dash", (s) => { s.dash = v; }))),
      row("Fill colour", color(first.fillColor, (v) => S("fillColor", (s) => { s.fillColor = v; s.fill = true; }))),
      row("Fill opacity", ...range(0, 1, 0.05, first.fillOpacity, (v) => S("fillOpacity", (s) => { s.fillOpacity = v; s.fill = v > 0; }), pct)),
      row("Labels", check("Show labels", feats.every((f) => f.properties.label.show), (v) => upd(ids, "lshow", (x) => { x.properties.label.show = v || x.properties.kind === "text"; })))));
    // combined measurements
    let len = 0, area = 0;
    feats.forEach((f) => { const m = SM.geo.measureFeature(f); len += m.length_m || 0; area += m.area_m2 || 0; });
    el.append(group("Totals", SM.el("div", { class: "meas" }, len ? mline("Total length", SM.fmtLength(len)) : null, area ? mline("Total area", SM.fmtArea(area)) : null, area ? mline("", SM.fmtArea(area, "ha")) : null, !len && !area ? SM.el("div", { class: "muted", text: "No lengths or areas" }) : null)));
    el.append(actionsGroup(feats));
  }

  /* ---------------- operations (also used by keyboard shortcuts) ---------------- */
  PR.duplicate = function (ids, opts) {
    const src = (ids || [...SM.state.selection]).map(SM.store.feature).filter(Boolean);
    if (!src.length) return;
    const groupMap = {}, newIds = [];
    const dx = opts && opts.dx !== undefined ? opts.dx : 24, dy = opts && opts.dy !== undefined ? opts.dy : 24;
    SM.store.change((p) => {
      src.forEach((f) => {
        const c = SM.clone(f);
        c.properties.id = SM.uid();
        c.properties.locked = false;
        if (opts && opts.layerId) c.properties.layerId = opts.layerId;
        if (c.properties.group) c.properties.group = groupMap[c.properties.group] = groupMap[c.properties.group] || SM.uid();
        if (c.properties.name && !/copy$/.test(c.properties.name) && !(opts && opts.paste)) c.properties.name += " copy";
        c.geometry = SM.render.translateGeom(c.geometry, dx, dy);
        p.features.push(c);
        newIds.push(c.properties.id);
      });
    });
    SM.store.select(newIds);
    return newIds;
  };
  PR.copyStyle = function (f) {
    f = f || SM.store.selected()[0];
    if (!f) return;
    const lab = SM.clone(f.properties.label); delete lab.text;
    SM.state.styleClipboard = { style: SM.clone(f.properties.style), label: lab };
    SM.toast("Style copied — select other objects and click Paste style", "", 2200);
    PR.render();
  };
  PR.pasteStyle = function (ids) {
    const cb = SM.state.styleClipboard;
    if (!cb) { SM.toast("Copy a style first"); return; }
    SM.store.updateMany(ids || [...SM.state.selection], (x) => {
      const k = x.properties.kind;
      const st = Object.assign({}, x.properties.style, cb.style);
      if (LINE.includes(k)) st.fill = false;
      if (k === "arrow") st.arrow = true;
      x.properties.style = st;
      x.properties.label = Object.assign({}, x.properties.label, cb.label, { text: x.properties.label.text, show: k === "text" ? true : cb.label.show });
    });
  };
  PR.reorder = function (ids, where) {
    const set = new Set(ids);
    SM.store.change((p) => {
      const moving = p.features.filter((f) => set.has(f.properties.id));
      const rest = p.features.filter((f) => !set.has(f.properties.id));
      p.features = where === "front" ? rest.concat(moving) : moving.concat(rest);
    });
  };
  PR.group = function (ids) {
    const gid = SM.uid();
    SM.store.updateMany(ids, (x) => { x.properties.group = gid; });
    SM.toast(ids.length + " objects grouped — they now select and move together", "", 2200);
  };
  PR.ungroup = function (ids) { SM.store.updateMany(ids, (x) => { x.properties.group = null; }); };
})(window.SM);
