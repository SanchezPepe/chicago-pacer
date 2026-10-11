// plan.js: pace plans for the Chicago Marathon pacer.
// Pure functions, no dependencies. Loads in iOS Safari 18 and Node 22.
//
// A plan is { profile, totalSec, segments: [{ a, b, pace, t0, t1 }] } where a/b are km,
// pace is s/km (constant inside the segment), and t0/t1 are the planned clock times at
// a and b. Segments are km 1..42 plus the final 195 m ([42, 42.195]).

export const MARATHON_M = 42195;
export const HALF_M = MARATHON_M / 2;

const END_KM = MARATHON_M / 1000;
const HALF_KM = HALF_M / 1000;

function kmSegments() {
  const segs = [];
  for (let k = 0; k < 42; k++) segs.push({ a: k, b: k + 1 });
  segs.push({ a: 42, b: END_KM });
  return segs;
}
const len = (s) => s.b - s.a;
const mid = (s) => (s.a + s.b) / 2;

// Friend's profile (default): km 1–10 eases 5:10 → 5:00 (10K = 50:50), then a linear ramp
// that starts at 4:57 on km 11 and whose slope is solved so the finish is exactly totalSec.
// hill adds seconds to a whole km, keyed by the km's start (41 → km 42, Roosevelt Rd).
function friendPaces(totalSec, { p11 = 297, hill = { 41: 5 } } = {}) {
  const segs = kmSegments();
  const first = segs.slice(0, 10).map((s, i) => ({ ...s, pace: 310 - (i * 10) / 9 }));
  const rest = segs.slice(10);
  const bump = (s) => hill[s.a] ?? 0;
  const t10 = first.reduce((t, s) => t + len(s) * s.pace, 0);
  const base = rest.reduce((t, s) => t + len(s) * (p11 + bump(s)), 0);
  const lever = rest.reduce((t, s) => t + len(s) * (mid(s) - 10.5), 0);
  const slope = (totalSec - t10 - base) / lever; // ≈ -0.153 s/km per km for 3:29:00
  return [
    ...first,
    ...rest.map((s) => ({ ...s, pace: p11 + slope * (mid(s) - 10.5) + bump(s) })),
  ];
}

// "Halves" profile (first draft): one linear ramp over the whole race, solved so the
// halves are 1:45:00 / 1:44:00 (scaled proportionally for other targets), with +6/+3 s
// on km 1/2 (crowded start) and +5 s on km 42 (Roosevelt Rd hill).
function halvesPaces(totalSec, { bumps = { 0: 6, 1: 3, 41: 5 } } = {}) {
  const h1 = (totalSec * 6300) / 12540;
  const h2 = totalSec - h1;
  const segs = kmSegments();
  const bump = (s) => bumps[s.a] ?? 0;
  // pace(s) = c + m·(mid(s) − HALF_KM) + bump(s). Each half's time is linear in (c, m).
  let L1 = 0, M1 = 0, B1 = 0, L2 = 0, M2 = 0, B2 = 0;
  for (const s of segs) {
    const l1 = Math.max(0, Math.min(s.b, HALF_KM) - s.a);
    const l2 = len(s) - l1;
    const x = mid(s) - HALF_KM;
    L1 += l1; M1 += l1 * x; B1 += l1 * bump(s);
    L2 += l2; M2 += l2 * x; B2 += l2 * bump(s);
  }
  const r1 = h1 - B1, r2 = h2 - B2;
  const det = L1 * M2 - L2 * M1;
  const c = (r1 * M2 - r2 * M1) / det;
  const m = (L1 * r2 - L2 * r1) / det;
  return segs.map((s) => ({ ...s, pace: c + m * (mid(s) - HALF_KM) + bump(s) }));
}

export const PROFILES = ['friend', 'halves'];

export function buildPlan(profile = 'friend', { totalSec = 12540 } = {}) {
  const name = profile === 'halves' ? 'halves' : 'friend';
  const raw = name === 'halves' ? halvesPaces(totalSec) : friendPaces(totalSec);
  let t = 0;
  const segments = raw.map((s) => {
    const t0 = t;
    t += len(s) * s.pace;
    return { a: s.a, b: s.b, pace: s.pace, t0, t1: t };
  });
  // Pin the finish to totalSec exactly (removes ~1e-12 s of float drift).
  const last = segments[segments.length - 1];
  last.t1 = totalSec;
  last.pace = (totalSec - last.t0) / len(last);
  return { profile: name, totalSec, segments };
}

function segIndexAtKm(plan, km) {
  const segs = plan.segments;
  let i = Math.min(segs.length - 1, Math.max(0, Math.floor(km)));
  while (i > 0 && km < segs[i].a) i--;
  while (i < segs.length - 1 && km >= segs[i].b) i++;
  return i;
}

// Planned clock time (s) at a distance in meters. Clamped to [0, totalSec].
export function planTimeAt(plan, meters) {
  const km = meters / 1000;
  if (!(km > 0)) return 0;
  const segs = plan.segments;
  const last = segs[segs.length - 1];
  if (km >= last.b) return last.t1;
  const s = segs[segIndexAtKm(plan, km)];
  return s.t0 + (km - s.a) * s.pace;
}

// Planned pace (s/km) at a distance in meters.
export function planPaceAt(plan, meters) {
  const km = Math.min(Math.max(meters / 1000, 0), END_KM - 1e-9);
  return plan.segments[segIndexAtKm(plan, km)].pace;
}

// Inverse of planTimeAt: distance (m) the plan reaches at a clock time (s).
export function planDistAt(plan, sec) {
  if (!(sec > 0)) return 0;
  const segs = plan.segments;
  const last = segs[segs.length - 1];
  if (sec >= last.t1) return MARATHON_M;
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (segs[m].t1 <= sec) lo = m + 1;
    else hi = m;
  }
  const s = segs[lo];
  return Math.min(MARATHON_M, (s.a + (sec - s.t0) / s.pace) * 1000);
}

// [{ km, splitSec, cumSec }] for km 1..42 and 42.195.
export function kmSplits(plan) {
  return plan.segments.map((s) => ({
    km: Math.round(s.b * 1000) / 1000,
    splitSec: s.t1 - s.t0,
    cumSec: s.t1,
  }));
}

const pad2 = (n) => String(n).padStart(2, '0');

// fmtClock(6337.4) is '1:45:37'; fmtClock(3050) is '50:50'. Rounds to the nearest second.
export function fmtClock(sec) {
  if (sec == null || !Number.isFinite(sec)) return '–:––';
  const neg = sec < 0;
  const s = Math.round(Math.abs(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const body = h > 0 ? `${h}:${pad2(m)}:${pad2(ss)}` : `${m}:${pad2(ss)}`;
  return (neg && s > 0 ? '-' : '') + body;
}

// fmtPace(297.25) is '4:57'.
export function fmtPace(secPerKm) {
  if (secPerKm == null || !Number.isFinite(secPerKm) || secPerKm <= 0) return '–:––';
  const s = Math.round(secPerKm);
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}
