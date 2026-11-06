/* =====================================================================
   geodesy.js — WGS84 ellipsoidal calculations in the browser.
   Vincenty inverse/direct for distances and geodesic circles (sub-mm).
   Areas use the equal-area (authalic) mapping of the ellipsoid onto a
   sphere, so they match the ellipsoidal value (PyProj/Karney) closely.
   Coordinates are [lng, lat] (GeoJSON order) unless noted.
   ===================================================================== */
"use strict";
(function (SM) {
  const a = 6378137.0, f = 1 / 298.257223563, b = a * (1 - f);
  const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
  const AUTHALIC_R = 6371007.181;

  /** Vincenty inverse: distance in metres between [lng,lat] points. */
  function distance(p1, p2) {
    const L = rad(p2[0] - p1[0]);
    const U1 = Math.atan((1 - f) * Math.tan(rad(p1[1])));
    const U2 = Math.atan((1 - f) * Math.tan(rad(p2[1])));
    const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1), sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);
    let lambda = L, lambdaP, iter = 100, sinSigma, cosSigma, sigma, sinAlpha, cos2Alpha, cos2SigmaM, C;
    do {
      const sinL = Math.sin(lambda), cosL = Math.cos(lambda);
      sinSigma = Math.sqrt((cosU2 * sinL) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosL) ** 2);
      if (sinSigma === 0) return 0;
      cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosL;
      sigma = Math.atan2(sinSigma, cosSigma);
      sinAlpha = (cosU1 * cosU2 * sinL) / sinSigma;
      cos2Alpha = 1 - sinAlpha * sinAlpha;
      cos2SigmaM = cos2Alpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cos2Alpha : 0;
      C = (f / 16) * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha));
      lambdaP = lambda;
      lambda = L + (1 - C) * f * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
    } while (Math.abs(lambda - lambdaP) > 1e-12 && --iter > 0);
    if (iter === 0) return haversine(p1, p2); // nearly antipodal: fall back
    const uSq = (cos2Alpha * (a * a - b * b)) / (b * b);
    const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
    const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
    const dSigma = B * sinSigma * (cos2SigmaM + (B / 4) * (cosSigma * (-1 + 2 * cos2SigmaM ** 2) - (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));
    return b * A * (sigma - dSigma);
  }
  function haversine(p1, p2) {
    const dLat = rad(p2[1] - p1[1]), dLng = rad(p2[0] - p1[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(p1[1])) * Math.cos(rad(p2[1])) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /** Vincenty direct: point at distance (m) and azimuth (deg) from [lng,lat]. */
  function destination(p, azimuthDeg, dist) {
    const alpha1 = rad(azimuthDeg), sinA1 = Math.sin(alpha1), cosA1 = Math.cos(alpha1);
    const tanU1 = (1 - f) * Math.tan(rad(p[1])), cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1), sinU1 = tanU1 * cosU1;
    const sigma1 = Math.atan2(tanU1, cosA1), sinAlpha = cosU1 * sinA1, cos2Alpha = 1 - sinAlpha * sinAlpha;
    const uSq = (cos2Alpha * (a * a - b * b)) / (b * b);
    const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
    const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
    let sigma = dist / (b * A), sigmaP, iter = 100, cos2SigmaM, sinSigma, cosSigma;
    do {
      cos2SigmaM = Math.cos(2 * sigma1 + sigma);
      sinSigma = Math.sin(sigma); cosSigma = Math.cos(sigma);
      const dS = B * sinSigma * (cos2SigmaM + (B / 4) * (cosSigma * (-1 + 2 * cos2SigmaM ** 2) - (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));
      sigmaP = sigma;
      sigma = dist / (b * A) + dS;
    } while (Math.abs(sigma - sigmaP) > 1e-12 && --iter > 0);
    const tmp = sinU1 * sinSigma - cosU1 * cosSigma * cosA1;
    const lat2 = Math.atan2(sinU1 * cosSigma + cosU1 * sinSigma * cosA1, (1 - f) * Math.sqrt(sinAlpha * sinAlpha + tmp * tmp));
    const lambda = Math.atan2(sinSigma * sinA1, cosU1 * cosSigma - sinU1 * sinSigma * cosA1);
    const C = (f / 16) * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha));
    const L = lambda - (1 - C) * f * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
    let lng2 = p[0] + deg(L);
    lng2 = ((lng2 + 540) % 360) - 180;
    return [lng2, deg(lat2)];
  }

  function lineLength(coords) {
    let s = 0;
    for (let i = 1; i < coords.length; i++) s += distance(coords[i - 1], coords[i]);
    return s;
  }
  function segments(coords) {
    const out = [];
    for (let i = 1; i < coords.length; i++) out.push(distance(coords[i - 1], coords[i]));
    return out;
  }
  /* Authalic latitude: maps the ellipsoid to a sphere of equal surface area,
     preserving area, so spherical-excess formulas give ellipsoidal areas. */
  const e2 = f * (2 - f), e = Math.sqrt(e2);
  const qf = (sinp) => (1 - e2) * (sinp / (1 - e2 * sinp * sinp) - (1 / (2 * e)) * Math.log((1 - e * sinp) / (1 + e * sinp)));
  const QP = qf(1);
  const R_Q = a * Math.sqrt(QP / 2);
  const authalic = (latDeg) => Math.asin(SM_clamp(qf(Math.sin(rad(latDeg))) / QP, -1, 1));
  function SM_clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /** Ring area on the WGS84 ellipsoid (m²). */
  function ringArea(ring) {
    const n = ring.length;
    if (n < 3) return 0;
    const lam = ring.map((c) => rad(c[0])), beta = ring.map((c) => authalic(c[1]));
    // unwrap longitudes so rings crossing the antimeridian work
    for (let i = 1; i < n; i++) { while (lam[i] - lam[i - 1] > Math.PI) lam[i] -= 2 * Math.PI; while (lam[i] - lam[i - 1] < -Math.PI) lam[i] += 2 * Math.PI; }
    let s = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      // exact signed area between edge i→j (great-circle) and the equator, unit sphere
      const t1 = Math.tan(beta[i] / 2), t2 = Math.tan(beta[j] / 2);
      s += 2 * Math.atan2(Math.tan((lam[j] - lam[i]) / 2) * (t1 + t2), 1 + t1 * t2);
    }
    return Math.abs(s) * R_Q * R_Q;
  }
  function polygonArea(rings) {
    if (!rings || !rings.length) return 0;
    let ar = ringArea(open(rings[0]));
    for (let i = 1; i < rings.length; i++) ar -= ringArea(open(rings[i]));
    return Math.max(ar, 0);
  }
  const open = (ring) => (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring);

  function circleRing(center, radius, n) {
    n = n || 72;
    const out = [];
    for (let i = 0; i < n; i++) out.push(destination(center, (i * 360) / n, radius));
    out.push(out[0].slice());
    return out;
  }

  /** Geodesic measurements for a stored feature. */
  function measureFeature(f) {
    const g = f.geometry, p = f.properties;
    if (p.kind === "circle") {
      const r = p.radius || 0;
      return { radius_m: r, area_m2: polygonArea([circleRing(g.coordinates, r, 360)]), perimeter_m: 2 * Math.PI * r, center: g.coordinates };
    }
    if (g.type === "LineString") { const s = segments(g.coordinates); return { length_m: s.reduce((x, y) => x + y, 0), segments_m: s }; }
    if (g.type === "Polygon") {
      const s = segments(g.coordinates[0]);
      return { area_m2: polygonArea(g.coordinates), perimeter_m: s.reduce((x, y) => x + y, 0), segments_m: s };
    }
    if (g.type === "Point") return { center: g.coordinates };
    return {};
  }

  SM.geo = { distance, destination, lineLength, segments, polygonArea, ringArea, circleRing, measureFeature };
})(window.SM);
