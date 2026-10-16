/*!
 * FrameEase 0.1.1
 * Spline easing driven by frameCount, with an optional tuning panel.
 * https://github.com/yuta-01/frame-ease
 * Curve presets: Robert Penner's Easing Equations (BSD-3-Clause). See LICENSE.
 */
(function (root) {
  'use strict';

  const VERSION = '0.1.1';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const DEFAULT_STATE = Object.freeze({
    duration: 60,
    delay: 0,
    loopDelay: 0,
    stagger: 0,
    loop: false,
    alternate: false,
    points: '',
    endY: 1,
  });

  const PEAK_MIN_SPEED = 1;

  const BLOCK_START = '// ---- frame-ease state ----';
  const BLOCK_END = '// ---- frame-ease state end ----';

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const round3 = (v) => Math.round(v * 1000) / 1000;

  const warn = (...args) => {
    if (typeof console !== 'undefined' && console.warn) console.warn(...args);
  };

  function pt(x, y, mode, slopeIn, slopeOut) {
    return { x, y, mode: mode || 'auto', in: slopeIn || 0, out: slopeOut || 0 };
  }

  function linearPoints() {
    return [pt(0, 0), pt(1, 1)];
  }

  function clonePoints(points) {
    return points.map((p) => pt(p.x, p.y, p.mode, p.in, p.out));
  }

  // 180° flip of curve 0 for auto-generated curve 1 (between slot without points).
  function flipCurvePoints(points, endY) {
    const ey = Number.isFinite(+endY) ? +endY : 1;
    const mapped = points.slice().reverse().map((p) => pt(1 - p.x, ey - p.y, p.mode, p.out, p.in));
    return normalizePoints(mapped, ey);
  }

  // ---------------------------------------------------------------------------
  // Curve: piecewise cubic Hermite, y = f(x)
  //
  // Hermite (not Bezier): editable points sit on the curve (better sketching
  // UI than off-curve Bezier handles). The same point+slope list is also what
  // we save and what between lerps — edit / save / between stay one representation.
  // ---------------------------------------------------------------------------

  // Auto slopes keep the acceleration continuous at each point (natural cubic spline:
  // second derivative matches on both sides, and is 0 at a free end). Points whose
  // slope is already known split the solve into runs:
  // - manual slopes (`/s`, `/in/out`, startSlope, endSlope)
  // - a point level with a neighbour (holds stay flat)
  // - a point above or below both neighbours (peaks and dips land on the point)
  // - a free end whose slope would point against its segment (no backwards start)
  // - an auto end of a segment that leaves its points' height range by more than
  //   OVERSHOOT_TOL, capped with the Fritsch-Carlson limit (bulging shapes give up
  //   smoothness to stay in range). Segments touching a manual point are left alone.
  const LEVEL_EPS = 1e-6;
  const OVERSHOOT_TOL = 0.02;

  function segmentSecants(points) {
    const n = points.length;
    const h = [];
    const d = [];
    for (let i = 0; i < n - 1; i++) {
      h.push(points[i + 1].x - points[i].x);
      d.push((points[i + 1].y - points[i].y) / h[i]);
    }
    return { h, d, n };
  }

  function fillKnownSlopes(points) {
    const n = points.length;
    const known = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const p = points[i];
      if (p.mode === 'manual') {
        known[i] = { in: p.in, out: p.out };
        continue;
      }
      const dl = i > 0 ? p.y - points[i - 1].y : null;
      const dr = i < n - 1 ? points[i + 1].y - p.y : null;
      const level = (dl != null && Math.abs(dl) <= LEVEL_EPS) || (dr != null && Math.abs(dr) <= LEVEL_EPS);
      const peak = dl != null && dr != null && ((dl > LEVEL_EPS && dr < -LEVEL_EPS) || (dl < -LEVEL_EPS && dr > LEVEL_EPS));
      if (level || peak) known[i] = { in: 0, out: 0 };
    }
    return known;
  }

  function pinBackwardsFreeEnds(n, d, known, m) {
    let pinned = false;
    for (const [i, seg, side] of [[0, d[0], 'out'], [n - 1, d[n - 2], 'in']]) {
      if (known[i] || !(m[i][side] * seg < 0)) continue;
      known[i] = { in: 0, out: 0 };
      pinned = true;
    }
    return pinned;
  }

  // Normalized end slopes (÷ segment secant) capped like Fritsch-Carlson on one Hermite piece.
  function fcCapHermiteAlphas(al, be, freeA, freeB) {
    if (freeA && al < 0) al = 0;
    if (freeB && be < 0) be = 0;
    if (al * al + be * be > 9) {
      if (freeA && freeB) {
        const t = 3 / Math.sqrt(al * al + be * be);
        al *= t;
        be *= t;
      } else if (freeA) al = Math.sqrt(Math.max(0, 9 - be * be));
      else be = Math.sqrt(Math.max(0, 9 - al * al));
    }
    return [al, be];
  }

  function slopeFromAlpha(seg, alpha) {
    const m = alpha * seg;
    return { in: m, out: m };
  }

  // How far one Hermite segment leaves the height range of its two points.
  // ma, mb are the end slopes scaled by the segment width.
  function segmentOvershoot(ya, yb, ma, mb) {
    const c = ma;
    const b = 3 * (yb - ya) - 2 * ma - mb;
    const a = 2 * (ya - yb) + ma + mb;
    const ts = [];
    const A = 3 * a;
    const B = 2 * b;
    if (Math.abs(A) < 1e-12) {
      if (Math.abs(B) > 1e-12) ts.push(-c / B);
    } else {
      const disc = B * B - 4 * A * c;
      if (disc >= 0) {
        const r = Math.sqrt(disc);
        ts.push((-B - r) / (2 * A), (-B + r) / (2 * A));
      }
    }
    const lo = Math.min(ya, yb);
    const hi = Math.max(ya, yb);
    let out = 0;
    for (const t of ts) {
      if (!(t > 0 && t < 1)) continue;
      const y = ((a * t + b) * t + c) * t + ya;
      out = Math.max(out, lo - y, y - hi);
    }
    return out;
  }

  function capOvershootSlopes(points, h, d, known, m, tol) {
    const n = points.length;
    for (let pass = 0; pass <= n; pass++) {
      let capped = false;
      for (let s = 0; s < n - 1; s++) {
        if (points[s].mode === 'manual' || points[s + 1].mode === 'manual') continue;
        const freeA = !known[s];
        const freeB = !known[s + 1];
        if (!freeA && !freeB) continue;
        const ma = h[s] * m[s].out;
        const mb = h[s] * m[s + 1].in;
        if (segmentOvershoot(points[s].y, points[s + 1].y, ma, mb) <= tol) continue;
        let al = m[s].out / d[s];
        let be = m[s + 1].in / d[s];
        [al, be] = fcCapHermiteAlphas(al, be, freeA, freeB);
        if (freeA) known[s] = slopeFromAlpha(d[s], al);
        if (freeB) known[s + 1] = slopeFromAlpha(d[s], be);
        m = solveRuns(h, d, known);
        capped = true;
      }
      if (!capped) break;
    }
    return m;
  }

  // Tridiagonal solve for each run of points without a known slope.
  function solveRuns(h, d, known) {
    const n = known.length;
    const m = known.map((k) => (k ? { in: k.in, out: k.out } : null));
    let i = 0;
    while (i < n) {
      if (known[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < n && !known[j + 1]) j++;
      const a = [];
      const b = [];
      const c = [];
      const r = [];
      for (let q = i; q <= j; q++) {
        let aq = 0;
        let bq = 0;
        let cq = 0;
        let rq = 0;
        if (q > 0) {
          aq = 1 / h[q - 1];
          bq += 2 / h[q - 1];
          rq += (3 * d[q - 1]) / h[q - 1];
        }
        if (q < n - 1) {
          cq = 1 / h[q];
          bq += 2 / h[q];
          rq += (3 * d[q]) / h[q];
        }
        if (q === i && q > 0) {
          rq -= aq * known[q - 1].out;
          aq = 0;
        }
        if (q === j && q < n - 1) {
          rq -= cq * known[q + 1].in;
          cq = 0;
        }
        a.push(aq);
        b.push(bq);
        c.push(cq);
        r.push(rq);
      }
      const k = j - i + 1;
      for (let t = 1; t < k; t++) {
        const w = a[t] / b[t - 1];
        b[t] -= w * c[t - 1];
        r[t] -= w * r[t - 1];
      }
      const x = new Array(k);
      x[k - 1] = r[k - 1] / b[k - 1];
      for (let t = k - 2; t >= 0; t--) x[t] = (r[t] - c[t] * x[t + 1]) / b[t];
      for (let t = 0; t < k; t++) m[i + t] = { in: x[t], out: x[t] };
      i = j + 1;
    }
    return m;
  }

  function resolveSlopes(points, overshootTol = OVERSHOOT_TOL) {
    const { h, d, n } = segmentSecants(points);
    const known = fillKnownSlopes(points);
    let m = solveRuns(h, d, known);
    if (pinBackwardsFreeEnds(n, d, known, m)) m = solveRuns(h, d, known);
    if (Number.isFinite(overshootTol)) m = capOvershootSlopes(points, h, d, known, m, overshootTol);
    return m;
  }

  // Returns [value, derivative] at x in [0,1].
  function evaluate(points, slopes, x) {
    if (!(x > 0)) x = 0;
    else if (x > 1) x = 1;
    let i = 0;
    while (i < points.length - 2 && x > points[i + 1].x) i++;
    const a = points[i];
    const b = points[i + 1];
    const h = b.x - a.x;
    const t = (x - a.x) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const ma = slopes[i].out;
    const mb = slopes[i + 1].in;
    const y =
      (2 * t3 - 3 * t2 + 1) * a.y + (t3 - 2 * t2 + t) * h * ma +
      (-2 * t3 + 3 * t2) * b.y + (t3 - t2) * h * mb;
    const dy =
      ((6 * t2 - 6 * t) * a.y + (3 * t2 - 4 * t + 1) * h * ma +
       (-6 * t2 + 6 * t) * b.y + (3 * t2 - 2 * t) * h * mb) / h;
    return [y, dy];
  }

  // evaluate()'s y alone: no slope, no array. The same arithmetic, so the same value.
  function evaluateY(points, slopes, x) {
    if (!(x > 0)) x = 0;
    else if (x > 1) x = 1;
    let i = 0;
    while (i < points.length - 2 && x > points[i + 1].x) i++;
    const a = points[i];
    const b = points[i + 1];
    const h = b.x - a.x;
    const t = (x - a.x) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * a.y + (t3 - 2 * t2 + t) * h * slopes[i].out +
      (-2 * t3 + 3 * t2) * b.y + (t3 - t2) * h * slopes[i + 1].in;
  }

  // Local maxima of |f'| above the average speed.
  function findPeaks(points, slopes, N = 300) {
    const v = [];
    for (let i = 0; i <= N; i++) v.push(Math.abs(evaluate(points, slopes, i / N)[1]));
    // Tolerance keeps rounding noise on straight segments from becoming peaks.
    const tol = 1e-9;
    const peaks = [];
    for (let i = 1; i < N; i++) {
      if (v[i] - v[i - 1] > tol && v[i] - v[i + 1] >= -tol && v[i] > PEAK_MIN_SPEED + tol) peaks.push(i / N);
    }
    return peaks;
  }

  class Curve {
    constructor(points) {
      this.setPoints(points);
    }

    setPoints(points) {
      this.points = points;
      this.invalidate();
    }

    invalidate() {
      this._slopes = null;
      this._peaks = null;
    }

    get slopes() {
      return this._slopes || (this._slopes = resolveSlopes(this.points));
    }

    get peaks() {
      return this._peaks || (this._peaks = findPeaks(this.points, this.slopes));
    }

    evaluate(x) {
      return evaluate(this.points, this.slopes, x);
    }

    value(x) {
      return evaluateY(this.points, this.slopes, x);
    }
  }

  // ---------------------------------------------------------------------------
  // Inner points only: '.2 -.15, .55 1.25 /0, .8 .9 /2/-1'
  // Endpoint slopes are startSlope / endSlope. Strings that still include
  // (0,0) and (1,1) parse, and those endpoint slopes move onto the ends.
  // ---------------------------------------------------------------------------

  const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
  const POINT_RE = new RegExp(
    `^(${NUM})\\s+(${NUM})(?:\\s*/\\s*(${NUM})(?:\\s*/\\s*(${NUM}))?)?$`
  );

  function parsePoints(str) {
    const fail = () => {
      warn(`FrameEase: cannot read points ${JSON.stringify(str)}. Using a straight line.`);
      return linearPoints();
    };
    if (typeof str !== 'string') return fail();
    const items = str.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    if (items.length === 0) return linearPoints();
    const pts = [];
    for (const item of items) {
      const m = POINT_RE.exec(item);
      if (!m) return fail();
      const p = pt(+m[1], +m[2]);
      if (m[3] !== undefined) {
        p.mode = 'manual';
        p.in = +m[3];
        p.out = m[4] !== undefined ? +m[4] : p.in;
      }
      if (![p.x, p.y, p.in, p.out].every(Number.isFinite)) return fail();
      pts.push(p);
    }
    return normalizePoints(pts, 1);
  }

  // Sorts by x and pins the endpoints to (0,0) and (1, endY).
  function normalizePoints(pts, endY = 1) {
    const ey = Number.isFinite(+endY) ? +endY : 1;
    const sorted = pts.slice().sort((a, b) => a.x - b.x);
    let start = null;
    let end = null;
    const inner = [];
    for (const p of sorted) {
      if (p.x <= 0) start = p;
      else if (p.x >= 1) end = end || p;
      else inner.push(p);
    }
    const out = [start ? pt(0, 0, start.mode, start.in, start.out) : pt(0, 0)];
    for (const p of inner) {
      if (p.x - out[out.length - 1].x < 1e-6 || 1 - p.x < 1e-6) continue;
      out.push(pt(p.x, p.y, p.mode, p.in, p.out));
    }
    out.push(end ? pt(1, ey, end.mode, end.in, end.out) : pt(1, ey));
    return out;
  }

  function fmtNum(v) {
    const r = round3(v);
    if (r === 0) return '0';
    return String(r).replace(/^(-?)0\./, '$1.');
  }

  function formatPoint(p) {
    let s = fmtNum(p.x) + ' ' + fmtNum(p.y);
    if (p.mode === 'manual') {
      const a = fmtNum(p.in);
      const b = fmtNum(p.out);
      s += a === b ? ` /${a}` : ` /${a}/${b}`;
    }
    return s;
  }

  // Endpoints stay on the curve. The string is the points between them.
  function formatPoints(points) {
    return points.slice(1, -1).map(formatPoint).join(', ');
  }

  function setSlope(p, slope) {
    p.mode = 'manual';
    p.in = p.out = slope;
  }

  // String form, snapshot arrays, and explicit startSlope / endSlope / endY keys.
  function materializePoints(s) {
    let pts;
    if (Array.isArray(s && s.points)) {
      pts = clonePoints(s.points);
      if (pts.length < 2) pts = linearPoints();
      const endY = s.endY != null && Number.isFinite(+s.endY) ? +s.endY : pts[pts.length - 1].y;
      const start = pts[0];
      const end = pts[pts.length - 1];
      pts[0] = pt(0, 0, start.mode, start.in, start.out);
      pts[pts.length - 1] = pt(1, endY, end.mode, end.in, end.out);
    } else {
      const endY = s && s.endY != null && Number.isFinite(+s.endY) ? +s.endY : 1;
      pts = parsePoints(s && typeof s.points === 'string' ? s.points : '');
      pts[pts.length - 1].y = endY;
    }
    if (s && s.startSlope != null && Number.isFinite(+s.startSlope)) setSlope(pts[0], +s.startSlope);
    if (s && s.endSlope != null && Number.isFinite(+s.endSlope)) setSlope(pts[pts.length - 1], +s.endSlope);
    return pts;
  }

  function assignSlopes(out, points) {
    if (points[0].mode === 'manual') out.startSlope = points[0].out;
    const end = points[points.length - 1];
    if (end.mode === 'manual') out.endSlope = end.in;
  }

  // Control points and resolved slopes, paired by index. u is not clamped.
  function betweenPoints(pa, sa, pb, sb, u) {
    const n = Math.min(pa.length, pb.length);
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(pt(
        pa[i].x + (pb[i].x - pa[i].x) * u,
        pa[i].y + (pb[i].y - pa[i].y) * u,
        'manual',
        sa[i].in + (sb[i].in - sa[i].in) * u,
        sa[i].out + (sb[i].out - sa[i].out) * u
      ));
    }
    return out;
  }

  // A between call: the values of two neighbouring step curves mixed by f. Stands in for a curve
  // wherever only value(), points and endY are read. Each easing reuses one for its calls; a call
  // the panel keeps gets a copy.
  class BetweenMix {
    constructor(u, a, b, f) {
      this.set(u, a, b, f);
    }

    set(u, a, b, f) {
      this.u = u;
      this.a = a;
      this.b = b;
      this.f = f;
      this.endY = b ? a.endY + (b.endY - a.endY) * f : a.endY;
      return this;
    }

    copy() {
      return new BetweenMix(this.u, this.a, this.b, this.f);
    }

    value(p) {
      const y = this.a.curve.value(p);
      return this.b ? y + (this.b.curve.value(p) - y) * this.f : y;
    }

    get points() {
      return this.b ? this.a.curve.points.concat(this.b.curve.points) : this.a.curve.points;
    }
  }

  // Points and slopes of two curves with the same number of points, ready to blend.
  // The curve with fewer points is resampled at the other's x positions: each new point
  // takes its y and slope from the original curve there, and the endpoints stay as they are.
  function alignedPoints(ca, cb) {
    const na = ca.points.length;
    const nb = cb.points.length;
    if (na === nb) return [ca.points, ca.slopes, cb.points, cb.slopes];
    if (na < nb) {
      const [pts, slopes] = resampleOnto(ca, cb);
      return [pts, slopes, cb.points, cb.slopes];
    }
    const [pts, slopes] = resampleOnto(cb, ca);
    return [ca.points, ca.slopes, pts, slopes];
  }

  // Rebuild `src` with the same x positions as `ref`: [points, slopes]. Endpoints stay; inner points
  // take y and slope from src at that x.
  function resampleOnto(src, ref) {
    const last = ref.points.length - 1;
    const pts = [];
    const slopes = [];
    for (let i = 0; i <= last; i++) {
      if (i === 0 || i === last) {
        const j = i === 0 ? 0 : src.points.length - 1;
        const p = src.points[j];
        pts.push(pt(i === 0 ? 0 : 1, p.y, p.mode, p.in, p.out));
        slopes.push(src.slopes[j]);
        continue;
      }
      const x = ref.points[i].x;
      const [y, dy] = src.evaluate(x);
      pts.push(pt(x, y, 'manual', dy, dy));
      slopes.push({ in: dy, out: dy });
    }
    return [pts, slopes];
  }

  // ---------------------------------------------------------------------------
  // Playback: frame -> progress (0..1)
  // ---------------------------------------------------------------------------

  // The same values inside as in the options: false, true (walks the curve backward) or 'mirror'
  // (walks it forward, and the value is flipped after evaluation: endY - curve(s)). Anything else is false.
  let alternateWarned = false;
  function alternateMode(v) {
    return v === 'mirror' ? 'mirror' : v === true;
  }

  function normalizeAlternate(v) {
    const known = v === true || v === false || v == null || v === 'mirror';
    if (!known && !alternateWarned) {
      alternateWarned = true;
      warn(`FrameEase: unknown alternate ${JSON.stringify(v)}; using false (accepted: false, true, "mirror")`);
    }
    return alternateMode(known ? v : false);
  }

  // Progress (0..1) and phase of `frame` (a number, or null), worked out together; `mode` is
  // alternateMode(opts.alternate).
  // Phase is where the frame sits in one cycle; holds are the stopped poses when loop is off.
  // The answer is written into one shared object: read it right away.
  const cycle = { progress: 1, phase: 'end' };
  function cycleAt(frame, opts, mode) {
    const d = opts.duration;
    const w = opts.loopDelay;
    const loop = opts.loop;
    let progress;
    let phase;
    if (frame == null || !(d > 0)) {
      progress = 1;
      phase = 'end';
    } else if (!(frame >= 0)) {
      progress = 0;
      phase = 'before';
    } else if (mode === false) {
      if (!loop && frame >= d) {
        progress = 1;
        phase = 'hold-end';
      } else {
        const t = frame % (d + w);
        progress = t < d ? t / d : 1;
        phase = t < d ? 'go' : 'wait-right';
      }
    } else if (!loop && frame >= 2 * d + w) {
      progress = 0;
      phase = 'hold-start';
    } else {
      const t = frame % (2 * (d + w));
      if (t < d) {
        progress = t / d;
        phase = 'go';
      } else if (t < d + w) {
        progress = 1;
        phase = 'wait-right';
      } else if (t < 2 * d + w) {
        const s = (t - d - w) / d;
        progress = mode === 'mirror' ? s : 1 - s;
        phase = 'return';
      } else {
        progress = 0;
        phase = 'wait-left';
      }
    }
    cycle.progress = progress;
    cycle.phase = phase;
    return cycle;
  }

  function progressAt(frame, opts) {
    return cycleAt(frame == null ? null : +frame, opts, alternateMode(opts.alternate)).progress;
  }

  function phaseAt(frame, opts) {
    return cycleAt(frame == null ? null : +frame, opts, alternateMode(opts.alternate)).phase;
  }

  function isWaitingPhase(phase) {
    return phase === 'wait-right' || phase === 'wait-left' || phase === 'hold-end' || phase === 'hold-start';
  }

  function curveOutput(curve, progress, mode, phase, endY = 1) {
    const y = curve.value(progress);
    if (mode === 'mirror' && phase === 'return') return endY - y;
    return y;
  }

  // Value a curve would return at `frame` (same path as playback / between).
  function valueAt(curve, endY, frame, opts) {
    const mode = alternateMode(opts.alternate);
    const at = cycleAt(frame == null ? null : +frame, opts, mode);
    return curveOutput(curve, at.progress, mode, at.phase, endY);
  }

  // ---------------------------------------------------------------------------
  // Calls: one frame call or one curve lookup, and the record of it for the GUI
  // ---------------------------------------------------------------------------

  // Where the GUI part plugs into the core. The core never names anything in the GUI part: it only
  // calls these, and skips them while they are empty (frame-ease.core.min.js has no GUI part).
  // - onCall(entry): a frame call or a curve lookup was made
  // - onChange(): an easing was created, or state was imported
  // - gui(opts): the body of FrameEase.gui()
  // wantsCall() says whether onCall would keep a curve lookup, so the record is not built for nothing.
  // onFrameCall(e, hasIndex) sees every frame call and says the same for it. checkCall looks at the
  // options of every call.
  const hooks = { onCall: null, wantsCall: null, onFrameCall: null, checkCall: null, onChange: null, gui: null };

  // p5's frameCount when present; otherwise null (non-p5 hosts stay safe).
  function liveFrameCount() {
    if (typeof frameCount === 'number' && Number.isFinite(frameCount)) return frameCount;
    try {
      if (typeof root.frameCount === 'number' && Number.isFinite(root.frameCount)) return root.frameCount;
    } catch (_) {
      // Ignore hosts that throw on property access.
    }
    return null;
  }

  // The second argument of a call, read once where the call comes in (get / curveAt): { index, between }.
  // Other values give neither.
  // - index: a finite number, or null
  // - u: between clamped to 0..1 (0 when it is not a finite number), or null when there is no
  //   `between` key
  // The answer is written into one shared object: read it right away.
  const callRead = { index: null, u: null };
  function readCallOpts(callOpts) {
    let index = null;
    let u = null;
    if (callOpts !== null && typeof callOpts === 'object' && !Array.isArray(callOpts)) {
      const i = callOpts.index;
      if (i != null && Number.isFinite(+i)) index = +i;
      if (Object.prototype.hasOwnProperty.call(callOpts, 'between')) {
        const raw = callOpts.between;
        u = typeof raw === 'number' && Number.isFinite(raw) ? clamp(raw, 0, 1) : 0;
      }
    }
    callRead.index = index;
    callRead.u = u;
    return callRead;
  }

  // The frame the curve is read at: the call's frame (a finite number, or null) less the one-time
  // delay, then the per-index stagger. A negative result is "before start"; a delay that leaves
  // nothing finite reads as no frame. delay and stagger come as the easing keeps them: 0 or more.
  function effectiveFrame(frame, delay, index, stagger) {
    if (frame == null) return null;
    if (delay > 0) {
      frame -= delay;
      if (!Number.isFinite(frame)) return null;
    }
    if (index == null) return frame;
    return frame - index * stagger;
  }

  function recordFrameCall(owner, betweenSlot, frame, progress, phase, value, endY, meta) {
    hooks.onCall({
      kind: 'frame',
      owner,
      betweenSlot: betweenSlot || null,
      frame,
      t: null,
      progress,
      phase,
      value,
      endY,
      waiting: isWaitingPhase(phase),
      hasIndex: !!(meta && meta.hasIndex),
      index: meta && meta.index != null ? meta.index : null,
      rawFrame: meta.rawFrame,
      live: meta && meta.live != null ? meta.live : null,
      usesBetween: !!(meta && meta.usesBetween),
    });
  }

  function recordCurveCall(owner, betweenSlot, t, value, endY, usesBetween) {
    hooks.onCall({
      kind: 'curve',
      owner,
      betweenSlot: betweenSlot || null,
      frame: null,
      t,
      progress: t,
      phase: 'go',
      value,
      endY,
      waiting: false,
      usesBetween: !!usesBetween,
    });
  }

  // One frame call: apply the index shortcut, evaluate the curve, remember the call on the easing
  // and log it for the panel. The easing supplies duration, delay, stagger and alternate.
  // `raw` is the call's frame as a number (NaN when it is not one), or null.
  function playFrame(e, curve, endY, betweenSlot, raw, index, usesBetween) {
    const hasIndex = index != null;
    const eff = effectiveFrame(Number.isFinite(raw) ? raw : null, e.delay, index, e.stagger);
    const mode = alternateMode(e.alternate);
    const at = cycleAt(eff, e, mode);
    const progress = at.progress;
    const phase = at.phase;
    e.lastFrame = eff;
    e.lastProgress = progress;
    e.lastCall = 'frame';
    const value = curveOutput(curve, progress, mode, phase, endY);
    if (hooks.onFrameCall && hooks.onFrameCall(e, hasIndex)) {
      recordFrameCall(e, betweenSlot && betweenSlot.copy(), eff, progress, phase, value, endY, {
        hasIndex,
        index,
        rawFrame: raw,
        live: liveFrameCount(),
        usesBetween,
      });
    }
    return value;
  }

  // A direct curve lookup at t (0..1), logged like a frame call.
  function playCurve(e, curve, endY, betweenSlot, t, usesBetween) {
    t = +t;
    if (!Number.isFinite(t)) t = 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    e.lastCall = 'curve';
    e.lastCurveT = t;
    e.lastProgress = t;
    const value = curve.value(t);
    if (hooks.onCall && hooks.wantsCall()) recordCurveCall(e, betweenSlot && betweenSlot.copy(), t, value, endY, usesBetween);
    return value;
  }

  // ---------------------------------------------------------------------------
  // State block keys (written in FrameEase.importState)
  // ---------------------------------------------------------------------------

  // Time keys live on the layer. Inside `between` they are ignored.
  const TIME_KEYS = ['duration', 'loopDelay', 'loop', 'alternate', 'stagger', 'delay'];
  const CURVE_KEYS = ['points', 'startSlope', 'endSlope', 'endY'];
  // A between call's u falls between two of these steps; step k is the point blend at k / BETWEEN_STEPS.
  const BETWEEN_STEPS = 64;

  function pickCurveKeys(src) {
    const out = {};
    if (!src || typeof src !== 'object') return out;
    if (typeof src.points === 'string') out.points = src.points;
    else if (Array.isArray(src.points)) out.points = src.points;
    if (src.startSlope != null && Number.isFinite(+src.startSlope)) out.startSlope = +src.startSlope;
    if (src.endSlope != null && Number.isFinite(+src.endSlope)) out.endSlope = +src.endSlope;
    if (src.endY != null && Number.isFinite(+src.endY)) out.endY = +src.endY;
    return out;
  }

  function hasCurveKey(src) {
    return !!src && CURVE_KEYS.some((k) => src[k] != null);
  }

  function pickState(src) {
    const out = {};
    if (!src || typeof src !== 'object') return out;
    if (src.duration != null && Number.isFinite(+src.duration)) out.duration = Math.max(0, +src.duration);
    if (src.delay != null && Number.isFinite(+src.delay)) out.delay = Math.max(0, +src.delay);
    if (src.loopDelay != null && Number.isFinite(+src.loopDelay)) out.loopDelay = Math.max(0, +src.loopDelay);
    if (src.stagger != null && Number.isFinite(+src.stagger)) out.stagger = Math.max(0, +src.stagger);
    if (src.loop != null) out.loop = !!src.loop;
    if (src.alternate != null) out.alternate = normalizeAlternate(src.alternate);
    Object.assign(out, pickCurveKeys(src));
    if (src.between && typeof src.between === 'object' && !Array.isArray(src.between)) {
      out.between = pickCurveKeys(src.between);
      out.betweenTiming = TIME_KEYS.filter((k) => src.between[k] != null);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Registry
  // ---------------------------------------------------------------------------

  const instances = new Map();
  const dataStore = Object.create(null);
  const optionsWarned = new Set();

  class Easing {
    constructor(name) {
      this.name = name;
      this.curve = new Curve(linearPoints());
      this.betweenCurve = null;
      this.betweenAuto = false;
      this._showFrameTiming = null;
      this._duration = DEFAULT_STATE.duration;
      this._delay = DEFAULT_STATE.delay;
      this._loopDelay = DEFAULT_STATE.loopDelay;
      this._stagger = DEFAULT_STATE.stagger;
      this._loop = DEFAULT_STATE.loop;
      this._alternate = DEFAULT_STATE.alternate;
      this.pointGen = 0;
      this._autoGen = -1;
      this._mix = null;
      this._betweens = new Map();
      this._betweensGen = 0;
      this._betweenBuilds = 0;
      this._warnedTiming = false;
      this._warnedAlign = false;
      this._warnedKeys = new Set();
      this._warnedNumberIndex = false;
      this.lastFrame = null;
      this.lastProgress = 0;
      this.lastCall = 'frame';
      this.lastCurveT = 0;
      this.api = makeApi(this);
      this.resolve();
    }

    get duration() { return this._duration; }
    set duration(v) { this._duration = v; }

    get delay() { return this._delay; }
    set delay(v) { this._delay = Math.max(0, +v || 0); }

    get loopDelay() { return this._loopDelay; }
    set loopDelay(v) { this._loopDelay = v; }

    get stagger() { return this._stagger; }
    set stagger(v) { this._stagger = Math.max(0, +v || 0); }

    get loop() { return this._loop; }
    set loop(v) { this._loop = v; }

    get alternate() { return this._alternate; }
    set alternate(v) { this._alternate = normalizeAlternate(v); }

    // Values come only from the state block (and the defaults).
    codeState() {
      return Object.assign({}, DEFAULT_STATE, pickState(dataStore[this.name]));
    }

    resolve() {
      this.applyState(this.codeState());
    }

    get endY() {
      return this.curve.points[this.curve.points.length - 1].y;
    }

    get betweenEndY() {
      return this.betweenCurve ? this.betweenCurve.points[this.betweenCurve.points.length - 1].y : this.endY;
    }

    // Accepts points as a string (serial form) or an array (snapshot form).
    applyState(s) {
      if (s.duration != null) this._duration = s.duration;
      if (s.delay != null) this._delay = Math.max(0, +s.delay || 0);
      if (s.loopDelay != null) this._loopDelay = s.loopDelay;
      if (s.stagger != null) this._stagger = Math.max(0, +s.stagger || 0);
      if (s.loop != null) this._loop = s.loop;
      if (s.alternate != null) this._alternate = normalizeAlternate(s.alternate);
      this.curve.setPoints(materializePoints(s));
      this.betweenAuto = false;
      if (s.between != null) {
        const raw = s.between;
        if (hasCurveKey(raw)) {
          const pts = materializePoints(raw);
          if (!this.betweenCurve) this.betweenCurve = new Curve(pts);
          else this.betweenCurve.setPoints(pts);
          this.alignPair();
        } else {
          this.betweenAuto = true;
          this.syncAutoBetween();
        }
        if (s.betweenTiming && s.betweenTiming.length) this.warnTiming(s.betweenTiming);
      } else {
        this.betweenCurve = null;
      }
      this.pointGen++;
      this._betweens.clear();
    }

    syncAutoBetween() {
      const pts = flipCurvePoints(this.curve.points, this.endY);
      if (!this.betweenCurve) this.betweenCurve = new Curve(pts);
      else this.betweenCurve.setPoints(pts);
      this.betweenCurve.invalidate();
    }

    markBetweenManual() {
      if (!this.betweenAuto) return;
      this.betweenAuto = false;
      this.pointGen++;
      this._betweens.clear();
    }

    // An auto curve 1 follows curve 0, so it is made again only when the points have changed
    // (pointGen, the same signal the step curves follow).
    ensureBetweenCurve() {
      if (this.betweenCurve && !this.betweenAuto) return;
      if (!this.betweenCurve) this.betweenAuto = true;
      else if (this._autoGen === this.pointGen) return;
      this.syncAutoBetween();
      this._autoGen = this.pointGen;
    }

    warnTiming(keys) {
      if (this._warnedTiming) return;
      this._warnedTiming = true;
      warn(`FrameEase: "${this.name}" has time keys inside between (${keys.join(', ')}). They are ignored.`);
    }

    warnAlign() {
      if (this._warnedAlign) return;
      this._warnedAlign = true;
      warn(`FrameEase: curves 0 and 1 of "${this.name}" have different numbers of points. The one with fewer was resampled to match.`);
    }

    // Fewer points are resampled onto the other's x positions.
    alignPair() {
      if (!this.betweenCurve) return;
      const na = this.curve.points.length;
      const nb = this.betweenCurve.points.length;
      if (na === nb) return;
      this.warnAlign();
      if (na < nb) this.curve.setPoints(resampleOnto(this.curve, this.betweenCurve)[0]);
      else this.betweenCurve.setPoints(resampleOnto(this.betweenCurve, this.curve)[0]);
    }

    snapshot() {
      const snap = {
        duration: this._duration,
        delay: this._delay,
        loopDelay: this._loopDelay,
        stagger: this._stagger,
        loop: this._loop,
        alternate: this._alternate,
        points: clonePoints(this.curve.points),
      };
      if (this.betweenCurve && !this.betweenAuto) snap.between = { points: clonePoints(this.betweenCurve.points) };
      return snap;
    }

    serial() {
      const out = {};
      out.duration = this._duration;
      if (this._delay) out.delay = this._delay;
      out.loopDelay = this._loopDelay;
      out.loop = this._loop;
      out.alternate = this._alternate;
      if (this._stagger) out.stagger = this._stagger;
      Object.assign(out, serialCurveFields(this.curve.points, true));
      if (this.betweenCurve && !this.betweenAuto) out.between = serialCurveFields(this.betweenCurve.points, false);
      return out;
    }

    // True while the panel's values differ from the code. The GUI keeps such values as a draft
    // across reloads (see `drafts`); the sketch itself always starts from the code.
    get hasDraft() {
      const code = serialFromState(this.codeState());
      return JSON.stringify(this.serial()) !== JSON.stringify(code);
    }

    // The curves blended point by point at u, with their endY. Built fresh on every call.
    blendAt(u) {
      this.ensureBetweenCurve();
      const [pa, sa, pb, sb] = alignedPoints(this.curve, this.betweenCurve);
      return {
        curve: new Curve(betweenPoints(pa, sa, pb, sb, u)),
        endY: this.endY + (this.betweenEndY - this.endY) * u,
      };
    }

    // Step k of BETWEEN_STEPS: curve 0, curve 1, or a cached blend that lives until the points change.
    betweenStep(k) {
      if (k === 0) return { curve: this.curve, endY: this.endY };
      if (k === BETWEEN_STEPS) return { curve: this.betweenCurve, endY: this.betweenEndY };
      if (this._betweensGen !== this.pointGen) {
        this._betweens.clear();
        this._betweensGen = this.pointGen;
      }
      let step = this._betweens.get(k);
      if (!step) {
        step = this.blendAt(k / BETWEEN_STEPS);
        this._betweens.set(k, step);
        this._betweenBuilds++;
      }
      return step;
    }

    // The curve for a call whose between is u (null: the call has no between). Strictly between 0
    // and 1 it is the easing's BetweenMix, set for this u.
    betweenFor(u) {
      if (u != null) this.ensureBetweenCurve();
      if (u == null || u === 0) return this.curve;
      if (u === 1) return this.betweenCurve;
      const k0 = Math.floor(u * BETWEEN_STEPS);
      const f = u * BETWEEN_STEPS - k0;
      const a = this.betweenStep(k0);
      const b = f > 0 ? this.betweenStep(Math.min(k0 + 1, BETWEEN_STEPS)) : null;
      if (this._mix) return this._mix.set(u, a, b, f);
      return (this._mix = new BetweenMix(u, a, b, f));
    }

    endYOf(curve) {
      if (curve === this.curve) return this.endY;
      if (curve === this.betweenCurve) return this.betweenEndY;
      return curve.endY;
    }

    // A call option name FrameEase does not know: said once per easing and key.
    warnUnknownKey(key) {
      if (this._warnedKeys.has(key)) return;
      this._warnedKeys.add(key);
      warn(`FrameEase: "${this.name}" has no option "${key}".`);
    }

    warnNumberIndex() {
      if (this._warnedNumberIndex) return;
      this._warnedNumberIndex = true;
      warn(`FrameEase: "${this.name}" takes { index } as its second argument. Write ${this.name}(frame, { index: i }).`);
    }

    get(frame, callOpts) {
      if (typeof callOpts === 'number') this.warnNumberIndex();
      if (hooks.checkCall) hooks.checkCall(this, callOpts);
      const read = readCallOpts(callOpts);
      const index = read.index;
      const u = read.u;
      const curve = this.betweenFor(u);
      const slot = curve === this._mix ? curve : null;
      return playFrame(this, curve, this.endYOf(curve), slot, frame == null ? null : +frame, index, u != null);
    }

    curveAt(t, callOpts) {
      if (typeof callOpts === 'number') this.warnNumberIndex();
      if (hooks.checkCall) hooks.checkCall(this, callOpts);
      const u = readCallOpts(callOpts).u;
      const curve = this.betweenFor(u);
      const slot = curve === this._mix ? curve : null;
      return playCurve(this, curve, this.endYOf(curve), slot, t, u != null);
    }
  }

  // alwaysPoints: layer curve 0 always writes `points`. Curve 1 omits keys that match defaults.
  function serialCurveFields(points, alwaysPoints) {
    const out = {};
    const text = formatPoints(points);
    if (alwaysPoints || text) out.points = text;
    assignSlopes(out, points);
    if (round3(points[points.length - 1].y) !== 1) out.endY = round3(points[points.length - 1].y);
    return out;
  }

  function makeApi(e) {
    const api = function (frame, callOpts) {
      return e.get(frame, callOpts);
    };
    Object.defineProperties(api, {
      name: { value: e.name },
      curve: { value: (t, opts) => e.curveAt(t, opts) },
      progress: { get: () => e.lastProgress, enumerable: true },
      duration: { get: () => e.duration, enumerable: true },
      delay: { get: () => e.delay, enumerable: true },
      loopDelay: { get: () => e.loopDelay, enumerable: true },
      stagger: { get: () => e.stagger, enumerable: true },
      loop: { get: () => e.loop, enumerable: true },
      alternate: { get: () => e.alternate, enumerable: true },
      endY: { get: () => e.endY, enumerable: true },
      points: { get: () => formatPoints(e.curve.points), enumerable: true },
      startSlope: {
        get: () => (e.curve.points[0].mode === 'manual' ? e.curve.points[0].out : undefined),
        enumerable: true,
      },
      endSlope: {
        get: () => {
          const p = e.curve.points[e.curve.points.length - 1];
          return p.mode === 'manual' ? p.in : undefined;
        },
        enumerable: true,
      },
    });
    return api;
  }

  function create(name, options) {
    if (typeof name !== 'string' || name === '') {
      throw new TypeError('FrameEase: a name is required, e.g. FrameEase("move")');
    }
    if (options != null && !optionsWarned.has(name)) {
      optionsWarned.add(name);
      warn(`FrameEase: "${name}" does not take options. Write its values in FrameEase.importState({ ${name}: { ... } }).`);
    }
    let e = instances.get(name);
    if (e) return e.api;
    e = new Easing(name);
    instances.set(name, e);
    if (hooks.onChange) hooks.onChange();
    return e.api;
  }

  function easingOf(target) {
    if (target && target.curve && Array.isArray(target.curve.points) && instances.get(target.name) === target) {
      return target;
    }
    return instances.get(target && target.name) || null;
  }

  function betweenCacheSize(api) {
    const e = easingOf(api);
    if (!e || e._betweensGen !== e.pointGen) return 0;
    return e._betweens.size;
  }

  // The point blend at u, the curve the step curves sample.
  function betweenPointsOf(api, u) {
    const e = easingOf(api);
    if (!e) return '';
    e.ensureBetweenCurve();
    if (!(u > 0)) return formatPoints(e.curve.points);
    if (u >= 1) return formatPoints(e.betweenCurve.points);
    return formatPoints(e.blendAt(u).curve.points);
  }

  // Step curves built so far, over the easing's life.
  function betweenBuildCount(api) {
    const e = easingOf(api);
    return e ? e._betweenBuilds : 0;
  }

  // { curve, endY } blended point by point at u, bypassing the steps.
  function betweenBlendAt(api, u) {
    const e = easingOf(api);
    return e ? e.blendAt(u) : null;
  }

  function importState(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (const name of Object.keys(obj)) {
      dataStore[name] = Object.assign({}, obj[name]);
      const e = instances.get(name);
      if (e) e.resolve();
    }
    if (hooks.onChange) hooks.onChange();
  }

  // FrameEase.gui(). The body is in the GUI part. Without it, a gui() line left in a finished sketch
  // must not stop the sketch: say so once and carry on.
  let guiMissingNoted = false;
  function gui(opts) {
    if (hooks.gui) {
      hooks.gui(opts);
      return;
    }
    if (guiMissingNoted) return;
    guiMissingNoted = true;
    if (typeof console !== 'undefined' && console.log) {
      console.log('FrameEase: gui() is not included in frame-ease.core.min.js');
    }
  }

  // ---------------------------------------------------------------------------
  // State block in sketch.js (exportState / importState)
  // ---------------------------------------------------------------------------

  function jsString(s) {
    return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }

  function quoteKey(name) {
    return /^[A-Za-z_$][\w$]*$/.test(name) ? name : jsString(name);
  }

  function jsLiteral(v) {
    return typeof v === 'string' ? jsString(v) : String(v);
  }

  function formatCurveLiteral(s, omitEmptyPoints) {
    const parts = [];
    if (s.points !== undefined && !(omitEmptyPoints && s.points === '')) parts.push(`points: ${jsString(s.points)}`);
    if (s.startSlope !== undefined) parts.push(`startSlope: ${fmtNum(s.startSlope)}`);
    if (s.endSlope !== undefined) parts.push(`endSlope: ${fmtNum(s.endSlope)}`);
    if (s.endY !== undefined && round3(s.endY) !== 1) parts.push(`endY: ${fmtNum(s.endY)}`);
    return parts;
  }

  function entryLine(name, s) {
    const parts = [];
    for (const key of ['duration', 'delay', 'loopDelay', 'stagger', 'loop', 'alternate']) {
      if (s[key] !== undefined) {
        if ((key === 'stagger' || key === 'delay') && !(+s[key] > 0)) continue;
        parts.push(`${key}: ${jsLiteral(s[key])}`);
      }
    }
    parts.push(...formatCurveLiteral(s, false));
    if (s.between) {
      const inner = formatCurveLiteral(s.between, true).join(', ');
      parts.push(inner ? `between: { ${inner} }` : 'between: {}');
    }
    return `  ${quoteKey(name)}: { ${parts.join(', ')} }`;
  }

  // A state in the shape of Easing#serial().
  function serialFromState(s) {
    const out = {};
    out.duration = s.duration;
    if (s.delay) out.delay = s.delay;
    out.loopDelay = s.loopDelay;
    out.loop = s.loop;
    out.alternate = normalizeAlternate(s.alternate);
    if (s.stagger) out.stagger = s.stagger;
    Object.assign(out, serialCurveFields(materializePoints(s), true));
    if (s.between && hasCurveKey(s.between)) {
      out.between = serialCurveFields(materializePoints(s.between), false);
    }
    return out;
  }

  function cloneSerial(s) {
    const out = Object.assign({}, s);
    if (s.between) out.between = Object.assign({}, s.between);
    return out;
  }

  function exportState() {
    const out = {};
    for (const e of instances.values()) out[e.name] = cloneSerial(e.serial());
    return out;
  }

  // Names in the state block that no FrameEase() call made this run. The copy leaves them out.
  function leftOutNames() {
    return Object.keys(dataStore).filter((name) => !instances.has(name));
  }

  function blockText() {
    const state = exportState();
    const names = Object.keys(state);
    const lines = names.map((name) => entryLine(name, state[name]));
    return [
      BLOCK_START,
      'FrameEase.importState({',
      ...lines.map((l, i) => (i < lines.length - 1 ? l + ',' : l)),
      '});',
      BLOCK_END,
    ].join('\n');
  }

  const internals = {
    parsePoints, formatPoints, progressAt, phaseAt, evaluate, resolveSlopes, segmentOvershoot, findPeaks,
    betweenPoints, materializePoints, betweenCacheSize, betweenPointsOf, betweenBlendAt,
    betweenBuildCount, BETWEEN_STEPS,
    blockText, leftOutNames, flipCurvePoints, curveOutput, valueAt,
    readCallOpts, liveFrameCount, effectiveFrame, hooks,
  };

  // ===== GUI START =====

  // ---------------------------------------------------------------------------
  // GUI: everything from here to GUI END draws or drives the panel.
  // scripts/build.js cuts this part out to make frame-ease.core.min.js.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Settings, storage for the panel layout, clipboard
  // ---------------------------------------------------------------------------

  const settings = { gui: false, toggleKey: 'e' };

  const LS_PREFIX = 'frame-ease:';
  const UI_KEY = LS_PREFIX + 'panel';

  function lsGet(key) {
    try {
      const s = root.localStorage.getItem(key);
      return s ? JSON.parse(s) : null;
    } catch (_) {
      return null;
    }
  }

  function lsSet(key, value) {
    try {
      root.localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      // Storage may be unavailable (private mode, file://). Panel layout is best-effort.
    }
  }

  function lsDel(key) {
    try {
      root.localStorage.removeItem(key);
    } catch (_) {
      // As above.
    }
  }

  // ---------------------------------------------------------------------------
  // Drafts: values changed in the panel and not yet pasted into the code
  // ---------------------------------------------------------------------------

  // The code is the source of truth. What is kept here is a draft from before it went into the code:
  // per page and easing, { draft: the panel's values, code: the code's values at that time }.
  // After a reload the sketch runs on the code as always. If the code is still the one the draft was
  // made from, the panel offers to bring the draft back; if the code has changed, the draft is dropped.
  const DRAFT_SAVE_MS = 300;

  function draftKey(name) {
    const path = (root.location && root.location.pathname) || '';
    return LS_PREFIX + path + ':' + name;
  }

  function sameSerial(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function codeSerial(e) {
    return serialFromState(e.codeState());
  }

  const drafts = {
    seen: new Set(), // names already looked up in storage
    found: new Map(), // name -> { draft, code }: kept from last time, waiting for restore / discard
    timers: new Map(),

    // Look up easings not seen yet (also those created after setup). True when the notice changed.
    scan() {
      let changed = false;
      for (const e of guiList()) {
        if (this.seen.has(e.name)) continue;
        this.seen.add(e.name);
        const key = draftKey(e.name);
        const kept = lsGet(key);
        if (!kept) continue;
        const ok = kept.draft && typeof kept.draft === 'object' && sameSerial(kept.code, codeSerial(e)) &&
          !sameSerial(kept.draft, e.serial());
        if (ok) {
          this.found.set(e.name, kept);
          changed = true;
        } else {
          lsDel(key);
        }
      }
      return changed;
    },

    // The code may change after the first look (importState called later): drop what no longer fits.
    recheck() {
      let changed = false;
      for (const [name, kept] of this.found) {
        const e = instances.get(name);
        if (e && sameSerial(kept.code, codeSerial(e))) continue;
        this.found.delete(name);
        lsDel(draftKey(name));
        changed = true;
      }
      return changed;
    },

    // An easing changed in the panel. Its own new values replace a draft still waiting.
    touch(e) {
      if (!this.seen.has(e.name)) this.scan();
      const waiting = this.found.has(e.name);
      if (waiting && !e.hasDraft) return false;
      if (waiting) this.found.delete(e.name);
      // Wait a little, so a drag does not write on every move.
      const save = () => {
        this.timers.delete(e.name);
        this.write(e);
      };
      if (typeof root.setTimeout !== 'function') save();
      else if (!this.timers.has(e.name)) this.timers.set(e.name, root.setTimeout(save, DRAFT_SAVE_MS));
      return waiting;
    },

    // Keep the draft while there is one; once the panel equals the code again, nothing is kept.
    write(e) {
      if (instances.get(e.name) !== e || this.found.has(e.name)) return;
      if (e.hasDraft) lsSet(draftKey(e.name), { draft: e.serial(), code: codeSerial(e) });
      else lsDel(draftKey(e.name));
    },

    // Write the saves still waiting now (the page is going away). Nothing waiting, nothing done.
    flush() {
      for (const [name, timer] of this.timers) {
        root.clearTimeout(timer);
        this.timers.delete(name);
        const e = instances.get(name);
        if (e) this.write(e);
      }
    },

    names() {
      return [...this.found.keys()];
    },

    // The state to apply for a kept draft. A serial leaves out what is at its default.
    stateOf(e, draft) {
      const state = Object.assign({}, DEFAULT_STATE, draft);
      if (!draft.between && e.betweenAuto) state.between = {};
      return state;
    },

    // Take the waiting drafts out, for the panel to apply.
    take() {
      const list = [];
      for (const [name, kept] of this.found) {
        const e = instances.get(name);
        if (e) list.push({ e, state: this.stateOf(e, kept.draft) });
      }
      this.found.clear();
      return list;
    },

    discard() {
      for (const name of this.found.keys()) lsDel(draftKey(name));
      this.found.clear();
    },
  };

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // Fall back to execCommand below.
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (_) {
        ok = false;
      }
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // GUI strings
  // ---------------------------------------------------------------------------

  // Tooltips and messages, in one place so the wording can be checked together.
  const UI_STRINGS = {
    undo: 'Undo',
    redo: 'Redo',
    save: 'Copy — put the state block on the clipboard',
    draft: 'Changes not yet in code. Copy and paste into sketch.js',
    minimize: 'Minimize',
    stagger: (frames) => `Last is ${frames}f behind first`,
    staggerOverlap: (frames, laps) => `Last is ${frames}f behind first (${laps} cycles, overlapping)`,
    staggerMixWarn: (name) => `FrameEase: "${name}" mixes calls with and without index`,
    staggerLabel: 'stagger',
    hide: (key) => `Hide (${key})`,
    expand: (key) => `Expand (${key})`,
    stop: 'Stops here',
    loop: 'Loop (click to toggle)',
    loopOn: 'loop',
    loopOff: 'loop off',
    alternate: 'Alternate (click for off → alternate → mirror)',
    altOff: 'off',
    altAlternate: 'alternate',
    altMirror: 'mirror',
    presets: 'Preset',
    tabKey: (n) => `Key ${n}`,
    scrubHover: 'Drag to change (Shift ×10) · click to type',
    hiddenValue: (name, frames) => `${name} ${frames}f`,
    scrubFocus: '↑↓ to nudge (Shift ×10) · Enter to confirm · Esc to cancel',
    stripe: 'Value per frame. Denser lines mean slower motion.',
    copied: 'Copied. Paste it over the block in sketch.js.',
    copiedLeftOut: (names) => `Copied. Left out (not used this run): ${names}`,
    copyFail: 'Copy failed.',
    startDelay: 'Wait before the first run (delay)',
    durationTip: 'One run (duration)',
    loopDelayTip: 'Wait after each run (loop delay)',
    pause: 'Pause (Space). While paused, ← → step one frame, Shift for 10',
    pauseShort: 'Pause',
    resume: 'Resume',
    scrub: 'Drag to that frame (pauses)',
    draftKeptLead: 'Last changes, not in code yet:',
    draftKept: (names) => `${t('draftKeptLead')} ${names}`,
    draftRestore: 'Restore',
    draftDiscard: 'Discard',
  };

  function t(key, ...args) {
    const v = UI_STRINGS[key];
    return typeof v === 'function' ? v(...args) : v;
  }

  // ---------------------------------------------------------------------------
  // Editing limits
  // ---------------------------------------------------------------------------

  const MIN_GAP = 0.01;
  const NUDGE = 0.01;
  const NUDGE_BIG = 0.1;
  const END_Y_SNAP = 0.04; // data-space threshold to snap the endpoint onto y = 0 or 1
  const MAX_SLOPE = 100;

  const snapEndY = (y) => {
    if (Math.abs(y - 1) <= END_Y_SNAP) return 1;
    if (Math.abs(y) <= END_Y_SNAP) return 0;
    return y;
  };

  // ---------------------------------------------------------------------------
  // Look: stacking, palette, CSS, sizes
  // ---------------------------------------------------------------------------

  const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  // The delay has a row of its own above the band. The row keeps its height at delay 0, so the curve does not move.
  const DELAY_ROW_H = 20;
  // Stacking inside the graph, bottom to top. The playhead and the other calls' marks sit under the
  // band and show through its translucent fill. Chips and marks inside the band use the band's own stack.
  const Z = {
    graph: 0,
    dim: 2, // info row under the band
    under: 3, // playhead line, other calls' marks
    band: 4, // band, delay row, stagger readout
    grip: 5, // playhead and scrub handle over the opaque delay row
    dot: 6, // zero dots
    chrome: 7, // loop / alternate toggles
    menu: 8, // preset button and its open menu
    tip: 9,
  };
  // Palette. Every colour in the CSS and on the canvases comes from here.
  // Greys have no tint. White comes at six strengths only (W); each use below picks one by its job.
  const W = {
    faint: 'rgba(255,255,255,.06)', // resting surfaces
    soft: 'rgba(255,255,255,.12)', // surfaces in use: duration, hover, quiet guides
    line: 'rgba(255,255,255,.2)', // lines and borders; a surface that is lit
    mark: 'rgba(255,255,255,.35)', // quiet marks on the graph
    text: 'rgba(255,255,255,.6)', // secondary text
    strong: 'rgba(255,255,255,.72)', // read-only numbers, strong marks
  };
  const C = {
    // Base. The accent marks only what is happening now: the playhead and its triangle, the ring,
    // the minimized strip's playhead, the dot for changes not yet copied, and the draft notice.
    // (And the stagger warning.)
    panel: '#232323',
    graph: '#181818',
    ink: '#ededed',
    mute: '#8c8c8c',
    line: W.line,
    accent: '#ff7a5c',
    hot: '#fff', // brightest marks on the graph: the active curve where it has played, its points and handles
    onInk: '#000', // icon on an ink-filled button
    onInkText: '#111', // digits in a focused number field, the Restore button
    noticeFill: 'rgba(255,122,92,.14)', // the draft notice: the accent, laid thin
    noticeLine: 'rgba(255,122,92,.5)',

    // Lines
    gripSep: W.line, // separator in the title bar
    presetAxes: W.line, // axes of a preset thumbnail
    numBorder: W.line,
    resizeMark: W.text,
    guideQuarter: W.soft, // dotted quarter lines
    guideBase: W.soft, // y = 0 and y = 1
    guideEdge: W.line, // duration's edges, down to the band
    delayDot: '#5e5e5e', // zero dot of the delay

    // Surfaces. The segment the playhead is in is lit, not coloured.
    hover: W.soft, // title bar icons, preset items
    hoverCorner: W.soft, // preset button and mode toggles in the graph corners
    hoverMini: W.soft, // icons on the minimized strip
    wait: W.faint, // loop delay segments
    waitHover: W.soft,
    waitHot: W.line, // while the playhead waits there
    dur: W.soft, // duration segment
    durHover: W.line,
    durHot: W.line, // while the playhead moves through it
    durRowHot: W.soft, // the same, laid over one of the two rows of a round trip
    delayFill: '#262626', // delay segment (opaque)
    miniBand: W.soft,
    miniHot: W.line, // the strip's segment the playhead is in, moving or waiting
    numFill: 'rgba(0,0,0,.35)',
    tipFill: '#0e0e0e',

    // Text
    readout: W.strong, // read-only numbers: observed stagger, cycle length
    dimText: W.text,
    staggerNote: W.text, // diagnostic line under the preset button

    // Graph
    curveAhead: W.text, // active curve, not yet played
    curveMirror: W.mark, // its mirrored return
    otherAhead: 'rgba(160,160,160,.55)', // the curve that is not active (between)
    otherMirror: 'rgba(160,160,160,.35)',
    pointOther: 'rgba(170,170,170,.95)',
    pointHalo: W.mark, // partner of the selected point on the other curve
    betweenCall: W.mark, // blends drawn for between calls
    handleLine: W.strong,
    peak: W.strong,
    stripe: W.mark, // per-frame values at the left edge
    callDot: '#b5b5b5', // calls other than the ring, on the graph and on the band
  };

  const CSS = `
.fe-panel{position:fixed;z-index:2147483000;display:flex;flex-direction:column;box-sizing:border-box;
  background:${C.panel};color:${C.ink};font:12px/16px system-ui,sans-serif;
  border:1px solid ${C.line};border-radius:0;
  overflow:hidden;user-select:none;-webkit-user-select:none;touch-action:none}
.fe-panel[hidden],.fe-mini[hidden]{display:none}
.fe-panel *,.fe-mini *{box-sizing:border-box}
.fe-grip{flex:none;height:32px;display:flex;align-items:center;gap:4px;padding:4px;cursor:move}
.fe-tabs{flex:1;min-width:0;display:flex;gap:0;overflow:hidden}
.fe-status{flex:none;max-width:40%;opacity:.72;padding:0 4px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.fe-status[hidden]{display:none}
.fe-notice{flex:none;height:40px;display:flex;align-items:center;gap:4px;padding:0 8px;background:${C.noticeFill};
  box-shadow:inset 0 -1px 0 ${C.noticeLine};color:${C.ink};font:11px/16px system-ui,sans-serif}
.fe-notice[hidden]{display:none}
.fe-notice-dot{flex:none;width:6px;height:6px;margin-right:4px;background:${C.accent}}
.fe-notice-text{flex:1;min-width:0;display:flex;white-space:nowrap}
.fe-notice-lead{flex:none;margin-right:4px}
.fe-notice-names{flex:0 1 auto;min-width:1.5em;overflow:hidden;text-overflow:ellipsis}
.fe-notice button{flex:none;height:24px;padding:0 6px;border:0;border-radius:0;background:none;
  color:${C.ink};font:inherit;cursor:pointer}
.fe-notice button:hover{background:${C.hover}}
.fe-notice button.fe-restore{background:${C.ink};color:${C.onInkText}}
.fe-notice button.fe-restore:hover{background:${C.hot}}
.fe-body{flex:1;min-height:0;display:flex;flex-direction:column;padding:0}
.fe-group{display:flex;gap:0;align-items:center}
.fe-sep{flex:none;width:1px;height:16px;margin:0 2px;background:${C.gripSep}}
.fe-tab,.fe-icon{height:24px;border:0;border-radius:0;background:none;color:inherit;font:inherit;cursor:pointer}
.fe-tab{padding:0 8px;white-space:nowrap;opacity:.45;border-radius:0;border-bottom:1px solid transparent;box-sizing:border-box}
.fe-tab:hover{opacity:.8}
.fe-tab.fe-on{opacity:1;border-bottom-color:${C.ink}}
.fe-tab-wrap{display:inline-flex;align-items:center;flex:0 0 auto}
.fe-between-mark{display:inline-flex;align-items:center;margin-left:4px;width:12px;height:12px;opacity:.75;vertical-align:middle}
.fe-between-mark svg{width:12px;height:12px;display:block;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.fe-mode-bars{position:absolute;z-index:${Z.chrome};right:8px;top:8px;display:flex;align-items:stretch;gap:8px;pointer-events:none}
.fe-mode-bars>*{pointer-events:auto}
.fe-icon{width:24px;padding:4px;display:grid;place-items:center;opacity:.4;position:relative}
.fe-icon svg{width:16px;height:16px;display:block;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.fe-icon:hover{background:${C.hover};opacity:1}
.fe-icon.fe-on{background:${C.ink};color:${C.onInk};opacity:1}
.fe-save{opacity:.5}
.fe-save.fe-draft{opacity:1;box-shadow:inset 0 0 0 1px ${C.mute}}
.fe-save-dot{position:absolute;right:0;top:0;width:5px;height:5px;background:${C.accent};pointer-events:none}
.fe-save-dot[hidden]{display:none}
.fe-group[hidden]{display:none}
.fe-graph{flex:1;min-height:96px;position:relative;border-radius:0;overflow:visible;background:${C.graph}}
.fe-graph canvas.fe-graph-canvas{position:absolute;left:0;top:0;width:100%!important;height:100%!important;
  max-width:none!important;max-height:none!important;display:block;z-index:${Z.graph}}
.fe-band{position:absolute;z-index:${Z.band};display:flex;align-items:stretch;border-radius:0;overflow:hidden}
.fe-delay-row{position:absolute;z-index:${Z.band};height:${DELAY_ROW_H}px;display:flex;align-items:center;justify-content:center;gap:4px;
  box-sizing:border-box;color:${C.mute};background:${C.delayFill};box-shadow:inset 0 1px 0 ${C.line};cursor:ew-resize}
.fe-delay-row .fe-chip-delay{gap:4px}
.fe-delay-row[hidden]{display:none}
.fe-delay-arrow{position:absolute;z-index:${Z.band};height:1px;background:${C.mute};pointer-events:none}
.fe-delay-arrow[hidden]{display:none}
.fe-delay-arrow::after{content:'';position:absolute;right:0;top:-2px;width:0;height:0;border-top:2.5px solid transparent;
  border-bottom:2.5px solid transparent;border-left:4px solid ${C.mute}}
.fe-delay-row.fe-compact .fe-start-label{display:none}
.fe-delay-row.fe-narrow > *{visibility:hidden}
.fe-delay-row:hover .fe-num{border-color:${C.ink}}
.fe-seg.fe-narrow > *{visibility:hidden}
.fe-start-label{position:relative;font:9px/1 ${MONO};letter-spacing:.02em;color:${C.mute};pointer-events:none}
.fe-band-ticks{position:absolute;z-index:${Z.under};pointer-events:none;display:block;
  max-width:none!important;max-height:none!important}
.fe-band-ticks[hidden]{display:none}
.fe-modes{height:24px;display:flex;align-items:stretch;border-radius:0;background:none;
  box-shadow:inset 0 0 0 1px ${C.line}}
.fe-modes-sep{flex:none;width:1px;margin:0;background:${C.line}}
.fe-presets{position:absolute;z-index:${Z.menu};left:8px;top:8px;height:24px;display:flex;align-items:stretch;
  border-radius:0;background:none;box-shadow:inset 0 0 0 1px ${C.line};pointer-events:auto}
.fe-stagger{position:absolute;z-index:${Z.band};left:8px;top:34px;max-width:70%;pointer-events:none;
  font:10px/14px ${MONO};color:${C.staggerNote};white-space:pre-line;overflow:hidden}
.fe-stagger.fe-warn{color:${C.accent}}
.fe-stagger[hidden]{display:none}
.fe-preset-btn{min-width:28px;height:24px;display:flex;align-items:center;justify-content:center;gap:5px;padding:0 6px;border:0;
  border-radius:0;background:none;color:${C.ink};cursor:pointer}
.fe-preset-btn:hover,.fe-preset-btn.fe-on{background:${C.hoverCorner}}
.fe-preset-btn svg{width:14px;height:14px;flex:none;display:block;fill:none;stroke:currentColor;stroke-width:1.5;
  stroke-linecap:round;stroke-linejoin:round;opacity:.75}
.fe-preset-menu{position:absolute;left:0;top:30px;width:320px;max-height:min(420px,70vh);overflow:auto;
  padding:6px;border-radius:0;
  background:${C.panel};border:1px solid ${C.line};
  display:grid;grid-template-columns:repeat(4,1fr);gap:4px}
.fe-preset-menu[hidden]{display:none}
.fe-preset-item{display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px 2px 4px;border:0;
  border-radius:0;background:none;color:${C.ink};cursor:pointer;opacity:.88;min-width:0}
.fe-preset-item:hover{background:${C.hover};opacity:1}
.fe-preset-item svg{width:64px;height:40px;display:block;flex:none}
.fe-preset-item .fe-preset-axes{fill:none;stroke:${C.presetAxes};stroke-width:1}
.fe-preset-item .fe-preset-curve{fill:none;stroke:${C.ink};stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.fe-preset-name{display:block;width:100%;font:7.5px/9px ${MONO};text-align:center;opacity:.9;
  white-space:normal;overflow:visible;word-break:break-word;hyphens:none}
.fe-mode{min-width:28px;height:24px;display:flex;flex-direction:row;align-items:center;justify-content:center;
  gap:5px;padding:0 6px;border:0;border-radius:0;background:none;color:${C.ink};cursor:pointer;position:relative}
.fe-mode:hover{background:${C.hoverCorner}}
.fe-mode svg{width:14px;height:14px;flex:none;display:block;fill:none;stroke:currentColor;stroke-width:1.5;
  stroke-linecap:round;stroke-linejoin:round}
.fe-mode-alt svg{width:13px;height:13px}
.fe-mode-label{font:10px/1 ${MONO};white-space:nowrap;opacity:.55}
.fe-mode-alt.fe-on .fe-mode-label{opacity:.9}
.fe-mode-loop.fe-on svg{opacity:1}
.fe-mode-loop:not(.fe-on) svg{opacity:.35}
.fe-icon:disabled{opacity:.28;pointer-events:none}
.fe-icon:disabled:hover{background:none;opacity:.28}
.fe-play{position:absolute;z-index:${Z.under};width:1px;margin-left:-0.5px;background:${C.accent};pointer-events:none}
.fe-play.fe-lead{z-index:${Z.grip}}
.fe-play.fe-pause{background:${C.ink}}
.fe-scrub{position:absolute;z-index:${Z.grip};width:12px;margin-left:-6px;cursor:ew-resize;touch-action:none}
.fe-scrub[hidden]{display:none}
.fe-scrub i{position:absolute;left:3px;width:0;height:0;border-left:3px solid transparent;border-right:3px solid transparent;
  border-top:5px solid ${C.accent};pointer-events:none}
.fe-scrub.fe-pause i{border-top-color:${C.ink}}
.fe-mini-pause{flex:none}
.fe-mini-pause[hidden]{display:none}
.fe-seg{min-width:0;height:100%;display:flex;align-items:center;justify-content:center;
  background:${C.wait};color:${C.ink};cursor:ew-resize;font:11px/14px ${MONO}}
.fe-seg:not(.fe-dur).fe-hot{background:${C.waitHot}}
.fe-seg-right:hover,.fe-seg:not(.fe-dur).fe-lit{background:${C.waitHover}}
.fe-seg.fe-seg-left{cursor:default}
.fe-wait-read{font:11px/14px ${MONO};color:${C.mute};pointer-events:none}
.fe-lit .fe-wait-read{color:${C.ink}}
.fe-seg.fe-dur{padding:0;position:relative;
  background:${C.dur};box-shadow:inset 1px 0 0 ${C.line},inset -1px 0 0 ${C.line};box-sizing:border-box}
.fe-seg.fe-dur:hover{background:${C.durHover}}
.fe-seg.fe-dur.fe-hot{background:${C.durHot}}
.fe-dur-row{position:absolute;left:1px;right:1px;height:50%;pointer-events:none;display:none}
.fe-dur.fe-round .fe-dur-row{display:block}
.fe-dur-go{top:0}
.fe-dur-back{top:50%;box-shadow:inset 0 1px 0 ${C.line}}
.fe-dur-row.fe-hot{background:${C.durRowHot}}
.fe-chip{position:absolute;z-index:4;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;align-items:center;
  gap:6px;padding:0;border-radius:0;background:none;pointer-events:none;cursor:ew-resize}
.fe-chip-dur{height:22px}
.fe-chip-delay{position:relative;left:auto;top:0;transform:none;padding:0;height:18px}
.fe-chip-sep{flex:none;width:1px;height:16px;background:${C.line}}
.fe-chip-sep[hidden]{display:none}
.fe-stagger-label{flex:none;font:9px/1 ${MONO};letter-spacing:.02em;color:${C.mute};pointer-events:none}
.fe-stagger-label[hidden]{display:none}
.fe-seg.fe-dur.fe-compact .fe-stagger-label{display:none}
.fe-stagger-slot{display:flex;align-items:center;gap:6px;pointer-events:auto}
.fe-stagger-slot[hidden]{display:none}
.fe-num.fe-stagger-input{cursor:ew-resize}
.fe-num.fe-stagger-input[hidden]{display:none}
.fe-stagger-read{font:11px/16px ${MONO};color:${C.readout};pointer-events:none}
.fe-stagger-read[hidden]{display:none}
.fe-arrows{display:flex;flex-direction:column;justify-content:center;gap:0;font:9px/10px system-ui,sans-serif;
  color:${C.ink};pointer-events:none}
.fe-arrow{opacity:.5}
.fe-arrow.fe-live,.fe-waiting .fe-arrow{opacity:1}
.fe-dur:not(.fe-round) .fe-arrow-back{display:none}
.fe-num{width:3ch;min-width:3ch;box-sizing:content-box;padding:0 4px;border:1px solid ${C.numBorder};border-radius:0;
  outline:none;background:${C.numFill};color:${C.ink};font:11px/14px ${MONO};text-align:center;
  cursor:ew-resize;pointer-events:auto}
.fe-seg:hover .fe-num{border-color:${C.ink}}
.fe-num:hover{border-color:${C.ink}}
.fe-num:focus{border-color:${C.ink};background:${C.ink};color:${C.onInkText};cursor:text}
.fe-band[hidden],.fe-mode-bars[hidden]{display:none}
.fe-dot{position:absolute;z-index:${Z.dot};width:16px;height:16px;cursor:ew-resize;touch-action:none}
.fe-dot[hidden]{display:none}
.fe-dot::before{content:'';position:absolute;left:4px;top:4px;width:8px;height:8px;box-sizing:border-box;
  background:${C.graph};border:1px solid var(--fe-dot);pointer-events:none}
.fe-dot:hover::before{background:var(--fe-dot)}
.fe-dot .fe-num{display:block;position:absolute;bottom:100%;margin-bottom:4px;opacity:0;pointer-events:none}
.fe-dot .fe-num:focus{opacity:1;pointer-events:auto}
.fe-dot-delay{--fe-dot:${C.delayDot}}
.fe-dot-delay .fe-num{left:0}
.fe-dot-wait{--fe-dot:${C.mute}}
.fe-dot-wait .fe-num{right:0}
.fe-seg:not(.fe-dur){padding:0;box-sizing:border-box}
.fe-info{position:absolute;z-index:${Z.dim};height:14px;display:flex;align-items:center;justify-content:flex-end;
  pointer-events:none;color:${C.readout};font:10px/14px ${MONO};white-space:pre}
.fe-info[hidden]{display:none}
.fe-info span[hidden]{display:none}
.fe-info-loop{flex:none;width:10px;height:10px;margin-right:4px;display:block;fill:none;stroke:currentColor;stroke-width:1.5;
  stroke-linecap:round;stroke-linejoin:round}
.fe-info-loop[hidden]{display:none}
.fe-info-fps{color:${C.dimText}}
.fe-stop{position:absolute;z-index:4;top:50%;width:8px;height:8px;margin-top:-4px;background:${C.ink};
  pointer-events:none}
.fe-stop[hidden]{display:none}
.fe-tip{position:absolute;z-index:${Z.tip};background:${C.tipFill};color:${C.ink};font:11px/16px system-ui,sans-serif;
  padding:3px 7px;border-radius:0;border:1px solid ${C.line};pointer-events:none;
  white-space:nowrap;transform:translate(-50%,-100%);margin-top:-6px}
.fe-tip.fe-tip-stripe{white-space:normal;width:180px;padding:6px 8px;transform:none;margin-top:0}
.fe-tip.fe-tip-mode{transform:none;margin-top:6px;display:flex;gap:6px}
.fe-tip.fe-tip-mode span{opacity:.4}
.fe-tip.fe-tip-mode span.fe-on{opacity:1}
.fe-tip[hidden]{display:none}
.fe-panel :focus-visible,.fe-mini :focus-visible{outline:1px solid ${C.ink};outline-offset:1px}
.fe-resize{position:absolute;right:0;bottom:0;width:8px;height:8px;cursor:nwse-resize}
.fe-resize::after{content:'';position:absolute;right:2px;bottom:2px;width:4px;height:4px;opacity:0;
  border-right:1px solid ${C.resizeMark};border-bottom:1px solid ${C.resizeMark}}
.fe-panel:hover .fe-resize::after{opacity:1}
.fe-mini{position:fixed;z-index:2147483000;height:32px;display:inline-flex;align-items:center;gap:8px;
  padding:0 4px 0 10px;border-radius:0;background:${C.panel};color:${C.ink};
  border:1px solid ${C.line};width:max-content;max-width:calc(100vw - 32px);
  font:12px/16px system-ui,sans-serif;cursor:move;user-select:none;-webkit-user-select:none;touch-action:none}
.fe-mini-name{flex:none;font-size:12px;max-width:88px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fe-mini-band{flex:none;width:72px;height:6px;border-radius:0;background:${C.miniBand};position:relative;overflow:hidden}
.fe-mini-seg{position:absolute;top:0;bottom:0}
.fe-mini-seg.fe-hot-move{background:${C.miniHot}}
.fe-mini-seg.fe-hot-wait{background:${C.miniHot}}
.fe-mini-play{position:absolute;top:0;bottom:0;width:2px;background:${C.accent};margin-left:-1px}
.fe-mini-play.fe-pause{background:${C.ink};width:3px}
.fe-mini-icons{display:flex;gap:2px;opacity:.8}
.fe-mini-icons svg{width:14px;height:14px;display:block;fill:none;stroke:currentColor;stroke-width:1.5;
  stroke-linecap:round;stroke-linejoin:round}
.fe-mini-dot{width:5px;height:5px;border-radius:0;background:${C.accent};flex:none}
.fe-mini-dot[hidden]{display:none}
.fe-mini:hover{border-color:${C.mute}}
.fe-mini .fe-icon:hover{background:${C.hoverMini}}
`;

  const MIN_W = 320;
  const MIN_H = 400;
  const EDGE = 16;
  const BAND_H = 28;
  // Between the delay row and the band, and between the band and the info row under it.
  const DELAY_GAP = 2;
  const BAND_GAP = 6;
  const INFO_H = 14;
  const INFO_LOOP_W = 14; // loop icon and the space after it
  const INFO_SEP = ' · ';
  const SCRUB_TRI_H = 5;
  const GRAPH_PAD = 8;
  // Per-frame value stripe and the current-value tick, from the graph's left padding like the band.
  const STRIPE_W = 8;
  const STRIPE_TICK_W = 14;
  const NARROW_DELAY_PX = 22;
  // Below this duration width the chip has no room for the `stagger` label; the number stays.
  const STAGGER_LABEL_MIN_PX = 140;
  const DOT_HIT = 16;
  // The arrow from the delay row to duration: kept off both by the inset, and left out when the gap
  // has no room for its head.
  const DELAY_ARROW_INSET = 2;
  const DELAY_ARROW_MIN_PX = 9;
  const FRAME_TICK_MIN_PX = 4;
  const MODE_TIP_MS = 1200;
  const COL_MOVE = C.accent;
  const COL_MOVE_DOT = C.callDot;
  const COL_WAIT = C.mute;
  const COL_PAUSE = C.ink;
  const GRAPH_BG = C.graph;
  const CALL_CAP = 200;
  // Most calls kept between two harvests. A safety limit, far above what one frame makes.
  const LOG_CAP = 100000;

  // ---------------------------------------------------------------------------
  // Call log: every get / curve during a display frame (when gui is on)
  // ---------------------------------------------------------------------------

  function thinCalls(arr, max = CALL_CAP) {
    if (!arr || arr.length <= max) return arr ? arr.slice() : [];
    const n = arr.length;
    const out = [];
    for (let i = 0; i < max; i++) {
      out.push(arr[Math.round((i * (n - 1)) / (max - 1))]);
    }
    return out;
  }

  // Calls are kept only while something will read them. An open panel harvests once per frame; a
  // minimized or closed one does not, so it stops the log (`listen(false)`) instead of letting it grow.
  // While stopped, only the first call of each easing in the latest frame is remembered (the call the
  // ring follows), so the minimized strip can still show where the motion is. That is one entry per easing.
  const callLog = {
    buf: [],
    shown: [],
    listening: true,
    firsts: new Map(),
    seen: new Set(),
    // Whether record() would keep a call now. While stopped every call counts: record() picks the first.
    wants() {
      return !!settings.gui && (!this.listening || this.buf.length < LOG_CAP);
    },
    record(entry) {
      if (!settings.gui) return;
      if (!this.listening) {
        this.noteFirst(entry);
        return;
      }
      if (this.buf.length >= LOG_CAP) return;
      this.buf.push(entry);
    },
    // A new frame starts when frameCount moved on, or, without p5, when the strip has looked since.
    noteFirst(entry) {
      const prev = this.firsts.get(entry.owner);
      const live = liveFrameCount();
      const newFrame = !prev || !this.seen.has(entry.owner) || (live != null && live !== prev.live);
      if (!newFrame) return;
      this.firsts.set(entry.owner, { live, entry });
      this.seen.add(entry.owner);
    },
    // The remembered first call of `owner`, or null. Looking marks the end of a frame for every easing.
    firstCall(owner) {
      this.seen.clear();
      const first = this.firsts.get(owner);
      return first ? first.entry : null;
    },
    listen(on) {
      this.listening = !!on;
      if (!on) this.buf = [];
      this.firsts.clear();
      this.seen.clear();
    },
    harvest() {
      if (this.buf.length > 0) {
        this.shown = thinCalls(this.buf, CALL_CAP);
        this.buf = [];
      }
      return this.shown;
    },
    clear() {
      this.buf = [];
      this.shown = [];
      this.firsts.clear();
      this.seen.clear();
    },
  };

  // The log runs only while an open panel that is not minimized will harvest it. The panel passes its
  // view state (`ui`) here whenever it is opened, closed, minimized or expanded.
  function followPanel(ui) {
    callLog.listen(!!ui.open && !ui.minimized);
  }

  // Calls that belong to one layer, in the order they were made. The first is the ring.
  function callsForEasing(e, calls) {
    return (calls || []).filter((c) => c.owner === e);
  }

  function betweenInCalls(e, calls) {
    return callsForEasing(e, calls).some((c) => c.usesBetween);
  }

  // Warn once when one easing is called both with and without an index.
  // Call options come every frame, so each key is only compared, not collected. A name other than
  // between and index is said once per easing and key.
  function checkCallOpts(e, callOpts) {
    if (typeof callOpts !== 'object' || callOpts === null || Array.isArray(callOpts)) return;
    for (const key in callOpts) {
      if (key !== 'between' && key !== 'index') e.warnUnknownKey(key);
    }
  }

  function noteIndexUse(e, hasIndex) {
    if (!e || e._staggerMixWarned) return;
    if (hasIndex) {
      if (e._sawIndexCall) return;
      e._sawIndexCall = true;
    } else {
      if (e._sawPlainCall) return;
      e._sawPlainCall = true;
    }
    if (e._sawIndexCall && e._sawPlainCall) {
      e._staggerMixWarned = true;
      warn(t('staggerMixWarn', e.name));
    }
  }

  // ---------------------------------------------------------------------------
  // Stagger readout
  // ---------------------------------------------------------------------------

  function staggerSpan(calls) {
    let lo = Infinity;
    let hi = -Infinity;
    let any = false;
    for (const c of calls) {
      if (c.frame == null || !Number.isFinite(c.frame)) continue;
      any = true;
      if (c.frame < lo) lo = c.frame;
      if (c.frame > hi) hi = c.frame;
    }
    if (!any) return null;
    return hi - lo;
  }

  function formatFrameNum(n) {
    return Number.isInteger(n) ? n : +(+n).toFixed(1);
  }

  // Neighbor step from recorded frames when gaps look evenly spaced. Else null.
  function observedStep(calls) {
    const frames = [];
    for (const c of calls || []) {
      if (c.kind !== 'frame' || c.frame == null || !Number.isFinite(c.frame)) continue;
      frames.push(+c.frame);
    }
    if (frames.length < 2) return null;
    frames.sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < frames.length; i++) {
      const g = frames[i] - frames[i - 1];
      if (g > 0) gaps.push(g);
    }
    if (!gaps.length) return null;
    gaps.sort((a, b) => a - b);
    const med = gaps[Math.floor((gaps.length - 1) / 2)];
    const lo = gaps[0];
    const hi = gaps[gaps.length - 1];
    const tol = Math.max(0.5, Math.abs(med) * 0.1);
    if (hi > med + tol || lo < med - tol) return null;
    return med;
  }

  // Several calls that all pass the same frame (between lines, for example) have no stagger to show.
  function allSameFrame(frameCalls) {
    if (frameCalls.length < 2) return false;
    const f = frameCalls[0].frame;
    return frameCalls.every((c) => c.frame === f);
  }

  // Decision for the stagger slot / diagnostic lines (display path). The slot shows stagger only:
  // an editable value when calls pass an index, or the observed step between two or more calls.
  // A single call's distance from frameCount is the sketch's own number and is not shown.
  function offsetReadoutInfo(e, calls) {
    const mine = callsForEasing(e, calls || []);
    const useIndex = mine.some((c) => c.hasIndex);
    const frameCalls = mine.filter((c) => c.kind === 'frame' && c.frame != null && Number.isFinite(c.frame));
    const lines = [];
    let warnLine = false;
    let step = null;
    if (useIndex) {
      step = e ? e.stagger : 0;
    } else if (frameCalls.length >= 2) {
      step = observedStep(frameCalls);
      if (step == null) {
        const span = staggerSpan(mine);
        if (span > 0) {
          const cycle = effectiveCycleFrames(e, true);
          const laps = cycle > 0 ? span / cycle : 0;
          const overlap = laps >= 1;
          if (overlap) warnLine = true;
          lines.push(t(overlap ? 'staggerOverlap' : 'stagger', formatFrameNum(span), laps.toFixed(1)));
        }
      }
    }
    const showSlot = useIndex
      ? mine.some((c) => c.hasIndex)
      : (step != null && step >= 0);
    return { useIndex, step, showSlot, lines, warnLine, frameCalls };
  }

  // ---------------------------------------------------------------------------
  // Transport: pause, step and scrub by holding p5's frameCount
  // ---------------------------------------------------------------------------

  // Pause holds p5's frameCount itself, so everything the sketch builds from it (`%`, speed changes,
  // offsets, noise) stops together. p5 adds 1 before each draw; the hook below writes the held
  // value back before draw runs. Only global mode is supported: instance mode has no global
  // frameCount, so liveFrameCount() is null and pausing stays off.
  const transport = { on: false, frame: 0 };
  const frameHold = { installed: false };

  function holdFrameCount() {
    if (!transport.on) return;
    if (typeof this._setProperty === 'function') this._setProperty('frameCount', transport.frame); // p5 1.x
    else this.frameCount = transport.frame; // p5 2.x
  }

  // p5 1.x copies registered methods when the instance is built, so register on the live instance.
  // p5 2.x addons added later still run, since lifecycle hooks are read at each draw.
  function installFrameHold() {
    if (frameHold.installed) return true;
    const P5 = root.p5;
    if (!P5) return false;
    if (P5.instance && typeof P5.instance.registerMethod === 'function') {
      P5.instance.registerMethod('pre', holdFrameCount);
      frameHold.installed = true;
    } else if (typeof P5.registerAddon === 'function') {
      P5.registerAddon((p, fn, lifecycles) => {
        lifecycles.predraw = holdFrameCount;
      });
      frameHold.installed = true;
    }
    return frameHold.installed;
  }

  function canPause() {
    return !!settings.gui && liveFrameCount() != null && installFrameHold();
  }

  function transportToggle(on) {
    const next = !!on;
    if (next === transport.on) return transport.on;
    if (next) {
      if (!canPause()) return false;
      transport.frame = liveFrameCount();
    }
    transport.on = next;
    return transport.on;
  }

  // Held frameCount moves by delta; p5 starts at 1, so it never goes below 0.
  function transportNudge(delta) {
    if (!transport.on || !Number.isFinite(+delta) || delta === 0) return;
    transport.frame = Math.max(0, transport.frame + Math.round(+delta));
  }

  // Hold frameCount where the ring call receives `ringRaw`. `received` and `live` are what the ring
  // got and frameCount was at its last draw; their gap carries over, so a frameCount pass lands at once
  // and repeating before p5 redraws gives the same frame. Calls slower than frameCount need a few
  // draws to settle, so the GUI repeats this while dragging.
  function transportScrubRing(ringRaw, received, live) {
    if (!Number.isFinite(+ringRaw)) return;
    if (!transport.on && !transportToggle(true)) return;
    if (received == null || !Number.isFinite(+received)) return;
    const base = live != null && Number.isFinite(+live) ? +live : transport.frame;
    transport.frame = Math.max(0, Math.round(+ringRaw + base - +received));
  }

  function transportState() {
    return { on: transport.on, frame: transport.frame };
  }

  // ---------------------------------------------------------------------------
  // Curve presets
  // ---------------------------------------------------------------------------

  // Robert Penner's Easing Equations (BSD-3-Clause, Copyright (c) 2001 Robert Penner;
  // full notice in LICENSE), written here with b = 0, c = 1, d = 1 so t runs 0..1.
  // Sampled into FrameEase control points below.
  const BACK_S = 1.70158;
  const backIn = (t, s) => t * t * ((s + 1) * t - s);
  const backOut = (t, s) => {
    const u = t - 1;
    return u * u * ((s + 1) * u + s) + 1;
  };
  const TAU = 2 * Math.PI;
  // Elastic with amplitude 1: s = p / 4.
  const elasticIn = (t, p) => {
    if (t === 0 || t === 1) return t;
    const u = t - 1;
    return -(Math.pow(2, 10 * u) * Math.sin(((u - p / 4) * TAU) / p));
  };
  const elasticOut = (t, p) => {
    if (t === 0 || t === 1) return t;
    return Math.pow(2, -10 * t) * Math.sin(((t - p / 4) * TAU) / p) + 1;
  };
  const bounceOut = (t) => {
    const k = 7.5625;
    if (t < 1 / 2.75) return k * t * t;
    if (t < 2 / 2.75) { const u = t - 1.5 / 2.75; return k * u * u + 0.75; }
    if (t < 2.5 / 2.75) { const u = t - 2.25 / 2.75; return k * u * u + 0.9375; }
    const u = t - 2.625 / 2.75;
    return k * u * u + 0.984375;
  };
  // InOut: the first half runs `inFn` on 2t, the second half `outFn` on 2t - 1.
  const inOut = (inFn, outFn) => (t) => (t < 0.5 ? inFn(2 * t) / 2 : outFn(2 * t - 1) / 2 + 0.5);
  const powIn = (n) => (t) => Math.pow(t, n);
  const powOut = (n) => (t) => 1 - Math.pow(1 - t, n);

  const EASING_FNS = {
    linear: (t) => t,
    easeInSine: (t) => 1 - Math.cos((t * Math.PI) / 2),
    easeOutSine: (t) => Math.sin((t * Math.PI) / 2),
    easeInOutSine: (t) => 0.5 - Math.cos(t * Math.PI) / 2,
    easeInQuad: powIn(2),
    easeOutQuad: powOut(2),
    easeInOutQuad: inOut(powIn(2), powOut(2)),
    easeInCubic: powIn(3),
    easeOutCubic: powOut(3),
    easeInOutCubic: inOut(powIn(3), powOut(3)),
    easeInQuart: powIn(4),
    easeOutQuart: powOut(4),
    easeInOutQuart: inOut(powIn(4), powOut(4)),
    easeInQuint: powIn(5),
    easeOutQuint: powOut(5),
    easeInOutQuint: inOut(powIn(5), powOut(5)),
    easeInExpo: (t) => (t === 0 ? 0 : Math.pow(2, 10 * (t - 1))),
    easeOutExpo: (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
    easeInOutExpo: (t) => {
      if (t === 0 || t === 1) return t;
      const u = 2 * t - 1;
      return u < 0 ? Math.pow(2, 10 * u) / 2 : 1 - Math.pow(2, -10 * u) / 2;
    },
    easeInCirc: (t) => 1 - Math.sqrt(1 - t * t),
    easeOutCirc: (t) => Math.sqrt(1 - (t - 1) * (t - 1)),
    easeInOutCirc: inOut((t) => 1 - Math.sqrt(1 - t * t), (t) => Math.sqrt(1 - (t - 1) * (t - 1))),
    easeInBack: (t) => backIn(t, BACK_S),
    easeOutBack: (t) => backOut(t, BACK_S),
    easeInOutBack: inOut((t) => backIn(t, BACK_S * 1.525), (t) => backOut(t, BACK_S * 1.525)),
    easeInElastic: (t) => elasticIn(t, 0.3),
    easeOutElastic: (t) => elasticOut(t, 0.3),
    easeInOutElastic: inOut((t) => elasticIn(t, 0.45), (t) => elasticOut(t, 0.45)),
    easeOutBounce: bounceOut,
    easeInBounce: (t) => 1 - bounceOut(1 - t),
    easeInOutBounce: inOut((t) => 1 - bounceOut(1 - t), bounceOut),
  };

  function easingSampleCount(id) {
    if (/Elastic/.test(id)) return 24;
    if (/Back|Expo/.test(id)) return 6;
    if (id === 'linear') return 0;
    return 4;
  }

  // Per-preset inner x positions. Missing → equal spacing via easingSampleCount.
  const EASING_SAMPLE_XS = {
    easeOutCirc: [0.01, 0.04, 0.1, 0.2, 0.35, 0.55, 0.8],
    easeInCirc: [0.2, 0.45, 0.65, 0.8, 0.9, 0.96, 0.99],
  };

  function numDeriv(fn, x) {
    const x0 = Math.max(0, x - 0.002);
    const x1 = Math.min(1, x + 0.002);
    if (x1 <= x0) return 0;
    return (fn(x1) - fn(x0)) / (x1 - x0);
  }

  function leftDeriv(fn, x, eps = 1e-5) {
    if (!(x > 0)) return numDeriv(fn, 0);
    const x0 = Math.max(0, x - eps);
    return (fn(x) - fn(x0)) / (x - x0);
  }

  function rightDeriv(fn, x, eps = 1e-5) {
    if (!(x < 1)) return numDeriv(fn, 1);
    const x1 = Math.min(1, x + eps);
    return (fn(x1) - fn(x)) / (x1 - x);
  }

  // Cap like Fritsch-Carlson: |slope| ≤ 3 × |secant of the adjacent segment|.
  function capEndSlope(raw, avg) {
    if (!(Math.abs(avg) > 0)) return 0;
    const lim = 3 * Math.abs(avg);
    return clamp(raw, -lim, lim);
  }

  function capAgainstNeighbors(slope, leftAvg, rightAvg) {
    let s = slope;
    if (Math.abs(leftAvg) > 0) s = clamp(s, -3 * Math.abs(leftAvg), 3 * Math.abs(leftAvg));
    if (Math.abs(rightAvg) > 0) s = clamp(s, -3 * Math.abs(rightAvg), 3 * Math.abs(rightAvg));
    return s;
  }

  function pointsToState(pts) {
    const out = { points: pts.slice(1, -1).map(formatPoint).join(', ') };
    if (pts[0].mode === 'manual') out.startSlope = round3(pts[0].out);
    if (pts[pts.length - 1].mode === 'manual') out.endSlope = round3(pts[pts.length - 1].in);
    return out;
  }

  function sampleXsFor(id) {
    if (EASING_SAMPLE_XS[id]) return EASING_SAMPLE_XS[id].slice();
    const n = easingSampleCount(id);
    if (n === 0) return [];
    const xs = [];
    for (let i = 1; i <= n; i++) xs.push(i / (n + 1));
    return xs;
  }

  function sampleEasingPoints(fn, xs) {
    const inner = xs.map((x) => {
      const d = clamp(numDeriv(fn, x), -MAX_SLOPE, MAX_SLOPE);
      return pt(x, fn(x), 'manual', d, d);
    });
    const pts = [pt(0, 0), ...inner, pt(1, 1)];
    for (let i = 0; i < pts.length; i++) {
      const leftAvg = i > 0
        ? (pts[i].y - pts[i - 1].y) / (pts[i].x - pts[i - 1].x)
        : null;
      const rightAvg = i < pts.length - 1
        ? (pts[i + 1].y - pts[i].y) / (pts[i + 1].x - pts[i].x)
        : null;
      if (i === 0) {
        setSlope(pts[0], round3(capEndSlope(rightDeriv(fn, 0), rightAvg)));
      } else if (i === pts.length - 1) {
        setSlope(pts[i], round3(capEndSlope(leftDeriv(fn, 1), leftAvg)));
      } else {
        const raw = numDeriv(fn, pts[i].x);
        const s = round3(capAgainstNeighbors(raw, leftAvg, rightAvg));
        pts[i].in = pts[i].out = s;
      }
    }
    return pts;
  }

  // Bounce landings + local peaks. Landings get independent in/out slopes.
  function bounceOutPoints() {
    const fn = EASING_FNS.easeOutBounce;
    const d1 = 2.75;
    const land = [1 / d1, 2 / d1, 2.5 / d1];
    const peaks = [1.5 / d1, 2.25 / d1, 2.625 / d1];
    // Mid of the first rise helps the long opening parabola.
    const xs = [0.18, ...land, ...peaks].sort((a, b) => a - b);
    const pts = [pt(0, 0)];
    for (const x of xs) {
      const y = fn(x);
      const atLand = land.some((v) => Math.abs(v - x) < 1e-9);
      if (atLand) pts.push(pt(x, y, 'manual', leftDeriv(fn, x), rightDeriv(fn, x)));
      else {
        const d = numDeriv(fn, x);
        pts.push(pt(x, y, 'manual', d, d));
      }
    }
    pts.push(pt(1, 1));
    const d0 = (pts[1].y - pts[0].y) / (pts[1].x - pts[0].x);
    const dN = (pts[pts.length - 1].y - pts[pts.length - 2].y)
      / (pts[pts.length - 1].x - pts[pts.length - 2].x);
    setSlope(pts[0], round3(capEndSlope(rightDeriv(fn, 0), d0)));
    setSlope(pts[pts.length - 1], round3(capEndSlope(leftDeriv(fn, 1), dN)));
    return pts;
  }

  // easeInBounce(x) = 1 - Out(1 - x)
  function bounceInPoints() {
    return bounceOutPoints()
      .map((p) => pt(1 - p.x, 1 - p.y, p.mode, p.out, p.in))
      .reverse();
  }

  // Build InOut from Out via (1-Out(1-2x))/2 and (1+Out(2x-1))/2.
  function inOutFromOut(half, fn) {
    const pts = [pt(0, 0)];
    for (let i = half.length - 1; i >= 1; i--) {
      const p = half[i];
      pts.push(pt((1 - p.x) / 2, (1 - p.y) / 2, p.mode, p.out, p.in));
    }
    for (let i = 1; i < half.length - 1; i++) {
      const p = half[i];
      pts.push(pt(0.5 + p.x / 2, 0.5 + p.y / 2, p.mode, p.in, p.out));
    }
    pts.push(pt(1, 1));
    const cleaned = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].x - cleaned[cleaned.length - 1].x < 1e-6) continue;
      cleaned.push(pts[i]);
    }
    if (cleaned[cleaned.length - 1].x < 1 - 1e-9) cleaned.push(pt(1, 1));
    else {
      const last = cleaned[cleaned.length - 1];
      cleaned[cleaned.length - 1] = pt(1, 1, last.mode, last.in, last.out);
    }
    const d0 = (cleaned[1].y - cleaned[0].y) / (cleaned[1].x - cleaned[0].x);
    const dN = (cleaned[cleaned.length - 1].y - cleaned[cleaned.length - 2].y)
      / (cleaned[cleaned.length - 1].x - cleaned[cleaned.length - 2].x);
    setSlope(cleaned[0], round3(capEndSlope(rightDeriv(fn, 0), d0)));
    setSlope(cleaned[cleaned.length - 1], round3(capEndSlope(leftDeriv(fn, 1), dN)));
    return cleaned;
  }

  function bounceInOutPoints() {
    return inOutFromOut(bounceOutPoints(), EASING_FNS.easeInOutBounce);
  }

  function circInOutPoints() {
    return inOutFromOut(
      sampleEasingPoints(EASING_FNS.easeOutCirc, EASING_SAMPLE_XS.easeOutCirc),
      EASING_FNS.easeInOutCirc
    );
  }

  function easingToState(id) {
    const fn = EASING_FNS[id];
    if (!fn) return { points: '' };
    if (id === 'linear') return { points: '' };
    let pts;
    if (id === 'easeOutBounce') pts = bounceOutPoints();
    else if (id === 'easeInBounce') pts = bounceInPoints();
    else if (id === 'easeInOutBounce') pts = bounceInOutPoints();
    else if (id === 'easeInOutCirc') pts = circInOutPoints();
    else pts = sampleEasingPoints(fn, sampleXsFor(id));
    return pointsToState(pts);
  }

  const CURVE_PRESETS = Object.keys(EASING_FNS).map((id) => ({
    id,
    state: easingToState(id),
  }));

  // A preset put into one curve (0, or 1 for between) as it is: its points and slopes, and its endY (1).
  function presetInto(e, which, state) {
    if (which === 1) e.markBetweenManual();
    const curve = which === 1 && e.betweenCurve ? e.betweenCurve : e.curve;
    curve.setPoints(materializePoints(state));
  }

  function presetCurvePath(state, w = 40, h = 28) {
    const pts = materializePoints(state);
    const slopes = resolveSlopes(pts);
    const padX = 2;
    const padY = 3;
    const n = 28;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i <= n; i++) {
      const y = evaluate(pts, slopes, i / n)[0];
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    const span = Math.max(1.2, hi - lo);
    let d = '';
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const y = evaluate(pts, slopes, u)[0];
      const sx = padX + u * (w - padX * 2);
      const sy = h - padY - ((y - lo) / span) * (h - padY * 2);
      d += `${i === 0 ? 'M' : 'L'}${round3(sx)} ${round3(sy)}`;
    }
    return d;
  }

  function presetIcon(state) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 40 28');
    svg.setAttribute('aria-hidden', 'true');
    const base = document.createElementNS(ns, 'path');
    base.setAttribute('d', 'M2 25H38M2 3V25');
    base.setAttribute('class', 'fe-preset-axes');
    const curve = document.createElementNS(ns, 'path');
    curve.setAttribute('d', presetCurvePath(state));
    curve.setAttribute('class', 'fe-preset-curve');
    svg.append(base, curve);
    return svg;
  }

  // ---------------------------------------------------------------------------
  // Band layout
  // ---------------------------------------------------------------------------

  // Frames in one cycle (display only; progressAt is unchanged): one run and its wait, or there and back
  // when alternating. Without loop it is the frames until the motion stops, which is what the band shows.
  // The stagger readout counts laps as if looping, whatever `loop` says, so it passes `loop` itself.
  function effectiveCycleFrames(e, loop = !!e.loop) {
    const d = Math.max(1, +e.duration || 1);
    const w = Math.max(0, +e.loopDelay || 0);
    const alt = alternateMode(e.alternate);
    if (!loop && alt === false) return d;
    if (!loop && alt !== false) return Math.max(1, 2 * d + w);
    return alt === false ? Math.max(1, d + w) : Math.max(1, 2 * (d + w));
  }

  // Layout of the timing band on the graph's horizontal axis: left wait | duration | right wait.
  // A wait is there only when loop / alternate waits in it; then it takes loopDelay's width.
  // - right: after the way there (loop or alternate)
  // - left: after the way back (loop and alternate)
  // The delay is a row of its own above the band, at the same scale, from the band's left end.
  // The room left of duration (`lead`) is the longer of the delay and the left wait; with a longer
  // delay the band starts with a gap before the left wait.
  function bandLayoutOf(opts, kx) {
    const d = Math.max(1, opts.duration);
    const w = Math.max(0, opts.loopDelay);
    const start = Math.max(0, +opts.delay || 0);
    const mode = alternateMode(opts.alternate);
    const round = mode !== false;
    const loop = !!opts.loop;
    const useL = loop && round;
    const useR = loop || round;
    const left = useL ? w : 0;
    const right = useR ? w : 0;
    const lead = Math.max(start, left);
    const total = Math.max(1, lead + d + right);
    const ppf = kx / total;
    const cx0 = lead * ppf;
    const cw = d * ppf;
    return { d, w, start, left, right, lead, mode, round, total, ppf, cx0, cw, cx1: cx0 + cw, useL, useR };
  }

  // Frames per second the sketch asks for: what p5's frameRate(n) set, not the rate measured just now,
  // which wobbles every frame. 60 without p5 or when it cannot be read. p5 before 1.5 has no
  // getTargetFrameRate(), so the instance's own value is the fallback.
  function sketchFrameRate() {
    let fps = null;
    try {
      const inst = root.p5 && root.p5.instance;
      if (typeof root.getTargetFrameRate === 'function') fps = root.getTargetFrameRate();
      else if (inst && typeof inst.getTargetFrameRate === 'function') fps = inst.getTargetFrameRate();
      else if (inst) fps = inst._targetFrameRate;
    } catch (_) {
      // Ignore hosts that throw on property access.
    }
    return typeof fps === 'number' && Number.isFinite(fps) && fps > 0 ? fps : 60;
  }

  // Texts of the info row under the band: one cycle in frames and in seconds (at the sketch's
  // frame rate), and the frame rate. `loop` says whether the loop icon goes in front.
  function bandDimensionLabels(e, fps = sketchFrameRate()) {
    const cycle = effectiveCycleFrames(e);
    return {
      cycle: `${cycle}f`,
      seconds: `${(cycle / fps).toFixed(1)}s`,
      fps: `${+fps.toFixed(2)}fps`,
      loop: !!e.loop,
    };
  }

  // Segment edges in px from the band's left. `start` is the delay row, above the band: it always
  // starts at the band's left end. With a left wait longer than the delay it ends before duration
  // begins; an arrow then leads from its end to duration (the first run starts right after it).
  function bandSegmentXs(L) {
    const l = L.lead * L.ppf;
    const d = l + L.d * L.ppf;
    return {
      start: [0, L.start * L.ppf],
      left: [l - L.left * L.ppf, l],
      dur: [l, d],
      right: [d, d + L.right * L.ppf],
    };
  }

  // What fits on the info row, given its width and the width of one character. The seconds go first,
  // then the loop icon; the frame count and the frame rate always stay.
  function infoLabelFit(labels, width, charW) {
    const icon = labels.loop ? INFO_LOOP_W : 0;
    const rate = ' @'.length + labels.fps.length;
    const short = labels.cycle.length + rate;
    const full = short + INFO_SEP.length + labels.seconds.length;
    const seconds = full * charW + icon <= width;
    return { seconds, icon: labels.loop && (seconds || short * charW + icon <= width) };
  }

  // Where on duration (0 at its left edge, 1 at its right) the playhead stands, on the band and the graph.
  function visualT(phase, progress, mode) {
    if (phase === 'go') return progress;
    if (phase === 'return') return mode === 'mirror' ? 1 - progress : progress;
    if (phase === 'wait-left' || phase === 'hold-start' || phase === 'before') return 0;
    return 1;
  }

  // Which part of the minimized strip is lit. A side wait lights its own part; held at an end (no
  // loop), duration is lit as a wait.
  function miniHot(phase) {
    const left = phase === 'wait-left';
    const right = phase === 'wait-right';
    const held = isWaitingPhase(phase) && !left && !right;
    return { left, right, dur: held || phase === 'go' || phase === 'return', durKind: held ? 'wait' : 'move' };
  }

  // Pixel x, from the band's left, of a frame's mark: on duration while it moves, at duration's edge
  // while it waits, and in the delay row before the first run (from the band's left end).
  function bandMarkX(frame, opts, L) {
    const left = L.lead * L.ppf;
    const dur = L.cw;
    if (frame == null || !Number.isFinite(+frame)) return left;
    const phase = phaseAt(frame, opts);
    if (phase === 'before') {
      const delay = Math.max(0, +(opts && opts.delay) || 0);
      if (delay > 0) return (delay - clamp(-frame, 0, delay)) * L.ppf;
      return left;
    }
    if (phase === 'wait-left' || phase === 'hold-start') return left;
    if (phase === 'wait-right' || phase === 'hold-end') return left + dur;
    return left + visualT(phase, progressAt(frame, opts), L.mode) * dur;
  }

  // Frame for a band x while scrubbing. The scrub points inside duration only: left or right of it the
  // frame stays at duration's edge. The waits and the delay hold one pose, and on an alternating band they
  // are not in time order, so dragging into them would have no clear direction.
  // Return frames share an x with the go, so pass phase 'return' to stay on the way back.
  function frameFromBandX(x, opts, L, phaseHint) {
    const d = Math.max(1, +opts.duration || 60);
    const w = Math.max(0, +opts.loopDelay || 0);
    const mode = L.mode !== undefined ? L.mode : alternateMode(opts.alternate);
    const ppf = L.ppf > 0 ? L.ppf : 1;
    const origin = L.lead * ppf;
    const dur = L.cw > 0 ? L.cw : d * ppf;
    const rel = dur > 0 ? clamp((x - origin) / dur, 0, 1) : 0;
    if (phaseHint === 'return' && mode !== false) return d + w + (1 - rel) * d;
    // Looping one way with no loop delay, frame `d` is already frame 0 of the next cycle, so the
    // right end would jump back to the start. Stop one frame short there.
    if (opts.loop && w === 0 && mode === false) return Math.min(rel * d, d - 1);
    return rel * d;
  }

  // Group marks that land on nearly the same x (phase overlap), left to right.
  function clusterMarks(placed, thresh) {
    const sorted = placed.slice().sort((a, b) => a.x - b.x);
    const groups = [];
    for (const p of sorted) {
      const g0 = groups[groups.length - 1];
      if (g0 && Math.abs(p.x - g0.x) <= thresh) {
        g0.items.push(p);
        g0.x = (g0.x * (g0.items.length - 1) + p.x) / g0.items.length;
      } else {
        groups.push({ x: p.x, items: [p] });
      }
    }
    return groups;
  }

  // ---------------------------------------------------------------------------
  // Adding and deleting points
  // ---------------------------------------------------------------------------

  // Same fraction of the interval on each linked curve. A point halfway
  // between a's neighbours lands halfway between the partner's neighbours.
  function placeX(originPoints, points, index, x) {
    const oLeft = originPoints[index - 1];
    const oRight = originPoints[index];
    const left = points[index - 1];
    const right = points[index];
    if (!oLeft || !oRight || !left || !right) return null;
    const oSpan = oRight.x - oLeft.x;
    const span = right.x - left.x;
    if (!(oSpan > 0) || !(span > 0)) return null;
    const raw = left.x + ((x - oLeft.x) / oSpan) * span;
    let px = round3(raw);
    if (!(px > left.x && px < right.x)) px = raw;
    if (!(px > left.x && px < right.x)) return null;
    return px;
  }

  // `which` is 0 or 1: the curve the point is added on. The other curve gets a point
  // at the same fraction of the interval, with y and slope read from itself.
  function insertPoint(target, index, x, y, which) {
    const origin = easingOf(target);
    if (!origin) return null;
    if (which === 1) origin.markBetweenManual();
    if (origin.betweenAuto && which === 0) {
      const pts = origin.curve.points;
      if (index < 1 || index > pts.length - 1) return null;
      origin.curve.points.splice(index, 0, pt(x, y));
      origin.curve.invalidate();
      origin.pointGen++;
      origin._betweens.clear();
      origin.syncAutoBetween();
      return origin;
    }
    const curves = origin.betweenCurve ? [origin.curve, origin.betweenCurve] : [origin.curve];
    const srcI = which === 1 && curves[1] ? 1 : 0;
    const originCurve = curves[srcI];
    const originPoints = originCurve.points;
    if (index < 1 || index > originPoints.length - 1) return null;
    const plan = [];
    for (let i = 0; i < curves.length; i++) {
      const curve = curves[i];
      const pts = curve.points;
      if (index < 1 || index > pts.length - 1) return null;
      if (i === srcI) {
        plan.push({ curve, point: pt(x, y) });
        continue;
      }
      const px = placeX(originPoints, pts, index, x);
      if (px == null) {
        warn(`FrameEase: no room for a matching point on "${origin.name}".`);
        return null;
      }
      const [py, dy] = curve.evaluate(px);
      plan.push({ curve, point: pt(px, round3(py), 'manual', dy, dy) });
    }
    for (const p of plan) {
      p.curve.points.splice(index, 0, p.point);
      p.curve.invalidate();
    }
    origin.pointGen++;
    origin._betweens.clear();
    return origin;
  }

  function deletePointAt(target, index) {
    const origin = easingOf(target);
    if (!origin) return null;
    if (origin.betweenAuto) {
      const pts = origin.curve.points;
      if (index <= 0 || index >= pts.length - 1) return null;
      origin.curve.points.splice(index, 1);
      origin.curve.invalidate();
      origin.pointGen++;
      origin._betweens.clear();
      origin.syncAutoBetween();
      return origin;
    }
    const curves = origin.betweenCurve ? [origin.curve, origin.betweenCurve] : [origin.curve];
    for (const curve of curves) {
      if (index <= 0 || index >= curve.points.length - 1) return null;
    }
    for (const curve of curves) {
      curve.points.splice(index, 1);
      curve.invalidate();
    }
    origin.pointGen++;
    origin._betweens.clear();
    return origin;
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  // Hover tip of a number field. A part too narrow to show its number says the value first
  // ("delay 12f · Drag to change…"); one that shows it does not repeat it.
  function numTipText(key, value, numberHidden) {
    const base = t('scrubHover');
    return numberHidden && key ? `${t('hiddenValue', key, formatFrameNum(value))} · ${base}` : base;
  }

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  // 16x16 stroke icons.
  const ICONS = {
    close: 'M4 4l8 8M12 4l-8 8',
    minimize: 'M4 10.5h8',
    expand: 'M4 10l4-4 4 4',
    duration: 'M2 4v8M14 4v8M4 8h8M10 6l2 2-2 2',
    delay: 'M4 2h8M4 14h8M5 2c0 3 6 3 6 6s-6 3-6 6M11 2c0 3-6 3-6 6s6 3 6 6',
    loop: 'M3 7V6.5A2.5 2.5 0 0 1 5.5 4H13M11 2l2 2-2 2M13 9v.5A2.5 2.5 0 0 1 10.5 12H3M5 14l-2-2 2-2',
    altOff: 'M3 8h9M9 5l3 3-3 3',
    altReverse: 'M2 5h11M10 2l3 3-3 3M14 11H3M6 8l-3 3 3 3',
    altMirror: 'M8 2v12M4 6l4-4 4 4M4 10l4 4 4-4',
    presets: 'M2 12C5 12 5 4 8 4s3 8 6 8 3-8 6-8',
    undo: 'M6 3L2 7l4 4M3 7h7.5a3.5 3.5 0 0 1 0 7H9',
    redo: 'M10 3l4 4-4 4M13 7H5.5a3.5 3.5 0 0 0 0 7H7',
    save: 'M5 2h6v8H5zM9 6h6v8H9',
    pause: 'M5 3v10M11 3v10',
    play: 'M5 3l8 5-8 5z',
  };

  function betweenCurvesSvg(size) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    const p1 = document.createElementNS(ns, 'path');
    p1.setAttribute('d', 'M2 12C6 12 7 4 14 4');
    const p2 = document.createElementNS(ns, 'path');
    p2.setAttribute('d', 'M2 12C9 12 10 7 14 4');
    p2.setAttribute('opacity', '0.5');
    svg.append(p1, p2);
    return svg;
  }

  function svgIcon(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.appendChild(path);
    return svg;
  }

  // Icon name for an alternate setting (false / true / 'mirror').
  function alternateIcon(alternate) {
    const mode = alternateMode(alternate);
    return mode === 'mirror' ? 'altMirror' : mode === true ? 'altReverse' : 'altOff';
  }

  function iconButton(name, title) {
    const b = h('button', 'fe-icon');
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.appendChild(svgIcon(name));
    return b;
  }

  // Small text field used for every editable number in the panel.
  function numInput() {
    const input = h('input', 'fe-num');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.spellcheck = false;
    return input;
  }

  function isField(t) {
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  function capture(el, ev) {
    try {
      el.setPointerCapture(ev.pointerId);
    } catch (_) {
      // Synthetic or already-released pointers cannot be captured.
    }
  }

  function injectStyle() {
    if (document.getElementById('frame-ease-style')) return;
    const s = h('style');
    s.id = 'frame-ease-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function sizeCanvas(canvas, w, h) {
    const dpr = root.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(w * dpr));
    const ch = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    return dpr;
  }

  function guiList() {
    return settings.gui ? [...instances.values()] : [];
  }

  // ---------------------------------------------------------------------------
  // Panel
  // ---------------------------------------------------------------------------

  class Panel {
    constructor() {
      injectStyle();
      this.ui = Object.assign(
        { open: true, minimized: false, x: null, y: null, w: 464, h: 544, selected: null },
        lsGet(UI_KEY) || {}
      );
      // Shared by the parts: the selected easing, this frame's calls, the selected point and curve,
      // the drag in progress.
      this.cur = null;
      this.calls = [];
      this.sel = -1;
      this.active = 0;
      this.drag = null;
      this.hover = false;
      this.undoStack = [];
      this.redoStack = [];
      this.range = [-0.5, 1.5];
      this.rangeDirty = true;
      this.gw = 0;
      this.gh = 0;
      this.msg = '';
      this.msgTimer = 0;
      this.raf = 0;

      this.band = new BandView(this);
      this.graph = new GraphView(this);
      this.controls = new Controls(this);
      this.keys = new Keys(this);

      this.build();
      this.bind();
      this.refreshAll();
      this.applyRect();
      this.applyView();
    }

    // ---- DOM ----------------------------------------------------------------

    build() {
      const el = (this.el = h('div', 'fe-panel'));
      this.buildGrip();

      const body = h('div', 'fe-body');
      this.graphWrap = h('div', 'fe-graph');
      const band = this.band.build();
      const controls = this.controls.build();
      // The order decides which part is on top where two share a z-index.
      this.graphWrap.append(
        this.graph.build(), ...band.nodes, controls.presets, band.readout, controls.modeBars, controls.tip
      );

      body.append(this.graphWrap);
      this.resizer = h('div', 'fe-resize');
      // One line under the title bar while drafts from last time are waiting.
      // Its square is the copy button's dot: changes not copied yet. A narrow panel cuts the names, not the lead.
      this.notice = h('div', 'fe-notice');
      this.noticeText = h('span', 'fe-notice-text');
      this.noticeNames = h('span', 'fe-notice-names');
      this.noticeText.append(h('span', 'fe-notice-lead', t('draftKeptLead')), this.noticeNames);
      this.restoreBtn = h('button', 'fe-restore', t('draftRestore'));
      this.discardBtn = h('button', null, t('draftDiscard'));
      this.restoreBtn.type = this.discardBtn.type = 'button';
      this.notice.append(h('span', 'fe-notice-dot'), this.noticeText, this.restoreBtn, this.discardBtn);
      this.notice.hidden = true;
      this.restoreBtn.addEventListener('click', () => this.restoreDrafts());
      this.discardBtn.addEventListener('click', () => {
        drafts.discard();
        this.syncNotice();
      });
      el.append(this.grip, this.notice, body, this.resizer);
      document.body.appendChild(el);

      this.buildMini();
      this.applyLocale();
    }

    // Title bar: tabs, status, the controls' buttons, minimize / close.
    buildGrip() {
      const grip = (this.grip = h('div', 'fe-grip'));
      this.tabs = h('div', 'fe-tabs');
      this.status = h('span', 'fe-status');
      this.minBtn = iconButton('minimize', '');
      this.closeBtn = iconButton('close', '');
      const windowGroup = h('div', 'fe-group');
      windowGroup.append(this.minBtn, this.closeBtn);
      grip.append(this.tabs, this.status, ...this.controls.buildButtons(), h('div', 'fe-sep'), windowGroup);
    }

    // Minimized strip shown instead of the panel.
    buildMini() {
      this.mini = h('div', 'fe-mini');
      this.miniName = h('span', 'fe-mini-name');
      this.miniBand = h('div', 'fe-mini-band');
      this.miniSegL = h('div', 'fe-mini-seg');
      this.miniSegD = h('div', 'fe-mini-seg');
      this.miniSegR = h('div', 'fe-mini-seg');
      this.miniPlay = h('div', 'fe-mini-play');
      this.miniBand.append(this.miniSegL, this.miniSegD, this.miniSegR, this.miniPlay);
      this.miniIcons = h('span', 'fe-mini-icons');
      this.miniLoopIcon = svgIcon('loop');
      this.miniAltIcon = svgIcon('altOff');
      this.miniIcons.append(this.miniLoopIcon, this.miniAltIcon);
      this.miniDot = h('span', 'fe-mini-dot');
      // Pause / resume, like the pause button in the panel's title bar. Always there while pause is
      // available, so the strip keeps one width.
      this.miniPause = iconButton('pause', '');
      this.miniPause.classList.add('fe-mini-pause');
      this.miniPause.hidden = true;
      this.expandBtn = iconButton('expand', '');
      this.mini.append(this.miniName, this.miniBand, this.miniIcons, this.miniDot, this.miniPause, this.expandBtn);
      document.body.appendChild(this.mini);
    }

    applyLocale() {
      const key = settings.toggleKey.toUpperCase();
      this.minBtn.title = t('minimize');
      this.minBtn.setAttribute('aria-label', t('minimize'));
      this.closeBtn.title = t('hide', key);
      this.closeBtn.setAttribute('aria-label', t('hide', key));
      this.expandBtn.title = t('expand', key);
      this.expandBtn.setAttribute('aria-label', t('expand', key));
      this.band.applyLocale();
      this.controls.applyLocale();
    }

    bind() {
      const el = this.el;

      // Keep pointer, touch and wheel input on the panel away from the sketch.
      // mousemove is left alone, so p5's mouseX / mouseY still update.
      for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick',
        'contextmenu', 'wheel', 'touchstart', 'touchmove', 'touchend', 'touchcancel']) {
        el.addEventListener(type, (ev) => ev.stopPropagation());
      }
      for (const type of ['keydown', 'keyup', 'keypress']) {
        el.addEventListener(type, (ev) => ev.stopPropagation());
      }
      el.addEventListener('pointerenter', () => (this.hover = true));
      el.addEventListener('pointerleave', () => (this.hover = false));
      for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick',
        'contextmenu', 'wheel', 'touchstart', 'touchmove', 'touchend', 'touchcancel',
        'keydown', 'keyup', 'keypress']) {
        this.mini.addEventListener(type, (ev) => ev.stopPropagation());
      }

      this.onKeyDown = (ev) => this.keys.keyDown(ev);
      this.onKeyOther = (ev) => this.keys.keyOther(ev);
      this.onResize = () => this.applyRect();
      // A reload right after a change must not lose it to the save's short wait.
      this.onPageHide = () => drafts.flush();
      this.onVisibility = () => {
        if (document.visibilityState === 'hidden') drafts.flush();
      };
      root.addEventListener('keydown', this.onKeyDown, true);
      root.addEventListener('keyup', this.onKeyOther, true);
      root.addEventListener('keypress', this.onKeyOther, true);
      root.addEventListener('resize', this.onResize);
      root.addEventListener('pagehide', this.onPageHide);
      document.addEventListener('visibilitychange', this.onVisibility);

      this.bindMoveResize();
      this.graph.bindGraph();
      this.band.bind();
      this.controls.bindControls();

      this.ro = new ResizeObserver(() => this.measure());
      this.ro.observe(this.graphWrap);
    }

    destroy() {
      cancelAnimationFrame(this.raf);
      callLog.listen(true);
      this.ro.disconnect();
      root.removeEventListener('keydown', this.onKeyDown, true);
      root.removeEventListener('keyup', this.onKeyOther, true);
      root.removeEventListener('keypress', this.onKeyOther, true);
      root.removeEventListener('resize', this.onResize);
      root.removeEventListener('pagehide', this.onPageHide);
      document.removeEventListener('visibilitychange', this.onVisibility);
      drafts.flush();
      this.controls.destroy();
      this.el.remove();
      this.mini.remove();
    }

    saveUI() {
      lsSet(UI_KEY, this.ui);
    }

    // ---- Open / position / size ---------------------------------------------

    applyView() {
      const open = !!this.ui.open;
      const mini = open && !!this.ui.minimized;
      this.el.hidden = !open || mini;
      this.mini.hidden = !mini;
      this.hover = open && !mini ? this.hover : false;
      if (!open || mini) this.drag = null;
      followPanel(this.ui);
      cancelAnimationFrame(this.raf);
      if (open) {
        this.measure();
        const tick = () => {
          if (drafts.scan()) this.syncNotice();
          this.band.scrubTick();
          if (this.ui.minimized) this.drawMini();
          else this.draw();
          this.raf = requestAnimationFrame(tick);
        };
        this.raf = requestAnimationFrame(tick);
      }
      this.applyRect();
      this.saveUI();
      this.syncControls();
    }

    setOpen(open) {
      this.ui.open = open;
      if (!open) this.ui.minimized = false;
      this.applyView();
    }

    setMinimized(min) {
      if (min) {
        this.ui.open = true;
        this.ui.minimized = true;
        // Tuck the mini bar into the bottom-right corner.
        this.ui.miniX = null;
        this.ui.miniY = null;
      } else {
        this.ui.minimized = false;
        this.ui.open = true;
      }
      this.applyView();
    }

    toggle() {
      if (this.ui.open && this.ui.minimized) this.setMinimized(false);
      else this.setOpen(!this.ui.open);
    }

    applyRect() {
      const vw = root.innerWidth;
      const vh = root.innerHeight;
      if (this.ui.open && this.ui.minimized) {
        this.mini.style.width = 'max-content';
        const mw = Math.min(this.mini.offsetWidth || 200, vw - EDGE * 2);
        const x = clamp(this.ui.miniX == null ? vw - mw - EDGE : this.ui.miniX, 0, Math.max(0, vw - mw));
        const y = clamp(this.ui.miniY == null ? vh - 32 - EDGE : this.ui.miniY, 0, Math.max(0, vh - 32));
        Object.assign(this.mini.style, { left: x + 'px', top: y + 'px' });
        return;
      }
      const w = clamp(this.ui.w, MIN_W, Math.max(MIN_W, vw - EDGE * 2));
      const hh = clamp(this.ui.h, MIN_H, Math.max(MIN_H, vh - EDGE * 2));
      let x = this.ui.x == null ? vw - w - EDGE : this.ui.x;
      let y = this.ui.y == null ? vh - hh - EDGE : this.ui.y;
      x = clamp(x, 0, Math.max(0, vw - w));
      y = clamp(y, 0, Math.max(0, vh - 24));
      Object.assign(this.el.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: hh + 'px' });
    }

    bindMoveResize() {
      const dragBox = (handle, getRect, onMove, opts = {}) => {
        handle.addEventListener('pointerdown', (ev) => {
          if (ev.button !== 0 || ev.target.closest('button')) return;
          ev.preventDefault();
          const r = getRect();
          const start = { px: ev.clientX, py: ev.clientY, x: r.left, y: r.top, w: r.width, h: r.height };
          let moved = false;
          capture(handle, ev);
          const move = (e2) => {
            const dx = e2.clientX - start.px;
            const dy = e2.clientY - start.py;
            if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
            moved = true;
            onMove(start, dx, dy);
            this.applyRect();
          };
          const up = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
            handle.removeEventListener('pointercancel', up);
            this.saveUI();
            if (opts.onUp) opts.onUp(moved);
          };
          handle.addEventListener('pointermove', move);
          handle.addEventListener('pointerup', up);
          handle.addEventListener('pointercancel', up);
        });
      };
      dragBox(this.grip, () => this.el.getBoundingClientRect(), (s, dx, dy) => {
        this.ui.x = s.x + dx;
        this.ui.y = s.y + dy;
      });
      dragBox(this.resizer, () => this.el.getBoundingClientRect(), (s, dx, dy) => {
        this.ui.x = s.x;
        this.ui.y = s.y;
        this.ui.w = Math.max(MIN_W, s.w + dx);
        this.ui.h = Math.max(MIN_H, s.h + dy);
      });
      this.miniDragged = false;
      dragBox(
        this.mini,
        () => this.mini.getBoundingClientRect(),
        (s, dx, dy) => {
          this.ui.miniX = s.x + dx;
          this.ui.miniY = s.y + dy;
        },
        {
          onUp: (moved) => {
            this.miniDragged = moved;
          },
        }
      );
      this.closeBtn.addEventListener('click', () => this.setOpen(false));
      this.minBtn.addEventListener('click', () => this.setMinimized(true));
      this.expandBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.setMinimized(false);
      });
      this.mini.addEventListener('click', () => {
        if (this.miniDragged) {
          this.miniDragged = false;
          return;
        }
        this.setMinimized(false);
      });
      this.miniPause.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.setPaused(!transportState().on);
      });
    }

    measure() {
      const g = this.graphWrap.getBoundingClientRect();
      if (g.width !== this.gw || g.height !== this.gh) {
        this.gw = g.width;
        this.gh = g.height;
      }
    }

    // ---- State changes / history --------------------------------------------

    affectsView(e) {
      return !!this.cur && e === this.cur;
    }

    changed(e) {
      e.curve.invalidate();
      if (e.betweenAuto) e.syncAutoBetween();
      else if (e.betweenCurve) e.betweenCurve.invalidate();
      e.pointGen++;
      e._betweens.clear();
      if (this.affectsView(e) && !this.drag) this.rangeDirty = true;
      if (drafts.touch(e)) this.syncNotice();
      this.syncControls();
    }

    liveChanged(e) {
      e.curve.invalidate();
      if (e.betweenAuto) e.syncAutoBetween();
      else if (e.betweenCurve) e.betweenCurve.invalidate();
      e.pointGen++;
      e._betweens.clear();
      if (drafts.touch(e)) this.syncNotice();
      this.syncControls();
    }

    // ---- Drafts kept from last time -------------------------------------------

    syncNotice() {
      const names = drafts.names();
      this.notice.hidden = names.length === 0;
      this.noticeNames.textContent = names.join(', ');
      this.noticeText.title = names.length ? t('draftKept', names.join(', ')) : '';
      this.syncMiniDot();
    }

    // The strip's dot: changes not copied yet, in the panel or kept from last time.
    syncMiniDot(hasDraft = guiList().some((x) => x.hasDraft)) {
      const show = hasDraft || drafts.names().length > 0;
      if (this.miniDot.hidden !== !show) {
        this.miniDot.hidden = !show;
        if (this.ui.open && this.ui.minimized) this.applyRect();
      }
    }

    // Bring every waiting draft back as one step of the history; undo returns to the code's values.
    restoreDrafts() {
      const befores = [];
      for (const { e, state } of drafts.take()) {
        const before = e.snapshot();
        try {
          e.applyState(state);
        } catch (_) {
          e.applyState(before);
          continue;
        }
        befores.push({ e, before });
      }
      this.recordMany(befores);
      for (const { e } of befores) this.changed(e);
      this.renderTabs();
      this.syncNotice();
    }

    pushHistory(entry) {
      this.undoStack.push(entry);
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack.length = 0;
    }

    record(e, before) {
      const after = e.snapshot();
      if (JSON.stringify(before) === JSON.stringify(after)) return false;
      this.pushHistory({ name: e.name, before, after });
      return true;
    }

    recordMany(befores) {
      const steps = [];
      for (const { e, before } of befores) {
        const after = e.snapshot();
        if (JSON.stringify(before) !== JSON.stringify(after)) steps.push({ name: e.name, before, after });
      }
      if (!steps.length) return false;
      this.pushHistory(steps.length === 1 ? steps[0] : { steps });
      return true;
    }

    edit(fn) {
      this.editInstance(this.cur, fn);
    }

    editInstance(e, fn) {
      if (!e) return;
      const before = e.snapshot();
      fn(e);
      if (this.record(e, before)) this.changed(e);
    }

    restore(entry, which) {
      const steps = entry.steps || [entry];
      const names = new Set();
      for (const step of steps) {
        const e = instances.get(step.name);
        if (!e || !settings.gui) continue;
        e.applyState(step[which]);
        this.changed(e);
        names.add(step.name);
      }
      const stay = this.cur && (names.has(this.cur.name));
      if (stay) {
        if (!this.cur.betweenCurve) this.active = 0;
        const curve = this.activeCurve(this.cur);
        if (!curve || this.sel >= curve.points.length) this.sel = -1;
        this.renderTabs();
        return;
      }
      const first = instances.get(steps[0].name);
      if (first && settings.gui) this.select(first);
    }

    undo() {
      const entry = this.undoStack.pop();
      if (!entry) return;
      this.redoStack.push(entry);
      this.restore(entry, 'before');
    }

    redo() {
      const entry = this.redoStack.pop();
      if (!entry) return;
      this.undoStack.push(entry);
      this.restore(entry, 'after');
    }

    // ---- Selection, tabs, sync ----------------------------------------------

    curveOf(e, which) {
      if (!e) return null;
      if (which === 1 && e.betweenCurve) return e.betweenCurve;
      return e.curve;
    }

    activeWhich(e = this.cur) {
      return e && e.betweenCurve && this.active === 1 ? 1 : 0;
    }

    activeCurve(e = this.cur) {
      return this.curveOf(e, this.activeWhich(e));
    }

    panelShowsBetween(e = this.cur) {
      return !!(e && betweenInCalls(e, this.calls || []));
    }

    showsFrameTiming(e = this.cur) {
      if (!e) return true;
      return e._showFrameTiming !== false;
    }

    updateFrameTimingVisibility(e) {
      if (!e) return;
      const mine = callsForEasing(e, this.calls || []);
      if (mine.length) e._showFrameTiming = mine.some((c) => c.kind === 'frame');
    }

    select(e) {
      this.cur = e;
      this.sel = -1;
      if (!e || !this.panelShowsBetween(e) || !e.betweenCurve) this.active = 0;
      this.ui.selected = e ? e.name : null;
      this.rangeDirty = true;
      this.saveUI();
      this.renderTabs();
      this.syncControls();
    }

    refreshAll() {
      const list = guiList();
      if (!this.cur || !list.includes(this.cur)) {
        const want = list.find((e) => e.name === this.ui.selected);
        this.cur = want || list[0] || null;
        this.sel = -1;
      }
      this.rangeDirty = true;
      drafts.recheck();
      this.syncNotice();
      this.renderTabs();
      this.syncControls();
    }

    // Tab marks depend on this frame's calls, which do not exist yet when the panel first renders.
    // Re-render the tabs only when an easing's mark changes. Easings not called this frame keep their mark.
    syncTabMarks() {
      const calls = this.calls || [];
      if (!calls.length) return;
      if (!this._tabMarks) this._tabMarks = new Map();
      let changed = false;
      for (const e of guiList()) {
        if (!callsForEasing(e, calls).length) continue;
        const on = !!(betweenInCalls(e, calls) && e.betweenCurve);
        if (this._tabMarks.get(e) !== on) {
          this._tabMarks.set(e, on);
          changed = true;
        }
      }
      if (changed) this.renderTabs();
    }

    tabMarkOn(e) {
      if (this._tabMarks && this._tabMarks.has(e)) return this._tabMarks.get(e);
      return !!(this.panelShowsBetween(e) && e.betweenCurve);
    }

    renderTabs() {
      this.tabs.textContent = '';
      guiList().forEach((e, i) => {
        const wrap = h('span', 'fe-tab-wrap');
        const b = h('button', 'fe-tab');
        b.type = 'button';
        b.appendChild(h('span', null, e.name));
        if (this.tabMarkOn(e)) {
          const mk = h('span', 'fe-between-mark');
          mk.appendChild(betweenCurvesSvg(12));
          b.appendChild(mk);
        }
        if (i < 9) b.title = t('tabKey', i + 1);
        b.classList.toggle('fe-on', e === this.cur);
        b.addEventListener('click', () => this.select(e));
        wrap.appendChild(b);
        this.tabs.appendChild(wrap);
      });
    }

    setMessage(text) {
      this.msg = text;
      clearTimeout(this.msgTimer);
      this.msgTimer = setTimeout(() => {
        this.msg = '';
        this.syncControls();
      }, 4000);
      this.syncControls();
    }

    syncControls() {
      const e = this.cur;
      const hasDraft = guiList().some((x) => x.hasDraft);
      const paused = transportState().on;
      this.applyLocale();
      if (e) {
        this.band.sync(e);
        this.controls.syncModes(e);
        this.miniName.textContent = e.name;
        const miniLoop = this.miniLoopIcon.querySelector('path');
        if (miniLoop) miniLoop.setAttribute('d', ICONS[e.loop ? 'loop' : 'altOff']);
        const miniAlt = this.miniAltIcon.querySelector('path');
        if (miniAlt) miniAlt.setAttribute('d', ICONS[alternateIcon(e.alternate)]);
      }
      this.controls.syncButtons({
        hasDraft, paused, canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0,
      });
      this.syncMiniDot(hasDraft);
      // The strip's own pause button: same icon and state as the one in the title bar, and the only way
      // to pause while minimized (keys do not, so its name has no key hints). Without pause
      // (no p5 frameCount) there is no button and no gap.
      const miniIcon = this.miniPause.querySelector('path');
      if (miniIcon) miniIcon.setAttribute('d', ICONS[paused ? 'play' : 'pause']);
      this.miniPause.classList.toggle('fe-on', paused);
      this.miniPause.title = t(paused ? 'resume' : 'pauseShort');
      this.miniPause.setAttribute('aria-label', this.miniPause.title);
      this.miniPause.hidden = !canPause();
      if (this.msg) {
        this.status.textContent = this.msg;
        this.status.title = this.msg;
        this.status.hidden = false;
      } else if (paused) {
        this.status.textContent = `f ${formatFrameNum(this.pausedLabelFrame())}`;
        this.status.title = '';
        this.status.hidden = false;
      } else {
        this.status.textContent = '';
        this.status.title = '';
        this.status.hidden = true;
      }
    }

    setPaused(on) {
      transportToggle(!!on);
      this.syncControls();
    }

    // The ring call's frame after delay and stagger, as last received.
    pausedLabelFrame() {
      const e = this.cur;
      if (!e) return 0;
      const ring = callsForEasing(e, this.calls || []).find((c) => c.kind === 'frame');
      return ring && ring.frame != null ? ring.frame : 0;
    }

    ringFrame(e) {
      const ring = callsForEasing(e, this.calls || [])[0];
      if (ring && ring.kind === 'frame' && ring.frame != null) return ring.frame;
      return this.frameNow(e);
    }

    // ---- Copy ---------------------------------------------------------------

    async save() {
      const block = blockText();
      const copied = await copyText(block);
      const left = leftOutNames();
      if (!copied) this.setMessage(t('copyFail'));
      else if (left.length) this.setMessage(t('copiedLeftOut', left.join(', ')));
      else this.setMessage(t('copied'));
    }

    // ---- Geometry shared by the graph and the band --------------------------

    frameNow(e) {
      if (e.lastFrame != null) return e.lastFrame;
      const ring = callsForEasing(e, this.calls || [])[0];
      if (ring && ring.kind === 'frame' && ring.frame != null) return ring.frame;
      return null;
    }

    lastWasCurve(e) {
      return e && e.lastCall === 'curve';
    }

    geom() {
      const pad = GRAPH_PAD;
      const x0 = pad;
      const x1 = Math.max(x0 + 1, this.gw - pad);
      const showTiming = this.showsFrameTiming(this.cur);
      // Under the graph, top to bottom: the delay row, the band, the info row.
      const rows = showTiming ? DELAY_ROW_H + DELAY_GAP + BAND_H + BAND_GAP + INFO_H : 0;
      const rowsTop = this.gh - pad - rows;
      const bandTop = showTiming ? rowsTop + DELAY_ROW_H + DELAY_GAP : rowsTop;
      const y0 = pad;
      const y1 = rowsTop - pad;
      const [lo, hi] = this.range;
      return {
        x0, x1, y0, y1, lo, hi,
        kx: x1 - x0,
        ky: (y1 - y0) / (hi - lo),
        rowsTop,
        bandTop,
        bandH: BAND_H,
        pad,
      };
    }

    inBand(my, g = this.geom()) {
      if (!this.showsFrameTiming(this.cur)) return false;
      return my >= g.rowsTop - 4;
    }

    bandLayout(e, g = this.geom()) {
      const L = bandLayoutOf(e, g.kx);
      const x0 = g.x0;
      return { ...L, x0, cx0: x0 + L.cx0, cx1: x0 + L.cx1 };
    }

    // ---- Each frame ---------------------------------------------------------

    draw() {
      // Harvest first: the log is emptied every frame even when there is nothing to draw on.
      this.calls = callLog.harvest();
      if (!this.cur || this.gw <= 0) return;
      this.syncTabMarks();
      this.updateFrameTimingVisibility(this.cur);
      if (this.rangeDirty && !this.drag) {
        this.graph.computeRange();
        this.rangeDirty = false;
      }
      this.graph.drawGraph();
      this.band.layoutBand();
    }

    drawMini() {
      const e = this.cur;
      if (!e) return;
      const L = bandLayoutOf(e, 72);
      // The log is stopped while minimized, so the strip follows the first call it remembers instead.
      // Until the sketch has drawn again, that is still the ring call from before minimizing.
      const ring = callLog.firstCall(e);
      let frame = this.ringFrame(e);
      if (ring) frame = ring.kind === 'frame' && ring.frame != null ? ring.frame : this.frameNow(e);
      const phase = phaseAt(frame, e);
      const setSeg = (el, [a, b], hot, kind) => {
        el.style.left = a + 'px';
        el.style.width = Math.max(0, b - a) + 'px';
        el.classList.toggle('fe-hot-move', hot && kind === 'move');
        el.classList.toggle('fe-hot-wait', hot && kind === 'wait');
      };
      // The same layout as the band. The delay is not drawn: its room left of duration stays empty.
      const seg = bandSegmentXs(L);
      const hot = miniHot(phase);
      setSeg(this.miniSegL, seg.left, hot.left, 'wait');
      setSeg(this.miniSegR, seg.right, hot.right, 'wait');
      setSeg(this.miniSegD, seg.dur, hot.dur, hot.durKind);
      // Before the first run the line waits at duration's left edge.
      this.miniPlay.style.left = (phase === 'before' ? seg.dur[0] : bandMarkX(frame, e, L)) + 'px';
      this.miniPlay.classList.toggle('fe-pause', transportState().on);
    }
  }

  // The four parts of the panel. Each one holds its own elements and state and reaches the shared
  // state (the selected easing, this frame's calls, the drag in progress, history) through `this.p`,
  // the panel. A part calls another part only through the few methods marked "For the other parts".

  // ---- Band: delay row, timing band, info row, zero dots, playhead and its scrub, marks, stagger slot ----

  class BandView {
    constructor(panel) {
      this.p = panel;
    }

    // ---- For the panel ------------------------------------------------------

    // `nodes` go into the graph right above the canvas; `readout` goes above the preset button.
    build() {
      this.playhead = h('div', 'fe-play');
      this.scrub = h('div', 'fe-scrub');
      this.scrub.append(h('i'));
      this.buildBand();
      this.stagger = h('div', 'fe-stagger');
      this.stagger.hidden = true;
      return {
        nodes: [
          this.playhead, this.scrub, this.startDelay.wrap, this.delayArrow, this.bandTrack, this.bandTicks,
          this.dots.delay, this.dots.loopDelay, this.info,
        ],
        readout: this.stagger,
      };
    }

    // Under the graph: the delay row, the band (left wait | duration | right wait) and the info row.
    buildBand() {
      // The delay waits once, before the first run. It is a row of its own above the band, so it
      // does not read as coming before the left wait.
      this.startDelay = { wrap: h('div', 'fe-delay-row'), input: numInput() };
      this.startDelay.label = h('span', 'fe-start-label', 'delay');
      this.startDelay.chip = h('div', 'fe-chip fe-chip-delay');
      this.startDelay.chip.append(this.startDelay.label, this.startDelay.input);
      this.startDelay.wrap.append(this.startDelay.chip);
      this.delayArrow = h('div', 'fe-delay-arrow');

      // loopDelay is changed on the right wait. The left one only shows the value: plain text, no
      // field, nothing to grab, and dim so that it does not read as a control. It lights up, number
      // included, together with the right one.
      this.delayL = { wrap: h('div', 'fe-seg fe-seg-left'), read: h('span', 'fe-wait-read') };
      this.delayL.wrap.append(this.delayL.read);
      this.delayR = { wrap: h('div', 'fe-seg fe-seg-right'), input: numInput() };
      this.delayR.chip = h('div', 'fe-chip fe-chip-delay');
      this.delayR.chip.append(this.delayR.input);
      this.delayR.wrap.append(this.delayR.chip);

      // A round trip splits duration into two rows, the way there on top and the way back below;
      // the waits keep the full height, and the number sits across both rows.
      this.dur = { wrap: h('div', 'fe-seg fe-dur'), input: numInput() };
      this.dur.go = h('div', 'fe-dur-row fe-dur-go');
      this.dur.back = h('div', 'fe-dur-row fe-dur-back');
      this.dur.chip = h('div', 'fe-chip fe-chip-dur');
      this.dur.arrows = h('div', 'fe-arrows');
      this.dur.arrowGo = h('span', 'fe-arrow fe-arrow-go', '→');
      this.dur.arrowBack = h('span', 'fe-arrow fe-arrow-back', '←');
      this.dur.arrows.append(this.dur.arrowGo, this.dur.arrowBack);
      this.dur.sep = h('i', 'fe-chip-sep');
      this.dur.staggerLabel = h('span', 'fe-stagger-label', t('staggerLabel'));
      this.dur.staggerInput = numInput();
      this.dur.staggerInput.classList.add('fe-stagger-input');
      this.dur.staggerRead = h('span', 'fe-stagger-read');
      this.dur.staggerSlot = h('span', 'fe-stagger-slot');
      this.dur.staggerSlot.append(
        this.dur.sep, this.dur.staggerLabel, this.dur.staggerInput, this.dur.staggerRead
      );
      this.dur.staggerSlot.hidden = true;
      this.dur.chip.append(this.dur.arrows, this.dur.input, this.dur.staggerSlot);
      this.dur.wrap.append(this.dur.go, this.dur.back, this.dur.chip);

      this.stopMark = h('span', 'fe-stop');
      this.bandTrack = h('div', 'fe-band');
      this.bandTrack.append(this.delayL.wrap, this.dur.wrap, this.delayR.wrap, this.stopMark);
      this.bandTicks = h('canvas', 'fe-band-ticks');
      this.bandTicks.hidden = true;

      // A value at 0 has no width to drag, so it gets a dot instead: the delay's at the band's left
      // end in the delay row, loopDelay's at the band's right end only (one value, one dot).
      const dot = (cls) => {
        const el = h('div', 'fe-dot ' + cls);
        el.input = numInput();
        el.append(el.input);
        return el;
      };
      this.dots = { delay: dot('fe-dot-delay'), loopDelay: dot('fe-dot-wait') };

      // Info row under the band, right-aligned: [loop icon] cycle in frames · in seconds @frame rate.
      this.info = h('div', 'fe-info');
      this.infoLoop = svgIcon('loop');
      this.infoLoop.setAttribute('class', 'fe-info-loop');
      this.infoCycle = h('span', 'fe-info-cycle');
      this.infoSecs = h('span', 'fe-info-secs');
      this.infoFps = h('span', 'fe-info-fps');
      this.info.append(this.infoLoop, this.infoCycle, this.infoSecs, this.infoFps);
    }

    applyLocale() {
      this.scrub.title = t('scrub');
      this.stopMark.title = t('stop');
      this.startDelay.wrap.title = t('startDelay');
      this.dur.wrap.title = t('durationTip');
      this.delayR.wrap.title = t('loopDelayTip');
      this.dots.delay.title = t('startDelay');
      this.dots.loopDelay.title = t('loopDelayTip');
    }

    // Every part with a number is one of the controls' number fields: drag sideways to change it,
    // click to type. The scrub handle is the band's own.
    bind() {
      const controls = this.p.controls;
      controls.bindScrub(this.dur.wrap, this.dur.input, 'duration', 1);
      controls.bindScrub(this.startDelay.wrap, this.startDelay.input, 'delay', 0);
      controls.bindScrub(this.delayR.wrap, this.delayR.input, 'loopDelay', 0);
      controls.bindScrub(this.dots.delay, this.dots.delay.input, 'delay', 0);
      // loopDelay's dot is on the band's right end: pulling it into the band, left, grows the value.
      controls.bindScrub(this.dots.loopDelay, this.dots.loopDelay.input, 'loopDelay', 0, true);
      controls.bindScrub(this.dur.staggerSlot, this.dur.staggerInput, 'stagger', 0);
      controls.bindNumTip(this.dur.wrap, this.dur.input);
      controls.bindNumTip(this.startDelay.wrap, this.startDelay.input, 'delay');
      controls.bindNumTip(this.delayR.wrap, this.delayR.input, 'loopDelay');
      controls.bindNumTip(this.dur.staggerSlot, this.dur.staggerInput);
      this.bindScrubHandle();
    }

    // The numbers follow the easing, except the one being typed in.
    sync(e) {
      for (const [s, v] of [
        [this.dur, e.duration],
        [this.startDelay, e.delay],
        [this.delayR, e.loopDelay],
        [this.dots.delay, e.delay],
        [this.dots.loopDelay, e.loopDelay],
      ]) {
        if (document.activeElement !== s.input) s.input.value = String(v);
      }
      this.delayL.read.textContent = formatFrameNum(e.loopDelay);
    }

    // Once per GUI frame while the scrub handle is held: keep the hold on target and refresh the numbers
    // when the held frame moved.
    scrubTick() {
      if (this.scrubbing) {
        this.reapplyScrub();
        if (this.scrubSynced !== transportState().frame) {
          this.scrubSynced = transportState().frame;
          this.p.syncControls();
        }
      }
    }

    layoutBand() {
      const e = this.p.cur;
      if (!e || this.p.gw <= 0) return;
      const showTiming = this.p.showsFrameTiming(e);
      this.bandTrack.hidden = !showTiming;
      this.info.hidden = !showTiming;
      this.p.controls.setModesShown(showTiming);
      if (!showTiming) {
        this.startDelay.wrap.hidden = true;
        for (const el of Object.values(this.dots)) el.hidden = true;
        this.playhead.hidden = true;
        this.scrub.hidden = true;
        return;
      }
      const g = this.p.geom();
      const L = this.p.bandLayout(e, g);
      const frame = this.p.ringFrame(e);
      const phase = phaseAt(frame, e);
      const curveMode = this.p.lastWasCurve(e);
      const waiting = !curveMode && isWaitingPhase(phase);

      this.layoutBandTrack(L, g);
      this.markBandHot(L, phase, curveMode, waiting);
      this.layoutDelayRow(L, g);
      this.layoutDots(L, g);
      this.p.controls.layoutCorners(g);
      this.updateOffsetReadout(e, g);
      this.layoutInfo(e, L, g);
      this.drawBandMarks(e, L, g);
      this.layoutPlayhead(e, L, g, frame, curveMode);
      // After the narrow classes above are set: a tip over a part follows what the part shows now.
      this.p.controls.refreshHoverTip();
    }

    // ---- For the other parts ------------------------------------------------

    // While scrubbing, the target frame; otherwise the frame the ring call last received.
    playheadFrame(e) {
      const snap = this.scrubStuck ? null : this.scrubFrame(e);
      return snap != null ? snap : this.p.ringFrame(e);
    }

    // Pixel centre shared by the graph line, the band line and the scrub triangle, so they line up.
    playheadX(e, L, frame) {
      return Math.round(L.x0 + bandMarkX(frame, e, L)) + 0.5;
    }

    // ---- Scrub handle -------------------------------------------------------

    bindScrubHandle() {
      const el = this.scrub;
      el.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0 || !this.p.cur) return;
        ev.preventDefault();
        ev.stopPropagation();
        const ring = callsForEasing(this.p.cur, this.p.calls || []).find((c) => c.kind === 'frame');
        const phase = phaseAt(ring ? ring.frame : this.p.frameNow(this.p.cur), this.p.cur);
        this.scrubPhase = phase === 'return' || phase === 'wait-left' ? 'return' : 'go';
        this.scrubbing = true;
        capture(el, ev);
        this.applyScrub(ev);
      });
      el.addEventListener('pointermove', (ev) => {
        if (!this.scrubbing) return;
        this.applyScrub(ev);
      });
      const end = () => {
        this.scrubbing = false;
        this.scrubPhase = null;
        this.scrubRaw = null;
        this.scrubSynced = null;
        this.p.syncControls();
      };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    }

    applyScrub(ev) {
      const e = this.p.cur;
      if (!e) return;
      const mx = ev.clientX - this.p.graph.left();
      const g = this.p.geom();
      const L = this.p.bandLayout(e, g);
      const ring = callsForEasing(e, this.p.calls || []).find((c) => c.kind === 'frame');
      const target = frameFromBandX(mx - L.x0, e, L, this.scrubPhase === 'return' ? 'return' : null);
      const index = ring && ring.hasIndex ? ring.index : 0;
      const stagger = (index || 0) * Math.max(0, +e.stagger || 0);
      const raw = Math.round(target + Math.max(0, +e.delay || 0) + stagger);
      if (raw !== this.scrubRaw) {
        this.scrubRaw = raw;
        this.scrubErr = null;
        this.scrubStuck = false;
      }
      this.reapplyScrub();
    }

    // Hold frameCount at the scrub target. Runs on each move and each GUI frame while dragging, so
    // calls slower than frameCount (`frameCount * 0.5`) settle. Each draw p5 makes with the new hold
    // is checked once; when the error stops shrinking (a `%` pass asked for a frame it never reaches)
    // it stops, so frameCount does not run away.
    reapplyScrub() {
      const e = this.p.cur;
      if (!e || this.scrubRaw == null) return;
      const ring = callsForEasing(e, this.p.calls || []).find((c) => c.kind === 'frame');
      const held = transportState();
      if (ring && ring !== this.scrubSeen && held.on && ring.live === held.frame && ring.rawFrame != null) {
        this.scrubSeen = ring;
        const err = Math.abs(this.scrubRaw - ring.rawFrame);
        if (err > 0 && this.scrubErr != null && err >= this.scrubErr) this.scrubStuck = true;
        this.scrubErr = err;
      }
      if (this.scrubStuck) return;
      transportScrubRing(this.scrubRaw, ring ? ring.rawFrame : null, ring ? ring.live : null);
    }

    // Ring frame the scrub is holding, snapped to whole frames, or null when not scrubbing.
    scrubFrame(e) {
      if (!this.scrubbing || this.scrubRaw == null) return null;
      const ring = callsForEasing(e, this.p.calls || []).find((c) => c.kind === 'frame');
      const index = ring && ring.hasIndex ? ring.index : 0;
      return this.scrubRaw - Math.max(0, +e.delay || 0) - (index || 0) * Math.max(0, +e.stagger || 0);
    }

    // ---- Layout -------------------------------------------------------------

    // Position the band and share its width: left wait | duration | right wait. The waits keep
    // loopDelay's width even when loop / alternate does not use them; an unused one is an empty
    // dashed frame, still showing and taking the value.
    layoutBandTrack(L, g) {
      const track = this.bandTrack;
      track.style.left = L.x0 + 'px';
      track.style.top = g.bandTop + 'px';
      track.style.width = g.kx + 'px';
      track.style.height = g.bandH + 'px';

      const seg = bandSegmentXs(L);
      const size = (wrap, [a, b]) => {
        wrap.style.flex = 'none';
        wrap.style.width = Math.max(0, b - a) + 'px';
      };
      // With a delay longer than loopDelay the left wait starts further in; nothing is drawn before it.
      track.style.paddingLeft = seg.left[0] + 'px';
      size(this.delayL.wrap, seg.left);
      size(this.dur.wrap, seg.dur);
      size(this.delayR.wrap, seg.right);
      // Narrow waits keep their width so duration stays on the graph's cx0 / cx1. Only their contents hide.
      const narrow = L.w * L.ppf < NARROW_DELAY_PX;
      // A wait the mode does not wait in is not drawn, and takes no width.
      for (const [part, frames] of [[this.delayL, L.left], [this.delayR, L.right]]) {
        part.wrap.style.display = frames > 0 ? 'flex' : 'none';
        part.wrap.classList.toggle('fe-narrow', narrow);
      }
      this.dur.wrap.classList.toggle('fe-round', L.round);
      // Like the delay label: drop the `stagger` text when the chip would not fit; the number stays.
      this.dur.wrap.classList.toggle('fe-compact', seg.dur[1] - seg.dur[0] < STAGGER_LABEL_MIN_PX);
    }

    // Light the part the playhead is in: duration while it moves, a wait while it waits there.
    markBandHot(L, phase, curveMode, waiting) {
      const moving = !curveMode && (phase === 'go' || phase === 'return');
      this.delayL.wrap.classList.toggle('fe-hot', !curveMode && phase === 'wait-left');
      this.delayR.wrap.classList.toggle('fe-hot', !curveMode && phase === 'wait-right');
      // One way, duration lights as a whole; on a round trip only the row the playhead is in.
      this.dur.wrap.classList.toggle('fe-hot', moving && !L.round);
      this.dur.go.classList.toggle('fe-hot', moving && L.round && phase === 'go');
      this.dur.back.classList.toggle('fe-hot', moving && L.round && phase === 'return');
      // The left wait cannot be pointed at: it lights with the right one, while the pointer is on the
      // right wait (or on loopDelay's dot) and while either is being dragged.
      const d = this.p.drag;
      const right = [this.delayR.wrap, this.dots.loopDelay];
      const lit = right.some((el) => el.matches(':hover')) || (!!d && d.type === 'scrub' && right.includes(d.wrap));
      this.delayL.wrap.classList.toggle('fe-lit', lit);
      this.delayR.wrap.classList.toggle('fe-lit', lit);
      this.dur.wrap.classList.toggle('fe-waiting', waiting);
      this.dur.arrowGo.classList.toggle('fe-live', !L.round || phase !== 'return');
      this.dur.arrowBack.classList.toggle('fe-live', phase !== 'go');
    }

    // The delay row: from the band's left end, as wide as the delay at the band's scale. Too narrow for its number, it hides it like a narrow wait; at 0 there is a dot instead.
    layoutDelayRow(L, g) {
      const wrap = this.startDelay.wrap;
      const [a, b] = bandSegmentXs(L).start;
      const width = b - a;
      wrap.hidden = !(L.start > 0);
      wrap.style.left = (L.x0 + a) + 'px';
      wrap.style.width = width + 'px';
      wrap.style.top = g.rowsTop + 'px';
      wrap.classList.toggle('fe-narrow', width < NARROW_DELAY_PX);
      // Label and number share the row; drop the label when both would not fit.
      wrap.classList.toggle('fe-compact', width < 64);
      // The row ends before duration only when the left wait is longer than the delay. The arrow
      // says that the first run starts right after the delay, not after that wait.
      const gap = L.cx0 - (L.x0 + b);
      const arrow = this.delayArrow;
      arrow.hidden = !(L.start > 0 && gap >= DELAY_ARROW_MIN_PX);
      arrow.style.left = (L.x0 + b + DELAY_ARROW_INSET) + 'px';
      arrow.style.width = Math.max(0, gap - 2 * DELAY_ARROW_INSET) + 'px';
      arrow.style.top = (g.rowsTop + DELAY_ROW_H / 2) + 'px';
    }

    // Zero dots, half outside what they belong to: the delay's on the band's left end at the delay
    // row's height, loopDelay's on the band's right end at the band's height.
    layoutDots(L, g) {
      const delay = this.dots.delay;
      delay.hidden = L.start > 0;
      delay.style.left = (L.x0 - DOT_HIT / 2) + 'px';
      delay.style.top = (g.rowsTop + DELAY_ROW_H / 2 - DOT_HIT / 2) + 'px';
      const wait = this.dots.loopDelay;
      // Only while the right wait exists: one way without loop, loopDelay is not used and shows nowhere.
      wait.hidden = L.w > 0 || !L.useR;
      wait.style.left = (L.x0 + g.kx - DOT_HIT / 2) + 'px';
      wait.style.top = (g.bandTop + g.bandH / 2 - DOT_HIT / 2) + 'px';
    }

    // Width of one character of the info row (it is monospace), measured once.
    infoCharWidth() {
      if (!this.infoChar) {
        const probe = h('span', null, '0000000000');
        probe.style.cssText = 'position:absolute;visibility:hidden';
        this.info.appendChild(probe);
        this.infoChar = probe.getBoundingClientRect().width / 10 || 6;
        probe.remove();
      }
      return this.infoChar;
    }

    // Info row under the band, and the stop mark when the animation does not loop.
    layoutInfo(e, L, g) {
      const labels = bandDimensionLabels(e);
      const fit = infoLabelFit(labels, g.kx, this.infoCharWidth());
      this.infoLoop.toggleAttribute('hidden', !fit.icon);
      this.infoCycle.textContent = labels.cycle;
      this.infoSecs.textContent = INFO_SEP + labels.seconds;
      this.infoSecs.hidden = !fit.seconds;
      this.infoFps.textContent = ' @' + labels.fps;
      this.info.style.left = L.x0 + 'px';
      this.info.style.width = g.kx + 'px';
      this.info.style.top = (g.bandTop + g.bandH + BAND_GAP) + 'px';

      this.stopMark.hidden = e.loop;
      const stopX = L.round ? L.cx0 : L.cx1;
      this.stopMark.style.left = (stopX - L.x0 - 4) + 'px';
    }

    // Reference keeps the DOM playhead; marks are for other calls only.
    layoutPlayhead(e, L, g, frame, curveMode) {
      if (curveMode) {
        this.playhead.hidden = true;
        this.scrub.hidden = true;
        return;
      }
      const head = this.playheadFrame(e);
      const paused = transportState().on;
      this.playhead.hidden = false;
      this.scrub.hidden = !canPause();
      const nx = this.playheadX(e, L, head == null ? frame : head);
      // One line from the top of the delay row to the bottom of the band.
      const bottom = g.bandTop + g.bandH;
      this.playhead.style.left = nx + 'px';
      this.playhead.style.top = g.rowsTop + 'px';
      this.playhead.style.height = (bottom - g.rowsTop) + 'px';
      // The delay row is opaque, so the line goes over it instead of under.
      this.playhead.classList.toggle('fe-lead', phaseAt(head == null ? frame : head, e) === 'before');
      this.playhead.classList.toggle('fe-pause', paused);
      // The triangle rests on the top of the band, next to the frame ticks. While paused the whole
      // line is a grab area; while playing only the strip above the triangle, as high as the delay row.
      const base = g.bandTop - 1;
      const grabTop = paused ? g.y0 : g.rowsTop;
      const grabBottom = paused ? bottom : base;
      this.scrub.style.left = nx + 'px';
      this.scrub.style.top = grabTop + 'px';
      this.scrub.style.height = (grabBottom - grabTop) + 'px';
      this.scrub.firstChild.style.top = (base - grabTop - SCRUB_TRI_H - 1) + 'px';
      this.scrub.classList.toggle('fe-pause', paused);
    }

    // ---- Marks and the stagger slot -----------------------------------------

    // Offset marks for non-reference calls. Waiting marks park at duration edges (C).
    drawBandMarks(e, L, g) {
      const canvas = this.bandTicks;
      const w = g.kx;
      const h = g.bandH;
      canvas.style.left = L.x0 + 'px';
      canvas.style.top = g.bandTop + 'px';
      // Sketches often size every canvas with `canvas { width: … !important }`; ours must win.
      canvas.style.setProperty('width', w + 'px', 'important');
      canvas.style.setProperty('height', h + 'px', 'important');
      const mine = callsForEasing(e, this.p.calls || []);
      const ring = mine[0] || null;
      const others = mine.filter((c) => c.kind === 'frame' && c !== ring);
      const same = allSameFrame(mine.filter((c) => c.kind === 'frame' && c.frame != null));
      const marks = others.length >= 1 && !same;
      const ticks = transportState().on && !this.p.lastWasCurve(e) && L.ppf >= FRAME_TICK_MIN_PX;
      const visible = (marks || ticks) && w > 0 && h > 0;
      canvas.hidden = !visible;
      const cw = visible ? w : Math.max(1, w);
      const ch = visible ? h : Math.max(1, h);
      const dpr = sizeCanvas(canvas, cw, ch);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      if (!visible) return;

      if (ticks) this.paintFrameTicks(ctx, L, h);
      if (!marks) return;
      const placed = others.map((c) => ({ c, x: bandMarkX(c.frame, e, L) }));
      this.paintMarkGroups(ctx, clusterMarks(placed, Math.max(2, w * 0.012)), others.length, h);
    }

    // One tick per frame while paused, so the snapping playhead has steps to land on.
    // Only over duration: the waits around it hold one value, so there is nothing to step through.
    paintFrameTicks(ctx, L, h) {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = COL_PAUSE;
      const th = Math.max(3, h * 0.2);
      const x0 = L.lead * L.ppf;
      for (let i = 0; i <= L.d; i++) ctx.fillRect(Math.round(x0 + i * L.ppf) - 0.5, 0, 1, th);
      ctx.globalAlpha = 1;
    }

    // One short bar per cluster; a cluster of overlapping marks is drawn taller and bolder.
    paintMarkGroups(ctx, groups, total, h) {
      const alpha = clamp(8 / Math.max(2, total), 0.4, 0.9);
      for (const g0 of groups) {
        const n = g0.items.length;
        const tw = n > 1 ? 3 : 1.5;
        const th = Math.min(h * 0.42 + (n - 1) * (h * 0.12), h * 0.9);
        ctx.globalAlpha = n > 1 ? Math.max(alpha, 0.75) : alpha;
        ctx.fillStyle = COL_MOVE_DOT;
        ctx.fillRect(g0.x - tw / 2, 0, tw, th);
      }
      ctx.globalAlpha = 1;
    }

    // Offset number in the duration chip + diagnostic line (irregular span).
    updateOffsetReadout(e, g) {
      const info = offsetReadoutInfo(e, this.p.calls || []);
      const { useIndex, step, showSlot, lines, warnLine } = info;

      this.dur.staggerSlot.hidden = !showSlot;
      if (showSlot) {
        this.dur.sep.hidden = false;
        this.dur.staggerLabel.hidden = false;
        this.dur.staggerInput.hidden = !useIndex;
        this.dur.staggerRead.hidden = useIndex;
        this.dur.staggerInput.readOnly = !useIndex;
        this.dur.staggerInput.tabIndex = useIndex ? 0 : -1;
        const text = String(formatFrameNum(step == null ? 0 : step));
        if (useIndex) {
          if (document.activeElement !== this.dur.staggerInput) this.dur.staggerInput.value = text;
        } else {
          this.dur.staggerRead.textContent = text;
        }
        this.dur.staggerSlot.style.pointerEvents = useIndex ? 'auto' : 'none';
      }

      if (lines.length) {
        this.stagger.hidden = false;
        this.stagger.textContent = lines.join('\n');
        this.stagger.classList.toggle('fe-warn', !!warnLine);
        this.stagger.style.left = g.pad + 'px';
        this.stagger.style.top = (g.pad + 30) + 'px';
      } else {
        this.stagger.hidden = true;
        this.stagger.textContent = '';
        this.stagger.classList.remove('fe-warn');
      }
    }
  }

  // ---- Graph: drawing the curve, and editing its points and handles ---------

  class GraphView {
    constructor(panel) {
      this.p = panel;
    }

    // ---- For the panel ------------------------------------------------------

    build() {
      this.canvas = h('canvas', 'fe-graph-canvas');
      return this.canvas;
    }

    bindGraph() {
      const c = this.canvas;
      c.addEventListener('pointerdown', (ev) => this.graphPointerDown(ev));
      c.addEventListener('pointermove', (ev) => this.graphPointerMove(ev));
      const end = () => {
        const d = this.p.drag;
        if (!d) return;
        this.p.drag = null;
        const target = d.owner || this.p.cur;
        if (d.before && this.p.record(target, d.before)) this.p.changed(target);
        this.p.rangeDirty = true;
      };
      c.addEventListener('pointerup', end);
      c.addEventListener('pointercancel', end);
      c.addEventListener('dblclick', (ev) => this.graphDoubleClick(ev));
      c.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        const e = this.p.cur;
        if (!e) return;
        const [mx, my] = this.localPos(ev, c);
        if (this.p.inBand(my)) return;
        const hit = this.hitPoint(mx, my);
        if (!hit) return;
        this.p.active = hit.which;
        const curve = this.p.curveOf(e, hit.which);
        if (hit.which === 1) e.markBetweenManual();
        if (hit.index > 0 && hit.index < curve.points.length - 1) this.deletePoint(hit.index);
      });
    }

    computeRange() {
      const e = this.p.cur;
      // Less room below than above: the band sits right under the graph.
      const below = 0.625;
      let lo = -0.12;
      let hi = 1.2;
      const mirror = e && alternateMode(e.alternate) === 'mirror';
      const endY = e ? e.endY : 1;
      const consider = (curve, ey) => {
        const take = (y, pad) => {
          lo = Math.min(lo, y - pad * below);
          hi = Math.max(hi, y + pad);
          if (mirror) {
            lo = Math.min(lo, ey - y - pad * below);
            hi = Math.max(hi, ey - y + pad);
          }
        };
        for (const p of curve.points) take(p.y, 0.2);
        for (let i = 0; i <= 200; i++) take(curve.value(i / 200), 0.08);
      };
      if (e) {
        consider(e.curve, endY);
        if (betweenInCalls(e, this.p.calls || []) && e.betweenCurve) consider(e.betweenCurve, e.betweenEndY);
        for (const c of this.p.calls || []) {
          if (c.owner === e && c.betweenSlot) consider(c.betweenSlot, c.betweenSlot.endY);
        }
      }
      this.p.range = [lo, hi];
    }

    drawGraph() {
      const e = this.p.cur;
      if (this.p.panelShowsBetween(e)) e.ensureBetweenCurve();
      const c = this.canvas;
      const dpr = sizeCanvas(c, this.p.gw, this.p.gh);
      const ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.p.gw, this.p.gh);
      const g = this.p.geom();
      const L = this.p.bandLayout(e, g);
      const frame = this.p.frameNow(e);
      const phase = phaseAt(frame, e);
      const curveMode = this.p.lastWasCurve(e);
      const waiting = !curveMode && isWaitingPhase(phase);
      const mine = callsForEasing(e, this.p.calls || []);
      const ring = mine[0] || null;
      const sc = {
        ctx, e, g, L, frame, phase, curveMode, waiting, mine, ring,
        curve: this.p.activeCurve(e),
        mode: L.mode,
        progress: progressAt(frame, e),
      };

      this.drawGuides(sc);
      this.drawGraphPlayhead(sc);
      this.drawBetweens(ctx, e, L, g);
      this.drawCurves(sc);
      const ringTone = this.drawFrameStripe(sc);
      this.drawPeaks(sc);
      this.drawHandles(sc);
      this.drawPoints(sc);
      this.drawCallDots(sc);
      this.drawRing(sc, ringTone);
    }

    // ---- For the other parts ------------------------------------------------

    // Client x of the graph's left edge. Band positions are measured from it.
    left() {
      return this.canvas.getBoundingClientRect().left;
    }

    clampX(points, i, x) {
      return clamp(x, points[i - 1].x + MIN_GAP, points[i + 1].x - MIN_GAP);
    }

    deletePoint(i) {
      const e = this.p.cur;
      if (!e) return;
      const before = e.snapshot();
      if (!deletePointAt(e, i)) return;
      this.p.sel = -1;
      if (this.p.record(e, before)) this.p.changed(e);
    }

    // ---- Geometry and hit tests ---------------------------------------------

    toY(y, g = this.p.geom()) {
      return g.y1 - (y - g.lo) * g.ky;
    }

    pointXY(p, L, g = this.p.geom()) {
      return [L.cx0 + p.x * L.cw, this.toY(p.y, g)];
    }

    frameValue(e, frame) {
      const curve = this.p.activeCurve(e);
      const endY = curve === e.betweenCurve ? e.betweenEndY : e.endY;
      return valueAt(curve, endY, frame, e);
    }

    localPos(ev, canvas) {
      const r = canvas.getBoundingClientRect();
      return [ev.clientX - r.left, ev.clientY - r.top];
    }

    // Nearest point on curve 0 or 1. Overlaps prefer the white curve.
    // A second click on that same point swaps to the other curve.
    hitPoint(mx, my) {
      const e = this.p.cur;
      if (!e) return null;
      const g = this.p.geom();
      const L = this.p.bandLayout(e, g);
      const hits = [];
      const consider = (curve, which) => {
        if (!curve) return;
        curve.points.forEach((p, i) => {
          const [sx, sy] = this.pointXY(p, L, g);
          const d = (sx - mx) ** 2 + (sy - my) ** 2;
          if (d <= 64) hits.push({ which, index: i, d });
        });
      };
      consider(e.curve, 0);
      if (this.p.panelShowsBetween(e) && e.betweenCurve) consider(e.betweenCurve, 1);
      if (!hits.length) return null;
      const closest = (which) => {
        let best = null;
        for (const h of hits) {
          if (h.which !== which) continue;
          if (!best || h.d < best.d) best = h;
        }
        return best;
      };
      const has0 = hits.some((h) => h.which === 0);
      const has1 = hits.some((h) => h.which === 1);
      const white = this.p.activeWhich(e);
      let best = has0 && has1 ? closest(white) : null;
      if (!best) {
        best = hits[0];
        for (const h of hits) if (h.d < best.d) best = h;
      }
      if (has0 && has1 && this.p.sel === best.index && white === best.which) {
        const other = closest(best.which === 0 ? 1 : 0);
        if (other) return other;
      }
      return best;
    }

    handlePositions(g = this.p.geom()) {
      const e = this.p.cur;
      const out = [];
      if (!e) return out;
      const curve = this.p.activeCurve(e);
      const pts = curve.points;
      const i = this.p.sel;
      if (i < 0 || i >= pts.length) return out;
      const p = pts[i];
      const s = curve.slopes[i];
      const L = this.p.bandLayout(e, g);
      const [px, py] = this.pointXY(p, L, g);
      const go = L.cw;
      const sides = [];
      if (i > 0) sides.push(['in', -1, s.in]);
      if (i < pts.length - 1) sides.push(['out', 1, s.out]);
      for (const [side, sign, m] of sides) {
        const vx = sign * go;
        const vy = -sign * m * g.ky;
        const len = Math.hypot(vx, vy) || 1;
        out.push({ i, side, px, py, x: px + (vx / len) * 48, y: py + (vy / len) * 48 });
      }
      return out;
    }

    hitHandle(mx, my) {
      for (const hd of this.handlePositions()) {
        if ((hd.x - mx) ** 2 + (hd.y - my) ** 2 <= 8 * 8) return hd;
      }
      return null;
    }

    addPoint(index, x, y, which) {
      const e = this.p.cur;
      if (!e) return;
      const before = e.snapshot();
      if (!insertPoint(e, index, x, y, which)) return;
      this.p.sel = index;
      if (this.p.record(e, before)) this.p.changed(e);
      else this.p.changed(e);
    }

    // ---- Pointer ------------------------------------------------------------

    // Start a handle or point drag depending on what is under the pointer.
    graphPointerDown(ev) {
      const c = this.canvas;
      if (ev.button !== 0 || !this.p.cur) return;
      const [mx, my] = this.localPos(ev, c);
      const g = this.p.geom();
      // The band and the delay row have their own handles; the canvas around them does nothing.
      if (this.p.inBand(my, g)) return;
      const hd = this.hitHandle(mx, my);
      if (hd) {
        if (this.p.activeWhich() === 1) this.p.cur.markBetweenManual();
        this.p.drag = {
          type: 'handle', i: hd.i, which: this.p.activeWhich(), side: hd.side, before: this.p.cur.snapshot(),
        };
      } else {
        const hit = this.hitPoint(mx, my);
        if (!hit) {
          this.p.sel = -1;
          return;
        }
        if (hit.which === 1) this.p.cur.markBetweenManual();
        this.p.active = hit.which;
        this.p.sel = hit.index;
        const curve = this.p.curveOf(this.p.cur, hit.which);
        const p = curve.points[hit.index];
        const isStart = hit.index === 0;
        const isEnd = hit.index === curve.points.length - 1;
        if (isStart) this.p.drag = null;
        else {
          this.p.drag = {
            type: 'point', i: hit.index, which: hit.which, before: this.p.cur.snapshot(), mx, my,
            ox: p.x, oy: p.y, endOnly: isEnd,
          };
        }
      }
      if (this.p.drag) capture(c, ev);
    }

    graphPointerMove(ev) {
      const [mx, my] = this.localPos(ev, this.canvas);
      const d = this.p.drag;
      if (!d || (d.type !== 'point' && d.type !== 'handle')) {
        this.graphHover(mx, my);
        return;
      }
      this.dragPointOrHandle(ev, d, mx, my);
    }

    // Cursor and tooltip while no point or handle is being dragged.
    graphHover(mx, my) {
      const c = this.canvas;
      const g = this.p.geom();
      if (this.p.inBand(my, g)) {
        c.style.cursor = 'default';
        this.p.controls.hideTip('stripe');
      } else if (mx >= g.pad && mx <= g.pad + STRIPE_W && my >= g.y0 && my <= g.y1) {
        c.style.cursor = 'help';
        this.p.controls.showStripeTip(Math.max(g.y0, my - 8));
      } else {
        c.style.cursor = this.hitHandle(mx, my) || this.hitPoint(mx, my) ? 'pointer' : 'crosshair';
        this.p.controls.hideTip('stripe');
      }
    }

    // Move a control point (Shift locks the axis) or reshape a tangent handle (Alt: one side only).
    dragPointOrHandle(ev, d, mx, my) {
      const e = this.p.cur;
      const curve = this.p.curveOf(e, d.which);
      const pts = curve.points;
      const g = this.p.geom();
      const L = this.p.bandLayout(e, g);
      const go = L.cw;
      const p = pts[d.i];
      if (d.type === 'point') {
        let dx = mx - d.mx;
        let dy = my - d.my;
        if (ev.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        if (d.endOnly) {
          p.x = 1;
          p.y = round3(snapEndY(d.oy - dy / g.ky));
        } else {
          p.x = this.clampX(pts, d.i, round3(d.ox + dx / go));
          p.y = round3(d.oy - dy / g.ky);
        }
      } else {
        const [px, py] = this.pointXY(p, L, g);
        let dxs = mx - px;
        const dys = py - my;
        dxs = d.side === 'out' ? Math.max(dxs, 1) : Math.min(dxs, -1);
        const m = round3(clamp((dys / g.ky) / (dxs / go), -MAX_SLOPE, MAX_SLOPE));
        if (p.mode !== 'manual') {
          const s = curve.slopes[d.i];
          p.mode = 'manual';
          p.in = round3(s.in);
          p.out = round3(s.out);
        }
        if (ev.altKey) p[d.side] = m;
        else p.in = p.out = m;
      }
      this.p.liveChanged(e);
    }

    // Double click: reset a handle to auto, or add a point on the curve.
    graphDoubleClick(ev) {
      const e = this.p.cur;
      if (!e) return;
      const [mx, my] = this.localPos(ev, this.canvas);
      if (this.p.inBand(my)) return;
      const hd = this.hitHandle(mx, my);
      if (hd) {
        this.p.edit((x) => {
          const p = this.p.activeCurve(x).points[hd.i];
          p.mode = 'auto';
          p.in = p.out = 0;
        });
        return;
      }
      if (this.hitPoint(mx, my)) return;
      const g = this.p.geom();
      const L = this.p.bandLayout(e, g);
      const go = L.cw;
      if (!(go > 0) || mx < L.cx0 || mx > L.cx0 + go) return;
      const x = round3(clamp((mx - L.cx0) / go, MIN_GAP, 1 - MIN_GAP));
      const y = round3(g.lo + (g.y1 - my) / g.ky);
      const which = this.p.activeWhich(e);
      const pts = this.p.curveOf(e, which).points;
      const at = pts.findIndex((p) => p.x > x);
      if (at <= 0) return;
      if (x - pts[at - 1].x < MIN_GAP || pts[at].x - x < MIN_GAP) return;
      this.addPoint(at, x, y, which);
    }

    // ---- Drawing ------------------------------------------------------------

    // Playhead on the graph only (band segment stays on the DOM line above the band).
    drawGraphPlayhead(sc) {
      const { ctx, g, e, L, frame, curveMode } = sc;
      if (curveMode) return;
      const head = this.p.band.playheadFrame(e);
      const px = this.p.band.playheadX(e, L, head == null ? frame : head);
      const paused = transportState().on;
      ctx.save();
      ctx.strokeStyle = paused ? COL_PAUSE : COL_MOVE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, g.y0);
      ctx.lineTo(px, g.rowsTop);
      ctx.stroke();
      ctx.restore();
    }

    // Guides: 0/1 solid, quarter lines dotted, all inside the 0..1 box over the duration width.
    drawGuides({ ctx, g, L }) {
      ctx.save();
      const yTop = Math.round(Math.min(this.toY(0, g), this.toY(1, g))) + 0.5;
      const yBot = Math.round(Math.max(this.toY(0, g), this.toY(1, g))) + 0.5;
      ctx.lineWidth = 1;
      ctx.setLineDash([1, 3]);
      ctx.strokeStyle = C.guideQuarter;
      for (const q of [0.25, 0.5, 0.75]) {
        const sy = Math.round(this.toY(q, g)) + 0.5;
        const sx = Math.round(L.cx0 + q * L.cw) + 0.5;
        ctx.beginPath();
        ctx.moveTo(L.cx0, sy);
        ctx.lineTo(L.cx1, sy);
        ctx.moveTo(sx, yTop);
        ctx.lineTo(sx, yBot);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.strokeStyle = C.guideBase;
      for (const y of [0, 1]) {
        const sy = Math.round(this.toY(y, g)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(L.cx0, sy);
        ctx.lineTo(L.cx1, sy);
        ctx.stroke();
      }
      // Duration's edges, where the waits begin: from the 0..1 box down to the band, not the full graph height.
      ctx.strokeStyle = C.guideEdge;
      for (const [sx, wait] of [[L.cx0, L.left], [L.cx1, L.right]]) {
        if (wait <= 0) continue;
        const px = Math.round(sx) + 0.5;
        ctx.beginPath();
        ctx.moveTo(px, yTop);
        ctx.lineTo(px, g.bandTop);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Curve 0 and curve 1. The last-touched curve is white; the other is grey.
    drawCurves(sc) {
      const { e } = sc;
      const active = this.p.activeWhich(e);
      const show1 = this.p.panelShowsBetween(e) && e.betweenCurve;
      if (show1 && active !== 0) this.strokeLayerCurve(sc, e.curve, e.endY, false);
      if (show1 && active !== 1) this.strokeLayerCurve(sc, e.betweenCurve, e.betweenEndY, false);
      const curve = active === 1 && show1 ? e.betweenCurve : e.curve;
      const endY = curve === e.betweenCurve ? e.betweenEndY : e.endY;
      this.strokeLayerCurve(sc, curve, endY, true);
    }

    strokeLayerCurve(sc, curve, endY, hot) {
      const { ctx, g, L, phase, mode, progress, waiting } = sc;
      const steps = Math.max(64, Math.ceil(L.cw || 1));
      const strokeRange = (yAt, a, b, width, color, dash) => {
        if (!(b > a)) return;
        ctx.beginPath();
        const n = Math.max(2, Math.ceil(steps * (b - a)));
        for (let i = 0; i <= n; i++) {
          const s = a + ((b - a) * i) / n;
          const sx = L.cx0 + s * L.cw;
          const sy = this.toY(yAt(s), g);
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        }
        ctx.save();
        ctx.setLineDash(dash || []);
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.restore();
      };
      const mainY = (s) => curve.value(s);
      const mirY = (s) => endY - curve.value(1 - s);
      const upcoming = hot ? C.curveAhead : C.otherAhead;
      const mirBase = hot ? C.curveMirror : C.otherMirror;
      const vt = visualT(phase, progress, mode);
      let gone0 = 0;
      let gone1 = 0;
      let mir0 = 0;
      let mir1 = 0;
      if (hot && !waiting) {
        if (phase === 'go') gone1 = vt;
        else if (phase === 'return') {
          if (mode === 'mirror') {
            mir0 = vt;
            mir1 = 1;
          } else {
            gone0 = vt;
            gone1 = 1;
          }
        }
      }
      strokeRange(mainY, 0, 1, 1.5, upcoming);
      if (hot) strokeRange(mainY, gone0, gone1, 2, C.hot);
      if (mode === 'mirror') {
        strokeRange(mirY, 0, 1, 1, mirBase, [3, 3]);
        if (hot) strokeRange(mirY, mir0, mir1, 2, C.hot, [3, 3]);
      }
    }

    // Value of the ring call (or of the current frame when nothing was recorded).
    ringValue({ e, frame, curveMode, ring, curve }) {
      if (ring) return ring.value;
      return curveMode ? curve.value(e.lastCurveT) : this.frameValue(e, frame);
    }

    // Left stripe of per-frame values plus the current-value tick. Returns the ring tone.
    drawFrameStripe(sc) {
      const { ctx, e, g, mode, ring, curveMode } = sc;
      const n = Math.floor(mode === false ? e.duration + e.loopDelay : 2 * (e.duration + e.loopDelay));
      if (n >= 1 && n <= 2000) {
        ctx.beginPath();
        for (let i = 0; i <= n; i++) {
          const sy = Math.round(this.toY(this.frameValue(e, i), g)) + 0.5;
          ctx.moveTo(g.pad, sy);
          ctx.lineTo(g.pad + STRIPE_W, sy);
        }
        ctx.strokeStyle = C.stripe;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      const ringCurve = ring ? ring.kind === 'curve' : curveMode;
      const paused = transportState().on && !ringCurve;
      const ringTone = ringCurve ? C.hot : paused ? COL_PAUSE : COL_MOVE;
      if (!ringCurve) {
        const ty = Math.round(this.toY(this.ringValue(sc), g)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(g.pad, ty);
        ctx.lineTo(g.pad + STRIPE_TICK_W, ty);
        ctx.strokeStyle = ringTone;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      return ringTone;
    }

    // Diamonds at the speed peaks.
    drawPeaks({ ctx, g, L, curve }) {
      for (const x of curve.peaks) {
        const sx = L.cx0 + x * L.cw;
        const sy = this.toY(curve.value(x), g);
        ctx.beginPath();
        ctx.moveTo(sx, sy - 4.5);
        ctx.lineTo(sx + 3.5, sy);
        ctx.lineTo(sx, sy + 4.5);
        ctx.lineTo(sx - 3.5, sy);
        ctx.closePath();
        ctx.fillStyle = C.peak;
        ctx.fill();
      }
    }

    drawHandles({ ctx, g, curve }) {
      const pts = curve.points;
      for (const hd of this.handlePositions(g)) {
        ctx.beginPath();
        ctx.moveTo(hd.px, hd.py);
        ctx.lineTo(hd.x, hd.y);
        ctx.strokeStyle = C.handleLine;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(hd.x, hd.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = pts[hd.i].mode === 'manual' ? C.hot : GRAPH_BG;
        ctx.fill();
        ctx.strokeStyle = C.hot;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    drawPoints({ ctx, e, g, L }) {
      const active = this.p.activeWhich(e);
      const show1 = this.p.panelShowsBetween(e) && e.betweenCurve;
      if (show1 && this.p.sel >= 0) {
        const other = this.p.curveOf(e, active === 0 ? 1 : 0);
        const p = other && other.points[this.p.sel];
        if (p) {
          const [sx, sy] = this.pointXY(p, L, g);
          ctx.beginPath();
          ctx.arc(sx, sy, 8, 0, Math.PI * 2);
          ctx.strokeStyle = C.pointHalo;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
      const paint = (curve, which) => {
        if (!curve) return;
        const hot = which === active;
        const hollow = which === 1;
        const tone = hot ? C.hot : C.pointOther;
        curve.points.forEach((p, i) => {
          const [sx, sy] = this.pointXY(p, L, g);
          const end = i === 0 || i === curve.points.length - 1;
          ctx.beginPath();
          if (end) ctx.rect(sx - 4, sy - 4, 8, 8);
          else ctx.arc(sx, sy, 5, 0, Math.PI * 2);
          ctx.fillStyle = hollow ? GRAPH_BG : tone;
          ctx.fill();
          ctx.strokeStyle = tone;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        });
      };
      if (show1 && active !== 0) paint(e.curve, 0);
      if (show1 && active !== 1) paint(e.betweenCurve, 1);
      paint(this.p.curveOf(e, active), active);
    }

    // Screen position of a recorded call on the curve.
    callXY(c, { e, L, g }) {
      const sx = c.kind === 'curve'
        ? L.cx0 + c.t * L.cw
        : L.x0 + bandMarkX(c.frame, e, L);
      return [sx, this.toY(c.value, g)];
    }

    // Multi-call dots (everything except the ring call).
    drawCallDots(sc) {
      const { ctx, mine } = sc;
      if (mine.length < 2) return;
      const alpha = clamp(8 / mine.length, 0.4, 0.9);
      for (let i = 1; i < mine.length; i++) {
        const c = mine[i];
        const [dx, dy] = this.callXY(c, sc);
        ctx.beginPath();
        ctx.arc(dx, dy, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = GRAPH_BG;
        ctx.fill();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = c.waiting ? COL_WAIT : COL_MOVE_DOT;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // The ring at the current position of the reference call.
    drawRing(sc, ringTone) {
      const { ctx, e, g, L, phase, mode, progress, curveMode, ring } = sc;
      const [nx, ny] = ring
        ? this.callXY(ring, sc)
        : [
          curveMode ? L.cx0 + e.lastCurveT * L.cw : L.cx0 + visualT(phase, progress, mode) * L.cw,
          this.toY(this.ringValue(sc), g),
        ];
      ctx.beginPath();
      ctx.arc(nx, ny, 7, 0, Math.PI * 2);
      ctx.fillStyle = GRAPH_BG;
      ctx.fill();
      ctx.strokeStyle = ringTone;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(nx, ny, 2, 0, Math.PI * 2);
      ctx.fillStyle = C.hot;
      ctx.fill();
    }

    drawBetweens(ctx, e, L, g) {
      const slots = [];
      const seen = new Set();
      for (const c of this.p.calls || []) {
        if (c.owner !== e || !c.betweenSlot || !(c.betweenSlot.u > 0 && c.betweenSlot.u < 1)) continue;
        const key = String(c.betweenSlot.u);
        if (seen.has(key)) continue;
        seen.add(key);
        slots.push(c.betweenSlot);
      }
      if (!slots.length) return;
      const steps = Math.max(64, Math.ceil(L.cw || 1));
      const ink = C.betweenCall;
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineWidth = 1;
      for (const slot of slots) {
        const strokeSlot = (yAt, dash) => {
          ctx.beginPath();
          ctx.setLineDash(dash);
          ctx.strokeStyle = ink;
          for (let i = 0; i <= steps; i++) {
            const s = i / steps;
            const sx = L.cx0 + s * L.cw;
            const sy = this.toY(yAt(s), g);
            if (i === 0) ctx.moveTo(sx, sy);
            else ctx.lineTo(sx, sy);
          }
          ctx.stroke();
        };
        strokeSlot((s) => slot.value(s), []);
        if (L.mode === 'mirror') {
          const ey = slot.endY;
          strokeSlot((s) => ey - slot.value(1 - s), [3, 3]);
        }
      }
      ctx.restore();
    }
  }

  // ---- Controls: title bar buttons, mode toggles, preset menu, number fields, tips ----

  class Controls {
    constructor(panel) {
      this.p = panel;
      this.tipKind = '';
    }

    // ---- For the panel ------------------------------------------------------

    build() {
      this.tip = h('div', 'fe-tip');
      this.tip.hidden = true;
      this.buildModes();
      this.buildPresets();
      return { presets: this.presets, modeBars: this.modeBars, tip: this.tip };
    }

    // Title bar buttons: pause, then undo / redo / copy. The panel places the two groups in its title bar.
    buildButtons() {
      this.pauseBtn = iconButton('pause', '');
      this.undoBtn = iconButton('undo', '');
      this.redoBtn = iconButton('redo', '');
      this.saveBtn = iconButton('save', '');
      this.saveBtn.classList.add('fe-save');
      this.saveDot = h('span', 'fe-save-dot');
      this.saveBtn.appendChild(this.saveDot);
      const group = (...items) => {
        const g = h('div', 'fe-group');
        g.append(...items);
        return g;
      };
      this.pauseGroup = group(this.pauseBtn);
      return [this.pauseGroup, group(this.undoBtn, this.redoBtn, this.saveBtn)];
    }

    // loop / alternate toggles at the top right of the graph.
    buildModes() {
      this.loopMode = h('button', 'fe-mode fe-mode-loop');
      this.loopMode.type = 'button';
      this.loopIcon = svgIcon('loop');
      this.loopSlash = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      this.loopSlash.setAttribute('d', 'M2.5 13.5l11-11');
      this.loopSlash.setAttribute('hidden', '');
      this.loopIcon.appendChild(this.loopSlash);
      this.loopMode.append(this.loopIcon);

      this.altMode = h('button', 'fe-mode fe-mode-alt');
      this.altMode.type = 'button';
      this.altIcon = svgIcon('altOff');
      this.altLabel = h('span', 'fe-mode-label', 'off');
      this.altMode.append(this.altIcon, this.altLabel);

      this.modes = h('div', 'fe-modes');
      this.modesSep = h('i', 'fe-modes-sep');
      this.modes.append(this.loopMode, this.modesSep, this.altMode);

      this.modeBars = h('div', 'fe-mode-bars');
      this.modeBars.append(this.modes);
    }

    // Preset menu at the top left of the graph.
    buildPresets() {
      this.presetBtn = h('button', 'fe-preset-btn');
      this.presetBtn.type = 'button';
      this.presetIcon = svgIcon('presets');
      this.presetBtn.append(this.presetIcon);
      this.presetMenu = h('div', 'fe-preset-menu');
      this.presetMenu.hidden = true;
      this.presetItems = new Map();
      for (const preset of CURVE_PRESETS) {
        const item = h('button', 'fe-preset-item');
        item.type = 'button';
        item.dataset.preset = preset.id;
        item.append(presetIcon(preset.state), h('span', 'fe-preset-name', preset.id));
        this.presetMenu.appendChild(item);
        this.presetItems.set(preset.id, item);
      }
      this.presets = h('div', 'fe-presets');
      this.presets.append(this.presetBtn, this.presetMenu);
    }

    applyLocale() {
      this.pauseBtn.title = t('pause');
      this.pauseBtn.setAttribute('aria-label', t('pause'));
      this.undoBtn.title = t('undo');
      this.undoBtn.setAttribute('aria-label', t('undo'));
      this.redoBtn.title = t('redo');
      this.redoBtn.setAttribute('aria-label', t('redo'));
      this.saveDot.title = t('draft');
      this.loopMode.title = t('loop');
      this.altMode.title = t('alternate');
      this.presetBtn.title = t('presets');
      for (const preset of CURVE_PRESETS) {
        const item = this.presetItems.get(preset.id);
        if (!item) continue;
        item.title = preset.id;
        const name = item.querySelector('.fe-preset-name');
        if (name) name.textContent = preset.id;
      }
    }

    bindControls() {
      this.presetBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.presetMenu.hidden = !this.presetMenu.hidden;
        this.presetBtn.classList.toggle('fe-on', !this.presetMenu.hidden);
      });
      this.bindModeTip(this.presetBtn, () => {
        this.showFloatingTip(this.presetBtn, t('presets'), 'preset', false);
      });
      this.presetMenu.addEventListener('click', (ev) => {
        const item = ev.target.closest('[data-preset]');
        if (!item) return;
        this.applyCurvePreset(item.dataset.preset);
      });
      this.onPresetOutside = (ev) => {
        if (this.presetMenu.hidden) return;
        if (this.presets.contains(ev.target)) return;
        this.closePresetMenu();
      };
      root.addEventListener('pointerdown', this.onPresetOutside, true);
      this.loopMode.addEventListener('click', () => {
        const e = this.p.cur;
        this.p.editInstance(e, (x) => (x.loop = !x.loop));
        this.flashModeTip('loop');
      });
      this.bindModeTip(this.loopMode, () => this.flashModeTip('loop', true));
      this.altMode.addEventListener('click', () => {
        const e = this.p.cur;
        const order = [false, true, 'mirror'];
        this.p.editInstance(e, (x) => {
          const i = order.indexOf(normalizeAlternate(x.alternate));
          x.alternate = order[(i + 1) % order.length];
        });
        this.flashModeTip('alt');
      });
      this.bindModeTip(this.altMode, () => this.flashModeTip('alt', true));
      this.pauseBtn.addEventListener('click', () => this.p.setPaused(!transportState().on));
      this.saveBtn.addEventListener('click', () => this.p.save());
      this.undoBtn.addEventListener('click', () => this.p.undo());
      this.redoBtn.addEventListener('click', () => this.p.redo());
    }

    // loop / alternate toggles follow the easing.
    syncModes(e) {
      this.loopMode.classList.toggle('fe-on', e.loop);
      const loopPath = this.loopIcon.querySelector('path');
      if (loopPath) loopPath.setAttribute('d', ICONS.loop);
      if (this.loopSlash) this.loopSlash.style.display = e.loop ? 'none' : '';
      const mode = alternateMode(e.alternate);
      const altText = mode === false ? t('altOff') : mode === true ? t('altAlternate') : t('altMirror');
      this.altMode.classList.toggle('fe-on', mode !== false);
      this.altLabel.textContent = altText;
      const altPath = this.altIcon.querySelector('path');
      if (altPath) altPath.setAttribute('d', ICONS[alternateIcon(e.alternate)]);
    }

    syncButtons({ hasDraft, paused, canUndo, canRedo }) {
      this.saveBtn.title = t('save');
      this.saveBtn.setAttribute('aria-label', this.saveBtn.title);
      this.undoBtn.disabled = !canUndo;
      this.redoBtn.disabled = !canRedo;
      this.saveBtn.classList.toggle('fe-draft', hasDraft);
      this.saveDot.hidden = !hasDraft;
      if (hasDraft) this.saveDot.title = t('draft');
      const icon = this.pauseBtn.querySelector('path');
      if (icon) icon.setAttribute('d', ICONS[paused ? 'play' : 'pause']);
      this.pauseBtn.classList.toggle('fe-on', paused);
      this.pauseGroup.hidden = !canPause();
    }

    destroy() {
      if (this.onPresetOutside) root.removeEventListener('pointerdown', this.onPresetOutside, true);
    }

    // ---- For the other parts ------------------------------------------------

    // The mode toggles show only while the band does.
    setModesShown(show) {
      this.modeBars.hidden = !show;
    }

    // Mode toggles (top right) and preset menu (top left) sit in the graph corners.
    layoutCorners(g) {
      this.modeBars.style.left = 'auto';
      this.modeBars.style.right = g.pad + 'px';
      this.modeBars.style.top = g.pad + 'px';
      this.presets.style.left = g.pad + 'px';
      this.presets.style.top = g.pad + 'px';
    }

    // While a number field's hover tip is up, keep its text current: the value changes during a drag,
    // and the part may become wide enough to show its number, or too narrow to.
    refreshHoverTip() {
      if (this.tipKind !== 'hover' || this.tip.hidden || !this.hoverTipText) return;
      const text = this.hoverTipText();
      if (this.tip.textContent !== text) this.tip.textContent = text;
    }

    // Hide the tip if it is showing one of these kinds.
    hideTip(...kinds) {
      if (!kinds.includes(this.tipKind)) return;
      this.tip.hidden = true;
      this.tipKind = '';
    }

    // The note on the per-frame stripe at the graph's left edge.
    showStripeTip(top) {
      this.tip.className = 'fe-tip fe-tip-stripe';
      this.tip.textContent = t('stripe');
      this.tip.hidden = false;
      this.tip.style.left = '18px';
      this.tip.style.top = top + 'px';
      this.tipKind = 'stripe';
    }

    // `key` names the value for parts that hide their number when narrow (delay, loopDelay).
    bindNumTip(wrap, input, key) {
      const hoverText = () => {
        const owner = this.p.cur;
        const hidden = !!key && !!owner && wrap.classList.contains('fe-narrow');
        return numTipText(key, hidden ? owner[key] : null, hidden);
      };
      const show = (text, kind) => {
        if (!wrap.isConnected) return;
        const g = this.p.graphWrap.getBoundingClientRect();
        const r = wrap.getBoundingClientRect();
        this.tip.className = 'fe-tip';
        this.tip.textContent = text;
        this.tip.hidden = false;
        this.tip.style.left = (r.left + r.width / 2 - g.left) + 'px';
        this.tip.style.top = (r.top - g.top - 30) + 'px';
        this.tipKind = kind;
        this.hoverTipText = kind === 'hover' ? hoverText : null;
      };
      const hide = (kind) => {
        if (this.tipKind === kind || (kind === 'hover' && this.tipKind !== 'focus')) {
          this.tip.hidden = true;
          this.tipKind = '';
        }
      };
      wrap.addEventListener('pointerenter', () => {
        if (input && document.activeElement === input) return;
        show(hoverText(), 'hover');
      });
      wrap.addEventListener('pointerleave', () => hide('hover'));
      if (input) {
        input.addEventListener('focus', () => show(t('scrubFocus'), 'focus'));
        input.addEventListener('blur', () => {
          this.tip.hidden = true;
          this.tipKind = '';
        });
      }
    }

    // Drag left/right to change the value; a click without dragging switches to typing.
    // The number field is part of the scrub target (unless already focused for typing).
    bindScrub(wrap, input, key, min, invert = false) {
      const focusInput = () => {
        if (!input) return;
        input.focus();
        input.select();
      };
      this.bindScrubPointer(wrap, input, key, min, focusInput, invert);
      if (input) this.bindScrubInput(wrap, input, key, min, focusInput);
    }

    // Typing: double click to edit, Enter / Escape to leave, arrows to nudge.
    bindScrubInput(wrap, input, key, min, focusInput) {
      const nudge = (dir, shift) => {
        if (!this.p.cur) return;
        const owner = this.p.cur;
        const step = (shift ? 10 : 1) * dir;
        const cur = Math.round(+input.value);
        const base = Number.isFinite(cur) ? cur : owner[key];
        const v = Math.max(min, base + step);
        this.p.editInstance(owner, (e) => (e[key] = v));
        input.value = String(v);
        input.select();
      };
      wrap.addEventListener('dblclick', (ev) => {
        if (!this.p.cur) return;
        ev.preventDefault();
        focusInput();
      });
      input.addEventListener('change', () => {
        const v = Math.round(+input.value);
        if (Number.isFinite(v) && v >= min) this.p.editInstance(this.p.cur, (e) => (e[key] = v));
        else this.p.syncControls();
      });
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
          ev.preventDefault();
          nudge(ev.key === 'ArrowUp' ? 1 : -1, ev.shiftKey);
          return;
        }
        if (ev.key === 'Enter' || ev.key === 'Escape') {
          if (ev.key === 'Escape' && this.p.cur) {
            const owner = this.p.cur;
            input.value = String(owner[key]);
          }
          input.blur();
        }
      });
      input.addEventListener('blur', () => this.p.syncControls());
    }

    // ---- Number fields ------------------------------------------------------

    // Press and drag sideways to change the value; a plain click focuses the input.
    bindScrubPointer(wrap, input, key, min, focusInput, invert = false) {
      wrap.addEventListener('pointerdown', (ev) => {
        // A scrub nested inside another (stagger inside duration) claims the press first.
        if (ev.button !== 0 || ev.feScrub) return;
        ev.feScrub = true;
        if (!this.p.cur || (input && document.activeElement === input)) return;
        ev.preventDefault();
        capture(wrap, ev);
        const owner = this.p.cur;
        this.p.drag = {
          type: 'scrub', key, owner, wrap, x: ev.clientX, v0: owner[key],
          before: owner.snapshot(), moved: false, invert,
        };
      });
      wrap.addEventListener('pointermove', (ev) => {
        const d = this.p.drag;
        if (!d || d.type !== 'scrub' || d.wrap !== wrap) return;
        const dx = ev.clientX - d.x;
        if (!d.moved && Math.abs(dx) < 3) return;
        d.moved = true;
        const step = ev.shiftKey ? 10 : 1;
        const delta = Math.trunc(dx / 4) * step;
        d.owner[key] = Math.max(min, d.v0 + (d.invert ? -delta : delta));
        this.p.syncControls();
      });
      const end = () => {
        const d = this.p.drag;
        if (!d || d.type !== 'scrub' || d.wrap !== wrap) return;
        this.p.drag = null;
        if (d.moved) {
          if (this.p.record(d.owner, d.before)) this.p.changed(d.owner);
        } else if (input) {
          focusInput();
        }
      };
      wrap.addEventListener('pointerup', end);
      wrap.addEventListener('pointercancel', end);
    }

    // ---- Modes and presets --------------------------------------------------

    bindModeTip(el, show) {
      el.addEventListener('pointerenter', () => show());
      el.addEventListener('pointerleave', () => {
        if (this.modeTipHold) return;
        if (this.tipKind === 'mode' || this.tipKind === 'preset') {
          this.tip.hidden = true;
          this.tipKind = '';
        }
      });
    }

    showFloatingTip(anchor, content, kind, alignRight) {
      if (!anchor || !anchor.isConnected) return;
      const g = this.p.graphWrap.getBoundingClientRect();
      const r = anchor.getBoundingClientRect();
      this.tip.className = kind === 'alt' ? 'fe-tip fe-tip-mode' : 'fe-tip';
      if (typeof content === 'string') this.tip.textContent = content;
      else {
        this.tip.textContent = '';
        this.tip.append(...content);
      }
      this.tip.hidden = false;
      this.tipKind = kind === 'preset' ? 'preset' : 'mode';
      const left = alignRight ? (r.right - g.left) : (r.left - g.left);
      this.tip.style.left = left + 'px';
      this.tip.style.top = (r.bottom - g.top) + 'px';
      this.tip.style.transform = alignRight ? 'translate(-100%, 0)' : 'none';
      this.tip.style.marginTop = '6px';
    }

    flashModeTip(kind, hoverOnly) {
      clearTimeout(this.modeTipTimer);
      this.modeTipHold = !hoverOnly;
      const e = this.p.cur;
      if (kind === 'loop') {
        const on = e && e.loop;
        this.showFloatingTip(this.loopMode, on ? t('loopOn') : t('loopOff'), 'loop', true);
      } else {
        const mode = e ? alternateMode(e.alternate) : false;
        const labels = [t('altOff'), t('altAlternate'), t('altMirror')];
        const cur = mode === false ? 0 : mode === true ? 1 : 2;
        const nodes = labels.map((lab, i) => {
          const s = h('span', i === cur ? 'fe-on' : '', lab);
          return s;
        });
        this.showFloatingTip(this.altMode, nodes, 'alt', true);
      }
      if (hoverOnly) return;
      this.modeTipTimer = setTimeout(() => {
        this.modeTipHold = false;
        if (this.tipKind === 'mode') {
          this.tip.hidden = true;
          this.tipKind = '';
        }
      }, MODE_TIP_MS);
    }

    closePresetMenu() {
      this.presetMenu.hidden = true;
      this.presetBtn.classList.remove('fe-on');
    }

    applyCurvePreset(id) {
      const preset = CURVE_PRESETS.find((p) => p.id === id);
      if (!preset || !this.p.cur) return;
      const which = this.p.activeWhich();
      this.p.edit((e) => presetInto(e, which, preset.state));
      this.p.sel = -1;
      this.closePresetMenu();
    }
  }

  // ---- Keys -----------------------------------------------------------------

  class Keys {
    constructor(panel) {
      this.p = panel;
    }

    // ---- For the panel ------------------------------------------------------

    keyDown(ev) {
      const inPanel = this.p.el.contains(ev.target) || this.p.mini.contains(ev.target);
      const typing = isField(ev.target);
      if (!typing && this.isToggleKey(ev)) {
        this.p.toggle();
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      // Minimized: only the toggle key above. Pausing has one way in, the strip's button, so Space and
      // the arrows do nothing here, and Space does not press a focused button of the strip either
      // (Enter still does).
      if (this.p.ui.open && this.p.ui.minimized) {
        if (this.p.mini.contains(ev.target) && (ev.key === ' ' || ev.key === 'Spacebar')) {
          ev.preventDefault();
          this.spaceTaken = true;
        }
        return;
      }
      if (!this.p.ui.open) return;
      if (typing && !inPanel) return;
      if (!this.p.hover && !inPanel) return;
      // Events targeting the panel itself are stopped by the panel's own listener.
      if (!inPanel) ev.stopPropagation();
      if (typing) return;
      this.handleKey(ev);
    }

    keyOther(ev) {
      // A Space taken on keydown must not press a focused button when it is released.
      if (ev.type === 'keyup' && this.spaceTaken && (ev.key === ' ' || ev.key === 'Spacebar')) {
        this.spaceTaken = false;
        ev.preventDefault();
      }
      if (!this.p.ui.open || !this.p.hover) return;
      if (this.p.el.contains(ev.target) || isField(ev.target)) return;
      ev.stopPropagation();
    }

    // ---- Handling -----------------------------------------------------------

    isToggleKey(ev) {
      return !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey &&
        typeof ev.key === 'string' && ev.key.toLowerCase() === settings.toggleKey.toLowerCase();
    }

    // Space pauses and resumes anywhere over the open panel.
    handleTransportKey(ev) {
      if (!canPause()) return false;
      const key = ev.key;
      if (key !== ' ' && key !== 'Spacebar') return false;
      ev.preventDefault();
      this.spaceTaken = true;
      this.p.setPaused(!transportState().on);
      return true;
    }

    handleKey(ev) {
      const key = ev.key;
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && (key === 'z' || key === 'Z')) {
        ev.preventDefault();
        if (ev.shiftKey) this.p.redo();
        else this.p.undo();
        return;
      }
      if (mod && (key === 'y' || key === 'Y')) {
        ev.preventDefault();
        this.p.redo();
        return;
      }
      if (mod || ev.altKey) return;
      if (key === 'Escape') {
        ev.preventDefault();
        this.p.sel = -1;
        return;
      }
      if (this.handleTransportKey(ev)) return;
      if (/^[1-9]$/.test(key)) {
        const e = guiList()[+key - 1];
        if (e) this.p.select(e);
        return;
      }
      const pts = this.p.cur && this.p.activeCurve(this.p.cur).points;
      const i = this.p.sel;
      if (!pts || i < 0) {
        if (!transportState().on) return;
        const step = ev.shiftKey ? 10 : 1;
        if (key === 'ArrowLeft') transportNudge(-step);
        else if (key === 'ArrowRight') transportNudge(step);
        else return;
        ev.preventDefault();
        this.p.syncControls();
        return;
      }
      const inner = i > 0 && i < pts.length - 1;
      const isEnd = i === pts.length - 1;
      if (key === 'Delete' || key === 'Backspace') {
        ev.preventDefault();
        if (inner) this.p.graph.deletePoint(i);
        return;
      }
      const step = ev.shiftKey ? NUDGE_BIG : NUDGE;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      const mv = moves[key];
      if (!mv) return;
      ev.preventDefault();
      if (inner) {
        this.p.edit((e) => {
          const curve = this.p.activeCurve(e);
          const p = curve.points[i];
          p.x = this.p.graph.clampX(curve.points, i, round3(p.x + mv[0]));
          p.y = round3(p.y + mv[1]);
        });
        return;
      }
      // Endpoint: vertical only on the end point (snaps to y = 1).
      if (isEnd && mv[0] === 0 && mv[1] !== 0) {
        this.p.edit((e) => {
          const curve = this.p.activeCurve(e);
          curve.points[i].y = round3(snapEndY(curve.points[i].y + mv[1]));
        });
      }
    }
  }

  const GUI = (() => {
    const hasDOM = typeof document !== 'undefined' && typeof root.addEventListener === 'function';
    let panel = null;
    let waiting = false;

    function mount() {
      waiting = false;
      if (!panel && settings.gui && guiList().length > 0) panel = new Panel();
    }

    function sync() {
      if (!hasDOM) return;
      const want = settings.gui && guiList().length > 0;
      if (want && !panel) {
        if (document.body) mount();
        else if (!waiting) {
          waiting = true;
          document.addEventListener('DOMContentLoaded', mount, { once: true });
        }
      } else if (!want && panel) {
        panel.destroy();
        panel = null;
      } else if (panel) {
        panel.refreshAll();
      }
    }

    return { sync };
  })();

  // The body of FrameEase.gui(): turn the GUI on (once) and apply its options. Other keys, such as the
  // `locale` of earlier versions, are ignored without a warning.
  function showGui(opts) {
    if (opts && typeof opts === 'object') {
      if (typeof opts.key === 'string' && opts.key) settings.toggleKey = opts.key;
    }
    const wasOff = !settings.gui;
    settings.gui = true;
    if (wasOff) {
      callLog.clear();
      for (const e of instances.values()) e.resolve();
    }
    GUI.sync();
  }

  // Plug the GUI part into the core.
  hooks.onCall = (entry) => callLog.record(entry);
  hooks.wantsCall = () => callLog.wants();
  hooks.onFrameCall = (e, hasIndex) => {
    if (!settings.gui) return false;
    noteIndexUse(e, hasIndex);
    return callLog.wants();
  };
  hooks.checkCall = checkCallOpts;
  hooks.onChange = () => GUI.sync();
  hooks.gui = showGui;

  Object.assign(internals, {
    insertPoint, deletePoint: deletePointAt, bandLayoutOf, bandSegmentXs, bandDimensionLabels, sketchFrameRate, effectiveCycleFrames,
    betweenInCalls, infoLabelFit, numTipText, BAND_H, DELAY_ROW_H, drafts, draftKey, easingOf,
    CURVE_PRESETS, presetInto,
    thinCalls, staggerSpan, allSameFrame, bandMarkX, observedStep, offsetReadoutInfo, visualT, miniHot, callLog,
    callsForEasing, followPanel, CALL_CAP, LOG_CAP, snapEndY, END_Y_SNAP,
    transportToggle, transportNudge, transportScrubRing, transportState, canPause, frameFromBandX,
  });

  // ===== GUI END =====

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function FrameEase(name, options) {
    return create(name, options);
  }
  FrameEase.importState = importState;
  FrameEase.exportState = exportState;
  FrameEase.gui = gui;
  FrameEase.version = VERSION;
  Object.defineProperty(FrameEase, '_internals', { value: internals });

  root.FrameEase = FrameEase;
})(typeof window !== 'undefined' ? window : globalThis);
