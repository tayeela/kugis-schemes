/* Ортофотоплан: спутник (Яндекс/Esri/Sentinel-2) + дороги и ЖД из OSM + маска района
   + территория + подписи с иконками метро + экспорт PNG */
"use strict";

const Ortho = (() => {
  /* ================= подложки ================= */
  const BASEMAPS = {
    yandex: {
      name: "Яндекс Спутник",
      url: "https://core-sat.maps.yandex.net/tiles?l=sat&x={x}&y={y}&z={z}&scale=1&lang=ru_RU",
      crs: "3395", maxNativeZoom: 19,
      attr: "© Яндекс Спутник",
    },
    esri: {
      name: "Esri World Imagery",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      crs: "3857", maxNativeZoom: 19,
      attr: "Esri World Imagery — Esri, Maxar, Earthstar Geographics",
    },
    s2: {
      name: "Sentinel-2 cloudless 2024",
      url: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg",
      crs: "3857", maxNativeZoom: 14,
      attr: "Sentinel-2 cloudless 2024 — EOX IT Services (CC BY 4.0)",
    },
  };
  let curBase = "yandex";

  /* ================= оформление дорог и ЖД (базовые толщины при z16) ================= */
  const ROAD_COLOR = "#f3ecd2";
  const ROAD_W = {
    motorway: 16, trunk: 16, primary: 13, secondary: 11, tertiary: 9,
    unclassified: 6.5, residential: 6.5, living_street: 5, pedestrian: 5,
  };
  const RAIL = { casing: 7.5, dash: 4.5, dashLen: 18 };
  const BOUNDARY = "#824a43";   // границы районов и округов — всегда этот цвет
  const zf = z => Math.min(3, Math.max(0.15, Math.pow(2, z - 16)));

  /* генерализованные ЖД-ходы (data/railways.geojson) -> [[lat,lng],...][] */
  function railLines() {
    if (!App.railways) return [];
    return App.railways.features.map(f => f.geometry.coordinates.map(([x, y]) => [y, x]));
  }

  let map = null, baseLayer = null, inited = false;
  const st = {
    maskLayer: null, edgeLayer: null,
    territory: null,          // {latlngs, layer, areaM2}
    annotations: [],          // {id,type,latlng,text,size,rot,badges,marker,leaderTo,leaderLayer}
    selected: null,
    drawing: null,
    nextId: 1,
    osm: null,                // {roadsByClass: {cls: [[latlng,..],..]}, rails: [[latlng,..],..], layers}
  };
  const osmCache = {};        // districtKey -> данные Overpass

  /* ================= карта ================= */
  function crsOf(id) { return BASEMAPS[id].crs === "3395" ? L.CRS.EPSG3395 : L.CRS.EPSG3857; }

  function createMap(center, zoom) {
    map = L.map("map", { center, zoom, maxZoom: 21, crs: crsOf(curBase) });
    map.createPane("roads");
    map.getPane("roads").style.zIndex = 350;
    map.createPane("mask");
    map.getPane("mask").style.zIndex = 380;
    // канвас-рендереры: общегородские линии в SVG на больших зумах вешают браузер
    st.roadsCanvas = L.canvas({ pane: "roads" });
    st.boundsCanvas = L.canvas({ pane: "overlayPane" });
    const bm = BASEMAPS[curBase];
    baseLayer = L.tileLayer(bm.url, { maxZoom: 21, maxNativeZoom: bm.maxNativeZoom, attribution: bm.attr }).addTo(map);
    addAllBoundaries();
    map.on("click", onMapClick);
    map.on("dblclick", onMapDblClick);
    map.on("zoomend", updateOsmWeights);
  }

  /* --- тонкие границы всех районов (над маской) --- */
  function addAllBoundaries() {
    if (!map) return;
    if (st.allBounds) map.removeLayer(st.allBounds);
    const lines = App.rayony.features.flatMap(f =>
      geomRings(f.geometry).map(r => r.map(([x, y]) => [y, x])));
    st.allBounds = L.polyline(lines, {
      renderer: st.boundsCanvas,
      color: BOUNDARY, weight: 1.2, interactive: false, opacity: 0.9,
    }).addTo(map);
  }

  function ensureMap() {
    if (inited) return;
    inited = true;
    createMap([55.75, 37.62], 11);
    if (App.district) applyDistrict(App.district);
    if (!restore() && App.district) {
      autoAddStations(App.district);
      autoAddDistrictLabels(App.district);
    }
    if (document.getElementById("osm-roads").checked) loadOSM();
  }
  function onShow() { ensureMap(); setTimeout(() => map.invalidateSize(), 50); }

  function setBasemap(id) {
    if (!inited) { curBase = id; return; }
    const sameCrs = BASEMAPS[id].crs === BASEMAPS[curBase].crs;
    curBase = id;
    if (sameCrs) {
      map.removeLayer(baseLayer);
      const bm = BASEMAPS[id];
      baseLayer = L.tileLayer(bm.url, { maxZoom: 21, maxNativeZoom: bm.maxNativeZoom, attribution: bm.attr }).addTo(map);
    } else {
      // другая проекция (Яндекс = EPSG:3395) — пересоздаём карту, слои переносим
      cancelDraw();
      const c = map.getCenter(), z = map.getZoom();
      map.remove();
      createMap(c, z);   // nature и границы районов пересоздаются внутри
      if (App.district) applyDistrict(App.district, true);
      addOsmLayers();
      if (st.territory) st.territory.layer.addTo(map);
      for (const a of st.annotations) {
        a.marker.addTo(map);
        if (a.leaderLayer) a.leaderLayer.addTo(map);
      }
    }
    save();
  }

  function applyDistrict(d, keepView) {
    if (!inited) return;
    if (st.maskLayer) { map.removeLayer(st.maskLayer); st.maskLayer = null; }
    if (st.edgeLayer) { map.removeLayer(st.edgeLayer); st.edgeLayer = null; }
    const rings = geomRings(d.feature.geometry).map(r => r.map(([x, y]) => [y, x]));
    const world = [[85, -180], [85, 180], [-85, 180], [-85, -180]];
    st.maskLayer = L.polygon([world, ...rings], {
      pane: "mask", stroke: false, fillColor: "#fff", fillOpacity: 0.55, interactive: false,
    }).addTo(map);
    st.edgeLayer = L.polygon(rings, {
      color: BOUNDARY, weight: 3, fill: false, interactive: false,
    }).addTo(map);
    if (!keepView) map.fitBounds(L.latLngBounds(rings.flat()), { padding: [30, 30] });
  }

  App.onDistrictChange.push(d => {
    if (!inited) return;
    const saved = readSaved();
    clearAll(false);
    removeOsmLayers();
    applyDistrict(d);
    if (saved && saved.district === d.ao + "|" + d.name) restoreState(saved);
    else { autoAddStations(d); autoAddDistrictLabels(d); }
    if (document.getElementById("osm-roads").checked) loadOSM();
  });

  /* станции метро/МЦК/МЦД в границах района (+20%) — автоматически */
  function autoAddStations(d) {
    const [x0, y0, x1, y1] = ringsBBox(geomOuterRings(d.feature.geometry));
    const px = (x1 - x0) * 0.2, py = (y1 - y0) * 0.2;
    addStationsInBounds(L.latLngBounds([y0 - py, x0 - px], [y1 + py, x1 + px]), true);
  }

  /* подписи выбранного района и соседей (как в образце: НАО\nФИЛИМОНКОВСКИЙ) */
  function geoPole(geom) {
    const ring = largestOuterRing(geom);
    const kx = Math.cos(ring[0][1] * Math.PI / 180);
    const pole = poleOfInaccessibility(ring.map(([x, y]) => [x * kx, y]), 0.0003);
    return { lat: pole.y, lng: pole.x / kx };
  }
  function autoAddDistrictLabels(d) {
    const [x0, y0, x1, y1] = ringsBBox(geomOuterRings(d.feature.geometry));
    const px = (x1 - x0) * 0.25, py = (y1 - y0) * 0.25;
    for (const f of App.rayony.features) {
      const [a0, b0, a1, b1] = ringsBBox(geomOuterRings(f.geometry));
      if (a1 < x0 - px || a0 > x1 + px || b1 < y0 - py || b0 > y1 + py) continue;
      const isSel = f === d.feature;
      const name = fixYo(f.properties.name);
      const text = (isSel || f.properties.ao !== d.ao) ? f.properties.ao + "\n" + name : name;
      addAnnotation({ type: "district", latlng: geoPole(f.geometry), text, size: isSel ? 24 : 17 });
    }
    selectAnn(null);
  }

  function addStationsInBounds(b, quiet) {
    let n = 0;
    for (const f of App.stations.features) {
      const [lng, lat] = f.geometry.coordinates;
      if (!b.contains([lat, lng])) continue;
      if (st.annotations.some(a => a.type === "metro" && a.text === f.properties.name)) continue;
      addAnnotation({
        type: "metro", latlng: { lat, lng }, text: f.properties.name,
        badges: (f.properties.lines || []).slice(), size: 14,
      });
      n++;
    }
    selectAnn(null);
    if (!quiet) toast(n ? `Добавлено станций: ${n}` : "В текущем кадре станций нет");
    save();
  }

  /* ================= дороги и ЖД из OSM (Overpass) ================= */
  const OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];

  function osmStatus(msg) { document.getElementById("osm-status").textContent = msg; }

  async function loadOSM() {
    if (!App.district || !inited) return;
    const key = App.district.ao + "|" + App.district.name;
    removeOsmLayers();
    if (osmCache[key]) { st.osm = osmCache[key]; addOsmLayers(); osmStatus(osmSummary()); return; }
    addOsmLayers(); // ЖД-ходы из файла показываем сразу, не дожидаясь Overpass
    osmStatus("Загрузка дорог из OSM…");
    const rings = geomOuterRings(App.district.feature.geometry);
    const [x0, y0, x1, y1] = ringsBBox(rings);
    // буфер: ~40% рамки района, но не меньше ~2 км и не больше ~5 км
    const px = Math.min(Math.max((x1 - x0) * 0.4, 0.032), 0.08);
    const py = Math.min(Math.max((y1 - y0) * 0.4, 0.018), 0.045);
    const bbox = `${(y0 - py).toFixed(5)},${(x0 - px).toFixed(5)},${(y1 + py).toFixed(5)},${(x1 + px).toFixed(5)}`;
    const q = `[out:json][timeout:90];(
      way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian)$"](${bbox});
    );out geom;`;
    let data = null, err = null;
    for (const ep of OVERPASS) {
      try {
        const r = await fetch(ep, { method: "POST", body: "data=" + encodeURIComponent(q) });
        if (!r.ok) throw new Error("HTTP " + r.status);
        data = await r.json();
        break;
      } catch (e) { err = e; }
    }
    if (!data) { osmStatus("Дороги OSM не загрузились (" + (err && err.message) + ") — показаны только ЖД"); return; }
    const roadsByClass = {};
    for (const el of data.elements || []) {
      if (!el.geometry) continue;
      const line = el.geometry.map(p => [p.lat, p.lon]);
      const hw = el.tags && el.tags.highway;
      if (hw && ROAD_W[hw]) (roadsByClass[hw] = roadsByClass[hw] || []).push(line);
    }
    st.osm = { roadsByClass };
    osmCache[key] = st.osm;
    if (document.getElementById("osm-roads").checked) addOsmLayers();
    osmStatus(osmSummary());
  }
  function osmSummary() {
    if (!st.osm) return "";
    const nr = Object.values(st.osm.roadsByClass).reduce((p, c) => p + c.length, 0);
    return `OSM: дорог ${nr} · ЖД-ходов ${railLines().length}`;
  }

  function addOsmLayers() {
    if (!map) return;
    removeOsmLayers(true);
    const f = zf(map.getZoom());
    const layers = { roads: [], railCasing: null, railDash: null };
    // порядок добавления в pane = порядок отрисовки: мелкие → крупные → ЖД
    const order = ["pedestrian", "living_street", "residential", "unclassified", "tertiary", "secondary", "primary", "trunk", "motorway"];
    for (const cls of order) {
      const lines = st.osm && st.osm.roadsByClass[cls];
      if (!lines || !lines.length) continue;
      const lay = L.polyline(lines, {
        renderer: st.roadsCanvas, color: ROAD_COLOR, weight: ROAD_W[cls] * f,
        lineCap: "round", lineJoin: "round", interactive: false, opacity: 1,
      }).addTo(map);
      layers.roads.push({ layer: lay, base: ROAD_W[cls] });
    }
    const rl = railLines();
    if (rl.length) {
      layers.railCasing = L.polyline(rl, {
        renderer: st.roadsCanvas, color: "#1a1a1a", weight: RAIL.casing * f,
        lineCap: "butt", interactive: false,
      }).addTo(map);
      layers.railDash = L.polyline(rl, {
        renderer: st.roadsCanvas, color: "#ffffff", weight: RAIL.dash * f,
        dashArray: `${RAIL.dashLen * f} ${RAIL.dashLen * f}`, lineCap: "butt", interactive: false,
      }).addTo(map);
    }
    st.osmLayers = layers;
  }
  function removeOsmLayers(keepData) {
    if (st.osmLayers) {
      st.osmLayers.roads.forEach(r => map.removeLayer(r.layer));
      if (st.osmLayers.railCasing) map.removeLayer(st.osmLayers.railCasing);
      if (st.osmLayers.railDash) map.removeLayer(st.osmLayers.railDash);
      st.osmLayers = null;
    }
    if (!keepData) { st.osm = null; osmStatus(""); }
  }
  function updateOsmWeights() {
    if (!st.osmLayers) return;
    const f = zf(map.getZoom());
    st.osmLayers.roads.forEach(r => r.layer.setStyle({ weight: r.base * f }));
    if (st.osmLayers.railCasing) st.osmLayers.railCasing.setStyle({ weight: RAIL.casing * f });
    if (st.osmLayers.railDash) st.osmLayers.railDash.setStyle({
      weight: RAIL.dash * f, dashArray: `${RAIL.dashLen * f} ${RAIL.dashLen * f}`,
    });
  }

  /* ================= территория ================= */
  function startDraw() {
    ensureMap();
    cancelDraw();
    st.drawing = { pts: [], line: L.polyline([], { color: magenta(), weight: 3, dashArray: "6 4" }), dots: [] };
    st.drawing.line.addTo(map);
    map.doubleClickZoom.disable();
    map.getContainer().style.cursor = "crosshair";
    document.getElementById("draw-tip").hidden = false;
    document.getElementById("ortho-draw").classList.add("active-tool");
  }
  function cancelDraw() {
    if (!st.drawing) return;
    map.removeLayer(st.drawing.line);
    st.drawing.dots.forEach(d => map.removeLayer(d));
    st.drawing = null;
    map.doubleClickZoom.enable();
    map.getContainer().style.cursor = "";
    document.getElementById("draw-tip").hidden = true;
    document.getElementById("ortho-draw").classList.remove("active-tool");
  }
  function onMapClick(e) {
    if (st.drawing) {
      st.drawing.pts.push([e.latlng.lat, e.latlng.lng]);
      st.drawing.line.setLatLngs(st.drawing.pts);
      st.drawing.dots.push(L.circleMarker(e.latlng, { radius: 4, color: magenta(), fillOpacity: 1 }).addTo(map));
      return;
    }
    selectAnn(null);
  }
  function onMapDblClick() {
    if (!st.drawing) return;
    const pts = st.drawing.pts;
    while (pts.length > 1 && near(pts[pts.length - 1], pts[pts.length - 2])) pts.pop();
    if (pts.length < 3) { toast("Нужно минимум 3 вершины"); return; }
    cancelDraw();
    setTerritory(pts);
    save();
  }
  function near(a, b) { return Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7; }

  function setTerritory(latlngs, noCallout) {
    clearTerritory();
    const areaM2 = sphericalAreaM2(latlngs.map(([la, ln]) => [ln, la]));
    const layer = L.polygon(latlngs, {
      color: magenta(), weight: 4, fill: false, lineJoin: "round", interactive: false,
    }).addTo(map);
    st.territory = { latlngs, layer, areaM2 };
    document.getElementById("ortho-area").textContent = "Площадь: " + formatHa(areaM2);
    if (!noCallout) {
      const c = ringCentroid(latlngs.map(([la, ln]) => [ln, la]));
      const b = layer.getBounds();
      addAnnotation({
        type: "callout",
        latlng: { lat: b.getSouth() - (b.getNorth() - b.getSouth()) * 1.2, lng: c[0] },
        text: "Рассматриваемая территория – " + formatHa(areaM2),
        size: 16, rot: 0,
        leaderTo: { lat: c[1], lng: c[0] },
      });
    }
  }
  function clearTerritory() {
    if (st.territory) { map.removeLayer(st.territory.layer); st.territory = null; }
    document.getElementById("ortho-area").textContent = "";
  }

  function importGeoJSON(file) {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const gj = JSON.parse(rd.result);
        const feats = gj.type === "FeatureCollection" ? gj.features : [gj.type === "Feature" ? gj : { geometry: gj }];
        const f = feats.find(x => x.geometry && /Polygon/.test(x.geometry.type));
        if (!f) { toast("В файле нет полигона"); return; }
        const ring = geomOuterRings(f.geometry)[0];
        if (Math.abs(ring[0][0]) > 180 || Math.abs(ring[0][1]) > 90) {
          toast("Координаты не в WGS84 — пересохраните GeoJSON в EPSG:4326", 6000); return;
        }
        setTerritory(ring.map(([ln, la]) => [la, ln]));
        map.fitBounds(st.territory.layer.getBounds(), { padding: [60, 60] });
        save();
      } catch (e) { toast("Не удалось прочитать файл: " + e.message, 5000); }
    };
    rd.readAsText(file);
  }

  /* ================= иконки метро ================= */
  const ICON_DIR = "assets/metro/";
  const iconCache = {};   // name -> Promise<{img, ratio}>

  function badgeIconName(tok) {
    const t = tok.trim().toUpperCase().replace(/Д/g, "D");
    if (t === "М" || t === "M") return "m";
    if (t === "МЦК" || t === "MЦК" || t === "MCK") return "line-14";
    if (/^D[1-5]$/.test(t)) return t.toLowerCase();
    if (t === "4A" || t === "4А") return "line-4a";
    if (t === "8A" || t === "8А") return "line-8a";
    if (/^\d{1,2}$/.test(t) && +t >= 1 && +t <= 18 && +t !== 13) return "line-" + +t;
    return null;
  }

  function loadIcon(name) {
    if (iconCache[name]) return iconCache[name];
    iconCache[name] = (async () => {
      const txt = await fetch(ICON_DIR + name + ".svg").then(r => {
        if (!r.ok) throw new Error(name + ".svg: HTTP " + r.status);
        return r.text();
      });
      const doc = new DOMParser().parseFromString(txt, "image/svg+xml");
      const root = doc.documentElement;
      if (!root.getAttribute("width") && root.getAttribute("viewBox")) {
        const p = root.getAttribute("viewBox").trim().split(/[\s,]+/);
        root.setAttribute("width", p[2]);
        root.setAttribute("height", p[3]);
      }
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(root)], { type: "image/svg+xml" }));
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error("не загрузилась иконка " + name));
        im.src = url;
      });
      return { img, ratio: img.width / img.height };
    })();
    return iconCache[name];
  }

  /* ================= аннотации ================= */
  function magenta() { return getComputedStyle(document.documentElement).getPropertyValue("--magenta").trim(); }
  function frameColor() { return getComputedStyle(document.documentElement).getPropertyValue("--frame").trim(); }

  const DEFAULTS = {
    street: { text: "Название улицы", size: 15 },
    district: { text: "РАЙОН", size: 26 },
    metro: { text: "Станция", size: 14, badges: ["D2"] },
    callout: { text: "Текст выноски", size: 16 },
  };

  function addAnnotation(opts) {
    const a = Object.assign({ id: st.nextId++, rot: 0, badges: [] }, structuredClone(DEFAULTS[opts.type]), opts);
    a.marker = L.marker(a.latlng, {
      icon: makeIcon(a), draggable: true, autoPan: true,
    }).addTo(map);
    a.marker.on("click", () => selectAnn(a));
    a.marker.on("drag", () => { a.latlng = a.marker.getLatLng(); updateLeader(a); });
    a.marker.on("dragend", save);
    if (a.leaderTo) {
      a.leaderLayer = L.polyline([a.latlng, a.leaderTo], { color: "#fff", weight: 2, interactive: false }).addTo(map);
    }
    st.annotations.push(a);
    selectAnn(a);
    return a;
  }

  function makeIcon(a) {
    const rot = a.rot ? ` rotate(${a.rot}deg)` : "";
    let inner = "";
    if (a.type === "metro") {
      const badges = ["М"].concat(a.badges || []).map(b => {
        const name = badgeIconName(b);
        return name ? `<img src="${ICON_DIR}${name}.svg" alt="${esc(b)}">`
                    : `<span class="m-badge">${esc(b)}</span>`;
      }).join("");
      inner = `<div class="m-row">${badges}</div><div class="m-name">${esc(a.text)}</div>`;
    } else {
      inner = esc(a.text).replaceAll("\n", "<br>");
    }
    const sel = st.selected === a ? " selected" : "";
    const html =
      `<div class="ann ann-${a.type}${sel}" style="font-size:${a.size}px;transform:translate(-50%,-50%)${rot}">` +
      `<div class="ann-inner">${inner}</div></div>`;
    return L.divIcon({ className: "ann-wrap", html, iconSize: [0, 0] });
  }
  function esc(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"); }

  function refreshIcon(a) { a.marker.setIcon(makeIcon(a)); }
  function updateLeader(a) {
    if (a.leaderLayer) a.leaderLayer.setLatLngs([a.latlng, a.leaderTo]);
  }

  function selectAnn(a) {
    const prev = st.selected;
    st.selected = a;
    if (prev && prev !== a) refreshIcon(prev);
    const panel = document.getElementById("ann-props");
    if (!a) { panel.hidden = true; return; }
    refreshIcon(a);
    panel.hidden = false;
    document.getElementById("ann-text").value = a.text;
    document.getElementById("ann-size").value = a.size;
    document.getElementById("ann-size-val").textContent = a.size;
    document.getElementById("ann-rot").value = a.rot || 0;
    document.getElementById("ann-rot-val").textContent = a.rot || 0;
    document.getElementById("ann-rot-field").style.display = a.type === "metro" ? "none" : "";
    document.getElementById("ann-badges-field").style.display = a.type === "metro" ? "" : "none";
    document.getElementById("ann-badges").value = (a.badges || []).join(", ");
  }

  function deleteAnn(a) {
    if (!a) return;
    map.removeLayer(a.marker);
    if (a.leaderLayer) map.removeLayer(a.leaderLayer);
    st.annotations = st.annotations.filter(x => x !== a);
    if (st.selected === a) selectAnn(null);
    save();
  }

  function clearAll(alsoDistrictLayers = true) {
    cancelDraw();
    clearTerritory();
    [...st.annotations].forEach(a => {
      map.removeLayer(a.marker);
      if (a.leaderLayer) map.removeLayer(a.leaderLayer);
    });
    st.annotations = [];
    selectAnn(null);
    if (alsoDistrictLayers) {
      if (st.maskLayer) map.removeLayer(st.maskLayer);
      if (st.edgeLayer) map.removeLayer(st.edgeLayer);
    }
  }

  function addStationsInView() {
    ensureMap();
    addStationsInBounds(map.getBounds());
  }

  /* ================= сохранение ================= */
  const LS_KEY = "kugis-ortho-v1";
  function save() {
    if (!App.district) return;
    const data = {
      district: App.district.ao + "|" + App.district.name,
      basemap: curBase,
      frame: document.getElementById("frame-color").value,
      territory: st.territory ? st.territory.latlngs : null,
      annotations: st.annotations.map(a => ({
        type: a.type, latlng: a.latlng, text: a.text, size: a.size, rot: a.rot,
        badges: a.badges, leaderTo: a.leaderTo || null,
      })),
    };
    try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (e) {}
  }
  function readSaved() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { return null; }
  }
  function restore() {
    const saved = readSaved();
    if (saved && App.district && saved.district === App.district.ao + "|" + App.district.name) {
      restoreState(saved);
      return true;
    }
    return false;
  }
  function restoreState(saved) {
    if (saved.frame) setFrameColor(saved.frame);
    if (saved.territory) setTerritory(saved.territory, true);
    for (const a of saved.annotations || []) addAnnotation(a);
    selectAnn(null);
  }
  function setFrameColor(v) {
    document.documentElement.style.setProperty("--frame", v);
    document.getElementById("frame-color").value = v;
  }

  /* ================= экспорт PNG ================= */
  function projPx(lat, lng, z, elliptical) {
    const n = 256 * Math.pow(2, z);
    const x = (lng + 180) / 360 * n;
    let yNorm;
    if (elliptical) { // EPSG:3395 (Яндекс)
      const e = 0.0818191908426;
      const phi = lat * Math.PI / 180;
      const con = e * Math.sin(phi);
      const ts = Math.tan(Math.PI / 4 - phi / 2) / Math.pow((1 - con) / (1 + con), e / 2);
      yNorm = 0.5 + Math.log(ts) / (2 * Math.PI);
    } else {          // EPSG:3857
      const s = Math.sin(lat * Math.PI / 180);
      yNorm = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    }
    return [x, yNorm * n];
  }
  function loadTile(url) {
    return new Promise(res => {
      const im = new Image();
      im.crossOrigin = "anonymous";
      im.onload = () => res(im);
      im.onerror = () => res(null);
      im.src = url;
    });
  }

  async function renderExport() {
    ensureMap();
    await document.fonts.ready;
    const bm = BASEMAPS[curBase];
    const ell = bm.crs === "3395";
    const spec = pageSpec("ortho"); // null => «текущий вид»
    const z = Math.round(map.getZoom());
    const b = map.getBounds();
    let [x0, y0] = projPx(b.getNorth(), b.getWest(), z, ell);
    let [x1, y1] = projPx(b.getSouth(), b.getEast(), z, ell);
    let zE;
    if (!spec) {
      const dz = { "1": 0, "2": 1, "3": 2 }[document.getElementById("ortho-scale").value];
      zE = Math.min(z + dz, bm.maxNativeZoom);
    } else {
      // расширяем рамку до пропорций листа (симметрично от текущего вида)
      const aspect = spec.wpx / spec.hpx;
      const cw = x1 - x0, ch = y1 - y0;
      if (cw / ch < aspect) { const add = (ch * aspect - cw) / 2; x0 -= add; x1 += add; }
      else { const add = (cw / aspect - ch) / 2; y0 -= add; y1 += add; }
      // зум под целевое разрешение листа
      const need = Math.max(0, Math.ceil(Math.log2(spec.wpx / (x1 - x0))));
      zE = Math.min(z + need, bm.maxNativeZoom);
      while (zE > z - 4 && (x1 - x0) * (y1 - y0) * Math.pow(4, zE - z) > 64e6) zE--;
    }
    const s = Math.pow(2, zE - z);
    x0 *= s; y0 *= s; x1 *= s; y1 *= s;
    const W = Math.round(x1 - x0), H = Math.round(y1 - y0);
    if (W * H > 64e6) throw new Error("слишком большой экспорт — уменьшите формат или окно");

    // предзагрузка иконок метро
    const iconNames = new Set();
    for (const a of st.annotations) {
      if (a.type !== "metro") continue;
      iconNames.add("m");
      for (const t of a.badges || []) { const n = badgeIconName(t); if (n) iconNames.add(n); }
    }
    const icons = {};
    await Promise.all([...iconNames].map(async n => { try { icons[n] = await loadIcon(n); } catch (e) {} }));

    toast("Собираю тайлы…", 60000);
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#e8e6e0"; ctx.fillRect(0, 0, W, H);

    const t0x = Math.floor(x0 / 256), t1x = Math.floor(x1 / 256);
    const t0y = Math.floor(y0 / 256), t1y = Math.floor(y1 / 256);
    const jobs = [];
    let okTiles = 0, allTiles = 0;
    for (let tx = t0x; tx <= t1x; tx++)
      for (let ty = t0y; ty <= t1y; ty++) {
        allTiles++;
        const url = bm.url.replace("{z}", zE).replace("{x}", tx).replace("{y}", ty);
        jobs.push(loadTile(url).then(im => {
          if (im) { okTiles++; ctx.drawImage(im, Math.round(tx * 256 - x0), Math.round(ty * 256 - y0)); }
        }));
      }
    await Promise.all(jobs);
    if (okTiles < allTiles * 0.5)
      toast(`Загрузилась только часть тайлов (${okTiles}/${allTiles}) — попробуйте другую подложку`, 6000);

    const P = (latlng) => {
      const ll = Array.isArray(latlng) ? { lat: latlng[0], lng: latlng[1] } : latlng;
      const [x, y] = projPx(ll.lat, ll.lng, zE, ell);
      return [x - x0, y - y0];
    };
    const strokeLine = (line, isLatLngPairs) => {
      ctx.beginPath();
      line.forEach((pt, i) => {
        const [x, y] = P(pt);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    };

    // дороги и ЖД (если включены)
    if (document.getElementById("osm-roads").checked) {
      const f = zf(zE);
      if (st.osm) {
        ctx.lineCap = "round"; ctx.lineJoin = "round";
        ctx.strokeStyle = ROAD_COLOR;
        const order = ["pedestrian", "living_street", "residential", "unclassified", "tertiary", "secondary", "primary", "trunk", "motorway"];
        for (const cls of order) {
          const lines = st.osm.roadsByClass[cls];
          if (!lines) continue;
          ctx.lineWidth = ROAD_W[cls] * f;
          for (const line of lines) strokeLine(line);
        }
      }
      const rl = railLines();
      ctx.lineCap = "butt"; ctx.lineJoin = "round";
      ctx.strokeStyle = "#1a1a1a"; ctx.lineWidth = RAIL.casing * f;
      for (const line of rl) strokeLine(line);
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = RAIL.dash * f;
      ctx.setLineDash([RAIL.dashLen * f, RAIL.dashLen * f]);
      for (const line of rl) strokeLine(line);
      ctx.setLineDash([]);
    }

    // маска вне района
    if (App.district) {
      const p = new Path2D();
      p.rect(0, 0, W, H);
      const rings = geomRings(App.district.feature.geometry);
      for (const ring of rings) {
        ring.forEach(([lng, lat], i) => {
          const [x, y] = P([lat, lng]);
          i ? p.lineTo(x, y) : p.moveTo(x, y);
        });
        p.closePath();
      }
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.fill(p, "evenodd");
      // тонкие границы всех районов поверх маски
      ctx.strokeStyle = BOUNDARY; ctx.lineJoin = "round";
      ctx.lineWidth = 1.2 * s; ctx.globalAlpha = 0.9;
      for (const f of App.rayony.features) {
        for (const ring of geomRings(f.geometry)) {
          ctx.beginPath();
          ring.forEach(([lng, lat], i) => {
            const [x, y] = P([lat, lng]);
            i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
          });
          ctx.closePath(); ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      // граница выбранного района
      ctx.lineWidth = 3 * s;
      for (const ring of rings) {
        ctx.beginPath();
        ring.forEach(([lng, lat], i) => {
          const [x, y] = P([lat, lng]);
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        });
        ctx.closePath(); ctx.stroke();
      }
    }

    // линии-выноски
    for (const a of st.annotations) {
      if (!a.leaderTo) continue;
      const [ax, ay] = P(a.latlng), [bx, by] = P(a.leaderTo);
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2 * s;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }

    // территория
    if (st.territory) {
      ctx.strokeStyle = magenta(); ctx.lineWidth = 4 * s; ctx.lineJoin = "round";
      ctx.beginPath();
      st.territory.latlngs.forEach((ll, i) => {
        const [x, y] = P(ll);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.closePath(); ctx.stroke();
    }

    // аннотации
    for (const a of st.annotations) drawAnnOnCanvas(ctx, a, P, s, icons);

    // атрибуция
    ctx.font = `${11 * s}px ${App.FONT}`;
    ctx.textAlign = "right"; ctx.textBaseline = "bottom";
    ctx.lineWidth = 3 * s; ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineJoin = "round";
    const attr = bm.attr + (st.osm && document.getElementById("osm-roads").checked ? " · дороги © OpenStreetMap" : "");
    ctx.strokeText(attr, W - 8 * s, H - 6 * s);
    ctx.fillStyle = "#333"; ctx.fillText(attr, W - 8 * s, H - 6 * s);

    // подгонка под лист
    let out = canvas;
    if (spec) {
      out = document.createElement("canvas");
      out.width = spec.wpx; out.height = spec.hpx;
      out.getContext("2d").drawImage(canvas, 0, 0, spec.wpx, spec.hpx);
    }
    return { canvas: out, spec };
  }

  function exportName(ext) {
    return "Ортофотоплан — " + (App.district ? App.district.display : "территория") + "." + ext;
  }
  async function exportPNG() {
    const { canvas } = await renderExport();
    canvas.toBlob(blob => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = exportName("png");
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast("Готово");
    }, "image/png");
  }
  async function exportPDF() {
    await loadJsPDF();
    const { canvas, spec } = await renderExport();
    const wmm = spec ? spec.wmm : canvas.width / 300 * 25.4;
    const hmm = spec ? spec.hmm : canvas.height / 300 * 25.4;
    downloadPDF(canvas, wmm, hmm, exportName("pdf"), true);
    toast("Готово");
  }

  function drawAnnOnCanvas(ctx, a, P, s, icons) {
    const [x, y] = P(a.latlng);
    const size = a.size * s;
    ctx.save();
    ctx.translate(x, y);
    if (a.rot && a.type !== "metro") ctx.rotate(a.rot * Math.PI / 180);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";

    if (a.type === "street") {
      ctx.font = `600 ${size}px ${App.FONT}`;
      drawHaloLines(ctx, a.text, size, "#1a1a1a", "#fff", size * 0.3);
    } else if (a.type === "district") {
      ctx.font = `700 ${size}px ${App.FONT}`;
      try { ctx.letterSpacing = (size * 0.14) + "px"; } catch (e) {}
      ctx.shadowColor = "rgba(0,0,0,.85)"; ctx.shadowBlur = 4 * s;
      drawHaloLines(ctx, a.text.toUpperCase(), size, "#fff", "rgba(0,0,0,.75)", size * 0.16);
      ctx.shadowBlur = 0;
      try { ctx.letterSpacing = "0px"; } catch (e) {}
    } else if (a.type === "callout") {
      ctx.font = `600 ${size}px ${App.FONT}`;
      const lines = (a.text || "").split("\n");
      const tw = Math.max(...lines.map(l => ctx.measureText(l).width));
      const lh = size * 1.35;
      const w = tw + size * 1.8, h = lines.length * lh + size * 0.9;
      ctx.fillStyle = "#fff"; ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeStyle = frameColor(); ctx.lineWidth = 2.5 * s;
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      ctx.fillStyle = "#111";
      lines.forEach((l, i) => ctx.fillText(l, 0, (i - (lines.length - 1) / 2) * lh));
    } else if (a.type === "metro") {
      // ряд иконок [М][бейджи], ниже — название
      const ih = size * 1.2;             // высота иконки
      const gap = size * 0.25;
      const toks = ["М"].concat(a.badges || []);
      const items = toks.map(t => {
        const n = badgeIconName(t);
        if (n && icons[n]) return { icon: icons[n], w: ih * icons[n].ratio };
        ctx.font = `700 ${size}px ${App.FONT}`;
        return { txt: t, w: ctx.measureText(t).width + size * 0.6 };
      });
      const total = items.reduce((p, c) => p + c.w, 0) + gap * (items.length - 1);
      let cx = -total / 2;
      const rowY = -size * 0.62;
      for (const it of items) {
        if (it.icon) {
          ctx.drawImage(it.icon.img, cx, rowY - ih / 2, it.w, ih);
        } else {
          ctx.fillStyle = "#888";
          roundRect(ctx, cx, rowY - ih / 2, it.w, ih, size * 0.2);
          ctx.fill();
          ctx.fillStyle = "#fff";
          ctx.font = `700 ${size}px ${App.FONT}`;
          ctx.fillText(it.txt, cx + it.w / 2, rowY + size * 0.05);
        }
        cx += it.w + gap;
      }
      const nameY = size * 0.75;
      ctx.font = `700 ${size}px ${App.FONT}`;
      ctx.lineWidth = size * 0.28; ctx.strokeStyle = "#fff"; ctx.lineJoin = "round";
      ctx.strokeText(a.text, 0, nameY);
      ctx.fillStyle = "#d6083b";
      ctx.fillText(a.text, 0, nameY);
    }
    ctx.restore();
  }
  function drawHaloLines(ctx, text, size, fill, halo, haloW) {
    const lines = (text || "").split("\n");
    const lh = size * 1.2;
    lines.forEach((l, i) => {
      const yy = (i - (lines.length - 1) / 2) * lh;
      ctx.lineWidth = haloW; ctx.strokeStyle = halo; ctx.lineJoin = "round";
      ctx.strokeText(l, 0, yy);
      ctx.fillStyle = fill; ctx.fillText(l, 0, yy);
    });
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ================= UI ================= */
  document.getElementById("basemap").addEventListener("change", e => setBasemap(e.target.value));
  document.getElementById("osm-roads").addEventListener("change", e => {
    if (!inited) return;
    if (e.target.checked) { st.osm ? addOsmLayers() : loadOSM(); }
    else removeOsmLayers(true);
  });
  document.getElementById("frame-color").addEventListener("input", e => {
    setFrameColor(e.target.value); save();
  });
  document.getElementById("ortho-draw").addEventListener("click", () =>
    st.drawing ? cancelDraw() : startDraw());
  document.getElementById("ortho-clear-territory").addEventListener("click", () => {
    clearTerritory(); save();
  });
  document.getElementById("ortho-import").addEventListener("click", () =>
    document.getElementById("ortho-file").click());
  document.getElementById("ortho-file").addEventListener("change", e => {
    if (e.target.files[0]) importGeoJSON(e.target.files[0]);
    e.target.value = "";
  });
  document.getElementById("add-street").addEventListener("click", () => addAtCenter("street"));
  document.getElementById("add-district").addEventListener("click", () => addAtCenter("district"));
  document.getElementById("add-metro").addEventListener("click", () => addAtCenter("metro"));
  document.getElementById("add-callout").addEventListener("click", () => addAtCenter("callout"));
  document.getElementById("add-stations").addEventListener("click", addStationsInView);
  document.getElementById("ortho-png").addEventListener("click", () =>
    exportPNG().catch(e => toast("Ошибка экспорта: " + e.message, 6000)));
  document.getElementById("ortho-pdf").addEventListener("click", () =>
    exportPDF().catch(e => toast("Ошибка экспорта PDF: " + e.message, 6000)));

  function addAtCenter(type) {
    ensureMap();
    addAnnotation({ type, latlng: map.getCenter() });
    save();
  }

  document.getElementById("ann-text").addEventListener("input", e => {
    if (!st.selected) return;
    st.selected.text = e.target.value; refreshIcon(st.selected); save();
  });
  document.getElementById("ann-size").addEventListener("input", e => {
    if (!st.selected) return;
    st.selected.size = +e.target.value;
    document.getElementById("ann-size-val").textContent = e.target.value;
    refreshIcon(st.selected); save();
  });
  document.getElementById("ann-rot").addEventListener("input", e => {
    if (!st.selected) return;
    st.selected.rot = +e.target.value;
    document.getElementById("ann-rot-val").textContent = e.target.value;
    refreshIcon(st.selected); save();
  });
  document.getElementById("ann-badges").addEventListener("input", e => {
    if (!st.selected || st.selected.type !== "metro") return;
    st.selected.badges = e.target.value.split(/[,;]+/).map(x => x.trim()).filter(Boolean);
    refreshIcon(st.selected); save();
  });
  document.getElementById("ann-delete").addEventListener("click", () => deleteAnn(st.selected));

  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { cancelDraw(); selectAnn(null); }
    if (e.key === "Delete" && st.selected &&
        !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) deleteAnn(st.selected);
  });

  return { onShow };
})();
