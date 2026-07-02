# -*- coding: utf-8 -*-
"""Леса и вода из OSM (natural=wood, landuse=forest, natural=water) -> data/nature.geojson.
   Обрезка по границе Москвы (union округов), упрощение, отбраковка мелочи."""
import json, math, os, sys, time
import urllib.request, urllib.parse

from shapely.geometry import shape, Polygon, MultiPolygon, LineString, mapping
from shapely.ops import unary_union, linemerge, polygonize

sys.stdout.reconfigure(encoding="utf-8")
BASE = os.path.join(os.path.dirname(__file__), "..")
OUT = os.path.join(BASE, "data", "nature.geojson")

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

Q = """
[out:json][timeout:600][maxsize:1073741824];
area["name"="Москва"]["boundary"="administrative"]["admin_level"="4"]->.a;
(
  way["natural"="wood"](area.a);
  relation["natural"="wood"](area.a);
  way["landuse"="forest"](area.a);
  relation["landuse"="forest"](area.a);
  way["natural"="water"](area.a);
  relation["natural"="water"](area.a);
);
out geom;
"""

def overpass(query):
    data = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for ep in ENDPOINTS:
        try:
            print("  ", ep)
            req = urllib.request.Request(ep, data=data, headers={"User-Agent": "kugis-schemes/1.0"})
            t0 = time.time()
            with urllib.request.urlopen(req, timeout=900) as r:
                raw = r.read()
            print(f"   получено {len(raw)//1048576} МБ за {time.time()-t0:.0f} с")
            return json.loads(raw)
        except Exception as e:
            last = e
            print("   ошибка:", e)
            time.sleep(10)
    raise last

def is_water(tags):
    return tags.get("natural") == "water"

def way_polygon(el):
    g = el.get("geometry")
    if not g or len(g) < 4:
        return None
    pts = [(p["lon"], p["lat"]) for p in g]
    if pts[0] != pts[-1]:
        pts.append(pts[0])
    try:
        pg = Polygon(pts)
        return pg if pg.is_valid else pg.buffer(0)
    except Exception:
        return None

def relation_polygon(el):
    outers = []
    for m in el.get("members", []):
        if m.get("type") != "way" or m.get("role") not in ("outer", ""):
            continue
        g = m.get("geometry")
        if not g or len(g) < 2:
            continue
        outers.append(LineString([(p["lon"], p["lat"]) for p in g]))
    if not outers:
        return None
    try:
        merged = linemerge(outers)
        polys = list(polygonize(merged))
        if not polys:
            return None
        return unary_union([p if p.is_valid else p.buffer(0) for p in polys])
    except Exception:
        return None

print("1) граница Москвы из okruga.geojson…")
ok = json.load(open(os.path.join(BASE, "data", "okruga.geojson"), encoding="utf-8"))
moscow = unary_union([shape(f["geometry"]).buffer(0) for f in ok["features"]]).buffer(0.0005)
print("   ok, площадь (град²):", round(moscow.area, 4))

print("2) Overpass: леса и вода по всей Москве…")
data = overpass(Q)
els = data.get("elements", [])
print("   элементов:", len(els))

TOL = 0.00025          # ~22 м
MIN_WOOD = 20000       # м²  (2 га)
MIN_WATER = 8000       # м²

def approx_m2(pg, lat=55.6):
    k = 111320.0
    return pg.area * k * k * math.cos(math.radians(lat))

feats = {"w": [], "r": []}
skip, cnt = 0, 0
for el in els:
    tags = el.get("tags", {})
    kind = "r" if is_water(tags) else "w"
    pg = way_polygon(el) if el["type"] == "way" else relation_polygon(el)
    if pg is None or pg.is_empty:
        skip += 1
        continue
    cnt += 1
    if cnt % 2000 == 0:
        print(f"   …{cnt}")
    try:
        pg = pg.simplify(TOL, preserve_topology=False)
        if pg.is_empty:
            continue
        if approx_m2(pg) < (MIN_WATER if kind == "r" else MIN_WOOD):
            continue
        pg = pg.intersection(moscow)
        if pg.is_empty:
            continue
        feats[kind].append(pg)
    except Exception:
        skip += 1

print(f"   лесов: {len(feats['w'])}, воды: {len(feats['r'])}, пропущено: {skip}")

def rnd(coords):
    return [[round(x, 5), round(y, 5)] for x, y in coords]

out_feats = []
for kind, geoms in feats.items():
    for g in geoms:
        polys = [g] if isinstance(g, Polygon) else [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon)]
        for p in polys:
            if p.is_empty or len(p.exterior.coords) < 4:
                continue
            rings = [rnd(p.exterior.coords)] + [rnd(i.coords) for i in p.interiors if len(i.coords) >= 4]
            out_feats.append({"type": "Feature", "properties": {"t": kind},
                              "geometry": {"type": "Polygon", "coordinates": rings}})

with open(OUT, "w", encoding="utf-8") as f:
    json.dump({"type": "FeatureCollection", "features": out_feats}, f, ensure_ascii=False, separators=(",", ":"))
print(f"OK: nature.geojson: {os.path.getsize(OUT)//1048576}.{os.path.getsize(OUT)%1048576//104858} МБ, полигонов: {len(out_feats)}")
