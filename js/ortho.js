/* Ортофотоплан: спутник Esri + маска района + территория + подписи + экспорт PNG */
"use strict";

const Ortho = (() => {
  const TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  const ATTR = "Esri World Imagery — Esri, Maxar, Earthstar Geographics";

  let map = null, inited = false;
  const st = {
    maskLayer: null, edgeLayer: null,
    territory: null,          // {latlngs:[[lat,lng],..], layer, areaM2}
    annotations: [],          // {id,type,latlng,text,size,rot,badges,marker,leaderTo,leaderLayer}
    selected: null,
    drawing: null,            // {pts, line, dots}
    nextId: 1,
  };

  /* ================= карта ================= */
  function ensureMap() {
    if (inited) return;
    inited = true;
    map = L.map("map", { center: [55.75, 37.62], zoom: 11, maxZoom: 20 });
    L.tileLayer(TILE_URL, { maxZoom: 20, maxNativeZoom: 19, attribution: ATTR }).addTo(map);
    map.on("click", onMapClick);
    map.on("dblclick", onMapDblClick);
    if (App.district) applyDistrict(App.district);
    restore();
  }
  function onShow() { ensureMap(); setTimeout(() => map.invalidateSize(), 50); }

  function applyDistrict(d, keepView) {
    if (!inited) return;
    if (st.maskLayer) { map.removeLayer(st.maskLayer); st.maskLayer = null; }
    if (st.edgeLayer) { map.removeLayer(st.edgeLayer); st.edgeLayer = null; }
    const rings = geomRings(d.feature.geometry).map(r => r.map(([x, y]) => [y, x]));
    const world = [[85, -180], [85, 180], [-85, 180], [-85, -180]];
    st.maskLayer = L.polygon([world, ...rings], {
      stroke: false, fillColor: "#fff", fillOpacity: 0.55, interactive: false,
    }).addTo(map);
    st.edgeLayer = L.polygon(rings, {
      color: "#fff", weight: 2.5, fill: false, interactive: false,
    }).addTo(map);
    if (!keepView) map.fitBounds(L.latLngBounds(rings.flat()), { padding: [30, 30] });
  }

  App.onDistrictChange.push(d => {
    if (!inited) return;
    const saved = readSaved();
    clearAll(false);
    applyDistrict(d);
    if (saved && saved.district === d.ao + "|" + d.name) restoreState(saved);
  });

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
    // двойной клик добавляет 2 лишних клика в ту же точку
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

  /* ================= аннотации ================= */
  function magenta() { return getComputedStyle(document.documentElement).getPropertyValue("--magenta").trim(); }

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
      const badges = (a.badges || []).map(b => `<span class="m-badge b${b}">${b}</span>`).join("");
      inner = `<div class="m-row"><span class="m-logo">М</span>${badges}</div><div class="m-name">${esc(a.text)}</div>`;
    } else {
      inner = esc(a.text).replaceAll("\n", "<br>");
    }
    const sel = st.selected === a ? " selected" : "";
    const html =
      `<div class="ann ann-${a.type}${sel}" style="font-size:${a.size}px;transform:translate(-50%,-50%)${rot}">` +
      `<div class="ann-inner">${inner}</div></div>`;
    return L.divIcon({ className: "ann-wrap", html, iconSize: [0, 0] });
  }
  function esc(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;"); }

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
    document.querySelectorAll(".badge-cb").forEach(cb => cb.checked = (a.badges || []).includes(cb.value));
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
    const b = map.getBounds();
    let n = 0;
    for (const f of App.stations.features) {
      const [lng, lat] = f.geometry.coordinates;
      if (!b.contains([lat, lng])) continue;
      const line = f.properties.line;
      addAnnotation({
        type: "metro", latlng: { lat, lng }, text: f.properties.name,
        badges: [line === "МЦК" ? "МЦК" : "D2"], size: 14,
      });
      n++;
    }
    selectAnn(null);
    toast(n ? `Добавлено станций: ${n}` : "В текущем кадре станций МЦК/МЦД-2 нет");
    save();
  }

  /* ================= сохранение ================= */
  const LS_KEY = "kugis-ortho-v1";
  function save() {
    if (!App.district) return;
    const data = {
      district: App.district.ao + "|" + App.district.name,
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
    if (saved && App.district && saved.district === App.district.ao + "|" + App.district.name)
      restoreState(saved);
  }
  function restoreState(saved) {
    if (saved.territory) setTerritory(saved.territory, true);
    for (const a of saved.annotations || []) addAnnotation(a);
    selectAnn(null);
  }

  /* ================= экспорт PNG ================= */
  function projPx(lat, lng, z) {
    const n = 256 * Math.pow(2, z);
    const x = (lng + 180) / 360 * n;
    const s = Math.sin(lat * Math.PI / 180);
    const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
    return [x, y];
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

  async function exportPNG() {
    ensureMap();
    await document.fonts.ready;
    const dz = { "1": 0, "2": 1, "3": 2 }[document.getElementById("ortho-scale").value];
    const z = Math.round(map.getZoom());
    const zE = Math.min(z + dz, 19);
    const s = Math.pow(2, zE - z);
    const b = map.getBounds();
    const [x0, y0] = projPx(b.getNorth(), b.getWest(), zE);
    const [x1, y1] = projPx(b.getSouth(), b.getEast(), zE);
    const W = Math.round(x1 - x0), H = Math.round(y1 - y0);
    if (W * H > 64e6) { toast("Слишком большой экспорт — уменьшите детализацию или окно"); return; }
    toast("Собираю тайлы…", 60000);

    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#e8e6e0"; ctx.fillRect(0, 0, W, H);

    const t0x = Math.floor(x0 / 256), t1x = Math.floor(x1 / 256);
    const t0y = Math.floor(y0 / 256), t1y = Math.floor(y1 / 256);
    const jobs = [];
    for (let tx = t0x; tx <= t1x; tx++)
      for (let ty = t0y; ty <= t1y; ty++)
        jobs.push(loadTile(TILE_URL.replace("{z}", zE).replace("{x}", tx).replace("{y}", ty))
          .then(im => { if (im) ctx.drawImage(im, Math.round(tx * 256 - x0), Math.round(ty * 256 - y0)); }));
    await Promise.all(jobs);

    const P = (latlng) => {
      const ll = Array.isArray(latlng) ? { lat: latlng[0], lng: latlng[1] } : latlng;
      const [x, y] = projPx(ll.lat, ll.lng, zE);
      return [x - x0, y - y0];
    };

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
      // белая кромка района
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2.5 * s; ctx.lineJoin = "round";
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
    for (const a of st.annotations) drawAnnOnCanvas(ctx, a, P, s);

    // атрибуция
    ctx.font = `${11 * s}px 'Golos Text', Arial`;
    ctx.textAlign = "right"; ctx.textBaseline = "bottom";
    ctx.lineWidth = 3 * s; ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineJoin = "round";
    ctx.strokeText(ATTR, W - 8 * s, H - 6 * s);
    ctx.fillStyle = "#333"; ctx.fillText(ATTR, W - 8 * s, H - 6 * s);

    canvas.toBlob(blob => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "Ортофотоплан — " + (App.district ? App.district.display : "территория") + ".png";
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast("Готово");
    }, "image/png");
  }

  function drawAnnOnCanvas(ctx, a, P, s) {
    const [x, y] = P(a.latlng);
    const size = a.size * s;
    ctx.save();
    ctx.translate(x, y);
    if (a.rot && a.type !== "metro") ctx.rotate(a.rot * Math.PI / 180);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";

    if (a.type === "street") {
      ctx.font = `600 ${size}px 'Golos Text', Arial`;
      drawHaloLines(ctx, a.text, size, "#1a1a1a", "#fff", size * 0.3);
    } else if (a.type === "district") {
      ctx.font = `700 ${size}px 'Golos Text', Arial`;
      try { ctx.letterSpacing = (size * 0.14) + "px"; } catch (e) {}
      ctx.shadowColor = "rgba(0,0,0,.85)"; ctx.shadowBlur = 4 * s;
      drawHaloLines(ctx, a.text.toUpperCase(), size, "#fff", "rgba(0,0,0,.75)", size * 0.16);
      ctx.shadowBlur = 0;
      try { ctx.letterSpacing = "0px"; } catch (e) {}
    } else if (a.type === "callout") {
      ctx.font = `600 ${size}px 'Golos Text', Arial`;
      const lines = (a.text || "").split("\n");
      const tw = Math.max(...lines.map(l => ctx.measureText(l).width));
      const lh = size * 1.35;
      const w = tw + size * 1.8, h = lines.length * lh + size * 0.9;
      ctx.fillStyle = "#fff"; ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeStyle = magenta(); ctx.lineWidth = 2.5 * s;
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      ctx.fillStyle = "#111";
      lines.forEach((l, i) => ctx.fillText(l, 0, (i - (lines.length - 1) / 2) * lh));
    } else if (a.type === "metro") {
      // ряд: [М][бейджи], ниже — название
      ctx.font = `700 ${size}px 'Golos Text', Arial`;
      const items = [{ txt: "М", bg: "#d6083b" }].concat((a.badges || []).map(bd => ({
        txt: bd, bg: { D1: "#f2a03d", D2: "#e84393", D3: "#e8703d", D4: "#159e8c", "МЦК": "#d6083b" }[bd] || "#888",
      })));
      const bh = size * 1.35, gap = size * 0.25, r = size * 0.2;
      const widths = items.map(it => ctx.measureText(it.txt).width + size * 0.6);
      const total = widths.reduce((p, c) => p + c, 0) + gap * (items.length - 1);
      let cx = -total / 2;
      const rowY = -size * 0.55;
      items.forEach((it, i) => {
        ctx.fillStyle = it.bg;
        roundRect(ctx, cx, rowY - bh / 2, widths[i], bh, r);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.fillText(it.txt, cx + widths[i] / 2, rowY + size * 0.05);
        cx += widths[i] + gap;
      });
      const nameY = size * 0.75;
      ctx.font = `700 ${size}px 'Golos Text', Arial`;
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
  document.querySelectorAll(".badge-cb").forEach(cb => cb.addEventListener("change", () => {
    if (!st.selected) return;
    st.selected.badges = [...document.querySelectorAll(".badge-cb:checked")].map(x => x.value);
    refreshIcon(st.selected); save();
  }));
  document.getElementById("ann-delete").addEventListener("click", () => deleteAnn(st.selected));

  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { cancelDraw(); selectAnn(null); }
    if (e.key === "Delete" && st.selected &&
        !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) deleteAnn(st.selected);
  });

  return { onShow };
})();
