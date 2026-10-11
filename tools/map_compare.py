"""Georeference the official course map and compare marker positions.

Fits an affine transform (lon, lat) -> map pixel by ICP between route.js and
the navy course line in tools/cm_hi.png (the PDF page rendered at 220 dpi).
Then reads every mile / km marker position from the PDF text layer
(pdftotext -bbox), maps it to lat/lon, and reports where it falls on route.js:
  official distance vs route.js cumM at the marker, and the marker's offset
  from the route line (a large offset would mean a wrong street).
Also writes tools/route_overlay.png: route.js drawn over the official map.
"""
import json
import math
import os
import re
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import routelib  # pylint: disable=g-import-not-at-top
import validate  # pylint: disable=g-import-not-at-top

HERE = routelib.HERE
IMG = os.path.join(HERE, 'cm_hi.png')
PDF = os.path.join(HERE, 'course_map.pdf')
W, H = 1870, 2420
PX_PER_PT = W / 612.0
MILE = 1609.344

MILE_PTS = {
    1: (467.3, 403.1), 2: (454.2, 474.3), 3: (437.9, 424.5),
    4: (435.9, 338.8), 5: (436.1, 254.8), 6: (421.5, 169.3),
    7: (401.3, 85.3), 8: (358.9, 31.3), 9: (383.5, 108.8),
    10: (400.8, 191.9), 11: (409.1, 276.9), 12: (429.6, 349.6),
    13: (402.5, 440.2), 14: (377.2, 480.1), 15: (285.6, 481.2),
    16: (274.8, 491.0), 17: (346.7, 488.7), 18: (340.7, 540.4),
    19: (304.4, 591.7), 20: (372.6, 616.8), 21: (408.1, 643.4),
    22: (446.6, 688.1), 23: (479.4, 762.4), 24: (490.3, 723.4),
    25: (478.5, 635.3), 26: (488.2, 552.0),
}
KM_PTS = {
    5: (437.5, 413.8), 10: (411.7, 153.3), 15: (381.0, 145.5),
    20: (429.8, 391.6), 25: (234.1, 477.3), 30: (303.4, 561.7),
    35: (439.8, 677.4), 40: (477.7, 648.2),
}


def load_rgb():
  raw = os.path.join(HERE, 'cache', 'cm_hi.rgb')
  if not os.path.exists(raw):
    subprocess.run(['convert', IMG, '-depth', '8', 'rgb:' + raw], check=True)
  return np.fromfile(raw, dtype=np.uint8).reshape(H, W, 3).astype(np.int16)


def navy_mask(img):
  r, g, b = img[..., 0], img[..., 1], img[..., 2]
  # Course line: dark navy. Lake/river are bright blue; text is black/grey.
  return (b > r + 25) & (b > g + 15) & (r < 90) & (g < 100) & (b < 170)


def fit(src, dst):
  A = np.c_[src, np.ones(len(src))]
  coef, *_ = np.linalg.lstsq(A, dst, rcond=None)
  return coef  # 3x2


def apply(coef, ll):
  ll = np.atleast_2d(ll)
  return np.c_[ll, np.ones(len(ll))] @ coef


def invert(coef, px):
  M = coef[:2].T  # 2x2: [x;y] = M [lon;lat] + t
  t = coef[2]
  return np.linalg.solve(M, (np.atleast_2d(px) - t).T).T


def icp(route, mask, coef, radii=(40, 25, 15, 10, 8, 8)):
  ll = np.array([[r[1], r[0]] for r in route])
  ys, xs = np.nonzero(mask)
  for rad in radii:
    px = apply(coef, ll)
    src, dst = [], []
    for (x, y), p in zip(px, ll):
      xi, yi = int(round(x)), int(round(y))
      x0, x1 = max(0, xi - rad), min(W, xi + rad + 1)
      y0, y1 = max(0, yi - rad), min(H, yi + rad + 1)
      if x0 >= x1 or y0 >= y1:
        continue
      win = mask[y0:y1, x0:x1]
      if not win.any():
        continue
      wy, wx = np.nonzero(win)
      d2 = (wx + x0 - x) ** 2 + (wy + y0 - y) ** 2
      k = int(np.argmin(d2))
      src.append(p)
      dst.append((wx[k] + x0, wy[k] + y0))
    src, dst = np.array(src), np.array(dst, dtype=float)
    coef = fit(src, dst)
    res = np.hypot(*(apply(coef, src) - dst).T)
    print('  icp r=%2d matched %4d/%d  rms %.2f px  median %.2f px' %
          (rad, len(src), len(ll), math.sqrt((res ** 2).mean()),
           float(np.median(res))))
  return coef


def initial_guess(turns):
  """Rough fit from a few unambiguous marker/turn pairs."""
  t = {lab: (la, lo) for lab, la, lo, *_ in turns}
  pairs = [
      (MILE_PTS[8], t['Sheridan Rd -> S Broadway']),
      (KM_PTS[25], t['Adams St -> S Damen Ave']),
      (MILE_PTS[22], t['Wentworth Ave -> E 26th St']),
      (MILE_PTS[24], t['Indiana Ave -> W 31st St']),
      (MILE_PTS[11], t['Sedgwick St -> E North Ave']),
  ]
  src = np.array([[lo, la] for _, (la, lo) in pairs])
  dst = np.array([[x * PX_PER_PT, y * PX_PER_PT] for (x, y), _ in pairs])
  return fit(src, dst)


def main():
  route_path = os.path.join(routelib.PROJECT, 'route.js')
  if len(sys.argv) > 1 and not sys.argv[1].startswith('--'):
    route_path = sys.argv[1]
  route, meta = validate.load_route(route_path)
  turns = json.load(open(os.path.join(HERE, 'turns.json')))['turns']
  img = load_rgb()
  mask = navy_mask(img)
  print('navy pixels', int(mask.sum()))
  coef = icp(route, mask, initial_guess(turns))
  # Metres per pixel, for reading offsets.
  p0 = invert(coef, [[W / 2, H / 2]])[0]
  p1 = invert(coef, [[W / 2 + 100, H / 2]])[0]
  mpp = routelib.hav((p0[1], p0[0]), (p1[1], p1[0])) / 100
  print('map scale %.2f m/px (%.1f m/pt)' % (mpp, mpp * PX_PER_PT))
  rows = []
  for kind, table, unit in (('mile', MILE_PTS, MILE), ('km', KM_PTS, 1000.0)):
    for n, (x, y) in sorted(table.items()):
      lon, lat = invert(coef, [[x * PX_PER_PT, y * PX_PER_PT]])[0]
      off, cum = validate.nearest_on_route(route, (lat, lon))
      official = n * unit
      rows.append((kind, n, official, cum, cum - official, off, lat, lon))
  print('%-5s %3s %9s %9s %8s %8s' % ('kind', 'n', 'official', 'route.js',
                                      'delta', 'off-line'))
  for kind, n, official, cum, delta, off, lat, lon in sorted(
      rows, key=lambda r: r[2]):
    print('%-5s %3d %9.0f %9.0f %+8.0f %8.0f   (%.5f, %.5f)' %
          (kind, n, official, cum, delta, off, lat, lon))
  json.dump({'coef': coef.tolist(), 'markers': rows},
            open(os.path.join(HERE, 'map_markers.json'), 'w'), indent=1)
  # Overlay route.js on the official map.
  px = apply(coef, np.array([[r[1], r[0]] for r in route]))
  pts = ' '.join('%.1f,%.1f' % (x, y) for x, y in px[::2])
  dots = []
  for km in range(5, 45, 5):
    la, lo = routelib.point_at(route, min(km * 1000, 42195))
    x, y = apply(coef, [[lo, la]])[0]
    dots += ['-draw', 'circle %.1f,%.1f %.1f,%.1f' % (x, y, x + 9, y)]
  out = os.path.join(HERE, 'route_overlay.png')
  subprocess.run(['convert', IMG, '-fill', 'none', '-stroke', '#00C853',
                  '-strokewidth', '3', '-draw', 'polyline ' + pts,
                  '-fill', '#00C853', '-stroke', 'black', '-strokewidth', '1']
                 + dots + ['-crop', '1050x2420+820+0', '+repage', out],
                 check=True)
  print('wrote', out)


if __name__ == '__main__':
  main()
