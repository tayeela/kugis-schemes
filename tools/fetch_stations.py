# -*- coding: utf-8 -*-
"""Станции метро / МЦК / МЦД из OSM (Overpass) -> data/stations.geojson
   {name, lines: ["9","D2","МЦК",...]} с актуальными названиями."""
import json, math, os, re, sys, time
import urllib.request, urllib.parse

sys.stdout.reconfigure(encoding="utf-8")
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "stations.geojson")
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

Q_ROUTES = """
[out:json][timeout:300];
area["name"="Москва"]["boundary"="administrative"]["admin_level"="4"]->.a;
(
  rel(area.a)["route"="subway"]["ref"];
  rel(area.a)["route"="light_rail"]["ref"];
  rel(area.a)["route"="train"]["ref"~"^(D[1-5]|МЦК|14)$"];
);
out body;
"""

def overpass(query):
    data = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for ep in ENDPOINTS:
        try:
            req = urllib.request.Request(ep, data=data, headers={"User-Agent": "kugis-schemes/1.0"})
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.load(r)
        except Exception as e:
            last = e
            print("  ", ep, "->", e)
            time.sleep(5)
    raise last

def norm_ref(tags):
    """ref маршрута -> токен бейджа (или None, если не берём)."""
    ref = (tags.get("ref") or "").strip().upper().replace("A", "А")  # к кириллице
    route = tags.get("route")
    name = tags.get("name", "")
    if "МЦК" in ref or "МЦК" in name or ref == "14":
        return "МЦК"
    if re.fullmatch(r"D[1-5]", ref.replace("Д", "D")):
        return ref.replace("Д", "D")
    if route in ("subway", "light_rail"):
        m = re.fullmatch(r"(\d{1,2})(А?)", ref)
        if m:
            n = int(m.group(1))
            if n == 13:  # монорельс — значка нет
                return None
            if 1 <= n <= 18:
                return f"{n}{m.group(2)}"
    return None

print("1) маршрутные relations…")
routes = overpass(Q_ROUTES)
node_lines = {}   # node_id -> set(tokens)
n_rel = 0
for el in routes.get("elements", []):
    if el.get("type") != "relation":
        continue
    tok = norm_ref(el.get("tags", {}))
    if not tok:
        continue
    n_rel += 1
    for m in el.get("members", []):
        if m.get("type") == "node" and m.get("role", "").startswith("stop"):
            node_lines.setdefault(m["ref"], set()).add(tok)
print(f"   relations учтено: {n_rel}, stop-узлов: {len(node_lines)}")

print("2) узлы-остановки…")
ids = sorted(node_lines)
nodes = {}
for i in range(0, len(ids), 700):
    chunk = ids[i:i + 700]
    q = f"[out:json][timeout:120];node(id:{','.join(map(str, chunk))});out body;"
    res = overpass(q)
    for el in res.get("elements", []):
        nodes[el["id"]] = el
    print(f"   {min(i+700, len(ids))}/{len(ids)}")

# сборка станций: имя + линии, слияние одноимённых рядом (<600 м)
def dist_m(a, b):
    kx = 111320 * math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 111320)

stations = []   # {name, lon, lat, lines:set}
skipped = 0
for nid, toks in node_lines.items():
    el = nodes.get(nid)
    if not el:
        continue
    name = (el.get("tags", {}).get("name") or "").strip()
    if not name:
        skipped += 1
        continue
    pt = (el["lon"], el["lat"])
    hit = None
    for s in stations:
        if s["name"] == name and dist_m((s["lon"], s["lat"]), pt) < 600:
            hit = s
            break
    if hit:
        hit["lines"] |= toks
        hit["pts"].append(pt)
    else:
        stations.append({"name": name, "lon": pt[0], "lat": pt[1], "lines": set(toks), "pts": [pt]})
print(f"   станций: {len(stations)} (без имени пропущено {skipped})")

def line_key(t):
    if t == "МЦК": return (2, 0)
    if t.startswith("D"): return (1, int(t[1:]))
    return (0, int(re.sub(r"\D", "", t) or 0))

feats = []
for s in sorted(stations, key=lambda x: x["name"]):
    lon = sum(p[0] for p in s["pts"]) / len(s["pts"])
    lat = sum(p[1] for p in s["pts"]) / len(s["pts"])
    feats.append({
        "type": "Feature",
        "properties": {"name": s["name"], "lines": sorted(s["lines"], key=line_key)},
        "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
    })

with open(OUT, "w", encoding="utf-8") as f:
    json.dump({"type": "FeatureCollection", "features": feats}, f, ensure_ascii=False, separators=(",", ":"))
print(f"OK: {OUT}: {os.path.getsize(OUT)//1024} KB, {len(feats)} станций")

for probe in ("Гражданская", "Дмитровская", "Савёловская", "Подмосковная"):
    hits = [f for f in feats if f["properties"]["name"] == probe]
    print(f"   {probe}: {[h['properties']['lines'] for h in hits] or '—'}")
