// Capas en vivo al estilo de Earth: Wikipedia, edificios 3D y cuadrícula (parques y calles están en osmvector.js).
// Se consultan según el punto que mira la cámara y se vuelven a pedir al moverla.
(() => {
  const C = Cesium, { viewer, $ } = OGE;
  const scene = viewer.scene, deg = C.Math.toDegrees;
  const status = (t) => { $('layerStatus').textContent = t || ''; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const icon = (txt, bg) => 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26"><circle cx="13" cy="13" r="12" fill="${bg}" stroke="#fff" stroke-width="2"/><text x="13" y="18" font-size="14" font-family="serif" font-weight="bold" text-anchor="middle" fill="#fff">${txt}</text></svg>`);

  // ---------- Overpass (consultas a OpenStreetMap; lo usa «Descargar de OpenStreetMap») ----------
  // Los servidores públicos se saturan a menudo: se piden a la vez varios espejos y gana el primero que responde.
  const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  OGE.overpass = async (query, ms = 60000) => {
    const ctl = MIRRORS.map(() => new AbortController());
    const timer = setTimeout(() => ctl.forEach((c) => c.abort()), ms);
    try {
      return await Promise.any(MIRRORS.map((srv, i) => fetch(srv, { method: 'POST', body: 'data=' + encodeURIComponent(query), signal: ctl[i].signal })
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then((js) => { if (js.remark && !js.elements.length) throw new Error(js.remark); ctl.forEach((c, j) => j !== i && c.abort()); return js; })));
    } catch {
      throw new Error('los servidores de OpenStreetMap (Overpass) no respondieron; inténtalo de nuevo en un momento');
    } finally { clearTimeout(timer); }
  };

  // ---------- Wikipedia: artículos cercanos al punto mirado; al abrir uno, su resumen ----------
  const wiki = new C.CustomDataSource('Wikipedia'), wikiIcon = icon('W', '#555'), seenWiki = new Set();
  wiki.isLayer = true; // no aparece en Lugares ni se guarda
  viewer.dataSources.add(wiki);
  async function loadWiki() {
    const la = OGE.lookAt();
    if (!la || la.dist > 1.5e5) return status('Acércate (a menos de 150 km) para ver artículos de Wikipedia.');
    status('Buscando artículos de Wikipedia…');
    const url = `https://es.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${deg(la.carto.latitude)}|${deg(la.carto.longitude)}&gsradius=10000&gslimit=100&format=json&origin=*`;
    const js = await (await fetch(url)).json();
    for (const a of js.query.geosearch) {
      if (seenWiki.has(a.pageid)) continue;
      seenWiki.add(a.pageid);
      const e = wiki.entities.add({ name: a.title, position: C.Cartesian3.fromDegrees(a.lon, a.lat),
        billboard: { image: wikiIcon, scale: 0.8, heightReference: C.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: 5e5 },
        description: `<p><a href="https://es.wikipedia.org/?curid=${a.pageid}" target="_blank">Abrir en Wikipedia</a></p>` });
      e.wikiId = a.pageid;
    }
    status(seenWiki.size + ' artículos de Wikipedia cargados.');
  }
  viewer.selectedEntityChanged.addEventListener(async (e) => {
    if (!e || !e.wikiId || e.wikiLoaded) return;
    e.wikiLoaded = true;
    try {
      const js = await (await fetch(`https://es.wikipedia.org/w/api.php?action=query&prop=extracts|pageimages&exintro=1&explaintext=1&pithumbsize=300&pageids=${e.wikiId}&format=json&origin=*`)).json();
      const p = js.query.pages[e.wikiId];
      e.description = (p.thumbnail ? `<img src="${p.thumbnail.source}" style="float:right;max-width:45%;margin:0 0 6px 8px">` : '') +
        `<p>${esc(p.extract || '')}</p><p><a href="https://es.wikipedia.org/?curid=${e.wikiId}" target="_blank">Seguir leyendo en Wikipedia</a></p>`;
    } catch { /* se queda con el enlace */ }
  });

  // ---------- Edificios 3D: huellas de OSM con su altura (capa «building» de OpenFreeMap), un lote por tesela ----------
  const Z = 14, batches = new Map(); // "x/y" -> { prim, count }
  let total = 0;
  const signedArea = (r) => r.reduce((a, p, i) => a + (i ? r[i - 1][0] * p[1] - p[0] * r[i - 1][1] : 0), 0); // > 0: anillo exterior
  async function loadTile(x, y) {
    const key = x + '/' + y;
    if (batches.has(key)) return;
    batches.set(key, { prim: null, count: 0 }); // reservado: no se pide dos veces
    const layers = await OGE.mvt.ofmTile(Z, x, y).catch(() => null);
    if (!layers) { batches.delete(key); throw new Error('no se pudieron descargar las teselas de edificios'); }
    const els = [];
    for (const f of layers.building || []) {
      if (f.props.hide_3d) continue;
      for (const r of f.geom) if (r.length >= 4 && signedArea(r) > 0) els.push({ ring: r.slice(0, -1).map(([px, py]) => OGE.mvt.lonLat(Z, x, y, px, py)), h: f.props.render_height || 8, min: f.props.render_min_height || 0, colour: f.props.colour });
    }
    if (!els.length) return;
    // altura del terreno bajo cada edificio, la misma que usa el relieve dibujado de cerca
    const cartos = els.map((b) => C.Cartographic.fromDegrees(b.ring[0][0], b.ring[0][1]));
    try { await C.sampleTerrain(scene.terrainProvider, 13, cartos); } catch { /* sin relieve: altura 0 */ }
    if (!batches.has(key)) return; // se reinició mientras cargaba
    const instances = els.map((b, i) => {
      const base = (cartos[i].height || 0) * scene.verticalExaggeration, g = 0.74 + ((i * 13) % 12) / 100; // gris con leve variación
      const color = (b.colour && C.Color.fromCssColorString(b.colour)) || new C.Color(g + 0.1, g + 0.08, g, 1);
      return new C.GeometryInstance({
        geometry: new C.PolygonGeometry({ polygonHierarchy: new C.PolygonHierarchy(C.Cartesian3.fromDegreesArray(b.ring.flat())),
          height: base + (b.min || -5), extrudedHeight: base + Math.max(b.h, b.min + 1), vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT }),
        attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(color) },
      });
    });
    const prim = scene.primitives.add(new C.Primitive({ geometryInstances: instances, appearance: new C.PerInstanceColorAppearance({ translucent: false, closed: true }) }));
    prim.show = $('layerBuildings').checked;
    batches.set(key, { prim, count: els.length });
    total += els.length;
    while (batches.size > 12) drop(batches.keys().next().value); // se descartan las teselas más antiguas
  }
  function drop(key) {
    const b = batches.get(key);
    batches.delete(key);
    if (b && b.prim) { scene.primitives.remove(b.prim); total -= b.count; }
  }
  async function loadBuildings() {
    const la = OGE.lookAt();
    if (!la || la.dist > 9000) return status('Acércate (a menos de 9 km del suelo que miras) para ver edificios 3D.');
    const n = 2 ** Z, fx = ((deg(la.carto.longitude) + 180) / 360) * n, fy = ((1 - Math.log(Math.tan(Math.PI / 4 + la.carto.latitude / 2)) / Math.PI) / 2) * n;
    const x0 = Math.floor(fx - 0.5), y0 = Math.floor(fy - 0.5); // las 4 teselas (~2 km cada una) más cercanas al punto mirado
    status('Cargando edificios 3D…');
    await Promise.all([[x0, y0], [x0 + 1, y0], [x0, y0 + 1], [x0 + 1, y0 + 1]].map(([x, y]) => loadTile(x, y)));
    status(total ? total.toLocaleString('es') + ' edificios 3D cargados.' : 'OpenStreetMap no tiene edificios en esta zona.');
  }
  function resetBuildings() { // el relieve cambió: las bases ya no calzan
    [...batches.keys()].forEach(drop);
    total = 0;
    if ($('layerBuildings').checked) refresh();
  }

  // ---------- Meridianos y paralelos, como la cuadrícula de Earth: más finos al acercarse y con su rótulo ----------
  function gridProvider() {
    const scheme = new C.GeographicTilingScheme(), TS = 256, STEP = [30, 30, 10, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001]; // grados por nivel de zoom
    const fmt = (v, pos, neg) => { const a = Math.abs(v), d = Math.floor(a + 1e-9), m = Math.round((a - d) * 6000) / 100; return d + '°' + (m ? m + '′' : '') + (v < -1e-9 ? neg : v > 1e-9 ? pos : ''); };
    return {
      tilingScheme: scheme, rectangle: scheme.rectangle, tileWidth: TS, tileHeight: TS, minimumLevel: 0, maximumLevel: 15,
      hasAlphaChannel: true, errorEvent: new C.Event(), credit: undefined, tileDiscardPolicy: undefined, proxy: undefined,
      getTileCredits: () => undefined, pickFeatures: () => undefined,
      requestImage(x, y, level) {
        const cv = document.createElement('canvas'), g = cv.getContext('2d'), r = scheme.tileXYToRectangle(x, y, level);
        cv.width = cv.height = TS;
        const w = deg(r.west), e = deg(r.east), s = deg(r.south), n = deg(r.north), st = STEP[Math.min(level, STEP.length - 1)];
        g.font = '600 11px sans-serif'; g.fillStyle = '#fff'; g.shadowColor = '#000'; g.shadowBlur = 3;
        const line = (x1, y1, x2, y2, main) => { g.strokeStyle = main ? 'rgba(255,235,59,.9)' : 'rgba(255,255,255,.6)'; g.lineWidth = main ? 1.6 : 1; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
        for (let k = Math.ceil(w / st - 1e-9); k * st <= e + 1e-9; k++) { const lon = k * st, px = ((lon - w) / (e - w)) * TS; line(px, 0, px, TS, Math.abs(lon) < 1e-9); if (px < TS - 30) g.fillText(fmt(lon, 'E', 'O'), px + 3, 12); }
        for (let k = Math.ceil(s / st - 1e-9); k * st <= n + 1e-9; k++) { const lat = k * st, py = ((n - lat) / (n - s)) * TS; line(0, py, TS, py, Math.abs(lat) < 1e-9); if (py > 26) g.fillText(fmt(lat, 'N', 'S'), 3, py - 3); }
        return Promise.resolve(cv);
      },
    };
  }
  let grid = null;
  const syncGrid = () => { if ($('layerGrid').checked && !grid) grid = viewer.imageryLayers.addImageryProvider(gridProvider()); if (grid) grid.show = $('layerGrid').checked; };
  $('layerGrid').addEventListener('change', syncGrid);
  syncGrid();

  // ---------- Encendido y recarga al mover la cámara ----------
  const L = [
    { cb: $('layerWiki'), load: loadWiki, show: (v) => { wiki.show = v; }, what: 'Wikipedia' },
    { cb: $('layerBuildings'), load: loadBuildings, show: (v) => batches.forEach((b) => { if (b.prim) b.prim.show = v; }), what: 'los edificios' },
  ];
  async function run(l) { // una carga a la vez por capa; si la cámara se movió mientras tanto, se repite
    if (l.busy) { l.again = true; return; }
    l.busy = true;
    try { await l.load(); } catch (e) { status('No se pudieron cargar ' + l.what + ': ' + e.message); }
    l.show(l.cb.checked);
    l.busy = false;
    if (l.again) { l.again = false; if (l.cb.checked) run(l); }
  }
  let timer;
  function refresh() { clearTimeout(timer); timer = setTimeout(() => L.forEach((l) => l.cb.checked && run(l)), 700); }
  L.forEach((l) => {
    l.show(l.cb.checked);
    l.cb.addEventListener('change', () => { l.show(l.cb.checked); if (l.cb.checked) run(l); else status(''); });
  });
  viewer.camera.moveEnd.addEventListener(refresh);
  refresh();
  OGE.layers = { resetBuildings };
})();
