/* Общее: загрузка данных, вкладки, выбор района, геоутилиты */
"use strict";

const App = {
  okruga: null,     // FeatureCollection
  rayony: null,     // FeatureCollection {ao, name}
  stations: null,   // FeatureCollection {name, line}
  district: null,   // выбранный район {ao, name, feature}
  onDistrictChange: [],
};

/* Известные написания с «ё» (в данных «ё» отсутствует) */
const YO_FIX = {
  "Савеловский": "Савёловский",
  "Хорошевский": "Хорошёвский",
  "Хорошево-Мневники": "Хорошёво-Мнёвники",
  "Дорогомилово": "Дорогомилово",
  "Тропарево-Никулино": "Тропарёво-Никулино",
  "Черемушки": "Черёмушки",
  "Теплый Стан": "Тёплый Стан",
  "Десеновское": "Десёновское",
  "Филевский Парк": "Филёвский Парк",
  "Семеновское": "Семёновское",
};
function fixYo(name) { return YO_FIX[name] || name; }

const AO_FULL = { "НАО": "Новомосковский АО", "ТАО": "Троицкий АО" };

/* ---------- геоутилиты ---------- */
function geomRings(geom) { // все внешние+внутренние кольца [[ [lng,lat],... ], ...]
  if (!geom) return [];
  if (geom.type === "Polygon") return geom.coordinates;
  if (geom.type === "MultiPolygon") return geom.coordinates.flat();
  return [];
}
function geomOuterRings(geom) {
  if (!geom) return [];
  if (geom.type === "Polygon") return [geom.coordinates[0]];
  if (geom.type === "MultiPolygon") return geom.coordinates.map(p => p[0]);
  return [];
}
function ringsBBox(rings) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) for (const [x, y] of r) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
function ringCentroid(ring) { // центроид полигона (плоский)
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const f = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    a += f; cx += (ring[i][0] + ring[i + 1][0]) * f; cy += (ring[i][1] + ring[i + 1][1]) * f;
  }
  if (Math.abs(a) < 1e-12) return ring[0];
  return [cx / (3 * a), cy / (3 * a)];
}
function largestOuterRing(geom) {
  let best = null, bestA = -1;
  for (const r of geomOuterRings(geom)) {
    let a = 0;
    for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
    a = Math.abs(a);
    if (a > bestA) { bestA = a; best = r; }
  }
  return best;
}
function featureCentroid(f) { return ringCentroid(largestOuterRing(f.geometry)); }

/* площадь кольца в м² по сфере; ring = [[lng,lat],...] */
function sphericalAreaM2(ring) {
  const R = 6378137, D = Math.PI / 180;
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const p1 = ring[i], p2 = ring[(i + 1) % ring.length];
    s += (p2[0] - p1[0]) * D * (2 + Math.sin(p1[1] * D) + Math.sin(p2[1] * D));
  }
  return Math.abs(s * R * R / 2);
}
function formatHa(m2) {
  return (m2 / 10000).toFixed(2).replace(".", ",") + " га";
}

function toast(msg, ms = 2600) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(t._tm); t._tm = setTimeout(() => t.hidden = true, ms);
}

/* ---------- вкладки ---------- */
document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".panel").forEach(p =>
      p.classList.toggle("active", p.id === "panel-" + btn.dataset.tab));
    if (btn.dataset.tab === "ortho" && typeof Ortho !== "undefined") Ortho.onShow();
  });
});

/* ---------- загрузка данных ---------- */
async function loadData() {
  const [ok, ra, st] = await Promise.all([
    fetch("data/okruga.geojson").then(r => r.json()),
    fetch("data/rayony.geojson").then(r => r.json()),
    fetch("data/stations.geojson").then(r => r.json()),
  ]);
  App.okruga = ok; App.rayony = ra; App.stations = st;

  // выпадающий список: округ → районы
  const sel = document.getElementById("district-select");
  const byAo = new Map();
  for (const f of ra.features) {
    if (!byAo.has(f.properties.ao)) byAo.set(f.properties.ao, []);
    byAo.get(f.properties.ao).push(f);
  }
  const aoOrder = ["ЦАО","САО","СВАО","ВАО","ЮВАО","ЮАО","ЮЗАО","ЗАО","СЗАО","ЗелАО","НАО","ТАО"];
  for (const ao of aoOrder) {
    const list = byAo.get(ao); if (!list) continue;
    const og = document.createElement("optgroup");
    og.label = AO_FULL[ao] || ao;
    list.sort((a, b) => a.properties.name.localeCompare(b.properties.name, "ru"));
    for (const f of list) {
      const o = document.createElement("option");
      o.value = ao + "|" + f.properties.name;
      o.textContent = fixYo(f.properties.name);
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  sel.addEventListener("change", () => selectDistrict(sel.value));
  selectDistrict("САО|Савеловский", true);
}

function selectDistrict(key, init) {
  const [ao, name] = key.split("|");
  const f = App.rayony.features.find(x => x.properties.ao === ao && x.properties.name === name);
  if (!f) return;
  App.district = { ao, name, display: fixYo(name), feature: f };
  if (init) document.getElementById("district-select").value = key;
  App.onDistrictChange.forEach(cb => cb(App.district));
}

loadData().catch(e => toast("Ошибка загрузки данных: " + e.message, 8000));
