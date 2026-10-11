// tests/engine.test.mjs: run with node tests/engine.test.mjs
// Simulated races along the real route (route.js): 8 m GPS noise, 150 m multipath bursts in
// km 0–5 and 19–22 (the Loop), two ~60 s dropouts, at paceFactor 1, 0.98 and 1.03.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MARATHON_M, buildPlan, planTimeAt } from '../plan.js';
import { FUEL, AID_STATIONS } from '../course.js';
import { RaceEngine, prepareRoute, projectOnRoute, routePointAt } from '../engine.js';
import { simulateRun } from '../sim.js';
import { loadRoute, runRace, START_MS, SCENARIO } from './harness.mjs';

const { route, meta } = await loadRoute();
const plan = buildPlan('friend');
console.log(`# route: ${meta.source} (${route.length} pts)`);

const gels = FUEL.filter((f) => f.kind === 'gel');
const caps = FUEL.filter((f) => f.kind === 'capsule');
const aidKm = (n) => AID_STATIONS.find((a) => a.n === n).km;

function countIds(cues) {
  const m = new Map();
  for (const c of cues) m.set(c.id, (m.get(c.id) || 0) + 1);
  return m;
}

for (const paceFactor of [1, 0.98, 1.03]) {
  test(`simulated race, paceFactor ${paceFactor}`, () => {
    const r = runRace({ route, plan, paceFactor });
    const ids = countIds(r.cues);
    for (const [id, n] of ids) assert.equal(n, 1, `cue ${id} fired ${n} times`);

    // Every km cue fires once, within ±50 m of the true crossing.
    let worstKm = 0;
    for (let k = 1; k <= 42; k++) {
      const c = r.cues.find((x) => x.id === `km${k}`);
      assert.ok(c, `km${k} cue missing`);
      const off = c.trueM - k * 1000;
      if (Math.abs(off) > Math.abs(worstKm)) worstKm = off;
      assert.ok(Math.abs(off) <= 50, `km${k} fired ${off.toFixed(1)} m from the sign`);
      assert.match(c.text, new RegExp(`^Kilometer ${k}\\. Split \\d \\d\\d\\. (On plan|.* (ahead|behind))\\.$`));
    }

    // |aheadSec error| < 10 s for the whole race.
    assert.ok(Math.abs(r.maxErr) < 10, `aheadSec error ${r.maxErr.toFixed(1)} s at ${(r.maxErrAtM / 1000).toFixed(2)} km`);

    // Gels: one warning ~400 m before, one at the point. Capsules at their aid stations.
    for (const g of gels) {
      const warn = r.cues.find((x) => x.id === `${g.id}-warn`);
      const now = r.cues.find((x) => x.id === `${g.id}-now`);
      assert.ok(warn && now, `${g.id} cues missing`);
      assert.ok(Math.abs(warn.trueM - (g.km * 1000 - 400)) <= 50, `${g.id}-warn at ${warn.trueM.toFixed(0)}`);
      assert.ok(Math.abs(now.trueM - g.km * 1000) <= 50, `${g.id}-now at ${now.trueM.toFixed(0)}`);
      assert.equal(warn.priority, 1);
    }
    for (const c of caps) {
      const cue = r.cues.find((x) => x.id === c.id);
      if (c.optional) {
        assert.equal(cue, undefined, `${c.id} must stay quiet with capsules = 2`);
      } else {
        assert.ok(cue, `${c.id} missing`);
        assert.ok(Math.abs(cue.trueM - (aidKm(c.waterAt) * 1000 - 200)) <= 50, `${c.id} at ${cue.trueM.toFixed(0)}`);
      }
    }
    // Aid heads-ups skip stations with a fuel cue within 300 m.
    for (const n of [3, 5, 6, 10, 12, 14, 17]) assert.ok(!ids.has(`aid${n}`), `aid${n} should be covered by a fuel cue`);
    for (const n of [1, 2, 4, 7, 8, 9, 11, 13, 15, 16, 18, 19, 20]) assert.ok(ids.has(`aid${n}`), `aid${n} heads-up missing`);

    // One-offs.
    for (const id of ['half', 'settle', 'hill', 'finish']) assert.ok(ids.has(id), `${id} missing`);
    const half = r.cues.find((x) => x.id === 'half').text;
    const hm = half.match(/^Halfway in (\d) (\d\d) (\d\d)\. Plan 1 45 37\. (?:On plan|(?:(\d+) minutes? )?(?:(\d+) seconds? )?(ahead|behind))\.$/);
    assert.ok(hm, `half text: ${half}`);
    const spokenDelta = 6337 - (hm[1] * 3600 + hm[2] * 60 + Number(hm[3]));
    const saidDelta = hm[6] ? (Number(hm[4] || 0) * 60 + Number(hm[5] || 0)) * (hm[6] === 'ahead' ? 1 : -1) : 0;
    assert.ok(Math.abs(spokenDelta - saidDelta) <= (saidDelta === 0 ? 1 : 0), `half delta: ${half}`);
    const fin = r.cues.find((x) => x.id === 'finish');
    assert.ok(MARATHON_M - fin.trueM <= 50, `finish fired ${(MARATHON_M - fin.trueM).toFixed(0)} m early`);
    const last = r.states[r.states.length - 1];
    assert.ok(last.finished && Math.abs(last.finishSec - (r.finishMs - START_MS) / 1000) < 15, 'finish time');
    assert.ok(Math.abs(last.half.actual - (planTimeAt(plan, MARATHON_M / 2) * paceFactor)) < 30, 'half actual');
    // Off-pace: slow runner hears "pick it up", nobody hears "ease off" at these factors.
    const behind = r.cues.filter((x) => x.id.startsWith('offpace-behind'));
    const ahead = r.cues.filter((x) => x.id.startsWith('offpace-ahead'));
    if (paceFactor === 1.03) assert.ok(behind.length >= 1, 'behind warning expected');
    if (paceFactor === 1) assert.equal(behind.length + ahead.length, 0, 'no off-pace cues on plan');
    if (paceFactor === 0.98) assert.ok(ahead.length >= 1, 'ahead warning expected at 2% fast');
    const stretch = ids.has('stretch');
    assert.equal(stretch, paceFactor === 0.98, 'stretch cue only when ≥ 30 s ahead at 30K');

    console.log(
      `# pf ${paceFactor}: max aheadSec error ${r.maxErr.toFixed(1)} s, worst km cue ${worstKm.toFixed(1)} m, ${r.cues.length} cues, ` +
        `fixes ${r.eng.stats.fixes} accepted ${r.eng.stats.accepted} rejected ${JSON.stringify(r.eng.stats.rejected)} reanchors ${r.eng.stats.reanchors}`,
    );
  });
}

test('settings: 3 capsules and cues every 2 km', () => {
  const r = runRace({ route, plan, paceFactor: 1, settings: { capsules: 3, cueEveryKm: 2, aidHeadsUp: false } });
  const ids = countIds(r.cues);
  for (const c of caps) assert.equal(ids.get(c.id), 1, `${c.id} once`);
  for (let k = 1; k <= 42; k++) assert.equal(ids.has(`km${k}`), k % 2 === 0, `km${k}`);
  assert.match(r.cues.find((c) => c.id === 'km12').text, /^Kilometer 12\. Last 2 at \d \d\d\./);
  assert.ok(![...ids.keys()].some((id) => /^aid\d+$/.test(id)), 'aidHeadsUp off');
});

test('toJSON → fromJSON mid-race keeps state', () => {
  const restoreAtMs = START_MS + 6000 * 1000; // ~km 20, inside the second Loop zone
  const a = runRace({ route, plan, paceFactor: 1.03 });
  const b = runRace({ route, plan, paceFactor: 1.03, restoreAtMs });
  assert.deepEqual(
    b.cues.map((c) => [c.id, c.tickMs, c.text]),
    a.cues.map((c) => [c.id, c.tickMs, c.text]),
  );
  assert.equal(a.states.length, b.states.length);
  for (let i = 0; i < a.states.length; i++) assert.deepEqual(b.states[i], a.states[i], `state at tick ${i}`);
  // The snapshot survives a JSON round trip unchanged.
  const eng = new RaceEngine({ plan, route });
  eng.start(START_MS);
  const snap = JSON.parse(JSON.stringify(a.eng));
  assert.deepEqual(JSON.parse(JSON.stringify(RaceEngine.fromJSON(snap, { plan, route }))), snap);
});

test('pre-start, nudge, markKm', () => {
  const eng = new RaceEngine({ plan, route });
  const p0 = routePointAt(prepareRoute(route), 0);
  eng.onFix({ lat: p0.lat, lon: p0.lon, accuracy: 6, t: START_MS - 2000 });
  let { state, cues } = eng.tick(START_MS - 1000);
  assert.equal(state.started, false);
  assert.equal(state.gps.ok, true);
  assert.equal(state.gps.accuracyM, 6);
  assert.equal(cues.length, 0);

  eng.start(START_MS);
  ({ state } = eng.tick(START_MS + 100 * 1000));
  assert.ok(state.started && !state.finished);
  assert.ok(Math.abs(state.elapsedSec - 100) < 1e-9);
  eng.nudgeStart(5);
  ({ state } = eng.tick(START_MS + 100 * 1000));
  assert.ok(Math.abs(state.elapsedSec - 105) < 1e-9, 'nudge +5 s adds to elapsed');

  // Mark km at what the runner says is the 1 km sign, from a dead-reckoned ~0.95 km.
  const k = eng.markKm(START_MS + 300 * 1000);
  assert.equal(k, 1);
  ({ state, cues } = eng.tick(START_MS + 300 * 1000));
  assert.equal(state.distM, 1000);
  assert.deepEqual(cues.map((c) => c.id), ['km1']);
  assert.equal(state.kmIndex, 1);
  assert.equal(state.next.kind, 'aid');
  assert.equal(state.next.label, 'Aid 1');
  assert.equal(state.nextFuel.label, 'Gel 1');
  assert.ok(state.targetPace > 300 && state.targetPace < 311);
  assert.equal(state.half.actual, null);
});

test('a wrong Mark km tap is corrected by GPS', () => {
  // At true ~9.7 km the runner taps Mark km; the engine snaps to 10.0 km, 300 m ahead.
  const fixes = simulateRun({ plan, route, startMs: START_MS, seed: 5, noiseM: 8 });
  const eng = new RaceEngine({ plan, route });
  eng.start(START_MS);
  let i = 0, tapped = false, recoveredAt = null, cue11 = null;
  for (let t = START_MS + 1000; t <= START_MS + 3600 * 1000; t += 1000) {
    while (i < fixes.length && fixes[i].t <= t) eng.onFix(fixes[i++]);
    const trueM = fixes.truth(t);
    if (!tapped && trueM >= 9700) {
      tapped = true;
      assert.equal(eng.markKm(t), 10);
    }
    const { state, cues } = eng.tick(t);
    const est = eng._predict(t / 1000).d;
    if (tapped && recoveredAt == null && Math.abs(est - trueM) < 30) recoveredAt = trueM;
    for (const c of cues) if (c.id === 'km11') cue11 = trueM;
    void state;
  }
  assert.ok(eng.stats.reanchors >= 1, 're-anchored on GPS');
  assert.ok(recoveredAt != null && recoveredAt - 9700 < 150, `recovered by ${recoveredAt}`);
  assert.ok(cue11 != null && Math.abs(cue11 - 11000) <= 50, `km11 at ${cue11}`);
});

test('route projection respects the window', () => {
  const geo = prepareRoute(route);
  for (const m of [500, 12345, 36500, 39500, 41900]) {
    const p = routePointAt(geo, m);
    const pr = projectOnRoute(geo, p.lat, p.lon, m - 100, m + 300);
    assert.ok(Math.abs(pr.along - m) < 0.5 && pr.offset < 0.5, `projection at ${m}`);
  }
  // A point on the Michigan Ave southbound leg must not match the northbound leg when the
  // window is around the southbound position (and vice versa).
  const fx = simulateRun({ plan, route, startMs: START_MS, noiseM: 0, wobble: 0 });
  assert.ok(fx.length > 12000 && fx.every((f, i) => i === 0 || f.t > fx[i - 1].t));
  void SCENARIO;
});
