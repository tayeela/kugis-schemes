/* Схема расположения: Москва (округа) + округ (районы), розовая подсветка, выноска.
   Подписи редактируемые: текст, кегль, поворот, перетаскивание. */
"use strict";

const Scheme = (() => {
  const W = 1600, H = 1131;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const svg = document.getElementById("scheme-svg-root");

  const st = {
    labels: [],        // {kind:'ao'|'ray'|'custom', text, x, y, size, rot, parts, weight}
    sel: -1,           // индекс выбранной подписи
    markerL: null, markerR: null,
    callout: null,     // {x,y,w,h}
    projL: null, projR: null,
    paths: null,       // кэш SVG-путей в текущих проекциях
    naturePathR: null,
    ready: false,
  };

  /* ---- проекция, вписанная в прямоугольник ---- */
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

  /* ---- подбор подписи: полюс недоступности + горизонтальный просвет ---- */
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
    const wf = Math.max(...parts.map(p => measureCtx.measureText(p).width)) / 100;
    const clr = horizontalClearance(best, pole.x, pole.y);
    const availW = clr ? (clr[1] - clr[0]) : pole.d * 2;
    const x = clr ? (clr[0] + clr[1]) / 2 : pole.x;
    let size = availW * 0.88 / wf;
    size = Math.min(size, 2 * pole.d / (parts.length * 1.2));
    size = Math.max(min, Math.min(max, size));
    return { x, y: pole.y, size, parts, areaPx: bestA / 2 };
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

  /* ---- раздвижка пересекающихся подписей ---- */
  function labelBox(l) {
    measureCtx.font = `${l.weight} ${l.size}px ${App.FONT}`;
    const w = Math.max(...l.parts.map(p => measureCtx.measureText(p).width)) + 6;
    const h = l.size * 1.25 * l.parts.length + 4;
    return { x0: l.x - w / 2, y0: l.y - h / 2, x1: l.x + w / 2, y1: l.y + h / 2, w, h };
  }
  function resolveOverlaps(labels) {
    for (let it = 0; it < 30; it++) {
      let moved = false;
      for (let i = 0; i < labels.length; i++)
        for (let j = i + 1; j < labels.length; j++) {
          const a = labelBox(labels[i]), b = labelBox(labels[j]);
          const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
          const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
          if (ox <= 0 || oy <= 0) continue;
          moved = true;
          if (ox < oy) {
            const dir = labels[i].x <= labels[j].x ? 1 : -1;
            labels[i].x -= dir * (ox / 2 + 1); labels[j].x += dir * (ox / 2 + 1);
          } else {
            const dir = labels[i].y <= labels[j].y ? 1 : -1;
            labels[i].y -= dir * (oy / 2 + 1); labels[j].y += dir * (oy / 2 + 1);
          }
        }
      if (!moved) break;
    }
  }

  /* ---- построение под выбранный район ---- */
  function build(d) {
    const rectL = { x: 30, y: 40, w: 640, h: 900 };
    const rectR = { x: 740, y: 40, w: 830, h: 1000 };

    const allBBox = ringsBBox(App.okruga.features.flatMap(f => geomOuterRings(f.geometry)));
    st.projL = fitProjection(allBBox, rectL);
    const rayInAo = App.rayony.features.filter(f => f.properties.ao === d.ao);
    st.projR = fitProjection(ringsBBox(rayInAo.flatMap(f => geomOuterRings(f.geometry))), rectR);

    // кэш путей (данные тяжёлые — пересчитываем только при смене района)
    st.paths = {
      aoL: App.okruga.features.map(f => ({ name: f.properties.name, d: ringsPath(f.geometry, st.projL) })),
      rayL: App.rayony.features.map(f => ringsPath(f.geometry, st.projL)),
      rayR: App.rayony.features.map(f => ({
        ao: f.properties.ao, name: f.properties.name, d: ringsPath(f.geometry, st.projR),
      })),
      aoSelR: App.okruga.features.filter(x => x.properties.name === d.ao)
        .map(f => ringsPath(f.geometry, st.projR)),
    };
    buildNaturePaths();

    // подписи
    st.labels = [];
    const seen = new Set();
    for (const f of App.okruga.features) {
      const name = f.properties.name;
      if (seen.has(name)) continue;
      seen.add(name);
      const text = AO_FULL[name] || name; // Новомосковский АО и Троицкий АО — полностью
      const fit = fitLabel(text, f.geometry, st.projL, { min: 18, max: 18, weight: 600, allowSplit: false });
      st.labels.push({ kind: "ao", text, x: fit.x, y: fit.y, size: 18, rot: 0, parts: [text], weight: 600 });
    }
    for (const f of rayInAo) {
      const text = fixYo(f.properties.name);
      const fit = fitLabel(text, f.geometry, st.projR, { min: 15, max: 15, weight: 500 });
      st.labels.push({ kind: "ray", text: fit.parts.join("\n"), x: fit.x, y: fit.y, size: 15, rot: 0, parts: fit.parts, weight: 500 });
    }
    for (const f of App.rayony.features.filter(x => x.properties.ao !== d.ao)) {
      const text = fixYo(f.properties.name);
      const fit = fitLabel(text, f.geometry, st.projR, { min: 15, max: 15, weight: 500 });
      if (fit.areaPx < 4500) continue; // мелкие на этом масштабе не подписываем
      if (fit.x < 750 || fit.x > 1585 || fit.y < 20 || fit.y > H - 20) continue;
      st.labels.push({ kind: "ray", text: fit.parts.join("\n"), x: fit.x, y: fit.y, size: 15, rot: 0, parts: fit.parts, weight: 500 });
    }
    resolveOverlaps(st.labels.filter(l => l.kind === "ao"));
    resolveOverlaps(st.labels.filter(l => l.kind === "ray"));

    const cD = featureCentroid(d.feature);
    st.markerL = { x: st.projL(cD)[0], y: st.projL(cD)[1] };
    st.markerR = { x: st.projR(cD)[0], y: st.projR(cD)[1] };
    st.callout = { x: W / 2, y: H - 90, w: 460, h: 96 };
    st.sel = -1;
    updateLabelPanel();
    st.ready = true;
  }

  function buildNaturePaths() {
    st.naturePathR = null;
    if (!App.nature || !st.projR) return;
    let w = "", r = "", pk = "";
    for (const f of App.nature.features) {
      const p = ringsPath(f.geometry, st.projR);
      const t = f.properties.t;
      if (t === "w") w += p;
      else if (t === "p") pk += p;
      else r += p;
    }
    st.naturePathR = { w, r, p: pk };
  }

  App.onNatureLoaded.push(() => {
    if (st.ready) { buildNaturePaths(); render(); }
  });

  /* ---- отрисовка SVG ---- */
  function render() {
    if (!st.ready) return;
    const d = App.district;
    svg.innerHTML = "";
    el("rect", { x: 0, y: 0, width: W, height: H, fill: "#fff" }, svg);

    const line1 = document.getElementById("scheme-callout1").value;
    const line2 = document.getElementById("scheme-callout2").value;

    // ЛЕВОЕ ПАННО
    const gL = el("g", {}, svg);
    for (const p of st.paths.aoL.filter(x => x.name === d.ao))
      el("path", { d: p.d, fill: "var(--pink-fill)", stroke: "none", "fill-rule": "evenodd" }, gL);
    for (const p of st.paths.rayL)
      el("path", { d: p, fill: "none", stroke: "#999", "stroke-width": 0.6 }, gL);
    for (const p of st.paths.aoL)
      el("path", { d: p.d, fill: "none", stroke: "#1a1a1a", "stroke-width": 1.6, "stroke-linejoin": "round" }, gL);
    for (const p of st.paths.aoL.filter(x => x.name === d.ao))
      el("path", { d: p.d, fill: "none", stroke: "var(--pink-stroke)", "stroke-width": 3 }, gL);

    // ПРАВОЕ ПАННО
    const gR = el("g", {}, svg);
    const clip = el("clipPath", { id: "clipR" }, svg);
    el("rect", { x: 740, y: 10, width: 850, height: H - 20 }, clip);
    gR.setAttribute("clip-path", "url(#clipR)");
    for (const p of st.paths.rayR)
      el("path", { d: p.d, fill: "#fff", stroke: "none", "fill-rule": "evenodd" }, gR);
    // зелень и вода — только в границах выбранного округа
    if (st.naturePathR) {
      const clipAO = el("clipPath", { id: "clipAO" }, svg);
      for (const p of st.paths.aoSelR) el("path", { d: p, "clip-rule": "evenodd" }, clipAO);
      const gN = el("g", { "clip-path": "url(#clipAO)" }, gR);
      if (st.naturePathR.p) el("path", { d: st.naturePathR.p, fill: "var(--park)", stroke: "none" }, gN);
      if (st.naturePathR.w) el("path", { d: st.naturePathR.w, fill: "var(--wood)", stroke: "none" }, gN);
      if (st.naturePathR.r) el("path", { d: st.naturePathR.r, fill: "var(--water)", stroke: "none" }, gN);
    }
    for (const p of st.paths.rayR.filter(x => x.ao !== d.ao))
      el("path", { d: p.d, fill: "none", stroke: "#1a1a1a", "stroke-width": 0.9 }, gR);
    for (const p of st.paths.rayR.filter(x => x.ao === d.ao))
      el("path", { d: p.d, fill: "none", stroke: "#1a1a1a", "stroke-width": 1.6 }, gR);
    for (const p of st.paths.rayR.filter(x => x.ao === d.ao && x.name === d.name))
      el("path", {
        d: p.d, fill: "var(--pink-fill)", "fill-opacity": 0.55,
        stroke: "var(--pink-stroke)", "stroke-width": 3.5, "fill-rule": "evenodd",
      }, gR);

    // выноска + пунктирные линии
    const c = st.callout;
    const boxX = c.x - c.w / 2, boxY = c.y - c.h / 2;
    for (const [m, ex] of [[st.markerL, boxX], [st.markerR, boxX + c.w]])
      el("path", {
        d: `M${m.x} ${m.y}L${m.x} ${c.y}L${ex} ${c.y}`,
        fill: "none", stroke: "#1a1a1a", "stroke-width": 1.6, "stroke-dasharray": "7 5",
      }, svg);
    for (const [m, key] of [[st.markerL, "markerL"], [st.markerR, "markerR"]])
      el("circle", { cx: m.x, cy: m.y, r: 7, fill: "#111", class: "draggable", "data-drag": key }, svg);

    const gC = el("g", { class: "draggable", "data-drag": "callout" }, svg);
    el("rect", { x: boxX, y: boxY, width: c.w, height: c.h, fill: "#fff", stroke: "#1a1a1a", "stroke-width": 2 }, gC);
    el("text", { x: c.x, y: c.y - 12, "text-anchor": "middle", "font-size": 26, "font-family": App.FONT, fill: "#111" }, gC).textContent = line1;
    el("text", { x: c.x, y: c.y + 26, "text-anchor": "middle", "font-size": 28, "font-weight": 700, "font-family": App.FONT, fill: "#111" }, gC).textContent = line2;

    // подписи
    st.labels.forEach((l, i) => {
      const attrs = {
        x: l.x, y: l.y, "text-anchor": "middle", "font-size": l.size,
        "font-family": App.FONT, "font-weight": l.weight, fill: "#111",
        stroke: "#fff", "stroke-width": l.kind === "ao" ? 5 : 4, "paint-order": "stroke",
        class: "draggable", "data-drag": "lb:" + i,
      };
      if (l.rot) attrs.transform = `rotate(${l.rot} ${l.x} ${l.y})`;
      const t = el("text", attrs, svg);
      l.parts.forEach((p, j) => {
        const ts = el("tspan", { x: l.x, dy: j === 0 ? (l.parts.length > 1 ? -l.size * 0.35 * (l.parts.length - 1) : 0) : l.size * 1.1 }, t);
        ts.textContent = p;
      });
      if (i === st.sel) {
        const b = labelBox(l);
        el("rect", {
          x: b.x0, y: b.y0, width: b.w, height: b.h,
          fill: "none", stroke: "#0f6fd6", "stroke-width": 1.5, "stroke-dasharray": "5 4",
          transform: l.rot ? `rotate(${l.rot} ${l.x} ${l.y})` : "",
        }, svg);
      }
    });
  }

  /* ---- перетаскивание и выбор ---- */
  let drag = null;
  svg.addEventListener("pointerdown", e => {
    const t = e.target.closest(".draggable");
    if (!t) { selectLabel(-1); return; }
    const key = t.getAttribute("data-drag");
    if (key.startsWith("lb:")) selectLabel(+key.slice(3));
    const pt = svgPoint(e);
    drag = { key, sx: pt[0], sy: pt[1], orig: getPos(key) };
    try { svg.setPointerCapture(e.pointerId); } catch (err) {}
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
    const l = st.labels[+key.slice(3)];
    return { x: l.x, y: l.y };
  }
  function setPos(key, x, y) {
    if (key === "callout") { st.callout.x = x; st.callout.y = y; return; }
    if (key === "markerL") { st.markerL = { x, y }; return; }
    if (key === "markerR") { st.markerR = { x, y }; return; }
    const l = st.labels[+key.slice(3)];
    l.x = x; l.y = y;
  }

  /* ---- панель редактирования подписи ---- */
  function selectLabel(i) {
    st.sel = i;
    updateLabelPanel();
    render();
  }
  function updateLabelPanel() {
    const panel = document.getElementById("scheme-props");
    const l = st.labels[st.sel];
    panel.hidden = !l;
    if (!l) return;
    document.getElementById("slabel-text").value = l.text;
    document.getElementById("slabel-size").value = l.size;
    document.getElementById("slabel-size-val").textContent = Math.round(l.size);
    document.getElementById("slabel-rot").value = l.rot || 0;
    document.getElementById("slabel-rot-val").textContent = l.rot || 0;
  }
  document.getElementById("slabel-text").addEventListener("input", e => {
    const l = st.labels[st.sel];
    if (!l) return;
    l.text = e.target.value;
    l.parts = e.target.value.split("\n").filter(x => x !== "");
    if (!l.parts.length) l.parts = [" "];
    render();
  });
  document.getElementById("slabel-size").addEventListener("input", e => {
    const l = st.labels[st.sel];
    if (!l) return;
    l.size = +e.target.value;
    document.getElementById("slabel-size-val").textContent = e.target.value;
    render();
  });
  document.getElementById("slabel-rot").addEventListener("input", e => {
    const l = st.labels[st.sel];
    if (!l) return;
    l.rot = +e.target.value;
    document.getElementById("slabel-rot-val").textContent = e.target.value;
    render();
  });
  document.getElementById("slabel-delete").addEventListener("click", () => {
    if (st.sel < 0) return;
    st.labels.splice(st.sel, 1);
    selectLabel(-1);
  });
  document.getElementById("scheme-add-label").addEventListener("click", () => {
    st.labels.push({ kind: "custom", text: "Подпись", x: W / 2, y: H / 2, size: 16, rot: 0, parts: ["Подпись"], weight: 500 });
    selectLabel(st.labels.length - 1);
  });
  document.addEventListener("keydown", e => {
    if (!document.getElementById("panel-scheme").classList.contains("active")) return;
    if (e.key === "Delete" && st.sel >= 0 &&
        !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
      st.labels.splice(st.sel, 1);
      selectLabel(-1);
    }
  });

  /* ---- экспорт ---- */
  async function makeCanvas() {
    await document.fonts.ready;
    const spec = pageSpec("scheme") || { wpx: 3200, hpx: 2262, wmm: 420, hmm: 297 };
    const canvas = document.createElement("canvas");
    canvas.width = spec.wpx; canvas.height = spec.hpx;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, spec.wpx, spec.hpx);
    const k = Math.min(spec.wpx / W, spec.hpx / H);
    ctx.translate((spec.wpx - W * k) / 2, (spec.hpx - H * k) / 2);
    ctx.scale(k, k);
    drawToCanvas(ctx);
    return { canvas, spec };
  }
  async function exportPNG() {
    const { canvas } = await makeCanvas();
    canvas.toBlob(b => downloadBlob(b, fileBase() + ".png"), "image/png");
  }
  async function exportPDF() {
    await loadJsPDF();
    const { canvas, spec } = await makeCanvas();
    downloadPDF(canvas, spec.wmm, spec.hmm, fileBase() + ".pdf", true);
  }

  function drawToCanvas(ctx) {
    const d = App.district;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    const CSS = getComputedStyle(document.documentElement);
    const PINK = CSS.getPropertyValue("--pink-fill").trim(), PSTROKE = CSS.getPropertyValue("--pink-stroke").trim();
    const stroke = (p, col, w) => { ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineJoin = "round"; ctx.stroke(p); };
    const P2 = s => new Path2D(s);

    // левое панно
    for (const p of st.paths.aoL.filter(x => x.name === d.ao)) {
      ctx.fillStyle = PINK; ctx.fill(P2(p.d), "evenodd");
    }
    for (const p of st.paths.rayL) stroke(P2(p), "#999", 0.6);
    for (const p of st.paths.aoL) stroke(P2(p.d), "#1a1a1a", 1.6);
    for (const p of st.paths.aoL.filter(x => x.name === d.ao)) stroke(P2(p.d), PSTROKE, 3);

    // правое панно (клип по панели)
    ctx.save();
    ctx.beginPath(); ctx.rect(740, 10, 850, H - 20); ctx.clip();
    for (const p of st.paths.rayR) { ctx.fillStyle = "#fff"; ctx.fill(P2(p.d), "evenodd"); }
    if (st.naturePathR) {
      ctx.save();
      const clipAO = new Path2D();
      for (const p of st.paths.aoSelR) clipAO.addPath(P2(p));
      ctx.clip(clipAO, "evenodd");
      if (st.naturePathR.p) { ctx.fillStyle = CSS.getPropertyValue("--park").trim(); ctx.fill(P2(st.naturePathR.p), "nonzero"); }
      if (st.naturePathR.w) { ctx.fillStyle = CSS.getPropertyValue("--wood").trim(); ctx.fill(P2(st.naturePathR.w), "nonzero"); }
      if (st.naturePathR.r) { ctx.fillStyle = CSS.getPropertyValue("--water").trim(); ctx.fill(P2(st.naturePathR.r), "nonzero"); }
      ctx.restore();
    }
    for (const p of st.paths.rayR.filter(x => x.ao !== d.ao)) stroke(P2(p.d), "#1a1a1a", 0.9);
    for (const p of st.paths.rayR.filter(x => x.ao === d.ao)) stroke(P2(p.d), "#1a1a1a", 1.6);
    for (const p of st.paths.rayR.filter(x => x.ao === d.ao && x.name === d.name)) {
      const pp = P2(p.d);
      ctx.globalAlpha = 0.55; ctx.fillStyle = PINK; ctx.fill(pp, "evenodd"); ctx.globalAlpha = 1;
      stroke(pp, PSTROKE, 3.5);
    }
    ctx.restore();

    // выноска и пунктиры
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

    // подписи (с поворотом)
    for (const l of st.labels) {
      ctx.save();
      ctx.translate(l.x, l.y);
      if (l.rot) ctx.rotate(l.rot * Math.PI / 180);
      ctx.font = `${l.weight} ${l.size}px ${App.FONT}`;
      ctx.fillStyle = "#111";
      const n = l.parts.length;
      l.parts.forEach((p, j) => {
        const dy = n > 1 ? (j - (n - 1) / 2) * l.size * 1.1 : 0;
        ctx.strokeStyle = "#fff"; ctx.lineWidth = l.kind === "ao" ? 5 : 4; ctx.lineJoin = "round";
        ctx.strokeText(p, 0, dy);
        ctx.fillText(p, 0, dy);
      });
      ctx.restore();
    }
  }

  function exportSVG() {
    const wasSel = st.sel;
    st.sel = -1; render();
    const clone = svg.cloneNode(true);
    st.sel = wasSel; render();
    clone.setAttribute("width", W); clone.setAttribute("height", H);
    const CSS = getComputedStyle(document.documentElement);
    let src = new XMLSerializer().serializeToString(clone);
    for (const v of ["pink-fill", "pink-stroke", "wood", "park", "water"])
      src = src.replaceAll(`var(--${v})`, CSS.getPropertyValue("--" + v).trim());
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
  document.getElementById("scheme-png").addEventListener("click", () =>
    exportPNG().catch(e => toast("Ошибка экспорта: " + e.message, 6000)));
  document.getElementById("scheme-pdf").addEventListener("click", () =>
    exportPDF().catch(e => toast("Ошибка экспорта PDF: " + e.message, 6000)));
  document.getElementById("scheme-svg").addEventListener("click", exportSVG);
  document.getElementById("scheme-reset").addEventListener("click", () => { build(App.district); render(); });

  return { render };
})();
