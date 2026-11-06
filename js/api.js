/* =====================================================================
   api.js — the "backend", running inside the browser.
   Same interface as the server version, so the rest of the app is
   unchanged:
     • projects → IndexedDB (this browser's private storage)
     • import/export → gis.js
     • measurements → geodesy.js (WGS84 ellipsoid)
     • place search → OpenStreetMap Nominatim, called directly
   ===================================================================== */
"use strict";
(function (SM) {
  const DB_NAME = "satmap", STORE = "projects";
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error("This browser cannot store projects (IndexedDB unavailable — private window?)")); return; }
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" }).createIndex("updated_at", "updated_at");
        if (!db.objectStoreNames.contains("drafts")) db.createObjectStore("drafts");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error("Browser storage is blocked: " + (req.error && req.error.message)));
    });
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
  }
  async function tx(mode, fn, storeName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName || STORE, mode), s = t.objectStore(storeName || STORE);
      let result;
      Promise.resolve(fn(s, (v) => { result = v; })).catch(reject);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(new Error(t.error && t.error.name === "QuotaExceededError" ? "Browser storage is full — delete old projects or download a backup" : "Storage error: " + (t.error && t.error.message)));
      t.onabort = t.onerror;
    });
  }
  const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const clone = (o) => (window.structuredClone ? structuredClone(o) : JSON.parse(JSON.stringify(o)));
  const now = () => new Date().toISOString().slice(0, 19) + "Z";
  const count = (d) => (d && Array.isArray(d.features) ? d.features.length : 0);
  const meta = (r) => ({ id: r.id, name: r.name, created_at: r.created_at, updated_at: r.updated_at, n_features: r.n_features });
  const notFound = () => { const e = new Error("Project not found"); e.status = 404; return e; };

  async function getRaw(id) {
    const r = await tx("readonly", (s, done) => req2p(s.get(id)).then(done));
    if (!r) throw notFound();
    return r;
  }
  async function put(rec) { await tx("readwrite", (s) => req2p(s.put(rec))); return rec; }

  async function createProject(name, data, id) {
    const t = now();
    const d = clone(data || {});
    d.name = name;
    const rec = { id: id || SM.uid() + SM.uid().slice(0, 2), name, data: d, created_at: t, updated_at: t, n_features: count(d) };
    return put(rec);
  }
  async function updateProject(id, name, data) {
    const r = await getRaw(id);
    if (name) r.name = name;
    if (data) r.data = clone(data);
    r.data.name = r.name;
    r.updated_at = now();
    r.n_features = count(r.data);
    await put(r);
    return meta(r);
  }

  /** Ask the browser not to clear our storage when space runs low. */
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  /* ---------------- place search ---------------- */
  const geoCache = new Map();
  let lastGeo = 0;
  async function geocode(q) {
    q = String(q || "").trim();
    if (!q) throw new Error("Enter a place name");
    const cfg = SM.APP_CONFIG;
    if (!cfg.geocoder) throw new Error("Place search is turned off in config.js");
    if (geoCache.has(q.toLowerCase())) return geoCache.get(q.toLowerCase());
    const wait = 1100 - (Date.now() - lastGeo); // Nominatim: max 1 request per second
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastGeo = Date.now();
    const url = cfg.geocoderUrl + "?" + new URLSearchParams({ q, format: "jsonv2", limit: 8, "accept-language": "en" });
    let rows;
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error(r.status);
      rows = await r.json();
    } catch (e) { throw new Error("Place search failed — check your internet connection (coordinates always work)"); }
    const out = rows.filter((r) => r.lat && r.lon).map((r) => ({
      name: r.display_name, lat: +r.lat, lng: +r.lon,
      bbox: r.boundingbox ? r.boundingbox.map(Number) : null, type: r.type,
    }));
    geoCache.set(q.toLowerCase(), out);
    return out;
  }

  /* ---------------- export ---------------- */
  async function exportFile(payload) {
    const fmt = (payload.format || "kml").toLowerCase();
    const opts = { layerIds: payload.layerIds, featureIds: payload.featureIds, onlyVisible: payload.onlyVisible !== false };
    if (fmt === "kml") return new Blob([SM.gis.exportKML(payload.project, opts)], { type: "application/vnd.google-earth.kml+xml" });
    if (fmt === "kmz") {
      // pictures travel inside the KMZ as GroundOverlays (not for "selected shapes" exports)
      const parts = payload.featureIds && payload.featureIds.length ? { xml: "", files: {} } : SM.overlays.kmzParts(payload.project);
      return new Blob([SM.gis.exportKMZ(SM.gis.exportKML(payload.project, Object.assign({ extraXml: parts.xml }, opts)), parts.files)], { type: "application/vnd.google-earth.kmz" });
    }
    if (fmt === "shp") return new Blob([SM.shp.exportZip(payload.project, Object.assign({ crs: payload.crs, baseName: payload.fileName }, opts))], { type: "application/zip" });
    if (fmt === "geojson") return new Blob([JSON.stringify(SM.gis.exportGeoJSON(payload.project, opts), null, 1)], { type: "application/geo+json" });
    throw new Error("format must be kml, kmz or geojson");
  }

  SM.api = {
    config: async () => {
      // providers needing a key are enabled when the user has entered one in Settings
      const cfg = JSON.parse(JSON.stringify(SM.APP_CONFIG));
      const keys = SM.settings.apiKeys || {};
      cfg.providers = cfg.providers.map((p) => {
        if (!p.keySetting) return Object.assign(p, { available: true });
        const key = (keys[p.keySetting] || "").trim();
        p.layers.forEach((l) => { l.url = key ? l.url.replace("{key}", encodeURIComponent(key)) : ""; });
        return Object.assign(p, { available: !!key, unavailable_reason: key ? undefined : "Add your " + p.keySetting + " key in Settings" });
      });
      return cfg;
    },
    listProjects: async () => {
      const all = await tx("readonly", (s, done) => req2p(s.getAll()).then(done));
      return all.map(meta).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    },
    getProject: async (id) => getRaw(id),
    createProject: async (name, data) => meta(await createProject(name, data)),
    updateProject,
    deleteProject: async (id) => { await getRaw(id); await tx("readwrite", (s) => req2p(s.delete(id))); return { deleted: id }; },
    duplicateProject: async (id, name) => { const r = await getRaw(id); return meta(await createProject(name || r.name + " (copy)", r.data)); },
    exportAll: async () => tx("readonly", (s, done) => req2p(s.getAll()).then(done)),
    restoreProjects: async (recs) => { for (const r of recs) await createProject(r.name, r.data); return recs.length; },
    exportFile,
    saveDraft: (d) => tx("readwrite", (s) => req2p(s.put(d, "session")), "drafts").catch(() => {}),
    loadDraft: () => tx("readonly", (s, done) => req2p(s.get("session")).then(done), "drafts").catch(() => null),
    importFile: (file, csvMode) => SM.gis.importFile(file, csvMode),
    measure: async (features) => features.map((f) => { try { return SM.geo.measureFeature(f); } catch (e) { return { error: e.message }; } }),
    geocode,
  };
})(window.SM);
