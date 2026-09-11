#!/usr/bin/env python
"""
geos-golden.py — regenerate the GEOS golden data behind the differential tests.

    geosGolden.json           <- validity + overlay + buffer expectations,
                                 written next to this script
    validity.geos.test.ts     (CASES table only; the file is hand-written)
    overlay.geos.test.ts      (reads the JSON directly)

WHY THIS EXISTS
---------------
`validity.geos.test.ts` and `overlay.geos.test.ts` compare this repo's planar
overlay kernel and buffer engine against GEOS itself, not against hand-computed
numbers. That is only honest if the expectations really came from GEOS, so they
are generated, not typed. This script is the generator.

It needs a Python that has shapely (which bundles GEOS). The QGIS desktop install
ships one, and its GEOS is the same one QGIS's own tools use:

    /Applications/QGIS.app/Contents/MacOS/python geoprocessing_tool_tests/geos-golden.py

Any other shapely works; the GEOS version is recorded in the output and printed
here, because "matches GEOS" is meaningless without saying which GEOS. Nothing in
the app depends on Python at build or test time: the script writes a JSON file
that is committed, and the tests read that.

Every case is chosen to probe a rule the two engines could plausibly disagree
about — a hole touching its shell, a ring revisiting a node, near-coincident
boundaries, cap and join styles — because agreement on easy input proves nothing.
Two buffer rows and one make-valid row are KNOWN deviations; they are flagged in
the data with the reason, and the tests assert the flag rather than hiding it.
"""
import json
import os
import re
import sys

import shapely
from shapely import LineString, MultiPoint, MultiPolygon, Point, Polygon
from shapely.validation import explain_validity, make_valid

HERE = os.path.dirname(os.path.abspath(__file__))
# The golden file lives beside this script, in geoprocessing_tool_tests/ — it is
# test data, not app source, so it deliberately stays out of gis_workbench/src.
OUT = os.path.join(HERE, 'geosGolden.json')

def P(shell, holes=()):
    return Polygon(shell, list(holes))

# ---------------------------------------------------------------------------
# 1. Validity + Make Valid
# ---------------------------------------------------------------------------

VALIDITY_CASES = [
    ("hole apex touches the shell edge from inside", 'Polygon',
     [[(0, 0), (10, 0), (10, 10), (0, 10)], [(5, 0), (7, 3), (3, 3)]]),
    ("hole vertex touches a shell vertex from inside", 'Polygon',
     [[(0, 0), (10, 0), (10, 10), (0, 10)], [(0, 0), (4, 1), (1, 4)]]),
    ("two holes touch each other at one point", 'Polygon',
     [[(0, 0), (20, 0), (20, 20), (0, 20)], [(2, 2), (8, 2), (8, 8), (2, 8)], [(8, 8), (14, 8), (14, 14), (8, 14)]]),
    ("hole touches the shell at TWO points", 'Polygon',
     [[(0, 0), (10, 0), (10, 10), (0, 10)], [(3, 0), (5, 3), (7, 0), (5, 1)]]),
    ("one ring visits the same node twice", 'Polygon',
     [[(0, 0), (10, 0), (10, 10), (5, 5), (10, 20), (0, 20), (0, 10), (5, 5)]]),
    ("bowtie", 'Polygon',
     [[(0, 0), (10, 10), (10, 0), (0, 10)]]),
    ("hole crosses the shell boundary", 'Polygon',
     [[(0, 0), (10, 0), (10, 10), (0, 10)], [(4, -2), (6, -2), (6, 4), (4, 4)]]),
    ("two multipolygon parts touch at a point", 'MultiPolygon',
     [[(0, 0), (10, 0), (10, 10), (0, 10)], [(10, 10), (20, 10), (20, 20), (10, 20)]]),
    ("hole lies partly outside the shell", 'Polygon',
     [[(0, 0), (10, 0), (10, 10), (0, 10)], [(5, 0), (7, -3), (3, -3)]]),
    ("duplicate ring", 'Polygon',
     [[(0, 0), (10, 0), (10, 10), (0, 10)], [(2, 2), (4, 2), (4, 4), (2, 4)], [(2, 2), (4, 2), (4, 4), (2, 4)]]),
    ("nested holes", 'Polygon',
     [[(0, 0), (20, 0), (20, 20), (0, 20)], [(2, 2), (18, 2), (18, 18), (2, 18)], [(5, 5), (8, 5), (8, 8), (5, 8)]]),
    ("zero-width spike on the shell", 'Polygon',
     [[(0, 0), (10, 0), (10, 10), (6, 10), (6, 14), (6, 10), (0, 10)]]),
    ("hole is a spike", 'Polygon',
     [[(0, 0), (10, 0), (10, 10), (0, 10)], [(5, 2), (5, 8), (5, 2)]]),
    ("three lobes meeting at one node", 'Polygon',
     [[(0, 0), (10, 0), (5, 5), (10, 10), (0, 10), (5, 5)]]),
    ("hole shares a whole edge with the shell", 'Polygon',
     [[(0, 0), (10, 0), (10, 10), (0, 10)], [(2, 0), (8, 0), (5, 4)]]),
    ("shell folded back on itself along an edge", 'Polygon',
     [[(0, 0), (10, 0), (10, 10), (0, 10), (0, 5), (10, 5)]]),
    ("a clean donut", 'Polygon',
     [[(0, 0), (10, 0), (10, 10), (0, 10)], [(3, 3), (7, 3), (7, 7), (3, 7)]]),
]

REASON_TO_CODE = [
    (r'^Interior is disconnected', 'disconnected-interior'),
    (r'^Ring Self-intersection', 'self-intersection'),
    (r'^Self-intersection', 'self-intersection'),
    (r'^Hole lies outside shell', 'hole-outside-shell'),
    (r'^Holes are nested', 'nested-holes'),
    (r'^Too few points', 'too-few-points'),
]

# GEOS reports a duplicated ring as a plain self-intersection; this kernel names
# the more specific class (which is what the plan asked Check Validity to add).
CODE_OVERRIDE = {'duplicate ring': 'duplicate-ring'}

# Cases where GEOS's single reported point is not expected to be one of ours:
# degenerate input where "which of the several coincident points" is arbitrary.
LOCATION_NOT_COMPARABLE = {
    'duplicate ring',
    'zero-width spike on the shell',
    'hole shares a whole edge with the shell',
}

# Cases where the AREA of our Make Valid deliberately differs, and why. Both are
# the documented nonzero-winding choice: coincident ground is treated as covered.
AREA_DEVIATION = {
    'duplicate ring':
        'a duplicated hole winds -2, which nonzero winding reads as covered; GEOS '
        'counts rings structurally and subtracts it',
    'hole shares a whole edge with the shell':
        'a hole whose base lies ON the shell boundary is void for GEOS and a real '
        'hole for us',
}


def validity_rows():
    rows = []
    for name, kind, rings in VALIDITY_CASES:
        if kind == 'Polygon':
            g = Polygon(rings[0], rings[1:])
        else:
            g = MultiPolygon([Polygon(r) for r in rings])
        mv = make_valid(g)
        geoms = list(getattr(mv, 'geoms', None) or [])
        parts = len([x for x in geoms if x.geom_type in ('Polygon', 'MultiPolygon')])
        if not parts:
            parts = 1 if mv.geom_type in ('Polygon', 'MultiPolygon') else 0
        reason = '' if g.is_valid else explain_validity(g)
        code = ''
        if reason:
            for pattern, mapped in REASON_TO_CODE:
                if re.match(pattern, reason):
                    code = mapped
                    break
            if not code:
                raise SystemExit(f'no mapping for GEOS reason {reason!r} ({name})')
        if name in CODE_OVERRIDE:
            code = CODE_OVERRIDE[name]
        at = re.search(r'\[(-?[\d.]+) (-?[\d.]+)\]$', reason)
        rows.append({
            'name': name,
            'kind': kind,
            'rings': [[[float(x), float(y)] for x, y in r] for r in rings],
            'geosValid': bool(g.is_valid),
            'geosReason': reason,
            'geosCode': code,
            'geosAt': [float(at.group(1)), float(at.group(2))] if at else None,
            'atMatchesOurs': name not in LOCATION_NOT_COMPARABLE,
            'geosMakeValidParts': parts,
            'geosMakeValidArea': mv.area,
            'deviation': AREA_DEVIATION.get(name),
        })
    return rows


# ---------------------------------------------------------------------------
# 2. Overlay areas
# ---------------------------------------------------------------------------

SQ_A = P([(0, 0), (10, 0), (10, 10), (0, 10)])
SQ_B = P([(5, 5), (15, 5), (15, 15), (5, 15)])
SQ_TOUCH = P([(10, 0), (20, 0), (20, 10), (10, 10)])
DONUT = P([(0, 0), (20, 0), (20, 20), (0, 20)], [[(5, 5), (15, 5), (15, 15), (5, 15)]])
INNER = P([(8, 8), (12, 8), (12, 12), (8, 12)])
L_SHAPE = P([(0, 0), (10, 0), (10, 4), (4, 4), (4, 10), (0, 10)])
STAR = Polygon([(0, 10), (2.9, 4.0), (9.5, 3.5), (4.7, -0.9), (5.9, -7.5), (0, -4.0),
                (-5.9, -7.5), (-4.7, -0.9), (-9.5, 3.5), (-2.9, 4.0)])
CONCAVE = P([(0, 0), (12, 0), (12, 12), (6, 6), (0, 12)])
THIN = P([(0, 0), (20, 0), (20, 0.5), (0, 0.5)])
MULTI = MultiPolygon([P([(0, 0), (4, 0), (4, 4), (0, 4)]), P([(6, 6), (10, 6), (10, 10), (6, 10)])])
NEAR = P([(0.0000001, 0), (10, 0), (10, 10), (0, 10)])
FAR = P([(50, 50), (60, 50), (60, 60), (50, 60)])
LINE = LineString([(0, 0), (10, 0), (12, 8)])
ZIG = LineString([(0, 0), (0.5, 0.6), (1, 0), (1.5, 0.6), (2, 0), (2.5, 0.6), (3, 0)])
POINT = Point(0, 0)
POINTS = MultiPoint([(0, 0), (1, 0), (6, 6)])
LOOP = LineString([(0, 0), (10, 0), (10, 10), (0, 10), (0, 0)])
STRAIGHT = LineString([(0, 0), (40, 0)])

# Single-sided buffers (GEOS `buffer(d, single_sided=True)`, JTS
# `BufferParameters.setSingleSided`). Positive = left of the direction of travel,
# negative = right, which is the convention this app's Buffer option uses.
SINGLE_SIDED = [
    ("polyline with a sharp bend", LINE),
    ("tight zigzag", ZIG),
    ("closed square loop", LOOP),
    ("open straight line", STRAIGHT),
]

OVERLAY_PAIRS = [
    ("two overlapping squares", SQ_A, SQ_B, None),
    ("two squares sharing an edge", SQ_A, SQ_TOUCH, None),
    ("a square inside a donut's hole", DONUT, INNER, None),
    ("a square inside a square", SQ_A, INNER, None),
    ("an L and its own bounding square", L_SHAPE, SQ_A, None),
    ("a star over a square", STAR, SQ_A, None),
    ("a concave arrow and a square", CONCAVE, SQ_A, None),
    ("a thin strip across a square", SQ_A, THIN, None),
    ("a multipart and a square", MULTI, SQ_B, None),
    ("disjoint squares", SQ_A, FAR, None),
    ("a donut and an overlapping square", DONUT, SQ_B, None),
    ("near-coincident squares", SQ_A, NEAR,
     "the two shells are 1e-7 apart, which is inside this kernel's snapping "
     "tolerance (1e-6): GEOS keeps a 5e-7 sliver, we merge the boundaries. "
     "Snapping is the documented trade for exact predicates."),
]


def overlay_rows():
    rows = []
    for name, a, b, note in OVERLAY_PAIRS:
        rows.append({
            'name': name,
            'a': a.__geo_interface__,
            'b': b.__geo_interface__,
            'union': a.union(b).area,
            'intersection': a.intersection(b).area,
            'difference': a.difference(b).area,
            'symDifference': a.symmetric_difference(b).area,
            'deviation': note,
        })
    return rows


# ---------------------------------------------------------------------------
# 3. Buffer areas, across every cap and join style
# ---------------------------------------------------------------------------

BUFFER_SINGLES = [
    ("square", SQ_A, None),
    ("donut", DONUT, None),
    ("L-shape", L_SHAPE, None),
    ("star", STAR, None),
    ("concave arrow", CONCAVE, None),
    ("thin strip", THIN, None),
    ("multipart", MULTI, None),
    ("polyline with a sharp bend", LINE, None),
    ("closed square loop", LOOP, None),
    ("open straight line", STRAIGHT, None),
    ("tight zigzag", ZIG, None),
    ("point", POINT, None),
    ("three points", POINTS, None),
]

POINT_CAP_NOTE = (
    "a point has no direction of travel, so a cap style cannot mean anything. "
    "GEOS returns an EMPTY geometry for cap=flat and a 2d x 2d square for "
    "cap=square; this kernel returns the disc for all three, which is what a user "
    "buffering a point layer expects. Round caps — the default, and the only style "
    "GEOS gives a disc for — agree exactly."
)
ZIG_FLAT_NOTE = (
    "the segments are a sixth of the distance, so the offset curve overlaps itself "
    "several times over. GEOS's flat-cap buffer of this input comes back as 2 parts "
    "(30.137 at d=3) where the piece union gives one region (34.762); the round, "
    "mitre and bevel buffers of the SAME line agree with GEOS to 1e-13, so this is "
    "a difference in how a flat end is cut through a self-overlap, not a "
    "disagreement about the geometry. Pinned, not chased."
)


ZIG_SINGLE_SIDED_NOTE = (
    "the segments are a sixth of the distance, so the one-sided band overlaps "
    "itself several times over and GEOS's offset-curve answer diverges from the "
    "piece union by 1-93% depending on the sign and the distance. The SAME line's "
    "two-sided round, mitre and bevel buffers agree with GEOS to 1e-13, and every "
    "open line agrees single-sided on both sides, so this is the self-overlap "
    "regime again rather than a disagreement about which side is which."
)
LOOP_SINGLE_SIDED_NOTE = (
    "GEOS's single-sided buffer of a CLOSED ring is not self-consistent: on a "
    "10x10 counter-clockwise loop it returns the 81-unit inward offset at d=0.5, "
    "the 64-unit one at d=1, the ring's own 100-unit interior at d=-0.5 and -1, "
    "and the 84-unit band at d=3. This kernel returns the band on the requested "
    "side clipped by the ring at every distance (19 / 36 / 84 inward, 20.8 / 43.1 "
    "/ 148.1 outward), which matches GEOS at d=3 inward and matches the "
    "definition everywhere."
)


def row_deviation(name, distance, cap):
    """Why this row is expected NOT to match GEOS, or None when it must match."""
    if name in ('point', 'three points') and cap != 'round':
        return POINT_CAP_NOTE
    if name == 'tight zigzag' and cap == 'flat' and distance >= 1:
        return ZIG_FLAT_NOTE
    return None

CAPS = {1: 'round', 2: 'flat', 3: 'square'}
JOINS = {1: 'round', 2: 'mitre', 3: 'bevel'}
# Ours spells it 'miter'; GEOS and QGIS spell it 'mitre'.
JOIN_IN_OURS = {'round': 'round', 'mitre': 'miter', 'bevel': 'bevel'}


def buffer_rows():
    rows = []
    for name, g, note in BUFFER_SINGLES:
        is_area = g.geom_type in ('Polygon', 'MultiPolygon')
        for d in (0.5, 1.0, 3.0):
            for jk, jname in JOINS.items():
                for ck, cname in CAPS.items():
                    # Polygons have no ends, so the cap style cannot change them;
                    # keep the matrix to the combinations that mean something.
                    if is_area and (cname != 'round' or jname != 'round'):
                        continue
                    if not is_area and jname != 'round' and cname != 'round':
                        continue
                    buffered = g.buffer(d, quad_segs=8, join_style=jk, cap_style=ck, mitre_limit=5.0)
                    rows.append({
                        'name': name,
                        'geom': g.__geo_interface__,
                        'distance': d,
                        'join': JOIN_IN_OURS[jname],
                        'cap': cname,
                        'segments': 8,
                        'singleSided': False,
                        'geosArea': buffered.area,
                        'geosParts': len(buffered.geoms) if buffered.geom_type.startswith('Multi') else 1,
                        'deviation': note or row_deviation(name, d, cname),
                    })

    for name, g in SINGLE_SIDED:
        for d in (0.5, 1.0, 3.0, -0.5, -1.0, -3.0):
            buffered = g.buffer(d, quad_segs=8, join_style=1, cap_style=2,
                                mitre_limit=5.0, single_sided=True)
            rows.append({
                'name': f'{name} (single-sided)',
                'geom': g.__geo_interface__,
                'distance': d,
                'join': 'round',
                'cap': 'flat',       # a single-sided buffer has flat ends by definition
                'segments': 8,
                'singleSided': True,
                'geosArea': buffered.area,
                'geosParts': len(buffered.geoms) if buffered.geom_type.startswith('Multi') else 1,
                'deviation': (
                    ZIG_SINGLE_SIDED_NOTE if g is ZIG
                    else LOOP_SINGLE_SIDED_NOTE if g is LOOP
                    else None
                ),
            })
    return rows


def main():
    data = {
        'provenance': {
            'generator': 'geoprocessing_tool_tests/geos-golden.py',
            'shapely': shapely.__version__,
            'geos': '.'.join(str(x) for x in shapely.geos_version),
            'python': sys.version.split()[0],
            'note': 'Regenerate after any change to the case list. The tests read '
                    'this file; nothing at build or run time needs Python.',
        },
        'validity': validity_rows(),
        'overlays': overlay_rows(),
        'buffers': buffer_rows(),
    }
    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump(data, fh, indent=1)
        fh.write('\n')
    print(f"GEOS {data['provenance']['geos']} (shapely {data['provenance']['shapely']})")
    print(f"  validity cases : {len(data['validity'])}")
    print(f"  overlay pairs  : {len(data['overlays'])}")
    print(f"  buffer cases   : {len(data['buffers'])}")
    print(f"  wrote {OUT} ({os.path.getsize(OUT)} bytes)")


if __name__ == '__main__':
    main()
