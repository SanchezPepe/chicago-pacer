"""Fetch named street geometry for the course area from Overpass (cached)."""
import json
import os
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, 'cache')
os.makedirs(CACHE, exist_ok=True)
UA = 'chicago-pacer-route-builder/1.0 (SanchezPepe@users.noreply.github.com)'

NAME_RE = ('Columbus|Grand Avenue|Dearborn|Jackson Boulevard|LaSalle|La Salle|'
           'Stockton|Cannon|Sheridan|Lake Shore|Broadway|Clark Street|'
           'Sedgwick|North Avenue|Wells Street|Franklin Street|Adams Street|'
           'Damen|Halsted|Taylor Street|Loomis|18th Street|Canalport|Cermak|'
           'Archer|Wentworth|26th Street|Michigan Avenue|35th Street|'
           'Indiana Avenue|31st Street|30th Street|Roosevelt|Lake Street|'
           'Fullerton|Webster|Diversey|Wacker|Monroe Street|Irving Park|'
           'Grace Street|Byron|Belmont|Lincoln Park West|Clinton|Wolcott|'
           'Illinois Street')
BBOX = (41.826, -87.690, 41.962, -87.610)

QUERY = """[out:json][timeout:120];
way["highway"]["name"~"%s"]
   ["highway"!~"^(footway|path|cycleway|steps|corridor|elevator|platform|proposed|construction|bridleway|track)$"]
   (%f,%f,%f,%f);
out body geom;
""" % ((NAME_RE,) + BBOX)

ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
]


def fetch(force=False):
  path = os.path.join(CACHE, 'overpass_streets.json')
  if os.path.exists(path) and not force:
    with open(path) as f:
      return json.load(f)
  data = urllib.parse.urlencode({'data': QUERY}).encode()
  last = None
  for ep in ENDPOINTS:
    try:
      req = urllib.request.Request(ep, data=data, headers={'User-Agent': UA})
      with urllib.request.urlopen(req, timeout=180) as r:
        js = json.load(r)
      with open(path, 'w') as f:
        json.dump(js, f)
      return js
    except Exception as e:  # pylint: disable=broad-except
      last = e
      print('overpass failed at', ep, e, file=sys.stderr)
  raise last


if __name__ == '__main__':
  js = fetch(force='--force' in sys.argv)
  ways = [e for e in js['elements'] if e['type'] == 'way']
  names = {}
  for w in ways:
    n = w['tags'].get('name')
    names.setdefault(n, set()).add(w['tags'].get('highway'))
  print(len(ways), 'ways')
  for n in sorted(names):
    print(repr(n), sorted(names[n]))
