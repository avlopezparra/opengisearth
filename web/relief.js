// OpenGISEarth — watersheds (mghydro.com Global Watersheds API) and mountain ranges (Natural Earth fork).
(() => {
  const C = Cesium, { viewer, geo, $ } = OGE;
  const FORK = 'https://raw.githubusercontent.com/avlopezparra/natural-earth-vector/master/';

  // ---------- Watershed: click a point, get the basin that drains to it, plus its rivers ----------
  let picking = null;
  const stop = () => { if (picking) { picking.destroy(); picking = null; } $('watershedBtn').classList.remove('active'); };
  $('watershedBtn').onclick = () => {
    if (picking) return stop();
    OGE.activate(null);
    $('watershedBtn').classList.add('active');
    OGE.hint('Haz clic en un río o en un punto del terreno: se calcula la cuenca que drena hasta ahí.');
    picking = new C.ScreenSpaceEventHandler(viewer.scene.canvas);
    picking.setInputAction(async (ev) => {
      const hit = OGE.pickGround(ev.position);
      stop(); OGE.hint('');
      if (!hit) return;
      const [lng, lat] = geo.toLL(hit), q = `lat=${lat}&lng=${lng}&precision=low`;
      OGE.toast('Calculando la cuenca…');
      try {
        const get = (path) => fetch(`https://mghydro.com/app/${path}?${q}`).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
        const basin = await get('watershed_api'), rivers = await get('upstream_rivers_api').catch(() => ({ features: [] }));
        const km2 = Math.round(turf.area(basin) / 1e6);
        const feats = [...basin.features.map((f) => ({ ...f, properties: { ...f.properties, area_km2: km2 }, oge: { name: 'Cuenca', style: { fill: '#2196f3', stroke: '#0d47a1', fillOpacity: 0.25, width: 2 } } })),
          ...rivers.features.map((f) => ({ ...f, oge: { name: 'Río', style: { stroke: '#4fc3f7', width: 1.5 } } }))];
        const ds = geo.addGroup('Cuenca', feats);
        viewer.flyTo(ds);
        OGE.toast(`Cuenca de ${km2.toLocaleString('es')} km² con ${rivers.features.length} tramos de río. Fuente: mghydro.com (MERIT-Hydro).`);
      } catch (e) { OGE.toast('No se pudo calcular la cuenca: ' + e.message, true); }
    }, C.ScreenSpaceEventType.LEFT_CLICK);
  };

  // ---------- Mountain ranges: outlines and names from Natural Earth physical regions ----------
  let ranges = null, loading = false;
  async function loadRanges() {
    const [shpBuf, dbfBuf] = await Promise.all(['.shp', '.dbf'].map((x) => fetch(FORK + '10m_physical/ne_10m_geography_regions_polys' + x).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })));
    const gj = shp.combine([shp.parseShp(shpBuf), shp.parseDbf(dbfBuf)]), inst = [], BROWN = C.Color.fromCssColorString('#d7a86e');
    const labels = viewer.scene.primitives.add(new C.BillboardCollection()), clean = (s) => String(s ?? '').replace(/\0/g, '').trim();
    for (const f of gj.features) {
      const p = f.properties;
      if (!/range|mtn/i.test(clean(p.FEATURECLA || p.featurecla)) || !f.geometry) continue;
      const name = clean(OGE_LANG === 'en' ? p.NAME_EN || p.name_en || p.NAME || p.name : p.NAME_ES || p.name_es || p.NAME || p.name);
      for (const rings of f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates) {
        if (rings[0].length > 3) inst.push(new C.GeometryInstance({ geometry: new C.GroundPolylineGeometry({ positions: C.Cartesian3.fromDegreesArray(rings[0].flatMap((c) => [c[0], c[1]])), width: 1.5 }),
          attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(BROWN.withAlpha(0.8)) } }));
      }
      const c = turf.centerOfMass(f).geometry.coordinates;
      labels.add({ position: C.Cartesian3.fromDegrees(c[0], c[1]), image: OGE.textImage(name, 'italic 600 13px sans-serif', BROWN), scale: 0.5,
        distanceDisplayCondition: new C.DistanceDisplayCondition(0, 9e6), disableDepthTestDistance: Number.POSITIVE_INFINITY });
    }
    const occluder = new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, viewer.camera.positionWC); // hide labels on the far side of the globe
    viewer.scene.preRender.addEventListener(() => { if (!labels.show) return; occluder.cameraPosition = viewer.camera.positionWC; for (let i = 0; i < labels.length; i++) { const l = labels.get(i); l.show = occluder.isPointVisible(l.position); } });
    const lines = viewer.scene.groundPrimitives.add(new C.GroundPolylinePrimitive({ geometryInstances: inst, appearance: new C.PolylineColorAppearance() }));
    return { set show(v) { lines.show = v; labels.show = v; } };
  }
  // ---------- Historical countries: borders and names for a chosen year (avlopezparra/historical-basemaps fork) ----------
  const YEARS = [-123000, -10000, -8000, -5000, -4000, -3000, -2000, -1500, -1000, -700, -500, -400, -323, -300, -200, -100, -1, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1279, 1300, 1400,
    1492, 1500, 1530, 1600, 1650, 1700, 1715, 1783, 1800, 1815, 1878, 1880, 1900, 1914, 1920, 1930, 1938, 1945, 1960, 1994, 2000, 2010];
  const sel = $('historyYear'), en = OGE_LANG === 'en';
  const fill = (years) => { // keeps the first option («do not show») and the current choice
    const cur = sel.value;
    while (sel.options.length > 1) sel.remove(1);
    for (const y of years) sel.append(new Option(y < 0 ? `${(-y).toLocaleString(en ? 'en' : 'es')} ${en ? 'BC' : 'a. C.'}` : String(y), y));
    sel.value = cur;
  };
  fill(YEARS); // fallback list; replaced by the live file list of the fork, so new files show up without rebuilding
  fetch('https://api.github.com/repos/avlopezparra/historical-basemaps/contents/geojson').then((r) => (r.ok ? r.json() : [])).then((files) => {
    const ys = files.map((f) => /^world_(bc)?(\d+)\.geojson$/.exec(f.name)).filter(Boolean).map((m) => (m[1] ? -m[2] : +m[2])).sort((x, y) => x - y);
    if (ys.length) fill(ys);
  }).catch(() => {});
  let hist = null, token = 0; // hist: { lines, labels, tick } of the year on screen
  function clearHist() {
    if (!hist) return;
    viewer.scene.groundPrimitives.remove(hist.lines);
    viewer.scene.primitives.remove(hist.labels);
    viewer.scene.preRender.removeEventListener(hist.tick);
    hist = null;
  }
  sel.addEventListener('change', async () => {
    const y = sel.value, mine = ++token;
    clearHist();
    if (!y) return;
    OGE.toast('Cargando el mapa histórico…');
    try {
      const res = await fetch(`https://raw.githubusercontent.com/avlopezparra/historical-basemaps/master/geojson/world_${+y < 0 ? 'bc' + -y : y}.geojson`, { cache: 'no-cache' }); // always ask the fork for the current version
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const gj = await res.json();
      if (mine !== token) return; // another year was chosen meanwhile
      const PINK = C.Color.fromCssColorString('#ff80ab'), inst = [], labels = new C.BillboardCollection();
      for (const f of gj.features) {
        if (!f.geometry) continue;
        let biggest = null, size = 0; // the label goes on the largest part
        for (const rings of f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates) {
          if (rings[0].length < 4) continue;
          inst.push(new C.GeometryInstance({ geometry: new C.GroundPolylineGeometry({ positions: C.Cartesian3.fromDegreesArray(rings[0].flatMap((c) => [c[0], c[1]])), width: 2 }),
            attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(PINK) } }));
          const b = turf.bbox(turf.lineString(rings[0])), a = (b[2] - b[0]) * (b[3] - b[1]);
          if (a > size) { size = a; biggest = b; }
        }
        const name = f.properties.NAME || f.properties.name;
        if (name && biggest) labels.add({ position: C.Cartesian3.fromDegrees((biggest[0] + biggest[2]) / 2, (biggest[1] + biggest[3]) / 2), image: OGE.textImage(name, '600 13px sans-serif', PINK), scale: 0.5,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new C.DistanceDisplayCondition(0, Math.max(1.5e6, Math.min(2e7, Math.sqrt(size) * 6e5))) }); // small states appear when zooming in
      }
      const occluder = new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, viewer.camera.positionWC);
      const tick = () => { occluder.cameraPosition = viewer.camera.positionWC; for (let i = 0; i < labels.length; i++) { const l = labels.get(i); l.show = occluder.isPointVisible(l.position); } };
      viewer.scene.preRender.addEventListener(tick);
      hist = { lines: viewer.scene.groundPrimitives.add(new C.GroundPolylinePrimitive({ geometryInstances: inst, appearance: new C.PolylineColorAppearance() })), labels: viewer.scene.primitives.add(labels), tick };
      OGE.toast(`Mapa histórico de ${sel.selectedOptions[0].textContent}: ${gj.features.length} territorios. Los nombres vienen en inglés.`);
    } catch (e) { OGE.toast('No se pudo cargar el mapa histórico: ' + e.message, true); }
  });

  // ---------- Subnational boundaries (states, provinces, regions) as blue lines, like Google Earth ----------
  // Only the geometry is needed, so the .dbf is not downloaded. The file is 7 MB: it loads the first time the layer is switched on.
  let admin1 = null, admin1Busy = false;
  const cbA = $('layerAdmin1');
  const syncAdmin1 = async () => {
    if (admin1) admin1.show = cbA.checked;
    if (!cbA.checked || admin1 || admin1Busy) return;
    admin1Busy = true;
    OGE.toast('Cargando los límites regionales…');
    try {
      const res = await fetch(FORK + '10m_cultural/ne_10m_admin_1_states_provinces_lines.shp');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const BLUE = C.ColorGeometryInstanceAttribute.fromColor(C.Color.fromCssColorString('#64b5f6')), inst = [];
      for (const g of shp.parseShp(await res.arrayBuffer())) for (const p of !g ? [] : g.type === 'LineString' ? [g.coordinates] : g.coordinates) {
        if (p.length > 1) inst.push(new C.GeometryInstance({ geometry: new C.GroundPolylineGeometry({ positions: C.Cartesian3.fromDegreesArray(p.flatMap((c) => [c[0], c[1]])), width: 1.5 }), attributes: { color: BLUE } }));
      }
      admin1 = viewer.scene.groundPrimitives.add(new C.GroundPolylinePrimitive({ geometryInstances: inst, appearance: new C.PolylineColorAppearance() }));
      admin1.show = cbA.checked;
      OGE.toast(`Límites regionales cargados: ${inst.length.toLocaleString('es')} tramos.`);
    } catch (e) { OGE.toast('No se pudieron cargar los límites regionales: ' + e.message, true); }
    admin1Busy = false;
  };
  cbA.addEventListener('change', syncAdmin1);
  syncAdmin1();

  const cb = $('layerRanges');
  const sync = async () => {
    if (ranges) ranges.show = cb.checked;
    if (!cb.checked || ranges || loading) return;
    loading = true;
    try { ranges = await loadRanges(); ranges.show = cb.checked; } catch (e) { OGE.toast('No se pudieron cargar las cadenas montañosas: ' + e.message, true); }
    loading = false;
  };
  cb.addEventListener('change', sync);
  sync();
})();
