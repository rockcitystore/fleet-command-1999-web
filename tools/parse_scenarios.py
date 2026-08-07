#!/usr/bin/env python3
"""
Parse the ORIGINAL Fleet Command (1999) scenario files (.scc / .scs) into a
single playable JSON mission library for the web port.

The original scenario files are plain CRLF text with a simple block grammar:

    ENTITY "<name>" <SURFENTITY|SUBENTITY|AIRENTITY|BUILDINGENTITY|MINEENTITY>
    ALLIANCE <n>
    POS <x> <y> <z>
    COURSE <deg>   SPEED <kts>   PROB <0-100>   POINTS <n>
    COUNTRY "..."  CLASS "..."   SHIPNAME "..."  UNIQUENAME "..."
    GROUP <n>      TACTIC <NAME>  FORMATIONLEADER "..."
    WAYPOINT <x> <y> <z> <speed>            (repeatable)
    BOX <x1> <y1> <x2> <y2>
    AIRCRAFT "<key>" "<display>" "<role>" "<country>" <count>   (repeatable)
    SOURCEOBJECT "<platform>" INFLIGHT
    END

    GOAL <x> <y> <radius>
    BEGIN
    GOALNAME "..."  GOALID <n>  PARENTGOALID <n>  SIDE <n>
    GOALTYPE <0|1|2|3>   [DAMAGE <pct>]
    STARTTIME <sec>  ENDTIME <sec>  POINTS <n>
    UNIQUENAME/TAGNAME/CLASS/GROUP/COUNTRY  -> target selector
    SUCCESSMESSAGE BEGINTEXT ... ENDTEXT
    FAILUREMESSAGE BEGINTEXT ... ENDTEXT
    END

GOALTYPE semantics (decoded by inspecting all 653 goals in the shipped files):
    0 = REACH   -- the tagged unit must enter the GOAL circle in the time window
    1 = RECOVER -- pick up a named entity and return it to base (RETURNTOBASE 1)
    2 = DESTROY -- damage the selected target(s) to >= DAMAGE percent
    3 = AGGREGATE -- parent node; satisfied when its child goals are satisfied

Usage:
    python3 tools/parse_scenarios.py \
        --src "/path/to/Fleet Command/scenario" \
        --out assets/data/missions.json
"""

import argparse
import json
import math
import os
import re
import sys
from collections import OrderedDict

# --------------------------------------------------------------------------
# Engine constants mirrored from js/engine.js. Keep in sync.
# --------------------------------------------------------------------------
WORLD_SIZE = 4000
METERS_PER_UNIT = 92.6          # authentic scale: 4000 u == ~200 nmi
# The engine's playable box is WORLD_SIZE x WORLD_SIZE. Anything outside it
# breaks the camera, the minimap and the terrain clip, so a mission's order of
# battle is scaled down until it fits with a margin on every side.
WORLD_MARGIN_U = 220
MAX_MISSION_SPAN_U = WORLD_SIZE - 2 * WORLD_MARGIN_U   # 3560
NM_TO_M = 1852.0

# Neutral merchant traffic is atmospheric but expensive; cap it per mission.
MAX_NEUTRALS = 10

# --------------------------------------------------------------------------
# Hull-code -> engine ship class. The original CLASS string always ends with
# a NATO-style hull code ("ARLEIGH BURKE DDG", "KILO SSK", "NIMITZ CVN").
# --------------------------------------------------------------------------
HULL_TO_CLASS = {
    # Carriers / big-deck amphibs
    'CV': 'carrier', 'CVN': 'carrier', 'CVS': 'carrier', 'CVH': 'carrier',
    'LHD': 'carrier', 'LHA': 'carrier', 'LPH': 'carrier',
    # Cruisers
    'CG': 'cruiser', 'CGN': 'cruiser', 'CGH': 'cruiser',
    # Battleships
    'BB': 'battleship', 'BBG': 'battleship',
    # Destroyers
    'DD': 'destroyer', 'DDG': 'destroyer', 'DDH': 'destroyer',
    # Frigates / corvettes / patrol / auxiliaries
    'FF': 'frigate', 'FFG': 'frigate', 'FFH': 'frigate', 'FFL': 'frigate',
    'FS': 'frigate', 'FSG': 'frigate',
    'PCFG': 'frigate', 'PGF': 'frigate', 'PGG': 'frigate', 'PHT': 'frigate',
    'PBI': 'frigate', 'PB': 'frigate', 'PC': 'frigate',
    'MCM': 'frigate', 'MHC': 'frigate', 'MSO': 'frigate',
    'AGI': 'frigate', 'AOE': 'frigate', 'AOR': 'frigate', 'AO': 'frigate',
    'LST': 'frigate', 'LSD': 'frigate', 'LPD': 'frigate',
    'MERCHANT': 'merchant', 'RAFT': 'merchant',
    # Submarines
    'SS': 'submarine', 'SSK': 'submarine', 'SSN': 'submarine',
    'SSGN': 'submarine', 'SSBN': 'submarine',
}

# Original aircraft role -> engine archetype. Display name stays authentic.
ROLE_TO_ARCHETYPE = {
    'Fighter/Attack': 'F/A-18 Hornet',
    'Maritime Patrol': 'P-3 Orion',
    'ASW': 'S-3 Viking',
    'Airborne Early Warning': 'E-2 Hawkeye',
    'Electronic Warfare': 'EA-6B Prowler',
    'Electronic Reconnaissance': 'ES-3 Viking',
    'Helicopter': 'SH-60F Sea Hawk',
    'CIVILIAN AIRCRAFT': 'Civil Airliner',
}

GOAL_TYPES = {0: 'reach', 1: 'recover', 2: 'destroy', 3: 'aggregate'}

NEUTRAL_ALLIANCE = 8


# --------------------------------------------------------------------------
# Low-level field helpers
# --------------------------------------------------------------------------
def _q(body, key, default=''):
    """Quoted string field: KEY "value"."""
    m = re.search(r'^' + key + r'\s+"(.*)"\s*$', body, re.M)
    return m.group(1) if m else default


def _n(body, key, default=None):
    """Numeric field: KEY 123.45"""
    m = re.search(r'^' + key + r'\s+(-?[\d.]+)\s*$', body, re.M)
    if not m:
        return default
    v = float(m.group(1))
    return int(v) if v == int(v) else v


def _word(body, key, default=''):
    m = re.search(r'^' + key + r'\s+(\S+)\s*$', body, re.M)
    return m.group(1) if m else default


def _text_after(body, marker):
    """SUCCESSMESSAGE / FAILUREMESSAGE followed by BEGINTEXT..ENDTEXT."""
    m = re.search(r'^' + marker + r'\s*\nBEGINTEXT\n(.*?)\nENDTEXT', body, re.S | re.M)
    if not m:
        return ''
    return _clean_text(m.group(1))


def _clean_text(s):
    s = s.replace('<R>', '\n')
    # The original exporter hard-wrapped long lines mid-word; rejoin those.
    s = re.sub(r'(?<=[a-z,])\n(?=[a-z])', '', s)
    s = re.sub(r'[ \t]+', ' ', s)
    s = re.sub(r'\n{3,}', '\n\n', s)
    return s.strip()


def hull_code(cls_name):
    cls_name = (cls_name or '').strip().upper()
    if not cls_name:
        return ''
    return cls_name.split()[-1]


def ship_class_for(cls_name, ent_type):
    if ent_type == 'BUILDINGENTITY':
        return 'installation'
    code = hull_code(cls_name)
    mapped = HULL_TO_CLASS.get(code)
    if mapped:
        return mapped
    if ent_type == 'SUBENTITY':
        return 'submarine'
    if ent_type == 'SURFENTITY':
        return 'frigate'
    return None


# --------------------------------------------------------------------------
# Block parsing
# --------------------------------------------------------------------------
def parse_entities(txt):
    out = []
    for m in re.finditer(r'^ENTITY "([^"]*)" (\w+)\n(.*?)\n^END$', txt, re.S | re.M):
        name, etype, body = m.group(1), m.group(2), m.group(3)
        pos = re.search(r'^POS\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*$', body, re.M)
        if not pos:
            continue
        waypoints = []
        for w in re.finditer(
            r'^WAYPOINT\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*$', body, re.M
        ):
            waypoints.append({
                'x': float(w.group(1)), 'y': float(w.group(2)),
                'z': float(w.group(3)), 'speed': float(w.group(4)),
            })
        aircraft = []
        for a in re.finditer(
            r'^AIRCRAFT\s+"([^"]*)"\s+"([^"]*)"\s+"([^"]*)"\s+"([^"]*)"\s+(\d+)', body, re.M
        ):
            cnt = int(a.group(5))
            if cnt <= 0:
                continue
            aircraft.append({
                'type': a.group(1), 'display': a.group(2),
                'role': a.group(3), 'country': a.group(4), 'count': cnt,
            })
        src = re.search(r'^SOURCEOBJECT\s+"([^"]*)"\s*(\w*)', body, re.M)
        box = re.search(
            r'^BOX\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)', body, re.M
        )
        out.append({
            'name': name,
            'etype': etype,
            'alliance': int(_n(body, 'ALLIANCE', 0) or 0),
            'x': float(pos.group(1)), 'y': float(pos.group(2)), 'z': float(pos.group(3)),
            'course': _n(body, 'COURSE', 0) or 0,
            'speed': _n(body, 'SPEED', 0) or 0,
            'prob': _n(body, 'PROB', 100),
            'points': _n(body, 'POINTS', 0) or 0,
            'country': _q(body, 'COUNTRY'),
            'cls': _q(body, 'CLASS'),
            'shipname': _q(body, 'SHIPNAME'),
            'uniquename': _q(body, 'UNIQUENAME'),
            'group': _n(body, 'GROUP'),
            'tactic': _word(body, 'TACTIC'),
            'leader': _q(body, 'FORMATIONLEADER'),
            'source': src.group(1) if src else '',
            'inflight': bool(src and src.group(2) == 'INFLIGHT'),
            'box': [float(box.group(i)) for i in range(1, 5)] if box else None,
            'waypoints': waypoints,
            'aircraft': aircraft,
        })
    return out


def parse_goals(txt):
    out = []
    for m in re.finditer(
        r'^GOAL\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\nBEGIN\n(.*?)\n^END$', txt, re.S | re.M
    ):
        gx, gy, gr, body = float(m.group(1)), float(m.group(2)), float(m.group(3)), m.group(4)
        gtype = int(_n(body, 'GOALTYPE', 3) or 3)
        out.append({
            'id': int(_n(body, 'GOALID', -1) or -1),
            'parent': int(_n(body, 'PARENTGOALID', -1) or -1),
            'name': _q(body, 'GOALNAME'),
            'type': GOAL_TYPES.get(gtype, 'aggregate'),
            'rawType': gtype,
            'side': _n(body, 'SIDE'),
            'start': _n(body, 'STARTTIME', 0) or 0,
            'end': _n(body, 'ENDTIME', 0) or 0,
            'points': _n(body, 'POINTS', 0) or 0,
            'damage': _n(body, 'DAMAGE'),
            'returnToBase': bool(_n(body, 'RETURNTOBASE', 0)),
            'gx': gx, 'gy': gy, 'radiusNm': gr,
            'target': {
                'unique': _q(body, 'UNIQUENAME'),
                'tag': _q(body, 'TAGNAME'),
                'cls': _q(body, 'CLASS'),
                'shipname': _q(body, 'SHIPNAME'),
                'country': _q(body, 'COUNTRY'),
                'group': _n(body, 'GROUP'),
            },
            'success': _text_after(body, 'SUCCESSMESSAGE'),
            'failure': _text_after(body, 'FAILUREMESSAGE'),
        })
    return out


def parse_header(txt):
    head = {}
    for key in ('VERSION', 'OWNALLIANCE', 'DIFFICULTY', 'TOTALNUMSIDES', 'SEASTATE',
                'MONTH', 'BOTTOMTYPE', 'TIMEOFDAY', 'WEATHER', 'CLOUDHEIGHT', 'SSP'):
        v = _n(txt, key)
        if v is not None:
            head[key] = v
    ll = re.search(r'^LATLONG\s+(-?[\d.]+)\s+(-?[\d.]+)', txt, re.M)
    if ll:
        head['LAT'] = float(ll.group(1))
        head['LON'] = float(ll.group(2))
    return head


def parse_briefing(txt):
    def block(marker):
        m = re.search(r'^' + marker + r'\s*\nBEGINTEXT\n(.*?)\nENDTEXT', txt, re.S | re.M)
        return _clean_text(m.group(1)) if m else ''
    return {
        'title': block('MISSIONTITLE') or _q(txt, 'MISSIONTITLE'),
        'description': block('DESCRIPTION'),
        'intel': block('INTELMESSAGE'),
        'task': block('TASKINGMESSAGE'),
    }


def parse_groups(txt):
    """Top-of-file group table: GROUP "<name>" <id> <prob> <a> <b> <c>."""
    groups = {}
    for m in re.finditer(r'^GROUP\s+"([^"]*)"\s+(\d+)((?:\s+-?\d+)*)\s*$', txt, re.M):
        gid = int(m.group(2))
        nums = [int(v) for v in m.group(3).split()] if m.group(3).strip() else []
        groups[gid] = {'name': m.group(1), 'id': gid,
                       'prob': nums[0] if nums else 100, 'args': nums}
    return groups


# --------------------------------------------------------------------------
# Mission assembly
# --------------------------------------------------------------------------
def side_of(alliance, own):
    if alliance == NEUTRAL_ALLIANCE:
        return 'neutral'
    return 'player' if alliance == own else 'enemy'


def build_mission(path, index):
    fname = os.path.basename(path)
    txt = open(path, 'rb').read().decode('latin-1').replace('\r\n', '\n').replace('\r', '\n')

    header = parse_header(txt)
    brief = parse_briefing(txt)
    own = int(header.get('OWNALLIANCE', 0))
    ents = parse_entities(txt)
    goals = parse_goals(txt)
    groups = parse_groups(txt)

    # ---- pick the units we can actually simulate ------------------------
    ships, air, skipped = [], [], {'mine': 0, 'neutral_dropped': 0, 'unmapped': 0}
    neutral_count = 0
    for e in ents:
        if e['etype'] == 'MINEENTITY':
            skipped['mine'] += 1
            continue
        side = side_of(e['alliance'], own)
        if e['etype'] == 'AIRENTITY':
            air.append(e)
            continue
        cls = ship_class_for(e['cls'], e['etype'])
        if cls is None:
            skipped['unmapped'] += 1
            continue
        if side == 'neutral':
            neutral_count += 1
            if neutral_count > MAX_NEUTRALS:
                skipped['neutral_dropped'] += 1
                continue
        e['_side'] = side
        e['_cls'] = cls
        ships.append(e)

    # Airborne units: keep only the ones already in flight at mission start.
    air_keep = []
    neutral_air = 0
    for e in air:
        side = side_of(e['alliance'], own)
        if side == 'neutral':
            neutral_air += 1
            if neutral_air > 4:
                continue
        e['_side'] = side
        e['_archetype'] = ROLE_TO_ARCHETYPE.get(e['cls'], 'F/A-18 Hornet')
        air_keep.append(e)

    # ---- coordinate transform -------------------------------------------
    pts = [(e['x'], e['y']) for e in ships if e['_side'] != 'neutral']
    pts += [(e['x'], e['y']) for e in air_keep if e['_side'] != 'neutral']
    if not pts:
        pts = [(e['x'], e['y']) for e in ships] or [(0.0, 0.0)]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    span_m = max(maxx - minx, maxy - miny, 1.0)

    mpu = METERS_PER_UNIT
    if span_m / mpu > MAX_MISSION_SPAN_U:
        mpu = span_m / MAX_MISSION_SPAN_U      # compress oversized theatres
    span_u = span_m / mpu
    # Centre the order of battle in the world box. The combatant bbox is
    # guaranteed to fit; stragglers (neutral traffic well outside the fight,
    # a distant shore base, a long-range goal marker) are clamped to the edge
    # rather than allowed to escape the playable area.
    cx_m, cy_m = (minx + maxx) / 2.0, (miny + maxy) / 2.0
    cx_u = WORLD_SIZE / 2.0
    cy_u = WORLD_SIZE / 2.0
    lo, hi = float(WORLD_MARGIN_U) * 0.3, float(WORLD_SIZE) - float(WORLD_MARGIN_U) * 0.3

    def to_u(x_m, y_m):
        # Flip Y so that north is up on the tactical display.
        ux = (x_m - cx_m) / mpu + cx_u
        uy = (cy_m - y_m) / mpu + cy_u
        return (round(min(max(ux, lo), hi), 2),
                round(min(max(uy, lo), hi), 2))

    units = []
    for e in ships:
        ux, uy = to_u(e['x'], e['y'])
        wps = []
        for w in e['waypoints'][:8]:
            wx, wy = to_u(w['x'], w['y'])
            wps.append({'x': wx, 'y': wy, 'speed': w['speed']})
        u = {
            'uid': e['uniquename'] or e['shipname'] or e['name'],
            'side': e['_side'],
            'shipClass': e['_cls'],
            'hull': hull_code(e['cls']),
            'cls': e['cls'],
            'name': e['shipname'] or e['name'],
            'country': e['country'],
            'x': ux, 'y': uy,
            'depth': round(e['z'], 1),
            'course': e['course'],
            'speed': e['speed'],
            'prob': e['prob'],
            'points': e['points'],
            'group': e['group'],
            'tactic': e['tactic'],
        }
        if wps:
            u['waypoints'] = wps
        if e['aircraft']:
            u['aircraft'] = [{'type': a['type'], 'role': a['role'], 'count': a['count']}
                             for a in e['aircraft']]
        units.append(u)

    airunits = []
    for e in air_keep:
        ux, uy = to_u(e['x'], e['y'])
        wps = []
        for w in e['waypoints'][:8]:
            wx, wy = to_u(w['x'], w['y'])
            wps.append({'x': wx, 'y': wy, 'speed': w['speed']})
        a = {
            'uid': e['uniquename'] or e['shipname'] or e['name'],
            'side': e['_side'],
            'type': e['_archetype'],
            'display': e['shipname'] or e['name'],
            'role': e['cls'],
            'country': e['country'],
            'x': ux, 'y': uy,
            'alt': round(e['z'], 0),
            'course': e['course'],
            'speed': e['speed'],
            'prob': e['prob'],
            'group': e['group'],
        }
        if wps:
            a['waypoints'] = wps
        airunits.append(a)

    # ---- goals -----------------------------------------------------------
    ggoals = []
    for g in goals:
        gx, gy = to_u(g['gx'], g['gy'])
        radius_u = max(40.0, g['radiusNm'] * NM_TO_M / mpu)
        tgt = {k: v for k, v in g['target'].items() if v not in ('', None)}
        ggoals.append({
            'id': g['id'], 'parent': g['parent'], 'name': g['name'],
            'type': g['type'], 'side': g['side'],
            'start': g['start'], 'end': g['end'], 'points': g['points'],
            'damage': g['damage'], 'returnToBase': g['returnToBase'],
            'x': gx, 'y': gy, 'radius': round(radius_u, 1), 'radiusNm': g['radiusNm'],
            'target': tgt,
            'success': g['success'], 'failure': g['failure'],
        })

    key = fname.rsplit('.', 1)[0]
    kind = 'region' if fname.lower().endswith('.scc') else 'single'
    counts = {
        'player': sum(1 for u in units if u['side'] == 'player'),
        'enemy': sum(1 for u in units if u['side'] == 'enemy'),
        'neutral': sum(1 for u in units if u['side'] == 'neutral'),
        'airPlayer': sum(1 for a in airunits if a['side'] == 'player'),
        'airEnemy': sum(1 for a in airunits if a['side'] == 'enemy'),
    }

    return {
        'id': key,
        'file': fname,
        'kind': kind,
        'index': index,
        'title': brief['title'] or key,
        'description': brief['description'],
        'intel': brief['intel'],
        'task': brief['task'],
        'difficulty': int(header.get('DIFFICULTY', 1)),
        'ownAlliance': own,
        'seaState': int(header.get('SEASTATE', 1)),
        'weather': int(header.get('WEATHER', 0)),
        'timeOfDay': int(header.get('TIMEOFDAY', 12)),
        'month': int(header.get('MONTH', 1)),
        'cloudHeight': int(header.get('CLOUDHEIGHT', 4500)),
        'lat': header.get('LAT', 0.0),
        'lon': header.get('LON', 0.0),
        'metersPerUnit': round(mpu, 3),
        'spanUnits': round(span_u, 1),
        'spanNm': round(span_m / NM_TO_M, 1),
        'counts': counts,
        'skipped': skipped,
        'groups': [groups[g] for g in sorted(groups)],
        'units': units,
        'air': airunits,
        'goals': ggoals,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True, help='original scenario/ directory')
    ap.add_argument('--out', required=True, help='output missions.json')
    args = ap.parse_args()

    files = []
    for pat in ('Region1.scc', 'Region2.scc', 'Region3.scc', 'Region4.scc'):
        p = os.path.join(args.src, pat)
        if os.path.exists(p):
            files.append(p)
    for i in range(1, 36):
        p = os.path.join(args.src, 'Single%02d.scs' % i)
        if os.path.exists(p):
            files.append(p)

    if not files:
        print('No scenario files found in %s' % args.src, file=sys.stderr)
        return 1

    missions = []
    for i, p in enumerate(files):
        try:
            missions.append(build_mission(p, i))
        except Exception as exc:  # keep going, report at the end
            print('  !! %s: %s' % (os.path.basename(p), exc), file=sys.stderr)

    doc = OrderedDict()
    doc['version'] = 1
    doc['source'] = 'Fleet Command (1999) original scenario/*.scc,*.scs'
    doc['worldSize'] = WORLD_SIZE
    doc['baseMetersPerUnit'] = METERS_PER_UNIT
    doc['missions'] = missions

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w') as fh:
        json.dump(doc, fh, separators=(',', ':'))

    size = os.path.getsize(args.out)
    print('wrote %s  (%d missions, %.1f KB)' % (args.out, len(missions), size / 1024.0))
    print()
    hdr = '%-13s %-30s %3s %4s %4s %4s %4s %4s %6s %7s'
    print(hdr % ('id', 'title', 'dif', 'PLR', 'ENY', 'NEU', 'AIR', 'GOAL', 'spanNM', 'm/unit'))
    for m in missions:
        c = m['counts']
        print(hdr % (m['id'], m['title'][:30], m['difficulty'], c['player'], c['enemy'],
                     c['neutral'], c['airPlayer'] + c['airEnemy'], len(m['goals']),
                     '%.0f' % m['spanNm'], '%.1f' % m['metersPerUnit']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
