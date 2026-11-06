# SatMap GIS — browser-only edition

Draw on satellite maps, measure distances and areas, organise drawings in
layers, and export **KML/KMZ (Google Earth)**, **GeoJSON**, **PNG** and
**true-scale PDF**. Everything runs inside the web browser: there is **no
server and nothing to install**, so it can be hosted free on **GitHub Pages**.

---

## Put it on GitHub Pages (about 5 minutes)

1. **Make a GitHub account** at github.com (free) and sign in.
2. Click the **+** at the top right → **New repository**.
   Name it, for example, `satmap`. Choose **Public** (free Pages needs a
   public repository on a free account). Click **Create repository**.
3. On the new repository page click **uploading an existing file**.
4. Open the unzipped `satmap-web` folder on your computer, select
   **everything inside it** (`index.html`, `css`, `js`, `vendor`, `examples`,
   …) and drag it into the browser window. Wait for the upload to finish,
   then click **Commit changes**.
   *Upload the contents, not the folder itself — `index.html` must sit at the top.*
5. Go to **Settings → Pages**. Under *Build and deployment* choose
   **Source: Deploy from a branch**, **Branch: main**, folder **/ (root)**,
   and click **Save**.
6. Wait 1–2 minutes and refresh the page. A link appears:
   `https://YOUR-NAME.github.io/satmap/` — that is your map app.
7. Open `https://YOUR-NAME.github.io/satmap/tests.html` once to confirm
   that every self-test is green.

To update the app later, upload changed files the same way; the site
refreshes within a minute or two.

**Without GitHub:** double-click `index.html` to use it straight from your
computer, or put the folder on any web host (Netlify, an office web server,
IIS, nginx) — it is just static files.

---

## Where is my work stored?

* Projects are saved automatically in **this browser on this device**
  (IndexedDB). Nobody else — not GitHub, not other visitors — can see them.
* Another computer, another browser, or a private/incognito window starts
  empty. **Clearing browsing data deletes the projects.**
* So: use **Open → Back up all** regularly. It downloads one `.json` file
  with every project. **Open → Restore backup** (or Import) brings them back
  on any computer.
* Single projects: **Export → Project backup**.
* To share a drawing with someone, send them the **KML** (opens in Google
  Earth) or the backup file (opens in SatMap).

---

## Using the app (short version)

1. **Find a place** — type a name or coordinates (`25.61, 85.14` or DMS) in
   the search box.
2. **Pick a tool** from the toolbar on the map and draw: click points and
   double-click to finish (lines, polygons), two clicks for rectangles and
   circles, hold and drag for the pen. Type a radius in the hint bar for an
   exact circle.
3. **Edit** — click an object: change colour, width, opacity, labels in the
   right panel; drag it to move it; drag white handles to reshape.
   **Ctrl+Z** undoes.
4. **Layers** — the left panel: add, rename, hide, lock and reorder layers.
5. **Measure** — selecting an object shows its length/area; the ruler
   tools measure without drawing.
6. **Export** — the blue **Export KML** button, or **Export** for KMZ,
   GeoJSON, PNG, PDF and backups.

---

## Removing part of a drawing (Select area)

Choose **Select area** on the toolbar (the dashed box with scissors) or press
**S**. Hold the mouse button and drag a **Box**, or switch to **Lasso** and
draw around the part. Objects *touching the area* (or only those *fully
inside*) are selected; tick *active layer only* to limit it to one layer.
Then choose:

* **Delete objects** — removes the selected objects completely.
* **Cut out area** — like scissors: everything inside the area disappears;
  lines, polygons and circles crossing the edge are cut exactly at the edge
  and the outside parts stay.
* **Keep only area** — the opposite (crop): everything outside goes.

Locked objects and hidden layers are never touched. One **Ctrl+Z** undoes the
whole operation. The selected objects can also be restyled or moved to another
layer from the right panel.

## Measurement units

Click **Units** in the status bar (bottom), use the unit boxes in the
*Measurements* panel or the measure tool, or open ⚙ Settings.

* Length: Auto (m / km), metres, kilometres, feet, yards, miles, Auto (ft / mi)
* Area: Auto (m² / ha / km²), m², hectares, km², acres, **decimal (dismil)**,
  square feet, **square yards (gaj)**

The chosen unit is shown first in the panel, followed by the same value in
every other unit. Map labels, the measure tool, PNG/PDF annotations and the
scale bar follow it (feet/miles for imperial lengths). Exact definitions:
1 ft = 0.3048 m, 1 acre = 4046.8564224 m², 1 decimal = 1/100 acre,
1 gaj = 1 yd² = 0.83612736 m². Exported files (KML, Shapefile) always store
metres and m².

## Rotating the map

Click the **compass** button (top right) to turn the map: slider, exact angle,
±1° / ±15° buttons, **North up**, and **Line up with selected road /
boundary**, which turns the map so the selected line runs left–right. Keys:
**[** and **]** turn 5°, **N** resets. Drawing, editing, measuring, Select area
and picture placement all work on a turned map; labels stay upright. The angle
is saved with the project, and PNG/PDF exports can be *turned like the screen*
with the north arrow pointing to true north (KML, GeoJSON and Shapefile are
unaffected — coordinates never change).

## Pictures, screenshots and site plans

Add a picture with **Pictures & plans → Add**, by dragging the file onto the
map, or by copying a screenshot and pressing **Ctrl+V**. PNG, JPG, WebP, GIF,
BMP and SVG work (TIFF: save as PNG first). Very large pictures are reduced
to 4096 px on the long side.

* **Move:** drag the picture. **Rotate:** drag the round blue handle.
  **Resize:** drag a corner. Exact values: *Rotation °* and *Width (m)* in
  the right panel.
* **Align by points** (most accurate): click a sharp spot on the picture
  (a building corner, a road junction), then the same spot on the satellite
  map — or type its lat, lng. 2 points fix position, size and direction;
  3 or more with *Also correct stretching* fix scanned or skewed plans. The
  panel shows each point's error in metres; drag a green marker to fine-tune.
* **Remove background:** click the colour to remove (or *White* / *Auto*),
  choose *Everywhere* (plans and drawings) or *Only touching the edges*
  (photos, logos), adjust *Strength*. *Restore original* undoes it.
* **Lock in place** when it fits, then draw over it. Pictures appear in PNG
  and PDF exports and travel inside **KMZ** files as Google Earth image
  overlays (re-importing the KMZ brings them back).

## AutoCAD drawings (.dxf and .dwg)

Import a drawing like any other file. The dialog shows its layers, size and
what it contains.

* **Drawings with real coordinates** (UTM, lat/lon, or any system you paste
  from epsg.io): choose the system — UTM is suggested automatically when the
  numbers look like UTM — and the drawing lands exactly in place.
* **Local drawings** (site plans drawn from 0,0): check the units (read from
  the drawing; the dialog shows the resulting size in metres), then the
  drawing appears as a see-through preview. Drag it, rotate it, and use
  **Align by points** — your clicks snap to the exact CAD corner. With
  *Keep true scale* the drawing is only moved and turned, never stretched.
  Click **Place on map**.
* The result is ordinary map objects, one map layer per CAD layer: closed
  polylines become polygons with areas, circles stay circles, arcs, bulges,
  splines, ellipses, blocks, text, dimensions and hatches are converted.
  **Export KML** (or tick *Download as KML straight after placing*) to get a
  Google Earth file. 3-D solids, tables and images inside the DWG are skipped
  and listed.
* **DWG files** use LibreDWG (WebAssembly, 11 MB, loaded only when a DWG is
  opened). They work on the published website, not when `index.html` is
  opened straight from your disk. Tested with DWG versions R13 to 2018.
  If a DWG will not open, save it as DXF in AutoCAD.

## Shapefiles

* **Import:** choose the `.shp`, `.dbf`, `.prj` (and `.cpg`) files together,
  or a `.zip` that contains them. The `.prj` sets the coordinate system; if it
  is missing you are asked (UTM zone suggested). Each shapefile becomes a
  layer; `.dbf` attributes go into each object's description. Hindi and other
  UTF-8 text is supported.
* **Export:** *Export → Shapefile (.zip)*. You get separate point, line and
  polygon shapefiles with `.shx`, `.dbf`, `.prj` and `.cpg`, in WGS84 or a UTM
  zone. Attributes: name, description, layer, type, label, colours, length,
  area (m² and ha) and radius. Checked with GDAL (used by QGIS and ArcGIS).

Practice files are in `examples/`: `site_plan_local_metres.dxf`,
`site_plan_utm45N.dxf`, `plots_utm45N_shapefile.zip`, `scanned_site_plan.png`.

---

Keyboard: S select area · [ ] rotate map · N north up · V select · G move · E edit · F pen · L line · P polygon · R
rectangle · C circle · M marker · T text · A arrow · D measure · Del delete ·
Ctrl+Z/Y undo/redo · Ctrl+D duplicate · Ctrl+S save · Esc cancel.

---

## Settings you can change

**For yourself (in the app, ⚙ Settings):** units, coordinate format,
snapping, autosave, measurement labels, and optional imagery keys.

**For everyone (edit `js/config.js`):** start position and zoom, default base
map, the list of base maps, place-search on/off.

### Optional extra satellite imagery
MapTiler and Mapbox satellite appear when a user pastes their own key into
Settings. The key stays in that user's browser. If you share a key with your
team, restrict it in the provider's dashboard to your site's address
(e.g. `https://your-name.github.io`) so it cannot be misused elsewhere.
**Never write a key into `config.js` on a public site.**

### Imagery licences
Esri World Imagery and OpenStreetMap tiles are shown with their attribution.
Esri's free basemaps suit light/non-commercial use; production or commercial
use needs an ArcGIS account. OpenStreetMap's tile servers allow only light
use. For heavy or official use, add a keyed provider (MapTiler, Mapbox, Esri
location services). Place search uses OpenStreetMap Nominatim (light use,
about one search per second).

---

## Licences

All bundled libraries are MIT/BSD except the DWG reader in
`vendor/libredwg/`, which is **GPL-3.0**. If you publish the site with that
folder, publish it under GPL-3.0 terms: keep the repository public and keep
the notice. If you do not want that, delete `vendor/libredwg/` before
uploading. Everything else still works, and DWG files can be saved as DXF.

## Accuracy

* Coordinates are stored in **WGS84 (EPSG:4326)**, never as screen pixels,
  so shapes and measurements are identical at every zoom level.
* Distances: Vincenty formulas on the WGS84 ellipsoid.
* Areas: exact equal-area mapping of the WGS84 ellipsoid; checked against
  PyProj (Karney) to better than 0.00001 %.
* Circles export as 72-point polygons with every point at the exact radius;
  SatMap re-imports them as true circles.
* Self-intersecting polygons are flagged when drawn and split into valid
  parts on import/export.
* CAD and Shapefile coordinates are converted with proj4 and match PyProj
  exactly. Local CAD drawings are placed in a local Transverse Mercator frame
  (Web Mercator alone would distort them by ~0.5 %), so 200 m stays 200.00 m.
* True-scale PDF: 1:N is exact at the map centre. Print at **Actual size /
  100 %**, not "Fit to page".

---

## Differences from the server (Python) edition

| | Server edition | Browser edition |
|---|---|---|
| Needs installation | Python + start script | Nothing |
| Hosting | Your PC or a Python server | GitHub Pages / any static host / double-click |
| Project storage | SQLite on the server, shared by everyone using that server | This browser only — back up regularly |
| Excel (.xlsx) import | Yes | Save as CSV in Excel first |
| Pictures, AutoCAD, Shapefile | — | Yes (this edition only) |
| Access control | Optional access token | Not needed — each visitor's projects stay in their own browser |

---

## Folder contents

```
index.html          the app
tests.html          self-test page (open it in the browser)
css/style.css       look and layout
js/config.js        ← settings for your site (start view, base maps)
js/                 app code: map, drawing, layers, storage, KML/GeoJSON/CSV, printing
vendor/             Leaflet, Leaflet-Geoman, Turf, jsPDF, fflate, proj4, dxf-parser (MIT/BSD)
vendor/libredwg/    DWG reader (GPL-3.0) — see its README.txt; delete the folder to drop DWG support
examples/           example project, KML, GeoJSON and CSV
dev/e2e_browser.py  optional automated browser test for developers
.nojekyll           tells GitHub Pages to serve files as they are
```

## Troubleshooting

| Problem | Fix |
|---|---|
| GitHub Pages shows 404 | Wait 2 minutes; check `index.html` is at the top of the repository, not inside a sub-folder; check Settings → Pages is set to `main` / root. |
| Map is grey, no imagery | No internet, or a network blocks the tile server. Try another base map. |
| My projects are gone | Different browser/computer/incognito, or browsing data was cleared. Restore your latest backup file. |
| "Browser storage is full" | Delete old projects (Open), after backing up. |
| Place search fails | Needs internet; coordinates always work. |
| PNG/PDF background empty | The imagery provider refused the download; the drawings still export. Try another base map. |
| Excel file rejected | In Excel: File → Save As → CSV, then import the CSV. |
| DWG says "only on the website version" | Open your GitHub Pages link instead of the file on disk, or save as DXF. |
| CAD drawing appears in the wrong place | Re-import and pick the right coordinate system; for local drawings use Align by points. |
| CAD drawing is 1000× too big/small | Change *Drawing units* in the import dialog (mm vs m). |
| Shapefile lands far away | The `.prj` was missing — re-import and choose the right UTM zone. |
| Project became slow | Very large CAD files or many pictures: import fewer CAD layers, or untick text/hatches. |
