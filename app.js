// Chicago Pacer: UI, voice, wake lock, GPS, persistence and rehearsal.
// Logic lives in plan.js / course.js / engine.js / sim.js (core) and route.js (route).
import { buildPlan, planTimeAt, kmSplits, fmtClock, fmtPace } from './plan.js';
import { AID_STATIONS, FUEL, MARKERS } from './course.js';
import { RaceEngine } from './engine.js';
import { simulateRun } from './sim.js';
import { ROUTE } from './route.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------------------------ storage
const SETTINGS_KEY = 'pacer.settings.v1';
const RACE_KEY = 'pacer.race.v1';
const MAX_RACE_AGE_MS = 7 * 3600 * 1000;
const DEFAULTS = { profile: 'friend', totalSec: 12540, cueEveryKm: 1, capsules: 2, stretchCue: true, aidHeadsUp: true, voice: true };

function loadJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or private mode */ }
}

let settings = { ...DEFAULTS, ...(loadJSON(SETTINGS_KEY) || {}) };
const engineSettings = () => ({
  cueEveryKm: Number(settings.cueEveryKm) === 2 ? 2 : 1,
  aidHeadsUp: !!settings.aidHeadsUp,
  capsules: Number(settings.capsules) === 3 ? 3 : 2,
  stretchCue: !!settings.stretchCue,
  voice: !!settings.voice,
});

// ------------------------------------------------------------------ app state
let plan = buildPlan(settings.profile, { totalSec: settings.totalSec });
let engine = null;
let mode = 'idle';            // 'idle' | 'race' | 'rehearsal'
let tickTimer = 0;
let saveTimer = 0;
let startedAt = 0;            // wall-clock ms of the START tap (race mode)
let nudgeTotal = 0;           // seconds, negative = start moved earlier
let rehearsal = null;
let lastState = null;

window.__cueLog = [];
window.__state = null;
window.__voice = null;   // set below, for the verifier
window.__mode = mode;
window.__rehearsal = null;

const params = new URLSearchParams(location.search);
const simRate = Math.max(0, Math.min(2000, Number(params.get('sim')) || 0));

// ------------------------------------------------------------------ formatting
const MINUS = '\u2212';
function slots(str) {
  let html = '';
  for (const ch of String(str)) {
    if (ch >= '0' && ch <= '9') html += `<span class="d">${ch}</span>`;
    else if (ch === ':' || ch === '.') html += `<span class="s">${ch}</span>`;
    else if (ch === '+' || ch === MINUS || ch === '–') html += `<span class="g">${ch}</span>`;
    else html += esc(ch);
  }
  return html;
}
function setNum(el, str) {
  if (!el || el._v === str) return;
  el._v = str;
  el.innerHTML = slots(str);
}
function setText(el, str) {
  if (!el || el._t === str) return;
  el._t = str;
  el.textContent = str;
}
function fmtDelta(sec) {
  const r = Math.round(sec);
  const s = Math.abs(r);
  const sign = r > 0 ? '+' : r < 0 ? MINUS : '';
  return `${sign}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtDist(m) {
  if (!Number.isFinite(m)) return '';
  if (m < 1000) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}
function paceOrDash(p) {
  return Number.isFinite(p) && p > 0 && p < 1200 ? fmtPace(p) : '–:––';
}
function speakDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return `${h} hours ${m} minutes`;
}
function waterText(w) {
  if (w == null || w === '') return '';
  if (typeof w === 'number') return `water at Aid ${w}`;
  const s = String(w);
  return /^water/i.test(s) ? s : `water at ${s}`;
}

const SVG = {
  star: '<svg class="ico ico-star" viewBox="-50 -50 100 100" aria-hidden="true"><polygon points="0,-48 11,-19 42,-24 22,0 42,24 11,19 0,48 -11,19 -42,24 -22,0 -42,-24 -11,-19"/></svg>',
  drop: '<svg class="ico ico-drop" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C9 7 5 10.5 5 15a7 7 0 0 0 14 0c0-4.5-4-8-7-13z"/></svg>',
  pill: '<svg class="ico ico-pill" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="8" width="18" height="8" rx="4"/></svg>',
  mark: '<svg class="ico ico-mark" viewBox="0 0 24 24" aria-hidden="true"><rect x="10" y="3" width="4" height="18"/></svg>',
};
const iconFor = (kind) => ({ gel: SVG.star, aid: SVG.drop, water: SVG.drop, capsule: SVG.pill }[kind] || SVG.mark);
const STAR_POINTS = '0,-48 11,-19 42,-24 22,0 42,24 11,19 0,48 -11,19 -42,24 -22,0 -42,-24 -11,-19';

// ------------------------------------------------------------------ elements
const el = {
  ready: $('#ready'), live: $('#live'), done: $('#done'),
  rTarget: $('#r-target'), rProfile: $('#r-profile'), rCheckpoints: $('#r-checkpoints'),
  rGps: $('#r-gps'), rGpsHint: $('#r-gps-hint'), rWake: $('#r-wake'), rWakeHint: $('#r-wake-hint'),
  lGps: $('#l-gps'), lWake: $('#l-wake'), lSim: $('#l-sim'), lVoiceFix: $('#l-voice-fix'),
  lKm: $('#l-km'), lElapsed: $('#l-elapsed'), lDeltaBox: $('#l-delta-box'), lDelta: $('#l-delta'), lDeltaLbl: $('#l-delta-lbl'),
  lTarget: $('#l-target'), lNow: $('#l-now'), lNext: $('#l-next'), lCue: $('#l-cue'),
  flag: $('#flag'), flagStars: $('#flag-stars'),
  dTime: $('#d-time'), dDetail: $('#d-detail'), dBack: $('#btn-done-back'), dHint: $('#d-hint'),
  band: $('#band'), bandSub: $('#band-sub'),
  planSub: $('#plan-sub'), planCheckpoints: $('#plan-checkpoints'), planFuel: $('#plan-fuel'),
  lock: $('#lock'), lockHold: $('#lock-hold'), kKm: $('#k-km'), kDelta: $('#k-delta'), kElapsed: $('#k-elapsed'),
  settings: $('#settings'), sTarget: $('#s-target'), sTargetErr: $('#s-target-err'),
  sVoice: $('#s-voice'), sAid: $('#s-aid'), sStretch: $('#s-stretch'),
  sNudge: $('#s-nudge'), sNudgeMinus: $('#s-nudge-minus'), sNudgePlus: $('#s-nudge-plus'),
  sReset: $('#s-reset'), sVersion: $('#s-version'),
  toast: $('#toast'),
};

// ------------------------------------------------------------------ voice
// One utterance at a time. Gel and capsule cues (priority 1) wait their turn;
// split and info cues go stale and are replaced by newer ones of the same kind.
const STALE_MS = { 1: 120000, 2: 40000, 3: 15000 };
const cueKind = (id) => String(id).replace(/\d+/g, '#');

const voice = {
  supported: typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined',
  queue: [],
  held: [],          // priority-1 cues raised before speech was allowed (after a reload)
  current: null,
  primed: false,
  watchdog: 0,
  chosen: undefined,

  setSession() {
    try { if (navigator.audioSession) navigator.audioSession.type = 'transient'; } catch { /* not supported */ }
  },
  pickVoice() {
    if (this.chosen !== undefined) return this.chosen;
    const all = speechSynthesis.getVoices() || [];
    if (!all.length) return null;
    const en = all.filter((v) => /^en[-_]US/i.test(v.lang));
    const pref = ['Samantha', 'Ava', 'Allison', 'Susan', 'Nicky', 'Zoe'];
    this.chosen = pref.map((n) => en.find((v) => v.name.includes(n))).find(Boolean)
      || en.find((v) => v.localService) || en[0] || null;
    return this.chosen;
  },
  canSpeak() {
    if (!this.supported) return false;
    if (this.primed) return true;
    const ua = navigator.userActivation;
    return ua ? ua.hasBeenActive : false;
  },
  // Call synchronously inside a tap handler: iOS only lets speech start from a gesture.
  // Cues that were waiting (queued, or held because speech wasn't allowed yet) play
  // right after the prime phrase if they're still fresh.
  prime(text) {
    if (!this.supported) return;
    this.setSession();
    this.primed = true;
    const now = performance.now();
    const keep = [...this.queue, ...this.held]
      .filter((q) => now - q.at <= (STALE_MS[q.priority] ?? STALE_MS[3]))
      .sort((a, b) => a.priority - b.priority || a.at - b.at);
    this.queue = [];
    this.held = [];
    this.current = null;
    try { speechSynthesis.cancel(); } catch { /* ignore */ }
    this.speakNow({ id: 'prime', priority: 1, text, at: now });
    this.queue = keep;
    renderVoiceFix();
  },
  enqueue(cue) {
    if (!settings.voice || !this.supported) return false;
    const item = { id: cue.id, priority: cue.priority ?? 3, text: cue.text, at: performance.now() };
    if (!this.canSpeak()) {
      if (item.priority === 1) this.held.push(item);
      return false;
    }
    if (item.priority >= 2) {
      const kind = cueKind(item.id);
      this.queue = this.queue.filter((q) => q.priority < 2 || cueKind(q.id) !== kind);
    }
    this.queue.push(item);
    this.queue.sort((a, b) => a.priority - b.priority || a.at - b.at);
    this.pump();
    return true;
  },
  pump() {
    if (this.current || !this.queue.length) return;
    const now = performance.now();
    this.queue = this.queue.filter((q) => now - q.at <= (STALE_MS[q.priority] ?? STALE_MS[3]));
    const next = this.queue.shift();
    if (next) this.speakNow(next);
  },
  speakNow(item) {
    const u = new SpeechSynthesisUtterance(item.text);
    u.lang = 'en-US';
    u.rate = 1.0;
    const v = this.pickVoice();
    if (v) u.voice = v;
    const done = () => {
      if (this.current !== u) return;
      this.current = null;
      clearTimeout(this.watchdog);
      setTimeout(() => this.pump(), 150);
    };
    u.onend = done;
    u.onerror = done;
    this.current = u;
    clearTimeout(this.watchdog);
    // iOS sometimes never fires onend; don't let the queue jam.
    this.watchdog = setTimeout(done, 3000 + item.text.length * 120);
    try {
      if (speechSynthesis.paused) speechSynthesis.resume();
      speechSynthesis.speak(u);
    } catch { done(); }
  },
  stop() {
    this.queue = [];
    this.held = [];
    this.current = null;
    clearTimeout(this.watchdog);
    if (this.supported) { try { speechSynthesis.cancel(); } catch { /* ignore */ } }
  },
};
if (voice.supported && 'onvoiceschanged' in speechSynthesis) {
  speechSynthesis.addEventListener('voiceschanged', () => { voice.chosen = undefined; });
}
voice.setSession();
window.__voice = voice;

// ------------------------------------------------------------------ wake lock
const wake = {
  sentinel: null,
  state: 'off',      // on | off | pending (not granted without a tap) | failed | unsupported
  lastTry: 0,
  async request(fromTap = false) {
    this.lastTry = Date.now();
    if (!('wakeLock' in navigator)) { this.set('unsupported'); return; }
    if (document.visibilityState !== 'visible') return;
    if (this.sentinel && !this.sentinel.released) { this.set('on'); return; }
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      this.set('on');
      this.sentinel.addEventListener('release', () => {
        this.sentinel = null;
        this.set('off');
      });
    } catch {
      // Safari may refuse until the user taps; only a refused tap means it really can't.
      this.set(fromTap || this.state === 'failed' ? 'failed' : 'pending');
    }
  },
  async release() {
    try { await this.sentinel?.release(); } catch { /* ignore */ }
    this.sentinel = null;
    this.set('off');
  },
  set(state) {
    this.state = state;
    renderWake();
  },
};

function renderWake() {
  const s = wake.state;
  const failed = s === 'failed' || s === 'unsupported';
  setText(el.rWake, s === 'on' ? 'Stays on' : failed ? 'Can\u2019t hold it on' : 'Turns on at Start');
  el.rWake.className = `check-v ${s === 'on' ? 'ok' : failed ? 'bad' : 'warn'}`;
  el.rWakeHint.hidden = !failed;
  setText(el.lWake, s === 'on' ? 'Screen on' : 'Screen may sleep. Set Auto-Lock to Never.');
  el.lWake.className = `pill ${s === 'on' ? 'ok' : 'bad'}`;
}

// ------------------------------------------------------------------ GPS
const gps = {
  watchId: null,
  last: null,       // { accuracy, at }
  error: null,
  start() {
    if (this.watchId != null || !('geolocation' in navigator)) return;
    try {
      this.watchId = navigator.geolocation.watchPosition(
        (p) => this.onPosition(p),
        (e) => this.onError(e),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
      );
    } catch (e) { this.onError(e); }
  },
  stop() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  },
  restart() { this.stop(); this.start(); },
  onPosition(p) {
    const now = Date.now();
    const ts = Number(p.timestamp);
    const t = Number.isFinite(ts) && Math.abs(ts - now) < 10000 ? ts : now;
    this.last = { accuracy: p.coords.accuracy, at: now };
    this.error = null;
    if (mode === 'race' && engine) {
      engine.onFix({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy, t });
    }
    renderGps();
  },
  onError(e) {
    this.error = e;
    renderGps();
  },
};

function gpsQuality(acc) {
  if (!Number.isFinite(acc)) return ['warn', ''];
  if (acc <= 15) return ['ok', 'good'];
  if (acc <= 35) return ['warn', 'fair'];
  return ['bad', 'weak'];
}

function renderGps() {
  const e = gps.error;
  if (!('geolocation' in navigator)) {
    setText(el.rGps, 'Not available');
    el.rGps.className = 'check-v bad';
    return;
  }
  el.rGpsHint.hidden = !(e && e.code === 1);
  if (e && e.code === 1) {
    setText(el.rGps, 'Location blocked');
    el.rGps.className = 'check-v bad';
  } else if (gps.last) {
    const [cls, word] = gpsQuality(gps.last.accuracy);
    const age = Math.round((Date.now() - gps.last.at) / 1000);
    setText(el.rGps, `±${Math.round(gps.last.accuracy)} m, ${word}${age > 15 ? `, ${age} s old` : ''}`);
    el.rGps.className = `check-v ${cls}`;
  } else {
    setText(el.rGps, e ? 'Searching… (no fix yet)' : 'Searching…');
    el.rGps.className = 'check-v warn';
  }
}

function renderLiveGps(state) {
  if (mode === 'rehearsal') {
    setText(el.lSim, `Stop rehearsal (${rehearsal?.rate ?? simRate}×)`);
    return;
  }
  const g = state?.gps;
  if (gps.error && gps.error.code === 1) {
    setText(el.lGps, 'GPS blocked');
    el.lGps.className = 'pill bad';
  } else if (g && g.ok) {
    setText(el.lGps, Number.isFinite(g.accuracyM) ? `GPS ±${Math.round(g.accuracyM)} m` : 'GPS ok');
    el.lGps.className = 'pill ok';
  } else if (g && g.mode === 'plan') {
    setText(el.lGps, 'No GPS, using plan pace');
    el.lGps.className = 'pill bad';
  } else {
    setText(el.lGps, 'GPS weak, estimating');
    el.lGps.className = 'pill bad';
  }
}

// ------------------------------------------------------------------ plan views
function checkpointItems() {
  return [
    ['10K', planTimeAt(plan, 10000)],
    ['Half', planTimeAt(plan, MARKERS.half * 1000)],
    ['30K', planTimeAt(plan, 30000)],
    ['Finish', plan.totalSec],
  ];
}
function renderCheckpoints(target) {
  target.innerHTML = checkpointItems()
    .map(([k, t]) => `<li><span class="lbl">${k}</span><span class="num">${slots(fmtClock(t))}</span></li>`)
    .join('');
}
const profileName = () => (settings.profile === 'halves' ? 'Even halves' : 'Friend\u2019s plan');

function renderReady() {
  setNum(el.rTarget, fmtClock(plan.totalSec));
  setText(el.rProfile, `${profileName()}, negative split`);
  renderCheckpoints(el.rCheckpoints);
}

function fuelVisible(f) {
  if (f.km == null) return false;
  if (f.kind === 'capsule' && f.optional && engineSettings().capsules !== 3) return false;
  return f.kind === 'gel' || f.kind === 'capsule';
}

let bandRows = new Map();
const clockAt = (km) => fmtClock(planTimeAt(plan, km * 1000));
function renderBand() {
  setText(el.bandSub, `${profileName()}, ${fmtClock(plan.totalSec)}`);
  const splits = kmSplits(plan);
  const fiveK = new Set((MARKERS.fiveK || []).map((k) => Math.round(k * 1000)));
  const rows = [];
  let prevKm = 0;
  for (const s of splits) {
    const len = s.km - prevKm;
    const finish = s.km >= 42.19;
    const isFive = fiveK.has(Math.round(s.km * 1000));
    rows.push({
      at: s.km, order: 1, kind: 'km', km: s.km, finish, isFive,
      pace: fmtPace(s.splitSec / (len || 1)), clock: fmtClock(s.cumSec),
    });
    prevKm = s.km;
  }
  rows.push({ at: MARKERS.half, order: 1, kind: 'half', clock: fmtClock(planTimeAt(plan, MARKERS.half * 1000)) });
  for (const f of FUEL) {
    if (!fuelVisible(f)) continue;
    rows.push({ at: f.km, order: 0, kind: f.kind, f });
  }
  for (const a of AID_STATIONS) rows.push({ at: a.km, order: 2, kind: 'aid', a });
  for (const m of MARKERS.miles || []) {
    rows.push({ at: m.km, order: 3, kind: 'mile', m, clock: fmtClock(planTimeAt(plan, m.km * 1000)) });
  }
  rows.sort((x, y) => x.at - y.at || x.order - y.order);

  bandRows = new Map();
  const html = rows.map((r) => {
    if (r.kind === 'km') {
      const label = r.finish ? 'Finish' : r.isFive ? `${Math.round(r.km)}K` : '';
      const cls = `band-row km${r.isFive ? ' fivek' : ''}${r.finish ? ' finish' : ''}`;
      const kmText = r.finish ? '42.2' : String(Math.round(r.km));
      return `<div class="${cls}" data-km="${Math.ceil(r.km - 1e-6)}"><span class="k">${slots(kmText)}${label ? `<span class="tag">${label}</span>` : ''}</span><span class="p">${slots(r.pace)}</span><span class="c">${slots(r.clock)}</span></div>`;
    }
    if (r.kind === 'half') {
      return `<div class="band-row half"><span class="k">${slots('21.1')}<span class="tag">Half</span></span><span class="p"></span><span class="c">${slots(r.clock)}</span></div>`;
    }
    if (r.kind === 'gel') {
      const w = waterText(r.f.waterAt);
      const what = r.f.product || '';
      return `<div class="band-ev gel">${SVG.star}<span>${esc(r.f.label)} at km ${r.f.km.toFixed(1)}. ${esc([what, w].filter(Boolean).join(', '))}</span><span class="at">${slots(clockAt(r.f.km))}</span></div>`;
    }
    if (r.kind === 'capsule') {
      const at = typeof r.f.waterAt === 'number' ? ` at Aid ${r.f.waterAt}, full cup of water` : '';
      return `<div class="band-ev">${SVG.pill}<span>${esc(r.f.label)}${at}${r.f.optional ? ' (optional)' : ''}</span><span class="at">${slots(clockAt(r.f.km))}</span></div>`;
    }
    if (r.kind === 'aid') {
      return `<div class="band-ev">${SVG.drop}<span>Aid ${esc(r.a.n)} at km ${r.a.approx ? '≈' : ''}${r.a.km.toFixed(1)}${r.a.where ? `, ${esc(r.a.where)}` : ''}</span><span class="at">${slots(clockAt(r.a.km))}</span></div>`;
    }
    if (r.kind === 'mile') {
      return `<div class="band-ev">${SVG.mark}<span>Mile ${esc(r.m.mile)}</span><span class="at">${slots(r.clock)}</span></div>`;
    }
    return '';
  }).join('');
  el.band.innerHTML = html;
  for (const row of $$('.band-row.km', el.band)) bandRows.set(Number(row.dataset.km), row);
  lastBandKm = -1;
}

let lastBandKm = -1;
function highlightBand(distM) {
  const km = Math.min(43, Math.floor(distM / 1000) + 1);
  if (km === lastBandKm) return;
  bandRows.get(lastBandKm)?.classList.remove('now');
  bandRows.get(km)?.classList.add('now');
  lastBandKm = km;
}

function renderPlanTab() {
  setText(el.planSub, `${fmtClock(plan.totalSec)}, ${profileName().toLowerCase()}, negative split`);
  renderCheckpoints(el.planCheckpoints);
  el.planFuel.innerHTML = FUEL.map((f) => {
    const isGel = f.kind === 'gel';
    const n = isGel ? String(f.n ?? '') : f.kind === 'capsule' ? 'S' : '–';
    const km = f.km == null ? '–' : f.km.toFixed(1);
    const clock = f.km == null ? esc(f.when || 'before') : fmtClock(planTimeAt(plan, f.km * 1000));
    const opt = f.optional ? ' (optional)' : '';
    const detail = f.detail || waterText(f.waterAt);
    return `<tr class="${f.kind}${f.optional ? ' opt' : ''}"><td class="n">${n}</td><td>${km}</td><td>${clock}</td><td><b>${esc(f.label)}</b>${opt}${detail ? `<br>${esc(detail)}` : ''}</td></tr>`;
  }).join('');
}

// ------------------------------------------------------------------ flag strip
function renderFlagStars() {
  const total = (ROUTE.length ? ROUTE[ROUTE.length - 1][2] : 42195) / 1000;
  el.flagStars.innerHTML = FUEL.filter((f) => f.kind === 'gel' && f.km != null)
    .map((f) => `<svg class="flag-star" data-km="${f.km}" viewBox="-50 -50 100 100" style="left:${((f.km / total) * 100).toFixed(2)}%" aria-hidden="true"><polygon points="${STAR_POINTS}"/></svg>`)
    .join('');
}
function renderFlag(state) {
  const p = Math.max(0, Math.min(1, state.progress ?? state.distM / 42195));
  el.flag.style.setProperty('--p', p.toFixed(4));
  const km = state.distM / 1000;
  for (const s of el.flagStars.children) s.classList.toggle('passed', km >= Number(s.dataset.km));
}

// ------------------------------------------------------------------ live render
function nextHTML(n) {
  if (!n || !n.label) return '';
  const where = Number.isFinite(n.inM) ? ` in <b>${fmtDist(n.inM)}</b>` : '';
  const detail = n.detail ? ` · <span class="detail">${esc(n.detail)}</span>` : '';
  return `${iconFor(n.kind)}${esc(n.label)}${where}${detail}`;
}

function render(state) {
  if (!state) return;
  lastState = state;
  window.__state = state;

  if (state.finished) {
    showView('done');
    const fin = state.finishSec ?? state.elapsedSec;
    setNum(el.dTime, fmtClock(fin));
    const h = state.half;
    const half = h && h.actual != null ? `Half ${fmtClock(h.actual)}, second half ${fmtClock(fin - h.actual)}. ` : '';
    const d = Math.round(plan.totalSec - fin);
    const vs = d === 0 ? 'Right on plan.' : `${Math.abs(d) >= 60 ? fmtClock(Math.abs(d)) : `${Math.abs(d)} s`} ${d > 0 ? 'under' : 'over'} the ${fmtClock(plan.totalSec)} plan.`;
    setText(el.dDetail, `${mode === 'rehearsal' ? 'Rehearsal. ' : ''}${half}${vs}`);
    el.dBack.hidden = mode !== 'rehearsal';
    el.dHint.hidden = mode === 'rehearsal';
    return;
  }

  const kmText = (Math.max(0, state.distM) / 1000).toFixed(1);
  const elapsed = fmtClock(Math.max(0, state.elapsedSec));
  setNum(el.lKm, kmText);
  setNum(el.lElapsed, elapsed);

  const a = state.aheadSec;
  let cls = 'delta';
  let label = 'on plan';
  if (!Number.isFinite(a)) {
    cls += ' idle';
    label = 'waiting for distance';
    setNum(el.lDelta, '–:––');
  } else {
    const r = Math.round(a);
    if (r >= 3) label = 'ahead of plan';
    else if (r <= -3) { label = 'behind plan'; cls += ' behind'; }
    setNum(el.lDelta, fmtDelta(a));
  }
  if (el.lDeltaBox.className !== cls) el.lDeltaBox.className = cls;
  setText(el.lDeltaLbl, label);

  setNum(el.lTarget, paceOrDash(state.targetPace));
  setNum(el.lNow, paceOrDash(state.currentPace));

  const nh = nextHTML(state.next);
  if (el.lNext._h !== nh) { el.lNext._h = nh; el.lNext.innerHTML = nh; }

  renderFlag(state);
  renderLiveGps(state);
  highlightBand(state.distM);

  if (!el.lock.hidden) {
    setNum(el.kKm, `${kmText}`);
    setNum(el.kDelta, Number.isFinite(a) ? fmtDelta(a) : '–:––');
    el.kDelta.classList.toggle('behind', Number.isFinite(a) && Math.round(a) <= -3);
    setNum(el.kElapsed, elapsed);
  }
}

function showView(which) {
  el.ready.hidden = which !== 'ready';
  el.live.hidden = which !== 'live';
  el.done.hidden = which !== 'done';
  el.lSim.hidden = mode !== 'rehearsal';
  el.lGps.hidden = mode === 'rehearsal';
  renderVoiceFix();
}

function renderVoiceFix() {
  el.lVoiceFix.hidden = !(mode !== 'idle' && settings.voice && voice.supported && !voice.canSpeak());
}

// The caption shows the latest cue, but a gel or capsule cue stays up for 20 s
// even if a split arrives in the same tick.
let captionTimer = 0;
let captionPri = 9;
let captionAt = 0;
function caption(text, priority = 3) {
  const t = performance.now();
  if (captionPri === 1 && priority > 1 && t - captionAt < 20000) return;
  captionPri = priority;
  captionAt = t;
  setText(el.lCue, text);
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => { setText(el.lCue, ''); captionPri = 9; }, 20000);
}

function logCue(cue, state) {
  const startMs = engine?.startMs;
  const t = Number.isFinite(cue.t) && Number.isFinite(startMs) ? (cue.t - startMs) / 1000 : (state?.elapsedSec ?? 0);
  const entry = {
    t: Math.round(t * 10) / 10,
    id: cue.id,
    text: cue.text,
    priority: cue.priority,
    distM: Math.round(Number.isFinite(cue.atM) ? cue.atM : (state?.distM ?? 0)),
    mode,
  };
  window.__cueLog.push(entry);
  caption(cue.text, cue.priority ?? 3);
  voice.enqueue(cue);
}

// ------------------------------------------------------------------ race loop
function now() { return Date.now(); }

function newEngine() {
  return new RaceEngine({ plan, route: ROUTE, settings: engineSettings() });
}
function applyEngineSettings() {
  if (!engine) return;
  const s = engineSettings();
  if (typeof engine.setSettings === 'function') engine.setSettings(s);
  else engine.settings = { ...(engine.settings || {}), ...s };
}

function stopLoops() {
  clearInterval(tickTimer);
  clearInterval(saveTimer);
  tickTimer = 0;
  saveTimer = 0;
}

let lastWakeRetry = 0;
function raceTick() {
  if (!engine || mode !== 'race') return;
  const { state, cues } = engine.tick(now());
  for (const c of cues || []) logCue(c, state);
  render(state);
  renderGps();
  if (wake.state !== 'on' && Date.now() - lastWakeRetry > 15000) { lastWakeRetry = Date.now(); wake.request(); }
  if (gps.last && Date.now() - gps.last.at > 45000 && Date.now() - (gps.restartedAt || 0) > 45000) {
    gps.restartedAt = Date.now();
    gps.restart();
  }
  if (state.finished) finishRace();
}

function saveRace() {
  if (mode !== 'race' || !engine) return;
  saveJSON(RACE_KEY, {
    v: 1,
    savedAt: Date.now(),
    startedAt,
    nudgeTotal,
    profile: settings.profile,
    totalSec: settings.totalSec,
    engine: engine.toJSON(),
  });
}

function startRace(tMs) {
  endRehearsal(false);
  stopLoops();
  mode = 'race';
  window.__mode = mode;
  window.__cueLog = [];
  engine = newEngine();
  engine.start(tMs);
  startedAt = tMs;
  nudgeTotal = 0;
  gps.start();
  showView('live');
  saveRace();
  tickTimer = setInterval(raceTick, 1000);
  saveTimer = setInterval(saveRace, 5000);
  raceTick();
}

function finishRace() {
  saveRace();
  stopLoops();
  gps.stop();
  wake.release();
}

function resumeRace() {
  const saved = loadJSON(RACE_KEY);
  if (!saved || !saved.engine || !saved.startedAt) return false;
  if (Date.now() - saved.startedAt > MAX_RACE_AGE_MS) {
    localStorage.removeItem(RACE_KEY);
    return false;
  }
  try {
    if (saved.profile && (saved.profile !== settings.profile || saved.totalSec !== settings.totalSec)) {
      settings = { ...settings, profile: saved.profile, totalSec: saved.totalSec };
      saveJSON(SETTINGS_KEY, settings);
      plan = buildPlan(settings.profile, { totalSec: settings.totalSec });
    }
    engine = RaceEngine.fromJSON(saved.engine, { plan, route: ROUTE });
    applyEngineSettings();
  } catch (err) {
    console.warn('Could not resume race', err);
    return false;
  }
  mode = 'race';
  window.__mode = mode;
  startedAt = saved.startedAt;
  nudgeTotal = saved.nudgeTotal || 0;
  // The first tick after a reload fires whatever was crossed while the app was closed.
  // The engine marks those cues as fired, so they must be logged and spoken now.
  const { state, cues } = engine.tick(now());
  for (const c of cues || []) logCue(c, state);
  if (state.finished) {
    render(state);
    return true;
  }
  gps.start();
  showView('live');
  tickTimer = setInterval(raceTick, 1000);
  saveTimer = setInterval(saveRace, 5000);
  render(state);
  toast('Race resumed.');
  return true;
}

function resetRace() {
  endRehearsal(false);
  stopLoops();
  voice.stop();
  localStorage.removeItem(RACE_KEY);
  engine = null;
  mode = 'idle';
  window.__mode = mode;
  nudgeTotal = 0;
  lastState = null;
  window.__state = null;
  setText(el.lCue, '');
  showView('ready');
  renderGps();
}

// ------------------------------------------------------------------ rehearsal
// Replays sim.js fixes on a virtual clock. The engine still ticks once per
// virtual second, exactly like race day; only the clock runs faster.
function startRehearsal(rate) {
  stopLoops();
  voice.stop();
  rate = Math.max(1, Math.min(2000, rate || 60));
  const startMs = Date.now();
  let fixes;
  try {
    fixes = simulateRun({
      plan, route: ROUTE, startMs, stepSec: 1, noiseM: 8,
      multipath: [[0, 5, 150], [19, 22, 150]],
      dropouts: [[14, 14.2], [33, 33.2]],
    });
  } catch (err) {
    console.error('simulateRun failed', err);
    toast('Rehearsal could not start (simulator error).');
    return;
  }
  mode = 'rehearsal';
  window.__mode = mode;
  window.__cueLog = [];
  engine = newEngine();
  engine.start(startMs);
  const lastT = fixes.length ? fixes[fixes.length - 1].t : startMs;
  rehearsal = { rate, startMs, fixes, i: 0, sec: 0, real0: performance.now(), lastT, done: false };
  window.__rehearsal = { rate, done: false, sec: 0 };
  nudgeTotal = 0;
  showView('live');
  tickTimer = setInterval(rehearsalStep, 100);
  rehearsalStep();
}

function rehearsalStep() {
  const r = rehearsal;
  if (!r || r.done || !engine) return;
  const target = Math.floor(((performance.now() - r.real0) / 1000) * r.rate);
  let res = null;
  let budget = 20000;
  while (r.sec < target && budget-- > 0) {
    r.sec += 1;
    const tMs = r.startMs + r.sec * 1000;
    while (r.i < r.fixes.length && r.fixes[r.i].t <= tMs) engine.onFix(r.fixes[r.i++]);
    res = engine.tick(tMs);
    for (const c of res.cues || []) logCue(c, res.state);
    if (res.state.finished || tMs > r.lastT + 900000) {
      r.done = true;
      break;
    }
  }
  window.__rehearsal.sec = r.sec;
  if (res) render(res.state);
  if (r.done) {
    window.__rehearsal.done = true;
    stopLoops();
  }
}

function rehearsalNow() {
  return rehearsal ? rehearsal.startMs + rehearsal.sec * 1000 : now();
}

function endRehearsal(toReady = true) {
  if (mode !== 'rehearsal') return;
  stopLoops();
  voice.stop();
  rehearsal = null;
  engine = null;
  mode = 'idle';
  window.__mode = mode;
  if (window.__rehearsal) window.__rehearsal.stopped = true;
  if (toReady) {
    showView('ready');
    if (!resumeRace()) renderGps();
  }
}

// ------------------------------------------------------------------ lock
let holdTimer = 0;
function lock() {
  el.lock.hidden = false;
  if (lastState) render(lastState);
}
function unlock() {
  el.lockHold.classList.remove('holding');
  el.lock.hidden = true;
}
function holdStart(e) {
  e.preventDefault();
  el.lockHold.classList.add('holding');
  clearTimeout(holdTimer);
  holdTimer = setTimeout(unlock, 2000);
}
function holdEnd() {
  clearTimeout(holdTimer);
  el.lockHold.classList.remove('holding');
}
el.lockHold.addEventListener('pointerdown', holdStart);
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) el.lockHold.addEventListener(ev, holdEnd);
el.lock.addEventListener('contextmenu', (e) => e.preventDefault());
el.lock.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

// ------------------------------------------------------------------ toast
let toastTimer = 0;
function toast(text) {
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
}

// ------------------------------------------------------------------ tabs
function showTab(name) {
  for (const b of $$('.tabbtn[data-tab]')) {
    if (b.dataset.tab === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  for (const s of $$('.tab')) s.hidden = s.id !== `tab-${name}`;
  $('.tabs').scrollTop = 0;
  if (name === 'band' && lastState && !lastState.finished && mode !== 'idle') {
    bandRows.get(lastBandKm)?.scrollIntoView({ block: 'center' });
  }
}
for (const b of $$('.tabbtn[data-tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));

// ------------------------------------------------------------------ settings
function fillSettings() {
  for (const r of $$('input[name="profile"]')) r.checked = r.value === settings.profile;
  for (const r of $$('input[name="cueEveryKm"]')) r.checked = Number(r.value) === engineSettings().cueEveryKm;
  for (const r of $$('input[name="capsules"]')) r.checked = Number(r.value) === engineSettings().capsules;
  el.sTarget.value = fmtClock(settings.totalSec);
  el.sTargetErr.hidden = true;
  el.sVoice.checked = !!settings.voice;
  el.sAid.checked = !!settings.aidHeadsUp;
  el.sStretch.checked = !!settings.stretchCue;
  renderNudge();
  disarmReset();
  refreshVersion();
}

function renderNudge() {
  el.sNudge.value = `${nudgeTotal > 0 ? '+' : nudgeTotal < 0 ? MINUS : ''}${Math.abs(nudgeTotal)} s`;
  el.sNudge.textContent = el.sNudge.value;
  const active = !!engine && mode !== 'idle';
  el.sNudgeMinus.disabled = !active;
  el.sNudgePlus.disabled = !active;
}

function saveSettings({ replan = false } = {}) {
  saveJSON(SETTINGS_KEY, settings);
  if (replan) {
    plan = buildPlan(settings.profile, { totalSec: settings.totalSec });
    if (engine) {
      try {
        engine = RaceEngine.fromJSON(engine.toJSON(), { plan, route: ROUTE });
      } catch (err) {
        console.warn('Could not re-plan the running race', err);
      }
    }
    renderReady();
    renderBand();
    renderPlanTab();
  }
  applyEngineSettings();
  if (!replan) renderBand();
  if (mode === 'race') saveRace();
  renderVoiceFix();
}

function parseClock(str) {
  const m = /^\s*(\d):([0-5]\d):([0-5]\d)\s*$/.exec(str || '');
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

for (const r of $$('input[name="profile"]')) {
  r.addEventListener('change', () => { settings.profile = r.value; saveSettings({ replan: true }); });
}
for (const r of $$('input[name="cueEveryKm"]')) {
  r.addEventListener('change', () => { settings.cueEveryKm = Number(r.value); saveSettings(); });
}
for (const r of $$('input[name="capsules"]')) {
  r.addEventListener('change', () => { settings.capsules = Number(r.value); saveSettings(); });
}
el.sTarget.addEventListener('change', () => {
  const sec = parseClock(el.sTarget.value);
  if (sec == null || sec < 9000 || sec > 18000) {
    el.sTargetErr.hidden = false;
    return;
  }
  el.sTargetErr.hidden = true;
  settings.totalSec = sec;
  saveSettings({ replan: true });
});
el.sVoice.addEventListener('change', () => {
  settings.voice = el.sVoice.checked;
  if (!settings.voice) voice.stop();
  else voice.prime('Voice on.');
  saveSettings();
});
el.sAid.addEventListener('change', () => { settings.aidHeadsUp = el.sAid.checked; saveSettings(); });
el.sStretch.addEventListener('change', () => { settings.stretchCue = el.sStretch.checked; saveSettings(); });

// shiftSec < 0 moves the start time earlier (adds to elapsed). engine.nudgeStart(+s) means
// the race really began s earlier than the tap, so it takes the opposite sign.
function nudge(shiftSec) {
  if (!engine) return;
  engine.nudgeStart(-shiftSec);
  nudgeTotal += shiftSec;
  if (mode === 'race') {
    startedAt += shiftSec * 1000;
    saveRace();
  }
  renderNudge();
  toast(shiftSec < 0 ? `Start moved ${-shiftSec} s earlier.` : `Start moved ${shiftSec} s later.`);
  if (mode === 'race') raceTick();
}
el.sNudgeMinus.addEventListener('click', () => nudge(-5));
el.sNudgePlus.addEventListener('click', () => nudge(5));

let resetArmed = 0;
function disarmReset() {
  clearTimeout(resetArmed);
  resetArmed = 0;
  el.sReset.classList.remove('armed');
  el.sReset.textContent = 'Reset race';
}
el.sReset.addEventListener('click', () => {
  if (!resetArmed) {
    el.sReset.classList.add('armed');
    el.sReset.textContent = 'Tap again to erase the race';
    resetArmed = setTimeout(disarmReset, 4000);
    return;
  }
  disarmReset();
  resetRace();
  el.settings.close();
  toast('Race reset.');
});

$('#btn-settings').addEventListener('click', () => {
  fillSettings();
  if (typeof el.settings.showModal === 'function') el.settings.showModal();
  else el.settings.setAttribute('open', '');
});
el.settings.addEventListener('click', (e) => {
  if (e.target === el.settings) el.settings.close();   // tap on the backdrop
});

// ------------------------------------------------------------------ buttons
$('#btn-test-voice').addEventListener('click', () => {
  if (!voice.supported) { toast('This browser has no speech synthesis.'); return; }
  voice.prime('Voice check. Kilometer 1. Split 5 10. On plan.');
  wake.request(true);
});

$('#btn-start').addEventListener('click', () => {
  voice.prime(`Started. Target ${speakDuration(plan.totalSec)}. Have a good race.`);
  wake.request(true);
  startRace(now());
});

function rehearseFromTap() {
  el.settings.open && el.settings.close();
  showTab('race');
  startRehearsal(simRate || 60);
  voice.prime(`Rehearsal at ${simRate || 60} times speed.`);
  wake.request(true);
}
$('#btn-rehearse').addEventListener('click', rehearseFromTap);
$('#s-rehearse').addEventListener('click', () => {
  if (mode === 'race' && lastState && !lastState.finished) {
    toast('Finish or reset the race before rehearsing.');
    return;
  }
  rehearseFromTap();
});
el.lSim.addEventListener('click', () => endRehearsal(true));
el.dBack.addEventListener('click', () => endRehearsal(true));

$('#btn-mark').addEventListener('click', () => {
  if (!engine) return;
  const k = engine.markKm(mode === 'rehearsal' ? rehearsalNow() : now());
  const { state, cues } = engine.tick(mode === 'rehearsal' ? rehearsalNow() : now());
  for (const c of cues || []) logCue(c, state);
  render(state);
  toast(Number.isFinite(k) ? `Synced to the km ${k} sign.` : 'Nothing to sync yet.');
  if (mode === 'race') saveRace();
});
$('#btn-lock').addEventListener('click', lock);

// Any tap (the "Voice is off" banner included) counts as the gesture iOS needs before
// speech can play after a reload or a ?sim= link. Held gel/capsule cues follow.
document.addEventListener('click', () => {
  if (mode !== 'idle' && settings.voice && voice.supported && !voice.primed) voice.prime('Voice on.');
}, true);

// ------------------------------------------------------------------ lifecycle
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    wake.request();
    if (mode === 'race') raceTick();
  } else {
    saveRace();
  }
});
window.addEventListener('pagehide', saveRace);

// ------------------------------------------------------------------ service worker
async function refreshVersion() {
  if (!('serviceWorker' in navigator)) { el.sVersion.textContent = 'no offline support in this browser'; return; }
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sw = reg && (reg.active || reg.waiting || reg.installing);
    if (!sw) { el.sVersion.textContent = 'not cached yet'; return; }
    const reply = await new Promise((resolve) => {
      const ch = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 1500);
      ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
      sw.postMessage({ type: 'version' }, [ch.port2]);
    });
    if (!reply) { el.sVersion.textContent = 'installing…'; return; }
    el.sVersion.textContent = `${reply.version} · ${reply.cached ? `offline ready (${reply.cached} files)` : 'caching…'}`;
  } catch {
    el.sVersion.textContent = 'version unknown';
  }
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    refreshVersion();
    const sw = reg.installing || reg.waiting;
    sw?.addEventListener('statechange', () => { if (sw.state === 'activated') refreshVersion(); });
  }).catch((err) => {
    console.warn('Service worker registration failed', err);
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => refreshVersion());
}

// ------------------------------------------------------------------ boot
renderReady();
renderBand();
renderPlanTab();
renderFlagStars();
renderWake();
renderGps();
showTab('race');

if (simRate > 0) {
  showView('live');
  startRehearsal(simRate);
} else if (!resumeRace()) {
  showView('ready');
}
if (mode === 'idle') gps.start();
wake.request();
