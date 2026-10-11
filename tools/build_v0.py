"""v0: straight segments between turn intersections (grid estimates).

Coordinates are approximate street-centreline intersections from the Chicago
address grid; good to ~50-100 m. Superseded by build_route.py (v1, routed).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import routelib  # pylint: disable=g-import-not-at-top

WAYPOINTS = [
    ('start: Columbus Dr @ Monroe', 41.88070, -87.62050),
    ('Columbus Dr @ Grand Ave', 41.89180, -87.62050),
    ('Grand Ave @ Dearborn St', 41.89180, -87.62950),
    ('Dearborn St @ Jackson Blvd', 41.87810, -87.62950),
    ('Jackson Blvd @ LaSalle St', 41.87810, -87.63240),
    ('LaSalle @ North Ave', 41.91000, -87.63250),
    ('LaSalle Dr bend', 41.91200, -87.63150),
    ('Stockton Dr south end', 41.91350, -87.63250),
    ('Stockton Dr @ Fullerton', 41.92550, -87.63500),
    ('Fullerton @ Cannon Dr', 41.92560, -87.63300),
    ('Cannon Dr @ Diversey', 41.93260, -87.63800),
    ('Sheridan Rd @ Belmont', 41.94000, -87.63850),
    ('Inner LSD @ Sheridan Rd (top)', 41.95300, -87.64500),
    ('Sheridan Rd @ Broadway', 41.95350, -87.65050),
    ('Broadway bend', 41.94300, -87.64450),
    ('Broadway @ Diversey / Clark', 41.93260, -87.64450),
    ('Clark St @ Fullerton', 41.92560, -87.63960),
    ('Clark St @ Webster', 41.92170, -87.63680),
    ('Webster @ Sedgwick', 41.92170, -87.63860),
    ('Sedgwick @ North Ave', 41.91070, -87.63860),
    ('North Ave @ Wells', 41.91070, -87.63470),
    ('Wells @ Lake St', 41.88570, -87.63390),
    ('Lake St @ Franklin', 41.88570, -87.63530),
    ('Franklin @ Adams', 41.87940, -87.63530),
    ('Adams @ Damen', 41.87940, -87.67660),
    ('Damen @ Jackson', 41.87810, -87.67660),
    ('Jackson @ Halsted', 41.87810, -87.64740),
    ('Halsted @ Taylor', 41.86950, -87.64700),
    ('Taylor @ Loomis', 41.86950, -87.66180),
    ('Loomis @ 18th St', 41.85780, -87.66150),
    ('18th St @ Halsted', 41.85780, -87.64680),
    ('Halsted @ Canalport', 41.85450, -87.64670),
    ('Canalport @ Cermak', 41.85300, -87.64800),
    ('Cermak @ Archer', 41.85300, -87.63400),
    ('Archer @ Wentworth', 41.85420, -87.63200),
    ('Wentworth @ 26th St', 41.84470, -87.63200),
    ('26th St @ Michigan', 41.84470, -87.62340),
    ('Michigan @ 35th St', 41.83090, -87.62330),
    ('35th St @ Indiana', 41.83090, -87.62150),
    ('Indiana @ 31st St', 41.83820, -87.62150),
    ('31st St @ Michigan', 41.83820, -87.62340),
    ('Michigan @ Roosevelt', 41.86760, -87.62450),
    ('Roosevelt @ Columbus', 41.86740, -87.62050),
    ('finish: Columbus Dr N of Roosevelt', 41.86900, -87.62050),
]

if __name__ == '__main__':
  pts = [(la, lo) for _, la, lo in WAYPOINTS]
  route, meta = routelib.build(
      pts, 'v0: straight segments between turn intersections (grid estimates)')
  print(meta, len(route), 'points')
