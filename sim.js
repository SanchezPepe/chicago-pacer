// sim.js: synthetic GPS fixes for a runner following the plan along the route.
// Used by the 60× Rehearsal mode in the UI and by the Node tests. No dependencies.

import { MARATHON_M, planPaceAt } from './plan.js';
import { prepareRoute, routePointAt } from './engine.js';

// Small deterministic PRNG so runs are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0 || 1;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Returns fixes [{ lat, lon, accuracy, t, trueM }] (t in epoch ms) for a runner who runs the
// plan's pace × paceFactor, with a slow ±wobble around it.
//   noiseM     GPS noise per axis (m): slowly drifting bias + white jitter, like real GPS.
//   multipath  [[fromKm, toKm, offsetM]]: urban-canyon zones. Bursts of 2–10 s where fixes jump
//              offsetM×(0.6–1) in a random direction while still reporting 25–60 m accuracy,
//              between 3–15 s stretches of noisier but honest fixes; 5% report > 60 m.
//   dropouts   [[fromKm, toKm]]: no fixes at all while the runner is inside.
// The array also carries .truth(tMs) → true meters, and .finishMs.
export function simulateRun({
  plan,
  route,
  startMs = Date.now(),
  stepSec = 1,
  noiseM = 8,
  multipath = [],
  dropouts = [],
  paceFactor = 1,
  wobble = 0.015,
  seed = 7,
  tailSec = 10,
} = {}) {
  const geo = prepareRoute(route);
  const rnd = mulberry32(seed);
  const uni = (a, b) => a + (b - a) * rnd();
  const gauss = () => {
    let u = 0;
    while (u === 0) u = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };

  // 1) The true trajectory, integrated in 0.5 s steps.
  const H = 0.5;
  const D = [0];
  const phase = rnd() * 2 * Math.PI;
  let t = 0, d = 0, v = 0;
  while (d < MARATHON_M) {
    v = (1000 / planPaceAt(plan, d) / paceFactor) * (1 + wobble * Math.sin((2 * Math.PI * t) / 300 + phase));
    t += H;
    d += v * H;
    D.push(Math.min(d, MARATHON_M));
  }
  const finishSec = t - (d - MARATHON_M) / v;
  const truthSec = (s) => {
    if (!(s > 0)) return 0;
    const i = Math.floor(s / H);
    if (i >= D.length - 1) return MARATHON_M;
    return Math.min(MARATHON_M, D[i] + ((s - i * H) / H) * (D[i + 1] - D[i]));
  };

  // 2) Fixes.
  const tau = 20; // s, correlation time of the GPS bias
  const sBias = noiseM * 0.8, sWhite = noiseM * 0.6;
  let bx = gauss() * sBias, by = gauss() * sBias;
  const zones = multipath.map(([a, b, off]) => ({ a: a * 1000, b: b * 1000, off, bad: false, until: -1, ang: 0, mag: 0 }));
  const drops = dropouts.map(([a, b]) => [a * 1000, b * 1000]);
  const fixes = [];
  const endSec = finishSec + tailSec;
  const decay = Math.exp(-stepSec / tau), kick = Math.sqrt(1 - decay * decay);
  for (let k = 0; k * stepSec <= endSec; k++) {
    const s = k * stepSec;
    bx = decay * bx + kick * sBias * gauss();
    by = decay * by + kick * sBias * gauss();
    const trueM = truthSec(s);
    let ex = bx + sWhite * gauss(), ey = by + sWhite * gauss();
    let acc = noiseM * uni(1.0, 1.6);
    const z = zones.find((q) => trueM >= q.a && trueM < q.b);
    if (z) {
      if (s >= z.until) {
        z.bad = z.until < 0 ? false : !z.bad;
        z.until = s + (z.bad ? uni(2, 10) : uni(3, 15));
        if (z.bad) {
          z.ang = uni(0, 2 * Math.PI);
          z.mag = z.off * uni(0.6, 1.0);
        }
      }
      ex *= 1.5;
      ey *= 1.5;
      if (z.bad) {
        ex += z.mag * Math.cos(z.ang);
        ey += z.mag * Math.sin(z.ang);
        acc = uni(25, 60);
      } else {
        acc = uni(12, 30);
      }
      if (rnd() < 0.05) acc = uni(61, 100);
    }
    if (drops.some(([a, b]) => trueM >= a && trueM < b)) continue;
    const p = routePointAt(geo, trueM);
    fixes.push({
      lat: geo.lat0 + (p.y + ey) / geo.ky,
      lon: geo.lon0 + (p.x + ex) / geo.kx,
      accuracy: Math.round(acc * 10) / 10,
      t: Math.round(startMs + s * 1000),
      trueM,
    });
  }
  fixes.truth = (tMs) => truthSec((tMs - startMs) / 1000);
  fixes.finishMs = startMs + finishSec * 1000;
  return fixes;
}
