// Sanity check for route.js in Node 22: node tools/check_route.mjs
import { ROUTE, ROUTE_META } from '../route.js';

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
function hav(a, b) {
  const dLa = rad(b[0] - a[0]);
  const dLo = rad(b[1] - a[1]);
  const h = Math.sin(dLa / 2) ** 2 +
      Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

let errors = 0;
const fail = (m) => { errors++; console.log('FAIL', m); };
if (!Array.isArray(ROUTE) || ROUTE.length < 1000) fail('ROUTE too short');
if (ROUTE[0][2] !== 0) fail('first cumM != 0');
if (ROUTE[ROUTE.length - 1][2] !== 42195) fail('last cumM != 42195');
let maxGapCum = 0, maxGapGeo = 0, raw = 0;
for (let i = 1; i < ROUTE.length; i++) {
  const dc = ROUTE[i][2] - ROUTE[i - 1][2];
  if (!(dc > 0)) fail(`non-monotonic at ${i}`);
  const dg = hav(ROUTE[i - 1], ROUTE[i]);
  raw += dg;
  maxGapCum = Math.max(maxGapCum, dc);
  maxGapGeo = Math.max(maxGapGeo, dg);
}
if (maxGapCum > 40) fail(`cum gap ${maxGapCum}`);
if (maxGapGeo > 40) fail(`geo gap ${maxGapGeo}`);
for (const k of ['rawLengthM', 'scale', 'source', 'builtAt']) {
  if (!(k in ROUTE_META)) fail(`ROUTE_META.${k} missing`);
}
console.log(JSON.stringify({
  points: ROUTE.length,
  rawLengthM: ROUTE_META.rawLengthM,
  remeasuredRawM: Math.round(raw * 10) / 10,
  scale: ROUTE_META.scale,
  maxGapCumM: Math.round(maxGapCum * 10) / 10,
  maxGapGeoM: Math.round(maxGapGeo * 10) / 10,
  source: ROUTE_META.source,
  builtAt: ROUTE_META.builtAt,
}));
console.log(errors ? `${errors} problem(s)` : 'OK');
process.exit(errors ? 1 : 0);
