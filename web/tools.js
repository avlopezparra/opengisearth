// OpenGISEarth — caja de herramientas avanzadas: geoprocesos equivalentes a los de QGIS (Processing) y ArcGIS (ArcToolbox).
// Cada herramienta declara su equivalente (q: QGIS, a: ArcGIS), sus parámetros y una función run(objetos, parámetros).
// El resultado va a una capa nueva de Lugares (como en QGIS), salvo las que seleccionan, informan o editan atributos en sitio.
// shortcut: todo se calcula en WGS84 con turf (lon/lat); no hay reproyección ni ráster propio (solo el relieve en línea).
(() => {
  const C = Cesium, T = turf, { viewer, geo, $, el } = OGE;
  const now = () => viewer.clock.currentTime;
  const km = (m) => m / 1000;
  const FC = (fs) => T.featureCollection(fs);
  const kindOf = (f) => (/Point$/.test(f.geometry.type) ? 'point' : /LineString$/.test(f.geometry.type) ? 'line' : 'polygon');
  const isPoly = (f) => kindOf(f) === 'polygon', isLine = (f) => kindOf(f) === 'line', isPoint = (f) => kindOf(f) === 'point';
  const TYPE = { point: 'puntos', line: 'líneas', polygon: 'polígonos' };
  const need = (okd, msg) => { if (!okd) throw new Error(msg); };

  // ---------- Utilidades de geometría ----------
  // Resultado: geometría nueva que hereda nombre y atributos del objeto de origen.
  const out = (f, g, extra) => ({ type: 'Feature', geometry: g.geometry || g, properties: { ...(f && f.properties), ...extra }, oge: { name: (f && f.oge && f.oge.name) || '' } });
  const named = (f, name) => { f.oge.name = String(name); return f; };
  const tint = (f, c) => { f.oge.style = { ...f.oge.style, stroke: c, fill: c, color: c }; return f; };
  const each = (fs, fn) => fs.flatMap((f) => { const r = fn(f); return !r ? [] : Array.isArray(r) ? r : [r]; });
  const U = (fs) => (fs.length < 2 ? fs[0] : T.union(FC(fs)));
  const inter = (a, b) => { try { return T.intersect(FC([a, b])); } catch { return null; } };
  const diff = (a, bs) => { try { return bs.length ? T.difference(FC([a, ...bs])) : a; } catch { return a; } };
  const boxes = new WeakMap();
  const bb = (f) => { let b = boxes.get(f); if (!b) { b = T.bbox(f); boxes.set(f, b); } return b; };
  const hit = (a, b) => { const x = bb(a), y = bb(b); return x[0] <= y[2] && y[0] <= x[2] && x[1] <= y[3] && y[1] <= x[3]; };
  const other = (f, g) => !f.entity || f.entity !== g.entity; // una capa comparada consigo misma no cruza un objeto con él mismo
  const ringsOf = (f) => (f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.type === 'LineString' ? [f.geometry.coordinates] : []);
  const asLine = (f) => (isPoly(f) ? T.lineString(f.geometry.coordinates[0]) : f);
  const anchor = (f) => (f.geometry.type === 'Point' ? f.geometry.coordinates : T.centroid(f).geometry.coordinates);
  const distM = (c, g) => (g.geometry.type === 'Point' ? T.distance(c, g.geometry.coordinates) * 1000
    : isPoly(g) && T.booleanPointInPolygon(c, g) ? 0 : Math.min(...ringsOf(g).map((r) => geo.nearest(r, c).dist)));
  const nearestOn = (c, g) => (g.geometry.type === 'Point' ? g.geometry.coordinates : ringsOf(g).map((r) => geo.nearest(r, c)).sort((a, b) => a.dist - b.dist)[0].point);
  const mapRings = (f, fn) => (f.geometry.type === 'LineString' ? T.lineString(fn(f.geometry.coordinates, false)) : T.polygon(f.geometry.coordinates.map((r) => fn(r, true))));
  const view = () => { const b = OGE.viewBbox(); need(b, 'No se pudo determinar la zona visible.'); return b; };
  const viewKm2 = (b) => T.area(T.bboxPolygon(b)) / 1e6;
  const cmp = (a, b) => (Number.isFinite(+a) && Number.isFinite(+b) ? a - b : String(a ?? '').localeCompare(String(b ?? '')));
  function clipTo(f, mask) { // parte de f dentro del polígono mask
    if (isPoint(f)) return T.booleanPointInPolygon(f, mask) ? out(f, f) : null;
    if (isPoly(f)) { const x = inter(f, mask); return x && out(f, x); }
    const parts = T.lineSplit(f, mask).features; // línea: se corta en el borde y se conservan los tramos interiores
    return (parts.length ? parts : [f]).filter((s) => T.booleanPointInPolygon(T.along(s, T.length(s) / 2), mask)).map((s) => out(f, s));
  }
  function eraseFrom(f, mask) { // parte de f fuera del polígono mask
    if (isPoint(f)) return T.booleanPointInPolygon(f, mask) ? null : out(f, f);
    if (isPoly(f)) { const x = diff(f, [mask]); return x && out(f, x); }
    const parts = T.lineSplit(f, mask).features;
    return (parts.length ? parts : [f]).filter((s) => !T.booleanPointInPolygon(T.along(s, T.length(s) / 2), mask)).map((s) => out(f, s));
  }
  const chaikin = (c, closed) => { // suavizado: corta cada esquina
    const p = closed ? c.slice(0, -1) : c, n = p.length, o = [];
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = p[i], b = p[(i + 1) % n];
      o.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    return closed ? [...o, o[0]] : [p[0], ...o, p[n - 1]];
  };
  const densify = (c, stepKm) => {
    const o = [c[0]];
    for (let i = 1; i < c.length; i++) {
      const d = T.distance(c[i - 1], c[i]), n = Math.floor(d / stepKm);
      for (let k = 1; k <= n; k++) { const t = (k * stepKm) / d; if (t < 1 - 1e-9) o.push([c[i - 1][0] + (c[i][0] - c[i - 1][0]) * t, c[i - 1][1] + (c[i][1] - c[i - 1][1]) * t]); }
      o.push(c[i]);
    }
    return o;
  };
  function mergeLines(fs) { // une líneas que se tocan por sus extremos
    const segs = fs.map((f) => f.geometry.coordinates.slice()), res = [], eq = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
    while (segs.length) {
      let cur = segs.pop(), grown = true;
      while (grown) {
        grown = false;
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i];
          if (eq(cur.at(-1), s[0])) cur = [...cur, ...s.slice(1)];
          else if (eq(cur.at(-1), s.at(-1))) cur = [...cur, ...s.slice(0, -1).reverse()];
          else if (eq(cur[0], s.at(-1))) cur = [...s.slice(0, -1), ...cur];
          else if (eq(cur[0], s[0])) cur = [...s.slice(1).reverse(), ...cur];
          else continue;
          segs.splice(i, 1); grown = true;
          break;
        }
      }
      res.push(cur);
    }
    return res;
  }
  function minCircle(f) { // círculo mínimo envolvente (Bădoiu–Clarkson: el centro se acerca al punto más lejano)
    const pts = T.coordAll(f);
    let c = T.center(f).geometry.coordinates;
    for (let k = 0; k < 300; k++) {
      let far = pts[0], fd = -1;
      for (const q of pts) { const d = T.distance(c, q); if (d > fd) { fd = d; far = q; } }
      c = T.destination(c, fd / (k + 2), T.bearing(c, far)).geometry.coordinates;
    }
    return T.circle(c, Math.max(...pts.map((q) => T.distance(c, q))), { steps: 72 });
  }
  function orientedBox(f) { // rectángulo mínimo orientado: se prueba la orientación de cada lado de la envolvente convexa
    const hull = T.convex(f);
    if (!hull) return null;
    const c = T.centroid(hull).geometry.coordinates, kx = Math.cos((c[1] * Math.PI) / 180);
    const P = hull.geometry.coordinates[0].map(([x, y]) => [(x - c[0]) * kx, y - c[1]]);
    let best = null;
    for (let i = 0; i < P.length - 1; i++) {
      const a = Math.atan2(P[i + 1][1] - P[i][1], P[i + 1][0] - P[i][0]), ca = Math.cos(a), sa = Math.sin(a);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of P) { const u = x * ca + y * sa, v = -x * sa + y * ca; x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, v); y1 = Math.max(y1, v); }
      if (!best || (x1 - x0) * (y1 - y0) < best.area) best = { area: (x1 - x0) * (y1 - y0), ca, sa, r: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
    }
    const back = best.r.map(([u, v]) => [(u * best.ca - v * best.sa) / kx + c[0], u * best.sa + v * best.ca + c[1]]);
    return T.polygon([[...back, back[0]]]);
  }
  function fix(f) { // repara: quita vértices repetidos, separa autointersecciones y ordena los anillos
    try {
      let g = T.cleanCoords(f);
      if (isPoly(g)) { const k = T.unkinkPolygon(g).features; g = T.rewind(k.length > 1 ? U(k) : k[0] || g); }
      return g;
    } catch { return null; }
  }

  // ---------- Estadística y color ----------
  const nums = (fs, field) => fs.map((f) => Number(f.properties[field])).filter((v, i) => Number.isFinite(v) && fs[i].properties[field] !== '' && fs[i].properties[field] != null);
  function stats(v) {
    const n = v.length, s = v.slice().sort((a, b) => a - b), sum = v.reduce((a, b) => a + b, 0), mean = sum / n;
    return { n, sum, mean, min: s[0], max: s[n - 1], median: n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2, std: Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / n) };
  }
  const statRow = (label, v) => { const s = stats(v); return [label, s.n, s.sum, s.mean, s.median, s.min, s.max, s.std].map((x) => (typeof x === 'number' ? +x.toFixed(4) : x)); };
  const STAT_COLS = ['', 'cuenta', 'suma', 'media', 'mediana', 'mínimo', 'máximo', 'desv. estándar'];
  const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#469990', '#9a6324', '#ffe119', '#800000', '#808000', '#000075', '#fabed4'];
  const RAMP = ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'].map((h) => C.Color.fromCssColorString(h)); // viridis
  const ramp = (t) => { const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(x)); return C.Color.lerp(RAMP[i], RAMP[i + 1], x - i, new C.Color()).toCssHexString(); };
  function colorer(values, graduated) { // valor → color: rampa continua o una categoría por valor distinto
    if (graduated) {
      const v = values.map(Number).filter(Number.isFinite), lo = v.reduce((a, b) => Math.min(a, b), Infinity), hi = v.reduce((a, b) => Math.max(a, b), -Infinity);
      return (x) => (x !== '' && x != null && Number.isFinite(Number(x)) ? ramp(hi > lo ? (Number(x) - lo) / (hi - lo) : 0.5) : '#888888');
    }
    const cats = [...new Set(values.map(String))];
    return (x) => PALETTE[cats.indexOf(String(x)) % PALETTE.length];
  }
  const valueOf = (f, field) => (field === 'nombre' ? f.oge.name : f.properties[field]);
  // Expresión JavaScript sobre un objeto: los campos por su nombre, además de nombre, $area y $perimeter (m²/m), $length (m), $x, $y, $id.
  function compile(src) {
    const fn = new Function('a', 'nombre', '$area', '$length', '$perimeter', '$x', '$y', '$id', 'with (a) { return (' + src + '); }');
    return (f, i) => {
      const k = kindOf(f), c = anchor(f);
      try { return fn(f.properties, f.oge.name, k === 'polygon' ? T.area(f) : 0, k === 'line' ? T.length(f) * 1000 : 0, k === 'polygon' ? T.length(f) * 1000 : 0, c[0], c[1], i + 1); } catch { return null; }
    };
  }
  function test(v, op, x) {
    const n = Number(v), m = Number(x), numeric = v !== '' && v != null && x !== '' && Number.isFinite(n) && Number.isFinite(m), s = String(v ?? '').toLowerCase(), t = String(x).toLowerCase();
    switch (op) {
      case '=': return numeric ? n === m : s === t;
      case '≠': return numeric ? n !== m : s !== t;
      case '>': return numeric ? n > m : s > t;
      case '<': return numeric ? n < m : s < t;
      case '≥': return numeric ? n >= m : s >= t;
      case '≤': return numeric ? n <= m : s <= t;
      case 'contiene': return s.includes(t);
      case 'empieza con': return s.startsWith(t);
      default: return v == null || v === '';
    }
  }

  // ---------- Cambios en sitio (deshacibles) ----------
  function setProps(changes) { // [[entidad, atributosNuevos]]
    const before = changes.map(([e]) => [e, e.properties ? e.properties.getValue(now()) : null]);
    const put = (list) => list.forEach(([e, p]) => { e.properties = p && Object.keys(p).length ? new C.PropertyBag(p) : undefined; });
    OGE.run({ do: () => put(changes), undo: () => put(before) });
  }
  function setStyles(changes) { // [[entidad, estiloNuevo]]
    const before = changes.map(([e]) => [e, geo.getStyle(e)]);
    const put = (list) => list.forEach(([e, s]) => geo.setStyle(e, s));
    OGE.run({ do: () => put(changes), undo: () => put(before) });
  }
  const withProps = (fs, fn) => { setProps(fs.map((f, i) => [f.entity, { ...f.properties, ...fn(f, i) }])); return { msg: fs.length + ' objetos actualizados.' }; };

  // ---------- Relieve (para las herramientas de terreno) ----------
  function chart(xs, ys) { // gráfico de área simple
    const cv = el('canvas', { width: 1400, height: 440 }), g = cv.getContext('2d'), W = cv.width, H = cv.height, m = { l: 90, r: 20, t: 20, b: 50 };
    const lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1, X = (v) => m.l + ((W - m.l - m.r) * v) / xs.at(-1), Y = (v) => H - m.b - ((H - m.t - m.b) * (v - lo)) / span;
    g.font = '22px sans-serif'; g.fillStyle = '#ccc'; g.strokeStyle = '#555'; g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) { const v = lo + (span * i) / 4; g.beginPath(); g.moveTo(m.l, Y(v)); g.lineTo(W - m.r, Y(v)); g.stroke(); g.textAlign = 'right'; g.fillText(Math.round(v) + ' m', m.l - 8, Y(v) + 7); }
    for (let i = 0; i <= 5; i++) { const v = (xs.at(-1) * i) / 5; g.textAlign = 'center'; g.fillText(v.toFixed(v < 10 ? 2 : 1) + ' km', X(v), H - 16); }
    g.beginPath(); g.moveTo(X(0), H - m.b); xs.forEach((x, i) => g.lineTo(X(x), Y(ys[i]))); g.lineTo(X(xs.at(-1)), H - m.b); g.closePath();
    g.fillStyle = 'rgba(94, 201, 98, .45)'; g.fill(); g.strokeStyle = '#5ec962'; g.lineWidth = 3; g.stroke();
    return cv;
  }
  async function terrainImage(mode) { // sombreado o pendiente de la vista actual, como imagen superpuesta
    const b = view(), lat = (b[1] + b[3]) / 2, nx = 360, ny = Math.max(60, Math.min(360, Math.round((360 * (b[3] - b[1])) / ((b[2] - b[0]) * Math.cos((lat * Math.PI) / 180)))));
    const g = await OGE.dem.grid(b, nx, ny), cv = el('canvas', { width: nx, height: ny }), ctx = cv.getContext('2d'), img = ctx.createImageData(nx, ny), z = (i, j) => g.z[Math.max(0, Math.min(ny - 1, j)) * nx + Math.max(0, Math.min(nx - 1, i))];
    const zen = (45 * Math.PI) / 180, az = (135 * Math.PI) / 180; // sol al noroeste, a 45° de altura
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { // gradiente de Horn
      const dzdx = (z(i + 1, j - 1) + 2 * z(i + 1, j) + z(i + 1, j + 1) - z(i - 1, j - 1) - 2 * z(i - 1, j) - z(i - 1, j + 1)) / (8 * g.dx);
      const dzdy = (z(i - 1, j + 1) + 2 * z(i, j + 1) + z(i + 1, j + 1) - z(i - 1, j - 1) - 2 * z(i, j - 1) - z(i + 1, j - 1)) / (8 * g.dy);
      const slope = Math.atan(Math.hypot(dzdx, dzdy)), o = (j * nx + i) * 4;
      if (mode === 'slope') { const c = C.Color.fromCssColorString(ramp(Math.min(1, slope / (Math.PI / 4)))); img.data[o] = c.red * 255; img.data[o + 1] = c.green * 255; img.data[o + 2] = c.blue * 255; img.data[o + 3] = 255; }
      else { const v = Math.max(0, Math.cos(zen) * Math.cos(slope) + Math.sin(zen) * Math.sin(slope) * Math.cos(az - Math.atan2(dzdy, -dzdx))) * 255; img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255; }
    }
    ctx.putImageData(img, 0, 0);
    return { image: { bbox: b, url: cv.toDataURL('image/png'), name: mode === 'slope' ? 'Pendiente (0° violeta – 45° amarillo)' : 'Sombreado del relieve', opacity: 0.6 } };
  }

  // ---------- Constructores de parámetros ----------
  const N = (id, label, value, o) => ({ id, label, type: 'number', value, ...o });
  const S = (id, label, options, value) => ({ id, label, type: 'select', options, value });
  const B = (id, label, value = false) => ({ id, label, type: 'checkbox', value });
  const X = (id, label, value = '', o) => ({ id, label, type: 'text', value, ...o });
  const LY = (id, label) => ({ id, label, type: 'layer' });
  const MODE = S('mode', 'Resultado', [['sel', 'Seleccionar en el mapa'], ['new', 'Extraer a una capa nueva']]);
  const selOrNew = (r, p) => (p.mode === 'sel' ? { select: r } : r.map((f) => out(f, f)));

  // ---------- Catálogo ----------
  const TOOLS = [
    // ===== Geometría vectorial =====
    { id: 'buffer', g: 'Geometría', n: 'Buffer (área de influencia)', q: 'native:buffer', a: 'Buffer', p: [N('d', 'Distancia (m; negativa encoge polígonos)', 1000), B('dis', 'Disolver el resultado')],
      run: (fs, p) => { const r = each(fs, (f) => { const b = T.buffer(f, km(p.d)); return b && out(f, b); }); return p.dis && r.length > 1 ? [out(null, U(r))] : r; } },
    { id: 'multiring', g: 'Geometría', n: 'Buffer de anillos múltiples', q: 'native:multiringconstantbuffer', a: 'MultipleRingBuffer', p: [N('d', 'Distancia entre anillos (m)', 500, { min: 0.01 }), N('n', 'Número de anillos', 3, { min: 1, max: 50, step: 1 })],
      run: (fs, p) => fs.flatMap((f) => { const rs = []; let prev = isPoly(f) ? f : null; for (let i = 1; i <= p.n; i++) { const b = T.buffer(f, km(p.d * i)); if (!b) continue; const ring = prev ? diff(b, [prev]) : b; if (ring) rs.push(out(f, ring, { anillo: i, distancia_m: p.d * i })); prev = b; } return rs; }) },
    { id: 'sidebuffer', g: 'Geometría', n: 'Buffer de un solo lado', q: 'native:singlesidedbuffer', a: 'Buffer (LEFT / RIGHT)', in: ['line'], p: [N('d', 'Distancia (m)', 500, { min: 0.01 }), S('side', 'Lado, según el sentido de la línea', [['1', 'Derecha'], ['-1', 'Izquierda']])],
      run: (fs, p) => each(fs, (f) => { const c = f.geometry.coordinates, o = T.lineOffset(f, km(p.d) * p.side, { units: 'kilometers' }).geometry.coordinates; return out(f, T.polygon([[...c, ...o.slice().reverse(), c[0]]])); }) },
    { id: 'wedge', g: 'Geometría', n: 'Buffer en cuña (sector)', q: 'native:wedgebuffers', a: '—', in: ['point'], p: [N('az', 'Acimut central (°)', 0), N('w', 'Ancho angular (°)', 45, { min: 1, max: 359 }), N('r', 'Radio (m)', 1000, { min: 0.01 })],
      run: (fs, p) => fs.map((f) => out(f, T.sector(f, km(p.r), p.az - p.w / 2, p.az + p.w / 2))) },
    { id: 'centroids', g: 'Geometría', n: 'Centroides', q: 'native:centroids / pointonsurface', a: 'FeatureToPoint', p: [S('m', 'Tipo', [['c', 'Centroide'], ['m', 'Centro de masa'], ['s', 'Punto sobre la superficie']])],
      run: (fs, p) => fs.map((f) => out(f, p.m === 'c' ? T.centroid(f) : p.m === 'm' ? T.centerOfMass(f) : T.pointOnFeature(f))) },
    { id: 'convex', g: 'Geometría', n: 'Envolvente convexa', q: 'native:convexhull', a: 'MinimumBoundingGeometry (CONVEX_HULL)', p: [B('all', 'Una sola para todos los objetos')],
      run: (fs, p) => { const one = (f, src) => { const h = T.convex(f); return h && out(src, h); }; return p.all ? [one(FC(fs), null)].filter(Boolean) : each(fs, (f) => one(f, f)); } },
    { id: 'concave', g: 'Geometría', n: 'Envolvente cóncava', q: 'native:concavehull', a: 'AggregatePoints', p: [N('e', 'Arista máxima (km)', 50, { min: 0.001 })],
      run: (fs, p) => { const h = T.concave(T.explode(FC(fs)), { maxEdge: p.e, units: 'kilometers' }); need(h, 'La arista máxima es demasiado corta para unir los puntos.'); return [out(null, h)]; } },
    { id: 'bbox', g: 'Geometría', n: 'Cajas delimitadoras / extensión de la capa', q: 'native:boundingboxes / polygonfromlayerextent', a: 'MinimumBoundingGeometry (ENVELOPE)', p: [B('all', 'Una sola para toda la capa')],
      run: (fs, p) => (p.all ? [out(null, T.bboxPolygon(T.bbox(FC(fs))))] : fs.filter((f) => !isPoint(f)).map((f) => out(f, T.bboxPolygon(T.bbox(f))))) },
    { id: 'mincircle', g: 'Geometría', n: 'Círculo mínimo envolvente', q: 'native:minimumenclosingcircle', a: 'MinimumBoundingGeometry (CIRCLE)', p: [B('all', 'Uno solo para todos los objetos')],
      run: (fs, p) => (p.all ? [out(null, minCircle(FC(fs)))] : fs.filter((f) => !isPoint(f)).map((f) => out(f, minCircle(f)))) },
    { id: 'obb', g: 'Geometría', n: 'Rectángulo mínimo orientado', q: 'native:orientedminimumboundingbox', a: 'MinimumBoundingGeometry (RECTANGLE_BY_AREA)', in: ['line', 'polygon'],
      run: (fs) => each(fs, (f) => { const b = orientedBox(f); return b && out(f, b); }) },
    { id: 'simplify', g: 'Geometría', n: 'Simplificar', q: 'native:simplifygeometries', a: 'SimplifyLine / SimplifyPolygon / Generalize', in: ['line', 'polygon'], p: [N('tol', 'Tolerancia (m)', 100, { min: 0.001 })],
      run: (fs, p) => fs.map((f) => out(f, T.simplify(T.clone(f), { tolerance: p.tol / 111320, highQuality: true }))) },
    { id: 'smooth', g: 'Geometría', n: 'Suavizar', q: 'native:smoothgeometry', a: 'SmoothLine / SmoothPolygon', in: ['line', 'polygon'], p: [N('it', 'Iteraciones', 2, { min: 1, max: 6, step: 1 })],
      run: (fs, p) => fs.map((f) => { let g = f; for (let i = 0; i < p.it; i++) g = mapRings(g, chaikin); return out(f, g); }) },
    { id: 'densify', g: 'Geometría', n: 'Densificar por intervalo', q: 'native:densifygeometriesgivenaninterval', a: 'Densify', in: ['line', 'polygon'], p: [N('d', 'Distancia máxima entre vértices (m)', 100, { min: 0.01 })],
      run: (fs, p) => fs.map((f) => out(f, mapRings(f, (c) => densify(c, km(p.d))))) },
    { id: 'poly2line', g: 'Geometría', n: 'Polígonos a líneas', q: 'native:polygonstolines / boundary', a: 'PolygonToLine / FeatureToLine', in: ['polygon'],
      run: (fs) => fs.flatMap((f) => f.geometry.coordinates.map((r) => out(f, T.lineString(r)))) },
    { id: 'line2poly', g: 'Geometría', n: 'Líneas a polígonos', q: 'qgis:linestopolygons', a: 'FeatureToPolygon', in: ['line'],
      run: (fs) => each(fs, (f) => { const c = f.geometry.coordinates, closed = c[0][0] === c.at(-1)[0] && c[0][1] === c.at(-1)[1]; return c.length > 2 && out(f, T.polygon([closed ? c : [...c, c[0]]])); }) },
    { id: 'polygonize', g: 'Geometría', n: 'Poligonizar (áreas cerradas por líneas)', q: 'native:polygonize', a: 'FeatureToPolygon', in: ['line'],
      run: (fs) => { // las líneas se cortan en sus cruces para que formen una red cerrada
        const noded = fs.flatMap((f, i) => { let parts = [f]; fs.forEach((g, j) => { if (i !== j && hit(f, g)) parts = parts.flatMap((x) => { const s = T.lineSplit(x, g).features; return s.length ? s : [x]; }); }); return parts; });
        return T.polygonize(FC(noded.map((f) => T.truncate(T.lineString(f.geometry.coordinates), { precision: 8 })))).features.map((x) => out(null, x));
      } },
    { id: 'vertices', g: 'Geometría', n: 'Extraer vértices', q: 'native:extractvertices / extractspecificvertices', a: 'FeatureVerticesToPoints', in: ['line', 'polygon'], p: [S('w', 'Cuáles', [['all', 'Todos'], ['first', 'El primero'], ['last', 'El último'], ['ends', 'Primero y último'], ['mid', 'Punto medio']])],
      run: (fs, p) => fs.flatMap((f) => { const l = asLine(f), c = l.geometry.coordinates; const pick = p.w === 'all' ? T.coordAll(f) : p.w === 'first' ? [c[0]] : p.w === 'last' ? [c.at(-1)] : p.w === 'ends' ? [c[0], c.at(-1)] : [T.along(l, T.length(l) / 2).geometry.coordinates]; return pick.map((q, i) => out(f, T.point(q), { vertice: i })); }) },
    { id: 'explode', g: 'Geometría', n: 'Explotar líneas (un tramo por segmento)', q: 'native:explodelines', a: 'SplitLine', in: ['line', 'polygon'],
      run: (fs) => fs.flatMap((f) => T.lineSegment(f).features.map((s) => out(f, s))) },
    { id: 'dissolve', g: 'Geometría', n: 'Disolver', q: 'native:dissolve', a: 'Dissolve', in: ['polygon'], p: [X('field', 'Campo para agrupar (vacío = todo junto)')],
      run: (fs, p) => { const gr = new Map(); for (const f of fs) { const k = p.field ? String(valueOf(f, p.field) ?? '') : ''; if (!gr.has(k)) gr.set(k, []); gr.get(k).push(f); } return [...gr].map(([k, list]) => named(out(null, U(list), p.field ? { [p.field]: valueOf(list[0], p.field) } : {}), k)); } },
    { id: 'deleteholes', g: 'Geometría', n: 'Eliminar agujeros', q: 'native:deleteholes', a: 'EliminatePolygonPart', in: ['polygon'], p: [N('min', 'Solo los menores que (m²; 0 = todos)', 0, { min: 0 })],
      run: (fs, p) => fs.map((f) => out(f, T.polygon(f.geometry.coordinates.filter((r, i) => i === 0 || (p.min > 0 && T.area(T.polygon([r])) >= p.min))))) },
    { id: 'reverse', g: 'Geometría', n: 'Invertir dirección de línea', q: 'native:reverselinedirection', a: 'FlipLine', in: ['line'], run: (fs) => fs.map((f) => out(f, T.lineString(f.geometry.coordinates.slice().reverse()))) },
    { id: 'offset', g: 'Geometría', n: 'Línea paralela / matriz de paralelas', q: 'native:offsetline / arrayoffsetlines', a: 'Copy Parallel', in: ['line'], p: [N('d', 'Distancia (m; positiva = a la derecha, negativa = a la izquierda)', 100), N('n', 'Número de copias', 1, { min: 1, max: 100, step: 1 })],
      run: (fs, p) => fs.flatMap((f) => Array.from({ length: p.n }, (_, i) => out(f, T.lineOffset(f, km(p.d * (i + 1)), { units: 'kilometers' }), p.n > 1 ? { copia: i + 1 } : {}))) },
    { id: 'translate', g: 'Geometría', n: 'Trasladar / matriz de copias', q: 'native:translategeometry / arraytranslatedfeatures', a: 'Move / Array', p: [N('d', 'Distancia (m)', 1000), N('az', 'Rumbo (°; 0 = norte, 90 = este)', 90), N('n', 'Número de copias', 1, { min: 1, max: 100, step: 1 })],
      run: (fs, p) => fs.flatMap((f) => Array.from({ length: p.n }, (_, i) => out(f, T.transformTranslate(f, km(p.d * (i + 1)), p.az), p.n > 1 ? { copia: i + 1 } : {}))) },
    { id: 'rotate', g: 'Geometría', n: 'Rotar', q: 'native:rotatefeatures', a: 'Rotate', p: [N('a', 'Ángulo (°; positivo = horario)', 45), B('each', 'Cada objeto alrededor de su centro', true)],
      run: (fs, p) => { const all = T.centroid(FC(fs)).geometry.coordinates; return fs.map((f) => out(f, T.transformRotate(f, p.a, { pivot: p.each ? anchor(f) : all }))); } },
    { id: 'scale', g: 'Geometría', n: 'Escalar', q: 'native:affinetransform', a: 'Scale', in: ['line', 'polygon'], p: [N('k', 'Factor', 2, { min: 0.001 })],
      run: (fs, p) => fs.map((f) => out(f, T.transformScale(f, p.k, { origin: 'centroid' }))) },
    { id: 'swapxy', g: 'Geometría', n: 'Intercambiar X e Y', q: 'native:swapxy', a: '—', run: (fs) => fs.map((f) => out(f, T.flip(f))) },
    { id: 'tessellate', g: 'Geometría', n: 'Teselar (triangular polígonos)', q: '3d:tessellate', a: '—', in: ['polygon'], run: (fs) => fs.flatMap((f) => T.tesselate(f).features.map((t) => out(f, t))) },
    { id: 'delaunay', g: 'Geometría', n: 'Triangulación de Delaunay', q: 'native:delaunaytriangulation', a: 'CreateTin', run: (fs) => T.tin(T.explode(FC(fs))).features.map((t) => out(null, t)) },
    { id: 'voronoi', g: 'Geometría', n: 'Polígonos de Voronoi (Thiessen)', q: 'native:voronoipolygons', a: 'CreateThiessenPolygons', in: ['point'], p: [N('pad', 'Margen alrededor de los puntos (%)', 20, { min: 0 })],
      run: (fs, p) => { const b = T.bbox(FC(fs)), mx = ((b[2] - b[0]) * p.pad) / 100 || 0.01, my = ((b[3] - b[1]) * p.pad) / 100 || 0.01; return T.voronoi(FC(fs), { bbox: [b[0] - mx, b[1] - my, b[2] + mx, b[3] + my] }).features.map((v, i) => v && out(fs[i], v)).filter(Boolean); } },
    { id: 'extend', g: 'Geometría', n: 'Extender líneas', q: 'native:extendlines', a: 'ExtendLine', in: ['line'], p: [N('s', 'Al inicio (m)', 100, { min: 0 }), N('e', 'Al final (m)', 100, { min: 0 })],
      run: (fs, p) => fs.map((f) => { const c = f.geometry.coordinates, n = c.length; return out(f, T.lineString([...(p.s ? [T.destination(c[0], km(p.s), T.bearing(c[1], c[0])).geometry.coordinates] : []), ...c, ...(p.e ? [T.destination(c[n - 1], km(p.e), T.bearing(c[n - 2], c[n - 1])).geometry.coordinates] : [])])); }) },
    { id: 'substring', g: 'Geometría', n: 'Subcadena de línea', q: 'native:linesubstring', a: 'TrimLine', in: ['line'], p: [N('a', 'Desde (m)', 0, { min: 0 }), N('b', 'Hasta (m; 0 = hasta el final)', 0, { min: 0 })],
      run: (fs, p) => each(fs, (f) => { const len = T.length(f), b = p.b ? Math.min(len, km(p.b)) : len; return km(p.a) < b && out(f, T.lineSliceAlong(f, km(p.a), b)); }) },
    { id: 'chunk', g: 'Geometría', n: 'Dividir líneas por longitud', q: 'native:splitlinesbylength', a: 'GeneratePointsAlongLines + SplitLineAtPoint', in: ['line'], p: [N('d', 'Longitud de cada tramo (m)', 1000, { min: 0.01 })],
      run: (fs, p) => fs.flatMap((f) => T.lineChunk(f, km(p.d)).features.map((s, i) => out(f, s, { tramo: i + 1 }))) },
    { id: 'splitlines', g: 'Geometría', n: 'Dividir con líneas', q: 'native:splitwithlines', a: 'Split / SplitLineAtPoint', in: ['line', 'polygon'], p: [LY('ov', 'Líneas de corte')],
      run: (fs, p) => { const cut = p.ov.filter(isLine); need(cut.length, 'La capa de corte no tiene líneas.'); return fs.flatMap((f) => { let parts = [f]; for (const c of cut) { if (!other(f, c)) continue; parts = parts.flatMap((x) => { if (!hit(x, c)) return [x]; if (isLine(x)) { const s = T.lineSplit(x, c).features; return s.length ? s : [x]; } const s = OGE.splitPolygon(x, c); return s ? T.flatten(s).features : [x]; }); } return parts.map((x) => out(f, x)); }); } },
    { id: 'lineint', g: 'Geometría', n: 'Intersecciones de líneas', q: 'native:lineintersections', a: 'Intersect (salida de puntos)', in: ['line', 'polygon'], p: [LY('ov', 'Segunda capa (líneas o polígonos)')],
      run: (fs, p) => fs.flatMap((f) => p.ov.filter((g) => other(f, g) && !isPoint(g) && hit(f, g)).flatMap((g) => T.lineIntersect(f, g).features.map((x) => out(f, x, { cruza_con: g.oge.name })))) },
    { id: 'mergelines', g: 'Geometría', n: 'Unir líneas', q: 'native:mergelines', a: 'UnsplitLine / Dissolve', in: ['line'], run: (fs) => mergeLines(fs).map((c) => out(null, T.lineString(c))) },
    { id: 'pts2path', g: 'Geometría', n: 'Puntos a ruta', q: 'native:pointstopath', a: 'PointsToLine', in: ['point'], p: [X('order', 'Campo de orden (vacío = orden de la capa)'), B('close', 'Cerrar la ruta')],
      run: (fs, p) => { need(fs.length > 1, 'Se necesitan al menos dos puntos.'); const c = (p.order ? fs.slice().sort((a, b) => cmp(valueOf(a, p.order), valueOf(b, p.order))) : fs).map((f) => f.geometry.coordinates); return [out(null, T.lineString(p.close ? [...c, c[0]] : c))]; } },
    { id: 'along', g: 'Geometría', n: 'Puntos a lo largo de líneas', q: 'native:pointsalonglines', a: 'GeneratePointsAlongLines', in: ['line', 'polygon'], p: [N('d', 'Separación (m)', 500, { min: 0.01 })],
      run: (fs, p) => fs.flatMap((f) => { const l = asLine(f), len = T.length(l), r = []; need(len / km(p.d) < 20000, 'Demasiados puntos: aumenta la separación.'); for (let d = 0; d <= len + 1e-9; d += km(p.d)) r.push(out(f, T.along(l, d), { distancia_m: Math.round(d * 1000) })); return r; }) },
    { id: 'transect', g: 'Geometría', n: 'Transectos (líneas perpendiculares)', q: 'native:transect', a: 'GenerateTransectsAlongLines', in: ['line'], p: [N('len', 'Largo de cada transecto (m)', 500, { min: 0.01 }), N('d', 'Separación (m)', 1000, { min: 0.01 })],
      run: (fs, p) => fs.flatMap((f) => { const len = T.length(f), r = []; for (let d = 0; d <= len + 1e-9; d += km(p.d)) { const a = T.along(f, d), br = T.bearing(T.along(f, Math.max(0, d - 0.001)), T.along(f, Math.min(len, d + 0.001))); r.push(out(f, T.lineString([T.destination(a, km(p.len / 2), br - 90).geometry.coordinates, T.destination(a, km(p.len / 2), br + 90).geometry.coordinates]), { distancia_m: Math.round(d * 1000) })); } return r; }) },
    { id: 'geodesic', g: 'Geometría', n: 'Línea geodésica entre puntos', q: 'native:pointstopath (geodésica)', a: 'XYToLine (GEODESIC)', in: ['point'],
      run: (fs) => { need(fs.length > 1, 'Se necesitan al menos dos puntos.'); return fs.slice(1).map((f, i) => named(out(null, T.greatCircle(fs[i], f, { npoints: 64 }), { km: +T.distance(fs[i], f).toFixed(3) }), `${fs[i].oge.name} → ${f.oge.name}`)); } },
    { id: 'shapes', g: 'Geometría', n: 'Rectángulos, óvalos y rombos', q: 'native:rectanglesovalsdiamonds', a: '—', in: ['point'], p: [S('s', 'Forma', [['r', 'Rectángulo'], ['o', 'Óvalo'], ['d', 'Rombo']]), N('w', 'Ancho (m)', 1000, { min: 0.01 }), N('h', 'Alto (m)', 500, { min: 0.01 }), N('rot', 'Rotación (°)', 0)],
      run: (fs, p) => fs.map((f) => { if (p.s === 'o') return out(f, T.ellipse(f, km(p.w / 2), km(p.h / 2), { angle: p.rot, steps: 64 })); const d = (m, br) => T.destination(f, km(m), br).geometry.coordinates, hw = p.w / 2, hh = p.h / 2;
        const pts = p.s === 'd' ? [d(hh, 0), d(hw, 90), d(hh, 180), d(hw, 270)] : [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([sx, sy]) => d(Math.hypot(hw, hh), (Math.atan2(sx * hw, sy * hh) * 180) / Math.PI));
        return out(f, T.transformRotate(T.polygon([[...pts, pts[0]]]), p.rot, { pivot: f.geometry.coordinates })); }) },
    { id: 'fix', g: 'Geometría', n: 'Reparar geometrías', q: 'native:fixgeometries / removeduplicatevertices / forcerhr', a: 'RepairGeometry', run: (fs) => each(fs, (f) => { const g = fix(f); return g && out(f, g); }) },
    { id: 'validity', g: 'Geometría', n: 'Comprobar validez', q: 'qgis:checkvalidity', a: 'CheckGeometry', in: ['line', 'polygon'],
      run: (fs) => { const errs = fs.flatMap((f) => T.kinks(f).features.map((k) => named(out(f, k, { error: 'autointersección' }), 'Error en ' + (f.oge.name || 'objeto')))); return errs.length ? errs : { msg: 'Todas las geometrías son válidas: no hay autointersecciones.' }; } },
    { id: 'dupes', g: 'Geometría', n: 'Eliminar geometrías duplicadas', q: 'native:deleteduplicategeometries', a: 'DeleteIdentical',
      run: (fs) => { const seen = new Set(), r = fs.filter((f) => { const k = JSON.stringify(f.geometry); if (seen.has(k)) return false; seen.add(k); return true; }); return { features: r.map((f) => out(f, f)), msg: `${fs.length - r.length} duplicados eliminados.` }; } },
    { id: 'snaplayer', g: 'Geometría', n: 'Ajustar geometrías a capa', q: 'native:snapgeometries', a: 'Snap / Integrate', p: [LY('ov', 'Capa de referencia'), N('tol', 'Tolerancia (m)', 50, { min: 0.001 })],
      run: (fs, p) => fs.map((f) => { const refs = p.ov.filter((g) => other(f, g)), g = T.clone(f); T.coordEach(g, (c) => { let best = null, bd = p.tol; for (const r of refs) { if (distM(c, r) >= bd) continue; const q = nearestOn(c, r), d = T.distance(c, q) * 1000; if (d < bd) { bd = d; best = q; } } if (best) { c[0] = best[0]; c[1] = best[1]; } }); return out(f, g); }) },
    { id: 'snapgrid', g: 'Geometría', n: 'Ajustar a rejilla', q: 'native:snappointstogrid', a: 'Integrate (XY tolerance)', p: [N('s', 'Espaciado (grados)', 0.001, { min: 1e-9 })],
      run: (fs, p) => each(fs, (f) => { const g = T.clone(f); T.coordEach(g, (c) => { c[0] = Math.round(c[0] / p.s) * p.s; c[1] = Math.round(c[1] / p.s) * p.s; }); return out(f, g); }) },

    // ===== Superposición vectorial =====
    { id: 'clip', g: 'Superposición', n: 'Recortar', q: 'native:clip', a: 'Clip', p: [LY('ov', 'Capa de recorte (polígonos)')],
      run: (fs, p) => { const mask = U(p.ov.filter(isPoly)); need(mask, 'La capa de recorte no tiene polígonos.'); return each(fs, (f) => clipTo(f, mask)); } },
    { id: 'erase', g: 'Superposición', n: 'Diferencia (borrar)', q: 'native:difference', a: 'Erase', p: [LY('ov', 'Capa que se resta (polígonos)')],
      run: (fs, p) => each(fs, (f) => { const m = U(p.ov.filter((g) => isPoly(g) && other(f, g) && hit(f, g))); return m ? eraseFrom(f, m) : out(f, f); }) },
    { id: 'intersection', g: 'Superposición', n: 'Intersección', q: 'native:intersection', a: 'Intersect', p: [LY('ov', 'Capa de superposición (polígonos)')],
      run: (fs, p) => fs.flatMap((f) => p.ov.filter((g) => isPoly(g) && other(f, g) && hit(f, g)).flatMap((g) => { const r = clipTo(f, g); return (Array.isArray(r) ? r : r ? [r] : []).map((x) => { x.properties = { ...g.properties, ...x.properties }; return x; }); })) },
    { id: 'union', g: 'Superposición', n: 'Unión (superposición)', q: 'native:union', a: 'Union', in: ['polygon'], p: [LY('ov', 'Capa de superposición (polígonos)')],
      run: (fs, p) => { const Bs = p.ov.filter(isPoly), r = []; for (const a of fs) { const hs = Bs.filter((b) => other(a, b) && hit(a, b)); for (const b of hs) { const x = inter(a, b); if (x) r.push(out(a, x, b.properties)); } const d = diff(a, hs); if (d) r.push(out(a, d)); } for (const b of Bs) { const d = diff(b, fs.filter((a) => other(a, b) && hit(a, b))); if (d) r.push(out(b, d)); } return r; } },
    { id: 'symdiff', g: 'Superposición', n: 'Diferencia simétrica', q: 'native:symmetricaldifference', a: 'SymDiff', in: ['polygon'], p: [LY('ov', 'Capa de superposición (polígonos)')],
      run: (fs, p) => { const Bs = p.ov.filter(isPoly), part = (x, ys) => { const d = diff(x, ys.filter((y) => other(x, y) && hit(x, y))); return d ? [out(x, d)] : []; }; return [...fs.flatMap((a) => part(a, Bs)), ...Bs.flatMap((b) => part(b, fs))]; } },
    { id: 'identity', g: 'Superposición', n: 'Identidad', q: 'native:union (parte de la entrada)', a: 'Identity', in: ['polygon'], p: [LY('ov', 'Capa de identidad (polígonos)')],
      run: (fs, p) => fs.flatMap((a) => { const hs = p.ov.filter((b) => isPoly(b) && other(a, b) && hit(a, b)), r = []; for (const b of hs) { const x = inter(a, b); if (x) r.push(out(a, x, b.properties)); } const d = diff(a, hs); if (d) r.push(out(a, d)); return r; }) },
    { id: 'update', g: 'Superposición', n: 'Actualizar', q: 'native:difference + mergevectorlayers', a: 'Update', in: ['polygon'], p: [LY('ov', 'Capa de actualización (polígonos)')],
      run: (fs, p) => { const Bs = p.ov.filter(isPoly); return [...each(fs, (a) => { const d = diff(a, Bs.filter((b) => other(a, b) && hit(a, b))); return d && out(a, d); }), ...Bs.map((b) => out(b, b))]; } },
    { id: 'extent', g: 'Superposición', n: 'Extraer o recortar por la vista actual', q: 'native:extractbyextent', a: 'Clip (extensión)', p: [B('clip', 'Recortar los objetos en el borde', true)],
      run: (fs, p) => { const m = T.bboxPolygon(view()); return p.clip ? each(fs, (f) => clipTo(f, m)) : fs.filter((f) => T.booleanIntersects(f, m)).map((f) => out(f, f)); } },
    { id: 'overlaps', g: 'Superposición', n: 'Análisis de solape', q: 'native:calculatevectoroverlaps', a: 'TabulateIntersection', in: ['polygon'], p: [LY('ov', 'Capa de superposición (polígonos)')],
      run: (fs, p) => fs.map((f) => { const m = U(p.ov.filter((g) => isPoly(g) && other(f, g) && hit(f, g))), x = m && inter(f, m), a = T.area(f), o = x ? T.area(x) : 0; return out(f, f, { area_m2: Math.round(a), solape_m2: Math.round(o), solape_pct: +((100 * o) / a).toFixed(2) }); }) },
    { id: 'neighbors', g: 'Superposición', n: 'Vecinos de polígonos', q: '—', a: 'PolygonNeighbors', in: ['polygon'],
      run: (fs) => { const rows = []; for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) if (hit(fs[i], fs[j]) && T.booleanIntersects(fs[i], fs[j])) { const x = inter(T.buffer(fs[i], 0.0005), fs[j]); rows.push([fs[i].oge.name, fs[j].oge.name, x ? +(T.area(x) / 0.5 / 1000).toFixed(3) : 0]); } return { table: [['Polígono', 'Vecino', 'Borde compartido aprox. (km)'], rows], note: `${rows.length} pares de polígonos que se tocan.` }; } },

    // ===== Selección =====
    { id: 'selattr', g: 'Selección', n: 'Seleccionar por atributo', q: 'native:extractbyattribute', a: 'SelectLayerByAttribute / Select', p: [X('field', 'Campo («nombre» = el nombre del objeto)', 'nombre'), S('op', 'Operador', ['=', '≠', '>', '<', '≥', '≤', 'contiene', 'empieza con', 'está vacío']), X('v', 'Valor'), MODE],
      run: (fs, p) => selOrNew(fs.filter((f) => test(valueOf(f, p.field), p.op, p.v)), p) },
    { id: 'selexpr', g: 'Selección', n: 'Seleccionar por expresión', q: 'native:extractbyexpression', a: 'SelectLayerByAttribute (SQL)', p: [X('e', 'Expresión (JavaScript)', '$area > 1e6'), MODE],
      h: 'Usa los campos por su nombre y además: nombre, $area y $perimeter (m² y m), $length (m), $x, $y, $id. Ejemplo: poblacion > 5000 && nombre.startsWith("San")',
      run: (fs, p) => { const ev = compile(p.e); return selOrNew(fs.filter((f, i) => ev(f, i)), p); } },
    { id: 'selloc', g: 'Selección', n: 'Seleccionar por localización', q: 'native:extractbylocation / extractwithindistance', a: 'SelectLayerByLocation',
      p: [LY('ov', 'Comparar con'), S('pred', 'Los objetos que…', [['intersects', 'intersecan'], ['within', 'están dentro de'], ['contains', 'contienen a'], ['disjoint', 'no tocan'], ['dist', 'están a menos de la distancia']]), N('d', 'Distancia (m; solo para la última opción)', 1000, { min: 0 }), MODE],
      run: (fs, p) => { const rel = (f, g) => { try { return p.pred === 'within' ? T.booleanWithin(f, g) : p.pred === 'contains' ? T.booleanContains(f, g) : T.booleanIntersects(f, g); } catch { return false; } };
        const ok = (f) => { const os = p.ov.filter((g) => other(f, g)); if (p.pred === 'dist') return os.some((g) => distM(anchor(f), g) <= p.d || (!isPoint(f) && T.booleanIntersects(f, g))); const any = os.some((g) => hit(f, g) && rel(f, g)); return p.pred === 'disjoint' ? !os.some((g) => hit(f, g) && T.booleanIntersects(f, g)) : any; };
        return selOrNew(fs.filter(ok), p); } },
    { id: 'random', g: 'Selección', n: 'Selección aleatoria', q: 'native:randomextract', a: 'SubsetFeatures', p: [N('n', 'Cantidad', 10, { min: 1, step: 1 }), MODE],
      run: (fs, p) => selOrNew(fs.map((f) => [Math.random(), f]).sort((a, b) => a[0] - b[0]).slice(0, p.n).map((x) => x[1]), p) },
    { id: 'bytype', g: 'Selección', n: 'Filtrar por tipo de geometría', q: 'native:filterbygeometry', a: 'Select (SHAPE)', p: [S('t', 'Tipo', [['point', 'Puntos'], ['line', 'Líneas'], ['polygon', 'Polígonos']]), MODE],
      run: (fs, p) => selOrNew(fs.filter((f) => kindOf(f) === p.t), p) },

    // ===== Análisis =====
    { id: 'countpts', g: 'Análisis', n: 'Contar puntos en polígonos', q: 'native:countpointsinpolygon', a: 'SpatialJoin (COUNT)', in: ['polygon'], p: [LY('ov', 'Capa de puntos'), X('field', 'Campo numérico a sumar (opcional)')],
      run: (fs, p) => { const pts = p.ov.filter(isPoint); return { features: fs.map((f) => { const inP = pts.filter((q) => T.booleanPointInPolygon(q, f)), ex = { NUMPOINTS: inP.length }; if (p.field) ex['suma_' + p.field] = inP.reduce((s, q) => s + (+q.properties[p.field] || 0), 0); return out(f, f, ex); }), colorBy: 'NUMPOINTS', graduated: true }; } },
    { id: 'joinloc', g: 'Análisis', n: 'Unir atributos por localización', q: 'native:joinattributesbylocation', a: 'SpatialJoin', p: [LY('ov', 'Capa con los atributos a traer')],
      run: (fs, p) => fs.map((f) => { const g = p.ov.find((o) => other(f, o) && hit(f, o) && T.booleanIntersects(f, o)); return out(f, f, g ? { ...g.properties, unido_con: g.oge.name, ...f.properties } : {}); }) },
    { id: 'near', g: 'Análisis', n: 'Unir al más cercano (distancia)', q: 'native:joinbynearest', a: 'Near / SpatialJoin (CLOSEST)', p: [LY('ov', 'Capa de destino')], h: 'La distancia se mide desde el punto (o el centroide del objeto) hasta el borde del destino.',
      run: (fs, p) => fs.map((f) => { const c = anchor(f); let best = null, bd = Infinity; for (const g of p.ov) { if (!other(f, g)) continue; const d = distM(c, g); if (d < bd) { bd = d; best = g; } } return out(f, f, best ? { cercano: best.oge.name, distancia_m: Math.round(bd) } : {}); }) },
    { id: 'distmatrix', g: 'Análisis', n: 'Matriz de distancias', q: 'qgis:distancematrix', a: 'PointDistance / GenerateNearTable', p: [LY('ov', 'Capa de destino'), N('k', 'Solo los k más cercanos (0 = todos)', 0, { min: 0, step: 1 })],
      run: (fs, p) => { const rows = []; for (const f of fs) { const c = anchor(f); let r = p.ov.filter((g) => other(f, g)).map((g) => [f.oge.name, g.oge.name, Math.round(distM(c, g))]).sort((a, b) => a[2] - b[2]); if (p.k) r = r.slice(0, p.k); rows.push(...r); } need(rows.length <= 200000, 'Demasiadas filas: usa los k más cercanos.'); return { table: [['Origen', 'Destino', 'Distancia (m)'], rows] }; } },
    { id: 'shortest', g: 'Análisis', n: 'Línea más corta entre objetos', q: 'native:shortestline', a: 'Near (con líneas)', p: [LY('ov', 'Capa de destino')],
      run: (fs, p) => each(fs, (f) => { const c = anchor(f); let best = null, bd = Infinity; for (const g of p.ov) { if (!other(f, g)) continue; const d = distM(c, g); if (d < bd) { bd = d; best = g; } } return best && bd > 0 && named(out(f, T.lineString([c, nearestOn(c, best)]), { hasta: best.oge.name, distancia_m: Math.round(bd) }), `${f.oge.name} → ${best.oge.name}`); }) },
    { id: 'nna', g: 'Análisis', n: 'Análisis de vecino más próximo', q: 'native:nearestneighbouranalysis', a: 'AverageNearestNeighbor', in: ['point'],
      run: (fs) => { need(fs.length > 2, 'Se necesitan al menos tres puntos.'); const a = T.nearestNeighborAnalysis(FC(fs)).properties.nearestNeighborAnalysis; return { table: [['Medida', 'Valor'], [['Distancia media observada (km)', a.observedMeanDistance], ['Distancia media esperada (km)', a.expectedMeanDistance], ['Índice de vecino más próximo', a.nearestNeighborIndex], ['Número de puntos', a.numberOfPoints], ['Puntuación Z', a.zScore]]], note: 'Índice < 1: agrupados; ≈ 1: aleatorios; > 1: dispersos.' }; } },
    { id: 'mean', g: 'Análisis', n: 'Coordenadas medias (centro medio)', q: 'native:meancoordinates', a: 'MeanCenter', p: [X('w', 'Campo de peso (opcional)')],
      run: (fs, p) => [named(out(null, T.centerMean(FC(fs.map((f) => T.point(anchor(f), f.properties))), p.w ? { weight: p.w } : {})), 'Centro medio')] },
    { id: 'sde', g: 'Análisis', n: 'Elipse de desviación estándar', q: '—', a: 'DirectionalDistribution', in: ['point'],
      run: (fs) => { need(fs.length > 2, 'Se necesitan al menos tres puntos.'); return [named(out(null, T.standardDeviationalEllipse(FC(fs))), 'Elipse de desviación estándar')]; } },
    { id: 'sumlen', g: 'Análisis', n: 'Sumar longitudes de líneas por polígono', q: 'native:sumlinelengths', a: 'SummarizeWithin', in: ['polygon'], p: [LY('ov', 'Capa de líneas')],
      run: (fs, p) => ({ features: fs.map((f) => { const parts = p.ov.filter((l) => isLine(l) && hit(f, l)).flatMap((l) => clipTo(l, f) || []); return out(f, f, { LENGTH_km: +parts.reduce((s, x) => s + T.length(x), 0).toFixed(3), COUNT: parts.length }); }), colorBy: 'LENGTH_km', graduated: true }) },
    { id: 'stats', g: 'Análisis', n: 'Estadísticas básicas de un campo', q: 'native:basicstatisticsforfields', a: 'Statistics', p: [X('field', 'Campo numérico')],
      run: (fs, p) => { const v = nums(fs, p.field); need(v.length, 'El campo «' + p.field + '» no tiene valores numéricos.'); return { table: [STAT_COLS, [statRow(p.field, v)]] }; } },
    { id: 'unique', g: 'Análisis', n: 'Valores únicos y frecuencia', q: 'qgis:listuniquevalues', a: 'Frequency', p: [X('field', 'Campo («nombre» = el nombre)', 'nombre')],
      run: (fs, p) => { const m = new Map(); for (const f of fs) { const k = String(valueOf(f, p.field) ?? ''); m.set(k, (m.get(k) || 0) + 1); } return { table: [[p.field, 'cuenta'], [...m].sort((a, b) => b[1] - a[1])] }; } },
    { id: 'statscat', g: 'Análisis', n: 'Estadísticas por categorías', q: 'qgis:statisticsbycategories', a: 'Statistics (case field)', p: [X('cat', 'Campo de categoría', 'nombre'), X('field', 'Campo numérico')],
      run: (fs, p) => { const m = new Map(); for (const f of fs) { const k = String(valueOf(f, p.cat) ?? ''), v = Number(f.properties[p.field]); if (!Number.isFinite(v)) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(v); } need(m.size, 'No hay valores numéricos en «' + p.field + '».'); return { table: [[p.cat, ...STAT_COLS.slice(1)], [...m].map(([k, v]) => statRow(k, v))] }; } },
    { id: 'dbscan', g: 'Análisis', n: 'Agrupamiento DBSCAN', q: 'native:dbscanclustering', a: 'DensityBasedClustering', in: ['point'], p: [N('d', 'Distancia máxima entre vecinos (m)', 1000, { min: 0.01 }), N('min', 'Tamaño mínimo del grupo', 3, { min: 1, step: 1 })],
      run: (fs, p) => ({ features: T.clustersDbscan(FC(fs.map((f) => T.point(f.geometry.coordinates))), km(p.d), { minPoints: p.min }).features.map((c, i) => out(fs[i], fs[i], { CLUSTER_ID: c.properties.cluster ?? -1 })), colorBy: 'CLUSTER_ID' }) },
    { id: 'kmeans', g: 'Análisis', n: 'Agrupamiento K-medias', q: 'native:kmeansclustering', a: 'MultivariateClustering', in: ['point'], p: [N('k', 'Número de grupos', 5, { min: 1, step: 1 })],
      run: (fs, p) => ({ features: T.clustersKmeans(FC(fs.map((f) => T.point(f.geometry.coordinates))), { numberOfClusters: Math.min(p.k, fs.length) }).features.map((c, i) => out(fs[i], fs[i], { CLUSTER_ID: c.properties.cluster })), colorBy: 'CLUSTER_ID' }) },
    { id: 'hexbin', g: 'Análisis', n: 'Agregar puntos en hexágonos', q: 'native:creategrid + countpointsinpolygon', a: 'AggregatePoints / GenerateTessellation', in: ['point'], p: [N('cell', 'Tamaño del hexágono (km)', 5, { min: 0.001 })],
      run: (fs, p) => { const b = T.bbox(T.buffer(T.bboxPolygon(T.bbox(FC(fs))), p.cell)); need(viewKm2(b) / (p.cell * p.cell) < 40000, 'Demasiadas celdas: aumenta el tamaño.'); return { features: T.hexGrid(b, p.cell, { units: 'kilometers' }).features.map((h) => out(null, h, { NUMPOINTS: fs.filter((q) => T.booleanPointInPolygon(q, h)).length })).filter((h) => h.properties.NUMPOINTS), colorBy: 'NUMPOINTS', graduated: true }; } },
    { id: 'idw', g: 'Análisis', n: 'Interpolación IDW', q: 'qgis:idwinterpolation', a: 'IDW', in: ['point'], p: [X('field', 'Campo con el valor'), N('cell', 'Tamaño de celda (km)', 1, { min: 0.001 }), N('w', 'Exponente de la distancia', 2, { min: 0.1 })],
      run: (fs, p) => { const pts = fs.filter((f) => Number.isFinite(Number(f.properties[p.field])) && f.properties[p.field] !== '').map((f) => T.point(f.geometry.coordinates, { v: Number(f.properties[p.field]) })); need(pts.length > 1, 'El campo «' + p.field + '» necesita valores numéricos en al menos dos puntos.'); need(viewKm2(T.bbox(FC(pts))) / (p.cell * p.cell) < 20000, 'Demasiadas celdas: aumenta el tamaño.');
        return { features: T.interpolate(FC(pts), p.cell, { gridType: 'square', property: 'v', units: 'kilometers', weight: p.w }).features.map((c) => out(null, c, { [p.field]: +c.properties.v.toFixed(4) })), colorBy: p.field, graduated: true, style: { width: 0, fillOpacity: 0.6 } }; } },
    { id: 'isolines', g: 'Análisis', n: 'Isolíneas desde puntos', q: 'Interpolación + gdal:contour', a: 'IDW + Contour', in: ['point'], p: [X('field', 'Campo con el valor'), N('int', 'Equidistancia', 10, { min: 1e-9 }), N('cell', 'Resolución de la rejilla (km)', 1, { min: 0.001 })],
      run: (fs, p) => { const pts = fs.filter((f) => Number.isFinite(Number(f.properties[p.field])) && f.properties[p.field] !== '').map((f) => T.point(f.geometry.coordinates, { v: Number(f.properties[p.field]) })); need(pts.length > 2, 'El campo «' + p.field + '» necesita valores numéricos en al menos tres puntos.'); need(viewKm2(T.bbox(FC(pts))) / (p.cell * p.cell) < 40000, 'Demasiadas celdas: aumenta la resolución.');
        const grid = T.interpolate(FC(pts), p.cell, { gridType: 'point', property: 'v', units: 'kilometers' }), vs = grid.features.map((f) => f.properties.v), lo = Math.min(...vs), hi = Math.max(...vs), br = [];
        for (let v = Math.ceil(lo / p.int) * p.int; v <= hi; v += p.int) br.push(+v.toFixed(9)); need(br.length && br.length <= 200, 'Ajusta la equidistancia: saldrían ' + br.length + ' curvas.');
        return { features: T.isolines(grid, br, { zProperty: 'v' }).features.filter((f) => f.geometry.coordinates.length).map((f) => named(out(null, f, { [p.field]: f.properties.v }), f.properties.v)), colorBy: p.field, graduated: true }; } },

    // ===== Creación de vectores =====
    { id: 'grid', g: 'Creación', n: 'Crear rejilla (vista actual)', q: 'native:creategrid / regularpoints', a: 'CreateFishnet / GenerateTessellation', noIn: true, p: [S('t', 'Tipo', [['square', 'Cuadrados'], ['hex', 'Hexágonos'], ['triangle', 'Triángulos'], ['point', 'Puntos']]), N('cell', 'Tamaño de celda (km)', 10, { min: 0.001 })],
      run: (fs, p) => { const b = view(); need(viewKm2(b) / (p.cell * p.cell) < 20000, 'Demasiadas celdas: acércate o aumenta el tamaño.'); return { square: T.squareGrid, hex: T.hexGrid, triangle: T.triangleGrid, point: T.pointGrid }[p.t](b, p.cell, { units: 'kilometers' }).features.map((f, i) => out(null, f, { id: i + 1 })); } },
    { id: 'randext', g: 'Creación', n: 'Puntos aleatorios (vista actual)', q: 'native:randompointsinextent', a: 'CreateRandomPoints', noIn: true, p: [N('n', 'Cantidad', 100, { min: 1, max: 50000, step: 1 })],
      run: (fs, p) => T.randomPoint(p.n, { bbox: view() }).features.map((f, i) => out(null, f, { id: i + 1 })) },
    { id: 'randpoly', g: 'Creación', n: 'Puntos aleatorios en polígonos', q: 'native:randompointsinpolygons', a: 'CreateRandomPoints (constraining)', in: ['polygon'], p: [N('n', 'Puntos por polígono', 10, { min: 1, max: 5000, step: 1 })],
      run: (fs, p) => fs.flatMap((f) => { const b = T.bbox(f), r = []; for (let t = 0; r.length < p.n && t < p.n * 200; t++) { const q = [b[0] + Math.random() * (b[2] - b[0]), b[1] + Math.random() * (b[3] - b[1])]; if (T.booleanPointInPolygon(q, f)) r.push(out(f, T.point(q), { id: r.length + 1 })); } return r; }) },
    { id: 'randline', g: 'Creación', n: 'Puntos aleatorios sobre líneas', q: 'native:randompointsonlines', a: 'CreateRandomPoints (sobre líneas)', in: ['line', 'polygon'], p: [N('n', 'Puntos por línea', 10, { min: 1, max: 5000, step: 1 })],
      run: (fs, p) => fs.flatMap((f) => { const l = asLine(f), len = T.length(l); return Array.from({ length: p.n }, (_, i) => out(f, T.along(l, Math.random() * len), { id: i + 1 })); }) },
    { id: 'project', g: 'Creación', n: 'Proyectar puntos (rumbo y distancia)', q: 'native:projectpointcartesian', a: 'BearingDistanceToLine', in: ['point'], p: [N('az', 'Rumbo (°)', 0), N('d', 'Distancia (m)', 1000), B('line', 'Dibujar también la línea')],
      run: (fs, p) => fs.flatMap((f) => { const q = T.destination(f, km(p.d), p.az); return [out(f, q), ...(p.line ? [out(f, T.lineString([f.geometry.coordinates, q.geometry.coordinates]))] : [])]; }) },
    { id: 'viewpoly', g: 'Creación', n: 'Extensión de la vista a polígono', q: 'native:extenttolayer', a: 'MapExtent → polígono', noIn: true, run: () => [named(out(null, T.bboxPolygon(view())), 'Extensión de la vista')] },
    { id: 'osm', g: 'Creación', n: 'Descargar de OpenStreetMap (vista actual)', q: 'Complemento QuickOSM', a: '—', noIn: true, net: true, p: [X('key', 'Clave OSM', 'highway'), X('val', 'Valor (vacío = cualquiera)', 'primary')],
      h: 'Ejemplos: highway=primary, waterway=river, boundary=administrative, amenity=school, natural=water.',
      run: async (fs, p) => { const b = view(); need((b[2] - b[0]) * (b[3] - b[1]) < 4, 'La vista es demasiado amplia: acércate.'); const cl = (s) => s.trim().replace(/["\\\]\[]/g, ''), key = cl(p.key), val = cl(p.val); need(key, 'Falta la clave.');
        const sel = `["${key}"${val ? `="${val}"` : ''}]`, bbx = `${b[1]},${b[0]},${b[3]},${b[2]}`, js = await OGE.overpass(`[out:json][timeout:50];(node${sel}(${bbx});way${sel}(${bbx}););out tags geom 5000;`);
        return js.elements.map((e) => { const pr = { ...e.tags, osm_id: e.type + '/' + e.id }; if (e.type === 'node') return { type: 'Feature', geometry: { type: 'Point', coordinates: [e.lon, e.lat] }, properties: pr }; const c = e.geometry.map((q) => [q.lon, q.lat]), closed = c.length > 3 && c[0][0] === c.at(-1)[0] && c[0][1] === c.at(-1)[1] && !/^(highway|barrier|railway|waterway)$/.test(key); return { type: 'Feature', geometry: closed ? { type: 'Polygon', coordinates: [c] } : { type: 'LineString', coordinates: c }, properties: pr }; }); } },

    // ===== Tabla de atributos =====
    { id: 'table', g: 'Atributos', n: 'Ver tabla de atributos', q: 'Tabla de atributos / exporttospreadsheet', a: 'Tabla de atributos / TableToExcel',
      run: (fs) => { const keys = [...new Set(fs.flatMap((f) => Object.keys(f.properties)))]; return { table: [['nombre', 'tipo', ...keys], fs.map((f) => [f.oge.name, TYPE[kindOf(f)], ...keys.map((k) => f.properties[k])])], rowEntities: fs.map((f) => f.entity), note: 'Clic en una fila para ir al objeto. El botón CSV la exporta.' }; } },
    { id: 'fieldcalc', g: 'Atributos', n: 'Calculadora de campos', q: 'native:fieldcalculator', a: 'CalculateField', p: [X('field', 'Campo a crear o actualizar', 'nuevo'), X('e', 'Expresión (JavaScript)', '$area / 1e6')],
      h: 'Usa los campos por su nombre y además: nombre, $area y $perimeter (m² y m), $length (m), $x, $y, $id. Ejemplos: $area / 1e6 · poblacion / ($area / 1e6) · nombre.toUpperCase()',
      run: (fs, p) => { need(p.field.trim(), 'Falta el nombre del campo.'); const ev = compile(p.e); return withProps(fs, (f, i) => { const v = ev(f, i); return { [p.field.trim()]: typeof v === 'number' ? +v.toFixed(6) : v }; }); } },
    { id: 'geomattrs', g: 'Atributos', n: 'Añadir atributos de geometría', q: 'qgis:exportaddgeometrycolumns / addxyfields', a: 'AddGeometryAttributes / AddXY',
      run: (fs) => withProps(fs, (f) => { const c = anchor(f), k = kindOf(f); return k === 'point' ? { lon: c[0], lat: c[1] } : k === 'line' ? { longitud_m: Math.round(T.length(f) * 1000) } : { area_m2: Math.round(T.area(f)), perimetro_m: Math.round(T.length(f) * 1000), lon: +c[0].toFixed(6), lat: +c[1].toFixed(6) }; }) },
    { id: 'autoinc', g: 'Atributos', n: 'Añadir campo autoincremental', q: 'native:addautoincrementalfield', a: 'CalculateField (secuencia)', p: [X('field', 'Nombre del campo', 'id'), N('start', 'Empezar en', 1, { step: 1 })],
      run: (fs, p) => withProps(fs, (f, i) => ({ [p.field.trim() || 'id']: p.start + i })) },
    { id: 'delfield', g: 'Atributos', n: 'Eliminar campo', q: 'native:deletecolumn', a: 'DeleteField', p: [X('field', 'Campo a eliminar')],
      run: (fs, p) => { setProps(fs.map((f) => { const q = { ...f.properties }; delete q[p.field]; return [f.entity, q]; })); return { msg: 'Campo «' + p.field + '» eliminado de ' + fs.length + ' objetos.' }; } },
    { id: 'renfield', g: 'Atributos', n: 'Renombrar campo', q: 'native:renametablefield', a: 'AlterField', p: [X('field', 'Campo actual'), X('to', 'Nombre nuevo')],
      run: (fs, p) => { need(p.to.trim(), 'Falta el nombre nuevo.'); setProps(fs.map((f) => { const q = {}; for (const [k, v] of Object.entries(f.properties)) q[k === p.field ? p.to.trim() : k] = v; return [f.entity, q]; })); return { msg: 'Campo renombrado.' }; } },

    // ===== Terreno (relieve en línea) =====
    { id: 'profile', g: 'Terreno', n: 'Perfil de elevación', q: 'Perfil de elevación / qgis:climbalongline', a: 'StackProfile / InterpolateShape', in: ['line'], net: true, h: 'Se usa la primera línea de la entrada.',
      run: async (fs) => { const f = fs[0], len = T.length(f), n = 300, pts = Array.from({ length: n }, (_, i) => T.along(f, (len * i) / (n - 1)).geometry.coordinates), z = await OGE.dem.sample(pts, OGE.dem.zoomFor((len * 1000) / n, pts[0][1])), xs = pts.map((_, i) => (len * i) / (n - 1));
        let up = 0, down = 0; for (let i = 1; i < n; i++) { const d = z[i] - z[i - 1]; if (d > 0) up += d; else down -= d; }
        return { title: 'Perfil de ' + (f.oge.name || 'trazado'), content: chart(xs, z), table: [['distancia_km', 'elevacion_m'], xs.map((x, i) => [+x.toFixed(3), z[i]])], note: `Longitud ${len.toFixed(2)} km · mínima ${Math.min(...z)} m · máxima ${Math.max(...z)} m · subida acumulada ${Math.round(up)} m · bajada ${Math.round(down)} m.` }; } },
    { id: 'drape', g: 'Terreno', n: 'Muestrear elevación', q: 'native:rastersampling / setzfromraster / zonalstatisticsfb', a: 'ExtractValuesToPoints / AddSurfaceInformation / ZonalStatistics', net: true, h: 'Añade campos: elev_m en puntos; z_min, z_max y z_media en líneas y polígonos.',
      run: async (fs) => { const res = []; for (const f of fs) { if (isPoint(f)) { res.push({ elev_m: (await OGE.dem.sample([f.geometry.coordinates], 12))[0] }); continue; }
        let pts; if (isLine(f)) { const len = T.length(f); pts = Array.from({ length: 100 }, (_, i) => T.along(f, (len * i) / 99).geometry.coordinates); } else { const b = T.bbox(f), side = Math.sqrt(viewKm2(b) / 400) || 0.01; pts = T.pointGrid(b, side, { units: 'kilometers', mask: f }).features.map((q) => q.geometry.coordinates); if (!pts.length) pts = [anchor(f)]; }
        const b = T.bbox(f), z = await OGE.dem.sample(pts, OGE.dem.zoomFor((Math.max(b[2] - b[0], b[3] - b[1]) * 111320) / 20, pts[0][1])); res.push({ z_min: Math.min(...z), z_max: Math.max(...z), z_media: Math.round(z.reduce((a, c) => a + c, 0) / z.length) }); }
        return withProps(fs, (f, i) => res[i]); } },
    { id: 'contours', g: 'Terreno', n: 'Curvas de nivel (vista actual)', q: 'gdal:contour', a: 'Contour', noIn: true, net: true, p: [N('int', 'Equidistancia (m)', 100, { min: 1 })],
      run: async (fs, p) => { const b = view(), g = await OGE.dem.grid(b, 110, 110), pts = []; let lo = Infinity, hi = -Infinity;
        for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) { const z = g.z[j * g.nx + i]; lo = Math.min(lo, z); hi = Math.max(hi, z); pts.push(T.point([b[0] + ((b[2] - b[0]) * i) / (g.nx - 1), b[3] - ((b[3] - b[1]) * j) / (g.ny - 1)], { z })); }
        const br = []; for (let v = Math.ceil(lo / p.int) * p.int; v <= hi; v += p.int) br.push(v); need(br.length, 'El relieve de la vista no alcanza una curva con esa equidistancia.'); need(br.length <= 150, 'Saldrían ' + br.length + ' curvas: aumenta la equidistancia.');
        return { features: T.isolines(FC(pts), br, { zProperty: 'z' }).features.filter((f) => f.geometry.coordinates.length).map((f) => named(out(null, f, { elev: f.properties.z }), f.properties.z + ' m')), style: { stroke: '#c8a165', width: 1.5 } }; } },
    { id: 'hillshade', g: 'Terreno', n: 'Sombreado del relieve (vista actual)', q: 'native:hillshade', a: 'Hillshade', noIn: true, net: true, run: () => terrainImage('hill') },
    { id: 'slope', g: 'Terreno', n: 'Pendiente (vista actual)', q: 'native:slope', a: 'Slope', noIn: true, net: true, run: () => terrainImage('slope') },
    { id: 'viewshed', g: 'Terreno', n: 'Cuenca visual', q: 'grass:r.viewshed', a: 'Viewshed (también en Earth Pro)', in: ['point'], net: true, p: [N('r', 'Radio (m)', 5000, { min: 100 }), N('h', 'Altura del observador sobre el suelo (m)', 2, { min: 0 })], h: 'Se usa el primer punto de la entrada. Lo verde es lo que se ve desde ahí.',
      run: async (fs, p) => { const c = fs[0].geometry.coordinates, n = 241, half = (n - 1) / 2, dLat = p.r / 110540, dLon = p.r / (111320 * Math.cos((c[1] * Math.PI) / 180)), b = [c[0] - dLon, c[1] - dLat, c[0] + dLon, c[1] + dLat];
        const g = await OGE.dem.grid(b, n, n), cell = (2 * p.r) / (n - 1), z0 = g.z[half * n + half] + p.h, vis = new Uint8Array(n * n);
        const ray = (ti, tj) => { const di = ti - half, dj = tj - half, steps = Math.max(Math.abs(di), Math.abs(dj)); let maxT = -Infinity; // una celda se ve si su ángulo supera el de todas las anteriores del rayo
          for (let s = 1; s <= steps; s++) { const i = Math.round(half + (di * s) / steps), j = Math.round(half + (dj * s) / steps), d = Math.hypot(i - half, j - half) * cell; if (d > p.r) break; const t = (g.z[j * n + i] - ((d * d) / (2 * 6371000)) * 0.87 - z0) / d; if (t >= maxT) { vis[j * n + i] = 1; maxT = t; } } };
        for (let k = 0; k < n; k++) { ray(k, 0); ray(k, n - 1); ray(0, k); ray(n - 1, k); }
        const cv = el('canvas', { width: n, height: n }), ctx = cv.getContext('2d'), img = ctx.createImageData(n, n); for (let i = 0; i < n * n; i++) if (vis[i]) { img.data[i * 4 + 1] = 230; img.data[i * 4 + 2] = 80; img.data[i * 4 + 3] = 255; } ctx.putImageData(img, 0, 0);
        return { image: { bbox: b, url: cv.toDataURL('image/png'), name: 'Cuenca visual de ' + (fs[0].oge.name || 'punto'), opacity: 0.55 } }; } },

    // ===== Cartografía =====
    { id: 'classify', g: 'Cartografía', n: 'Simbología por categorías o graduada', q: 'Simbología categorizada / graduada', a: 'Simbología: Unique Values / Graduated Colors', p: [X('field', 'Campo («nombre» = el nombre)', 'nombre'), S('m', 'Modo', [['cat', 'Categorías (un color por valor)'], ['grad', 'Graduado (rampa de color por valor numérico)']])],
      run: (fs, p) => { const col = colorer(fs.map((f) => valueOf(f, p.field)), p.m === 'grad'); setStyles(fs.map((f) => { const c = col(valueOf(f, p.field)); return [f.entity, { ...f.oge.style, stroke: c, fill: c, color: c }]; })); return { msg: 'Colores aplicados a ' + fs.length + ' objetos según «' + p.field + '».' }; } },
    { id: 'label', g: 'Cartografía', n: 'Etiquetar por campo', q: 'Etiquetado de capa', a: 'Label Features', p: [X('field', 'Campo («nombre» = el nombre; vacío = quitar etiquetas)', 'nombre')],
      run: (fs, p) => { const before = fs.map((f) => [f.entity, f.entity.label, f.entity.position, isPoint(f)]), text = (f) => (p.field ? String(valueOf(f, p.field) ?? '') : '');
        const put = () => fs.forEach((f) => { const e = f.entity, t = text(f); if (isPoint(f)) e.label = t ? new C.LabelGraphics(e.billboard ? geo.pinLabel(t) : geo.labelStyle(t)) : undefined; else { e.label = t ? new C.LabelGraphics(geo.labelStyle(t)) : undefined; e.position = t ? geo.center(geo.rings(e)[0]) : undefined; } });
        OGE.run({ do: put, undo: () => before.forEach(([e, l, pos, pt]) => { e.label = l; if (!pt) e.position = pos; }) }); return { msg: p.field ? 'Etiquetas puestas en ' + fs.length + ' objetos.' : 'Etiquetas quitadas.' }; } },
    { id: 'topocolor', g: 'Cartografía', n: 'Coloreado topológico', q: 'qgis:topologicalcoloring', a: '—', in: ['polygon'], h: 'Da a cada polígono un color distinto al de sus vecinos, con el menor número de colores posible.',
      run: (fs) => { const n = fs.length, adj = Array.from({ length: n }, () => []); for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (hit(fs[i], fs[j]) && T.booleanIntersects(fs[i], fs[j])) { adj[i].push(j); adj[j].push(i); }
        const col = new Array(n).fill(-1); for (const i of [...Array(n).keys()].sort((a, b) => adj[b].length - adj[a].length)) { const used = new Set(adj[i].map((j) => col[j])); let c = 0; while (used.has(c)) c++; col[i] = c; }
        setStyles(fs.map((f, i) => [f.entity, { ...f.oge.style, fill: PALETTE[col[i] % PALETTE.length], stroke: PALETTE[col[i] % PALETTE.length], fillOpacity: 0.55 }])); return { msg: `Coloreado con ${Math.max(...col) + 1} colores.` }; } },

    // ===== Topología =====
    { id: 'coverage', g: 'Topología', n: 'Comprobar topología (huecos y solapes)', q: 'native:coveragevalidate / Comprobador de topología', a: 'Topología: Must Not Overlap / Must Not Have Gaps', in: ['polygon'],
      run: (fs) => { const r = []; for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) if (hit(fs[i], fs[j])) { const x = inter(fs[i], fs[j]); if (x && T.area(x) > 0.01) r.push(named(out(null, x, { tipo: 'solape', entre: fs[i].oge.name + ' / ' + fs[j].oge.name, area_m2: +T.area(x).toFixed(2) }), 'Solape')); }
        const u = U(fs); if (u) for (const poly of T.flatten(u).features) for (const hole of poly.geometry.coordinates.slice(1)) { const h = T.polygon([hole]); r.push(named(out(null, h, { tipo: 'hueco', area_m2: +T.area(h).toFixed(2) }), 'Hueco')); }
        return r.length ? { features: r, colorBy: 'tipo', msg: `${r.filter((f) => f.properties.tipo === 'solape').length} solapes y ${r.filter((f) => f.properties.tipo === 'hueco').length} huecos encontrados.` } : { msg: 'Sin huecos ni solapes: la cobertura está limpia.' }; } },
    { id: 'slivers', g: 'Topología', n: 'Eliminar astillas', q: 'qgis:eliminateselectedpolygons', a: 'Eliminate', in: ['polygon'], p: [N('min', 'Área máxima de una astilla (m²)', 10000, { min: 0 })], h: 'Cada polígono más chico que el umbral se funde con el vecino con el que comparte más borde.',
      run: (fs, p) => { const big = fs.filter((f) => T.area(f) >= p.min).map((f) => ({ f, g: f })); let merged = 0; for (const s of fs.filter((f) => T.area(f) < p.min)) { let best = null, ba = 0; for (const b of big) { if (!hit(s, b.g)) continue; const x = inter(T.buffer(s, 0.001), b.g), a = x ? T.area(x) : 0; if (a > ba) { ba = a; best = b; } } if (best) { best.g = U([best.g, s]); merged++; } else big.push({ f: s, g: s }); }
        return { features: big.map((b) => out(b.f, b.g)), msg: merged + ' astillas fundidas con su vecino.' }; } },

    // ===== Base de datos =====
    { id: 'sql', g: 'Base de datos', n: 'Consulta SQL sobre una capa', q: 'qgis:executesql / Gestor de BBDD', a: 'MakeQueryTable / SQL', p: [{ id: 'q', label: 'Consulta (SQLite)', type: 'textarea', value: 'SELECT tipo, COUNT(*) AS cuenta, ROUND(SUM(area_m2) / 1e6, 2) AS km2 FROM capa GROUP BY tipo' }],
      h: 'Los objetos de la capa quedan en la tabla «capa», con las columnas nombre, tipo, area_m2, longitud_m, lon, lat y sus atributos.',
      run: async (fs, p) => ({ table: await OGE.db.query(fs, p.q), note: 'Resultado de: ' + p.q.replace(/\s+/g, ' ') }) },
  ];
  const GROUPS = [...new Set(TOOLS.map((t) => t.g))];

  // ---------- Ejecución ----------
  const usable = (f) => f && f.oge.kind !== 'image';
  const featuresOf = (key) => (key === '@sel' ? OGE.selection() : (geo.groups().find((d) => d.name === key) || { entities: { values: [] } }).entities.values).map(geo.toFeature).filter(usable);
  let runs = 0;
  // La capa ya fue añadida por addGroup (de forma asíncrona): deshacer la quita y rehacer la vuelve a poner.
  function undoable(ds) {
    let inside = true;
    OGE.run({ do: () => { if (!inside) { viewer.dataSources.add(ds); inside = true; } }, undo: () => { viewer.dataSources.remove(ds, false); inside = false; } });
  }
  function deliver(tool, res) {
    if (Array.isArray(res)) res = { features: res };
    if (res.features) {
      const fs = res.features.filter((f) => f && f.geometry);
      if (!fs.length) return OGE.toast('«' + tool.n + '»: el resultado está vacío.', true);
      if (res.colorBy) { const col = colorer(fs.map((f) => f.properties[res.colorBy]), res.graduated); fs.forEach((f) => tint(f, col(f.properties[res.colorBy]))); }
      const c = PALETTE[runs++ % PALETTE.length];
      const ds = geo.addGroup(tool.n, fs, { style: { stroke: c, fill: c, color: c, width: 2, marker: fs.length > 150 ? 'dot' : 'pin', ...res.style } });
      undoable(ds);
      OGE.toast(res.msg || `«${tool.n}»: ${ds.entities.values.length} objetos en la capa «${ds.name}».`);
    } else if (res.image) {
      const [w, s, e, n] = res.image.bbox;
      const ds = geo.addGroup(tool.n, [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }, properties: {}, oge: { kind: 'image', name: res.image.name, style: { url: res.image.url, opacity: res.image.opacity, rotation: 0 } } }]);
      undoable(ds);
      OGE.toast(`«${tool.n}» lista: es una imagen superpuesta en la capa «${ds.name}»; su opacidad se cambia en ✎ Propiedades.`);
    } else if (res.table) {
      const ents = res.rowEntities;
      OGE.showTable(res.title || tool.n, res.table[0], res.table[1], { note: res.note, content: res.content, onRow: ents && ((i) => { $('table').close(); viewer.flyTo(ents[i]); OGE.setEdit(true); OGE.select([ents[i]]); }) });
    } else if (res.select) {
      OGE.setEdit(true);
      OGE.select(res.select.map((f) => f.entity).filter(Boolean));
      OGE.toast(`«${tool.n}»: ${res.select.length} objetos seleccionados.`);
    } else if (res.msg) OGE.toast(res.msg);
  }
  async function exec(tool, values) {
    let fs = tool.noIn ? [] : featuresOf(values._in);
    if (tool.in) fs = fs.filter((f) => tool.in.includes(kindOf(f)));
    if (!tool.noIn && !fs.length) return OGE.toast(`«${tool.n}» necesita ${tool.in ? tool.in.map((t) => TYPE[t]).join(' o ') : 'objetos'} en la entrada.`, true);
    const p = { ...values };
    for (const d of tool.p || []) if (d.type === 'layer') p[d.id] = featuresOf(values[d.id]);
    OGE.toast('Ejecutando «' + tool.n + '»…');
    await new Promise((r) => setTimeout(r, 30)); // deja pintar el aviso antes de un cálculo largo
    try { deliver(tool, await tool.run(fs, p)); } catch (e) { console.error(e); OGE.toast('«' + tool.n + '» no se pudo ejecutar: ' + e.message, true); }
  }
  async function open(tool) {
    const nSel = OGE.selection().filter((e) => geo.kind(e) !== 'image').length;
    const layers = [...(nSel ? [['@sel', `Selección actual (${nSel})`]] : []), ...geo.groups().filter((d) => d.entities.values.length).map((d) => [d.name, d.name])];
    if (!tool.noIn && !layers.length) return OGE.toast('No hay objetos: dibuja o abre un archivo primero.', true);
    const fields = [...(tool.noIn ? [] : [{ id: '_in', label: 'Capa de entrada' + (tool.in ? ' (' + tool.in.map((t) => TYPE[t]).join(' o ') + ')' : ''), type: 'select', options: layers }]),
      ...(tool.p || []).map((d) => (d.type === 'layer' ? { ...d, type: 'select', options: layers } : d))];
    const eq = [tool.q && tool.q !== '—' && 'QGIS: ' + tool.q, tool.a && tool.a !== '—' && 'ArcGIS: ' + tool.a].filter(Boolean).join(' · ');
    const v = await OGE.ask({ title: tool.n, help: [tool.h, eq].filter(Boolean).join(' — '), fields, ok: 'Ejecutar' });
    if (v) await exec(tool, v);
  }

  // ---------- Panel ----------
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  function render(filter = '') {
    const q = norm(filter);
    $('toolList').replaceChildren(...GROUPS.map((gname) => {
      const ts = TOOLS.filter((t) => t.g === gname && (!q || norm(`${t.n} ${window.T(t.n)} ${t.q || ''} ${t.a || ''}`).includes(q)));
      if (!ts.length) return '';
      return el('details', { open: !!q }, el('summary', { textContent: `${gname} (${ts.length})` }), ...ts.map((t) => {
        const b = el('button', { className: 'tool', textContent: t.n, title: [t.h, t.q && 'QGIS: ' + t.q, t.a && 'ArcGIS: ' + t.a].filter(Boolean).join('\n') });
        b.onclick = () => open(t);
        return b;
      }));
    }));
  }
  const show = (v) => { $('toolbox').hidden = !v; $('toolboxBtn').classList.toggle('active', v); localStorage.setItem('oge.toolbox', v ? '1' : ''); };
  $('toolboxBtn').onclick = () => show($('toolbox').hidden);
  $('toolboxClose').onclick = () => show(false);
  $('toolSearch').oninput = (e) => render(e.target.value);
  render();
  show(!!localStorage.getItem('oge.toolbox'));

  // ---------- Autoprueba: ejecuta cada herramienta sin red con datos de muestra y valores por defecto ----------
  async function selfTest() {
    const P = (c, name, props) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: props || {}, oge: { name } });
    const sq = (x, y, s, name, props) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[x, y], [x + s, y], [x + s, y - s], [x, y - s], [x, y]]] }, properties: props || {}, oge: { name } });
    const ln = (c, name) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: c }, properties: {}, oge: { name } });
    const a = geo.addGroup('__prueba A', [P([-70.65, -33.45], 'p1', { valor: 10, cat: 'x' }), P([-70.6, -33.4], 'p2', { valor: 20, cat: 'y' }), P([-70.55, -33.5], 'p3', { valor: 35, cat: 'x' }), P([-70.5, -33.42], 'p4', { valor: 5, cat: 'y' }), P([-70.62, -33.52], 'p5', { valor: 50, cat: 'x' }),
      ln([[-70.7, -33.4], [-70.6, -33.45], [-70.5, -33.4]], 'l1'), ln([[-70.65, -33.35], [-70.65, -33.6]], 'l2'),
      sq(-70.7, -33.38, 0.1, 'A', { valor: 3 }), sq(-70.6, -33.38, 0.1, 'B', { valor: 7 }), sq(-70.66, -33.44, 0.1, 'C', { valor: 9 })]);
    const b = geo.addGroup('__prueba B', [sq(-70.68, -33.42, 0.12, 'M'), ln([[-70.72, -33.47], [-70.45, -33.47]], 'corte'), P([-70.63, -33.46], 'q1')]);
    const fa = () => geo.features(a), fb = () => geo.features(b), results = [];
    for (const t of TOOLS) {
      if (t.net || t.id === 'sql') { results.push({ id: t.id, ok: null, info: 'requiere red: se prueba aparte' }); continue; }
      try {
        let fs = t.noIn ? [] : fa();
        if (t.in) fs = fs.filter((f) => t.in.includes(kindOf(f)));
        const p = {};
        for (const d of t.p || []) p[d.id] = d.type === 'layer' ? fb() : d.type === 'select' ? (d.value ?? (Array.isArray(d.options[0]) ? d.options[0][0] : d.options[0])) : d.value;
        if ('field' in p && !['selattr', 'unique', 'classify', 'label', 'fieldcalc', 'autoinc', 'dissolve'].includes(t.id)) p.field = 'valor';
        if (t.id === 'statscat') p.cat = 'cat';
        if (p.mode) p.mode = 'new';
        let res = await t.run(fs, p);
        if (Array.isArray(res)) res = { features: res };
        const n = res.features ? res.features.filter((f) => f && f.geometry).flatMap((f) => geo.fromFeature(f)).length : res.table ? res.table[1].length : null;
        results.push({ id: t.id, ok: !res.features || n > 0, info: res.features ? n + ' objetos' : res.table ? n + ' filas' : res.msg || (res.select ? res.select.length + ' sel.' : '') });
      } catch (e) { results.push({ id: t.id, ok: false, info: e.message }); }
    }
    viewer.dataSources.remove(a, true); viewer.dataSources.remove(b, true);
    return results;
  }
  // Catálogo en Markdown (para la documentación).
  const catalog = () => GROUPS.map((gname) => `### ${gname}\n\n| Herramienta | QGIS | ArcGIS |\n|---|---|---|\n` + TOOLS.filter((t) => t.g === gname).map((t) => `| ${t.n} | ${t.q || '—'} | ${t.a || '—'} |`).join('\n')).join('\n\n');

  OGE.tools = { list: TOOLS, open, exec, selfTest, catalog };
})();
