// tests/sweep.mjs: robustness sweep over random seeds (not part of the required tests).
// node tests/sweep.mjs [seeds=20]
import { buildPlan } from '../plan.js';
import { loadRoute, runRace } from './harness.mjs';
const { route } = await loadRoute();
const plan = buildPlan('friend');
const N = Number(process.argv[2] || 20);
let worst = { err: 0 }, fails = 0;
for (const pf of [1, 0.98, 1.03]) {
  const errs = [], kms = [];
  for (let seed = 1; seed <= N; seed++) {
    const r = runRace({ route, plan, paceFactor: pf, seed });
    const kmOff = r.cues.filter((c) => /^km\d+$/.test(c.id)).map((c) => Math.abs(c.trueM - Number(c.id.slice(2)) * 1000));
    const nKm = kmOff.length, wk = Math.max(...kmOff);
    errs.push(Math.abs(r.maxErr)); kms.push(wk);
    const bad = Math.abs(r.maxErr) >= 10 || wk > 50 || nKm !== 42;
    if (bad) { fails++; console.log(`FAIL pf ${pf} seed ${seed}: err ${r.maxErr.toFixed(1)} s at ${(r.maxErrAtM/1000).toFixed(2)} km, worst km ${wk.toFixed(0)} m, km cues ${nKm}, reanchors ${r.eng.stats.reanchors}`); }
    if (Math.abs(r.maxErr) > Math.abs(worst.err)) worst = { err: r.maxErr, pf, seed, at: r.maxErrAtM };
  }
  errs.sort((a, b) => a - b); kms.sort((a, b) => a - b);
  console.log(`pf ${pf}: aheadErr median ${errs[N >> 1].toFixed(1)} max ${errs[N - 1].toFixed(1)} s | worst km cue median ${kms[N >> 1].toFixed(0)} max ${kms[N - 1].toFixed(0)} m`);
}
console.log('worst', JSON.stringify(worst), 'fails', fails, '/', 3 * N);
