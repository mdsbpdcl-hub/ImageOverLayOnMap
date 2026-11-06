/* =====================================================================
   shp.js — ESRI Shapefile reading and writing in the browser.
   Reads .shp + .dbf (+ .prj, .cpg) given as separate files or in a .zip;
   writes a .zip with separate point / line / polygon shapefiles.
   ===================================================================== */
"use strict";
(function (SM) {
  const S = {};
  SM.shp = S;
  const PALETTE = ["#ffcc00", "#00e5ff", "#ff5252", "#69f0ae", "#ff9100", "#e040fb", "#40c4ff", "#eeff41"];

  /* ================= reading ================= */
  function readShp(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (buf.byteLength < 100 || dv.getInt32(0, false) !== 9994) throw new SM.gis.ImportError("The .shp file is damaged or not a shapefile");
    const fileType = dv.getInt32(32, true);
    const recs = [];
    let off = 100;
    while (off + 8 <= buf.byteLength) {
      const len = dv.getInt32(off + 4, false) * 2;
      const start = off + 8;
      if (start + len > buf.byteLength || len < 4) break;
      const type = dv.getInt32(start, true);
      recs.push(parseShape(dv, start, type));
      off = start + len;
    }
    return { fileType, recs };
  }
  function parseShape(dv, o, type) {
    const base = type % 10 === 1 ? 1 : type % 10 === 3 ? 3 : type % 10 === 5 ? 5 : type % 10 === 8 ? 8 : type;
    if (type === 0) return null;
    if (base === 1) return { type: "Point", coordinates: [dv.getFloat64(o + 4, true), dv.getFloat64(o + 12, true)] };
    if (base === 8) {
      const n = dv.getInt32(o + 36, true), pts = [];
      for (let i = 0; i < n; i++) pts.push([dv.getFloat64(o + 40 + i * 16, true), dv.getFloat64(o + 48 + i * 16, true)]);
      return { type: "MultiPoint", coordinates: pts };
    }
    if (base === 3 || base === 5) {
      const nParts = dv.getInt32(o + 36, true), nPts = dv.getInt32(o + 40, true);
      const parts = [];
      for (let i = 0; i < nParts; i++) parts.push(dv.getInt32(o + 44 + i * 4, true));
      const p0 = o + 44 + nParts * 4, all = [];
      for (let i = 0; i < nPts; i++) all.push([dv.getFloat64(p0 + i * 16, true), dv.getFloat64(p0 + 8 + i * 16, true)]);
      const rings = parts.map((s, i) => all.slice(s, i + 1 < parts.length ? parts[i + 1] : nPts));
      if (base === 3) return { type: "MultiLineString", coordinates: rings };
      return { type: "Rings", coordinates: rings };
    }
    return { type: "Unsupported", shapeType: type };
  }
  const signedArea = (r) => { let s = 0; for (let i = 0; i < r.length - 1; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return s / 2; };
  function inRing(pt, r) {
    let ins = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if ((r[i][1] > pt[1]) !== (r[j][1] > pt[1]) && pt[0] < ((r[j][0] - r[i][0]) * (pt[1] - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) ins = !ins;
    }
    return ins;
  }
  /** Shapefile polygons: clockwise rings are outers, counter-clockwise are holes. */
  function ringsToPolygons(rings) {
    const outers = [], holes = [];
    rings.filter((r) => r.length >= 4).forEach((r) => (signedArea(r) < 0 ? outers : holes).push(r));
    if (!outers.length) return holes.map((h) => [h]); // badly oriented file: treat all as outers
    const polys = outers.map((o) => [o]);
    holes.forEach((h) => {
      const owner = polys.find((p) => inRing(h[0], p[0])) || polys[polys.length - 1];
      owner.push(h);
    });
    return polys;
  }

  function readDbf(buf, encoding) {
    if (!buf) return null;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const n = dv.getUint32(4, true), headLen = dv.getUint16(8, true), recLen = dv.getUint16(10, true);
    const fields = [];
    for (let o = 32; o < headLen - 1 && buf[o] !== 0x0d; o += 32) {
      let name = "";
      for (let i = 0; i < 11 && buf[o + i]; i++) name += String.fromCharCode(buf[o + i]);
      fields.push({ name: name.trim(), type: String.fromCharCode(buf[o + 11]), len: buf[o + 16], dec: buf[o + 17] });
    }
    let dec;
    try { dec = new TextDecoder(encoding || "utf-8", { fatal: !encoding }); } catch (e) { dec = new TextDecoder("utf-8"); }
    const fallback = new TextDecoder("windows-1252");
    const rows = [];
    for (let r = 0; r < n; r++) {
      const o = headLen + r * recLen;
      if (o + recLen > buf.byteLength) break;
      if (buf[o] === 0x2a) { rows.push(null); continue; } // deleted
      let p = o + 1;
      const row = {};
      fields.forEach((f) => {
        const raw = buf.subarray(p, p + f.len);
        p += f.len;
        let s;
        try { s = dec.decode(raw); } catch (e) { s = fallback.decode(raw); }
        s = s.replace(/\0/g, "").trim();
        if (f.type === "N" || f.type === "F") row[f.name] = s === "" || /^\*+$/.test(s) ? null : +s;
        else if (f.type === "L") row[f.name] = /^[YyTt]/.test(s) ? true : /^[NnFf]/.test(s) ? false : null;
        else if (f.type === "D" && /^\d{8}$/.test(s)) row[f.name] = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
        else row[f.name] = s;
      });
      rows.push(row);
    }
    return { fields, rows };
  }
  const cpgToEncoding = (t) => {
    t = (t || "").trim().toLowerCase();
    if (!t) return null;
    if (/utf-?8|65001/.test(t)) return "utf-8";
    if (/1252|ansi|latin/.test(t)) return "windows-1252";
    if (/^\d+$/.test(t)) return "windows-" + t;
    return t;
  };

  /** Group a list of {name, bytes} into shapefile sets keyed by base name. */
  S.collect = function (files) {
    const sets = {};
    files.forEach((f) => {
      const m = /^(.*)\.(shp|dbf|prj|cpg|shx)$/i.exec(f.name.split("/").pop());
      if (!m) return;
      const base = m[1];
      (sets[base] = sets[base] || { name: base })[m[2].toLowerCase()] = f.bytes;
    });
    return Object.values(sets).filter((s) => s.shp);
  };
  S.unzip = function (bytes) {
    let out;
    try { out = fflate.unzipSync(bytes); } catch (e) { throw new SM.gis.ImportError("The ZIP file could not be opened"); }
    return Object.entries(out).filter(([n]) => !/(^|\/)__MACOSX\//.test(n)).map(([name, b]) => ({ name, bytes: b }));
  };

  /** Raw read (projected coordinates kept) so the caller can decide the CRS. */
  S.readSets = function (sets) {
    return sets.map((set) => {
      const shp = readShp(set.shp);
      const prj = set.prj ? new TextDecoder().decode(set.prj).trim() : null;
      const dbf = readDbf(set.dbf, set.cpg ? cpgToEncoding(new TextDecoder().decode(set.cpg)) : null);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const visit = (c) => { if (typeof c[0] === "number") { minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]); minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]); } else c.forEach(visit); };
      shp.recs.forEach((g) => g && g.coordinates && visit(g.coordinates));
      return { name: set.name, prj, shp, dbf, bbox: [minX, minY, maxX, maxY], count: shp.recs.filter(Boolean).length };
    });
  };

  const NAME_KEYS = ["name", "title", "label", "naam", "nm", "id"];
  /** Convert read sets to SatMap layers/features. crsDefs: {setName: proj4 def or WKT} */
  S.toFeatures = function (readSets, crsDefs) {
    const layers = [], features = [], warnings = [];
    readSets.forEach((rs, li) => {
      const conv = SM.crs.toWgs84(crsDefs[rs.name]);
      const lid = SM.uid();
      layers.push({ id: lid, name: rs.name, visible: true, locked: false });
      const color = PALETTE[li % PALETTE.length];
      const fieldNames = rs.dbf ? rs.dbf.fields.map((f) => f.name) : [];
      const nameKey = fieldNames.find((n) => NAME_KEYS.includes(n.toLowerCase()));
      let unsupported = 0;
      rs.shp.recs.forEach((g, i) => {
        if (!g) return;
        if (g.type === "Unsupported") { unsupported++; return; }
        const attrs = rs.dbf && rs.dbf.rows[i] ? rs.dbf.rows[i] : {};
        if (rs.dbf && rs.dbf.rows[i] === null) return; // deleted record
        const name = nameKey && attrs[nameKey] != null ? String(attrs[nameKey]) : "";
        const desc = Object.entries(attrs).filter(([, v]) => v !== null && v !== "").map(([k, v]) => `${k}: ${v}`).join("\n");
        const base = { layerId: lid, name, description: desc, attrs, style: { color, fillColor: color, fillOpacity: 0.15, weight: 2 } };
        const tc = (c) => conv(c);
        const push = (geom, kind, extra) => features.push({ type: "Feature", geometry: geom, properties: Object.assign({}, base, { kind }, extra || {}) });
        try {
          if (g.type === "Point") push({ type: "Point", coordinates: tc(g.coordinates) }, "marker", { label: { text: name, show: !!name } });
          else if (g.type === "MultiPoint") g.coordinates.forEach((c) => push({ type: "Point", coordinates: tc(c) }, "marker", { label: { text: name, show: !!name } }));
          else if (g.type === "MultiLineString") g.coordinates.forEach((l) => l.length >= 2 && push({ type: "LineString", coordinates: l.map(tc) }, "polyline"));
          else ringsToPolygons(g.coordinates).forEach((p) => push({ type: "Polygon", coordinates: p.map((r) => r.map(tc)) }, "polygon"));
        } catch (e) { warnings.push(`${rs.name} record ${i + 1}: ${e.message}`); }
      });
      if (unsupported) warnings.push(`${rs.name}: ${unsupported} shape(s) of an unsupported type (e.g. MultiPatch) were skipped`);
    });
    return { layers, features, warnings };
  };

  /* ================= writing ================= */
  const enc = new TextEncoder();
  function fitBytes(s, max) { // UTF-8 bytes, cut without splitting a character
    let b = enc.encode(s);
    if (b.length <= max) return b;
    let cut = max;
    while (cut > 0 && (b[cut] & 0xc0) === 0x80) cut--;
    return b.subarray(0, cut);
  }
  function writeDbf(fields, rows) {
    const headLen = 32 + fields.length * 32 + 1, recLen = 1 + fields.reduce((s, f) => s + f.len, 0);
    const buf = new Uint8Array(headLen + rows.length * recLen + 1);
    const dv = new DataView(buf.buffer);
    const d = new Date();
    buf[0] = 0x03; buf[1] = d.getFullYear() - 1900; buf[2] = d.getMonth() + 1; buf[3] = d.getDate();
    dv.setUint32(4, rows.length, true); dv.setUint16(8, headLen, true); dv.setUint16(10, recLen, true);
    buf[29] = 0x00; // language driver: none (encoding declared in .cpg)
    fields.forEach((f, i) => {
      const o = 32 + i * 32;
      for (let k = 0; k < Math.min(10, f.name.length); k++) buf[o + k] = f.name.charCodeAt(k);
      buf[o + 11] = f.type.charCodeAt(0); buf[o + 16] = f.len; buf[o + 17] = f.dec || 0;
    });
    buf[headLen - 1] = 0x0d;
    rows.forEach((row, r) => {
      let o = headLen + r * recLen;
      buf[o++] = 0x20;
      fields.forEach((f) => {
        const v = row[f.name];
        let bytes;
        if (f.type === "N") {
          const s = v === null || v === undefined || !isFinite(v) ? "" : (+v).toFixed(f.dec);
          bytes = enc.encode(s.length > f.len ? "*".repeat(f.len) : s.padStart(f.len, " "));
        } else bytes = fitBytes(String(v ?? ""), f.len);
        buf.fill(0x20, o, o + f.len);
        buf.set(bytes, o);
        o += f.len;
      });
    });
    buf[buf.length - 1] = 0x1a;
    return buf;
  }
  function writeShpShx(shapeType, geoms) {
    // geoms: arrays of parts (each an array of [x,y]); points: [[x,y]]
    const contents = geoms.map((parts) => {
      if (shapeType === 1) {
        const b = new DataView(new ArrayBuffer(20));
        b.setInt32(0, 1, true); b.setFloat64(4, parts[0][0], true); b.setFloat64(12, parts[0][1], true);
        return { dv: b, box: [parts[0][0], parts[0][1], parts[0][0], parts[0][1]] };
      }
      const nPts = parts.reduce((s, p) => s + p.length, 0);
      const b = new DataView(new ArrayBuffer(44 + parts.length * 4 + nPts * 16));
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      parts.forEach((p) => p.forEach((c) => { x0 = Math.min(x0, c[0]); y0 = Math.min(y0, c[1]); x1 = Math.max(x1, c[0]); y1 = Math.max(y1, c[1]); }));
      b.setInt32(0, shapeType, true);
      [x0, y0, x1, y1].forEach((v, i) => b.setFloat64(4 + i * 8, v, true));
      b.setInt32(36, parts.length, true); b.setInt32(40, nPts, true);
      let idx = 0;
      parts.forEach((p, i) => { b.setInt32(44 + i * 4, idx, true); idx += p.length; });
      let o = 44 + parts.length * 4;
      parts.forEach((p) => p.forEach((c) => { b.setFloat64(o, c[0], true); b.setFloat64(o + 8, c[1], true); o += 16; }));
      return { dv: b, box: [x0, y0, x1, y1] };
    });
    const total = 100 + contents.reduce((s, c) => s + 8 + c.dv.byteLength, 0);
    const shp = new Uint8Array(total), shx = new Uint8Array(100 + contents.length * 8);
    const box = contents.reduce((a, c) => [Math.min(a[0], c.box[0]), Math.min(a[1], c.box[1]), Math.max(a[2], c.box[2]), Math.max(a[3], c.box[3])], [Infinity, Infinity, -Infinity, -Infinity]);
    const header = (u8, len) => {
      const dv = new DataView(u8.buffer);
      dv.setInt32(0, 9994, false); dv.setInt32(24, len / 2, false); dv.setInt32(28, 1000, true); dv.setInt32(32, shapeType, true);
      box.forEach((v, i) => dv.setFloat64(36 + i * 8, isFinite(v) ? v : 0, true));
    };
    header(shp, total); header(shx, shx.length);
    const sdv = new DataView(shp.buffer), xdv = new DataView(shx.buffer);
    let off = 100;
    contents.forEach((c, i) => {
      sdv.setInt32(off, i + 1, false); sdv.setInt32(off + 4, c.dv.byteLength / 2, false);
      shp.set(new Uint8Array(c.dv.buffer), off + 8);
      xdv.setInt32(100 + i * 8, off / 2, false); xdv.setInt32(104 + i * 8, c.dv.byteLength / 2, false);
      off += 8 + c.dv.byteLength;
    });
    return { shp, shx };
  }

  const FIELDS = [
    { name: "NAME", type: "C", len: 254 }, { name: "DESCR", type: "C", len: 254 }, { name: "LAYER", type: "C", len: 100 },
    { name: "KIND", type: "C", len: 16 }, { name: "LABEL", type: "C", len: 254 }, { name: "COLOR", type: "C", len: 7 },
    { name: "FILLCOLOR", type: "C", len: 7 }, { name: "LENGTH_M", type: "N", len: 19, dec: 3 }, { name: "AREA_M2", type: "N", len: 19, dec: 3 },
    { name: "AREA_HA", type: "N", len: 19, dec: 6 }, { name: "RADIUS_M", type: "N", len: 19, dec: 3 },
  ];

  /** Export project features to a zip of shapefiles. opts: {layerIds, featureIds, onlyVisible, crs: 'wgs84'|'utm45n'…, baseName} */
  S.exportZip = function (project, opts) {
    opts = opts || {};
    const gj = SM.gis.exportGeoJSON(project, opts); // circles already polygons, styles normalised
    const toOut = SM.crs.fromWgs84(SM.crs.defFor(opts.crs || "wgs84"));
    const groups = { points: { type: 1, geoms: [], rows: [] }, lines: { type: 3, geoms: [], rows: [] }, polygons: { type: 5, geoms: [], rows: [] } };
    gj.features.forEach((f) => {
      const p = f.properties, g = f.geometry, m = SM.geo.measureFeature(f);
      const row = {
        NAME: p.name, DESCR: p.description, LAYER: p.layerName, KIND: p.kind, LABEL: p.label && p.label.text || "",
        COLOR: p.style.color, FILLCOLOR: p.style.fillColor, LENGTH_M: g.type === "LineString" ? m.length_m : null,
        AREA_M2: m.area_m2 ?? null, AREA_HA: m.area_m2 !== undefined ? m.area_m2 / 1e4 : null, RADIUS_M: p.kind === "circle" ? p.radius : null,
      };
      if (g.type === "Point") { groups.points.geoms.push([toOut(g.coordinates)]); groups.points.rows.push(row); }
      else if (g.type === "LineString") { groups.lines.geoms.push([g.coordinates.map(toOut)]); groups.lines.rows.push(row); }
      else if (g.type === "Polygon") {
        const rings = g.coordinates.map((r, i) => {
          const rr = r.map(toOut);
          const a = signedArea(rr);
          return (i === 0 ? a > 0 : a < 0) ? rr.reverse() : rr; // outer clockwise, holes counter-clockwise
        });
        groups.polygons.geoms.push(rings); groups.polygons.rows.push(row);
      }
    });
    const base = SM.safeName(opts.baseName || project.name).replace(/\s+/g, "_");
    const files = {}, prj = SM.crs.prjFor(opts.crs || "wgs84");
    let count = 0;
    Object.entries(groups).forEach(([suffix, gr]) => {
      if (!gr.geoms.length) return;
      const { shp, shx } = writeShpShx(gr.type, gr.geoms);
      const n = `${base}_${suffix}`;
      files[n + ".shp"] = shp; files[n + ".shx"] = shx; files[n + ".dbf"] = writeDbf(FIELDS, gr.rows);
      files[n + ".prj"] = enc.encode(prj); files[n + ".cpg"] = enc.encode("UTF-8");
      count += gr.geoms.length;
    });
    if (!count) throw new Error("There is nothing to export");
    return fflate.zipSync(files, { level: 6 });
  };
})(window.SM);
