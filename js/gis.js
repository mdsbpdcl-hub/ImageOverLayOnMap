/* =====================================================================
   gis.js — import / export entirely in the browser:
   KML, KMZ (zip via fflate), GeoJSON and CSV coordinate tables.

   Internal model: project = { name, layers[{id,name,visible,locked}],
   features[GeoJSON Feature], viewport, basemap }. Coordinates are WGS84
   (EPSG:4326) in GeoJSON order [lon, lat]. Circles are stored as a Point
   centre + properties.radius (metres) and exported as 72-vertex geodesic
   polygons, because KML has no circle primitive.
   ===================================================================== */
"use strict";
(function (SM) {
  const G = {};
  SM.gis = G;

  const DEFAULT_STYLE = { color: "#ffcc00", weight: 3, opacity: 1, dash: "solid", fill: true, fillColor: "#ffcc00", fillOpacity: 0.25, arrow: false };
  const DEFAULT_LABEL = { text: "", show: false, size: 14, color: "#ffffff", bold: false, italic: false, align: "center", halo: true, offset: [0, 0] };
  const LINE_KINDS = ["polyline", "freehand", "arrow"], AREA_KINDS = ["polygon", "rectangle", "circle"], POINT_KINDS = ["marker", "text"];
  const ALL_KINDS = [...LINE_KINDS, ...AREA_KINDS, ...POINT_KINDS];
  const SATMAP_KEY = "satmap"; // ExtendedData holding our full properties as JSON

  class ImportError extends Error {}
  class GeometryError extends Error {}
  G.ImportError = ImportError;
  const newId = () => SM.uid();

  /* ---------------- validation ---------------- */
  function checkLonLat(lon, lat) {
    if (typeof lon !== "number" || typeof lat !== "number" || !isFinite(lon) || !isFinite(lat)) throw new GeometryError("Coordinates must be numbers");
    if (lat < -90 || lat > 90) throw new GeometryError(`Latitude ${lat} is outside -90..90 (are lat/lon swapped?)`);
    if (lon < -180 || lon > 180) throw new GeometryError(`Longitude ${lon} is outside -180..180`);
  }
  function cleanLine(coords) {
    const out = [];
    for (const c of coords || []) {
      const lon = +c[0], lat = +c[1];
      checkLonLat(lon, lat);
      const last = out[out.length - 1];
      if (!last || last[0] !== lon || last[1] !== lat) out.push([lon, lat]);
    }
    if (out.length < 2) throw new GeometryError("A line needs at least 2 distinct vertices");
    return out;
  }
  function cleanRing(coords) {
    const out = cleanLine(coords);
    if (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1]) out.push(out[0].slice());
    if (out.length < 4) throw new GeometryError("A polygon ring needs at least 3 distinct vertices");
    return out;
  }
  G.checkLonLat = checkLonLat;

  /** Split a self-intersecting polygon into valid parts. Returns {parts, warning}. */
  function repairPolygon(geom) {
    if (!window.turf) return { parts: [geom], warning: null };
    let kinks;
    try { kinks = turf.kinks(turf.polygon(geom.coordinates)).features.length; } catch (e) { return { parts: [geom], warning: null }; }
    if (!kinks) return { parts: [geom], warning: null };
    try {
      const parts = turf.unkinkPolygon(turf.polygon(geom.coordinates)).features
        .map((f) => f.geometry).filter((g) => g && g.coordinates[0].length >= 4 && SM.geo.polygonArea(g.coordinates) > 0);
      if (parts.length) return { parts, warning: "Self-intersecting polygon repaired" };
    } catch (e) { /* fall through */ }
    return { parts: [geom], warning: "Self-intersecting polygon could not be repaired" };
  }
  G.repairPolygon = repairPolygon;

  /** Fill defaults and validate one feature (throws GeometryError). */
  function normalizeFeature(feat, layerId) {
    if (!feat || feat.type !== "Feature") throw new GeometryError("Not a GeoJSON Feature");
    const geom = feat.geometry || {}, gtype = geom.type;
    const props = Object.assign({}, feat.properties || {});
    let kind = props.kind;
    if (!ALL_KINDS.includes(kind)) kind = { Point: "marker", LineString: "polyline", Polygon: "polygon" }[gtype];
    if (!kind) throw new GeometryError(`Unsupported geometry type ${gtype}`);
    let coords = geom.coordinates;
    if (gtype === "Point") { coords = [+coords[0], +coords[1]]; checkLonLat(coords[0], coords[1]); }
    else if (gtype === "LineString") coords = cleanLine(coords);
    else if (gtype === "Polygon") coords = coords.map(cleanRing);
    else throw new GeometryError(`Unsupported geometry type ${gtype}`);
    const style = Object.assign({}, DEFAULT_STYLE, props.style || {});
    const label = Object.assign({}, DEFAULT_LABEL, props.label || {});
    if (!Array.isArray(label.offset)) label.offset = [0, 0];
    if (LINE_KINDS.includes(kind)) style.fill = false;
    if (kind === "arrow") style.arrow = true;
    Object.assign(props, {
      id: String(props.id || newId()), layerId: props.layerId || layerId, kind,
      name: String(props.name || ""), description: String(props.description || ""),
      style, label, hidden: !!props.hidden, locked: !!props.locked, group: props.group || null,
    });
    if (kind === "circle") {
      props.radius = +props.radius || 0;
      if (gtype !== "Point" || props.radius <= 0) { props.kind = "polygon"; delete props.radius; }
    }
    return { type: "Feature", geometry: { type: gtype, coordinates: coords }, properties: props };
  }
  G.normalizeFeature = normalizeFeature;

  function selectFeatures(project, layerIds, featureIds, onlyVisible) {
    let layers = project.layers || [];
    const feats = project.features || [];
    if (featureIds && featureIds.length) {
      const want = new Set(featureIds);
      const out = feats.filter((f) => want.has((f.properties || {}).id));
      const used = new Set(out.map((f) => f.properties.layerId));
      return { layers: layers.filter((l) => used.has(l.id)), features: out };
    }
    if (layerIds && layerIds.length) { const w = new Set(layerIds); layers = layers.filter((l) => w.has(l.id)); }
    if (onlyVisible) layers = layers.filter((l) => l.visible !== false);
    const set = new Set(layers.map((l) => l.id));
    return { layers, features: feats.filter((f) => set.has(f.properties.layerId) && !(onlyVisible && f.properties.hidden)) };
  }

  /* ---------------- colours ---------------- */
  function hexToKml(hex, opacity) {
    let h = String(hex || "#000000").replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (!/^[0-9a-fA-F]{6}$/.test(h)) h = "000000";
    const a = Math.max(0, Math.min(255, Math.round(+opacity * 255)));
    return (a.toString(16).padStart(2, "0") + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2)).toLowerCase();
  }
  function kmlToHex(c) {
    c = String(c || "").trim().replace("#", "");
    if (!/^[0-9a-fA-F]{8}$/.test(c)) return ["#ffcc00", 1];
    return [("#" + c.slice(6, 8) + c.slice(4, 6) + c.slice(2, 4)).toLowerCase(), Math.round((parseInt(c.slice(0, 2), 16) / 255) * 1000) / 1000];
  }
  G.hexToKml = hexToKml; G.kmlToHex = kmlToHex;

  /* ---------------- KML export ---------------- */
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
  const fmt = (coords) => coords.map((c) => `${c[0].toFixed(8)},${c[1].toFixed(8)},0`).join(" ");
  const polyXml = (rings) => "<Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>" + fmt(rings[0]) +
    "</coordinates></LinearRing></outerBoundaryIs>" + rings.slice(1).map((r) => `<innerBoundaryIs><LinearRing><coordinates>${fmt(r)}</coordinates></LinearRing></innerBoundaryIs>`).join("") + "</Polygon>";

  function styleXml(p) {
    const st = p.style, lab = p.label, kind = p.kind, out = ["<Style>"];
    if (POINT_KINDS.includes(kind)) {
      if (kind === "text") out.push("<IconStyle><scale>0</scale><Icon/></IconStyle>");
      else out.push(`<IconStyle><color>${hexToKml(st.color, st.opacity)}</color><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/wht-blank.png</href></Icon><hotSpot x="0.5" y="0" xunits="fraction" yunits="fraction"/></IconStyle>`);
      const show = kind === "text" || lab.show;
      out.push(`<LabelStyle><color>${hexToKml(lab.color || "#ffffff", 1)}</color><scale>${show ? ((+lab.size || 14) / 14).toFixed(2) : 0}</scale></LabelStyle>`);
    } else {
      out.push(`<LineStyle><color>${hexToKml(st.color, st.opacity)}</color><width>${(+st.weight).toFixed(1)}</width></LineStyle>`);
      const area = AREA_KINDS.includes(kind);
      if (area || st.arrow || kind === "arrow") {
        const fill = (area && st.fill !== false) || (!area && (st.arrow || kind === "arrow")) ? 1 : 0;
        out.push(`<PolyStyle><color>${hexToKml(area ? st.fillColor : st.color, area ? st.fillOpacity : st.opacity)}</color><fill>${fill}</fill><outline>1</outline></PolyStyle>`);
      }
      if (lab.show) out.push(`<LabelStyle><color>${hexToKml(lab.color || "#ffffff", 1)}</color><scale>${((+lab.size || 14) / 14).toFixed(2)}</scale></LabelStyle>`);
      out.push("<IconStyle><scale>0</scale><Icon/></IconStyle>");
    }
    out.push("</Style>");
    return out.join("");
  }

  function arrowHead(coords, total) {
    if (coords.length < 2) return null;
    const end = coords[coords.length - 1], prev = coords[coords.length - 2];
    const head = Math.min(Math.max(total * 0.06, 1), 500);
    const back = window.turf ? turf.bearing(turf.point(end), turf.point(prev)) : 180;
    return [end.slice(), SM.geo.destination(end, back + 25, head), SM.geo.destination(end, back - 25, head), end.slice()];
  }
  function labelPoint(geom) {
    try {
      if (geom.type === "Polygon") return turf.pointOnFeature(turf.polygon(geom.coordinates)).geometry.coordinates;
      if (geom.type === "LineString") { const l = turf.lineString(geom.coordinates); return turf.along(l, turf.length(l) / 2).geometry.coordinates; }
    } catch (e) { /* ignore */ }
    return null;
  }

  function placemark(f) {
    const p = f.properties, g = f.geometry, kind = p.kind, st = p.style, c = g.coordinates;
    let name = p.name || kind[0].toUpperCase() + kind.slice(1);
    if (kind === "text") name = p.label.text || p.name || "Text";
    const m = SM.geo.measureFeature(f);
    const ext = [`<Data name="kind"><value>${esc(kind)}</value></Data>`];
    if (m.length_m !== undefined && g.type === "LineString") ext.push(`<Data name="length_m"><displayName>Length (m)</displayName><value>${m.length_m.toFixed(2)}</value></Data>`);
    if (m.area_m2 !== undefined) {
      ext.push(`<Data name="area_m2"><displayName>Area (m²)</displayName><value>${m.area_m2.toFixed(2)}</value></Data>`);
      ext.push(`<Data name="area_ha"><displayName>Area (ha)</displayName><value>${(m.area_m2 / 1e4).toFixed(4)}</value></Data>`);
    }
    if (kind === "circle") {
      ext.push(`<Data name="radius_m"><displayName>Radius (m)</displayName><value>${p.radius.toFixed(2)}</value></Data>`);
      ext.push(`<Data name="center_lonlat"><value>${c[0].toFixed(10)},${c[1].toFixed(10)}</value></Data>`);
    }
    ext.push(`<Data name="${SATMAP_KEY}"><value>${esc(JSON.stringify(p))}</value></Data>`);

    const geoms = [];
    if (kind === "circle") geoms.push(polyXml([SM.geo.circleRing(c, p.radius, 72)]));
    else if (g.type === "Point") geoms.push(`<Point><coordinates>${c[0].toFixed(8)},${c[1].toFixed(8)},0</coordinates></Point>`);
    else if (g.type === "LineString") {
      geoms.push(`<LineString><tessellate>1</tessellate><coordinates>${fmt(c)}</coordinates></LineString>`);
      if (st.arrow || kind === "arrow") { const h = arrowHead(c, m.length_m); if (h) geoms.push(polyXml([h])); }
    } else if (g.type === "Polygon") repairPolygon(g).parts.forEach((pg) => geoms.push(polyXml(pg.coordinates)));
    if (!POINT_KINDS.includes(kind) && p.label.show) {
      const lp = labelPoint(kind === "circle" ? { type: "Polygon", coordinates: [SM.geo.circleRing(c, p.radius, 36)] } : g);
      if (lp) geoms.push(`<Point><coordinates>${lp[0].toFixed(8)},${lp[1].toFixed(8)},0</coordinates></Point>`);
    }
    const geomXml = geoms.length === 1 ? geoms[0] : "<MultiGeometry>" + geoms.join("") + "</MultiGeometry>";
    return `<Placemark id="f_${esc(p.id)}"><name>${esc(name)}</name><visibility>${p.hidden ? 0 : 1}</visibility>` +
      `<description>${esc(p.description || "")}</description>${styleXml(p)}<ExtendedData>${ext.join("")}</ExtendedData>${geomXml}</Placemark>`;
  }

  G.exportKML = function (project, opts) {
    opts = opts || {};
    const { layers, features } = selectFeatures(project, opts.layerIds, opts.featureIds, opts.onlyVisible !== false);
    const byLayer = {};
    features.forEach((f) => {
      try { const nf = normalizeFeature(f); (byLayer[nf.properties.layerId] = byLayer[nf.properties.layerId] || []).push(nf); }
      catch (e) { /* skip unusable geometry rather than writing invalid KML */ }
    });
    const now = new Date().toISOString().slice(0, 16).replace("T", " ");
    const out = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">',
      `<Document><name>${esc(project.name || "SatMap project")}</name><open>1</open>`,
      `<description>Exported from SatMap GIS on ${now} UTC. Coordinates WGS84 (EPSG:4326).</description>`];
    const vp = project.viewport;
    if (vp && vp.center) {
      const range = (591657550.5 / Math.pow(2, +vp.zoom || 12)) * 0.6;
      out.push(`<LookAt><longitude>${(+vp.center[1]).toFixed(6)}</longitude><latitude>${(+vp.center[0]).toFixed(6)}</latitude><altitude>0</altitude><range>${range.toFixed(0)}</range><tilt>0</tilt><heading>0</heading></LookAt>`);
    }
    layers.forEach((l) => {
      const items = byLayer[l.id];
      if (!items || !items.length) return;
      out.push(`<Folder><name>${esc(l.name || "Layer")}</name><visibility>${l.visible === false ? 0 : 1}</visibility><open>1</open>`);
      items.forEach((f) => out.push(placemark(f)));
      out.push("</Folder>");
    });
    if (opts.extraXml) out.push(opts.extraXml);
    out.push("</Document></kml>");
    return out.join("\n");
  };
  G.exportKMZ = (kmlText, files) => fflate.zipSync(Object.assign({ "doc.kml": fflate.strToU8(kmlText) }, files || {}), { level: 6 });

  /* ---------------- GeoJSON export ---------------- */
  G.exportGeoJSON = function (project, opts) {
    opts = opts || {};
    const { layers, features } = selectFeatures(project, opts.layerIds, opts.featureIds, opts.onlyVisible !== false);
    const names = Object.fromEntries(layers.map((l) => [l.id, l.name]));
    const out = [];
    features.forEach((f) => {
      let nf;
      try { nf = normalizeFeature(f); } catch (e) { return; }
      const p = Object.assign({}, nf.properties, { layerName: names[nf.properties.layerId] || "" });
      let g = nf.geometry;
      if (p.kind === "circle") { p.center = g.coordinates.slice(); g = { type: "Polygon", coordinates: [SM.geo.circleRing(g.coordinates, p.radius, 72)] }; }
      out.push({ type: "Feature", geometry: g, properties: p });
    });
    return { type: "FeatureCollection", name: project.name || "SatMap project", features: out, satmap_layers: layers };
  };

  /* ---------------- result assembly ---------------- */
  function finish(layers, features, warnings, allowEmpty) {
    const good = [];
    features.forEach((f) => {
      try { good.push(normalizeFeature(f)); }
      catch (e) { warnings.push(`Feature '${(f.properties || {}).name || ""}' skipped: ${e.message}`); }
    });
    const used = new Set(good.map((f) => f.properties.layerId));
    if (!good.length && !allowEmpty) throw new ImportError("No usable features were found in the file" + (warnings.length ? ` (${warnings[0]})` : ""));
    return { layers: layers.filter((l) => used.has(l.id)), features: good, warnings: warnings.slice(0, 50) };
  }
  function layerMaker(layers) {
    const byName = {};
    return (name) => {
      if (!byName[name]) { byName[name] = newId(); layers.push({ id: byName[name], name, visible: true, locked: false }); }
      return byName[name];
    };
  }

  /* ---------------- KML import ---------------- */
  const kids = (el, name) => Array.from(el.children).filter((c) => c.localName === name);
  const kid = (el, name) => kids(el, name)[0] || null;
  const txt = (el, name, def) => { const c = kid(el, name); return c && c.textContent ? c.textContent.trim() : (def ?? ""); };
  function parseCoords(t) {
    const pts = [];
    String(t || "").trim().split(/\s+/).forEach((tok) => {
      const p = tok.split(",");
      if (p.length >= 2) { const x = parseFloat(p[0]), y = parseFloat(p[1]); if (isFinite(x) && isFinite(y)) pts.push([x, y]); }
    });
    return pts;
  }
  function parseStyle(el) {
    const st = {};
    if (!el) return st;
    const ls = kid(el, "LineStyle");
    if (ls) {
      const c = txt(ls, "color"); if (c) [st.color, st.opacity] = kmlToHex(c);
      const w = parseFloat(txt(ls, "width")); if (isFinite(w)) st.weight = Math.max(0.5, w);
    }
    const ps = kid(el, "PolyStyle");
    if (ps) {
      const c = txt(ps, "color"); if (c) [st.fillColor, st.fillOpacity] = kmlToHex(c);
      const fl = txt(ps, "fill"); if (fl === "0" || fl === "false") st.fill = false;
    }
    const ic = kid(el, "IconStyle");
    if (ic) { const c = txt(ic, "color"); if (c) st._iconColor = kmlToHex(c)[0]; }
    const lb = kid(el, "LabelStyle");
    if (lb) {
      st._label = {};
      const c = txt(lb, "color"); if (c) st._label.color = kmlToHex(c)[0];
      const s = parseFloat(txt(lb, "scale")); if (isFinite(s)) st._label.size = Math.max(6, Math.round(s * 14));
    }
    return st;
  }
  function collectStyles(root) {
    const styles = {}, maps = {};
    root.querySelectorAll("*").forEach((el) => {
      const id = el.getAttribute("id");
      if (!id) return;
      if (el.localName === "Style") styles["#" + id] = parseStyle(el);
      else if (el.localName === "StyleMap") {
        kids(el, "Pair").forEach((pair) => {
          if (txt(pair, "key") !== "normal") return;
          const inline = kid(pair, "Style");
          if (inline) styles["#" + id] = parseStyle(inline); else maps["#" + id] = txt(pair, "styleUrl");
        });
      }
    });
    Object.entries(maps).forEach(([id, target]) => { if (styles[target]) styles[id] = styles[target]; });
    return styles;
  }
  function kmlGeoms(el) {
    const n = el.localName;
    if (n === "Point") { const p = parseCoords(txt(el, "coordinates")); return p.length ? [{ type: "Point", coordinates: p[0] }] : []; }
    if (n === "LineString" || n === "LinearRing") { const p = parseCoords(txt(el, "coordinates")); return p.length >= 2 ? [{ type: "LineString", coordinates: p }] : []; }
    if (n === "Polygon") {
      const rings = [];
      ["outerBoundaryIs", "innerBoundaryIs"].forEach((b) => kids(el, b).forEach((bd) => {
        const lr = kid(bd, "LinearRing");
        if (lr) { const p = parseCoords(txt(lr, "coordinates")); if (p.length >= 3) rings.push(p); }
      }));
      return rings.length ? [{ type: "Polygon", coordinates: rings }] : [];
    }
    if (n === "MultiGeometry") return Array.from(el.children).flatMap(kmlGeoms);
    if (n === "Track") {
      const pts = Array.from(el.children).filter((c) => c.localName === "coord").map((c) => c.textContent.trim().split(/\s+/).slice(0, 2).map(Number));
      return pts.length >= 2 ? [{ type: "LineString", coordinates: pts }] : [];
    }
    return [];
  }
  const GEOM_TAGS = ["Point", "LineString", "LinearRing", "Polygon", "MultiGeometry", "Track"];

  function placemarkFeatures(pm, styles, layerId, warnings) {
    const name = txt(pm, "name"), desc = txt(pm, "description"), vis = txt(pm, "visibility", "1");
    let satProps = null, satCenter = null;
    const ext = kid(pm, "ExtendedData");
    if (ext) kids(ext, "Data").forEach((d) => {
      if (d.getAttribute("name") === "center_lonlat") satCenter = parseCoords(txt(d, "value"))[0] || null;
      if (d.getAttribute("name") === SATMAP_KEY) { try { satProps = JSON.parse(txt(d, "value")); } catch (e) { satProps = null; } }
    });
    const geoms = Array.from(pm.children).filter((c) => GEOM_TAGS.includes(c.localName)).flatMap(kmlGeoms);
    if (!geoms.length) return [];

    // round trip of a SatMap export: restore exact properties
    if (satProps && typeof satProps === "object") {
      const props = Object.assign({}, satProps, { id: newId(), layerId, description: desc });
      if (props.kind !== "text" && name) props.name = name;
      const kind = props.kind;
      let main = null;
      if (kind === "circle") {
        const poly = geoms.find((g) => g.type === "Polygon");
        if (poly) {
          let c = turf.centroid(turf.polygon(poly.coordinates)).geometry.coordinates;
          // exact stored centre unless the circle was moved elsewhere (e.g. in Google Earth)
          if (satCenter && Math.abs(satCenter[0] - c[0]) < 1e-4 && Math.abs(satCenter[1] - c[1]) < 1e-4) c = satCenter;
          main = { type: "Point", coordinates: c };
        }
      } else if (LINE_KINDS.includes(kind)) main = geoms.find((g) => g.type === "LineString");
      else if (AREA_KINDS.includes(kind)) {
        const polys = geoms.filter((g) => g.type === "Polygon");
        if (polys.length > 1) return polys.map((pg) => ({ type: "Feature", geometry: pg, properties: Object.assign({}, props, { id: newId() }) }));
        main = polys[0];
      } else if (POINT_KINDS.includes(kind)) main = geoms.find((g) => g.type === "Point");
      if (main) return [{ type: "Feature", geometry: main, properties: props }];
    }

    // generic KML (Google Earth, QGIS, …)
    const style = {};
    const su = txt(pm, "styleUrl");
    if (su && styles[su]) Object.assign(style, styles[su]);
    const inline = kid(pm, "Style");
    if (inline) Object.assign(style, parseStyle(inline));
    const label = style._label || {}, iconColor = style._iconColor;
    delete style._label; delete style._iconColor;
    const out = [];
    geoms.forEach((g) => {
      const kind = { Point: "marker", LineString: "polyline", Polygon: "polygon" }[g.type];
      const st = Object.assign({}, style);
      if (g.type === "Point" && iconColor) st.color = iconColor;
      if (g.type === "Polygon" && !st.fillColor && st.color) st.fillColor = st.color;
      const lab = Object.assign({}, label);
      if (g.type === "Point") { lab.show = !!name; lab.text = name; }
      const props = { id: newId(), layerId, kind, name, description: desc, style: st, label: lab, hidden: vis === "0" };
      if (g.type === "Polygon") {
        try {
          const r = repairPolygon({ type: "Polygon", coordinates: g.coordinates.map(cleanRing) });
          if (r.warning) warnings.push(`${name || "Polygon"}: ${r.warning}`);
          r.parts.forEach((pg) => out.push({ type: "Feature", geometry: pg, properties: Object.assign({}, props, { id: newId() }) }));
        } catch (e) { warnings.push(`${name || "Polygon"} skipped: ${e.message}`); }
      } else out.push({ type: "Feature", geometry: g, properties: props });
    });
    return out;
  }

  /** GroundOverlay → {name, href, quad:[[lng,lat]×4 ll,lr,ur,ul], opacity} */
  function groundOverlay(el) {
    const icon = kid(el, "Icon"), href = icon ? txt(icon, "href") : "";
    const col = txt(el, "color");
    const opacity = col ? kmlToHex(col)[1] : 1;
    let quad = null;
    const q = Array.from(el.children).find((c) => c.localName === "LatLonQuad");
    if (q) { const p = parseCoords(txt(q, "coordinates")); if (p.length >= 4) quad = p.slice(0, 4); }
    const box = kid(el, "LatLonBox");
    if (!quad && box) {
      const n = +txt(box, "north"), s = +txt(box, "south"), e = +txt(box, "east"), w = +txt(box, "west"), rot = (+txt(box, "rotation") || 0) * Math.PI / 180;
      const cx = (e + w) / 2, cy = (n + s) / 2, k = Math.cos(cy * Math.PI / 180);
      quad = [[w, s], [e, s], [e, n], [w, n]].map(([x, y]) => {
        const dx = (x - cx) * k, dy = y - cy; // rotate counter-clockwise in a locally square frame
        return [cx + (dx * Math.cos(rot) - dy * Math.sin(rot)) / k, cy + dx * Math.sin(rot) + dy * Math.cos(rot)];
      });
    }
    return quad && href ? { name: txt(el, "name"), href, quad, opacity } : null;
  }
  const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
  function bytesToDataURL(bytes, name) {
    const ext = (name.split(".").pop() || "png").toLowerCase();
    let bin = "";
    for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    return `data:${MIME[ext] || "image/png"};base64,${btoa(bin)}`;
  }

  G.importKML = function (text, defaultLayer, zipFiles) {
    if (typeof text !== "string") text = new TextDecoder().decode(text);
    if (/<!ENTITY/i.test(text)) throw new ImportError("The KML file was rejected: it declares XML entities");
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new ImportError("The KML file is not valid XML");
    const root = doc.documentElement;
    if (root.localName !== "kml") throw new ImportError("This XML file is not KML (root element is not <kml>)");
    const styles = collectStyles(root);
    const layers = [], features = [], warnings = [], overlays = [];
    const layerFor = layerMaker(layers);
    (function walk(el, path) {
      Array.from(el.children).forEach((c) => {
        const t = c.localName;
        if (t === "Document" || t === "Folder") {
          const nm = txt(c, "name") || (t === "Folder" ? "Folder" : "");
          walk(c, t === "Folder" && nm ? path.concat(nm) : path);
        } else if (t === "Placemark") {
          try { features.push(...placemarkFeatures(c, styles, layerFor(path.length ? path.join(" / ") : defaultLayer), warnings)); }
          catch (e) { warnings.push(`Placemark '${txt(c, "name")}' skipped: ${e.message}`); }
        } else if (t === "GroundOverlay") {
          const g = groundOverlay(c);
          const key = g && zipFiles ? Object.keys(zipFiles).find((k) => k === g.href || k.endsWith("/" + g.href) || g.href.endsWith(k)) : null;
          if (g && key) overlays.push({ name: g.name || "Image", src: bytesToDataURL(zipFiles[key], key), quad: g.quad, opacity: g.opacity });
          else warnings.push(`Image overlay '${txt(c, "name")}' skipped` + (g && !zipFiles ? " (images can only be read from KMZ files)" : " (picture not found)"));
        } else if (["ScreenOverlay", "PhotoOverlay", "NetworkLink"].includes(t)) {
          warnings.push(`${t} '${txt(c, "name")}' is not supported and was skipped`);
        }
      });
    })(root, []);
    const res = finish(layers, features, warnings, overlays.length > 0);
    if (overlays.length) res.groundOverlays = overlays;
    return res;
  };

  G.importKMZ = function (bytes, defaultLayer) {
    let files;
    try { files = fflate.unzipSync(bytes, { filter: (f) => /\.(kml|png|jpe?g|gif|webp|bmp)$/i.test(f.name) && f.originalSize < 200 * 1024 * 1024 }); }
    catch (e) { throw new ImportError("The KMZ file is not a valid ZIP archive"); }
    const names = Object.keys(files).filter((n) => /\.kml$/i.test(n));
    if (!names.length) throw new ImportError("No .kml document found inside the KMZ");
    const main = names.includes("doc.kml") ? "doc.kml" : names.sort((a, b) => a.length - b.length)[0];
    const imgs = {};
    Object.keys(files).forEach((n) => { if (!/\.kml$/i.test(n)) imgs[n] = files[n]; });
    return G.importKML(fflate.strFromU8(files[main]), defaultLayer, imgs);
  };

  /* ---------------- GeoJSON import ---------------- */
  function explode(g) {
    if (!g) return [];
    if (["Point", "LineString", "Polygon"].includes(g.type)) return [g];
    if (g.type === "MultiPoint") return g.coordinates.map((c) => ({ type: "Point", coordinates: c }));
    if (g.type === "MultiLineString") return g.coordinates.map((c) => ({ type: "LineString", coordinates: c }));
    if (g.type === "MultiPolygon") return g.coordinates.map((c) => ({ type: "Polygon", coordinates: c }));
    if (g.type === "GeometryCollection") return (g.geometries || []).flatMap(explode);
    return [];
  }
  G.importGeoJSON = function (text, defaultLayer) {
    let obj;
    try { obj = typeof text === "string" ? JSON.parse(text) : text; } catch (e) { throw new ImportError("The file is not valid JSON: " + e.message); }
    if (obj && Array.isArray(obj.layers) && Array.isArray(obj.features) && obj.type !== "FeatureCollection") obj = { type: "FeatureCollection", features: obj.features, satmap_layers: obj.layers };
    let feats;
    if (obj && obj.type === "FeatureCollection") feats = obj.features || [];
    else if (obj && obj.type === "Feature") feats = [obj];
    else if (obj && ["Point", "LineString", "Polygon", "MultiPoint", "MultiLineString", "MultiPolygon", "GeometryCollection"].includes(obj.type)) feats = [{ type: "Feature", geometry: obj, properties: {} }];
    else throw new ImportError("JSON is not GeoJSON (expected a FeatureCollection, Feature or Geometry)");

    const layers = [], warnings = [], out = [], nameToId = {}, oldToNew = {};
    (obj.satmap_layers || []).forEach((l) => {
      const id = newId();
      oldToNew[l.id] = id; nameToId[l.name || "Layer"] = id;
      layers.push({ id, name: l.name || "Layer", visible: l.visible !== false, locked: false });
    });
    const layerFor = (p) => {
      if (oldToNew[p.layerId]) return oldToNew[p.layerId];
      const nm = p.layerName || p.layer || defaultLayer;
      if (!nameToId[nm]) { nameToId[nm] = newId(); layers.push({ id: nameToId[nm], name: nm, visible: true, locked: false }); }
      return nameToId[nm];
    };
    feats.forEach((f, i) => {
      if (!f || !f.geometry) return;
      const props = Object.assign({}, f.properties || {});
      const lid = layerFor(props);
      const ours = ALL_KINDS.includes(props.kind);
      if (ours && props.kind === "circle" && props.center && props.radius) {
        const c = props.center; delete props.center; delete props.layerName;
        out.push({ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: Object.assign(props, { id: newId(), layerId: lid }) });
        return;
      }
      explode(f.geometry).forEach((g) => {
        let p;
        if (ours) { p = Object.assign({}, props); if (g.type !== f.geometry.type) p.kind = null; }
        else {
          p = { name: String(props.name || props.title || props.Name || ""), description: String(props.description || props.desc || ""), style: {} };
          ["color", "weight", "opacity", "fillColor", "fillOpacity"].forEach((k) => { if (k in props) p.style[k] = props[k]; });
          if ("stroke" in props) Object.assign(p.style, { color: props.stroke, weight: props["stroke-width"] ?? 3, opacity: props["stroke-opacity"] ?? 1, fillColor: props.fill ?? props.stroke, fillOpacity: props["fill-opacity"] ?? 0.25 });
          if (g.type === "Point" && p.name) p.label = { text: p.name, show: true };
        }
        delete p.layerName;
        p.id = newId(); p.layerId = lid;
        if (g.type === "Polygon") {
          try {
            const r = repairPolygon({ type: "Polygon", coordinates: g.coordinates.map(cleanRing) });
            if (r.warning) warnings.push(`Feature ${i + 1}: ${r.warning}`);
            r.parts.forEach((pg) => out.push({ type: "Feature", geometry: pg, properties: Object.assign({}, p, { id: newId() }) }));
          } catch (e) { warnings.push(`Feature ${i + 1} skipped: ${e.message}`); }
          return;
        }
        out.push({ type: "Feature", geometry: g, properties: p });
      });
    });
    return finish(layers, out, warnings);
  };

  /* ---------------- CSV import ---------------- */
  function parseCSV(text) {
    text = text.replace(/^﻿/, "");
    const first = text.split(/\r?\n/, 1)[0] || "";
    const delim = [",", ";", "\t"].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], field = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') q = false;
        else field += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some((v) => v.trim() !== "")) rows.push(row);
        row = [];
      } else field += ch;
    }
    row.push(field);
    if (row.some((v) => v.trim() !== "")) rows.push(row);
    if (!rows.length) return [];
    const head = rows[0].map((h) => h.trim());
    return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
  }
  G.parseCSV = parseCSV;
  const LAT_KEYS = ["lat", "latitude", "y", "lat_dd"], LON_KEYS = ["lon", "lng", "long", "longitude", "x", "lon_dd"];

  G.importTable = function (text, mode, defaultLayer) {
    const rows = parseCSV(text);
    if (!rows.length) throw new ImportError("The table has no data rows");
    const keys = {};
    Object.keys(rows[0]).forEach((k) => { if (k) keys[k.toLowerCase().trim()] = k; });
    const latK = LAT_KEYS.map((k) => keys[k]).find(Boolean), lonK = LON_KEYS.map((k) => keys[k]).find(Boolean);
    if (!latK || !lonK) throw new ImportError("Could not find latitude/longitude columns (use headers 'lat' and 'lon')");
    const nameK = keys.name || keys.label || keys.title, descK = keys.description || keys.desc || keys.remarks, layerK = keys.layer || keys.group;
    const warnings = [], pts = [];
    rows.forEach((r, i) => {
      const lat = parseFloat(String(r[latK]).trim()), lon = parseFloat(String(r[lonK]).trim());
      try {
        if (!/^\s*-?\d/.test(String(r[latK])) || !/^\s*-?\d/.test(String(r[lonK]))) throw new GeometryError("invalid coordinate");
        checkLonLat(lon, lat);
        pts.push([[lon, lat], r]);
      } catch (e) { warnings.push(`Row ${i + 2} skipped: ${e.message}`); }
    });
    if (!pts.length) throw new ImportError("No valid coordinate rows found" + (warnings.length ? ` (${warnings[0]})` : ""));
    const layers = [], layerFor = layerMaker(layers), feats = [];
    if (mode === "line" || mode === "polygon") {
      const coords = pts.map((p) => p[0]), lid = layerFor(defaultLayer);
      feats.push({ type: "Feature", geometry: mode === "line" ? { type: "LineString", coordinates: coords } : { type: "Polygon", coordinates: [coords.concat([coords[0]])] },
        properties: { kind: mode === "line" ? "polyline" : "polygon", name: defaultLayer, layerId: lid } });
    } else {
      pts.forEach(([c, r]) => {
        const nm = nameK ? String(r[nameK] || "") : "";
        feats.push({ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: {
          kind: "marker", name: nm, layerId: layerFor(layerK && r[layerK] ? String(r[layerK]) : defaultLayer),
          description: descK ? String(r[descK] || "") : "", label: { text: nm, show: !!nm } } });
      });
    }
    return finish(layers, feats, warnings);
  };

  /* ---------------- dispatcher ---------------- */
  G.importFile = async function (file, csvMode) {
    const name = (file.name || "").toLowerCase();
    const stem = (file.name || "Imported").replace(/\.[^.]+$/, "") || "Imported";
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!bytes.length) throw new ImportError("The file is empty");
    if (/\.xlsx?$|\.xlsm$/.test(name)) throw new ImportError("Excel files: in Excel choose File → Save As → CSV, then import the .csv file");
    if (name.endsWith(".kmz") || (bytes[0] === 0x50 && bytes[1] === 0x4b)) return G.importKMZ(bytes, stem);
    const text = new TextDecoder("utf-8").decode(bytes);
    if (name.endsWith(".kml")) return G.importKML(text, stem);
    if (/\.(geojson|json)$/.test(name)) return G.importGeoJSON(text, stem);
    if (/\.(csv|txt|tsv)$/.test(name)) return G.importTable(text, csvMode || "points", stem);
    const head = text.slice(0, 200).trimStart();
    if (head.startsWith("<")) return G.importKML(text, stem);
    if (head.startsWith("{")) return G.importGeoJSON(text, stem);
    throw new ImportError("Unsupported file type. Use .kml, .kmz, .geojson, .json or .csv");
  };
})(window.SM);
