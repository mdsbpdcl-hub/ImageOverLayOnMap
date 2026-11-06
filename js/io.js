/* =====================================================================
   io.js — import / export dialogs, project manager, settings dialog
   ===================================================================== */
"use strict";
(function (SM) {
  const IO = {};
  SM.io = IO;

  IO.init = function () {
    SM.$("#btn-import").addEventListener("click", () => SM.$("#file-input").click());
    SM.$("#file-input").addEventListener("change", (e) => { const fs = [...e.target.files]; e.target.value = ""; if (fs.length) IO.importFiles(fs); });
    SM.$("#btn-add-overlay").addEventListener("click", () => SM.$("#file-input").click());
    SM.$("#btn-export-kml").addEventListener("click", () => IO.exportDialog("kml"));
    SM.attachMenu(SM.$("#btn-export-more"), SM.$("#export-menu"));
    SM.$$("#export-menu button[data-export]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.export;
      if (k === "png" || k === "pdf") SM.print.dialog(k);
      else if (k === "project") IO.exportProjectBackup();
      else IO.exportDialog(k);
    }));
    SM.$("#btn-open").addEventListener("click", IO.projectsDialog);
    SM.$("#btn-new").addEventListener("click", IO.newProject);
    SM.$("#btn-save").addEventListener("click", () => SM.store.save());
    SM.$("#btn-settings").addEventListener("click", IO.settingsDialog);

    // drag & drop files onto the map
    const wrap = SM.$("#map-wrap");
    wrap.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
    wrap.addEventListener("drop", (e) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      IO.importFiles([...e.dataTransfer.files]);
    });
  };

  /* ---------------- import ---------------- */
  const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i, SHP_PART_RE = /\.(shp|dbf|prj|cpg|shx|sbn|sbx|qix|xml)$/i;
  /** Entry point for the file picker and drag & drop (several files allowed). */
  IO.importFiles = async function (files) {
    const maxMb = (SM.config && SM.config.maxUploadMb) || 25;
    const big = files.find((f) => f.size > maxMb * 1024 * 1024 && !/\.(dwg|dxf)$/i.test(f.name));
    if (big) { SM.toast(`${big.name} is larger than ${maxMb} MB`, "error"); return; }
    const shpParts = files.filter((f) => SHP_PART_RE.test(f.name));
    const rest = files.filter((f) => !SHP_PART_RE.test(f.name));
    try {
      if (shpParts.length) {
        if (!shpParts.some((f) => /\.shp$/i.test(f.name))) throw new Error("Select the .shp file together with its .dbf and .prj files (or a .zip containing them)");
        await IO.importShapefiles(await Promise.all(shpParts.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
      }
      for (const f of rest) {
        if (SM.cad.isCad(f.name)) await SM.cad.importFile(f); // (browsers call DXF "image/vnd.dxf", so test CAD first)
        else if (IMG_RE.test(f.name) || (/^image\//.test(f.type) && !/dxf|dwg/i.test(f.type))) await SM.overlays.addImageFile(f);
        else if (/\.zip$/i.test(f.name)) {
          const entries = SM.shp.unzip(new Uint8Array(await f.arrayBuffer()));
          if (entries.some((e) => /\.shp$/i.test(e.name))) await IO.importShapefiles(entries);
          else if (entries.some((e) => /\.kml$/i.test(e.name))) await IO.importFile(new File([await f.arrayBuffer()], f.name.replace(/\.zip$/i, ".kmz")));
          else throw new Error("This ZIP contains no shapefile (.shp) or KML");
        } else await IO.importFile(f);
      }
    } catch (e) { SM.toast("Import failed: " + e.message, "error", 7000); }
  };

  /** Shapefile import: one map layer per shapefile, reprojected to WGS84. */
  IO.importShapefiles = async function (entries) {
    const sets = SM.shp.collect(entries);
    if (!sets.length) throw new Error("No .shp file found");
    const read = SM.shp.readSets(sets);
    const c = SM.map.getCenter();
    const rows = [], needPick = [];
    read.forEach((r) => {
      let status, def = null;
      if (r.prj) {
        try { SM.crs.toWgs84(r.prj)([r.bbox[0], r.bbox[1]]); def = r.prj; status = "✓ " + ((/^(PROJCS|GEOGCS|PROJCRS|GEOGCRS)\["([^"]+)"/.exec(r.prj) || [])[2] || "coordinate system from .prj"); }
        catch (e) { status = "⚠ .prj not understood"; }
      } else status = SM.crs.guess(...r.bbox) === "wgs84" ? "✓ looks like longitude/latitude" : "⚠ no .prj file";
      if (!def && SM.crs.guess(...r.bbox) === "wgs84" && !r.prj) def = "+proj=longlat +datum=WGS84 +no_defs";
      if (!def) needPick.push(r.name);
      r._def = def;
      rows.push(SM.el("div", { class: "mline" }, SM.el("span", { text: `${r.name} — ${r.count} shapes` + (r.dbf ? "" : " (no .dbf: no attributes)") }), SM.el("span", { text: status })));
    });
    const guess = read.find((r) => needPick.includes(r.name));
    const pick = SM.crs.picker(guess && SM.crs.guess(...guess.bbox) === "utm" ? "utm" + SM.crs.utmZoneOf(c.lng) + "n" : "wgs84", c.lng, c.lat);
    const target = SM.el("select", { class: "field" },
      SM.el("option", { value: "new", text: "A new layer for each shapefile" }),
      SM.el("option", { value: "active", text: "Active layer: " + SM.store.activeLayer().name }));
    const body = SM.el("div", { class: "form-grid" },
      SM.el("label", { text: "Shapefiles" }), SM.el("div", { class: "meas" }, rows),
      needPick.length ? SM.el("label", { text: "Coordinates of " + (needPick.length > 1 ? "these files" : needPick[0]) }) : null,
      needPick.length ? pick.el : null,
      SM.el("label", { text: "Put objects in" }), target,
      SM.el("div", { class: "full muted", text: "Attributes from the .dbf table are kept in each object's description. Tip: include the .prj file so the position is exact." }));
    await new Promise((resolve) => SM.modal({
      title: "Import Shapefile", body, onClose: resolve,
      buttons: [{ label: "Cancel" }, {
        label: "Import", cls: "primary", action: () => {
          const defs = {};
          try { read.forEach((r) => { defs[r.name] = r._def || pick.value(); }); } catch (e) { SM.toast(e.message, "error"); return false; }
          const res = SM.shp.toFeatures(read, defs);
          if (!res.features.length) { SM.toast("No usable shapes found", "error"); return false; }
          const out = { layers: res.layers, features: [], warnings: res.warnings };
          res.features.forEach((f) => { try { out.features.push(SM.gis.normalizeFeature(f)); } catch (e) { out.warnings.push(e.message); } });
          mergeImport(out, target.value === "active");
          SM.toast(`Imported ${out.features.length} shapes from ${read.length} shapefile(s)`, "ok", 3500);
          if (out.warnings.length) showWarnings(out.warnings);
        },
      }],
    }));
  };

  IO.importFile = async function (file) {
    const maxMb = (SM.config && SM.config.maxUploadMb) || 25;
    if (file.size > maxMb * 1024 * 1024) { SM.toast(`File is larger than ${maxMb} MB`, "error"); return; }
    const name = file.name.toLowerCase();
    if (/\.(xlsx|xls|xlsm)$/.test(name)) { SM.toast("Excel files: in Excel use File → Save As → CSV, then import the .csv", "error", 6000); return; }
    if (!/\.(kml|kmz|geojson|json|csv|txt|tsv)$/.test(name)) { SM.toast("Unsupported file type. Use KML, KMZ, GeoJSON or CSV", "error", 4500); return; }

    // SatMap project backup → open as a project
    if (name.endsWith(".json") || name.endsWith(".geojson")) {
      try {
        const txt = await file.text();
        const obj = JSON.parse(txt);
        if (obj && obj.satmapAllProjects && Array.isArray(obj.projects)) {
          if (await SM.confirm("Restore all projects", `Add ${obj.projects.length} project(s) from this backup to this browser? Existing projects are kept.`, "Restore")) {
            const n = await SM.api.restoreProjects(obj.projects);
            SM.toast(n + " project(s) restored — find them under Open", "ok", 3500);
          }
          return;
        }
        if (obj && obj.satmapProject && obj.project) {
          if (await SM.confirm("Open project backup", `Open "${obj.project.name}" as a new project? Your current project stays saved.`, "Open")) {
            if (SM.state.dirty) await SM.store.save({ silent: true });
            SM.store.load(obj.project, null);
            if (obj.project.viewport) SM.map.setView(obj.project.viewport.center, obj.project.viewport.zoom);
            SM.mapview.setBasemap(obj.project.basemap);
            await SM.store.save({ silent: true });
            SM.toast("Project restored from backup", "ok");
          }
          return;
        }
      } catch (e) { /* not a backup — fall through to normal import */ }
    }

    const isTable = /\.(csv|txt|tsv|xlsx|xlsm)$/.test(name);
    const target = SM.el("select", { class: "field" },
      SM.el("option", { value: "new", text: "New layer(s) from the file" }),
      SM.el("option", { value: "active", text: "Active layer: " + SM.store.activeLayer().name }));
    const mode = SM.el("select", { class: "field" },
      SM.el("option", { value: "points", text: "One marker per row" }),
      SM.el("option", { value: "line", text: "Join rows into a line" }),
      SM.el("option", { value: "polygon", text: "Join rows into a polygon" }));
    const body = SM.el("div", { class: "form-grid" },
      SM.el("label", { text: "File" }), SM.el("div", { text: file.name + " (" + Math.ceil(file.size / 1024) + " KB)" }),
      SM.el("label", { text: "Put objects in" }), target,
      isTable ? SM.el("label", { text: "Rows become" }) : null, isTable ? mode : null,
      isTable ? SM.el("div", { class: "full muted", text: "The table needs columns named lat / latitude and lon / lng / longitude (decimal degrees). Optional: name, description, layer. From Excel, save as CSV first." }) : null);
    SM.modal({
      title: "Import " + (isTable ? "coordinates" : "map data"), body,
      buttons: [{ label: "Cancel" }, {
        label: "Import", cls: "primary", action: async (_, b) => {
          b.disabled = true; b.textContent = "Importing…";
          try {
            const res = await SM.api.importFile(file, mode.value);
            mergeImport(res, target.value === "active");
            let nImg = 0;
            if (res.groundOverlays && res.groundOverlays.length) nImg = await SM.overlays.addImported(res.groundOverlays);
            const n = res.features.length;
            SM.toast(`Imported ${n} object${n === 1 ? "" : "s"}` + (nImg ? ` and ${nImg} picture(s)` : "") + (res.warnings.length ? ` (${res.warnings.length} warning${res.warnings.length > 1 ? "s" : ""})` : ""), "ok", 3500);
            if (res.warnings.length) showWarnings(res.warnings);
          } catch (e) {
            SM.toast("Import failed: " + e.message, "error", 6000);
            b.disabled = false; b.textContent = "Import";
            return false;
          }
        },
      }],
    });
  };
  function mergeImport(res, intoActive) {
    const active = SM.store.activeLayer().id;
    const ids = [];
    SM.store.change((p) => {
      if (!intoActive) res.layers.forEach((l) => p.layers.push({ id: l.id, name: l.name, visible: l.visible !== false, locked: false }));
      res.features.forEach((f) => {
        const s = SM.store.sanitize({ layers: [{ id: f.properties.layerId }], features: [f] }).features[0];
        s.properties.id = SM.uid();
        if (intoActive) s.properties.layerId = active;
        p.features.push(s);
        ids.push(s.properties.id);
      });
      if (!intoActive && res.layers.length) p.activeLayerId = res.layers[res.layers.length - 1].id;
    });
    if (ids.length) SM.mapview.fitFeatures(ids.map(SM.store.feature).filter(Boolean));
  }
  function showWarnings(list) {
    const ul = SM.el("ul", { style: { margin: 0, paddingLeft: "18px" } }, list.map((w) => SM.el("li", { text: w })));
    SM.modal({ title: "Import notes", body: SM.el("div", {}, SM.el("p", { class: "muted", text: "The file was imported. Some items needed attention:" }), ul) });
  }

  /* ---------------- vector export ---------------- */
  IO.exportVector = async function (format, opts) {
    opts = opts || {};
    const p = SM.state.project;
    const payload = Object.assign({ project: Object.assign({}, p, { viewport: { center: [SM.map.getCenter().lat, SM.map.getCenter().lng], zoom: SM.map.getZoom() } }), format, onlyVisible: true }, opts);
    try {
      const blob = await SM.api.exportFile(payload);
      const ext = format === "shp" ? "shapefile.zip" : format;
      SM.downloadBlob(blob, SM.safeName(opts.fileName || p.name) + (opts.suffix || "") + (format === "shp" ? "_" : ".") + ext);
      SM.toast((format === "shp" ? "Shapefile" : format.toUpperCase()) + " exported", "ok", 2000);
    } catch (e) {
      SM.toast("Export failed: " + e.message, "error", 6000);
    }
  };
  IO.exportDialog = function (format) {
    const sel = [...SM.state.selection];
    const layers = SM.store.layers();
    const fmt = SM.el("select", { class: "field" },
      SM.el("option", { value: "kml", text: "KML — Google Earth, QGIS, ArcGIS", selected: format === "kml" }),
      SM.el("option", { value: "kmz", text: "KMZ — compressed KML", selected: format === "kmz" }),
      SM.el("option", { value: "geojson", text: "GeoJSON — web GIS, QGIS", selected: format === "geojson" }),
      SM.el("option", { value: "shp", text: "Shapefile (.zip) — ArcGIS, QGIS, AutoCAD Map", selected: format === "shp" }));
    const c = SM.map.getCenter(), z = SM.crs.utmZoneOf(c.lng), south = c.lat < 0;
    const crsSel = SM.el("select", { class: "field" },
      SM.el("option", { value: "wgs84", text: "WGS84 longitude / latitude (EPSG:4326)" }),
      [...new Set([z, 43, 44, 45, 46])].sort((a, b) => a - b).map((n) => SM.el("option", { value: "utm" + n + (south ? "s" : "n"), text: `UTM zone ${n}${south ? "S" : "N"}, metres (EPSG:${(south ? 32700 : 32600) + n})` + (n === z ? " — this area" : "") })));
    const crsRow = [SM.el("label", { text: "Coordinates" }), crsSel];
    const note = SM.el("div", { class: "full muted" });
    const syncFmt = () => {
      crsRow.forEach((e) => e.classList.toggle("hidden", fmt.value !== "shp"));
      const nImg = (SM.state.project.overlays || []).filter((o) => o.visible).length;
      note.textContent = fmt.value === "shp"
        ? "Creates a .zip with separate point, line and polygon shapefiles (+ .dbf attributes, .prj, UTF-8 .cpg). Circles become 72-point polygons. Lengths and areas are included as attributes."
        : "Coordinates are exported in WGS84 (EPSG:4326). Circles become 72-point geodesic polygons; colours, widths, opacity, labels and descriptions are kept. Re-importing a SatMap KML restores the exact objects." +
          (nImg ? (fmt.value === "kmz" ? ` Your ${nImg} picture(s) are included as image overlays.` : ` Pictures are only included in KMZ.`) : "");
    };
    fmt.addEventListener("change", syncFmt);
    const scopeName = "scope" + SM.uid();
    const radio = (val, label, checked, disabled) => { const r = SM.el("input", { type: "radio", name: scopeName, value: val, checked, disabled }); return SM.el("label", {}, r, label); };
    const scopes = SM.el("div", { class: "radio-row", style: { flexDirection: "column", gap: "6px" } },
      radio("project", "Entire project", !sel.length),
      radio("layers", "Selected layers", false),
      radio("shapes", `Selected shapes (${sel.length})`, !!sel.length, !sel.length));
    const lList = SM.el("div", { class: "check-list hidden" }, [...layers].reverse().map((l) => {
      const c = SM.el("input", { type: "checkbox", value: l.id, checked: l.visible });
      return SM.el("label", {}, c, l.name + " (" + SM.store.featuresInLayer(l.id).length + ")");
    }));
    scopes.addEventListener("change", () => lList.classList.toggle("hidden", scopes.querySelector("input:checked").value !== "layers"));
    const vis = SM.el("input", { type: "checkbox", checked: true });
    const body = SM.el("div", { class: "form-grid" },
      SM.el("label", { text: "Format" }), fmt,
      SM.el("label", { text: "Export" }), scopes,
      SM.el("div", { class: "full" }, lList),
      ...crsRow,
      SM.el("label", { text: "" }), SM.el("label", { class: "check" }, vis, "Only visible layers and objects"),
      note);
    syncFmt();
    SM.modal({
      title: "Export map data", body,
      buttons: [{ label: "Cancel" }, {
        label: "Download", cls: "primary", action: async (_, b) => {
          const scope = scopes.querySelector("input:checked").value;
          const opts = { onlyVisible: vis.checked, crs: crsSel.value };
          if (scope === "layers") {
            opts.layerIds = SM.$$("input:checked", lList).map((c) => c.value);
            if (!opts.layerIds.length) { SM.toast("Tick at least one layer", "error"); return false; }
          }
          if (scope === "shapes") { opts.featureIds = sel; opts.suffix = "-selection"; }
          b.disabled = true; b.textContent = "Exporting…";
          await IO.exportVector(fmt.value, opts);
        },
      }],
    });
  };
  IO.exportProjectBackup = function () {
    const p = SM.state.project;
    p.viewport = { center: [SM.map.getCenter().lat, SM.map.getCenter().lng], zoom: SM.map.getZoom() };
    const blob = new Blob([JSON.stringify({ satmapProject: 1, exportedAt: new Date().toISOString(), project: p }, null, 1)], { type: "application/json" });
    SM.downloadBlob(blob, SM.safeName(p.name) + ".satmap.json");
  };

  /* ---------------- project manager ---------------- */
  IO.newProject = async function () {
    const name = await SM.prompt("New project", "Project name", "Untitled project");
    if (name === null) return;
    if (SM.state.dirty) await SM.store.save({ silent: true });
    const view = { center: [SM.map.getCenter().lat, SM.map.getCenter().lng], zoom: SM.map.getZoom() };
    SM.store.newProject(name.trim() || "Untitled project");
    SM.state.project.viewport = view;
    SM.mapview.setBasemap(SM.state.project.basemap);
    await SM.store.save({ silent: true });
  };
  IO.openProject = async function (id) {
    try {
      if (SM.state.dirty && SM.state.projectId !== id) await SM.store.save({ silent: true });
      const r = await SM.api.getProject(id);
      SM.store.load(r.data, r.id);
      const vp = r.data.viewport;
      if (vp && vp.center) SM.map.setView(vp.center, vp.zoom);
      SM.mapview.setBasemap(r.data.basemap);
      SM.toast(`Opened "${r.name}"`, "ok", 1800);
    } catch (e) { SM.toast("Could not open project: " + e.message, "error"); }
  };
  IO.projectsDialog = async function () {
    const list = SM.el("ul", { class: "proj-list" }, SM.el("li", { class: "empty", text: "Loading…" }));
    const m = SM.modal({
      title: "Projects", body: list, wide: true,
      buttons: [
        { label: "Back up all", action: async () => { await IO.backupAll(); return false; } },
        { label: "Restore backup", action: () => { SM.$("#file-input").click(); } },
        { label: "Open example project", action: async () => { await IO.loadExample(); } },
        { label: "Close" }],
    });
    m.body.prepend(SM.el("div", { class: "warn-box", style: { marginTop: 0, marginBottom: "10px" }, text: "Projects are stored only in this browser on this device. Clearing browsing data deletes them — click “Back up all” now and then, and use Restore backup to move them to another computer or browser." }));
    const refresh = async () => {
      let rows;
      try { rows = await SM.api.listProjects(); } catch (e) { list.innerHTML = ""; list.append(SM.el("li", { class: "empty", text: e.message })); return; }
      list.innerHTML = "";
      if (!rows.length) list.append(SM.el("li", { class: "empty", text: "No saved projects yet — your current work is saved automatically." }));
      rows.forEach((r) => {
        const when = new Date(r.updated_at).toLocaleString();
        const li = SM.el("li", { class: r.id === SM.state.projectId ? "current" : "" },
          SM.icon("folder"),
          SM.el("div", { class: "pinfo", title: "Open" }, SM.el("b", { text: r.name }), SM.el("small", { text: `${r.n_features} objects · updated ${when}` + (r.id === SM.state.projectId ? " · open now" : "") })),
          pbtn("Open", "primary", async () => { m.close(); await IO.openProject(r.id); }),
          pbtn("Rename", "", async () => {
            const n = await SM.prompt("Rename project", "New name", r.name);
            if (!n || !n.trim()) return;
            try {
              await SM.api.updateProject(r.id, n.trim(), null);
              if (r.id === SM.state.projectId) { SM.state.project.name = n.trim(); SM.$("#project-name").value = n.trim(); }
              refresh();
            } catch (e) { SM.toast(e.message, "error"); }
          }),
          pbtn("Duplicate", "", async () => { try { if (r.id === SM.state.projectId && SM.state.dirty) await SM.store.save({ silent: true }); await SM.api.duplicateProject(r.id); refresh(); } catch (e) { SM.toast(e.message, "error"); } }),
          pbtn("Delete", "danger", async () => {
            if (!(await SM.confirm("Delete project", `Permanently delete "${r.name}"? This cannot be undone.`, "Delete", true))) return;
            try {
              await SM.api.deleteProject(r.id);
              if (r.id === SM.state.projectId) { SM.state.projectId = null; SM.store.markDirty(); }
              refresh();
            } catch (e) { SM.toast(e.message, "error"); }
          }));
        li.querySelector(".pinfo").addEventListener("click", async () => { m.close(); await IO.openProject(r.id); });
        list.append(li);
      });
    };
    refresh();
  };
  IO.loadExample = async function () {
    try {
      if (!window.SM_EXAMPLE_PROJECT) await new Promise((res, rej) => {
        const sc = document.createElement("script");
        sc.src = "examples/example_project.js"; sc.onload = res; sc.onerror = () => rej(new Error("examples/example_project.js is missing"));
        document.head.append(sc);
      });
      const obj = SM.clone(window.SM_EXAMPLE_PROJECT);
      if (SM.state.dirty) await SM.store.save({ silent: true });
      SM.store.load(obj.project, null);
      SM.map.setView(obj.project.viewport.center, obj.project.viewport.zoom);
      SM.mapview.setBasemap(obj.project.basemap);
      await SM.store.save({ silent: true });
      SM.toast("Example project loaded and saved as a new project", "ok", 3000);
    } catch (e) { SM.toast("Could not load the example: " + e.message, "error"); }
  };
  IO.backupAll = async function () {
    try {
      const all = await SM.api.exportAll();
      if (!all.length) { SM.toast("No saved projects yet"); return; }
      const blob = new Blob([JSON.stringify({ satmapAllProjects: 1, exportedAt: new Date().toISOString(), projects: all.map((r) => ({ name: r.name, data: r.data })) })], { type: "application/json" });
      SM.downloadBlob(blob, "satmap-backup-" + new Date().toISOString().slice(0, 10) + ".json");
      SM.toast(all.length + " project(s) backed up", "ok");
    } catch (e) { SM.toast("Backup failed: " + e.message, "error"); }
  };
  const pbtn = (label, cls, fn) => { const b = SM.el("button", { class: "mini-btn " + cls, text: label }); b.addEventListener("click", fn); return b; };

  /* ---------------- settings ---------------- */
  IO.settingsDialog = function () {
    const s = SM.settings;
    const sel = (opts, val) => SM.el("select", { class: "field" }, opts.map(([v, t]) => SM.el("option", { value: v, text: t, selected: String(v) === String(val) })));
    const units = sel([["metric", "Metric (m, km, ha)"], ["imperial", "Imperial (ft, mi, acres)"]], s.units);
    const coord = sel([["dd", "Decimal degrees (25.594100, 85.137600)"], ["dms", "Degrees minutes seconds"]], s.coordFormat);
    const snap = SM.el("input", { type: "checkbox", checked: s.snapping });
    const snapD = SM.el("input", { class: "field", type: "number", min: 2, max: 60, value: s.snapDistance });
    const keep = SM.el("input", { type: "checkbox", checked: s.keepTool });
    const ml = sel([["off", "Off"], ["selected", "Selected objects"], ["all", "All objects"]], s.measureLabels);
    const auto = sel([[0, "Off (save manually)"], [2, "2 s after a change"], [5, "5 s after a change"], [15, "15 s after a change"]], s.autosaveSeconds);
    const keys = s.apiKeys || {};
    const kMaptiler = SM.el("input", { class: "field", type: "password", value: keys.maptiler || "", placeholder: "optional — enables MapTiler satellite", autocomplete: "off" });
    const kMapbox = SM.el("input", { class: "field", type: "password", value: keys.mapbox || "", placeholder: "optional — enables Mapbox satellite", autocomplete: "off" });
    const body = SM.el("div", { class: "form-grid" },
      SM.el("label", { text: "Units" }), units,
      SM.el("label", { text: "Coordinates" }), coord,
      SM.el("label", { text: "Snapping" }), SM.el("label", { class: "check" }, snap, "Snap to nearby vertices and edges"),
      SM.el("label", { text: "Snap distance (px)" }), snapD,
      SM.el("label", { text: "After drawing" }), SM.el("label", { class: "check" }, keep, "Keep the drawing tool active"),
      SM.el("label", { text: "Measurement labels" }), ml,
      SM.el("label", { text: "Autosave" }), auto,
      SM.el("label", { text: "MapTiler key" }), kMaptiler,
      SM.el("label", { text: "Mapbox token" }), kMapbox,
      SM.el("div", { class: "full muted", text: `SatMap GIS ${SM.config.version || ""} · runs entirely in your browser. Keys are kept only in this browser; restrict them to your site's address in the provider's dashboard.` }));
    SM.modal({
      title: "Settings", body,
      buttons: [{ label: "Cancel" }, {
        label: "Save", cls: "primary", action: () => {
          Object.assign(s, { units: units.value, coordFormat: coord.value, snapping: snap.checked, snapDistance: SM.clamp(+snapD.value || 15, 2, 60), keepTool: keep.checked, measureLabels: ml.value, autosaveSeconds: +auto.value });
          const oldKeys = JSON.stringify(s.apiKeys || {});
          s.apiKeys = { maptiler: kMaptiler.value.trim(), mapbox: kMapbox.value.trim() };
          SM.saveSettings();
          if (JSON.stringify(s.apiKeys) !== oldKeys) SM.api.config().then((cfg) => { SM.config.providers = cfg.providers; SM.mapview.setProviders(cfg.providers); SM.toast("Base maps updated", "ok", 1800); });
          SM.render.resetEditState();
        },
      }],
    });
  };
})(window.SM);
