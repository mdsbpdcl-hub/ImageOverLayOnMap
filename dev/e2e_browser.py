"""End-to-end browser test (optional).

Drives the real UI in headless Chromium: draws every shape type, edits
styles, uses undo/redo, layers, save/reload, and the KML/GeoJSON/PNG/PDF
exports.  Serve the folder first (python -m http.server 8000), then:

    pip install playwright && playwright install chromium
    python tests/e2e_browser.py            # default http://127.0.0.1:8000
    python tests/e2e_browser.py http://host:port

Map tiles may fail to load without internet access; the test does not
depend on imagery.
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000/"
OUT = Path(tempfile.mkdtemp(prefix="satmap-e2e-"))
errors: list[str] = []


def feats(page):
    return page.evaluate("SM.store.features().map(f => ({kind: f.properties.kind, type: f.geometry.type, layer: f.properties.layerId, id: f.properties.id, n: f.geometry.type === 'Point' ? 1 : (f.geometry.type === 'LineString' ? f.geometry.coordinates.length : f.geometry.coordinates[0].length), radius: f.properties.radius, color: f.properties.style.color}))")


def tool(page, name):
    page.click(f'#toolbar button[data-tool="{name}"]')
    page.wait_for_timeout(150)


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        errors.append(msg)


def run(viewport=(1440, 900), mobile=False):
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome") if Path("/usr/bin/google-chrome").exists() else p.chromium.launch()
        ctx = browser.new_context(viewport={"width": viewport[0], "height": viewport[1]}, accept_downloads=True, has_touch=mobile, is_mobile=mobile)
        page = ctx.new_page()
        console_errors = []
        page.on("console", lambda m: m.type == "error" and "tile" not in m.text.lower() and "ERR_" not in m.text and "Failed to load resource" not in m.text and console_errors.append(m.text))
        page.on("pageerror", lambda e: console_errors.append("pageerror: " + str(e)))
        page.goto(BASE)
        page.wait_for_function("window.SM && SM.state.project && SM.map")
        page.evaluate("localStorage.clear()")
        page.reload()
        page.wait_for_function("window.SM && SM.state.project && SM.map")
        page.wait_for_timeout(500)
        if mobile:
            page.screenshot(path=str(OUT / "mobile.png"))
            check(page.is_visible("#toolbar"), "mobile: toolbar visible")
            check(not page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), "mobile: no horizontal page scroll")
            browser.close()
            return console_errors

        box = page.locator("#map").bounding_box()
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        page.evaluate("SM.map.setView([25.6195, 85.1442], 17, {animate:false})")
        page.wait_for_timeout(200)

        # --- polygon: click 4 points, close on first point
        tool(page, "polygon")
        pts = [(cx - 200, cy - 150), (cx - 60, cy - 160), (cx - 50, cy - 40), (cx - 210, cy - 30)]
        for x, y in pts:
            page.mouse.click(x, y)
            page.wait_for_timeout(80)
        page.mouse.click(*pts[0])
        page.wait_for_timeout(300)
        f = feats(page)
        check(len(f) == 1 and f[0]["kind"] == "polygon" and f[0]["n"] == 5, "polygon drawn with 4 vertices")

        # --- polyline: click 3 points, double-click to finish
        tool(page, "polyline")
        page.mouse.click(cx + 20, cy - 150); page.wait_for_timeout(80)
        page.mouse.click(cx + 120, cy - 120); page.wait_for_timeout(80)
        page.mouse.dblclick(cx + 200, cy - 160); page.wait_for_timeout(300)
        f = feats(page)
        check(f[-1]["kind"] == "polyline" and f[-1]["n"] >= 3, f"polyline drawn ({f[-1]['n']} vertices)")

        # --- arrow with the Finish button
        tool(page, "arrow")
        page.mouse.click(cx + 20, cy + 20); page.wait_for_timeout(80)
        page.mouse.click(cx + 150, cy + 60); page.wait_for_timeout(80)
        page.click("#hint-finish"); page.wait_for_timeout(300)
        f = feats(page)
        check(f[-1]["kind"] == "arrow", "arrow drawn and finished with button")
        check(page.locator(".sm-arrowhead").count() >= 1, "arrow head rendered")

        # --- rectangle
        tool(page, "rectangle")
        page.mouse.click(cx - 200, cy + 30); page.wait_for_timeout(80)
        page.mouse.click(cx - 80, cy + 120); page.wait_for_timeout(300)
        check(feats(page)[-1]["kind"] == "rectangle", "rectangle drawn")

        # --- circle by drag-click and by fixed radius
        tool(page, "circle")
        page.mouse.click(cx + 250, cy + 150); page.wait_for_timeout(80)
        page.mouse.click(cx + 300, cy + 150); page.wait_for_timeout(300)
        c = feats(page)[-1]
        check(c["kind"] == "circle" and c["radius"] > 0, f"circle drawn (r={c['radius']:.1f} m)")
        tool(page, "circle")
        page.fill("#circle-radius", "75")
        page.mouse.click(cx + 250, cy - 50); page.wait_for_timeout(300)
        c = feats(page)[-1]
        check(c["kind"] == "circle" and abs(c["radius"] - 75) < 1e-9, "circle with typed radius 75 m")

        # --- marker & text
        tool(page, "marker"); page.mouse.click(cx - 300, cy + 200); page.wait_for_timeout(300)
        check(feats(page)[-1]["kind"] == "marker", "marker placed")
        tool(page, "text"); page.mouse.click(cx, cy + 220); page.wait_for_timeout(300)
        check(feats(page)[-1]["kind"] == "text", "text label placed")
        page.fill("#prop-label-text", "Gate 1")
        page.wait_for_timeout(200)
        check(page.evaluate("SM.store.features().slice(-1)[0].properties.label.text") == "Gate 1", "text edited from properties panel")
        check("Gate 1" in page.inner_text("#map"), "text visible on map")

        # --- freehand
        tool(page, "freehand")
        page.mouse.move(cx - 350, cy - 250); page.mouse.down()
        for i in range(30):
            page.mouse.move(cx - 350 + i * 6, cy - 250 + (i % 7) * 5)
        page.mouse.up(); page.wait_for_timeout(300)
        f = feats(page)[-1]
        check(f["kind"] == "freehand" and f["type"] == "LineString" and f["n"] >= 3, f"freehand stroke stored as geographic line ({f['n']} pts)")
        n_total = len(feats(page))

        # --- select polygon, change colour, undo/redo
        tool(page, "select")
        page.mouse.click(cx - 130, cy - 100); page.wait_for_timeout(300)
        sel = page.evaluate("[...SM.state.selection]")
        check(len(sel) == 1 and page.evaluate("SM.store.feature(SM.state.selection.values().next().value).properties.kind") == "polygon", "click selects polygon")
        page.evaluate("""() => { const i = document.querySelector('#props input[type=color]'); i.value = '#ff0000'; i.dispatchEvent(new Event('input', {bubbles:true})); }""")
        page.wait_for_timeout(200)
        check(page.evaluate("SM.store.feature([...SM.state.selection][0]).properties.style.color") == "#ff0000", "border colour changed")
        check(page.evaluate("document.querySelector('.sm-selected').getAttribute('stroke')") == "#ff0000", "map updated immediately")
        page.keyboard.press("Control+z"); page.wait_for_timeout(200)
        check(page.evaluate("SM.store.features()[0].properties.style.color") != "#ff0000", "undo restores colour")
        page.keyboard.press("Control+y"); page.wait_for_timeout(200)
        check(page.evaluate("SM.store.features()[0].properties.style.color") == "#ff0000", "redo reapplies colour")

        # --- vertex editing handles appear & drag moves vertex
        handles = page.locator(".marker-icon").count()
        check(handles >= 4, f"vertex handles shown for selected polygon ({handles})")
        before = page.evaluate("JSON.stringify(SM.store.features()[0].geometry)")
        page.mouse.move(*pts[1]); page.mouse.down(); page.mouse.move(pts[1][0] + 40, pts[1][1] - 30, steps=6); page.mouse.up()
        page.wait_for_timeout(300)
        check(page.evaluate("JSON.stringify(SM.store.features()[0].geometry)") != before, "dragging a vertex edits the stored geometry")

        # --- move the whole polygon by dragging its body
        before = page.evaluate("SM.store.features()[0].geometry.coordinates[0][2]")
        page.mouse.move(cx - 140, cy - 90); page.mouse.down(); page.mouse.move(cx - 100, cy - 60, steps=8); page.mouse.up()
        page.wait_for_timeout(300)
        after = page.evaluate("SM.store.features()[0].geometry.coordinates[0][2]")
        check(before != after, "dragging the shape moves it")

        # --- duplicate, layers, move to layer, hide layer
        page.keyboard.press("Control+d"); page.wait_for_timeout(200)
        check(len(feats(page)) == n_total + 1, "Ctrl+D duplicates selection")
        page.click("#btn-add-layer"); page.wait_for_timeout(200)
        page.keyboard.press("Enter")
        check(page.evaluate("SM.store.layers().length") == 2, "new layer created")
        lid2 = page.evaluate("SM.state.project.activeLayerId")
        page.select_option("#props select", lid2)
        page.wait_for_timeout(200)
        check(page.evaluate(f"SM.store.feature([...SM.state.selection][0]).properties.layerId") == lid2, "object moved to new layer")
        vis_before = page.locator("#map path.leaflet-interactive").count()
        page.click(f'#layer-list li[data-id="{lid2}"] .ib >> nth=0'); page.wait_for_timeout(200)
        check(page.locator("#map path.leaflet-interactive").count() < vis_before, "hiding a layer removes its objects from the map")
        page.click(f'#layer-list li[data-id="{lid2}"] .ib >> nth=0'); page.wait_for_timeout(200)

        # --- measurements in panel
        page.evaluate("SM.store.select(SM.store.features().find(f => f.properties.kind==='circle' && Math.abs(f.properties.radius-75)<1).properties.id)")
        page.wait_for_timeout(900)
        txt = page.inner_text("#meas-group")
        check("75.0 m" in txt and "ha" in txt and "WGS84" in txt, "circle radius and area shown (WGS84 geodesic)")

        # --- measure tool
        tool(page, "measure")
        page.mouse.click(cx - 100, cy + 250); page.wait_for_timeout(80)
        page.mouse.dblclick(cx + 100, cy + 250); page.wait_for_timeout(700)
        check(" m" in page.inner_text("#measure-box"), "measure tool shows distance")
        page.keyboard.press("Escape")

        # --- save, reload, restore
        page.keyboard.press("Control+s"); page.wait_for_timeout(800)
        pid = page.evaluate("SM.state.projectId")
        n = len(feats(page))
        page.reload(); page.wait_for_function("window.SM && SM.state.project && SM.map"); page.wait_for_timeout(700)
        check(page.evaluate("SM.state.projectId") == pid and len(feats(page)) == n, f"session restored after reload ({n} objects)")
        check(page.evaluate("SM.store.features()[0].properties.style.color") == "#ff0000", "styling persisted")

        # --- exports
        def download(trigger, label):
            with page.expect_download(timeout=60000) as d:
                trigger()
            path = OUT / d.value.suggested_filename
            d.value.save_as(path)
            check(path.stat().st_size > 200, f"{label} downloaded ({path.name}, {path.stat().st_size} bytes)")
            return path

        page.click("#btn-export-kml"); page.wait_for_timeout(200)
        kml = download(lambda: page.click(".modal-foot .btn.primary"), "KML")
        k = kml.read_text()
        check("<Folder>" in k and k.count("<Placemark") == n, "KML holds every object in layer folders")
        page.click("#btn-export-more"); page.click('#export-menu button[data-export="geojson"]'); page.wait_for_timeout(200)
        gj = download(lambda: page.click(".modal-foot .btn.primary"), "GeoJSON")
        check(len(json.loads(gj.read_text())["features"]) == n, "GeoJSON holds every object")
        page.click("#btn-export-more"); page.click('#export-menu button[data-export="png"]'); page.wait_for_timeout(200)
        page.select_option(".modal select >> nth=0", "png")
        download(lambda: page.click(".modal-foot .btn.primary"), "PNG")
        page.wait_for_timeout(300)
        page.click("#btn-export-more"); page.click('#export-menu button[data-export="pdf"]'); page.wait_for_timeout(200)
        page.evaluate("""() => { const s = [...document.querySelectorAll('.modal select')]; s[3].value = 'fixed'; s[3].dispatchEvent(new Event('change')); }""")
        page.fill('.modal input[type=number]', "2500")
        pdf = download(lambda: page.click(".modal-foot .btn.primary"), "PDF (true scale 1:2500)")
        check(pdf.read_bytes()[:4] == b"%PDF", "PDF is a valid PDF")

        # --- import the exported KML back
        before = len(feats(page))
        page.set_input_files("#file-input", str(kml)); page.wait_for_timeout(300)
        page.click(".modal-foot .btn.primary"); page.wait_for_timeout(1200)
        check(len(feats(page)) == before * 2, "re-importing the KML recreates every object")

        page.screenshot(path=str(OUT / "desktop.png"))
        browser.close()
        return console_errors


if __name__ == "__main__":
    print("Desktop:")
    ce = run()
    print("Mobile:")
    ce += run((390, 844), mobile=True)
    for e in ce:
        print("  console error:", e)
    print(f"\nScreenshots and downloads in {OUT}")
    if errors or ce:
        print(f"{len(errors)} check(s) failed, {len(ce)} console error(s)")
        sys.exit(1)
    print("All browser checks passed")
