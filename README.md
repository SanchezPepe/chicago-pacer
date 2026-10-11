# Chicago Pacer

A phone pacing app for the 2026 Chicago Marathon (Sunday Oct 11, Wave 1, Corral E, goal 3:29:00). Through your headphones it speaks per-km splits, how far ahead or behind plan you are, gel and salt-capsule reminders, and aid-station heads-ups. It works offline once installed.

Live: https://sanchezpepe.github.io/chicago-pacer/

## Install on iPhone

1. Open the link in Safari, then tap Share → Add to Home Screen.
2. Open it once from the home-screen icon while online so it caches itself. Settings shows the version and "offline ready".
3. Allow location ("While Using") when asked. The Race tab shows the GPS accuracy.

## Rehearsal

Tap "Rehearse at 60×" on the Race tab, or open `https://sanchezpepe.github.io/chicago-pacer/?sim=60`. A simulated race plays in about 3.5 minutes with the real voice cues (tap once to turn voice on). Try it with AirPods in and music playing: the cues should duck the music, not stop it.

## Race morning

1. Settings → Display & Brightness → Auto-Lock → Never. Charge to 100%.
2. In the corral, open the app and check GPS, screen and voice on the Race tab.
3. Tap Start as you cross the start mat.
4. Tap Lock and put the phone in your belt. Hold the circle for 2 s to unlock.
5. Tapped Start late? Settings → Start time moves it in 5 s steps. "Mark km" snaps the distance to the nearest km sign.

## Files

- `index.html`, `styles.css`, `app.js`: UI, voice queue, wake lock, GPS, rehearsal
- `plan.js`, `course.js`, `engine.js`, `sim.js`: pace plans, course data, map matching and cues, GPS simulator
- `route.js`: the course line, built by `tools/build_route.py`
- `sw.js`, `manifest.webmanifest`, `icons/`, `fonts/`: offline PWA shell. Bump `VERSION` in `sw.js` whenever any file changes.
- `tests/`: `node tests/plan.test.mjs` and `node tests/engine.test.mjs`

Typeface: Big Shoulders Display, SIL Open Font License 1.1 (`fonts/OFL.txt`).
