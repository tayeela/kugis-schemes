/* Схема расположения: Москва (округа) + округ (районы), розовая подсветка, выноска */
"use strict";

const Scheme = (() => {
  const W = 1600, H = 1131;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const svg = document.getElementById("scheme-svg-root");

  const st = {
    aoLabels: [],      // {text, x, y, size, bold}
    rayLabels: [],     // {text, x, y, size}
    markerL: null, markerR: null,   // {x,y}
    callout: null,     // {x,y,w,h}
    projL: null, projR: null,
    ready: false,
  };

  /* ---- проекция: равнопромежуточная с коррекцией широты, вписанная в прямоугольник ---- */
  function fitProjection(bbox, rect, pad = 0.04) {
    const [x0, y0, x1, y1] = bbox;
    const latK = Math.cos((y0 + y1) / 2 * Math.PI / 180);
    const w = (x1 - x0) * latK, h = (y1 - y0);
    const s = Math.min(rect.w * (1 - pad * 2) / w, rect.h * (1 - pad * 2) / h);
    const ox = rect.x + (rect.w - w * s) / 2, oy = rect.y + (rect.h + h * s) / 2;
    return ([lng, lat]) => [ox + (lng - x0) * latK * s, oy - (lat - y0) * s];
  }

  function ringsPath(geom, proj) {
    let d = "";
    for (const ring of geomRings(geom)) {
      d += ring.map((pt, i) => {
        const [x, y] = proj(pt);
        return (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
      }).join("") + "Z";
    }
    return d;
  }

  function el(tag, attrs, parent) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  const measureCtx = document.createElement("canvas").getContext("2d");

  /* Подбор положения и кегля подписи: полюс недоступности + горизонтальный просвет,
     чтобы текст целиком лежал внутри полигона и оставался горизонтальным. */
  function fitLabel(text, geom, proj, { min, max, weight, allowSplit = true }) {
    let best = null, bestA = -1;
    for (const r of geomOuterRings(geom)) {
      const pr = r.map(proj);
      let a = 0;
      for (let i = 0; i < pr.length - 1; i++) a += pr[i][0] * pr[i + 1][1] - pr[i + 1][0] * pr[i][1];
      a = Math.abs(a);
      if (a > bestA) { bestA = a; best = pr; }
    }
    const pole = poleOfInaccessibility(best);
    const parts = allowSplit ? splitLabel(text) : [text];
    measureCtx.font = `${weight} 100px ${App.FONT}`;
    const wf = Math.max(...parts.map(p => measureCtx.measureText(p).width)) / 100; // ширина на 1px кегля
    const clr = horizontalClearance(best, pole.x, pole.y);
    const availW = clr ? (clr[1] - clr[0]) : pole.d * 2;
    const x = clr ? (clr[0] + clr[1]) / 2 : pole.x;
    let size = availW * 0.88 / wf;
    size = Math.min(size, 2 * pole.d / (parts.length * 1.2)); // вертикальный габарит
    size = Math.max(min, Math.min(max, size));
    return { x, y: pole.y, size, parts };
  }

  /* ---- построение состояния под выбранный район ---- */
  function build(d) {
    const rectL = { x: 30, y: 40, w: 640, h: 900 };
    const rectR = { x: 740, y: 40, w: 830, h: 1000 };

    const allBBox = ringsBBox(App.okruga.features.flatMap(f => geomOuterRings(f.geometry)));
    st.projL = fitProjection(allBBox, rectL);

    const aoFeats = App.okruga.features.filter(f => f.properties.name === d.ao);
    const rayInAo = App.rayony.features.filter(f => f.properties.ao === d.ao);
    const aoBBox = ringsBBox(rayInAo.flatMap(f => geomOuterRings(f.geometry)));
    st.projR = fitProjection(aoBBox, rectR);

    const seen = new Set();
    st.aoLabels = [];
    for (const f of App.okruga.features) {
      const name = f.properties.name;
      if (seen.has(name)) continue;
      seen.add(name);
      const text = AO_FULL[name] || name;
      // позиция — полюс недоступности, кегль единый для всех округов
      const fit = fitLabel(text, f.geometry, st.projL,
        { min: 24, max: 24, weight: 600, allowSplit: false });
      st.aoLabels.push({ text, x: fit.x, y: fit.y, size: 24, parts: [text] });
    }

    st.rayLabels = rayInAo.map(f => {
      const text = fixYo(f.properties.name);
      const fit = fitLabel(text, f.geometry, st.projR, { min: 10, max: 16, weight: 500 });
      return { text, x: fit.x, y: fit.y, size: fit.size, parts: fit.parts };
    });

    const cD = featureCentroid(d.feature);
    st.markerL = { x: st.projL(cD)[0], y: st.projL(cD)[1] };
    st.markerR = { x: st.projR(cD)[0], y: st.projR(cD)[1] };
    st.callout = { x: W / 2, y: H - 90, w: 460, h: 96 };
    st.ready = true;
  }

  /* ---- отрисовка SVG ---- */
  function render() {
    if (!st.ready) return;
    const d = App.district;
    svg.innerHTML = "";
    el("rect", { x: 0, y: 0, width: W, height: H, fill: "#fff" }, svg);

    const line1 = document.getElementById("scheme-callout1").value;
    const line2 = document.getElementById("scheme-callout2").value;

    // ЛЕВОЕ ПАННО: районы тонко, округа жирнее, выбранный округ розовый
    const gL = el("g", {}, svg);
    for (const f of App.okruga.features.filter(x => x.properties.name === d.ao))
      el("path", { d: ringsPath(f.geometry, st.projL), fill: "var(--pink-fill)", stroke: "none", "fill-rule": "evenodd" }, gL);
    for (const f of App.rayony.features)
      el("path", { d: ringsPath(f.geometry, st.projL), fill: "none", stroke: "#999", "stroke-width": 0.6 }, gL);
    for (const f of App.okruga.features)
      el("path", { d: ringsPath(f.geometry, st.projL), fill: "none", stroke: "#1a1a1a", "stroke-width": 1.6, "stroke-linejoin": "round" }, gL);
    for (const f of App.okruga.features.filter(x => x.properties.name === d.ao))
      el("path", { d: ringsPath(f.geometry, st.projL), fill: "none", stroke: "var(--pink-stroke)", "stroke-width": 3 }, gL);

    // ПРАВОЕ ПАННО: соседние районы бледно + округ
    const gR = el("g", {}, svg);
    const clip = el("clipPath", { id: "clipR" }, svg);
    el("rect", { x: 740, y: 10, width: 850, height: H - 20 }, clip);
    gR.setAttribute("clip-path", "url(#clipR)");
    for (const f of App.rayony.features.filter(x => x.properties.ao !== d.ao))
      el("path", { d: ringsPath(f.geometry, st.projR), fill: "none", stroke: "#bbb", "stroke-width": 1 }, gR);
    for (const f of App.rayony.features.filter(x => x.properties.ao === d.ao)) {
      const isSel = f.properties.name === d.name;
      el("path", {
        d: ringsPath(f.geometry, st.projR),
        fill: isSel ? "var(--pink-fill)" : "#fff",
        stroke: "#1a1a1a", "stroke-width": 1.4, "fill-rule": "evenodd",
      }, gR);
    }
    for (const f of App.rayony.features.filter(x => x.properties.ao === d.ao && x.properties.name === d.name))
      el("path", { d: ringsPath(f.geometry, st.projR), fill: "none", stroke: "var(--pink-stroke)", "stroke-width": 3.5 }, gR);

    // выноска + пунктирные линии к точкам
    const c = st.callout;
    const boxX = c.x - c.w / 2, boxY = c.y - c.h / 2;
    const leader = (m, edgeX) => {
      const midY = c.y;
      return `M${m.x} ${m.y}L${m.x} ${midY}L${edgeX} ${midY}`;
    };
    el("path", { d: leader(st.markerL, boxX), fill: "none", stroke: "#1a1a1a", "stroke-width": 1.6, "stroke-dasharray": "7 5" }, svg);
    el("path", { d: leader(st.markerR, boxX + c.w), fill: "none", stroke: "#1a1a1a", "stroke-width": 1.6, "stroke-dasharray": "7 5" }, svg);

    // точки
    for (const [m, key] of [[st.markerL, "markerL"], [st.markerR, "markerR"]]) {
      el("circle", { cx: m.x, cy: m.y, r: 7, fill: "#111", class: "draggable", "data-drag": key }, svg);
    }

    // рамка выноски
    const gC = el("g", { class: "draggable", "data-drag": "callout" }, svg);
    el("rect", { x: boxX, y: boxY, width: c.w, height: c.h, fill: "#fff", stroke: "#1a1a1a", "stroke-width": 2 }, gC);
    el("text", { x: c.x, y: c.y - 12, "text-anchor": "middle", "font-size": 26, "font-family": App.FONT, fill: "#111" }, gC).textContent = line1;
    el("text", { x: c.x, y: c.y + 26, "text-anchor": "middle", "font-size": 28, "font-weight": 700, "font-family": App.FONT, fill: "#111" }, gC).textContent = line2;

    // подписи округов
    st.aoLabels.forEach((l, i) => {
      const t = el("text", {
        x: l.x, y: l.y, "text-anchor": "middle", "font-size": l.size,
        "font-family": App.FONT, "font-weight": 600, fill: "#111",
        stroke: "#fff", "stroke-width": 5, "paint-order": "stroke",
        class: "draggable", "data-drag": "ao:" + i,
      }, svg);
      t.textContent = l.text;
    });

    // подписи районов (две строки, если длинно)
    st.rayLabels.forEach((l, i) => {
      const t = el("text", {
        x: l.x, y: l.y, "text-anchor": "middle", "font-size": l.size,
        "font-family": App.FONT, "font-weight": 500, fill: "#111",
        stroke: "#fff", "stroke-width": 4, "paint-order": "stroke",
        class: "draggable", "data-drag": "ray:" + i,
      }, svg);
      const parts = l.parts || [l.text];
      parts.forEach((p, j) => {
        const ts = el("tspan", { x: l.x, dy: j === 0 ? (parts.length > 1 ? -l.size * 0.35 : 0) : l.size * 1.1 }, t);
        ts.textContent = p;
      });
    });
  }

  function splitLabel(text) {
    if (text.length <= 12 || !text.includes(" ")) return [text];
    const words = text.split(" ");
    let best = [text], bestDiff = Infinity;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(" "), b = words.slice(i).join(" ");
      const diff = Math.abs(a.length - b.length);
      if (diff < bestDiff) { bestDiff = diff; best = [a, b]; }
    }
    return best;
  }

  /* ---- перетаскивание ---- */
  let drag = null;
  svg.addEventListener("pointerdown", e => {
    const t = e.target.closest(".draggable");
    if (!t) return;
    const pt = svgPoint(e);
    drag = { key: t.getAttribute("data-drag"), sx: pt[0], sy: pt[1], orig: getPos(t.getAttribute("data-drag")) };
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  svg.addEventListener("pointermove", e => {
    if (!drag) return;
    const pt = svgPoint(e);
    setPos(drag.key, drag.orig.x + pt[0] - drag.sx, drag.orig.y + pt[1] - drag.sy);
    render();
  });
  svg.addEventListener("pointerup", () => drag = null);

  function svgPoint(e) {
    const r = svg.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width * W, (e.clientY - r.top) / r.height * H];
  }
  function getPos(key) {
    if (key === "callout") return { x: st.callout.x, y: st.callout.y };
    if (key === "markerL") return st.markerL;
    if (key === "markerR") return st.markerR;
    const [kind, i] = key.split(":");
    const l = (kind === "ao" ? st.aoLabels : st.rayLabels)[+i];
    return { x: l.x, y: l.y };
  }
  function setPos(key, x, y) {
    if (key === "callout") { st.callout.x = x; st.callout.y = y; return; }
    if (key === "markerL") { st.markerL = { x, y }; return; }
    if (key === "markerR") { st.markerR = { x, y }; return; }
    const [kind, i] = key.split(":");
    const l = (kind === "ao" ? st.aoLabels : st.rayLabels)[+i];
    l.x = x; l.y = y;
  }

  /* ---- экспорт ---- */
  async function exportPNG() {
    await document.fonts.ready;
    const k = +document.getElementById("scheme-scale").value;
    const canvas = document.createElement("canvas");
    canvas.width = W * k; canvas.height = H * k;
    const ctx = canvas.getContext("2d");
    ctx.scale(k, k);
    drawToCanvas(ctx);
    canvas.toBlob(b => downloadBlob(b, fileBase() + ".png"), "image/png");
  }

  function drawToCanvas(ctx) {
    const d = App.district;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    const CSS = getComputedStyle(document.documentElement);
    const PINK = CSS.getPropertyValue("--pink-fill").trim(), PSTROKE = CSS.getPropertyValue("--pink-stroke").trim();

    const path = (geom, proj) => {
      const p = new Path2D();
      for (const ring of geomRings(geom)) {
        ring.forEach((pt, i) => {
          const [x, y] = proj(pt);
          i ? p.lineTo(x, y) : p.moveTo(x, y);
        });
        p.closePath();
      }
      return p;
    };
    const stroke = (p, col, w) => { ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineJoin = "round"; ctx.stroke(p); };

    // левое панно
    for (const f of App.okruga.features.filter(x => x.properties.name === d.ao)) {
      ctx.fillStyle = PINK; ctx.fill(path(f.geometry, st.projL), "evenodd");
    }
    for (const f of App.rayony.features) stroke(path(f.geometry, st.projL), "#999", 0.6);
    for (const f of App.okruga.features) stroke(path(f.geometry, st.projL), "#1a1a1a", 1.6);
    for (const f of App.okruga.features.filter(x => x.properties.name === d.ao))
      stroke(path(f.geometry, st.projL), PSTROKE, 3);

    // правое панно (клип)
    ctx.save();
    ctx.beginPath(); ctx.rect(740, 10, 850, H - 20); ctx.clip();
    for (const f of App.rayony.features.filter(x => x.properties.ao !== d.ao))
      stroke(path(f.geometry, st.projR), "#bbb", 1);
    for (const f of App.rayony.features.filter(x => x.properties.ao === d.ao)) {
      const p = path(f.geometry, st.projR);
      ctx.fillStyle = f.properties.name === d.name ? PINK : "#fff";
      ctx.fill(p, "evenodd"); stroke(p, "#1a1a1a", 1.4);
    }
    for (const f of App.rayony.features.filter(x => x.properties.ao === d.ao && x.properties.name === d.name))
      stroke(path(f.geometry, st.projR), PSTROKE, 3.5);
    ctx.restore();

    // выноска и линии
    const c = st.callout, boxX = c.x - c.w / 2, boxY = c.y - c.h / 2;
    ctx.setLineDash([7, 5]); ctx.strokeStyle = "#1a1a1a"; ctx.lineWidth = 1.6;
    for (const [m, ex] of [[st.markerL, boxX], [st.markerR, boxX + c.w]]) {
      ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x, c.y); ctx.lineTo(ex, c.y); ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const m of [st.markerL, st.markerR]) {
      ctx.beginPath(); ctx.arc(m.x, m.y, 7, 0, Math.PI * 2); ctx.fillStyle = "#111"; ctx.fill();
    }
    ctx.fillStyle = "#fff"; ctx.fillRect(boxX, boxY, c.w, c.h);
    ctx.strokeStyle = "#1a1a1a"; ctx.lineWidth = 2; ctx.strokeRect(boxX, boxY, c.w, c.h);
    ctx.textAlign = "center"; ctx.fillStyle = "#111";
    ctx.font = `26px ${App.FONT}`;
    ctx.fillText(document.getElementById("scheme-callout1").value, c.x, c.y - 12);
    ctx.font = `700 28px ${App.FONT}`;
    ctx.fillText(document.getElementById("scheme-callout2").value, c.x, c.y + 26);

    // подписи
    const halo = (text, x, y) => {
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 5; ctx.lineJoin = "round";
      ctx.strokeText(text, x, y); ctx.fillText(text, x, y);
    };
    ctx.fillStyle = "#111";
    for (const l of st.aoLabels) { ctx.font = `600 ${l.size}px ${App.FONT}`; halo(l.text, l.x, l.y); }
    for (const l of st.rayLabels) {
      ctx.font = `500 ${l.size}px ${App.FONT}`;
      const parts = l.parts || [l.text];
      parts.forEach((p, j) => {
        const dy = parts.length > 1 ? (j === 0 ? -l.size * 0.35 : l.size * 0.75) : 0;
        halo(p, l.x, l.y + dy);
      });
    }
  }

  function exportSVG() {
    const clone = svg.cloneNode(true);
    clone.setAttribute("width", W); clone.setAttribute("height", H);
    // заменить CSS-переменные на литеральные цвета
    const CSS = getComputedStyle(document.documentElement);
    let src = new XMLSerializer().serializeToString(clone);
    src = src.replaceAll("var(--pink-fill)", CSS.getPropertyValue("--pink-fill").trim());
    src = src.replaceAll("var(--pink-stroke)", CSS.getPropertyValue("--pink-stroke").trim());
    downloadBlob(new Blob([src], { type: "image/svg+xml" }), fileBase() + ".svg");
  }

  function fileBase() {
    return "Схема расположения — " + (App.district ? App.district.display : "район");
  }

  function downloadBlob(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /* ---- события ---- */
  App.onDistrictChange.push(d => {
    document.getElementById("scheme-name").value = d.display;
    document.getElementById("scheme-callout2").value = "район " + d.display;
    build(d); render();
  });
  document.getElementById("scheme-name").addEventListener("input", e => {
    if (App.district) {
      App.district.display = e.target.value;
      document.getElementById("scheme-callout2").value = "район " + e.target.value;
      render();
    }
  });
  ["scheme-callout1", "scheme-callout2"].forEach(id =>
    document.getElementById(id).addEventListener("input", render));
  document.getElementById("scheme-png").addEventListener("click", exportPNG);
  document.getElementById("scheme-svg").addEventListener("click", exportSVG);
  document.getElementById("scheme-reset").addEventListener("click", () => { build(App.district); render(); });

  return { render };
})();
