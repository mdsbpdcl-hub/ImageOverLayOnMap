/* =====================================================================
   overlays.js — images, screenshots and site plans placed on the map.

   Each overlay is stored in the project as
     { id, name, imageId, origImageId, w, h, P:[a,b,c,d,e,f], opacity, visible, locked }
   where P maps model coordinates (image pixel x, −y) to Web-Mercator
   metres, so rotation, scale, skew and position are all one matrix. The
   picture itself lives in project.images[imageId] (a data URL) and is
   kept out of the undo history to stay fast.

   The same machinery places AutoCAD drawings (cad.js) before they are
   converted into map objects ("temporary" overlays, never saved).
   ===================================================================== */
"use strict";
(function (SM) {
  const O = {};
  SM.overlays = O;
  const xf = () => SM.xf;
  const FLIP = [1, 0, 0, -1, 0, 0]; // image pixels (y down) → model (y up)
  const MAX_SIDE = 4096;
  const reg = new Map(); // id → { layer, hash }
  const imgCache = new Map(); // imageId → HTMLImageElement
  let temp = null; // CAD placement overlay { id, el, w, h, B, P, snap, opts }

  /* ---------------- Leaflet layer: any element under an affine matrix ---------------- */
  const R = 6378137;
  const TransformLayer = L.Layer.extend({
    initialize(el, M) { this._el = el; this._M = M; },
    onAdd(map) {
      const el = this._el;
      el.classList.add("sm-overlay", "leaflet-zoom-animated");
      Object.assign(el.style, { position: "absolute", left: "0", top: "0", transformOrigin: "0 0", maxWidth: "none", maxHeight: "none" });
      map.getPane("sm-overlays").appendChild(el);
      this._reset();
    },
    onRemove() { this._el.remove(); },
    getEvents() { return { zoom: this._reset, viewreset: this._reset, zoomanim: this._anim }; },
    setMatrix(M) { this._M = M; if (this._map) this._reset(); },
    _css(zoom, origin) {
      const s = 256 * Math.pow(2, zoom), k = s / (2 * Math.PI * R);
      const toLayer = [k, 0, 0, -k, s / 2 - origin.x, s / 2 - origin.y];
      const m = xf().mul(toLayer, this._M);
      this._el.style.transform = `matrix(${m.join(",")})`;
    },
    _reset() { this._css(this._map.getZoom(), this._map.getPixelOrigin()); },
    _anim(e) { this._css(e.zoom, this._map._getNewPixelOrigin(e.center, e.zoom)); },
  });

  /* ---------------- helpers ---------------- */
  const proj = () => SM.state.project;
  const list = () => (proj().overlays = proj().overlays || []);
  const get = (id) => (temp && temp.id === id ? temp : list().find((o) => o.id === id));
  const Bof = (o) => o.B || FLIP;
  const Mof = (o) => xf().mul(o.P, Bof(o));
  const mercOf = (latlng) => xf().toMerc(latlng.lat, latlng.lng);
  const llOf = (m) => { const [lat, lng] = xf().fromMerc(m[0], m[1]); return L.latLng(lat, lng); };
  O.centreMerc = (o) => xf().apply(Mof(o), [o.w / 2, o.h / 2]);
  O.cornersLatLng = (o) => [[0, 0], [o.w, 0], [o.w, o.h], [0, o.h]].map((p) => llOf(xf().apply(Mof(o), p)));
  O.groundSize = (o) => {
    const F = SM.crs.frameAtMerc(O.centreMerc(o)), E = xf().mul(F.Jinv, Mof(o)); // pixels → ground metres
    return { w: Math.hypot(E[0], E[1]) * o.w, h: Math.hypot(E[2], E[3]) * o.h };
  };
  /** Placement expressed in local ground metres (east, north) around the overlay centre. */
  O.enuOf = (o, P) => { const F = SM.crs.frameAtMerc(O.centreMerc(o)); return { F, Pe: xf().mul(F.Jinv, P || o.P) }; };
  O.rotationDeg = (o) => { const Pe = O.enuOf(o).Pe; let r = -(Math.atan2(Pe[1], Pe[0]) * 180) / Math.PI; r = ((r % 360) + 360) % 360; return r > 359.995 ? 0 : r; };
  /** True when the picture has been stretched or skewed (beyond the 0.5 % map-projection difference). */
  O.isStretched = (o) => { const Pe = O.enuOf(o).Pe, sx = Math.hypot(Pe[0], Pe[1]), sy = Math.hypot(Pe[2], Pe[3]); return Math.abs(sx - sy) / sx > 0.012 || Math.abs(Pe[0] * Pe[2] + Pe[1] * Pe[3]) / (sx * sy) > 0.012; };

  O.imageEl = function (imageId) {
    if (imgCache.has(imageId)) return imgCache.get(imageId);
    const src = (proj().images || {})[imageId];
    if (!src) return null;
    const img = new Image();
    img.decoding = "async";
    img.src = src;
    imgCache.set(imageId, img);
    return img;
  };

  /* ---------------- sync project → map ---------------- */
  O.init = function () {
    SM.map.createPane("sm-overlays").style.zIndex = 350;
    SM.map.createPane("sm-handles").style.zIndex = 660;
    SM.bus.on("change", () => O.sync());
    SM.bus.on("project", () => { imgCache.clear(); reg.forEach((e) => SM.map.removeLayer(e.layer)); reg.clear(); O.sync(); O.renderList(); });
    SM.bus.on("tool", () => updateHandles());
    SM.map.on("zoomend moveend", () => { updateHandles(); refreshAlignMarkers(); });
  };
  O.sync = function () {
    if (!proj()) return;
    const seen = new Set();
    list().forEach((o, i) => {
      if (!o.visible) return;
      seen.add(o.id);
      const hash = JSON.stringify(o);
      const e = reg.get(o.id);
      if (e && e.hash === hash) { e.layer._el.style.zIndex = i; return; }
      if (e) SM.map.removeLayer(e.layer);
      const srcImg = O.imageEl(o.imageId);
      if (!srcImg) return; // picture missing from the project file
      const img = srcImg.cloneNode();
      wireElement(img, o.id);
      const layer = new TransformLayer(img, Mof(o)).addTo(SM.map);
      img.style.opacity = o.opacity;
      img.style.zIndex = i;
      img.classList.toggle("locked", !!o.locked);
      reg.set(o.id, { layer, hash });
    });
    for (const [id, e] of reg) if (!seen.has(id)) { SM.map.removeLayer(e.layer); reg.delete(id); }
    if (SM.state.overlaySel && !get(SM.state.overlaySel)) O.select(null);
    O.renderList();
    updateHandles();
  };
  function liveLayer(id) { return temp && temp.id === id ? temp.layer : (reg.get(id) || {}).layer; }

  /* ---------------- selection ---------------- */
  O.select = function (id) {
    if (SM.state.overlaySel === id) return;
    if (align) O.endAlign(false);
    SM.state.overlaySel = id;
    if (id && SM.state.selection.size) { SM.state.selection.clear(); }
    SM.$$(".sm-overlay").forEach((el) => el.classList.toggle("sm-ov-selected", !!id && el.dataset.ov === id));
    updateHandles();
    O.renderList();
    SM.bus.emit("selection");
    if (id) SM.bus.emit("open-props");
  };
  O.selected = () => (SM.state.overlaySel ? get(SM.state.overlaySel) : null);

  /** Commit a placement matrix (undoable for saved overlays). */
  function commitP(o, P, coalesce) {
    if (o === temp) { temp.P = P; temp.layer.setMatrix(Mof(temp)); updateHandles(); SM.bus.emit("overlay-moved"); return; }
    SM.store.change(() => { o.P = P; }, { coalesce: coalesce || "ov:" + o.id, source: "overlay" });
  }
  function previewP(o, P) {
    const layer = liveLayer(o.id);
    if (layer) layer.setMatrix(xf().mul(P, Bof(o)));
    placeHandles(o, P);
  }

  /* ---------------- dragging the picture itself ---------------- */
  function wireElement(el, id) {
    el.dataset.ov = id;
    el.draggable = false;
    el.addEventListener("pointerdown", (ev) => {
      const o = get(id);
      if (!o || o.locked || ev.button > 0 || align) return;
      const tool = SM.tools.current;
      if (!["select", "move", "edit"].includes(tool)) return;
      ev.stopPropagation(); ev.preventDefault();
      if (SM.state.overlaySel !== id) { O.select(id); }
      const start = mercOf(SM.map.mouseEventToLatLng(ev)), P0 = o.P.slice();
      let moved = false;
      SM.map.dragging.disable();
      try { el.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      const move = (e2) => {
        const m = mercOf(SM.map.mouseEventToLatLng(e2));
        const P = xf().mul(xf().translate(m[0] - start[0], m[1] - start[1]), P0);
        moved = true; o._dragP = P; previewP(o, P);
      };
      const up = () => {
        el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up);
        if (SM.tools.current !== "freehand") SM.map.dragging.enable();
        if (moved && o._dragP) commitP(o, o._dragP, "ovdrag:" + id + Date.now());
        delete o._dragP;
      };
      el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
    });
  }

  /* ---------------- handles (resize corners, rotate, move) ---------------- */
  let handles = [];
  function clearHandles() { handles.forEach((h) => SM.map.removeLayer(h)); handles = []; }
  function updateHandles() {
    clearHandles();
    const o = O.selected();
    if (!o || o.locked || align || !["select", "move", "edit"].includes(SM.tools.current)) return;
    const mk = (cls, title) => L.marker([0, 0], { pane: "sm-handles", draggable: true, keyboard: false, pmIgnore: true, snapIgnore: true, title,
      icon: L.divIcon({ className: "sm-hd " + cls, iconSize: cls === "rot" || cls === "mv" ? [22, 22] : [14, 14] }) }).addTo(SM.map);
    const fixedScale = o === temp && temp.trueScale;
    const corners = fixedScale ? [] : [0, 1, 2, 3].map((i) => { const h = mk("corner", "Drag to resize"); h._corner = i; return h; });
    const rot = mk("rot", "Drag to rotate"); rot._rot = true;
    const mv = mk("mv", "Drag to move"); mv._mv = true;
    handles = [...corners, rot, mv];
    handles.forEach((h) => {
      let P0, pivot, start;
      h.on("dragstart", () => { P0 = o.P.slice(); pivot = O.centreMerc(o); start = mercOf(h.getLatLng()); SM.map.dragging.disable(); });
      h.on("drag", () => {
        const m = mercOf(h.getLatLng());
        let P;
        if (h._mv) P = xf().mul(xf().translate(m[0] - start[0], m[1] - start[1]), P0);
        else if (h._rot) {
          const a = Math.atan2(m[1] - pivot[1], m[0] - pivot[0]) - Math.atan2(start[1] - pivot[1], start[0] - pivot[0]);
          P = xf().mul(xf().about(xf().rotate(a), pivot), P0);
        } else {
          const f = Math.hypot(m[0] - pivot[0], m[1] - pivot[1]) / Math.max(1e-9, Math.hypot(start[0] - pivot[0], start[1] - pivot[1]));
          P = xf().mul(xf().about(xf().scale(f), pivot), P0);
        }
        o._dragP = P;
        const layer = liveLayer(o.id); if (layer) layer.setMatrix(xf().mul(P, Bof(o)));
        placeHandles(o, P, h);
      });
      h.on("dragend", () => {
        if (SM.tools.current !== "freehand") SM.map.dragging.enable();
        if (o._dragP) commitP(o, o._dragP, "ovh:" + o.id + Date.now());
        delete o._dragP;
        if (o === temp) updateHandles();
      });
    });
    placeHandles(o, o.P);
  }
  function placeHandles(o, P, except) {
    if (!handles.length) return;
    const M = xf().mul(P, Bof(o));
    const pts = [[0, 0], [o.w, 0], [o.w, o.h], [0, o.h]].map((p) => xf().apply(M, p));
    const c = xf().apply(M, [o.w / 2, o.h / 2]);
    // rotation handle: beyond the top edge, 34 px away on screen
    const top = xf().apply(M, [o.w / 2, 0]);
    const px = SM.map.latLngToContainerPoint(llOf(top)), pc = SM.map.latLngToContainerPoint(llOf(c));
    const d = px.subtract(pc), len = Math.max(1, Math.hypot(d.x, d.y));
    const rotPt = SM.map.containerPointToLatLng(px.add(d.multiplyBy(34 / len)));
    handles.forEach((h) => {
      if (h === except) return;
      if (h._mv) h.setLatLng(llOf(c));
      else if (h._rot) h.setLatLng(rotPt);
      else h.setLatLng(llOf(pts[h._corner]));
    });
  }

  /* ---------------- adding images ---------------- */
  function readAsDataURL(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error("Could not read the image")); r.readAsDataURL(file); }); }
  function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("This image format cannot be opened by the browser")); i.src = src; }); }
  /** Downscale very large pictures so projects stay quick to save. */
  async function normalise(src, type) {
    const img = await loadImg(src);
    let w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new Error("The image is empty");
    const big = Math.max(w, h) > MAX_SIDE;
    if (!big && src.length < 12e6) return { src, w, h };
    const k = big ? MAX_SIDE / Math.max(w, h) : 1;
    w = Math.round(w * k); h = Math.round(h * k);
    const cv = SM.el("canvas", { width: w, height: h });
    cv.getContext("2d").drawImage(img, 0, 0, w, h);
    const keepAlpha = /png|gif|webp|svg/.test(type || "");
    return { src: cv.toDataURL(keepAlpha ? "image/png" : "image/jpeg", 0.9), w, h, scaled: big };
  }
  O.addImageFile = async function (file) {
    if (SM.cad.isCad(file.name) || (!/^image\//.test(file.type) && !/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name || ""))) throw new Error("Not a picture file");
    if (/^image\/(tiff|x-tiff)$/.test(file.type) || /\.tiff?$/i.test(file.name || "")) throw new Error("TIFF pictures cannot be shown by browsers — save it as PNG or JPG first");
    const { src, w, h, scaled } = await normalise(await readAsDataURL(file), file.type);
    const imageId = "img" + SM.uid();
    // fit into 60% of the current view, north-up, centred
    const b = SM.map.getBounds(), sw = xf().toMerc(b.getSouth(), b.getWest()), ne = xf().toMerc(b.getNorth(), b.getEast());
    const cx = (sw[0] + ne[0]) / 2, cy = (sw[1] + ne[1]) / 2;
    const s = Math.min(((ne[0] - sw[0]) * 0.6) / w, ((ne[1] - sw[1]) * 0.6) / h);
    const ov = { id: "ov" + SM.uid(), name: (file.name || "Screenshot").replace(/\.[^.]+$/, "") || "Image", imageId, origImageId: null, w, h,
      P: [s, 0, 0, s, cx - (s * w) / 2, cy + (s * h) / 2], opacity: 0.8, visible: true, locked: false };
    proj().images = proj().images || {};
    proj().images[imageId] = src;
    SM.store.change((p) => { p.overlays = p.overlays || []; p.overlays.push(ov); });
    if (SM.tools.current !== "select") SM.tools.set("select");
    O.select(ov.id);
    SM.toast((scaled ? "Large image reduced to 4096 px. " : "") + "Drag the picture to move it, the round handle to rotate, corners to resize — or use “Align by points”.", "", 6000);
    return ov;
  };
  /** Ctrl+V with a screenshot on the clipboard → new picture. Returns true if handled. */
  O.pasteImage = function (e) {
    const item = [...((e.clipboardData || {}).items || [])].find((i) => i.type.startsWith("image/"));
    if (!item) return false;
    e.preventDefault();
    const f = item.getAsFile();
    if (f) O.addImageFile(new File([f], "Screenshot " + new Date().toLocaleTimeString().replace(/:/g, "."), { type: f.type })).catch((err) => SM.toast(err.message, "error"));
    return true;
  };

  /* ---------------- operations ---------------- */
  O.update = function (id, fn, coalesce) {
    const o = get(id);
    if (!o) return;
    if (o === temp) { fn(o); temp.layer.setMatrix(Mof(o)); temp.el.style.opacity = o.opacity; updateHandles(); return; }
    SM.store.change(() => fn(o), { coalesce: coalesce || null, source: "overlay" });
  };
  O.remove = function (id) {
    SM.store.change((p) => { p.overlays = (p.overlays || []).filter((o) => o.id !== id); });
    if (SM.state.overlaySel === id) O.select(null);
  };
  O.setRotation = function (o, deg) {
    // rotate in ground metres so the picture is not distorted by the map projection
    const { F, Pe } = O.enuOf(o), c = xf().apply(F.Jinv, O.centreMerc(o));
    const now = Math.atan2(Pe[1], Pe[0]), want = (-deg * Math.PI) / 180;
    commitP(o, xf().mul(F.J, xf().mul(xf().about(xf().rotate(want - now), c), Pe)), "ovrot:" + o.id);
  };
  O.setWidth = function (o, metres) {
    const cur = O.groundSize(o).w;
    if (!(metres > 0) || !(cur > 0)) return;
    commitP(o, xf().mul(xf().about(xf().scale(metres / cur), O.centreMerc(o)), o.P), "ovw:" + o.id);
  };
  O.fitToView = function (o) {
    const b = SM.map.getBounds(), sw = xf().toMerc(b.getSouth(), b.getWest()), ne = xf().toMerc(b.getNorth(), b.getEast());
    const c = O.centreMerc(o), M = Mof(o);
    const pts = [[0, 0], [o.w, 0], [o.w, o.h], [0, o.h]].map((p) => xf().apply(M, p));
    const bw = Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]));
    const bh = Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]));
    const s = Math.min(((ne[0] - sw[0]) * 0.8) / bw, ((ne[1] - sw[1]) * 0.8) / bh);
    let P = xf().mul(xf().about(xf().scale(s), c), o.P);
    P = xf().mul(xf().translate((sw[0] + ne[0]) / 2 - c[0], (sw[1] + ne[1]) / 2 - c[1]), P);
    commitP(o, P);
  };
  O.move = function (id, dir) {
    SM.store.change((p) => {
      const i = p.overlays.findIndex((o) => o.id === id), j = i + dir;
      if (i < 0 || j < 0 || j >= p.overlays.length) return;
      const [x] = p.overlays.splice(i, 1); p.overlays.splice(j, 0, x);
    });
  };
  O.zoomTo = (o) => SM.map.fitBounds(L.latLngBounds(O.cornersLatLng(o)), { padding: [40, 40] });

  /* =========================================================
     Align by control points
     ========================================================= */
  let align = null; // { id, pairs:[{src, dst}], step, mode, P0, markers }
  O.aligning = () => !!align;
  O.startAlign = function (id) {
    const o = get(id);
    if (!o) return;
    if (o.locked) { SM.toast("Unlock the image first"); return; }
    if (SM.tools.current !== "select") SM.tools.set("select");
    const layer = liveLayer(id);
    align = { id, pairs: [], step: "src", mode: o === temp && temp.trueScale ? "rigid" : "similarity", P0: o.P.slice(), group: L.layerGroup().addTo(SM.map), opacity: layer ? layer._el.style.opacity : null };
    if (layer) layer._el.style.opacity = Math.min(0.65, +o.opacity || 0.65);
    SM.map.getContainer().classList.add("sm-aligning", "tool-draw");
    clearHandles();
    SM.bus.emit("selection");
    showAlignHint();
  };
  function showAlignHint() {
    const bar = SM.$("#hintbar");
    if (!align) { bar.classList.add("hidden"); return; }
    const o = get(align.id), n = align.pairs.length + (align.step === "dst" ? 1 : 0);
    const what = o === temp ? "drawing" : "picture";
    bar.classList.remove("hidden");
    SM.$("#hint-text").textContent = align.step === "src"
      ? `Point ${n + 1}: click a sharp feature on the ${what} (a corner, junction, gate)` + (o === temp ? " — it snaps to the nearest drawing point" : "")
      : `Point ${n}: now click where that exact spot really is on the satellite map`;
    SM.$("#hint-extra").innerHTML = "";
    SM.$("#hint-undo").classList.toggle("hidden", !align.pairs.length && align.step === "src");
    SM.$("#hint-finish").classList.remove("hidden");
    SM.$("#hint-finish").textContent = "Done";
  }
  O.alignClick = function (e) {
    if (!align) return false;
    const o = get(align.id);
    let m = mercOf(e.latlng);
    if (align.step === "src") {
      const M = Mof(o), inv = xf().inv(M), px = xf().apply(inv, m);
      if (px[0] < -o.w * 0.02 || px[1] < -o.h * 0.02 || px[0] > o.w * 1.02 || px[1] > o.h * 1.02) { SM.toast("Click on the " + (o === temp ? "drawing" : "picture") + " first, then on the map"); return true; }
      let model = xf().apply(Bof(o), px);
      if (o === temp && temp.snap) {
        const tolMerc = (12 * 2 * Math.PI * R) / (256 * Math.pow(2, SM.map.getZoom()));
        const s = temp.snap(model, tolMerc / xf().decompose(o.P).scale);
        if (s) model = s;
      }
      align.cur = { src: model };
      align.step = "dst";
    } else {
      align.cur.dst = m;
      align.pairs.push(align.cur);
      align.cur = null;
      align.step = "src";
      refit();
    }
    refreshAlignMarkers();
    showAlignHint();
    SM.bus.emit("align");
    return true;
  };
  O.alignTyped = function (text) {
    if (!align || align.step !== "dst") { SM.toast("First click a point on the picture"); return; }
    const ll = SM.parseLatLng(text);
    if (!ll) { SM.toast("Could not read that coordinate", "error"); return; }
    O.alignClick({ latlng: L.latLng(ll.lat, ll.lng) });
  };
  O.alignUndo = function () {
    if (!align) return;
    if (align.step === "dst") { align.cur = null; align.step = "src"; }
    else if (align.pairs.length) align.pairs.pop();
    refit(); refreshAlignMarkers(); showAlignHint(); SM.bus.emit("align");
  };
  O.alignRemove = function (i) { align.pairs.splice(i, 1); refit(); refreshAlignMarkers(); SM.bus.emit("align"); };
  O.alignMode = function (mode) { align.mode = mode; refit(); refreshAlignMarkers(); SM.bus.emit("align"); };
  O.alignState = () => align;
  function need(mode) { return mode === "affine" ? 3 : mode === "rigid" ? 1 : 2; }
  function refit() {
    const o = get(align.id);
    const src = align.pairs.map((p) => p.src), dst = align.pairs.map((p) => p.dst);
    align.error = null; align.res = null;
    if (src.length < need(align.mode)) { setP(o, src.length ? align.P0 : align.P0); return; }
    try {
      let P;
      if (align.mode === "affine") P = xf().fitAffine(src, dst);
      else if (align.mode === "rigid") {
        // true scale: fit rotation + position in local ground metres, scale fixed by the drawing units
        const F = SM.crs.frameAtMerc(dst[0]), Pe0 = xf().mul(F.Jinv, align.P0), d = xf().decompose(Pe0);
        const scale = o === temp && temp.metresPerUnit ? temp.metresPerUnit : d.scale;
        const Pe = xf().fitSimilarity(src, dst.map((q) => xf().apply(F.Jinv, q)), { scale, rot: d.rot });
        P = xf().mul(F.J, Pe);
      }
      else P = xf().fitSimilarity(src, dst);
      setP(o, P);
      align.res = xf().residuals(P, src, dst);
    } catch (e) { align.error = e.message; }
  }
  function setP(o, P) {
    o._alignP = P;
    const layer = liveLayer(o.id);
    if (layer) layer.setMatrix(xf().mul(P, Bof(o)));
  }
  function refreshAlignMarkers() {
    if (!align) return;
    const o = get(align.id), P = o._alignP || o.P;
    align.group.clearLayers();
    const num = (n, cls) => L.divIcon({ className: "sm-cp " + cls, html: String(n), iconSize: [22, 22], iconAnchor: [11, 11] });
    const all = align.pairs.concat(align.cur ? [align.cur] : []);
    all.forEach((p, i) => {
      const s = llOf(xf().apply(P, p.src));
      align.group.addLayer(L.marker(s, { icon: num(i + 1, "src"), interactive: false, pmIgnore: true, pane: "sm-handles" }));
      if (p.dst) {
        const d = llOf(p.dst);
        align.group.addLayer(L.polyline([s, d], { color: "#ffeb3b", weight: 2, dashArray: "4 4", interactive: false, pmIgnore: true }));
        const mk = L.marker(d, { icon: num(i + 1, "dst"), draggable: true, pmIgnore: true, pane: "sm-handles", title: "Drag to adjust" });
        mk.on("dragend", () => { p.dst = mercOf(mk.getLatLng()); refit(); refreshAlignMarkers(); SM.bus.emit("align"); });
        align.group.addLayer(mk);
      }
    });
  }
  O.endAlign = function (apply) {
    if (!align) return;
    const o = get(align.id), a = align;
    align = null;
    a.group.remove();
    SM.map.getContainer().classList.remove("sm-aligning");
    if (SM.tools.current === "select") SM.map.getContainer().classList.remove("tool-draw");
    const layer = liveLayer(o.id);
    if (layer && a.opacity !== null) layer._el.style.opacity = a.opacity;
    const P = o._alignP;
    delete o._alignP;
    SM.$("#hintbar").classList.add("hidden");
    if (apply && P && a.pairs.length >= need(a.mode)) {
      commitP(o, P, "align:" + Date.now());
      const rms = a.res && a.res.length > 1 ? Math.sqrt(a.res.reduce((s, r) => s + r * r, 0) / a.res.length) : null;
      SM.toast("Aligned" + (rms !== null ? ` — average error ${SM.fmtLength(rms)}` : ""), "ok", 3500);
    } else {
      const lay = liveLayer(o.id); if (lay) lay.setMatrix(Mof(o));
    }
    updateHandles();
    SM.bus.emit("selection");
  };

  /* =========================================================
     Background removal
     ========================================================= */
  O.backgroundDialog = async function (o) {
    const src = proj().images[o.imageId];
    const img = await loadImg(src);
    // preview at up to 900 px for speed; the final result is computed at full size
    const pk = Math.min(1, 900 / Math.max(img.naturalWidth, img.naturalHeight));
    const pw = Math.round(img.naturalWidth * pk), ph = Math.round(img.naturalHeight * pk);
    const cv = SM.el("canvas", { width: pw, height: ph, class: "bg-preview", title: "Click the colour to remove" });
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, pw, ph);
    const base = ctx.getImageData(0, 0, pw, ph);
    let key = cornerColour(base);
    const sw = SM.el("span", { class: "swatch-big" });
    const tol = SM.el("input", { type: "range", min: 0, max: 100, value: 18 });
    const tolV = SM.el("span", { class: "val", text: "18" });
    const mode = SM.el("select", { class: "field" },
      SM.el("option", { value: "all", text: "Everywhere in the picture (best for plans and drawings)" }),
      SM.el("option", { value: "edges", text: "Only the background touching the edges (best for photos, logos)" }));
    const soft = SM.el("input", { type: "checkbox", checked: true });
    const dark = SM.el("input", { type: "checkbox" });
    const render = () => {
      sw.style.background = `rgb(${key.join(",")})`;
      tolV.textContent = tol.value;
      const out = new ImageData(new Uint8ClampedArray(base.data), pw, ph);
      removeBg(out, key, +tol.value, mode.value, soft.checked, dark.checked);
      ctx.putImageData(out, 0, 0);
    };
    cv.addEventListener("click", (e) => {
      const r = cv.getBoundingClientRect();
      const x = Math.floor(((e.clientX - r.left) / r.width) * pw), y = Math.floor(((e.clientY - r.top) / r.height) * ph);
      const i = (y * pw + x) * 4;
      key = [base.data[i], base.data[i + 1], base.data[i + 2]];
      render();
    });
    [tol, mode, soft, dark].forEach((c) => c.addEventListener("input", render));
    const body = SM.el("div", {},
      SM.el("div", { class: "bg-wrap" }, cv),
      SM.el("div", { class: "form-grid", style: { marginTop: "12px" } },
        SM.el("label", { text: "Colour to remove" }), SM.el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, sw,
          SM.el("span", { class: "muted", text: "click the picture to pick" }),
          SM.el("button", { class: "mini-btn", text: "White", onclick: () => { key = [255, 255, 255]; render(); } }),
          SM.el("button", { class: "mini-btn", text: "Auto", onclick: () => { key = cornerColour(base); render(); } })),
        SM.el("label", { text: "Strength" }), SM.el("div", { class: "prow", style: { margin: 0 } }, tol, tolV),
        SM.el("label", { text: "Remove it" }), mode,
        SM.el("label", { text: "" }), SM.el("label", { class: "check" }, soft, "Soft edges"),
        SM.el("label", { text: "" }), SM.el("label", { class: "check" }, dark, "Also make light paper areas fully see-through, keep only dark lines")));
    render();
    SM.modal({
      title: "Remove background", body, wide: true,
      buttons: [{ label: "Cancel" }, {
        label: "Apply", cls: "primary", action: async (_, b) => {
          b.disabled = true; b.textContent = "Working…";
          await new Promise((r) => setTimeout(r, 20));
          const full = SM.el("canvas", { width: img.naturalWidth, height: img.naturalHeight });
          const fctx = full.getContext("2d", { willReadFrequently: true });
          fctx.drawImage(img, 0, 0);
          const d = fctx.getImageData(0, 0, full.width, full.height);
          removeBg(d, key, +tol.value, mode.value, soft.checked, dark.checked);
          fctx.putImageData(d, 0, 0);
          const newId = "img" + SM.uid();
          proj().images[newId] = full.toDataURL("image/png");
          SM.store.change(() => { if (!o.origImageId) o.origImageId = o.imageId; o.imageId = newId; }, { source: "overlay" });
          SM.toast("Background removed", "ok", 2000);
        },
      }],
    });
  };
  O.restoreOriginal = function (o) {
    if (!o.origImageId) return;
    SM.store.change(() => { o.imageId = o.origImageId; o.origImageId = null; }, { source: "overlay" });
  };
  function cornerColour(d) {
    const { width: w, height: h, data } = d;
    const pts = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1], [w >> 1, 0], [w >> 1, h - 1], [0, h >> 1], [w - 1, h >> 1]];
    const s = [0, 0, 0];
    pts.forEach(([x, y]) => { const i = (y * w + x) * 4; s[0] += data[i]; s[1] += data[i + 1]; s[2] += data[i + 2]; });
    return s.map((v) => Math.round(v / pts.length));
  }
  /** Make pixels close to `key` transparent. tol 0–100. */
  function removeBg(d, key, tol, mode, soft, keepDarkOnly) {
    const { width: w, height: h, data } = d;
    const T = (tol / 100) * 255 * 1.2, T2 = T * 1.5;
    const dist = (i) => { const r = data[i] - key[0], g = data[i + 1] - key[1], b = data[i + 2] - key[2]; return Math.sqrt((r * r + g * g + b * b) / 3); };
    const fade = (i, dd) => {
      if (dd <= T) data[i + 3] = 0;
      else if (soft && dd < T2) data[i + 3] = Math.round((data[i + 3] * (dd - T)) / (T2 - T));
    };
    if (mode === "edges") {
      const seen = new Uint8Array(w * h), q = new Int32Array(w * h);
      let qh = 0, qt = 0;
      const push = (x, y) => { const p = y * w + x; if (seen[p]) return; seen[p] = 1; if (dist(p * 4) < T2) q[qt++] = p; };
      for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
      for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
      while (qh < qt) {
        const p = q[qh++], x = p % w, y = (p / w) | 0;
        fade(p * 4, dist(p * 4));
        if (dist(p * 4) > T) continue; // soft edge pixel: don't spread further
        if (x > 0) push(x - 1, y); if (x < w - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < h - 1) push(x, y + 1);
      }
    } else {
      for (let i = 0; i < data.length; i += 4) fade(i, dist(i));
    }
    if (keepDarkOnly) {
      for (let i = 0; i < data.length; i += 4) {
        const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (l > 170) data[i + 3] = Math.min(data[i + 3], Math.max(0, Math.round((230 - l) * 4.25)));
      }
    }
  }

  /* =========================================================
     Left panel list and right panel properties
     ========================================================= */
  O.renderList = function () {
    const ul = SM.$("#overlay-list");
    if (!ul || !proj()) return;
    ul.innerHTML = "";
    const items = list().slice().reverse();
    SM.$("#overlay-sect").classList.toggle("empty-sect", !items.length);
    if (!items.length) { ul.append(SM.el("li", { class: "empty", text: "Add a picture, screenshot (Ctrl+V) or site plan" })); return; }
    items.forEach((o) => {
      const ib = (icon, title, fn, on) => { const b = SM.el("button", { class: "ib" + (on ? " on" : ""), title }, SM.icon(icon)); b.addEventListener("click", (e) => { e.stopPropagation(); fn(); }); return b; };
      const li = SM.el("li", { class: SM.state.overlaySel === o.id ? "sel" : "" },
        SM.el("img", { class: "thumb", src: proj().images[o.imageId] || "", alt: "" }),
        SM.el("span", { class: "oname", text: o.name }),
        ib(o.visible ? "eye" : "eyeoff", o.visible ? "Hide" : "Show", () => O.update(o.id, (x) => { x.visible = !x.visible; })),
        ib(o.locked ? "lock" : "unlock", o.locked ? "Unlock" : "Lock in place", () => O.update(o.id, (x) => { x.locked = !x.locked; }), o.locked));
      li.addEventListener("click", () => { O.select(o.id); });
      li.addEventListener("dblclick", () => O.zoomTo(o));
      ul.append(li);
    });
  };

  O.renderProps = function (root) {
    const o = O.selected();
    if (!o) return false;
    if (align) { renderAlignPanel(root, o); return true; }
    if (o === temp && SM.cad) { SM.cad.renderPlacement(root, o); return true; }
    const group = (title, ...kids) => SM.el("div", { class: "pgroup" }, SM.el("h4", {}, ...(Array.isArray(title) ? title : [title])), ...kids);
    const row = (label, ...c) => SM.el("div", { class: "prow" }, SM.el("label", { text: label }), SM.el("div", { class: "ctrl" }, ...c));
    const btn = (icon, label, fn, cls) => { const b = SM.el("button", { class: "mini-btn " + (cls || "") }, icon ? SM.icon(icon) : null, label); b.addEventListener("click", fn); return b; };
    const name = SM.el("input", { type: "text", value: o.name });
    name.addEventListener("input", () => O.update(o.id, (x) => { x.name = name.value; }, "ovname:" + o.id));
    const op = SM.el("input", { type: "range", min: 0.05, max: 1, step: 0.05, value: o.opacity });
    const opV = SM.el("span", { class: "val", text: Math.round(o.opacity * 100) + "%" });
    op.addEventListener("input", () => { opV.textContent = Math.round(op.value * 100) + "%"; O.update(o.id, (x) => { x.opacity = +op.value; }, "ovop:" + o.id); });
    const size = O.groundSize(o);
    const rot = SM.el("input", { type: "number", step: 0.1, value: O.rotationDeg(o).toFixed(1), disabled: o.locked });
    rot.addEventListener("change", () => { if (isFinite(+rot.value)) O.setRotation(o, +rot.value); });
    const wid = SM.el("input", { type: "number", step: "any", min: 0.01, value: size.w.toFixed(2), disabled: o.locked });
    wid.addEventListener("change", () => O.setWidth(o, +wid.value));
    const c = O.centreMerc(o), [clat, clng] = xf().fromMerc(c[0], c[1]);
    const skew = O.isStretched(o);
    root.append(
      group([SM.el("span", { text: "Picture" }), SM.el("span", { class: "kind-badge", text: `${o.w}×${o.h} px` })],
        row("Name", name),
        row("See-through", op, opV),
        o.locked ? SM.el("div", { class: "warn-box", text: "Locked in place. Unlock it to move, rotate or resize." }) : null),
      group("Position & size",
        row("Rotation °", rot, SM.el("span", { class: "muted", text: "clockwise" })),
        row("Width (m)", wid),
        row("Height", SM.el("span", { text: SM.fmtLength(size.h) + (skew ? " (stretched)" : "") })),
        row("Centre", SM.el("span", { class: "muted", text: `${clat.toFixed(6)}, ${clng.toFixed(6)}` })),
        SM.el("div", { class: "actions", style: { marginTop: "8px" } },
          btn("target", "Align by points…", () => O.startAlign(o.id), "primary"),
          btn("fit", "Fit to screen", () => O.fitToView(o)),
          btn("up", "North up", () => O.setRotation(o, 0)))),
      group("Picture",
        SM.el("div", { class: "actions" },
          btn("brush", "Remove background…", () => O.backgroundDialog(o).catch((e) => SM.toast(e.message, "error"))),
          o.origImageId ? btn("undo", "Restore original", () => O.restoreOriginal(o)) : null,
          btn("up", "Bring forward", () => O.move(o.id, 1)),
          btn("down", "Send back", () => O.move(o.id, -1)))),
      group("Actions", SM.el("div", { class: "actions" },
        btn("fit", "Zoom to", () => O.zoomTo(o)),
        btn(o.locked ? "unlock" : "lock", o.locked ? "Unlock" : "Lock in place", () => O.update(o.id, (x) => { x.locked = !x.locked; })),
        btn("eyeoff", "Hide", () => { O.update(o.id, (x) => { x.visible = false; }); O.select(null); }),
        btn("trash", "Delete", () => O.remove(o.id), "danger"))),
      group("Tips", SM.el("div", { class: "tips", html:
        "<ul><li>Drag the picture to move it. Drag the <b>round</b> handle to rotate and a <b>corner</b> to resize.</li>" +
        "<li>For accuracy use <b>Align by points</b>: click a spot on the picture, then the same spot on the map. Two points fix position, size and direction; three or more also correct stretching.</li>" +
        "<li>Lock it when it fits, then draw over it. Pictures are included in PNG/PDF exports and in KMZ files for Google Earth.</li></ul>" })));
    return true;
  };

  function renderAlignPanel(root, o) {
    const a = align;
    const group = (title, ...kids) => SM.el("div", { class: "pgroup" }, SM.el("h4", { text: title }), ...kids);
    const typed = SM.el("input", { type: "text", class: "field", placeholder: "or type lat, lng and press Enter" });
    typed.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); const v = typed.value; typed.value = ""; O.alignTyped(v); } });
    const modeSel = SM.el("select", { class: "field" },
      ...(o === temp ? [SM.el("option", { value: "rigid", text: "Keep true scale — move & rotate only (1+ points)", selected: a.mode === "rigid" })] : []),
      SM.el("option", { value: "similarity", text: "Move, rotate & resize (2+ points)", selected: a.mode === "similarity" }),
      SM.el("option", { value: "affine", text: "Also correct stretching (3+ points)", selected: a.mode === "affine" }));
    modeSel.addEventListener("change", () => O.alignMode(modeSel.value));
    const rows = a.pairs.map((p, i) => {
      const r = a.res ? a.res[i] : null;
      const del = SM.el("button", { class: "ib", title: "Remove this pair" }, SM.icon("x"));
      del.addEventListener("click", () => O.alignRemove(i));
      return SM.el("div", { class: "mline" }, SM.el("span", { text: "Point " + (i + 1) }), SM.el("span", {}, r !== null ? SM.fmtLength(r) + " off" : "—", del));
    });
    const rms = a.res && a.res.length ? Math.sqrt(a.res.reduce((s, r) => s + r * r, 0) / a.res.length) : null;
    const needN = need(a.mode);
    root.append(group("Align by points",
      SM.el("div", { class: "tips", html: a.step === "src"
        ? `<b>Step 1:</b> click a clear spot on the ${o === temp ? "drawing" : "picture"} — a building corner, road junction or boundary pillar.`
        : "<b>Step 2:</b> click the same spot on the satellite map." }),
      a.step === "dst" ? typed : null,
      SM.el("div", { class: "prow" }, SM.el("label", { text: "Method" }), SM.el("div", { class: "ctrl" }, modeSel)),
      SM.el("div", { class: "meas", style: { marginTop: "6px" } }, ...rows,
        rms !== null && a.pairs.length > needN ? SM.el("div", { class: "mline" }, SM.el("span", { text: "Average error" }), SM.el("b", { text: SM.fmtLength(rms) })) : null,
        a.pairs.length < needN ? SM.el("div", { class: "note", text: `Add ${needN - a.pairs.length} more point pair(s)` }) : SM.el("div", { class: "note", text: a.pairs.length === needN ? "Add one more pair to check the accuracy" : "Drag a green marker to fine-tune" })),
      a.error ? SM.el("div", { class: "warn-box", text: a.error }) : null,
      SM.el("div", { class: "actions", style: { marginTop: "8px" } },
        SM.el("button", { class: "mini-btn primary", text: "Done", onclick: () => O.endAlign(true) }),
        SM.el("button", { class: "mini-btn", text: "Undo point", onclick: () => O.alignUndo() }),
        SM.el("button", { class: "mini-btn", text: "Cancel", onclick: () => O.endAlign(false) }))));
  }

  /* =========================================================
     Printing and KMZ
     ========================================================= */
  /** Draw visible saved overlays onto an export canvas; toPx: [lng,lat] → [x,y]. */
  O.drawOnCanvas = function (ctx, toPx) {
    (list() || []).forEach((o) => {
      if (!o.visible) return;
      const img = O.imageEl(o.imageId);
      if (!img || !img.complete || !img.naturalWidth) return;
      const M = Mof(o);
      const pts = [[0, 0], [o.w, 0], [0, o.h]].map((p) => { const ll = llOf(xf().apply(M, p)); return toPx([ll.lng, ll.lat]); });
      const T = xf().from3([[0, 0], [o.w, 0], [0, o.h]], pts);
      ctx.save();
      ctx.globalAlpha = o.opacity;
      ctx.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
      ctx.drawImage(img, 0, 0, o.w, o.h);
      ctx.restore();
    });
  };
  O.whenImagesReady = () => Promise.all((list() || []).filter((o) => o.visible).map((o) => {
    const img = O.imageEl(o.imageId);
    return img && !img.complete ? new Promise((r) => { img.onload = img.onerror = r; }) : null;
  }));

  /** KML GroundOverlay elements + image files for a KMZ. */
  O.kmzParts = function (project) {
    const out = { xml: "", files: {} };
    (project.overlays || []).filter((o) => o.visible !== false).forEach((o) => {
      const src = (project.images || {})[o.imageId];
      if (!src) return;
      const m = /^data:image\/(png|jpe?g|gif|webp);base64,(.*)$/.exec(src);
      if (!m) return;
      const ext = m[1].replace("jpeg", "jpg"), file = `images/${o.id}.${ext}`;
      const bin = atob(m[2]), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      out.files[file] = bytes;
      const M = Mof(o);
      // gx:LatLonQuad: lower-left, lower-right, upper-right, upper-left of the image
      const q = [[0, o.h], [o.w, o.h], [o.w, 0], [0, 0]].map((p) => { const ll = llOf(xf().apply(M, p)); return `${ll.lng.toFixed(8)},${ll.lat.toFixed(8)}`; }).join(" ");
      const alpha = Math.round(o.opacity * 255).toString(16).padStart(2, "0");
      out.xml += `<GroundOverlay><name>${SM.esc(o.name)}</name><color>${alpha}ffffff</color><Icon><href>${file}</href></Icon><gx:LatLonQuad><coordinates>${q}</coordinates></gx:LatLonQuad></GroundOverlay>`;
    });
    if (out.xml) out.xml = `<Folder><name>Images</name>${out.xml}</Folder>`;
    return out;
  };

  /** Create overlays from imported GroundOverlays: [{name, src, quad:[ll,lr,ur,ul] as [lng,lat], opacity}] */
  O.addImported = async function (items) {
    const added = [];
    proj().images = proj().images || {};
    for (const it of items) {
      const img = await loadImg(it.src).catch(() => null);
      if (!img) continue;
      const w = img.naturalWidth, h = img.naturalHeight;
      const merc = it.quad.map((c) => xf().toMerc(c[1], c[0]));
      // model points of image corners: ll=(0,-h) lr=(w,-h) ur=(w,0) ul=(0,0); fit affine through them
      const P = xf().fitAffine([[0, -h], [w, -h], [w, 0], [0, 0]], merc);
      const imageId = "img" + SM.uid();
      proj().images[imageId] = it.src;
      added.push({ id: "ov" + SM.uid(), name: it.name || "Image", imageId, origImageId: null, w, h, P, opacity: it.opacity ?? 0.8, visible: true, locked: true });
    }
    if (added.length) SM.store.change((p) => { p.overlays = (p.overlays || []).concat(added); });
    return added.length;
  };

  /* =========================================================
     Temporary overlay (CAD placement, see cad.js)
     ========================================================= */
  O.setTemp = function (t) {
    if (temp) { SM.map.removeLayer(temp.layer); if (SM.state.overlaySel === temp.id) SM.state.overlaySel = null; }
    temp = t;
    if (!t) { updateHandles(); SM.bus.emit("selection"); return; }
    wireElement(t.el, t.id);
    t.layer = new TransformLayer(t.el, Mof(t)).addTo(SM.map);
    t.el.style.opacity = t.opacity;
    SM.state.overlaySel = null;
    O.select(t.id);
  };
  O.temp = () => temp;
  O.refreshTemp = () => { if (temp) { temp.layer.setMatrix(Mof(temp)); temp.el.style.opacity = temp.opacity; updateHandles(); } };
})(window.SM);
