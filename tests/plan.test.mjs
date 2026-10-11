// tests/plan.test.mjs: run with node tests/plan.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { MARATHON_M, buildPlan, planTimeAt, planPaceAt, planDistAt, kmSplits, fmtClock, fmtPace } from '../plan.js';
import { AID_STATIONS, FUEL, MARKERS, NOTES } from '../course.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, want ${b} ±${tol}`);

test('friend profile matches table A.1', () => {
  const p = buildPlan();
  assert.equal(p.profile, 'friend');
  assert.equal(p.totalSec, 12540);
  close(planTimeAt(p, 10000), 3050, 1e-9, '10K');
  close(planTimeAt(p, MARATHON_M / 2), 6337, 1, 'half (1:45:37)');
  assert.equal(fmtClock(planTimeAt(p, MARATHON_M / 2)), '1:45:37');
  const s = kmSplits(p);
  assert.equal(s.length, 43);
  assert.equal(fmtClock(s[29].cumSec), '2:29:21', 'km 30');
  assert.equal(fmtClock(s[41].cumSec), '3:28:03', 'km 42');
  assert.equal(planTimeAt(p, MARATHON_M), 12540, 'finish exactly');
  assert.equal(s[42].km, 42.195);
  assert.equal(s[42].cumSec, 12540);
  // A.1 spot checks: paces and clocks
  assert.equal(fmtPace(s[0].splitSec), '5:10');
  assert.equal(fmtPace(s[9].splitSec), '5:00');
  assert.equal(fmtPace(s[10].splitSec), '4:57');
  assert.equal(fmtPace(s[40].splitSec), '4:52');
  assert.equal(fmtPace(s[41].splitSec), '4:57', 'km 42 hill +5 s');
  assert.equal(fmtPace(s[42].splitSec / 0.195), '4:52');
  const fiveK = [25 * 60 + 39, 50 * 60 + 50, 4533, 6013, 7489, 8961, 10429, 11893];
  MARKERS.fiveK.forEach((km, i) => assert.equal(fmtClock(planTimeAt(p, km * 1000)), fmtClock(fiveK[i]), `${km}K`));
});

test('halves profile is 6300 / 6240', () => {
  const p = buildPlan('halves');
  assert.equal(p.profile, 'halves');
  close(planTimeAt(p, MARATHON_M / 2), 6300, 1e-6, 'first half');
  close(p.totalSec - planTimeAt(p, MARATHON_M / 2), 6240, 1e-6, 'second half');
  assert.equal(planTimeAt(p, MARATHON_M), 12540);
  const s = kmSplits(p);
  assert.equal(fmtClock(s[9].cumSec), '49:58', '10K');
  assert.ok(s[0].splitSec > s[2].splitSec && s[1].splitSec > s[2].splitSec, '+6/+3 s on km 1/2');
  close(s[41].splitSec - s[40].splitSec, 5, 0.5, '+5 s on km 42');
});

test('custom finish target is solved exactly', () => {
  for (const prof of ['friend', 'halves']) {
    const p = buildPlan(prof, { totalSec: 12300 });
    assert.equal(planTimeAt(p, MARATHON_M), 12300);
  }
});

test('cumulative times strictly increase; lookups are consistent', () => {
  for (const prof of ['friend', 'halves']) {
    const p = buildPlan(prof);
    const s = kmSplits(p);
    for (let i = 1; i < s.length; i++) assert.ok(s[i].cumSec > s[i - 1].cumSec, `${prof} km ${s[i].km}`);
    let prev = -1;
    for (let m = 0; m <= MARATHON_M; m += 50) {
      const t = planTimeAt(p, m);
      assert.ok(t > prev || m === 0, `${prof} planTimeAt increases at ${m}`);
      prev = t;
      close(planDistAt(p, t), m, 1e-6, `${prof} planDistAt inverse at ${m}`);
    }
    assert.equal(planPaceAt(p, 0), p.segments[0].pace);
    assert.equal(planPaceAt(p, 41500), p.segments[41].pace);
    assert.equal(planPaceAt(p, MARATHON_M), p.segments[42].pace);
    assert.equal(planTimeAt(p, -5), 0);
    assert.equal(planTimeAt(p, 50000), 12540);
  }
});

test('fmt helpers', () => {
  assert.equal(fmtClock(6337.37), '1:45:37');
  assert.equal(fmtClock(3050), '50:50');
  assert.equal(fmtClock(59.6), '1:00');
  assert.equal(fmtClock(3599.5), '1:00:00');
  assert.equal(fmtClock(0), '0:00');
  assert.equal(fmtClock(-12.4), '-0:12');
  assert.equal(fmtClock(NaN), '–:––');
  assert.equal(fmtPace(297.25), '4:57');
  assert.equal(fmtPace(299.6), '5:00');
  assert.equal(fmtPace(310), '5:10');
  assert.equal(fmtPace(null), '–:––');
});

test('course data matches plan A.2 / A.2b', () => {
  assert.equal(AID_STATIONS.length, 20);
  assert.deepEqual(
    AID_STATIONS.map((a) => a.km),
    [2.6, 5.2, 8.1, 9.3, 11.7, 14.3, 16.3, 18.0, 20.1, 22.2, 23.7, 25.3, 27.5, 29.3, 30.4, 32.7, 36.2, 37.2, 39.4, 40.7],
  );
  assert.deepEqual(AID_STATIONS.filter((a) => !a.approx).map((a) => a.n), [1, 2, 3, 4, 7, 12, 16]);
  assert.equal(AID_STATIONS[2].mile, 5.05);
  const gels = FUEL.filter((f) => f.kind === 'gel');
  assert.deepEqual(gels.map((g) => [g.km, g.waterAt]), [[7.8, 3], [13.9, 6], [21.8, 10], [28.9, 14], [35.8, 17]]);
  const caps = FUEL.filter((f) => f.kind === 'capsule');
  assert.deepEqual(caps.map((c) => [c.km, c.waterAt, c.optional]), [[11.7, 5, false], [25.3, 12, false], [32.7, 16, true]]);
  const pre = FUEL.filter((f) => f.kind === 'pre');
  assert.ok(pre.every((f) => f.km === null) && pre.some((f) => f.id === 'gu1'));
  for (const g of [...gels, ...caps]) {
    const aid = AID_STATIONS.find((a) => a.n === g.waterAt);
    assert.ok(aid && aid.km >= g.km && aid.km - g.km <= 0.45, `${g.id} lands before its water`);
  }
  assert.equal(MARKERS.miles.length, 26);
  assert.equal(MARKERS.miles[25].km, 41.843);
  assert.equal(MARKERS.half, 21.0975);
  assert.ok(NOTES.length >= 4 && NOTES.every((n) => typeof n.km === 'number' && n.text));
});
