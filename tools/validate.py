"""Validate a built route against official checkpoints and render a check map.

  python3 tools/validate.py [route.js] [--png tools/route_check.png]
"""
import json
import math
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_route  # pylint: disable=g-import-not-at-top
import fetch_osm  # pylint: disable=g-import-not-at-top
import routelib  # pylint: disable=g-import-not-at-top

hav = routelib.hav
MILE = 1609.344


def load_route(path):
  txt = open(path).read()
  meta = json.loads(re.search(r'ROUTE_META = (\{.*?\});', txt).group(1))
  rows = re.findall(r'\[(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\]', txt)
  return [[float(a), float(b), float(c)] for a, b, c in rows], meta


def nearest_on_route(route, p):
  """(distance m from p to the route polyline, cumM at that closest point)."""
  best = (1e18, 0.0)
  lat0 = p[0]
  kx = math.cos(math.radians(lat0))
  for a, b in zip(route, route[1:]):
    ax, ay = (a[1] - p[1]) * kx, a[0] - p[0]
    bx, by = (b[1] - p[1]) * kx, b[0] - p[0]
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / L))
    q = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
    d = hav(q, p)
    if d < best[0]:
      best = (d, a[2] + (b[2] - a[2]) * t)
  return best


def dist_to_segment(p, a, b):
  kx = math.cos(math.radians(p[0]))
  ax, ay = (a[1] - p[1]) * kx, a[0] - p[0]
  bx, by = (b[1] - p[1]) * kx, b[0] - p[0]
  dx, dy = bx - ax, by - ay
  L = dx * dx + dy * dy
  t = 0.0 if L == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / L))
  return hav((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t), p)


def osm_points():
  g = build_route.Graph(fetch_osm.fetch())
  def x(a, b, hint):
    n, _ = g.intersection(a, b, hint)
    return g.coord[n]
  return {
      'fullerton_clark': x('Clark Street', 'Fullerton Parkway',
                           (41.9256, -87.6400)),
      'north_sedgwick': x('Sedgwick Street', 'North Avenue',
                          (41.9107, -87.6386)),
      'franklin_adams': x('Franklin Street', 'Adams Street',
                          (41.8794, -87.6353)),
      'franklin_washington': x('Franklin Street', 'Wacker Drive',
                               (41.8868, -87.6353)),
      'loomis_taylor': x('Loomis Street', 'Taylor Street', (41.8695, -87.6618)),
      'loomis_18th': x('Loomis Street', '18th Street', (41.8578, -87.6615)),
      'halsted_18th': x('Halsted Street', '18th Street', (41.8578, -87.6468)),
      'michigan_roosevelt': x('Michigan Avenue', 'Roosevelt Road',
                              (41.8676, -87.6245)),
  }


def checkpoints(route, P):
  rows = []
  def spot(name, m, target, where):
    q = routelib.point_at(route, m)
    rows.append((name, m, hav(q, target), where, q))
  spot('mile 10', 16093, P['fullerton_clark'], 'Fullerton Ave & Clark St')
  spot('mile 11', 17703, P['north_sedgwick'], 'North Ave & Sedgwick St')
  spot('half', 21098, P['franklin_adams'], 'Franklin St & Adams St')
  q = routelib.point_at(route, 30000)
  d = dist_to_segment(q, P['loomis_taylor'], P['loomis_18th'])
  rows.append(('30K', 30000, d, 'Loomis St, Taylor..18th (0 = on it)', q))
  spot('mile 20', 32187, P['halsted_18th'], 'Halsted St & 18th St')
  spot('mile 26', 41843, P['michigan_roosevelt'], 'Michigan Ave & Roosevelt Rd')
  return rows


def render(route, png, marks):
  """Plain route map: line, 5K dots, mile 10/11/20/26, start/finish."""
  lats = [r[0] for r in route]
  lons = [r[1] for r in route]
  pad = 0.004
  la0, la1 = min(lats) - pad, max(lats) + pad
  lo0, lo1 = min(lons) - pad * 1.5, max(lons) + pad * 1.5
  kx = math.cos(math.radians((la0 + la1) / 2))
  H = 1600
  W = int(H * (lo1 - lo0) * kx / (la1 - la0)) + 360
  sc = H / (la1 - la0)
  def px(p):
    return ((p[1] - lo0) * kx * sc + 20, (la1 - p[0]) * sc)
  pts = ' '.join('%.1f,%.1f' % px(r) for r in route[::2] + [route[-1]])
  draw = ['-fill', 'none', '-stroke', '#1F2A5C', '-strokewidth', '4',
          '-draw', 'polyline ' + pts]
  # Faint grid every 0.01 deg for scale.
  grid = []
  for k in range(int(la0 * 100), int(la1 * 100) + 2):
    y = px((k / 100, lo0))[1]
    grid += ['-draw', 'line 0,%.1f %d,%.1f' % (y, W, y)]
  for k in range(int(lo0 * 100) - 1, int(lo1 * 100) + 2):
    x = px((la0, k / 100))[0]
    grid += ['-draw', 'line %.1f,0 %.1f,%d' % (x, x, H)]
  cmd = ['convert', '-size', '%dx%d' % (W, H), 'xc:#F4F4F1',
         '-stroke', '#DDDDD6', '-strokewidth', '1'] + grid + draw
  cmd += ['-stroke', 'none', '-font', 'DejaVu-Sans', '-pointsize', '15']
  for km in range(5, 45, 5):
    m = min(km * 1000, 42195)
    x, y = px(routelib.point_at(route, m))
    cmd += ['-fill', '#2B6CB0', '-draw',
            'circle %.1f,%.1f %.1f,%.1f' % (x, y, x + 7, y),
            '-fill', '#2B6CB0', '-draw',
            "text %.1f,%.1f '%dK'" % (x + 10, y - 8, km)]
  for mi in (10, 11, 20, 26):
    x, y = px(routelib.point_at(route, mi * MILE))
    cmd += ['-fill', '#D62828', '-draw',
            'circle %.1f,%.1f %.1f,%.1f' % (x, y, x + 8, y),
            '-fill', '#D62828', '-draw',
            "text %.1f,%.1f 'mile %d'" % (x - 70, y + 5, mi)]
  for name, p in marks:
    x, y = px(p)
    cmd += ['-fill', 'none', '-stroke', '#2F855A', '-strokewidth', '2',
            '-draw', 'circle %.1f,%.1f %.1f,%.1f' % (x, y, x + 12, y),
            '-stroke', 'none']
  for name, p, col in (('START', route[0], '#111111'),
                       ('FINISH', route[-1], '#111111')):
    x, y = px(p)
    cmd += ['-fill', col, '-draw',
            'rectangle %.1f,%.1f %.1f,%.1f' % (x - 5, y - 5, x + 5, y + 5),
            '-draw', "text %.1f,%.1f '%s'" % (x + 9, y + (16 if name ==
                                                           'FINISH' else -6),
                                              name)]
  cmd += ['-fill', '#333333', '-pointsize', '17', '-draw',
          "text %d,%d 'Chicago 2026 route.js check: blue = every 5K, red = "
          "miles 10/11/20/26, green rings = official spots'" % (20, H - 20),
          png]
  subprocess.run(cmd, check=True)


def main():
  args = [a for a in sys.argv[1:] if not a.startswith('--')]
  path = args[0] if args else os.path.join(routelib.PROJECT, 'route.js')
  route, meta = load_route(path)
  P = osm_points()
  print('route', path, 'points', len(route), 'raw', meta['rawLengthM'],
        'scale', meta['scale'])
  rows = checkpoints(route, P)
  for name, m, d, where, q in rows:
    print('  %-8s %6d m -> %4.0f m from %s  (%.5f, %.5f)' % (name, m, d, where,
                                                            q[0], q[1]))
  if '--png' in sys.argv:
    png = sys.argv[sys.argv.index('--png') + 1]
    marks = [(k, P[k]) for k in ('fullerton_clark', 'north_sedgwick',
                                  'franklin_adams', 'halsted_18th',
                                  'michigan_roosevelt')]
    render(route, png, marks)
    print('wrote', png)
  return rows


if __name__ == '__main__':
  main()
