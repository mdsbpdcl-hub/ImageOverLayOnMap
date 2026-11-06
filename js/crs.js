/* =====================================================================
   crs.js — coordinate reference systems (via proj4js).
   Used to read Shapefiles/CAD drawings drawn in projected coordinates
   (e.g. UTM metres) and to write Shapefiles in UTM.
   ===================================================================== */
"use strict";
(function (SM) {
  const C = {};
  SM.crs = C;
  const WGS84 = "+proj=longlat +datum=WGS84 +no_defs";

  C.utmDef = (zone, south) => `+proj=utm +zone=${zone}${south ? " +south" : ""} +datum=WGS84 +units=m +no_defs`;
  C.utmZoneOf = (lng) => Math.max(1, Math.min(60, Math.floor((lng + 180) / 6) + 1));

  /** Choices offered in dialogs. India spans UTM 42N–47N; Bihar is 44N–45N. */
  C.choices = function (lng, lat) {
    const z = C.utmZoneOf(lng ?? 85), south = (lat ?? 25) < 0;
    const zones = [...new Set([z, 43, 44, 45, 46])].sort((a, b) => a - b);
    return [
      { id: "wgs84", label: "WGS84 longitude / latitude (degrees)", def: WGS84 },
      ...zones.map((n) => ({ id: "utm" + n + (south ? "s" : "n"), label: `UTM zone ${n}${south ? "S" : "N"} (WGS84, metres)` + (n === z ? " — this map area" : ""), def: C.utmDef(n, south) })),
      { id: "custom", label: "Other… (paste EPSG proj4 text or .prj WKT)", def: null },
    ];
  };

  /** Build a converter source CRS → [lon, lat]. def: proj4 string or WKT. */
  C.toWgs84 = function (def) {
    if (!def || def === WGS84) return (p) => [p[0], p[1]];
    if (!window.proj4) throw new Error("Projection library not loaded");
    let conv;
    try { conv = proj4(def, WGS84); } catch (e) { throw new Error("This coordinate system is not understood: " + (e.message || e)); }
    return (p) => conv.forward([p[0], p[1]]);
  };
  C.fromWgs84 = function (def) {
    if (!def || def === WGS84) return (p) => [p[0], p[1]];
    const conv = proj4(WGS84, def);
    return (p) => conv.forward([p[0], p[1]]);
  };

  /**
   * A local metric frame (Transverse Mercator, scale 1, centred on lat/lng).
   * Web Mercator is not conformal on the WGS84 ellipsoid — north–south and
   * east–west scales differ by ~0.5 % — so true-scale CAD placement is done in
   * this frame. J maps local east/north metres → Web-Mercator metres (affine).
   */
  C.localFrame = function (lat, lng) {
    const def = `+proj=tmerc +lat_0=${lat} +lon_0=${lng} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs`;
    const conv = proj4(WGS84, def);
    const toLonLat = (p) => conv.inverse([p[0], p[1]]);
    const fromLonLat = (p) => conv.forward([p[0], p[1]]);
    const m = (e, n) => { const q = toLonLat([e, n]); return SM.xf.toMerc(q[1], q[0]); };
    const o = m(0, 0), ex = m(10, 0), ny = m(0, 10);
    const J = [(ex[0] - o[0]) / 10, (ex[1] - o[1]) / 10, (ny[0] - o[0]) / 10, (ny[1] - o[1]) / 10, o[0], o[1]];
    return { lat, lng, toLonLat, fromLonLat, J, Jinv: SM.xf.inv(J) };
  };
  /** Frame centred on a Web-Mercator point. */
  C.frameAtMerc = (m) => { const [lat, lng] = SM.xf.fromMerc(m[0], m[1]); return C.localFrame(lat, lng); };

  /** Rough guess of what coordinates are, from their extent. */
  C.guess = function (minX, minY, maxX, maxY) {
    if (minX >= -180 && maxX <= 180 && minY >= -90 && maxY <= 90 && (maxX - minX) < 20) return "wgs84";
    if (minX > 100000 && maxX < 900000 && minY >= 0 && maxY < 10000000) return "utm";
    return "local";
  };

  /** ESRI-style WKT for .prj files we write. */
  const GEOG = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
  C.prjFor = function (id) {
    if (!id || id === "wgs84") return GEOG;
    const m = /^utm(\d+)([ns])$/.exec(id);
    if (!m) throw new Error("Unsupported output coordinate system");
    const zone = +m[1], south = m[2] === "s";
    return `PROJCS["WGS_1984_UTM_Zone_${zone}${south ? "S" : "N"}",${GEOG},PROJECTION["Transverse_Mercator"],` +
      `PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",${south ? "10000000.0" : "0.0"}],PARAMETER["Central_Meridian",${zone * 6 - 183}.0],` +
      `PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]`;
  };
  C.defFor = (id) => {
    if (!id || id === "wgs84") return WGS84;
    const m = /^utm(\d+)([ns])$/.exec(id);
    return m ? C.utmDef(+m[1], m[2] === "s") : null;
  };

  /** A <select> + custom text box; returns {el, value()} where value() is a proj4 def or WKT. */
  C.picker = function (preferId, lng, lat) {
    const list = C.choices(lng, lat);
    const sel = SM.el("select", { class: "field" }, list.map((c) => SM.el("option", { value: c.id, text: c.label, selected: c.id === preferId })));
    const custom = SM.el("textarea", { class: "field hidden", rows: 3, placeholder: "e.g. +proj=utm +zone=44 +datum=WGS84 +units=m   or the contents of a .prj file   (find yours at epsg.io)" });
    sel.addEventListener("change", () => custom.classList.toggle("hidden", sel.value !== "custom"));
    custom.classList.toggle("hidden", sel.value !== "custom");
    return {
      el: SM.el("div", {}, sel, custom), select: sel,
      value: () => {
        if (sel.value === "custom") {
          const t = custom.value.trim();
          if (!t) throw new Error("Paste the coordinate system definition");
          C.toWgs84(t)([0, 0]); // validate
          return t;
        }
        return list.find((c) => c.id === sel.value).def;
      },
      id: () => sel.value,
    };
  };
})(window.SM);
