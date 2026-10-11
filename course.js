// course.js: race-day data for the Chicago Marathon pacer (plan sections A.1–A.3).
// Distances are course km. The route line itself lives in route.js.

const MI = 1.609344;
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

// 20 aid stations (Gatorade, then water; medical, toilets). approx = estimated from the
// official 2026 PDF map ("≈" in plan A.2); the others come from the official site or guide.
// `where` is the neighborhood only, since exact blocks are estimates.
const AID_RAW = [
  [1, 2.6, false, 'The Loop'],
  [2, 5.2, false, 'River North'],
  [3, 8.1, false, 'Lincoln Park', 5.05],
  [4, 9.3, false, 'Lincoln Park'],
  [5, 11.7, true, 'Lakeview'],
  [6, 14.3, true, 'Lakeview'],
  [7, 16.3, false, 'Lincoln Park'],
  [8, 18.0, true, 'Old Town'],
  [9, 20.1, true, 'River North'],
  [10, 22.2, true, 'Greektown'],
  [11, 23.7, true, 'West Loop'],
  [12, 25.3, false, 'United Center'],
  [13, 27.5, true, 'West Loop'],
  [14, 29.3, true, 'Little Italy'],
  [15, 30.4, true, 'University Village'],
  [16, 32.7, false, 'Pilsen'],
  [17, 36.2, true, 'Michigan Ave'],
  [18, 37.2, true, 'Bronzeville'],
  [19, 39.4, true, 'Near South Side'],
  [20, 40.7, true, 'South Loop'],
];

export const AID_STATIONS = AID_RAW.map(([n, km, approx, where, mile]) => ({
  n,
  km,
  mile: mile ?? r2(km / MI),
  approx,
  where,
}));

// Water-refill stations sit just before these aid stations; bananas at 16–18.
export const REFILL_BEFORE_AID = [4, 7, 12, 16];
export const BANANAS_AT_AID = [16, 17, 18];

// Fuel plan (A.2) and sodium capsules (A.2b). Gels go ~400 m before the aid station named in
// waterAt (an AID_STATIONS n) and are chased with water. Capsules are taken at their aid
// station with a full cup of water. kind 'pre' items happen before the start (km null).
export const FUEL = [
  {
    id: 'cap0', kind: 'pre', n: 0, label: 'Salt capsule', product: 'Salt capsule',
    km: null, when: '4:45 AM', waterAt: null, optional: false,
    detail: 'At breakfast with ~500 ml water. Also tests how your stomach takes it.',
  },
  {
    id: 'gu1', kind: 'pre', n: 0, label: 'GU #1', product: 'GU',
    km: null, when: '7:15 AM', waterAt: null, optional: false,
    detail: '22 g, caffeine. In the corral, with sips from your bottle.',
  },
  {
    id: 'gel1', kind: 'gel', n: 1, label: 'Gel 1', product: 'Beta Fuel',
    km: 7.8, planClock: '0:40', waterAt: 3, optional: false,
    detail: 'Beta Fuel, 40 g. Water at Aid 3.',
  },
  {
    id: 'cap1', kind: 'capsule', n: 1, label: 'Salt capsule 1', product: 'Salt capsule',
    km: 11.7, planClock: '1:00', waterAt: 5, optional: false,
    detail: 'At Aid 5, swallowed whole with a full cup of water.',
  },
  {
    id: 'gel2', kind: 'gel', n: 2, label: 'Gel 2', product: 'Beta Fuel',
    km: 13.9, planClock: '1:10', waterAt: 6, optional: false,
    detail: 'Beta Fuel, 40 g. Water at Aid 6.',
  },
  {
    id: 'gel3', kind: 'gel', n: 3, label: 'Gel 3', product: 'Beta Fuel + Electrolyte',
    km: 21.8, planClock: '1:49', waterAt: 10, optional: false,
    detail: 'Beta Fuel + Electrolyte, 40 g, 200 mg sodium. Water at Aid 10.',
  },
  {
    id: 'cap2', kind: 'capsule', n: 2, label: 'Salt capsule 2', product: 'Salt capsule',
    km: 25.3, planClock: '2:06', waterAt: 12, optional: false,
    detail: 'At Aid 12, swallowed whole with a full cup of water.',
  },
  {
    id: 'gel4', kind: 'gel', n: 4, label: 'Gel 4', product: 'Beta Fuel + Electrolyte',
    km: 28.9, planClock: '2:24', waterAt: 14, optional: false,
    detail: 'Beta Fuel + Electrolyte, 40 g, 200 mg sodium. Water at Aid 14.',
  },
  {
    id: 'cap3', kind: 'capsule', n: 3, label: 'Salt capsule 3', product: 'Salt capsule',
    km: 32.7, planClock: '2:42', waterAt: 16, optional: true,
    detail: 'Optional, at Aid 16: only if it is hot or you are a salty sweater.',
  },
  {
    id: 'gel5', kind: 'gel', n: 5, label: 'Gel 5', product: 'GU #2',
    km: 35.8, planClock: '2:58', waterAt: 17, optional: false,
    detail: 'GU #2, 22 g, caffeine. Peaks right around the finish. Water at Aid 17.',
  },
];

export const MARKERS = {
  miles: Array.from({ length: 26 }, (_, i) => ({ mile: i + 1, km: r3((i + 1) * MI) })),
  fiveK: [5, 10, 15, 20, 25, 30, 35, 40],
  half: 21.0975,
};

export const NOTES = [
  { km: 0, text: 'GPS is unreliable in the Loop for the first 5 km. The app dead-reckons on pace; trust the km signs over your watch.' },
  { km: 0.5, text: 'Tuck in with the 3:35 pace group (also in Corral E, ~5:06/km). Edge ahead of it by km 8–10.' },
  { km: 19, text: 'Back into the Loop (~km 19–22): GPS is unreliable again. Hold effort and ignore pace jumps.' },
  { km: 30, text: '30K decision: if it feels easy, stretch to 4:48–4:50/km (≈3:28 finish). Otherwise hold 4:53.' },
  { km: 34.1, text: 'Cooling zone near mile 21.2 (Cermak & Archer).' },
  { km: 41.843, text: 'Mile 26: right onto Roosevelt Rd, a short climb over the rail yards. Then left onto Columbus, ~300 m to go.' },
];

// Plan checkpoints (A.1 rule 3).
export const CHECKPOINTS = [
  { km: 10, text: '10K between 50:30 and 51:00' },
  { km: 21.0975, text: 'Half no slower than 1:46:00' },
  { km: 30, text: '30K around 2:29:20' },
];
