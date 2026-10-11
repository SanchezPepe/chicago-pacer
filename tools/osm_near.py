"""Debug: list OSM ways of given street keys near a point."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_route  # pylint: disable=g-import-not-at-top
import fetch_osm  # pylint: disable=g-import-not-at-top
from routelib import hav  # pylint: disable=g-import-not-at-top


def near(js, lat, lon, radius, keys=None):
  out = []
  for w in js['elements']:
    if w['type'] != 'way':
      continue
    name = w['tags'].get('name')
    k = build_route.norm(name)
    if keys and k not in keys:
      continue
    dmin = min(hav((g['lat'], g['lon']), (lat, lon)) for g in w['geometry'])
    if dmin <= radius:
      g0, g1 = w['geometry'][0], w['geometry'][-1]
      out.append((dmin, w['id'], name, w['tags'].get('highway'),
                  w['tags'].get('layer', ''), w['tags'].get('bridge', ''),
                  (round(g0['lat'], 5), round(g0['lon'], 5)),
                  (round(g1['lat'], 5), round(g1['lon'], 5)),
                  len(w['nodes'])))
  for row in sorted(out):
    print('%5.0f m  way %-11s %-34s %-12s L%-3s br=%-4s %s -> %s n=%d' % row)


if __name__ == '__main__':
  js = fetch_osm.fetch()
  lat, lon, radius = float(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3])
  keys = set(sys.argv[4:]) or None
  near(js, lat, lon, radius, keys)
