// engine.js: map matcher, distance estimator and voice-cue engine for the pacer.
// Plain ES module, no dependencies. Loads in iOS Safari 18 and Node 22.
//
// Times: every public method takes epoch milliseconds (Geolocation timestamps / Date.now()).
// Distances are meters along the route line (route.js, scaled to 42,195 m).

import { MARATHON_M, HALF_M, planTimeAt, planPaceAt, planDistAt, fmtClock } from './plan.js';
import { AID_STATIONS, FUEL, MARKERS } from './course.js';

export const DEFAULT_SETTINGS = Object.freeze({
  cueEveryKm: 1, // 1 | 2
  aidHeadsUp: true,
  capsules: 2, // 2 | 3
  stretchCue: true,
  voice: true, // the engine always emits cues; the UI decides whether to speak them
});

// Tunables (see plan B.3). Exported for experiments; treat as read-only.
export const CFG = {
  maxAcc: 60, // m: reject fixes whose reported accuracy is worse
  offsetSlack: 60, // m: reject if the fix is farther than slack + accuracy from the route
  backJump: 30, // m: a fix this far (+2σ of the estimate) from the prediction is a jump
  vCap: 7, // m/s: progress can't grow faster than this between accepted fixes
  drMin: 2, // m/s: dead-reckoning speed clamp
  drMax: 5,
  drSec: 60, // s without a good fix before falling back to plan pace
  vWinSec: 180, // s of accepted progress used for the dead-reckoning speed
  vMinSec: 40, // s minimum span before that speed is trusted
  cornerWin: 25, // m on each side used to measure how sharp the route turns
  q: 0.001, // Kalman process noise (m²/s³)
  rMul: 2, // GPS errors are correlated over ~20 s, so 1 Hz fixes carry less news than R says
  gateSigma: 3, // innovation gate, in sigmas
  gateFloor: 10, // m
  huber: 2, // innovations beyond this many sigmas get a capped influence
  dvMax: 0.05, // m/s: most one fix can change the filter velocity
  reanchorN: 10, // consistent rejected fixes needed to re-anchor
  reanchorSpan: 15, // s they must span
  reanchorSpread: 25, // m: they must agree within ±this
  goodAgeSec: 15, // gps.ok while the last accepted fix is younger than this
};

const R_EARTH = 6371008.8;
const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const pad2 = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------------------------------
// Route geometry

const routeCache = new WeakMap();

// Accepts ROUTE ([[lat, lon, cumM], ...]) or a module/object with .ROUTE. Points without
// cumM get cumulative distances scaled to 42,195 m.
export function prepareRoute(route) {
  const pts = Array.isArray(route) ? route : route && route.ROUTE;
  if (!pts || pts.length < 2) throw new Error('prepareRoute: need at least 2 route points');
  const hit = routeCache.get(pts);
  if (hit) return hit;
  const n = pts.length;
  let lat0 = 0;
  for (const p of pts) lat0 += p[0];
  lat0 /= n;
  const lon0 = pts[0][1];
  const kx = R_EARTH * DEG * Math.cos(lat0 * DEG);
  const ky = R_EARTH * DEG;
  const x = new Float64Array(n), y = new Float64Array(n), cum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = (pts[i][1] - lon0) * kx;
    y[i] = (pts[i][0] - lat0) * ky;
  }
  if (pts[0].length >= 3 && pts[n - 1][2] > 0) {
    for (let i = 0; i < n; i++) cum[i] = pts[i][2];
  } else {
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
    const s = MARATHON_M / cum[n - 1];
    for (let i = 0; i < n; i++) cum[i] *= s;
  }
  const geo = { n, lat0, lon0, kx, ky, x, y, cum, total: cum[n - 1] };
  routeCache.set(pts, geo);
  return geo;
}

// Largest i in [0, n-2] with cum[i] <= m.
function segStart(cum, m) {
  let lo = 0, hi = cum.length - 2;
  if (!(m > cum[0])) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= m) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Point on the route at distance m: { lat, lon, x, y }.
export function routePointAt(geo, m) {
  m = clamp(m, 0, geo.total);
  const i = segStart(geo.cum, m);
  const c0 = geo.cum[i], c1 = geo.cum[i + 1];
  const f = c1 > c0 ? (m - c0) / (c1 - c0) : 0;
  const x = geo.x[i] + f * (geo.x[i + 1] - geo.x[i]);
  const y = geo.y[i] + f * (geo.y[i + 1] - geo.y[i]);
  return { x, y, lat: geo.lat0 + y / geo.ky, lon: geo.lon0 + x / geo.kx };
}

// Projects a fix onto the part of the route between lo and hi meters.
// Returns { along, offset } (route meters, perpendicular distance in m) or null.
export function projectOnRoute(geo, lat, lon, lo, hi) {
  lo = Math.max(0, lo);
  hi = Math.min(geo.total, hi);
  if (!(hi >= lo)) return null;
  const px = (lon - geo.lon0) * geo.kx, py = (lat - geo.lat0) * geo.ky;
  const { x, y, cum, n } = geo;
  let bestD2 = Infinity, bestAlong = 0;
  for (let i = segStart(cum, lo); i < n - 1 && cum[i] <= hi; i++) {
    const c0 = cum[i], dc = cum[i + 1] - c0;
    if (!(dc > 0)) continue;
    const ax = x[i], ay = y[i], bx = x[i + 1] - ax, by = y[i + 1] - ay;
    const L2 = bx * bx + by * by;
    let t = L2 > 0 ? ((px - ax) * bx + (py - ay) * by) / L2 : 0;
    const tmin = Math.max(0, (lo - c0) / dc), tmax = Math.min(1, (hi - c0) / dc);
    t = Math.min(tmax, Math.max(tmin, t));
    const qx = ax + t * bx - px, qy = ay + t * by - py;
    const d2 = qx * qx + qy * qy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestAlong = c0 + t * dc;
    }
  }
  return bestD2 < Infinity ? { along: bestAlong, offset: Math.sqrt(bestD2) } : null;
}

// ---------------------------------------------------------------------------------------
// Speech helpers (short, TTS-friendly English)

export function sayPace(secPerKm) {
  const r = Math.round(secPerKm);
  return `${Math.floor(r / 60)} ${pad2(r % 60)}`;
}
export function sayClock(sec) {
  const r = Math.round(Math.abs(sec));
  const h = Math.floor(r / 3600), m = Math.floor((r % 3600) / 60), s = r % 60;
  return h > 0 ? `${h} ${pad2(m)} ${pad2(s)}` : `${m} ${pad2(s)}`;
}
function sayDur(sec) {
  const r = Math.round(Math.abs(sec));
  if (r < 60) return `${r} second${r === 1 ? '' : 's'}`;
  const m = Math.floor(r / 60), s = r % 60;
  return `${m} minute${m === 1 ? '' : 's'}${s ? ` ${s} second${s === 1 ? '' : 's'}` : ''}`;
}
// Whole seconds as spoken: rounds half away from zero, so ±2.5 s is "3 seconds" either way.
export const spokenSec = (sec) => Math.sign(sec) * Math.round(Math.abs(sec));
export function sayAhead(sec) {
  const r = spokenSec(sec);
  if (r === 0) return 'On plan';
  return `${sayDur(r)} ${r > 0 ? 'ahead' : 'behind'}`;
}
function sayProduct(p) {
  if (/^GU #2/.test(p)) return 'the caffeinated G U';
  return p.replace(/\+/g, 'plus');
}

// ---------------------------------------------------------------------------------------

const aidByN = new Map(AID_STATIONS.map((a) => [a.n, a]));
const MILE26_M = MARKERS.miles[25].km * 1000;

// Where the mile-26 hill cue fires: 200 m before the sharpest turn (the right onto Roosevelt
// Rd) in the 600 m before mile 26. Falls back to 200 m before mile 26.
const hillCache = new WeakMap();
function hillCueM(geo) {
  if (hillCache.has(geo)) return hillCache.get(geo);
  let best = 0, at = null;
  for (let m = MILE26_M - 600; m <= MILE26_M; m += 10) {
    const a = routePointAt(geo, m - 25), b = routePointAt(geo, m), c = routePointAt(geo, m + 25);
    let dh = Math.abs(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x));
    if (dh > Math.PI) dh = 2 * Math.PI - dh;
    if (dh > best) {
      best = dh;
      at = m;
    }
  }
  const m = (best > Math.PI / 4 ? at : MILE26_M) - 200;
  hillCache.set(geo, m);
  return m;
}

export class RaceEngine {
  constructor({ plan, route, settings } = {}) {
    if (!plan || !plan.segments) throw new Error('RaceEngine: plan is required');
    this.plan = plan;
    this.route = route;
    this.geo = prepareRoute(route);
    this.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    this._init();
  }

  _init() {
    this.startMs = null;
    this.finishT = null; // s (epoch) when the finish was crossed
    this.f = null; // Kalman state { t, d, v, p00, p01, p11 }
    this.anchor = null; // last accepted progress { t, d }: window base and gates
    this.cand = []; // [[t, along]] plausible fixes the gates rejected (re-anchor evidence)
    this.trk = []; // [[t, d]] accepted progress every ≥5 s (dead-reckoning speed)
    this.lastFix = null; // most recent fix of any quality { t, acc, used }
    this.lastAccT = null; // s: last accepted fix
    this.dMax = 0; // monotonic progress used for display and cue triggers
    this.prevTickT = null;
    this.fired = {}; // cue id → s (epoch)
    this.kmT = []; // kmT[k] = s (epoch) when km k was crossed; kmT[0] = start
    this.kmAhead = []; // aheadSec at each km crossing
    this.halfT = null;
    this.hist = []; // [[t, dMax]] samples for the rolling pace
    this.pending = []; // cues raised outside tick() (markKm)
    this.warn = { aheadKm: -99, aheadMag: 0, behindKm: -99, behindMag: 0 };
    this.stats = { fixes: 0, accepted: 0, reanchors: 0, rejected: {} };
  }

  get started() {
    return this.startMs != null;
  }
  get finished() {
    return this.finishT != null;
  }

  setSettings(patch) {
    this.settings = { ...this.settings, ...(patch || {}) };
  }

  // Tap at the start mat.
  start(tMs) {
    const lastFix = this.lastFix;
    this._init();
    this.lastFix = lastFix;
    this.startMs = tMs;
    const t = tMs / 1000;
    this.f = { t, d: 0, v: 1000 / planPaceAt(this.plan, 0), p00: 25, p01: 0, p11: 0.25 };
    this.anchor = { t, d: 0 };
    this.kmT[0] = t;
    this.prevTickT = t;
    this.hist.push([t, 0]);
  }

  // +sec means the race really started sec earlier than the START tap (adds to elapsed).
  nudgeStart(sec) {
    if (!this.started) return null;
    this.startMs -= sec * 1000;
    return this.startMs;
  }

  // Smoothed speed for dead reckoning: progress over the last ~3 min of accepted fixes.
  // (The Kalman velocity follows the slowly drifting GPS bias, so it swings ±0.5 m/s.)
  // Until 40 s of track exist, use the filter velocity held within ±10% of plan pace.
  _vDR() {
    const k = this.trk;
    if (k.length >= 2) {
      const [tb, db] = k[k.length - 1];
      for (let i = 0; i < k.length - 1; i++) {
        const [ta, da] = k[i];
        if (tb - ta > CFG.vWinSec) continue;
        if (tb - ta >= CFG.vMinSec) return clamp((db - da) / (tb - ta), CFG.drMin, CFG.drMax);
        break;
      }
    }
    const vPlan = 1000 / planPaceAt(this.plan, this.f.d);
    return clamp(clamp(this.f.v, 0.9 * vPlan, 1.1 * vPlan), CFG.drMin, CFG.drMax);
  }

  // Dead-reckoned progress at time t (s), from the last filter update.
  _predict(t) {
    const f = this.f;
    const dt = Math.max(0, t - f.t);
    const v = this._vDR();
    if (dt <= CFG.drSec) return { d: Math.min(MARATHON_M, f.d + v * dt), v, mode: dt <= 5 ? 'gps' : 'dr' };
    const d1 = Math.min(MARATHON_M, f.d + v * CFG.drSec);
    const d = planDistAt(this.plan, planTimeAt(this.plan, d1) + (dt - CFG.drSec));
    return { d, v: 1000 / planPaceAt(this.plan, d), mode: 'plan' };
  }

  // Heading change (rad, 0..π) of the route around distance m.
  _turnAt(m) {
    const g = this.geo, w = CFG.cornerWin;
    const a = routePointAt(g, m - w), b = routePointAt(g, m), c = routePointAt(g, m + w);
    const h1 = Math.atan2(b.y - a.y, b.x - a.x), h2 = Math.atan2(c.y - b.y, c.x - b.x);
    let dh = Math.abs(h2 - h1);
    if (dh > Math.PI) dh = 2 * Math.PI - dh;
    return dh;
  }

  _rej(why) {
    this.stats.rejected[why] = (this.stats.rejected[why] || 0) + 1;
    return false;
  }

  // Returns true when the fix moved the estimate.
  onFix(fix) {
    if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return false;
    const t = (Number.isFinite(fix.t) ? fix.t : Date.now()) / 1000;
    const acc = Number.isFinite(fix.accuracy) ? fix.accuracy : 999;
    this.lastFix = { t, acc, used: false };
    if (!this.started || this.finished) return false;
    this.stats.fixes++;
    if (t <= this.f.t) return this._rej('stale');
    if (!(acc <= CFG.maxAcc)) return this._rej('accuracy');

    // Map-match inside the forward window around the last accepted progress.
    const a = this.anchor;
    const dtA = t - a.t;
    const pred = this._predict(t);
    const pr = projectOnRoute(this.geo, fix.lat, fix.lon, a.d - 100, a.d + Math.max(300, CFG.vCap * dtA + 150));
    if (!pr || pr.offset > CFG.offsetSlack + acc) {
      // Nothing in the forward window. If the fix is clean, look wider: our estimate may be off.
      if (acc <= 25) {
        const wide = projectOnRoute(this.geo, fix.lat, fix.lon, pred.d - 1000, pred.d + 1000);
        if (wide && wide.offset <= 15 + acc) this._candidate(t, wide.along, acc);
      }
      return this._rej('offset');
    }
    const z = pr.along;

    // Kalman predict (constant velocity) + gated update.
    const f = this.f;
    const dt = t - f.t;
    let p00 = f.p00 + 2 * dt * f.p01 + dt * dt * f.p11 + (CFG.q * dt * dt * dt) / 3;
    let p01 = f.p01 + dt * f.p11 + (CFG.q * dt * dt) / 2;
    let p11 = f.p11 + CFG.q * dt;
    if (dt > CFG.drSec) {
      const extra = 0.05 * pred.v * (dt - CFG.drSec);
      p00 += extra * extra;
      p11 += 0.1;
    }
    let R = (Math.max(9, (0.7 * acc) ** 2) + pr.offset * pr.offset) * CFG.rMul;
    // Near a sharp turn, a sideways error turns into an along-route error of ~tan(turn/2)×.
    const turn = this._turnAt(pr.along);
    if (turn > 0.5) R *= 1 + Math.tan(Math.min(turn, 2.8) / 2) ** 2;
    const S = p00 + R;
    const sd = Math.sqrt(S);
    let y = z - pred.d;
    // Jump gate: a fix more than 30 m (plus the estimate's own 2σ) from where the runner
    // should be is a multipath jump, backward or forward. A badly reported accuracy can only
    // tighten this gate, never widen it.
    const gate = Math.min(CFG.backJump + 2 * Math.sqrt(p00), CFG.gateSigma * sd + CFG.gateFloor);
    if (Math.abs(y) > gate) {
      this._candidate(t, pr.along, acc);
      return this._rej(y < 0 ? 'backward' : 'gate');
    }
    if (Math.abs(y) > CFG.huber * sd) y = Math.sign(y) * CFG.huber * sd; // bounded influence
    const k0 = p00 / S, k1 = p01 / S;
    const vPrior = dt > CFG.drSec ? pred.v : f.v;
    this.f = {
      t,
      d: clamp(Math.min(pred.d + k0 * y, a.d + CFG.vCap * dtA), 0, MARATHON_M), // ≤ 7 m/s
      v: clamp(vPrior + clamp(k1 * y, -CFG.dvMax, CFG.dvMax), 0.5, CFG.vCap),
      p00: (1 - k0) * p00,
      p01: (1 - k0) * p01,
      p11: Math.max(1e-4, p11 - k1 * p01),
    };
    this.anchor = { t, d: this.f.d };
    this.cand = [];
    this.lastAccT = t;
    this.lastFix.used = true;
    this.stats.accepted++;
    const k = this.trk;
    if (!k.length || t - k[k.length - 1][0] >= 5) k.push([t, this.f.d]);
    while (k.length > 2 && t - k[1][0] > CFG.vWinSec) k.shift();
    return true;
  }

  // Collects plausible fixes the gates rejected. When enough of them agree with each other
  // for long enough, the estimate is what's wrong: re-anchor on them.
  _candidate(t, along, acc) {
    if (acc > 40) return;
    const c = this.cand;
    c.push([t, along]);
    while (c.length && t - c[0][0] > 30) c.shift();
    if (c.length < CFG.reanchorN || t - c[0][0] < CFG.reanchorSpan) return;
    const v = this._vDR();
    const now = c.map(([ti, zi]) => zi + v * (t - ti)).sort((p, q) => p - q);
    const med = now[now.length >> 1];
    const agree = now.filter((p) => Math.abs(p - med) <= CFG.reanchorSpread).length;
    if (agree < 0.8 * now.length) return;
    this._reanchor(t, med, 15 * 15);
    this.stats.reanchors++;
  }

  _reanchor(t, d, p00) {
    const v = this.f ? this._vDR() : 1000 / planPaceAt(this.plan, d);
    this.f = { t, d: clamp(d, 0, MARATHON_M), v, p00, p01: 0, p11: 0.1 };
    this.anchor = { t, d: this.f.d };
    this.cand = [];
    this.trk = [];
    this.lastAccT = t;
    if (this.f.d < this.dMax) this.dMax = this.f.d;
  }

  // "Mark km" button: snap progress to the nearest km sign. Returns the km snapped to.
  markKm(tMs) {
    if (!this.started || this.finished) return null;
    const t = tMs / 1000;
    const k = clamp(Math.round(this._predict(t).d / 1000), 0, 42);
    const m = k * 1000;
    const from = this.dMax;
    this._reanchor(t, m, 100);
    if (m > from) this._cross(t, from, t, m, this.pending);
    this.dMax = m;
    this.prevTickT = Math.max(this.prevTickT ?? t, t);
    return k;
  }

  // Ordered trigger points. Rebuilt when settings that affect them change.
  _events() {
    const s = this.settings;
    const sig = `${s.cueEveryKm}|${s.aidHeadsUp}|${s.capsules}|${s.stretchCue}`;
    if (this._evSig === sig) return this._ev;
    const ev = [];
    const add = (m, kind, data = {}) => ev.push({ m, kind, ord: ev.length, ...data });
    for (let k = 1; k <= 42; k++) add(k * 1000, 'km', { k });
    add(HALF_M, 'half');
    const fuelPts = [];
    for (const it of FUEL) {
      if (it.km == null) continue;
      const aid = aidByN.get(it.waterAt) || null;
      if (it.kind === 'gel') {
        add(it.km * 1000 - 400, 'gelWarn', { item: it, aid });
        add(it.km * 1000, 'gelNow', { item: it, aid });
        fuelPts.push(it.km * 1000 - 400, it.km * 1000);
      } else if (it.kind === 'capsule') {
        if (it.optional && Number(s.capsules) < 3) continue;
        const m = (aid ? aid.km : it.km) * 1000 - 200;
        add(m, 'capsule', { item: it, aid });
        fuelPts.push(m);
      }
    }
    if (s.aidHeadsUp) {
      for (const a of AID_STATIONS) {
        const m = a.km * 1000 - 200;
        if (fuelPts.some((p) => Math.abs(p - m) <= 300)) continue;
        add(m, 'aid', { aid: a });
      }
    }
    add(3000, 'settle');
    add(30000, 'stretch');
    add(hillCueM(this.geo), 'hill');
    add(MARATHON_M, 'finish');
    ev.sort((p, q) => p.m - q.m || p.ord - q.ord);
    this._evSig = sig;
    this._ev = ev;
    return ev;
  }

  // Fires every event whose trigger point lies in (d0, d1], interpolating crossing times.
  _cross(t0, d0, t1, d1, out) {
    if (!(d1 > d0)) return;
    for (const e of this._events()) {
      if (e.m <= d0) continue;
      if (e.m > d1) break;
      const tc = t1 > t0 ? t0 + ((e.m - d0) / (d1 - d0)) * (t1 - t0) : t1;
      this._handle(e, tc, out);
      if (this.finished) break;
    }
  }

  _emit(out, id, priority, text, tc, m) {
    if (this.fired[id] != null) return;
    this.fired[id] = tc;
    out.push({ id, priority, text, t: Math.round(tc * 1000), atM: Math.round(m) });
  }

  _handle(e, tc, out) {
    const s = this.settings, plan = this.plan;
    const t0 = this.startMs / 1000;
    switch (e.kind) {
      case 'km': {
        const k = e.k;
        if (this.kmT[k] == null) this.kmT[k] = tc;
        const ahead = planTimeAt(plan, k * 1000) - (this.kmT[k] - t0);
        this.kmAhead[k] = ahead;
        const every = Number(s.cueEveryKm) === 2 ? 2 : 1;
        if (k % every === 0) {
          const back = Math.min(every, k);
          const prevT = this.kmT[k - back];
          const per = prevT != null ? (this.kmT[k] - prevT) / back : null;
          const split = per == null ? '' : every === 1 ? ` Split ${sayPace(per)}.` : ` Last ${back} at ${sayPace(per)}.`;
          // From km 31: projected finish if the rest goes to plan (same rounding as spoken).
          const proj = k >= 31 ? ` Projected ${sayClock(Math.round(plan.totalSec) - spokenSec(ahead))}.` : '';
          this._emit(out, `km${k}`, 2, `Kilometer ${k}.${split} ${sayAhead(ahead)}.${proj}`, tc, e.m);
        }
        this._offPace(k, ahead, tc, out, e.m);
        break;
      }
      case 'half': {
        if (this.halfT == null) this.halfT = tc;
        const actual = Math.round(this.halfT - t0);
        const planned = Math.round(planTimeAt(plan, HALF_M));
        this._emit(out, 'half', 2, `Halfway in ${sayClock(actual)}. Plan ${sayClock(planned)}. ${sayAhead(planned - actual)}.`, tc, e.m);
        break;
      }
      case 'gelWarn': {
        const { item, aid } = e;
        const toAid = aid ? Math.round((aid.km * 1000 - e.m) / 100) * 100 : 0;
        const tail = toAid > 0 ? ` Aid station in ${toAid} meters.` : '';
        this._emit(out, `${item.id}-warn`, 1, `Gel ${item.n} coming up, ${sayProduct(item.product)}.${tail}`, tc, e.m);
        break;
      }
      case 'gelNow': {
        const { item, aid } = e;
        const toAid = aid ? Math.round((aid.km * 1000 - e.m) / 100) * 100 : 0;
        const tail = toAid > 0 ? ` Water in ${toAid} meters.` : '';
        this._emit(out, `${item.id}-now`, 1, `Gel ${item.n}. Take it now, in small squeezes.${tail}`, tc, e.m);
        break;
      }
      case 'capsule': {
        const { item, aid } = e;
        const where = aid ? `Aid ${aid.n} in 200 meters. ` : '';
        this._emit(out, item.id, 1, `${where}Salt capsule at this aid station, with a full cup of water.`, tc, e.m);
        break;
      }
      case 'aid':
        this._emit(out, `aid${e.aid.n}`, 3, `Aid station ${e.aid.n} in 200 meters.`, tc, e.m);
        break;
      case 'settle':
        this._emit(out, 'settle', 3, 'Settle in. Stay relaxed with the 3 35 group.', tc, e.m);
        break;
      case 'stretch':
        if (s.stretchCue) {
          this._emit(out, 'stretch', 2, 'Decision point. Feeling strong: 4 48 from 32 K, then 4 43 after 35 K. If not, hold 4 53.', tc, e.m);
        }
        break;
      case 'hill':
        this._emit(out, 'hill', 2, 'Mile 26 ahead. Right onto Roosevelt for a short hill. Quick steps to the top, then 300 meters to go.', tc, e.m);
        break;
      case 'finish': {
        this.finishT = tc;
        const fin = Math.round(tc - t0);
        const diff = Math.round(plan.totalSec) - fin;
        const vs = diff === 0 ? 'Right on plan.' : `${sayDur(diff)} ${diff > 0 ? 'under' : 'over'} plan.`;
        this._emit(out, 'finish', 1, `Finish. ${sayClock(fin)}. ${vs}`, tc, e.m);
        break;
      }
    }
  }

  // > 45 s ahead or > 30 s behind at two km crossings in a row. At most every 5 km, and only
  // again if the gap grew by 10 s. "Ease off" never fires from 30K on (the push is allowed).
  _offPace(k, ahead, tc, out, m) {
    const prev = this.kmAhead[k - 1];
    if (prev == null) return;
    const w = this.warn;
    if (ahead > 45 && prev > 45) {
      if (k < 30 && k - w.aheadKm >= 5 && (w.aheadKm < 0 || ahead >= w.aheadMag + 10)) {
        w.aheadKm = k;
        w.aheadMag = ahead;
        this._emit(out, `offpace-ahead-${k}`, 2, `${sayDur(ahead)} ahead of plan. Ease off a little.`, tc, m);
      }
    } else if (ahead < -30 && prev < -30) {
      if (k - w.behindKm >= 5 && (w.behindKm < 0 || -ahead >= w.behindMag + 10)) {
        w.behindKm = k;
        w.behindMag = -ahead;
        this._emit(out, `offpace-behind-${k}`, 2, `${sayDur(ahead)} behind plan. Pick it up a little.`, tc, m);
      }
    }
  }

  tick(tMs) {
    const t = tMs / 1000;
    const cues = this.pending.splice(0, this.pending.length);
    if (!this.started) return { state: this._state(t, 0, 'idle'), cues };
    let d = MARATHON_M, mode = 'done';
    if (!this.finished) {
      const p = this._predict(t);
      d = clamp(p.d, 0, MARATHON_M);
      mode = p.mode;
      const t0 = this.prevTickT ?? t;
      if (d > this.dMax) {
        this._cross(Math.min(t0, t), this.dMax, t, d, cues);
        this.dMax = d;
      }
      this.prevTickT = Math.max(t0, t);
      const h = this.hist;
      if (!h.length || t - h[h.length - 1][0] >= 2) h.push([t, this.dMax]);
      while (h.length > 2 && t - h[1][0] > 420) h.shift();
    }
    return { state: this._state(t, d, mode), cues };
  }

  _rollingPace(t) {
    const h = this.hist;
    const d = this.dMax;
    if (this.finished || !h.length) return null;
    for (let i = h.length - 1; i >= 0; i--) {
      if (d - h[i][1] >= 400) return ((t - h[i][0]) / (d - h[i][1])) * 1000;
    }
    const [t0, d0] = h[0];
    return d - d0 >= 100 && t > t0 ? ((t - t0) / (d - d0)) * 1000 : null;
  }

  _nextList() {
    const caps = Number(this.settings.capsules);
    if (this._nextSig === caps) return this._nextEv;
    const list = [];
    const capAids = new Set();
    for (const it of FUEL) {
      if (it.km == null) continue;
      if (it.kind === 'gel') {
        list.push({ m: it.km * 1000, kind: 'gel', label: it.label, detail: `${it.product} · water at Aid ${it.waterAt}`, fuel: true });
      } else if (it.kind === 'capsule') {
        if (it.optional && caps < 3) continue;
        const aid = aidByN.get(it.waterAt);
        capAids.add(it.waterAt);
        list.push({ m: (aid ? aid.km : it.km) * 1000, kind: 'capsule', label: it.label, detail: `At Aid ${it.waterAt} · full cup of water`, fuel: true });
      }
    }
    for (const a of AID_STATIONS) {
      if (!capAids.has(a.n)) list.push({ m: a.km * 1000, kind: 'aid', label: `Aid ${a.n}`, detail: a.where, fuel: false });
    }
    list.push({ m: MARATHON_M, kind: 'finish', label: 'Finish', detail: `Plan ${fmtClock(this.plan.totalSec)}`, fuel: false });
    list.sort((p, q) => p.m - q.m);
    this._nextSig = caps;
    this._nextEv = list;
    return list;
  }

  _state(t, dEst, mode) {
    const plan = this.plan;
    const started = this.started, finished = this.finished;
    const t0 = started ? this.startMs / 1000 : 0;
    const elapsedSec = started ? Math.max(0, (finished ? this.finishT : t) - t0) : 0;
    const distM = started ? (finished ? MARATHON_M : this.dMax) : 0;
    const aheadSec = started ? planTimeAt(plan, finished ? MARATHON_M : dEst) - elapsedSec : 0;
    const lf = this.lastFix;
    const ageSec = lf ? Math.max(0, t - lf.t) : null;
    const gps = {
      ok: started
        ? this.lastAccT != null && t - this.lastAccT <= CFG.goodAgeSec
        : !!lf && ageSec <= 10 && lf.acc <= 30,
      accuracyM: lf ? lf.acc : null,
      ageSec,
      mode, // 'idle' | 'gps' | 'dr' (dead reckoning) | 'plan' (plan pace) | 'done'
    };
    let next = null, nextFuel = null;
    if (started && !finished) {
      for (const e of this._nextList()) {
        if (e.m <= distM) continue;
        const v = { kind: e.kind, label: e.label, detail: e.detail, inM: e.m - distM, atM: e.m };
        if (!next) next = v;
        if (e.fuel) {
          nextFuel = v;
          break;
        }
      }
    }
    return {
      started,
      finished,
      elapsedSec,
      distM,
      progress: distM / MARATHON_M,
      gps,
      aheadSec,
      targetPace: planPaceAt(plan, distM),
      currentPace: started ? this._rollingPace(t) : null,
      kmIndex: Math.min(42, Math.floor(distM / 1000)),
      next,
      nextFuel,
      half: {
        planned: planTimeAt(plan, HALF_M),
        actual: this.halfT != null ? this.halfT - t0 : null,
      },
      finishSec: finished ? this.finishT - t0 : null,
      kmTimes: this.kmT.map((x) => (x == null ? null : x - t0)),
    };
  }

  toJSON() {
    const copy = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
    return {
      v: 1,
      plan: { profile: this.plan.profile, totalSec: this.plan.totalSec },
      settings: { ...this.settings },
      startMs: this.startMs,
      finishT: this.finishT,
      f: copy(this.f),
      anchor: copy(this.anchor),
      cand: copy(this.cand),
      trk: copy(this.trk),
      lastFix: copy(this.lastFix),
      lastAccT: this.lastAccT,
      dMax: this.dMax,
      prevTickT: this.prevTickT,
      fired: copy(this.fired),
      kmT: copy(this.kmT),
      kmAhead: copy(this.kmAhead),
      halfT: this.halfT,
      hist: copy(this.hist),
      pending: copy(this.pending),
      warn: copy(this.warn),
      stats: copy(this.stats),
    };
  }

  static fromJSON(obj, { plan, route } = {}) {
    const o = typeof obj === 'string' ? JSON.parse(obj) : JSON.parse(JSON.stringify(obj));
    const e = new RaceEngine({ plan, route, settings: o.settings });
    for (const k of ['startMs', 'finishT', 'f', 'anchor', 'lastFix', 'lastAccT', 'dMax', 'prevTickT', 'halfT']) {
      if (o[k] !== undefined) e[k] = o[k];
    }
    e.cand = o.cand || [];
    e.trk = o.trk || [];
    e.fired = o.fired || {};
    e.kmT = o.kmT || [];
    e.kmAhead = o.kmAhead || [];
    e.hist = o.hist || [];
    e.pending = o.pending || [];
    e.warn = o.warn || e.warn;
    e.stats = o.stats || e.stats;
    return e;
  }
}
