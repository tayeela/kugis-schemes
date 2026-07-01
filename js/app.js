/* Общее: загрузка данных, вкладки, выбор района, геоутилиты */
"use strict";

const App = {
  okruga: null,     // FeatureCollection
  rayony: null,     // FeatureCollection {ao, name}
  stations: null,   // FeatureCollection {name, line}
  district: null,   // выбранный район {ao, name, feature}
  onDistrictChange: [],
  FONT: '"Century Gothic","CenturyGothic","Didact Gothic",Arial,sans-serif',
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

/* «Полюс недоступности» — точка внутри полигона, максимально удалённая от границ.
   ring: [[x,y],...] замкнутое кольцо в плоских координатах. Алгоритм Mapbox polylabel. */
function poleOfInaccessibility(ring, precision = 1) {
  function segDist(px, py, a, b) {
    let x = a[0], y = a[1], dx = b[0] - x, dy = b[1] - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b[0]; y = b[1]; }
      else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = px - x; dy = py - y;
    return dx * dx + dy * dy;
  }
  function pointDist(x, y) { // >0 внутри, <0 снаружи
    let inside = false, minSq = Infinity;
    for (let i = 0, n = ring.length - 1; i < n; i++) {
      const a = ring[i], b = ring[i + 1];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
      minSq = Math.min(minSq, segDist(x, y, a, b));
    }
    return (inside ? 1 : -1) * Math.sqrt(minSq);
  }
  const [bx0, by0, bx1, by1] = ringsBBox([ring]);
  const cellSize = Math.min(bx1 - bx0, by1 - by0);
  if (!(cellSize > 0)) return { x: bx0, y: by0, d: 0 };
  precision = Math.max(precision, cellSize / 64);
  const cells = [];
  const addCell = (x, y, h) => {
    const d = pointDist(x, y);
    cells.push({ x, y, h, d, max: d + h * Math.SQRT2 });
  };
  for (let x = bx0; x < bx1; x += cellSize)
    for (let y = by0; y < by1; y += cellSize)
      addCell(x + cellSize / 2, y + cellSize / 2, cellSize / 2);
  const c0 = ringCentroid(ring);
  let best = { x: c0[0], y: c0[1], d: pointDist(c0[0], c0[1]) };
  let iter = 0;
  while (cells.length && iter++ < 1500) {
    let bi = 0; // линейный поиск ячейки с наибольшим потенциалом
    for (let i = 1; i < cells.length; i++) if (cells[i].max > cells[bi].max) bi = i;
    const c = cells[bi];
    cells[bi] = cells[cells.length - 1];
    cells.pop();
    if (c.d > best.d) best = { x: c.x, y: c.y, d: c.d };
    if (c.max - best.d <= precision) continue;
    const h = c.h / 2;
    addCell(c.x - h, c.y - h, h); addCell(c.x + h, c.y - h, h);
    addCell(c.x - h, c.y + h, h); addCell(c.x + h, c.y + h, h);
  }
  return best;
}

/* Горизонтальный «просвет» кольца на высоте y вокруг x: [левый край, правый край] или null */
function horizontalClearance(ring, x, y) {
  const xs = [];
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const a = ring[i], b = ring[i + 1];
    if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]));
  }
  xs.sort((p, q) => p - q);
  for (let i = 0; i + 1 < xs.length; i += 2)
    if (x >= xs[i] && x <= xs[i + 1]) return [xs[i], xs[i + 1]];
  return null;
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
