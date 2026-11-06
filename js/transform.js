/* =====================================================================
   transform.js — 2-D affine maths used to place images and CAD drawings.

   A matrix is [a, b, c, d, e, f] meaning
       X = a·x + c·y + e
       Y = b·x + d·y + f
   Placement matrices map "model" coordinates (image pixels with y up, or
   CAD drawing units) to Web-Mercator metres (EPSG:3857), the projection
   the map is drawn in. Ground metres = Mercator metres × cos(latitude).
   ===================================================================== */
"use strict";
(function (SM) {
  const X = {};
  SM.xf = X;
  const R = 6378137, MAXLAT = 85.0511287798;

  X.identity = () => [1, 0, 0, 1, 0, 0];
  X.mul = (m, n) => [ // m ∘ n  (apply n first)
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  X.apply = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
  X.det = (m) => m[0] * m[3] - m[1] * m[2];
  X.inv = (m) => {
    const d = X.det(m);
    if (!d) throw new Error("Transformation cannot be inverted");
    return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
  };
  X.translate = (tx, ty) => [1, 0, 0, 1, tx, ty];
  X.scale = (sx, sy) => [sx, 0, 0, sy ?? sx, 0, 0];
  X.rotate = (rad) => [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0];
  /** Apply `m` about pivot point p (rotate/scale around a centre). */
  X.about = (m, p) => X.mul(X.translate(p[0], p[1]), X.mul(m, X.translate(-p[0], -p[1])));
  /** Exact affine from three point pairs (used for CSS/canvas drawing). */
  X.from3 = (s, d) => {
    const [x0, y0] = s[0], [x1, y1] = s[1], [x2, y2] = s[2];
    const den = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    const solve = (u0, u1, u2) => {
      const a = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / den;
      const c = ((u2 - u0) * (x1 - x0) - (u1 - u0) * (x2 - x0)) / den;
      return [a, c, u0 - a * x0 - c * y0];
    };
    const [a, c, e] = solve(d[0][0], d[1][0], d[2][0]), [b, dd, f] = solve(d[0][1], d[1][1], d[2][1]);
    return [a, b, c, dd, e, f];
  };
  /** Uniform scale and rotation (radians, counter-clockwise) contained in m. */
  X.decompose = (m) => ({ scale: Math.sqrt(Math.abs(X.det(m))), sx: Math.hypot(m[0], m[1]), sy: Math.hypot(m[2], m[3]), rot: Math.atan2(m[1], m[0]), skewed: Math.abs(m[0] * m[2] + m[1] * m[3]) > 1e-9 * (m[0] * m[0] + m[1] * m[1]) || Math.abs(Math.hypot(m[0], m[1]) - Math.hypot(m[2], m[3])) > 1e-6 * Math.hypot(m[0], m[1]) });

  /* ---------------- Web Mercator ---------------- */
  X.toMerc = (lat, lng) => {
    const la = Math.max(-MAXLAT, Math.min(MAXLAT, lat));
    return [R * (lng * Math.PI) / 180, R * Math.log(Math.tan(Math.PI / 4 + (la * Math.PI) / 360))];
  };
  X.fromMerc = (x, y) => [((2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180) / Math.PI, (x / R) * 180 / Math.PI]; // [lat, lng]
  X.mercScaleAt = (lat) => 1 / Math.cos((lat * Math.PI) / 180); // Mercator metres per ground metre

  /* ---------------- least-squares fitting ---------------- */
  /** Similarity (move + rotate + uniform scale), no mirroring. ≥2 pairs.
      opts.scale fixes the scale (true-scale CAD: then 1 pair = move only, keeping opts.rot). */
  X.fitSimilarity = function (src, dst, opts) {
    opts = opts || {};
    const fixedScale = opts.scale;
    const n = src.length;
    if (n < (fixedScale ? 1 : 2)) throw new Error("Need at least " + (fixedScale ? 1 : 2) + " point pairs");
    let sx = 0, sy = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) { sx += src[i][0]; sy += src[i][1]; dx += dst[i][0]; dy += dst[i][1]; }
    sx /= n; sy /= n; dx /= n; dy /= n;
    let a = 0, b = 0, ss = 0;
    for (let i = 0; i < n; i++) {
      const ux = src[i][0] - sx, uy = src[i][1] - sy, vx = dst[i][0] - dx, vy = dst[i][1] - dy;
      a += ux * vx + uy * vy; b += ux * vy - uy * vx; ss += ux * ux + uy * uy;
    }
    let rot = Math.atan2(b, a), s;
    if (fixedScale) s = fixedScale;
    else { if (ss === 0) throw new Error("The picked drawing points are all in the same place"); s = Math.hypot(a, b) / ss; }
    if (n === 1) rot = opts.rot || 0;
    const c = Math.cos(rot) * s, si = Math.sin(rot) * s;
    return [c, si, -si, c, dx - (c * sx - si * sy), dy - (si * sx + c * sy)];
  };
  /** General affine (allows stretch and skew). ≥3 pairs, not all in a line. */
  X.fitAffine = function (src, dst) {
    if (src.length < 3) throw new Error("Need at least 3 point pairs");
    // normal equations for [x y 1] · [a c e]ᵀ = X  (and same for Y)
    const N = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0];
    src.forEach((p, i) => {
      const r = [p[0], p[1], 1];
      for (let j = 0; j < 3; j++) { for (let k = 0; k < 3; k++) N[j][k] += r[j] * r[k]; bx[j] += r[j] * dst[i][0]; by[j] += r[j] * dst[i][1]; }
    });
    const solve3 = (A, v) => {
      const m = A.map((row, i) => row.concat(v[i]));
      for (let i = 0; i < 3; i++) {
        let p = i; for (let r = i + 1; r < 3; r++) if (Math.abs(m[r][i]) > Math.abs(m[p][i])) p = r;
        [m[i], m[p]] = [m[p], m[i]];
        if (Math.abs(m[i][i]) < 1e-12 * (Math.abs(m[0][0]) + 1)) throw new Error("The picked points are in a straight line — pick points spread around the drawing");
        for (let r = 0; r < 3; r++) if (r !== i) { const f = m[r][i] / m[i][i]; for (let k = i; k < 4; k++) m[r][k] -= f * m[i][k]; }
      }
      return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
    };
    const [a, c, e] = solve3(N, bx), [b, d, f] = solve3(N, by);
    return [a, b, c, d, e, f];
  };
  /** Per-pair residuals in ground metres (dst given in Mercator metres). */
  X.residuals = function (m, src, dst) {
    return src.map((p, i) => {
      const q = X.apply(m, p);
      const lat = X.fromMerc(dst[i][0], dst[i][1])[0];
      return Math.hypot(q[0] - dst[i][0], q[1] - dst[i][1]) / X.mercScaleAt(lat);
    });
  };
})(window.SM);
