"""v1 builder: chain OSM street centrelines between course turn intersections.

Each leg is a shortest path restricted to ways carrying the course street's
name (one-way tags ignored), so the line follows the actual course streets
instead of sidewalks or park paths. Turn points are the OSM nodes shared by
the two streets, picked nearest to a hint coordinate read off the official map.

  python3 tools/build_route.py            # build route.js from cached OSM
  python3 tools/build_route.py --refetch  # refresh tools/cache from Overpass
"""
import heapq
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_osm  # pylint: disable=g-import-not-at-top
import routelib  # pylint: disable=g-import-not-at-top

hav = routelib.hav
DIRS = {'North', 'South', 'East', 'West', 'Upper'}
TYPES = {'Avenue', 'Street', 'Drive', 'Road', 'Boulevard', 'Parkway', 'Place',
         'Court', 'Lane', 'Way'}


def norm(name):
  """'West North Avenue' -> 'North Avenue'; 'Upper North Columbus Drive' ->
  'Columbus Drive'. Lower-level and service drives are excluded."""
  if not name or 'Lower' in name or 'Service' in name:
    return None
  words = name.split()
  while (len(words) > 1 and words[0] in DIRS and
         not (len(words) == 2 and words[1] in TYPES)):
    words = words[1:]
  return ' '.join(words)


# Turn list. Each entry: (street for the leg that ENDS here, cross street,
# hint lat, hint lon, label). The first entry is the start (street=None).
# Streets may be a tuple of OSM names (after norm()) that the leg may use.
COURSE = [
    (None, 'Columbus Drive', 41.88063, -87.62078,
     'start: Columbus Dr @ Monroe St'),
    ('Columbus Drive', 'Grand Avenue', 41.89180, -87.62050,
     'Columbus Dr -> W Grand Ave'),
    ('Grand Avenue', 'Dearborn Street', 41.89180, -87.62950,
     'Grand Ave -> S Dearborn St'),
    ('Dearborn Street', 'Jackson Boulevard', 41.87810, -87.62950,
     'Dearborn St -> W Jackson Blvd'),
    ('Jackson Boulevard', 'LaSalle Street', 41.87810, -87.63240,
     'Jackson Blvd -> N LaSalle St'),
    (('LaSalle Street', 'LaSalle Drive'), 'Stockton Drive', 41.91300, -87.63250,
     'LaSalle Dr -> N Stockton Dr'),
    ('Stockton Drive', 'Fullerton Parkway', 41.92550, -87.63500,
     'Stockton Dr -> E Fullerton Pkwy'),
    ('Fullerton Parkway', 'Cannon Drive', 41.92560, -87.63300,
     'Fullerton Pkwy -> N Cannon Dr'),
    ('Cannon Drive', 'Sheridan Road', 41.93260, -87.63800,
     'Cannon Dr -> N Sheridan Rd'),
    ('Sheridan Road', 'Lake Shore Drive', 41.94000, -87.63850,
     'Sheridan Rd -> N Inner Lake Shore Dr'),
    ('Lake Shore Drive', 'Sheridan Road', 41.95300, -87.64500,
     'Inner Lake Shore Dr -> W Sheridan Rd'),
    ('Sheridan Road', 'Broadway', 41.95350, -87.65050,
     'Sheridan Rd -> S Broadway'),
    ('Broadway', 'Clark Street', 41.93260, -87.64450,
     'Broadway -> SE Clark St (Diversey)'),
    ('Clark Street', 'Webster Avenue', 41.92197, -87.63827,
     'Clark St -> W Webster Ave'),
    ('Webster Avenue', 'Sedgwick Street', 41.92196, -87.63894,
     'Webster Ave -> S Sedgwick St'),
    ('Sedgwick Street', 'North Avenue', 41.91070, -87.63860,
     'Sedgwick St -> E North Ave'),
    ('North Avenue', 'Wells Street', 41.91070, -87.63470,
     'North Ave -> S Wells St'),
    # The map's line hugs the river: W on Wacker Dr from Wells, then S on
    # the N-S leg of Wacker Dr to Adams (one block W of Franklin St).
    ('Wells Street', 'Wacker Drive', 41.88680, -87.63390,
     'Wells St -> W Wacker Dr'),
    ('Wacker Drive', 'Adams Street', 41.87940, -87.63700,
     'Wacker Dr -> W Adams St'),
    ('Adams Street', 'Damen Avenue', 41.87940, -87.67660,
     'Adams St -> S Damen Ave'),
    ('Damen Avenue', 'Jackson Boulevard', 41.87810, -87.67660,
     'Damen Ave -> E Jackson Blvd'),
    ('Jackson Boulevard', 'Halsted Street', 41.87810, -87.64740,
     'Jackson Blvd -> S Halsted St'),
    ('Halsted Street', 'Taylor Street', 41.86950, -87.64700,
     'Halsted St -> W Taylor St'),
    ('Taylor Street', 'Loomis Street', 41.86950, -87.66180,
     'Taylor St -> S Loomis St'),
    ('Loomis Street', '18th Street', 41.85780, -87.66150,
     'Loomis St -> E 18th St'),
    ('18th Street', 'Halsted Street', 41.85780, -87.64680,
     '18th St -> S Halsted St'),
    ('Halsted Street', 'Canalport Avenue', 41.85450, -87.64670,
     'Halsted St -> SW Canalport Ave'),
    ('Canalport Avenue', 'Cermak Road', 41.85300, -87.64800,
     'Canalport Ave -> E Cermak Rd'),
    # The map's line stays on Cermak Rd to Wentworth (no jog up Archer Ave).
    ('Cermak Road', 'Wentworth Avenue', 41.85300, -87.63200,
     'Cermak Rd -> S Wentworth Ave'),
    ('Wentworth Avenue', '26th Street', 41.84470, -87.63200,
     'Wentworth Ave -> E 26th St'),
    ('26th Street', 'Michigan Avenue', 41.84470, -87.62340,
     '26th St -> S Michigan Ave'),
    ('Michigan Avenue', '35th Street', 41.83090, -87.62330,
     'Michigan Ave -> E 35th St'),
    ('35th Street', 'Indiana Avenue', 41.83090, -87.62150,
     '35th St -> N Indiana Ave'),
    ('Indiana Avenue', '31st Street', 41.83820, -87.62150,
     'Indiana Ave -> W 31st St'),
    ('31st Street', 'Michigan Avenue', 41.83820, -87.62340,
     '31st St -> N Michigan Ave'),
    ('Michigan Avenue', 'Roosevelt Road', 41.86760, -87.62450,
     'Michigan Ave -> E Roosevelt Rd'),
    ('Roosevelt Road', 'Columbus Drive', 41.86740, -87.62050,
     'Roosevelt Rd -> N Columbus Dr'),
]
# Finish: this far north of the Roosevelt/Columbus turn, along Columbus Dr.
# Georeferenced map: the FINISH box sits ~305 m N of Roosevelt and the mile 26
# marker ~85 m W of Columbus on Roosevelt (-> finish ~267 m N of the turn).
FINISH_AFTER_TURN_M = float(os.environ.get('FINISH_AFTER_TURN_M', '285'))
FINISH_TOWARD = ('Columbus Drive', 41.88070, -87.62078)  # start node


class Graph:
  """Street graph from Overpass ways; edges labelled with normalised names."""

  def __init__(self, js):
    self.coord = {}
    self.adj = {}  # node -> list of (node, dist, key)
    self.by_key = {}  # key -> set(node)
    for w in js['elements']:
      if w['type'] != 'way':
        continue
      key = norm(w['tags'].get('name'))
      if key is None:
        continue
      nodes, geom = w['nodes'], w['geometry']
      for nid, g in zip(nodes, geom):
        self.coord[nid] = (g['lat'], g['lon'])
        self.by_key.setdefault(key, set()).add(nid)
      for a, b in zip(nodes, nodes[1:]):
        d = hav(self.coord[a], self.coord[b])
        self.adj.setdefault(a, []).append((b, d, key))
        self.adj.setdefault(b, []).append((a, d, key))

  def keys_like(self, key):
    return self.by_key.get(key, set())

  def intersection(self, keys_a, key_b, hint, max_off=150.0):
    if isinstance(keys_a, str):
      keys_a = (keys_a,)
    na = set().union(*(self.keys_like(k) for k in keys_a))
    nb = self.keys_like(key_b)
    common = na & nb
    if common:
      best = min(common, key=lambda n: hav(self.coord[n], hint))
      off = hav(self.coord[best], hint)
      if off <= max_off:
        return best, off
    # No shared node near the hint: take street A's node at the closest
    # approach to street B, searching within 400 m of the hint.
    near_a = [n for n in na if hav(self.coord[n], hint) < 400]
    near_b = [n for n in nb if hav(self.coord[n], hint) < 400]
    if not near_a or not near_b:
      return None, None
    best = min(((hav(self.coord[a], self.coord[b]), a) for a in near_a
                for b in near_b))
    print('   (no shared node for %s x %s; closest approach %.0f m)' %
          (keys_a, key_b, best[0]))
    return best[1], hav(self.coord[best[1]], hint)

  def path(self, src, dst, keys, snap=45.0):
    """Shortest path on ways named `keys` from node src to node dst.

    Any node of the street within `snap` m of src/dst may start/end the path
    (joined to src/dst by a straight stub), which handles divided roads where
    the turn node sits on the other carriageway.
    """
    if isinstance(keys, str):
      keys = (keys,)
    keys = set(keys)
    street_nodes = set().union(*(self.keys_like(k) for k in keys))
    c_src, c_dst = self.coord[src], self.coord[dst]
    dist, prev, pq = {}, {}, []
    for n in street_nodes | {src}:
      d0 = hav(self.coord[n], c_src)
      if d0 <= snap:
        dist[n] = d0
        prev[n] = None
        heapq.heappush(pq, (d0, n))
    targets = {n for n in street_nodes | {dst}
               if hav(self.coord[n], c_dst) <= snap}
    best, best_t = math.inf, None
    while pq:
      d, u = heapq.heappop(pq)
      if d >= best:
        break
      if d > dist.get(u, math.inf):
        continue
      if u in targets:
        cand = d + hav(self.coord[u], c_dst)
        if cand < best:
          best, best_t = cand, u
      for v, w, k in self.adj.get(u, ()):
        if k not in keys:
          continue
        nd = d + w
        if nd < dist.get(v, math.inf):
          dist[v] = nd
          prev[v] = u
          heapq.heappush(pq, (nd, v))
    if best_t is None:
      return None, None
    seq = [best_t]
    while prev[seq[-1]] is not None:
      seq.append(prev[seq[-1]])
    seq.reverse()
    coords = [c_src] + [self.coord[n] for n in seq] + [c_dst]
    return routelib.dedupe(coords, min_gap=0.5), best


def build_polyline(g, verbose=True):
  pts = []
  turns = []  # (label, lat, lon, raw cum m at the turn)
  legs = []
  turn_idx = []  # index into pts of each interior turn vertex
  prev_node = None
  cum = 0.0
  for street, cross, la, lo, label in COURSE:
    if street is None:
      node = min(g.keys_like(cross), key=lambda n: hav(g.coord[n], (la, lo)))
      off = hav(g.coord[node], (la, lo))
    else:
      node, off = g.intersection(street, cross, (la, lo))
    if node is None:
      raise SystemExit('no intersection for %s' % label)
    if street is None:
      pts.append(g.coord[node])
    else:
      seg, d = g.path(prev_node, node, street)
      straight = hav(g.coord[prev_node], g.coord[node])
      if seg is None:
        print('!! no path for leg ending %s; using straight line' % label)
        seg, d = [g.coord[prev_node], g.coord[node]], straight
      pts.extend(seg[1:])
      turn_idx.append(len(pts) - 1)
      cum += d
      legs.append((label, d, straight))
    turns.append((label, g.coord[node][0], g.coord[node][1], cum, off))
    prev_node = node
  # Finish: walk north along Columbus Dr from the Roosevelt turn.
  street, la, lo = FINISH_TOWARD
  node = min(g.keys_like(street), key=lambda n: hav(g.coord[n], (la, lo)))
  seg, _ = g.path(prev_node, node, street)
  if seg is None:
    raise SystemExit('no Columbus Dr path toward Balbo for the finish')
  run = 0.0
  for a, b in zip(seg, seg[1:]):
    d = hav(a, b)
    if run + d >= FINISH_AFTER_TURN_M:
      t = (FINISH_AFTER_TURN_M - run) / d
      pts.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
      run = FINISH_AFTER_TURN_M
      break
    pts.append(b)
    run += d
  cum += run
  legs.append(('finish on Columbus Dr', run, run))
  turns.append(('finish', pts[-1][0], pts[-1][1], cum, 0.0))
  if verbose:
    print('%-40s %9s %9s %7s %6s' % ('leg ending at', 'leg m', 'straight',
                                      'ratio', 'hint'))
    for (label, d, s), t in zip(legs, turns[1:]):
      print('%-40s %9.0f %9.0f %7.3f %6.0f' % (label, d, s,
                                                d / s if s else 0, t[4]))
  return pts, turns, legs, turn_idx


APEX_M = float(os.environ.get('APEX_M', '14'))


def main():
  js = fetch_osm.fetch(force='--refetch' in sys.argv)
  g = Graph(js)
  pts, turns, _, turn_idx = build_polyline(g)
  centre_len = routelib.polyline_length(routelib.dedupe(pts))
  pts, savings = routelib.fillet_turns(pts, turn_idx, apex_m=APEX_M)
  print('centreline %.0f m; racing-line corner cuts at %d turns save %.0f m'
        % (centre_len, sum(1 for v in savings if v), sum(savings)))
  out = None
  if '--out' in sys.argv:
    out = os.path.abspath(sys.argv[sys.argv.index('--out') + 1])
  route, meta = routelib.build(
      pts,
      'v1: OSM street centrelines (Overpass, (c) OpenStreetMap contributors) '
      'chained along the official 2026 course turn list, corners cut to the '
      'racing line (apex %.0f m inside each intersection); finish %.0f m N of '
      'Roosevelt on Columbus Dr' % (APEX_M, FINISH_AFTER_TURN_M),
      out_path=out)
  with open(os.path.join(routelib.HERE, 'turns.json'), 'w') as f:
    json.dump({'meta': meta, 'turns': turns}, f, indent=1)
  print(json.dumps(meta))
  print(len(route), 'points')


if __name__ == '__main__':
  main()
