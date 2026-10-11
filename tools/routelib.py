"""Shared helpers for building chicago-pacer/route.js.

route.js format (plain ES module, no deps):
  export const ROUTE = [[lat, lon, cumM], ...]  // start -> finish, <=40 m spacing,
                                                // cumM monotonic 0 .. exactly 42195
  export const ROUTE_META = { rawLengthM, scale, source, builtAt }
"""
import datetime
import json
import math
import os

MARATHON_M = 42195.0
R_EARTH = 6371008.8  # mean Earth radius, metres

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)


def hav(a, b):
  """Great-circle distance in metres between (lat, lon) points a and b."""
  la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
  h = (math.sin((la2 - la1) / 2) ** 2
       + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2)
  return 2 * R_EARTH * math.asin(min(1.0, math.sqrt(h)))


def dedupe(pts, min_gap=0.5):
  out = []
  for p in pts:
    if not out or hav(out[-1], p) >= min_gap:
      out.append((float(p[0]), float(p[1])))
  return out


def polyline_length(pts):
  return sum(hav(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def densify(pts, max_step):
  """Insert points so that no segment is longer than max_step metres."""
  out = [pts[0]]
  for a, b in zip(pts, pts[1:]):
    d = hav(a, b)
    n = max(1, int(math.ceil(d / max_step)))
    for k in range(1, n + 1):
      t = k / n
      out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
  return out


def point_at(route, m):
  """(lat, lon) at scaled distance m along a [[lat, lon, cum], ...] route."""
  if m <= 0:
    return tuple(route[0][:2])
  for i in range(1, len(route)):
    if route[i][2] >= m:
      a, b = route[i - 1], route[i]
      t = (m - a[2]) / (b[2] - a[2]) if b[2] > a[2] else 0
      return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
  return tuple(route[-1][:2])


def fillet_turns(pts, turn_idx, apex_m=14.0, max_t=45.0, min_deg=20.0):
  """Cut each turn like a runner on the racing line.

  The course is certified on the shortest path a runner could take (hugging
  the inside of every corner), while street centrelines go through the middle
  of each intersection. At each turn vertex we replace the corner with a
  quadratic Bezier (control point = the intersection centre) whose apex is
  ~apex_m inside the centre, i.e. about at the inside kerb corner.
  Returns (new_pts, per-turn savings in metres).
  """
  lat0 = sum(p[0] for p in pts) / len(pts)
  lon0 = sum(p[1] for p in pts) / len(pts)
  ky = math.pi / 180 * R_EARTH
  kx = ky * math.cos(math.radians(lat0))
  xy = [((p[1] - lon0) * kx, (p[0] - lat0) * ky) for p in pts]
  cum = [0.0]
  for a, b in zip(xy, xy[1:]):
    cum.append(cum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))

  def at(s):
    s = max(0.0, min(cum[-1], s))
    lo, hi = 0, len(cum) - 1
    while hi - lo > 1:
      mid = (lo + hi) // 2
      if cum[mid] <= s:
        lo = mid
      else:
        hi = mid
    seg = cum[hi] - cum[lo]
    t = (s - cum[lo]) / seg if seg > 0 else 0.0
    a, b = xy[lo], xy[hi]
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t), lo

  cuts = []  # (s_in, s_out, control xy)
  savings = []
  idx = sorted(i for i in turn_idx if 0 < i < len(pts) - 1)
  for k, i in enumerate(idx):
    s = cum[i]
    s_prev = cum[idx[k - 1]] if k else 0.0
    s_next = cum[idx[k + 1]] if k + 1 < len(idx) else cum[-1]
    probe = 30.0
    a, _ = at(s - probe)
    b, _ = at(s + probe)
    c = xy[i]
    v1 = (c[0] - a[0], c[1] - a[1])
    v2 = (b[0] - c[0], b[1] - c[1])
    n1, n2 = math.hypot(*v1), math.hypot(*v2)
    if n1 < 1 or n2 < 1:
      savings.append(0.0)
      continue
    cosd = max(-1.0, min(1.0, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)))
    theta = math.acos(cosd)
    if math.degrees(theta) < min_deg:
      savings.append(0.0)
      continue
    half = math.cos(theta / 2)
    t = 2 * apex_m / max(half, 1e-3)
    t = min(t, max_t, 0.45 * (s - s_prev), 0.45 * (s_next - s))
    cuts.append((s - t, s + t, c))
    savings.append(None)  # filled after building

  out = []
  pos = -1.0  # so the start point (cum 0) is kept
  bez_len = []
  for s_in, s_out, c in cuts:
    # Original vertices strictly between pos and s_in.
    for j in range(len(xy)):
      if pos < cum[j] < s_in:
        out.append(xy[j])
    p0, _ = at(s_in)
    p2, _ = at(s_out)
    n = max(4, int((s_out - s_in) / 4))
    length = 0.0
    prev = p0
    for q in range(n + 1):
      u = q / n
      x = (1 - u) ** 2 * p0[0] + 2 * (1 - u) * u * c[0] + u * u * p2[0]
      y = (1 - u) ** 2 * p0[1] + 2 * (1 - u) * u * c[1] + u * u * p2[1]
      length += math.hypot(x - prev[0], y - prev[1])
      prev = (x, y)
      out.append((x, y))
    bez_len.append((s_out - s_in) - length)
    pos = s_out
  for j in range(len(xy)):
    if cum[j] > pos:
      out.append(xy[j])
  it = iter(bez_len)
  savings = [next(it) if v is None else v for v in savings]
  new_pts = [(lat0 + y / ky, lon0 + x / kx) for x, y in out]
  return dedupe(new_pts, min_gap=0.3), savings


def build(pts, source, out_path=None, max_step=25.0):
  """Dedupe, densify, measure, scale to 42195 m and write route.js.

  Returns (route, meta).
  """
  pts = dedupe(pts)
  raw = polyline_length(pts)
  scale = MARATHON_M / raw
  # Keep both the physical spacing and the scaled cumM spacing under 40 m.
  step = max_step / max(1.0, scale)
  dense = dedupe(densify(pts, step), min_gap=0.05)
  route = []
  cum = 0.0
  for i, p in enumerate(dense):
    if i:
      cum += hav(dense[i - 1], p)
    route.append([round(p[0], 6), round(p[1], 6), cum * scale])
  # Pin the end exactly and round; enforce strict monotonicity after rounding.
  route[-1][2] = MARATHON_M
  prev = -1.0
  clean = []
  for lat, lon, c in route:
    c = round(c, 1)
    if c <= prev:
      continue
    clean.append([lat, lon, c])
    prev = c
  clean[0][2] = 0
  clean[-1][2] = 42195
  meta = {
      'rawLengthM': round(raw, 1),
      'scale': round(scale, 6),
      'source': source,
      'builtAt': datetime.datetime.now(datetime.timezone.utc).strftime(
          '%Y-%m-%dT%H:%M:%SZ'),
  }
  if out_path is None:
    out_path = os.path.join(PROJECT, 'route.js')
  write_js(clean, meta, out_path)
  return clean, meta


def write_js(route, meta, out_path):
  lines = [
      '// Chicago Marathon 2026 course centreline, start line -> finish line.',
      '// Generated by tools/build_route.py. Do not edit by hand.',
      '// ROUTE rows are [lat, lon, cumM]; cumM is scaled so the finish is'
      ' exactly 42195 m.',
      'export const ROUTE_META = ' + json.dumps(meta) + ';',
      'export const ROUTE = [',
  ]
  rows = []
  for lat, lon, c in route:
    cs = ('%.1f' % c).rstrip('0').rstrip('.') if c else '0'
    rows.append('[%.6f,%.6f,%s]' % (lat, lon, cs))
  # A few rows per line keeps the file compact but diffable.
  for i in range(0, len(rows), 4):
    lines.append(','.join(rows[i:i + 4]) + ',')
  lines.append('];')
  lines.append('')
  tmp = out_path + '.tmp'
  with open(tmp, 'w') as f:
    f.write('\n'.join(lines))
  os.replace(tmp, out_path)
