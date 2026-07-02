# -*- coding: utf-8 -*-
"""Генерализованные магистральные ЖД-ходы Москвы -> data/railways.geojson.
   usage=main из OSM, сегменты склеиваются в длинные линии, параллельные
   направления/пути схлопываются в один ход, кривые сглаживаются."""
import json, math, os, sys, time
import urllib.request, urllib.parse

from shapely.geometry import LineString, MultiLineString
from shapely.ops import linemerge

sys.stdout.reconfigure(encoding="utf-8")
BASE = os.path.join(os.path.dirname(__file__), "..")
OUT = os.path.join(BASE, "data", "railways.geojson")

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# Москва + ~10 км буфера
BBOX = "55.05,36.70,56.10,38.10"
Q = f"""
[out:json][timeout:300];
way["railway"="rail"]["usage"="main"]({BBOX});
out geom;
"""

def overpass(query):
    data = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for ep in ENDPOINTS:
        try:
            print("  ", ep)
            req = urllib.request.Request(ep, data=data, headers={"User-Agent": "kugis-schemes/1.0"})
            with urllib.request.urlopen(req, timeout=600) as r:
                raw = r.read()
            print(f"   получено {len(raw)//1048576} МБ")
            return json.loads(raw)
        except Exception as e:
            last = e
            print("   ошибка:", e)
            time.sleep(10)
    raise last

# работаем в локальных метрах (равнопромежуточная проекция)
LAT0 = 55.6
KX = 111320.0 * math.cos(math.radians(LAT0))
KY = 111320.0
to_m = lambda lon, lat: (lon * KX, lat * KY)
to_deg = lambda x, y: (x / KX, y / KY)

print("1) Overpass: магистральные пути…")
data = overpass(Q)
lines = []
for el in data.get("elements", []):
    g = el.get("geometry")
    if not g or len(g) < 2:
        continue
    lines.append(LineString([to_m(p["lon"], p["lat"]) for p in g]))
print("   сегментов:", len(lines))

print("2) склейка в ходы…")
merged = linemerge(MultiLineString(lines))
strands = list(merged.geoms) if merged.geom_type == "MultiLineString" else [merged]
strands.sort(key=lambda s: -s.length)
print("   ходов после склейки:", len(strands))

print("3) кластеризация параллельных…")
kept = []
for s in strands:
    if s.length < 3000:      # короткие связки и хвосты не нужны
        continue
    n = max(9, min(25, int(s.length // 400)))
    pts = [s.interpolate(i / (n - 1), normalized=True) for i in range(n)]
    dup = False
    for k in kept:
        ds = sorted(p.distance(k) for p in pts)
        if ds[len(ds) // 2] < 60:   # медиана < 60 м — тот же ход
            dup = True
            break
    if not dup:
        kept.append(s)
print("   осталось ходов:", len(kept))

feats = []
for s in kept:
    s = s.simplify(40)   # сглаживание для схематичного вида
    coords = [to_deg(x, y) for x, y in s.coords]
    feats.append({
        "type": "Feature", "properties": {},
        "geometry": {"type": "LineString",
                     "coordinates": [[round(x, 5), round(y, 5)] for x, y in coords]},
    })

with open(OUT, "w", encoding="utf-8") as f:
    json.dump({"type": "FeatureCollection", "features": feats}, f, separators=(",", ":"))
print(f"OK: railways.geojson: {os.path.getsize(OUT)//1024} KB, ходов: {len(feats)}")
