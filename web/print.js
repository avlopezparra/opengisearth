// OpenGISEarth — diseño de impresión (PDF/PNG), exportación del mapa a SVG vectorial e importación de trazados SVG.
(() => {
  const C = Cesium, { viewer, geo, $ } = OGE;
  const PAPER = { A4: [297, 210], A3: [420, 297], Carta: [279.4, 215.9] }; // mm, horizontal
  const xml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const visible = () => geo.groups().filter((d) => d.show && d.entities.values.length);
  const colorOf = (ds) => { const f = geo.features(ds)[0], s = f ? f.oge.style : {}; return s.fill || s.stroke || s.color || '#ffd400'; };

  // ---------- PDF mínimo de una página con una imagen JPEG (sin librerías) ----------
  function pdf(jpeg, wPx, hPx, wPt, hPt) {
    const enc = new TextEncoder(), parts = [], offs = [];
    let len = 0;
    const push = (d) => { const b = typeof d === 'string' ? enc.encode(d) : d; parts.push(b); len += b.length; };
    const obj = (n, body) => { offs[n] = len; push(`${n} 0 obj\n${body}\nendobj\n`); };
    push('%PDF-1.4\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
    offs[4] = len;
    push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${wPx} /Height ${hPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
    push(jpeg); push('\nendstream\nendobj\n');
    const c = `q ${wPt} 0 0 ${hPt} 0 0 cm /Im0 Do Q`;
    obj(5, `<< /Length ${c.length} >>\nstream\n${c}\nendstream`);
    const xref = len;
    push('xref\n0 6\n0000000000 65535 f \n' + [1, 2, 3, 4, 5].map((n) => String(offs[n]).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
    return new Blob(parts, { type: 'application/pdf' });
  }

  // ---------- Composición: título, mapa (la vista actual), norte, escala, leyenda y pie ----------
  function compose(v) {
    const DPI = 150, mm = DPI / 25.4;
    let [pw, ph] = PAPER[v.paper];
    if (v.orient === 'v') [pw, ph] = [ph, pw];
    const W = Math.round(pw * mm), H = Math.round(ph * mm), cv = Object.assign(document.createElement('canvas'), { width: W, height: H }), g = cv.getContext('2d');
    const m = 10 * mm, top = v.title ? (v.sub ? 26 : 20) * mm : m, foot = 14 * mm, fx = m, fy = top, fw = W - 2 * m, fh = H - top - foot;
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#111'; g.textBaseline = 'alphabetic';
    if (v.title) { g.font = `700 ${7 * mm}px sans-serif`; g.fillText(v.title, m, 13 * mm); }
    if (v.sub) { g.font = `${4 * mm}px sans-serif`; g.fillStyle = '#444'; g.fillText(v.sub, m, 20 * mm); }
    // mapa: recorte centrado de la vista con la proporción del marco
    viewer.render();
    const src = viewer.scene.canvas, k = Math.max(fw / src.width, fh / src.height), sw = fw / k, sh = fh / k;
    g.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, fx, fy, fw, fh);
    g.strokeStyle = '#111'; g.lineWidth = 0.4 * mm; g.strokeRect(fx, fy, fw, fh);
    const box = (x, y, w, h) => { g.fillStyle = 'rgba(255,255,255,.88)'; g.fillRect(x, y, w, h); g.strokeStyle = '#111'; g.lineWidth = 0.25 * mm; g.strokeRect(x, y, w, h); g.fillStyle = '#111'; };
    if (v.north) { // la flecha gira con el rumbo de la cámara
      const cx = fx + fw - 12 * mm, cy = fy + 14 * mm;
      box(cx - 8 * mm, cy - 10 * mm, 16 * mm, 20 * mm);
      g.save(); g.translate(cx, cy + 2 * mm); g.rotate(-viewer.camera.heading);
      g.beginPath(); g.moveTo(0, -7 * mm); g.lineTo(3 * mm, 4 * mm); g.lineTo(0, 2 * mm); g.lineTo(-3 * mm, 4 * mm); g.closePath(); g.fill();
      g.font = `700 ${3.2 * mm}px sans-serif`; g.textAlign = 'center'; g.fillText('N', 0, -8 * mm); g.restore(); g.textAlign = 'left';
    }
    const la = OGE.lookAt();
    if (v.scale && la) { // escala en el centro de la vista (en perspectiva varía hacia los bordes)
      const mpp = viewer.camera.getPixelSize(new C.BoundingSphere(la.pos, 0), src.width, src.height) / k; // metros por píxel del papel
      const target = mpp * fw * 0.2, p10 = 10 ** Math.floor(Math.log10(target)), nice = [5, 2, 1].map((n) => n * p10).find((n) => n <= target) || p10, len = nice / mpp;
      const x = fx + fw - len - 8 * mm, y = fy + fh - 8 * mm;
      box(x - 4 * mm, y - 8 * mm, len + 8 * mm, 13 * mm);
      g.fillRect(x, y, len, 1.2 * mm); g.fillStyle = '#fff'; g.fillRect(x + len / 2, y + 0.25 * mm, len / 2 - 0.25 * mm, 0.7 * mm); g.fillStyle = '#111';
      g.font = `${3 * mm}px sans-serif`; g.textAlign = 'center';
      g.fillText((nice >= 1000 ? nice / 1000 + ' km' : nice + ' m') + T(' (aprox. al centro)'), x + len / 2, y - 2.5 * mm); g.textAlign = 'left';
    }
    const groups = visible().slice(0, 14);
    if (v.legend && groups.length) {
      g.font = `${3.2 * mm}px sans-serif`;
      const lw = Math.min(fw * 0.4, Math.max(...groups.map((d) => g.measureText(d.name).width)) + 14 * mm), lh = (groups.length * 5.5 + 9) * mm, x = fx + 4 * mm, y = fy + fh - lh - 4 * mm;
      box(x, y, lw, lh);
      g.font = `700 ${3.4 * mm}px sans-serif`; g.fillText(T('Leyenda'), x + 3 * mm, y + 5.5 * mm);
      g.font = `${3.2 * mm}px sans-serif`;
      groups.forEach((d, i) => { const yy = y + (11 + i * 5.5) * mm; g.fillStyle = colorOf(d); g.fillRect(x + 3 * mm, yy - 3 * mm, 5 * mm, 3.4 * mm); g.strokeRect(x + 3 * mm, yy - 3 * mm, 5 * mm, 3.4 * mm); g.fillStyle = '#111'; g.fillText(T(d.name), x + 10 * mm, yy, lw - 12 * mm); });
    }
    g.font = `${2.6 * mm}px sans-serif`; g.fillStyle = '#444';
    g.fillText(T('Fuentes: Sentinel-2 cloudless (EOX) · AWS Terrain Tiles · © OpenStreetMap · Natural Earth'), m, H - 6 * mm, fw * 0.7);
    g.textAlign = 'right'; g.fillText('OpenGISEarth · ' + new Date().toLocaleDateString('es'), W - m, H - 6 * mm); g.textAlign = 'left';
    return { cv, wPt: (pw * 72) / 25.4, hPt: (ph * 72) / 25.4 };
  }

  // ---------- Mapa vectorial en SVG: las capas visibles dentro de la vista, en proyección equirectangular ----------
  // data-bounds guarda la extensión para poder reimportarlo georreferenciado (aquí o en otro editor).
  function svgMap(title, graticule) {
    const b = OGE.viewBbox();
    if (!b) throw new Error('no se pudo determinar la zona visible');
    const [w, s, e, n] = b, Wp = 1200, Hp = Math.round((Wp * (n - s)) / ((e - w) * Math.cos((((s + n) / 2) * Math.PI) / 180)));
    const X = (lon) => (((lon - w) / (e - w)) * Wp).toFixed(2), Y = (lat) => (((n - lat) / (n - s)) * Hp).toFixed(2);
    const d = (ring, close) => 'M' + ring.map((c) => X(c[0]) + ' ' + Y(c[1])).join(' L') + (close ? ' Z' : '');
    const out = [`<?xml version="1.0" encoding="UTF-8"?>`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Wp} ${Hp}" width="${Wp}" height="${Hp}" data-bounds="${w} ${s} ${e} ${n}" data-projection="equirectangular">`, `<title>${xml(title)}</title>`];
    if (graticule) {
      const span = Math.max(e - w, n - s), st = [30, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.01].find((x) => span / x >= 4) || 0.01, lines = [];
      for (let k = Math.ceil(w / st); k * st <= e; k++) lines.push(`M${X(k * st)} 0 V${Hp}`);
      for (let k = Math.ceil(s / st); k * st <= n; k++) lines.push(`M0 ${Y(k * st)} H${Wp}`);
      out.push(`<path id="reticula" d="${lines.join(' ')}" fill="none" stroke="#999" stroke-width="0.5"/>`);
    }
    for (const ds of visible()) {
      out.push(`<g id="${xml(ds.name)}">`);
      for (const f of geo.features(ds)) {
        if (f.oge.show === false || f.oge.kind === 'image') continue;
        const st = f.oge.style, t = `<title>${xml(f.oge.name)}</title>`, g = f.geometry;
        if (g.type === 'Polygon') out.push(`<path d="${g.coordinates.map((r) => d(r, true)).join(' ')}" fill="${st.fill}" fill-opacity="${st.fillOpacity}" fill-rule="evenodd" stroke="${st.width ? st.stroke : 'none'}" stroke-width="${st.width || 0}">${t}</path>`);
        else if (g.type === 'LineString') out.push(`<path d="${d(g.coordinates)}" fill="none" stroke="${st.stroke}" stroke-opacity="${st.strokeOpacity}" stroke-width="${st.width}">${t}</path>`);
        else out.push(`<circle cx="${X(g.coordinates[0])}" cy="${Y(g.coordinates[1])}" r="4" fill="${st.color}" stroke="#000" stroke-width="0.5">${t}</circle>` +
          (f.oge.name ? `<text x="${+X(g.coordinates[0]) + 6}" y="${+Y(g.coordinates[1]) + 4}" font-family="sans-serif" font-size="11">${xml(f.oge.name)}</text>` : ''));
      }
      out.push('</g>');
    }
    out.push('</svg>');
    return out.join('\n');
  }

  async function layout() {
    const v = await OGE.ask({ title: 'Diseño de impresión', ok: 'Crear', help: 'Compone la vista actual del mapa en una hoja. El SVG es vectorial: lleva las capas visibles (sin la imagen satelital) y se puede abrir en Inkscape.',
      fields: [{ id: 'title', label: 'Título', value: T('Mapa') }, { id: 'sub', label: 'Subtítulo' },
        { id: 'fmt', label: 'Formato', type: 'select', options: [['pdf', 'PDF'], ['png', 'PNG (imagen)'], ['svg', 'SVG vectorial (solo capas)']] },
        { id: 'paper', label: 'Papel (PDF/PNG)', type: 'select', options: Object.keys(PAPER) }, { id: 'orient', label: 'Orientación', type: 'select', options: [['h', 'Horizontal'], ['v', 'Vertical']] },
        { id: 'legend', label: 'Leyenda de capas', type: 'checkbox', value: true }, { id: 'scale', label: 'Barra de escala', type: 'checkbox', value: true },
        { id: 'north', label: 'Flecha de norte', type: 'checkbox', value: true }, { id: 'grat', label: 'Meridianos y paralelos (SVG)', type: 'checkbox', value: true }] });
    if (!v) return;
    const name = (v.title || 'mapa').replace(/[\\/:*?"<>|]+/g, '_');
    try {
      if (v.fmt === 'svg') return OGE.download(name + '.svg', svgMap(v.title, v.grat), 'image/svg+xml');
      const { cv, wPt, hPt } = compose(v);
      const blob = await new Promise((r) => cv.toBlob(r, v.fmt === 'png' ? 'image/png' : 'image/jpeg', 0.92));
      OGE.download(name + '.' + v.fmt, v.fmt === 'png' ? blob : pdf(new Uint8Array(await blob.arrayBuffer()), cv.width, cv.height, wPt.toFixed(1), hPt.toFixed(1)));
    } catch (e) { OGE.toast('No se pudo crear el mapa: ' + e.message, true); }
  }
  $('printBtn').onclick = layout;

  // ---------- Importar trazados de un SVG ----------
  // Las formas se recorren con el propio motor SVG del navegador (curvas y transformaciones incluidas) y se
  // georreferencian con una extensión equirectangular: la de data-bounds si el archivo la trae, o la que indique el usuario.
  // shortcut: cada subtrazado cerrado sale como polígono aparte (los huecos no se detectan).
  async function importSvg(file) {
    const doc = new DOMParser().parseFromString(await file.text(), 'image/svg+xml'), svg = doc.documentElement;
    if (svg.localName !== 'svg') throw new Error('no es un SVG válido');
    const host = Object.assign(document.createElement('div'), { style: 'position:absolute;left:-99999px;top:0;visibility:hidden' });
    host.append(document.importNode(svg, true));
    document.body.append(host);
    try {
      const root = host.firstElementChild, vb0 = root.viewBox.baseVal;
      const vb = vb0 && vb0.width ? vb0 : { width: parseFloat(root.getAttribute('width')) || 1000, height: parseFloat(root.getAttribute('height')) || 1000 };
      root.setAttribute('width', vb.width); root.setAttribute('height', vb.height); root.setAttribute('preserveAspectRatio', 'none'); // 1 unidad = 1 píxel
      const saved = (root.getAttribute('data-bounds') || '').split(/[\s,]+/).map(Number), view = OGE.viewBbox() || [-10, -10, 10, 10];
      const own = saved.length === 4 && saved.every(Number.isFinite), def = own ? saved : view.map((x) => +x.toFixed(5));
      const num = (id, label, value) => ({ id, label, type: 'number', value });
      const v = await OGE.ask({ title: 'Importar SVG: ¿dónde va en el mapa?', ok: 'Importar',
        help: 'Extensión geográfica que cubre el dibujo completo (proyección equirectangular). ' + (own ? 'El archivo trae su extensión.' : 'Por defecto se propone la vista actual.'),
        fields: [num('n', 'Norte (latitud)', def[3]), num('s', 'Sur (latitud)', def[1]), num('w', 'Oeste (longitud)', def[0]), num('e', 'Este (longitud)', def[2])] });
      if (!v) return;
      const hex = (c) => { const k = C.Color.fromCssColorString(c); return k ? k.withAlpha(1).toCssHexString() : null; };
      const feats = [], step = Math.max(vb.width, vb.height) / 1500;
      for (const elm of root.querySelectorAll('path,polygon,polyline,line,rect,circle,ellipse')) {
        if (elm.closest('defs,clipPath,mask,symbol,pattern,marker') || elm.id === 'reticula') continue; // la retícula de nuestro propio SVG no es un trazado
        let total = 0;
        try { total = elm.getTotalLength(); } catch { continue; }
        if (!total) continue;
        // tramos [inicio, fin, cerrado] de cada subtrazado, medidos sobre la longitud total
        let spans = [[0, total, /^(polygon|rect|circle|ellipse)$/.test(elm.localName)]];
        const subs = elm.localName === 'path' ? (elm.getAttribute('d') || '').match(/[Mm][^Mm]*/g) : null;
        if (subs && subs.length > 1) {
          const probe = elm.cloneNode(false);
          elm.parentNode.append(probe);
          let acc = '', prev = 0;
          spans = subs.map((sub) => { acc += sub; probe.setAttribute('d', acc); const end = probe.getTotalLength(), sp = [prev, end, /[zZ]\s*$/.test(sub)]; prev = end; return sp; });
          probe.remove();
        } else if (subs) spans[0][2] = /[zZ]\s*$/.test(subs[0]);
        const m = elm.getCTM(), cs = getComputedStyle(elm), fill = cs.fill === 'none' ? null : hex(cs.fill), stroke = cs.stroke === 'none' ? null : hex(cs.stroke);
        const title = elm.querySelector('title'), name = (title && title.textContent) || elm.id || (elm.parentNode.id && elm.parentNode.localName === 'g' ? elm.parentNode.id : '');
        for (const [a, b, closed] of spans) {
          const nPts = Math.max(2, Math.min(3000, Math.ceil((b - a) / step))), cs2 = [];
          for (let i = 0; i < nPts; i++) {
            const p = elm.getPointAtLength(a + ((b - a) * i) / (nPts - 1)).matrixTransform(m);
            cs2.push([v.w + (p.x / vb.width) * (v.e - v.w), v.n - (p.y / vb.height) * (v.n - v.s)]);
          }
          const poly = closed && fill && cs2.length > 3;
          if (poly) cs2[cs2.length - 1] = cs2[0];
          feats.push({ type: 'Feature', properties: {}, oge: { name, style: { ...(fill ? { fill, fillOpacity: +cs.fillOpacity || 1 } : {}), ...(stroke ? { stroke, width: 2 } : poly ? { width: 0 } : {}) } },
            geometry: poly ? { type: 'Polygon', coordinates: [cs2] } : { type: 'LineString', coordinates: closed ? [...cs2.slice(0, -1), cs2[0]] : cs2 } });
        }
        if (feats.length > 8000) break;
      }
      if (!feats.length) throw new Error('no se encontraron trazados');
      const ds = geo.addGroup(file.name.replace(/\.svg$/i, ''), feats);
      viewer.flyTo(ds);
      OGE.toast(`SVG importado: ${ds.entities.values.length} trazados.`);
    } finally { host.remove(); }
  }
  Object.assign(OGE, { importSvg, svgMap, layout });
})();
