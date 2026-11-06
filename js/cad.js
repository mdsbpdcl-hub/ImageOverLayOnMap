/* =====================================================================
   cad.js — AutoCAD drawings (.dxf, .dwg) on the map.

   1. read the file (DXF: dxf-parser; DWG: LibreDWG compiled to
      WebAssembly, loaded only when a DWG is opened)
   2. normalise entities and explode blocks, arcs, bulges, splines,
      ellipses and hatches into lines, circles, points and text
   3. place it:
        • drawing has real coordinates (UTM, lat/lon, any EPSG) → exact
        • local coordinates → shown as a movable preview that can be
          dragged, rotated, scaled and aligned by control points
   4. convert to ordinary map objects (so KML/KMZ/Shapefile export works)
   ===================================================================== */
"use strict";
(function (SM) {
  const C = {};
  SM.cad = C;
  const ACI_HEX = "000000ff0000ffff0000ff0000ffff0000ffff00ffffffff808080c0c0c0ff0000ff7f7fcc0000cc6666990000994c4c7f00007f3f3f4c00004c2626ff3f00ff9f7fcc3300cc7f66992600995f4c7f1f007f4f3f4c13004c2f26ff7f00ffbf7fcc6600cc9966994c0099724c7f3f007f5f3f4c26004c3926ffbf00ffdf7fcc9900ccb26699720099854c7f5f007f6f3f4c39004c4226ffff00ffff7fcccc00cccc6698980098984c7f7f007f7f3f4c4c004c4c26bfff00dfff7f99cc00b2cc6672980085984c5f7f006f7f3f394c00424c267fff00bfff7f66cc0099cc664c980072984c3f7f005f7f3f264c00394c263fff009fff7f33cc007fcc662698005f984c1f7f004f7f3f134c002f4c2600ff007fff7f00cc0066cc660098004c984c007f003f7f3f004c00264c2600ff3f7fff9f00cc3366cc7f0098264c985f007f1f3f7f4f004c13264c2f00ff7f7fffbf00cc6666cc9900984c4c9872007f3f3f7f5f004c26264c3900ffbf7fffdf00cc9966ccb20098724c9885007f5f3f7f6f004c39264c4200ffff7fffff00cccc66cccc0098984c9898007f7f3f7f7f004c4c264c4c00bfff7fdfff0099cc66b2cc0072984c8598005f7f3f6f7f00394c26424c007fff7fbfff0066cc6699cc004c984c7298003f7f3f5f7f00264c26394c003fff7f9fff0033cc667fcc0026984c5f98001f7f3f4f7f00134c262f4c0000ff7f7fff0000cc6666cc0000984c4c9800007f3f3f7f00004c26264c3f00ff9f7fff3300cc7f66cc2600985f4c981f007f4f3f7f13004c2f264c7f00ffbf7fff6600cc9966cc4c0098724c983f007f5f3f7f26004c39264cbf00ffdf7fff9900ccb266cc720098854c985f007f6f3f7f39004c42264cff00ffff7fffcc00cccc66cc980098984c987f007f7f3f7f4c004c4c264cff00bfff7fdfcc0099cc66b2980072984c857f005f7f3f6f4c00394c2642ff007fff7fbfcc0066cc669998004c984c727f003f7f3f5f4c00264c2639ff003fff7f9fcc0033cc667f980026984c5f7f001f7f3f4f4c00134c262f3333335b5b5b848484adadadd6d6d6ffffff";
  const aci = (i) => "#" + ACI_HEX.substr(i * 6, 6);
  const UNITS = { 1: ["Inches", 0.0254], 2: ["Feet", 0.3048], 3: ["Miles", 1609.344], 4: ["Millimetres", 0.001], 5: ["Centimetres", 0.01], 6: ["Metres", 1], 7: ["Kilometres", 1000], 10: ["Yards", 0.9144], 14: ["Decimetres", 0.1] };
  const UNIT_CHOICES = [[4, "Millimetres (mm)"], [5, "Centimetres (cm)"], [6, "Metres (m)"], [7, "Kilometres (km)"], [1, "Inches"], [2, "Feet"]];
  C.isCad = (name) => /\.(dxf|dwg)$/i.test(name || "");
  const D2R = Math.PI / 180;

  /* ================= reading ================= */
  let dwgLib = null, dwgMod = null;
  async function loadDwg() {
    if (dwgLib) return;
    if (location.protocol === "file:") throw new Error("DWG files can only be opened on the website version (e.g. GitHub Pages), not from a file on disk. Or save the drawing as DXF in AutoCAD and import that.");
    const base = new URL("vendor/libredwg/", document.baseURI).href;
    try {
      dwgMod = await import(base + "dist/libredwg-web.js");
      dwgLib = await dwgMod.LibreDwg.create(base + "wasm");
    } catch (e) {
      throw new Error("DWG support could not be loaded (" + (e.message || e) + "). In AutoCAD use Save As → DXF, then import the DXF.");
    }
  }
  function decodeText(bytes) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (e) { return new TextDecoder("windows-1252").decode(bytes); }
  }
  C.read = async function (file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const head = new TextDecoder("ascii").decode(bytes.subarray(0, 6));
    if (/^AC10\d\d/.test(head)) {
      await loadDwg();
      let db;
      try {
        const dwg = dwgLib.dwg_read_data(bytes.buffer, dwgMod.Dwg_File_Type.DWG);
        if (!dwg) throw new Error("unreadable");
        db = dwgLib.convert(dwg);
        dwgLib.dwg_free(dwg);
      } catch (e) {
        throw new SM.gis.ImportError("This DWG file could not be read (" + (e.message || e) + "). Try saving it as DXF from AutoCAD.");
      }
      return fromLibreDwg(db);
    }
    if (/\.dwg$/i.test(file.name)) throw new SM.gis.ImportError("This is not a valid DWG file");
    let dxf;
    try { dxf = new window.DxfParser().parseSync(decodeText(bytes)); }
    catch (e) { throw new SM.gis.ImportError("This DXF file could not be read: " + (e.message || e) + ". Binary DXF is not supported — save as ASCII DXF."); }
    if (!dxf || !dxf.entities) throw new SM.gis.ImportError("No drawing found in this DXF file");
    return fromDxfParser(dxf);
  };

  const xy = (p) => (p ? [+p.x || 0, +p.y || 0] : [0, 0]);
  const mirrored = (e) => (e.extrusionDirectionZ !== undefined ? e.extrusionDirectionZ < 0 : !!(e.extrusionDirection && e.extrusionDirection.z < -0.5));

  /* ---------- dxf-parser → normalised ---------- */
  function fromDxfParser(dxf) {
    const layers = {};
    Object.values(((dxf.tables || {}).layer || {}).layers || {}).forEach((l) => { layers[l.name] = { ci: l.colorIndex ?? 7, hidden: l.visible === false || !!l.frozen }; });
    const conv = (e) => {
      const base = { layer: e.layer || "0", ci: e.colorIndex ?? 256, mirror: mirrored(e) };
      switch (e.type) {
        case "LINE": return { t: "LINE", pts: e.vertices.map(xy), ...base };
        case "LWPOLYLINE": case "POLYLINE":
          if (e.isPolyfaceMesh || e.is3dPolygonMesh || e.isPolygonMesh) return { t: "SKIP", what: "3D mesh" };
          return { t: "PLINE", v: (e.vertices || []).filter((v) => !v.splineControlPoint).map((v) => [+v.x || 0, +v.y || 0, +v.bulge || 0]), closed: !!e.shape, ...base };
        case "CIRCLE": return { t: "CIRCLE", c: xy(e.center), r: e.radius, ...base };
        case "ARC": return { t: "ARC", c: xy(e.center), r: e.radius, a0: e.startAngle, a1: e.endAngle, ...base };
        case "ELLIPSE": return { t: "ELLIPSE", c: xy(e.center), maj: xy(e.majorAxisEndPoint), ratio: e.axisRatio, a0: e.startAngle ?? 0, a1: e.endAngle ?? 2 * Math.PI, ...base };
        case "SPLINE": return { t: "SPLINE", deg: e.degreeOfSplineCurve || 3, ctrl: (e.controlPoints || []).map(xy), knots: e.knotValues || [], w: e.weights || null, fit: (e.fitPoints || []).map(xy), closed: !!e.closed, ...base };
        case "POINT": return { t: "POINT", p: xy(e.position), ...base };
        case "TEXT": {
          const useEnd = (e.halign || e.valign) && e.endPoint && (e.endPoint.x || e.endPoint.y);
          return { t: "TEXT", p: xy(useEnd ? e.endPoint : e.startPoint), text: e.text, h: e.textHeight || 1, rot: (e.rotation || 0) * D2R, ...base };
        }
        case "MTEXT": return { t: "TEXT", p: xy(e.position), text: cleanMText(e.text), h: e.height || 1, rot: e.directionVector ? Math.atan2(e.directionVector.y, e.directionVector.x) : (e.rotation || 0) * D2R, ...base };
        case "INSERT": return { t: "INSERT", name: e.name, p: xy(e.position), sx: e.xScale ?? 1, sy: e.yScale ?? 1, rot: (e.rotation || 0) * D2R, cols: e.columnCount || 1, rows: e.rowCount || 1, cs: e.columnSpacing || 0, rs: e.rowSpacing || 0, ...base };
        case "DIMENSION": return e.block ? { t: "INSERT", name: e.block, p: [0, 0], sx: 1, sy: 1, rot: 0, cols: 1, rows: 1, dim: true, ...base, mirror: false } : { t: "SKIP", what: "DIMENSION" };
        case "SOLID": { const p = (e.points || []).map(xy); return p.length >= 3 ? { t: "FILL", loops: [p.length === 4 ? [p[0], p[1], p[3], p[2]] : p], solid: true, ...base } : null; }
        case "3DFACE": return { t: "FILL", loops: [(e.vertices || []).map(xy)], ...base };
        default: return { t: "SKIP", what: e.type };
      }
    };
    const blocks = {};
    Object.entries(dxf.blocks || {}).forEach(([name, b]) => { blocks[name] = { base: xy(b.position), ents: (b.entities || []).map(conv).filter(Boolean) }; });
    const ents = (dxf.entities || []).filter((e) => !e.inPaperSpace).map(conv).filter(Boolean);
    return { source: "DXF", insunits: (dxf.header || {}).$INSUNITS ?? 0, layers, blocks, ents };
  }

  /* ---------- LibreDWG → normalised ---------- */
  function fromLibreDwg(db) {
    const layers = {};
    ((db.tables.LAYER || {}).entries || []).forEach((l) => { layers[l.name] = { ci: Math.abs(l.colorIndex ?? 7), hidden: !!(l.off || l.frozen) || (l.colorIndex < 0) }; });
    const txt = (t, p, h, rot, base) => ({ t: "TEXT", p, text: t, h: h || 1, rot: rot || 0, ...base });
    const conv = (e) => {
      const base = { layer: e.layer || "0", ci: e.colorIndex ?? 256, mirror: mirrored(e) };
      switch (e.type) {
        case "LINE": return { t: "LINE", pts: [xy(e.startPoint), xy(e.endPoint)], ...base };
        case "LWPOLYLINE": return { t: "PLINE", v: (e.vertices || []).map((v) => [v.x, v.y, v.bulge || 0]), closed: !!((e.flag & 1) || (e.flag & 512)), ...base };
        case "POLYLINE2D": case "POLYLINE3D": case "POLYLINE":
          return { t: "PLINE", v: (e.vertices || []).filter((v) => !(v.flag & 16)).map((v) => [v.x, v.y, v.bulge || 0]), closed: !!(e.flag & 1), ...base };
        case "CIRCLE": return { t: "CIRCLE", c: xy(e.center), r: e.radius, ...base };
        case "ARC": return { t: "ARC", c: xy(e.center), r: e.radius, a0: e.startAngle, a1: e.endAngle, ...base };
        case "ELLIPSE": return { t: "ELLIPSE", c: xy(e.center), maj: xy(e.majorAxisEndPoint), ratio: e.axisRatio, a0: e.startAngle ?? 0, a1: e.endAngle ?? 2 * Math.PI, ...base };
        case "SPLINE": return { t: "SPLINE", deg: e.degree || 3, ctrl: (e.controlPoints || []).map(xy), knots: e.knots || [], w: e.weights && e.weights.length ? e.weights : null, fit: (e.fitPoints || []).map(xy), closed: !!(e.flag & 1), ...base };
        case "POINT": return { t: "POINT", p: xy(e.position), ...base };
        case "TEXT": {
          const useEnd = (e.halign || e.valign) && e.endPoint && (e.endPoint.x || e.endPoint.y);
          return txt(e.text, xy(useEnd ? e.endPoint : e.startPoint), e.textHeight, e.rotation, base);
        }
        case "MTEXT": return txt(cleanMText(e.text), xy(e.insertionPoint), e.textHeight, e.direction && (e.direction.x || e.direction.y) ? Math.atan2(e.direction.y, e.direction.x) : e.rotation, base);
        case "INSERT": return {
          t: "INSERT", name: e.name, p: xy(e.insertionPoint), sx: e.xScale ?? 1, sy: e.yScale ?? 1, rot: e.rotation || 0,
          cols: e.columnCount || 1, rows: e.rowCount || 1, cs: e.columnSpacing || 0, rs: e.rowSpacing || 0, ...base,
          attribs: (e.attribs || []).filter((a) => a.text && a.text.text).map((a) => txt(a.text.text, xy(a.text.startPoint), a.text.textHeight, a.text.rotation, { layer: a.layer || base.layer, ci: a.colorIndex ?? 256, mirror: false })),
        };
        case "DIMENSION": return e.name ? { t: "INSERT", name: e.name, p: [0, 0], sx: 1, sy: 1, rot: 0, cols: 1, rows: 1, dim: true, ...base, mirror: false } : { t: "SKIP", what: "DIMENSION" };
        case "HATCH": {
          const loops = (e.boundaryPaths || []).map(hatchLoop).filter((l) => l.length >= 3);
          return loops.length ? { t: "FILL", loops, hatch: true, solid: !!e.solidFill, ...base } : { t: "SKIP", what: "HATCH" };
        }
        case "SOLID": { const p = [e.corner1, e.corner2, e.corner4, e.corner3].filter(Boolean).map(xy); return { t: "FILL", loops: [p], solid: true, ...base }; }
        case "3DFACE": return { t: "FILL", loops: [[e.corner1, e.corner2, e.corner3, e.corner4].filter(Boolean).map(xy)], ...base };
        case "MLINE": return { t: "PLINE", v: (e.vertices || []).map((v) => [v.vertex.x, v.vertex.y, 0]), closed: !!(e.flags & 2), ...base };
        default: return { t: "SKIP", what: e.type };
      }
    };
    const recs = (db.tables.BLOCK_RECORD || {}).entries || [];
    const model = recs.find((b) => /^\*model_space$/i.test(b.name));
    const paperIds = new Set(recs.filter((b) => /^\*paper_space/i.test(b.name)).map((b) => b.handle));
    const blocks = {};
    recs.forEach((b) => { if (!/^\*(model|paper)_space/i.test(b.name)) blocks[b.name] = { base: xy(b.basePoint), ents: (b.entities || []).map(conv).filter(Boolean) }; });
    const ents = db.entities.filter((e) => (model && e.ownerBlockRecordSoftId ? e.ownerBlockRecordSoftId === model.handle : !paperIds.has(e.ownerBlockRecordSoftId))).map(conv).filter(Boolean);
    return { source: "DWG", insunits: (db.header || {}).INSUNITS ?? 0, layers, blocks, ents };
  }
  function hatchLoop(path) {
    const pts = [];
    if (path.vertices && path.vertices.length) {
      const v = path.vertices.map((p) => [p.x, p.y, p.bulge || 0]);
      return plinePoints(v, true);
    }
    (path.edges || []).forEach((ed) => {
      if (ed.type === 1) { pts.push(xy(ed.start), xy(ed.end)); }
      else if (ed.type === 2) {
        let a0 = ed.startAngle, a1 = ed.endAngle;
        if (ed.isCCW === false || ed.isCCW === 0) { const t = -a0; a0 = -a1; a1 = t; }
        arcPoints(xy(ed.center), ed.radius, a0, a1).forEach((p) => pts.push(p));
      } else if (ed.type === 3) {
        const maj = xy(ed.end || ed.majorAxisEndPoint), ratio = ed.lengthOfMinorAxis || ed.axisRatio || 1;
        ellipsePoints(xy(ed.center), maj, ratio, ed.startAngle || 0, ed.endAngle || 2 * Math.PI).forEach((p) => pts.push(p));
      } else if (ed.type === 4) {
        splinePoints({ deg: ed.degree || 3, ctrl: (ed.controlPoints || []).map(xy), knots: ed.knots || [], fit: (ed.fitDatum || ed.fitPoints || []).map(xy) }).forEach((p) => pts.push(p));
      }
    });
    return dedupe(pts);
  }

  function cleanMText(t) {
    return String(t || "")
      .replace(/\\P/g, "\n").replace(/\\~/g, " ").replace(/\\\\/g, "\u0000")
      .replace(/\\[ACcFfHhQqTtWw][^;]*;/g, "").replace(/\\S([^^;]*)[\^#/]([^;]*);/g, "$1/$2")
      .replace(/\\[LlOoKkNn]/g, "").replace(/[{}]/g, "").replace(/\u0000/g, "\\")
      .replace(/%%[cC]/g, "Ø").replace(/%%[dD]/g, "°").replace(/%%[pP]/g, "±").replace(/%%%/g, "%").trim();
  }
  C.cleanMText = cleanMText;

  /* ================= geometry ================= */
  function dedupe(pts) { const o = []; pts.forEach((p) => { const l = o[o.length - 1]; if (!l || Math.abs(l[0] - p[0]) > 1e-12 || Math.abs(l[1] - p[1]) > 1e-12) o.push(p); }); return o; }
  function arcPoints(c, r, a0, a1, close) {
    let sweep = a1 - a0;
    while (sweep <= 0) sweep += 2 * Math.PI;
    if (close) sweep = 2 * Math.PI;
    const n = Math.max(8, Math.ceil(sweep / (5 * D2R)));
    const out = [];
    for (let i = 0; i <= n; i++) { const a = a0 + (sweep * i) / n; out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]); }
    return out;
  }
  function ellipsePoints(c, maj, ratio, t0, t1) {
    const mn = [-maj[1] * ratio, maj[0] * ratio];
    let sweep = t1 - t0;
    while (sweep <= 0) sweep += 2 * Math.PI;
    const n = Math.max(16, Math.ceil(sweep / (4 * D2R))), out = [];
    for (let i = 0; i <= n; i++) { const t = t0 + (sweep * i) / n; out.push([c[0] + maj[0] * Math.cos(t) + mn[0] * Math.sin(t), c[1] + maj[1] * Math.cos(t) + mn[1] * Math.sin(t)]); }
    return out;
  }
  /** Polyline vertices [x, y, bulge] → points, expanding bulge arcs. */
  function plinePoints(v, closed) {
    const out = [];
    const n = v.length;
    for (let i = 0; i < n; i++) {
      const p1 = v[i];
      out.push([p1[0], p1[1]]);
      if (i === n - 1 && !closed) break;
      const p2 = v[(i + 1) % n], b = p1[2];
      if (!b || Math.abs(b) < 1e-9) continue;
      const ang = 4 * Math.atan(b), dx = p2[0] - p1[0], dy = p2[1] - p1[1], d = Math.hypot(dx, dy);
      if (d === 0) continue;
      const r = d / (2 * Math.sin(ang / 2));
      const a = Math.atan2(dy, dx) + (Math.PI / 2 - ang / 2);
      const cx = p1[0] + r * Math.cos(a), cy = p1[1] + r * Math.sin(a);
      const s = Math.atan2(p1[1] - cy, p1[0] - cx), rr = Math.hypot(p1[0] - cx, p1[1] - cy);
      const steps = Math.max(4, Math.ceil(Math.abs(ang) / (5 * D2R)));
      for (let k = 1; k < steps; k++) { const t = s + (ang * k) / steps; out.push([cx + rr * Math.cos(t), cy + rr * Math.sin(t)]); }
    }
    if (closed && out.length > 2) out.push(out[0].slice());
    return dedupe(out);
  }
  function splinePoints(s) {
    const { deg, ctrl, knots, w, fit } = s;
    const n = ctrl.length;
    if (n >= deg + 1 && knots.length === n + deg + 1) {
      const lo = knots[deg], hi = knots[n], N = Math.min(2000, Math.max(24, n * 10)), out = [];
      for (let i = 0; i <= N; i++) out.push(deBoor(lo + ((hi - lo) * i) / N, deg, ctrl, knots, w, i === N));
      return dedupe(out);
    }
    const pts = fit && fit.length >= 2 ? fit : ctrl;
    if (pts.length < 3) return pts.slice();
    // Catmull-Rom through fit points
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      for (let k = 0; k < 10; k++) {
        const t = k / 10, t2 = t * t, t3 = t2 * t;
        out.push([0, 1].map((j) => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)));
      }
    }
    out.push(pts[pts.length - 1].slice());
    return out;
  }
  function deBoor(t, p, ctrl, U, w, last) {
    const n = ctrl.length;
    let k = p;
    if (last) k = n - 1; else { while (k < n - 1 && t >= U[k + 1]) k++; }
    const d = [];
    for (let j = 0; j <= p; j++) {
      const c = ctrl[k - p + j], wt = w ? w[k - p + j] ?? 1 : 1;
      d.push([c[0] * wt, c[1] * wt, wt]);
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = k - p + j, den = U[i + p - r + 1] - U[i];
        const a = den === 0 ? 0 : (t - U[i]) / den;
        d[j] = [0, 1, 2].map((q) => (1 - a) * d[j - 1][q] + a * d[j][q]);
      }
    }
    return [d[p][0] / d[p][2], d[p][1] / d[p][2]];
  }

  /* ================= explode into simple shapes ================= */
  const MX = [-1, 0, 0, 1, 0, 0];
  /**
   * Returns { shapes, layerCounts, skipped }.
   * shapes: {k:'line'|'circle'|'point'|'text'|'fill', layer, color, pts|c,r|p,text,h,rot|loops, closed, dim}
   */
  C.explode = function (model, opts) {
    opts = opts || {};
    const xf = SM.xf, shapes = [], layerCounts = {}, skipped = {};
    const want = opts.layers ? new Set(opts.layers) : null;
    const layerOf = (e, parent) => (e.layer === "0" && parent ? parent : e.layer);
    const colorOf = (e, layer, parentColor) => {
      let ci = e.ci;
      if (ci === 0) return parentColor || aci(7);
      if (ci === 256 || ci === undefined || ci === null) ci = (model.layers[layer] || {}).ci ?? 7;
      ci = Math.abs(ci);
      return aci(ci >= 1 && ci <= 255 ? ci : 7);
    };
    let budget = 400000; // safety limit on exploded vertices
    const walk = (ents, T, parentLayer, parentColor, depth, inDim) => {
      if (depth > 12) return;
      for (const e of ents) {
        if (!e || budget <= 0) continue;
        if (e.t === "SKIP") { skipped[e.what] = (skipped[e.what] || 0) + 1; continue; }
        const layer = layerOf(e, parentLayer);
        const L = model.layers[layer];
        if (L && L.hidden && !opts.includeHidden) continue;
        if (want && !want.has(layer) && e.t !== "INSERT") continue; // blocks are entered: their parts may be on wanted layers
        const color = colorOf(e, layer, parentColor);
        const M = e.mirror ? xf.mul(T, MX) : T;
        const P = (pts) => pts.map((p) => xf.apply(M, p));
        const isDim = inDim || !!e.dim;
        const finite = (s) => [s.pts, s.c, s.p, s.loops].every((v) => !v || JSON.stringify(v).indexOf("null") < 0) && (s.r === undefined || isFinite(s.r));
        const add = (s) => {
          if (want && !want.has(layer)) return;
          if (!finite(s)) { skipped["invalid geometry"] = (skipped["invalid geometry"] || 0) + 1; return; }
          s.layer = layer; s.color = color; s.dim = isDim;
          shapes.push(s);
          layerCounts[layer] = (layerCounts[layer] || 0) + 1;
          budget -= s.pts ? s.pts.length : 1;
        };
        switch (e.t) {
          case "LINE": add({ k: "line", pts: P(e.pts) }); break;
          case "PLINE": { if (e.v.length < 2) break; add({ k: "line", pts: P(plinePoints(e.v, e.closed)), closed: e.closed && e.v.length > 2 }); break; }
          case "CIRCLE": {
            const d = xf.decompose(M);
            if (!d.skewed) add({ k: "circle", c: xf.apply(M, e.c), r: e.r * d.scale });
            else add({ k: "line", pts: P(arcPoints(e.c, e.r, 0, 0, true)), closed: true });
            break;
          }
          case "ARC": add({ k: "line", pts: P(arcPoints(e.c, e.r, e.a0, e.a1)) }); break;
          case "ELLIPSE": {
            const full = Math.abs(e.a1 - e.a0 - 2 * Math.PI) < 1e-6 || (e.a0 === 0 && e.a1 === 0);
            add({ k: "line", pts: P(ellipsePoints(e.c, e.maj, e.ratio, e.a0, full ? e.a0 + 2 * Math.PI : e.a1)), closed: full });
            break;
          }
          case "SPLINE": { const pts = splinePoints(e); if (pts.length >= 2) add({ k: "line", pts: P(pts), closed: e.closed }); break; }
          case "POINT": add({ k: "point", p: xf.apply(M, e.p) }); break;
          case "TEXT": {
            if (!e.text || !String(e.text).trim()) break;
            const d = xf.decompose(M);
            add({ k: "text", p: xf.apply(M, e.p), text: String(e.text), h: e.h * d.scale, rot: e.rot + d.rot });
            break;
          }
          case "FILL": add({ k: "fill", loops: e.loops.map(P), solid: !!e.solid, hatch: !!e.hatch }); break;
          case "INSERT": {
            const b = model.blocks[e.name];
            if (!b) { skipped["missing block"] = (skipped["missing block"] || 0) + 1; break; }
            const rows = Math.max(1, Math.min(e.rows || 1, 100)), cols = Math.max(1, Math.min(e.cols || 1, 100));
            for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
              let Ti = xf.mul(M, xf.translate(e.p[0], e.p[1]));
              Ti = xf.mul(Ti, xf.rotate(e.rot));
              Ti = xf.mul(Ti, xf.translate(c * (e.cs || 0), r * (e.rs || 0)));
              Ti = xf.mul(Ti, xf.scale(e.sx || 1, e.sy || 1));
              Ti = xf.mul(Ti, xf.translate(-b.base[0], -b.base[1]));
              walk(b.ents, Ti, layer, color, depth + 1, isDim);
            }
            (e.attribs || []).forEach((a) => walk([a], T, layer, color, depth + 1, isDim));
            break;
          }
        }
      }
    };
    walk(model.ents, SM.xf.identity(), null, null, 0, false);
    return { shapes, layerCounts, skipped, truncated: budget <= 0 };
  };

  /** All layer names used by model-space content (for the layer list), with counts. */
  C.layerSummary = function (model) {
    const r = C.explode(model, { includeHidden: false });
    return r;
  };

  /** Bounding box robust to stray far-away objects (0.5–99.5 percentile). */
  function extents(shapes) {
    const xs = [], ys = [];
    shapes.forEach((s) => {
      if (s.pts) s.pts.forEach((p) => { xs.push(p[0]); ys.push(p[1]); });
      else if (s.loops) s.loops.forEach((l) => l.forEach((p) => { xs.push(p[0]); ys.push(p[1]); }));
      else if (s.c) { xs.push(s.c[0] - s.r, s.c[0] + s.r); ys.push(s.c[1] - s.r, s.c[1] + s.r); }
      else if (s.p) { xs.push(s.p[0]); ys.push(s.p[1]); }
    });
    if (!xs.length) return null;
    const pick = (arr, q) => { const a = Float64Array.from(arr).sort(); return a[Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))))]; };
    const robust = xs.length > 400;
    return {
      full: [Math.min(...xs.slice(0, 1e6)), Math.min(...ys.slice(0, 1e6)), Math.max(...xs.slice(0, 1e6)), Math.max(...ys.slice(0, 1e6))],
      core: robust ? [pick(xs, 0.005), pick(ys, 0.005), pick(xs, 0.995), pick(ys, 0.995)] : null,
    };
  }

  /* ================= import dialog ================= */
  C.importFile = async function (file) {
    SM.toast(/\.dwg$/i.test(file.name) ? "Reading DWG drawing… (the first DWG takes a few seconds to load)" : "Reading drawing…", "", 2500);
    const model = await C.read(file);
    const all = C.explode(model, {});
    if (!all.shapes.length) throw new SM.gis.ImportError("No drawable objects found in model space" + (Object.keys(all.skipped).length ? " (only " + Object.keys(all.skipped).join(", ") + ")" : ""));
    const ext = extents(all.shapes), box = ext.core || ext.full;
    const stem = file.name.replace(/\.[^.]+$/, "");
    const c = SM.map.getCenter();
    const guess = SM.crs.guess(...box);
    const preferId = guess === "utm" ? "utm" + SM.crs.utmZoneOf(c.lng) + "n" : guess === "wgs84" ? "wgs84" : "local";
    const picker = SM.crs.picker(preferId, c.lng, c.lat);
    picker.select.prepend(SM.el("option", { value: "local", text: "Not on a map grid — I will place it myself (local coordinates)", selected: preferId === "local" }));
    if (preferId === "local") picker.select.value = "local";
    const units = SM.el("select", { class: "field" }, UNIT_CHOICES.map(([v, t]) => SM.el("option", { value: v, text: t, selected: v === (UNITS[model.insunits] ? model.insunits : 6) })));
    const sizeInfo = SM.el("div", { class: "muted" });
    const updSize = () => {
      const u = UNITS[+units.value][1], w = (box[2] - box[0]) * u, h = (box[3] - box[1]) * u;
      sizeInfo.textContent = picker.select.value === "local" ? `Drawing size: about ${SM.fmtLength(w)} × ${SM.fmtLength(h)}. If that looks wrong, change the units.` : `Extent: X ${box[0].toFixed(1)} … ${box[2].toFixed(1)}, Y ${box[1].toFixed(1)} … ${box[3].toFixed(1)}`;
      unitsRow.forEach((e) => e.classList.toggle("hidden", picker.select.value !== "local"));
    };
    const unitsRow = [SM.el("label", { text: "Drawing units" }), units];
    picker.select.addEventListener("change", updSize); units.addEventListener("change", updSize);
    const layerNames = Object.keys(all.layerCounts).sort();
    const layerList = SM.el("div", { class: "check-list" }, layerNames.map((n) => SM.el("label", {}, SM.el("input", { type: "checkbox", value: n, checked: true }),
      SM.el("span", { class: "swatch", style: { background: aci(Math.abs((model.layers[n] || {}).ci ?? 7) || 7) } }), `${n} (${all.layerCounts[n]})`)));
    const counts = { text: 0, point: 0, dim: 0, fill: 0 };
    all.shapes.forEach((s) => { if (s.dim) counts.dim++; else if (s.k === "text") counts.text++; else if (s.k === "point") counts.point++; else if (s.k === "fill") counts.fill++; });
    const cb = (label, on, n) => { const i = SM.el("input", { type: "checkbox", checked: on, disabled: n === 0 }); return [i, SM.el("label", { class: "check" }, i, label + (n !== undefined ? ` (${n})` : ""))]; };
    const [cText, lText] = cb("Text labels", counts.text <= 600, counts.text);
    const [cPts, lPts] = cb("Points", counts.point <= 200, counts.point);
    const [cDim, lDim] = cb("Dimensions", false, counts.dim);
    const [cFill, lFill] = cb("Hatches and filled areas", counts.fill <= 500, counts.fill);
    const [cSplit, lSplit] = cb("A separate map layer for each CAD layer", layerNames.length <= 40);
    const [cKml, lKml] = cb("Download as KML straight after placing", false);
    const skippedTxt = Object.entries(all.skipped).map(([k, v]) => `${v} ${k}`).join(", ");
    const body = SM.el("div", { class: "form-grid" },
      SM.el("label", { text: "Drawing" }), SM.el("div", { text: `${file.name} — ${model.source}, ${all.shapes.length} objects in ${layerNames.length} layers` }),
      SM.el("label", { text: "Coordinates" }), picker.el,
      ...unitsRow,
      SM.el("label", { text: "" }), sizeInfo,
      SM.el("label", { text: "CAD layers" }), SM.el("div", {}, layerList, SM.el("div", { class: "actions", style: { marginTop: "4px" } },
        SM.el("button", { class: "mini-btn", text: "All", onclick: () => SM.$$("input", layerList).forEach((i) => { i.checked = true; }) }),
        SM.el("button", { class: "mini-btn", text: "None", onclick: () => SM.$$("input", layerList).forEach((i) => { i.checked = false; }) }))),
      SM.el("label", { text: "Include" }), SM.el("div", { style: { display: "grid", gap: "3px" } }, lText, lPts, lDim, lFill),
      SM.el("label", { text: "Options" }), SM.el("div", { style: { display: "grid", gap: "3px" } }, lSplit, lKml),
      skippedTxt ? SM.el("div", { class: "full warn-box", text: "Not converted (no 2-D map equivalent): " + skippedTxt } ) : null,
      SM.el("div", { class: "full muted", text: "Local drawings appear as a preview you can drag, rotate and align by points before they become map objects." }));
    updSize();
    SM.modal({
      title: "Import AutoCAD drawing", body, wide: true,
      buttons: [{ label: "Cancel" }, {
        label: "Continue", cls: "primary", action: async () => {
          const layers = SM.$$("input:checked", layerList).map((i) => i.value);
          if (!layers.length) { SM.toast("Tick at least one CAD layer", "error"); return false; }
          const opts = { layers, text: cText.checked, points: cPts.checked, dims: cDim.checked, fills: cFill.checked, split: cSplit.checked, kml: cKml.checked, stem };
          const ex = C.explode(model, { layers });
          ex.shapes = ex.shapes.filter((s) => (s.dim ? opts.dims : s.k === "text" ? opts.text : s.k === "point" ? opts.points : s.k === "fill" ? opts.fills : true));
          if (!ex.shapes.length) { SM.toast("Nothing left to import with these options", "error"); return false; }
          if (ex.shapes.length > 6000 && !(await SM.confirm("Large drawing", `This will create ${ex.shapes.length} map objects, which can make the map slow. Untick some layers, or continue anyway?`, "Continue"))) return false;
          if (picker.select.value === "local") startPlacement(ex, +units.value, opts, file.name);
          else {
            let def;
            try { def = picker.value(); } catch (e) { SM.toast(e.message, "error"); return false; }
            const conv = SM.crs.toWgs84(def);
            const isGeo = /longlat|GEOGCS/i.test(def) && !/PROJCS/i.test(def);
            finish(ex.shapes, (p) => conv(p), isGeo ? null : 1, opts);
          }
        },
      }],
    });
  };

  /* ================= interactive placement ================= */
  function renderPreview(shapes, box) {
    const pad = 0.02 * Math.max(box[2] - box[0], box[3] - box[1], 1e-9);
    const x0 = box[0] - pad, y0 = box[1] - pad, x1 = box[2] + pad, y1 = box[3] + pad;
    const LONG = 3200, k = LONG / Math.max(x1 - x0, y1 - y0);
    const W = Math.max(2, Math.round((x1 - x0) * k)), H = Math.max(2, Math.round((y1 - y0) * k));
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    ctx.lineJoin = ctx.lineCap = "round";
    const tx = (p) => [(p[0] - x0) * k, (y1 - p[1]) * k];
    const lw = Math.max(1.5, LONG / 900);
    shapes.forEach((s) => {
      ctx.strokeStyle = ctx.fillStyle = visible(s.color);
      ctx.lineWidth = lw;
      if (s.k === "line") { ctx.beginPath(); s.pts.forEach((p, i) => { const q = tx(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); if (s.closed) ctx.closePath(); ctx.stroke(); }
      else if (s.k === "circle") { const q = tx(s.c); ctx.beginPath(); ctx.arc(q[0], q[1], s.r * k, 0, 2 * Math.PI); ctx.stroke(); }
      else if (s.k === "fill") { ctx.globalAlpha = s.solid ? 0.55 : 0.3; ctx.beginPath(); s.loops.forEach((l) => l.forEach((p, i) => { const q = tx(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); })); ctx.fill("evenodd"); ctx.globalAlpha = 1; }
      else if (s.k === "point") { const q = tx(s.p); ctx.beginPath(); ctx.arc(q[0], q[1], lw * 2, 0, 2 * Math.PI); ctx.fill(); }
      else if (s.k === "text") {
        const q = tx(s.p), size = Math.max(6, s.h * k);
        if (size > 400) return;
        ctx.save(); ctx.translate(q[0], q[1]); ctx.rotate(-s.rot);
        ctx.font = `${size}px Arial, sans-serif`; ctx.textBaseline = "alphabetic";
        String(s.text).split("\n").forEach((ln, i) => ctx.fillText(ln, 0, i * size * 1.25));
        ctx.restore();
      }
    });
    return { canvas: cv, B: [1 / k, 0, 0, -1 / k, x0, y1] };
  }
  /** Very dark CAD colours (meant for white paper) become white on satellite imagery. */
  function visible(hex) {
    const h = hex.replace("#", ""), l = (0.2126 * parseInt(h.slice(0, 2), 16) + 0.7152 * parseInt(h.slice(2, 4), 16) + 0.0722 * parseInt(h.slice(4, 6), 16)) / 255;
    return l < 0.18 ? "#ffffff" : hex;
  }

  function startPlacement(ex, unitCode, opts, fileName) {
    const ext = extents(ex.shapes), box = ext.core || ext.full;
    const { canvas, B } = renderPreview(ex.shapes, box);
    // snapping targets: every vertex, circle centre, point and text anchor
    const verts = [];
    ex.shapes.forEach((s) => {
      if (s.pts) s.pts.forEach((p) => verts.push(p[0], p[1]));
      else if (s.loops) s.loops.forEach((l) => l.forEach((p) => verts.push(p[0], p[1])));
      else if (s.c) verts.push(s.c[0], s.c[1]);
      else if (s.p) verts.push(s.p[0], s.p[1]);
    });
    const V = Float64Array.from(verts);
    const snap = (m, tol) => {
      let best = -1, bd = tol * tol;
      for (let i = 0; i < V.length; i += 2) { const dx = V[i] - m[0], dy = V[i + 1] - m[1], d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } }
      return best >= 0 ? [V[best], V[best + 1]] : null;
    };
    const c = SM.map.getCenter(), F = SM.crs.localFrame(c.lat, c.lng);
    const u = UNITS[unitCode][1];
    const mx = (box[0] + box[2]) / 2, my = (box[1] + box[3]) / 2;
    const Pe = [u, 0, 0, u, -u * mx, -u * my]; // drawing units → ground metres around the map centre
    const t = {
      id: "cad-temp", name: fileName, el: canvas, w: canvas.width, h: canvas.height, B,
      P: SM.xf.mul(F.J, Pe), opacity: 0.9, visible: true, locked: false,
      trueScale: true, unitCode, metresPerUnit: u, snap, cad: { ex, opts, box },
    };
    SM.tools.set("select");
    SM.overlays.setTemp(t);
    const fit = () => { const b = L.latLngBounds(SM.overlays.cornersLatLng(t)); SM.map.fitBounds(b, { padding: [60, 60], maxZoom: 20 }); };
    fit();
    SM.toast("Drag the drawing into place, rotate with the round handle, then use “Align by points” for accuracy.", "", 6500);
  }

  C.renderPlacement = function (root, t) {
    const row = (label, ...c) => SM.el("div", { class: "prow" }, SM.el("label", { text: label }), SM.el("div", { class: "ctrl" }, ...c));
    const btn = (icon, label, fn, cls) => { const b = SM.el("button", { class: "mini-btn " + (cls || "") }, icon ? SM.icon(icon) : null, label); b.addEventListener("click", fn); return b; };
    if (SM.overlays.aligning()) return; // align panel is drawn by overlays.js
    const units = SM.el("select", {}, UNIT_CHOICES.map(([v, txt]) => SM.el("option", { value: v, text: txt, selected: v === t.unitCode })));
    const ts = SM.el("input", { type: "checkbox", checked: t.trueScale });
    const rot = SM.el("input", { type: "number", step: 0.1, value: SM.overlays.rotationDeg(t).toFixed(2) });
    const op = SM.el("input", { type: "range", min: 0.2, max: 1, step: 0.05, value: t.opacity });
    const resetScale = () => { t.P = trueScaleP(t); SM.overlays.refreshTemp(); };
    units.addEventListener("change", () => { t.unitCode = +units.value; t.metresPerUnit = UNITS[t.unitCode][1]; if (t.trueScale) resetScale(); SM.props.render(); });
    ts.addEventListener("change", () => { t.trueScale = ts.checked; if (ts.checked) resetScale(); SM.overlays.refreshTemp(); SM.props.render(); });
    rot.addEventListener("change", () => { if (isFinite(+rot.value)) { SM.overlays.setRotation(t, +rot.value); if (t.trueScale) t.P = trueScaleP(t); SM.overlays.refreshTemp(); } });
    op.addEventListener("input", () => { t.opacity = +op.value; SM.overlays.refreshTemp(); });
    const d = SM.xf.decompose(SM.overlays.enuOf(t).Pe);
    const mPerUnit = d.scale;
    const size = [(t.cad.box[2] - t.cad.box[0]) * mPerUnit, (t.cad.box[3] - t.cad.box[1]) * mPerUnit];
    root.append(
      SM.el("div", { class: "pgroup" }, SM.el("h4", {}, SM.el("span", { text: "Place drawing" }), SM.el("span", { class: "kind-badge", text: t.cad.ex.shapes.length + " objects" })),
        SM.el("div", { class: "tips", text: t.name }),
        row("Units", units),
        row("", SM.el("label", { class: "check" }, ts, "Keep true scale")),
        row("Scale", SM.el("span", { class: "muted", text: `1 unit = ${SM.fmtLength(mPerUnit)}` + (SM.overlays.isStretched(t) ? " (stretched)" : "") })),
        row("Size", SM.el("span", { class: "muted", text: `${SM.fmtLength(size[0])} × ${SM.fmtLength(size[1])}` })),
        row("Rotation °", rot),
        row("See-through", op),
        SM.el("div", { class: "actions", style: { marginTop: "8px" } },
          btn("target", "Align by points…", () => SM.overlays.startAlign(t.id), "primary"),
          btn("check", "Place on map", () => C.place(), "primary"),
          btn("x", "Cancel", () => { SM.overlays.setTemp(null); SM.toast("Drawing import cancelled"); }))),
      SM.el("div", { class: "pgroup" }, SM.el("h4", { text: "How to place it" }), SM.el("div", { class: "tips", html:
        "<ul><li><b>Drag</b> the drawing (or the ✥ handle) to move it, the <b>round</b> handle to rotate it.</li>" +
        "<li>Best accuracy: <b>Align by points</b> — click a corner on the drawing (it snaps to the exact CAD point), then the same corner on the satellite map. One point moves it; two or more also turn it.</li>" +
        "<li>Untick <b>Keep true scale</b> only if the drawing was not drawn to scale.</li>" +
        "<li>Click <b>Place on map</b> to turn it into map objects you can edit and export to KML.</li></ul>" })));
  };

  /** Drawing → ground metres with exactly the unit scale, keeping position and direction. */
  function enuTrueScale(t) {
    const { F, Pe } = SM.overlays.enuOf(t);
    const box = t.cad.box, mc = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], ce = SM.xf.apply(Pe, mc);
    const rot = Math.atan2(Pe[1], Pe[0]), u = t.metresPerUnit;
    let E = SM.xf.mul(SM.xf.rotate(rot), SM.xf.scale(u));
    E = SM.xf.mul(SM.xf.translate(ce[0], ce[1]), SM.xf.mul(E, SM.xf.translate(-mc[0], -mc[1])));
    return { F, Pe: E };
  }
  function trueScaleP(t) { const { F, Pe } = enuTrueScale(t); return SM.xf.mul(F.J, Pe); }

  C.place = function () {
    const t = SM.overlays.temp();
    if (!t) return;
    // exact conversion: drawing → local ground metres (Transverse Mercator at the drawing) → WGS84
    const { F, Pe } = t.trueScale ? enuTrueScale(t) : SM.overlays.enuOf(t);
    const d = SM.xf.decompose(Pe);
    const map = (p) => F.toLonLat(SM.xf.apply(Pe, p));
    SM.overlays.setTemp(null);
    finish(t.cad.ex.shapes, map, d.skewed ? null : d.scale, t.cad.opts);
  };

  /* ================= convert to map objects ================= */
  function finish(shapes, toLonLat, circleScale, opts) {
    const layers = [], byLayer = {}, features = [];
    const layerFor = (cadLayer) => {
      const key = opts.split ? cadLayer : "_all";
      if (!byLayer[key]) { byLayer[key] = SM.uid(); layers.push({ id: byLayer[key], name: opts.split ? `${opts.stem} · ${cadLayer}` : opts.stem, visible: true, locked: false }); }
      return byLayer[key];
    };
    let bad = 0;
    const push = (geom, kind, s, extra) => {
      const col = visible(s.color);
      features.push({ type: "Feature", geometry: geom, properties: Object.assign({
        kind, layerId: layerFor(s.layer), name: s.layer, description: "CAD layer: " + s.layer, cadLayer: s.layer,
        style: { color: col, weight: 2, opacity: 1, fill: false, fillColor: col, fillOpacity: 0.25 },
      }, extra || {}) });
    };
    shapes.forEach((s) => {
      try {
        if (s.k === "line") {
          const pts = s.pts.map(toLonLat);
          if (s.closed && pts.length >= 4) push({ type: "Polygon", coordinates: [pts] }, "polygon", s);
          else if (pts.length >= 2) push({ type: "LineString", coordinates: pts }, "polyline", s);
        } else if (s.k === "circle") {
          if (circleScale) push({ type: "Point", coordinates: toLonLat(s.c) }, "circle", s, { radius: s.r * circleScale, style: { color: visible(s.color), weight: 2, fill: false, fillColor: visible(s.color), fillOpacity: 0 } });
          else push({ type: "Polygon", coordinates: [arcPoints(s.c, s.r, 0, 0, true).map(toLonLat)] }, "polygon", s);
        } else if (s.k === "fill") {
          s.loops.forEach((l) => { if (l.length >= 3) push({ type: "Polygon", coordinates: [l.concat([l[0]]).map(toLonLat)] }, "polygon", s, { style: { color: visible(s.color), weight: 0.5, fill: true, fillColor: visible(s.color), fillOpacity: s.solid ? 0.6 : 0.3 } }); });
        } else if (s.k === "point") push({ type: "Point", coordinates: toLonLat(s.p) }, "marker", s, { style: { color: visible(s.color) } });
        else if (s.k === "text") push({ type: "Point", coordinates: toLonLat(s.p) }, "text", s, { name: s.text.slice(0, 80), label: { text: s.text, show: true, size: 12, color: visible(s.color), bold: false, halo: true, align: "left" } });
      } catch (e) { bad++; }
    });
    const good = [];
    features.forEach((f) => { try { good.push(SM.gis.normalizeFeature(f)); } catch (e) { bad++; } });
    if (!good.length) { SM.toast("Nothing could be placed — the coordinates may be in a different system", "error", 6000); return; }
    const used = new Set(good.map((f) => f.properties.layerId));
    const newLayers = layers.filter((l) => used.has(l.id));
    SM.store.change((p) => { newLayers.forEach((l) => p.layers.push(l)); good.forEach((f) => p.features.push(SM.store.sanitize({ layers: [{ id: f.properties.layerId }], features: [f] }).features[0])); p.activeLayerId = newLayers[newLayers.length - 1].id; });
    SM.mapview.fitFeatures(good);
    SM.toast(`${good.length} objects placed in ${newLayers.length} layer(s)` + (bad ? ` (${bad} could not be converted)` : "") + ". Export → KML to use them in Google Earth.", "ok", 5000);
    if (opts.kml) SM.io.exportVector("kml", { layerIds: newLayers.map((l) => l.id), onlyVisible: false, fileName: opts.stem });
  }
  C._test = { plinePoints, arcPoints, splinePoints, ellipsePoints, extents, fromDxfParser };
})(window.SM);
