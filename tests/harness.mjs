// tests/harness.mjs: drives RaceEngine with simulated fixes on a 1 Hz clock and measures it
// against the simulator's ground truth. Used by engine.test.mjs; run directly for a report.

import { buildPlan, planTimeAt, MARATHON_M } from '../plan.js';
import { RaceEngine } from '../engine.js';
import { simulateRun } from '../sim.js';

export const START_MS = Date.UTC(2026, 9, 11, 12, 40, 0); // 7:40 AM CDT
export const SCENARIO = {
  noiseM: 8,
  multipath: [
    [0, 5, 150],
    [19, 22, 150],
  ],
  // Two ~60 s dropouts: one across the km 13 sign, one across gel 4 (km 28.9).
  dropouts: [
    [12.9, 13.105],
    [28.75, 28.955],
  ],
};

export async function loadRoute() {
  try {
    const mod = await import('../route.js');
    if (Array.isArray(mod.ROUTE) && mod.ROUTE.length > 1) return { route: mod.ROUTE, meta: mod.ROUTE_META || {} };
  } catch {
    // fall through to the synthetic route
  }
  const { SYNTH_ROUTE } = await import('./synth_route.mjs');
  return { route: SYNTH_ROUTE, meta: { source: 'synthetic test route' } };
}

// restoreAtMs: serialize → JSON → fromJSON at that tick and continue with the restored engine.
export function runRace({ plan = buildPlan('friend'), route, paceFactor = 1, seed = 11, settings = {}, scenario = SCENARIO, restoreAtMs = null, onTick = null }) {
  const fixes = simulateRun({ plan, route, startMs: START_MS, paceFactor, seed, ...scenario });
  let eng = new RaceEngine({ plan, route, settings });
  eng.start(START_MS);
  const cues = [];
  const states = [];
  let maxErr = 0, maxErrAtM = 0, maxErrMs = 0;
  let i = 0;
  const endMs = fixes.finishMs + 30000;
  for (let t = START_MS + 1000; t <= endMs; t += 1000) {
    while (i < fixes.length && fixes[i].t <= t) eng.onFix(fixes[i++]);
    if (restoreAtMs != null && t === restoreAtMs) {
      eng = RaceEngine.fromJSON(JSON.parse(JSON.stringify(eng)), { plan, route });
    }
    const { state, cues: out } = eng.tick(t);
    const trueM = fixes.truth(t);
    for (const c of out) cues.push({ ...c, tickMs: t, trueM });
    if (!state.finished) {
      const err = state.aheadSec - (planTimeAt(plan, trueM) - state.elapsedSec);
      if (Math.abs(err) > Math.abs(maxErr)) {
        maxErr = err;
        maxErrAtM = trueM;
        maxErrMs = t;
      }
    }
    states.push(state);
    if (onTick) onTick(t, state, trueM, eng);
  }
  return { fixes, cues, states, maxErr, maxErrAtM, maxErrMs, eng, finishMs: fixes.finishMs };
}

// Report: run directly with node tests/harness.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
  const { route, meta } = await loadRoute();
  console.log('route:', meta.source, route.length, 'pts');
  for (const pf of [1, 0.98, 1.03]) {
    const r = runRace({ route, paceFactor: pf });
    const kmErr = r.cues.filter((c) => /^km\d+$/.test(c.id)).map((c) => c.trueM - Number(c.id.slice(2)) * 1000);
    const worstKm = kmErr.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
    console.log(
      `pf ${pf}: maxAheadErr ${r.maxErr.toFixed(1)} s at ${(r.maxErrAtM / 1000).toFixed(2)} km, km cues ${kmErr.length}, worst km offset ${worstKm.toFixed(1)} m, cues ${r.cues.length}, stats ${JSON.stringify(r.eng.stats)}`,
    );
  }
  void MARATHON_M;
}
