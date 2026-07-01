# -*- coding: utf-8 -*-
"""Convert КУГИС project shapefiles to WGS84 GeoJSON for the web app."""
import shapefile, os, json, math, sys
from pyproj import CRS, Transformer

sys.stdout.reconfigure(encoding='utf-8')

ROOT = r"C:\Users\161\Desktop\_ШАБЛОНЫ\КУГИС\Проект"
OUT = r"C:\Users\161\Desktop\_ШАБЛОНЫ\КУГИС\kugis-schemes\data"
os.makedirs(OUT, exist_ok=True)

# МСК Москвы (МГГТ): tmerc on Bessel 1841 with towgs84 from the .prj datum name
MSK = CRS.from_proj4(
    "+proj=tmerc +lat_0=55.66666666667 +lon_0=37.5 +k=1 "
    "+x_0=16.098 +y_0=14.512 +ellps=bessel "
    "+towgs84=316.151,78.924,589.650,-1.57273,2.69209,2.34693,8.4507 "
    "+units=m +no_defs"
)
WGS = CRS.from_epsg(4326)
TR = Transformer.from_crs(MSK, WGS, always_xy=True)


def dp_simplify(pts, tol):
    """Douglas-Peucker on a list of (x, y) in meters."""
    if len(pts) < 3:
        return pts
    def perp(p, a, b):
        ax, ay = a; bx, by = b; px, py = p
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        if L2 == 0:
            return math.hypot(px - ax, py - ay)
        t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L2))
        return math.hypot(px - (ax + t * dx), py - (ay + t * dy))
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i0, i1 = stack.pop()
        if i1 <= i0 + 1:
            continue
        dmax, imax = -1, -1
        for i in range(i0 + 1, i1):
            d = perp(pts[i], pts[i0], pts[i1])
            if d > dmax:
                dmax, imax = d, i
        if dmax > tol:
            keep[imax] = True
            stack.append((i0, imax))
            stack.append((imax, i1))
    return [p for p, k in zip(pts, keep) if k]


def shp_polygons(path, tol=0.0, already_wgs=False, need_props=True):
    """Read polygon shapefile -> list of (props, multipolygon-coords-wgs84)."""
    out = []
    recs = []
    if need_props:
        for enc in ("utf-8", "cp1251"):
            try:
                with shapefile.Reader(path, encoding=enc) as r:
                    fields = [f[0] for f in r.fields[1:]]
                    recs = [dict(zip(fields, list(r.record(i)))) for i in range(len(r))]
                break
            except UnicodeDecodeError:
                continue
    with shapefile.Reader(path) as r:
        for i in range(len(r)):
            shp = r.shape(i)
            props = recs[i] if i < len(recs) else {}
            parts = list(shp.parts) + [len(shp.points)]
            rings = []
            for j in range(len(shp.parts)):
                ring = shp.points[parts[j]:parts[j + 1]]
                if tol > 0:
                    closed = ring[0] == ring[-1]
                    body = ring[:-1] if closed else ring
                    body = dp_simplify(body, tol)
                    ring = body + [body[0]]
                if len(ring) < 4:
                    continue
                if already_wgs:
                    rings.append([[round(x, 6), round(y, 6)] for x, y in ring])
                else:
                    xs, ys = zip(*ring)
                    lon, lat = TR.transform(xs, ys)
                    rings.append([[round(a, 6), round(b, 6)] for a, b in zip(lon, lat)])
            out.append((props, rings))
    return out


def ring_area(ring):
    s = 0
    for k in range(len(ring) - 1):
        s += ring[k][0] * ring[k + 1][1] - ring[k + 1][0] * ring[k][1]
    return s / 2


def rings_to_geom(rings):
    """Group rings into a Polygon or MultiPolygon by winding/containment (simple: outer = largest |area| first)."""
    if not rings:
        return None
    # shapefile convention: outer rings clockwise (negative shoelace), holes ccw
    outers, holes = [], []
    for rg in rings:
        (outers if ring_area(rg) < 0 else holes).append(rg)
    if not outers:
        outers, holes = holes, []
    polys = [[o] for o in outers]

    def inside(pt, ring):
        x, y = pt; n = len(ring) - 1; c = False
        for k in range(n):
            x1, y1 = ring[k]; x2, y2 = ring[k + 1]
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                c = not c
        return c

    for h in holes:
        for poly in polys:
            if inside(h[0], poly[0]):
                poly.append(h)
                break
    if len(polys) == 1:
        return {"type": "Polygon", "coordinates": polys[0]}
    return {"type": "MultiPolygon", "coordinates": polys}


def fc(features):
    return {"type": "FeatureCollection", "features": features}


def save(name, obj):
    p = os.path.join(OUT, name)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{name}: {os.path.getsize(p) // 1024} KB, {len(obj['features'])} features")


AO_DIR = os.path.join(ROOT, "Москва_АТД")
aos = sorted(os.listdir(AO_DIR))

# 1) Округа
from shapely.geometry import shape as sh_shape, mapping as sh_mapping
from shapely.ops import unary_union

feats = []
for ao in aos:
    p = os.path.join(AO_DIR, ao, ao + ".shp")
    if os.path.exists(p):
        for props, rings in shp_polygons(p, tol=25, need_props=False):
            g = rings_to_geom(rings)
            feats.append({"type": "Feature", "properties": {"name": ao}, "geometry": g})
    else:
        # dissolve districts into an okrug boundary (e.g. ЮЗАО has no own shp)
        pr = os.path.join(AO_DIR, ao, ao + "_районы.shp")
        geoms = []
        for props, rings in shp_polygons(pr, tol=25, need_props=False):
            geoms.append(sh_shape(rings_to_geom(rings)))
        u = unary_union([g.buffer(0.0001) for g in geoms]).buffer(-0.0001).simplify(0.0002)
        feats.append({"type": "Feature", "properties": {"name": ao}, "geometry": sh_mapping(u)})
        print("dissolved okrug boundary for", ao)
save("okruga.geojson", fc(feats))

# 2) Районы
feats = []
for ao in aos:
    p = os.path.join(AO_DIR, ao, ao + "_районы.shp")
    if not os.path.exists(p):
        print("!! no rayony shp for", ao); continue
    for props, rings in shp_polygons(p, tol=12):
        layer = str(props.get("layer") or "")
        name = layer.split("_", 1)[1] if "_" in layer else layer
        g = rings_to_geom(rings)
        feats.append({"type": "Feature", "properties": {"ao": ao, "name": name}, "geometry": g})
save("rayony.geojson", fc(feats))

# 3) Станции (уже WGS84)
feats = []
for line, rel in [("МЦК", r"Московский транспорт\Метро\МЦК\МЦК_Станции.shp"),
                  ("МЦД-2", r"Московский транспорт\Метро\МЦД-2\МЦД-2_Станции.shp")]:
    with shapefile.Reader(os.path.join(ROOT, rel)) as r:
        fields = [f[0] for f in r.fields[1:]]
        for i in range(len(r)):
            shp = r.shape(i)
            rec = dict(zip(fields, list(r.record(i))))
            name = rec.get("name") or rec.get("name_ru") or ""
            x, y = shp.points[0]
            feats.append({"type": "Feature",
                          "properties": {"name": name, "line": line},
                          "geometry": {"type": "Point", "coordinates": [round(x, 6), round(y, 6)]}})
save("stations.geojson", fc(feats))

# sanity: САО bounds
import itertools
sao = [f for f in json.load(open(os.path.join(OUT, "okruga.geojson"), encoding="utf-8"))["features"] if f["properties"]["name"] == "САО"]
g = sao[0]["geometry"]
rings = g["coordinates"] if g["type"] == "Polygon" else list(itertools.chain(*g["coordinates"]))
xs = [p[0] for r in rings for p in r]; ys = [p[1] for r in rings for p in r]
print("САО bbox lon", min(xs), max(xs), "lat", min(ys), max(ys))
