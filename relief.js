// OpenGISEarth — watersheds (mghydro.com Global Watersheds API) and mountain ranges (Natural Earth fork).
(() => {
  const C = Cesium, { viewer, geo, $ } = OGE;
  const FORK = 'https://raw.githubusercontent.com/avlopezparra/natural-earth-vector/master/';

  // ---------- Area fills: translucent polygons drawn as an imagery layer, so they drape on the terrain like the base map ----------
  // (ground primitives slid away from their boundary lines in tilted views)
  const TINTS = ['#e57373', '#64b5f6', '#81c784', '#ffd54f', '#ba68c8', '#4db6ac', '#ff8a65', '#f06292', '#9575cd', '#dce775', '#4dd0e1', '#a1887f'];
  // items: [GeoJSON Polygon or MultiPolygon geometry, color number]. Returns an imagery layer (has .show).
  function fillLayer(items) {
    const scheme = new C.GeographicTilingScheme(), TS = 256, deg = C.Math.toDegrees, polys = []; // one entry per polygon: { box, rings, color }
    for (const [g, n] of items) for (const rings of !g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []) {
      if (rings[0].length > 3) polys.push({ box: turf.bbox({ type: 'Polygon', coordinates: rings }), rings, color: typeof n === 'number' ? TINTS[Math.abs(n) % TINTS.length] : n }); // a color number, a CSS color or a canvas to repeat (stripes)
    }
    const layer = viewer.imageryLayers.addImageryProvider({
      tilingScheme: scheme, rectangle: scheme.rectangle, tileWidth: TS, tileHeight: TS, minimumLevel: 0, maximumLevel: 12,
      hasAlphaChannel: true, errorEvent: new C.Event(), credit: undefined, tileDiscardPolicy: undefined, proxy: undefined,
      getTileCredits: () => undefined, pickFeatures: () => undefined,
      requestImage(x, y, level) {
        const cv = document.createElement('canvas'), ctx = cv.getContext('2d'), r = scheme.tileXYToRectangle(x, y, level);
        cv.width = cv.height = TS;
        const w = deg(r.west), e = deg(r.east), s = deg(r.south), n = deg(r.north), kx = TS / (e - w), ky = TS / (n - s);
        for (const p of polys) {
          if (p.box[0] > e || p.box[2] < w || p.box[1] > n || p.box[3] < s) continue;
          ctx.beginPath();
          for (const ring of p.rings) { ring.forEach((c, i) => (i ? ctx.lineTo((c[0] - w) * kx, (n - c[1]) * ky) : ctx.moveTo((c[0] - w) * kx, (n - c[1]) * ky))); ctx.closePath(); }
          ctx.fillStyle = typeof p.color === 'string' ? p.color : ctx.createPattern(p.color, 'repeat');
          ctx.fill('evenodd'); // holes stay empty
        }
        return Promise.resolve(cv);
      },
    });
    layer.alpha = 0.45;
    return layer;
  }
  function lineLayer(lines, color, width = 1.2) { // lines: arrays of [lon, lat]; drawn per tile like fillLayer
    const scheme = new C.GeographicTilingScheme(), TS = 256, deg = C.Math.toDegrees;
    const ls = lines.filter((p) => p.length > 1).map((p) => ({ p, box: turf.bbox({ type: 'LineString', coordinates: p }) }));
    return viewer.imageryLayers.addImageryProvider({
      tilingScheme: scheme, rectangle: scheme.rectangle, tileWidth: TS, tileHeight: TS, minimumLevel: 0, maximumLevel: 14,
      hasAlphaChannel: true, errorEvent: new C.Event(), credit: undefined, tileDiscardPolicy: undefined, proxy: undefined,
      getTileCredits: () => undefined, pickFeatures: () => undefined,
      requestImage(x, y, level) {
        const cv = document.createElement('canvas'), ctx = cv.getContext('2d'), r = scheme.tileXYToRectangle(x, y, level);
        cv.width = cv.height = TS;
        const w = deg(r.west), e = deg(r.east), s = deg(r.south), n = deg(r.north), kx = TS / (e - w), ky = TS / (n - s);
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.beginPath();
        for (const { p, box } of ls) {
          if (box[0] > e || box[2] < w || box[1] > n || box[3] < s) continue;
          p.forEach((c, i) => (i ? ctx.lineTo((c[0] - w) * kx, (n - c[1]) * ky) : ctx.moveTo((c[0] - w) * kx, (n - c[1]) * ky)));
        }
        ctx.stroke();
        return Promise.resolve(cv);
      },
    });
  }
  // Greedy coloring: each territory takes the color least used by the earlier ones whose bounding box touches its own,
  // so neighbors differ wherever the palette allows.
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)), NEAR = TINTS.map((x) => TINTS.map((y) => Math.hypot(...rgb(x).map((v, k) => v - rgb(y)[k])) < 80));
  function colorize(geoms) {
    const boxes = geoms.map((g) => (g ? turf.bbox(g) : null)), out = [];
    geoms.forEach((g, i) => {
      const used = new Array(TINTS.length).fill(0), a = boxes[i];
      if (a) for (let j = 0; j < i; j++) { const b = boxes[j]; if (b && a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]) TINTS.forEach((_, c) => { used[c] += c === out[j][1] ? 1 : NEAR[out[j][1]][c] ? 0.6 : 0; }); } // a look-alike tint (red, salmon, brown) counts almost as the same
      let best = i % TINTS.length; // rotating start: the whole palette gets used
      for (let k = 0, c = best; k < TINTS.length; k++, c = (c + 1) % TINTS.length) if (used[c] < used[best]) best = c;
      out.push([g, best]);
    });
    return out;
  }
  // Loads a fill the first time its checkbox is ticked; if it fails, it is retried when ticked again.
  function lazyFill(cb, load, what) {
    let prim = null, busy = false;
    const sync = async () => {
      if (prim) prim.show = cb.checked;
      if (!cb.checked || prim || busy) return;
      busy = true;
      try { prim = fillLayer(await load()); prim.show = cb.checked; } catch (e) { OGE.toast(`No se pudieron cargar ${what}: ${e.message}`, true); }
      busy = false;
    };
    cb.addEventListener('change', sync);
    sync();
  }
  const buf = (path) => fetch(FORK + path).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); });
  lazyFill($('fillCountries'), async () => { // neighbors get different colors (Natural Earth's MAPCOLOR7 gave Israel and Palestine the same one)
    const [s, d, ds, dd] = await Promise.all(['50m_cultural/ne_50m_admin_0_countries.shp', '50m_cultural/ne_50m_admin_0_countries.dbf', '10m_cultural/ne_10m_admin_0_disputed_areas.shp', '10m_cultural/ne_10m_admin_0_disputed_areas.dbf'].map(buf));
    const clean = (v) => String(v ?? '').replace(/\0/g, '').trim(), fs = shp.combine([shp.parseShp(s), shp.parseDbf(d)]).features, a3 = (f) => clean(f.properties.ADM0_A3);
    const out = colorize(fs.map((f) => f.geometry)), idx = new Map(fs.map((f, i) => [a3(f), out[i][1]]));
    OGE.tintOf = (k) => (idx.has(k) ? TINTS[idx.get(k) % TINTS.length] : null); if (OGE.redrawClaims) OGE.redrawClaims(); // the Chilean Antarctic claim takes Chile's color
    if (OGE.taiwanCN) fs.forEach((f, i) => { if (a3(f) === 'TWN' && idx.has('CHN')) out[i][1] = idx.get('CHN'); }); // Taiwan in China's color from China
    if (OGE.malvinasAR) fs.forEach((f, i) => { if (['FLK', 'SGS'].includes(a3(f)) && idx.has('ARG')) out[i][1] = idx.get('ARG'); }); // Malvinas and South Georgia in Argentina's color from that point of view
    for (const f of shp.combine([shp.parseShp(ds), shp.parseDbf(dd)]).features) { // Crimea and the other areas claimed by Ukraine, in Ukraine's color (painted over the rest)
      const p = f.properties;
      const pc = OGE.povClaims;
      if (f.geometry && OGE.pov === 'RU' && ['Abkhazia', 'South Ossetia'].includes(clean(p.BRK_NAME))) { // their own country color from Russia: one not used by Georgia or Russia
        const busy = [idx.get('GEO'), idx.get('RUS'), ...out.filter((x) => x[2] === 'cauc').map((x) => x[1])];
        out.push([f.geometry, TINTS.findIndex((_, c) => !busy.some((b) => b === c || NEAR[b]?.[c])), 'cauc']); continue;
      }
      if (f.geometry && pc && pc[1].includes(clean(p.BRK_NAME)) && idx.has(pc[0])) { out.push([f.geometry, idx.get(pc[0])]); continue; } // claimed from this point of view
      if (f.geometry && OGE.pov !== 'RU' && idx.has('UKR') && /Ukrain/i.test(clean(p.NOTE_BRK) + ' ' + clean(p.BRK_NAME) + ' ' + clean(p.NAME))) out.push([f.geometry, idx.get('UKR')]);
    }
    if (OGE.antarticaCL && idx.has('CHL')) out.push([{ type: 'Polygon', coordinates: [[[-90, -60], [-53, -60], [-53, -89.99], [-90, -89.99], [-90, -60]]] }, idx.get('CHL')]); // the Chilean Antarctic Territory in Chile's color
    return out;
  }, 'las áreas de los países');
  lazyFill($('fillAdmin1'), async () => {
    OGE.toast('Cargando las áreas de provincias y regiones (21 MB)…');
    // simplified to ~1 km: the full detail is over a million vertices; the .dbf is not needed
    return colorize(shp.parseShp(await buf('10m_cultural/ne_10m_admin_1_states_provinces.shp')).map((g) => g && turf.simplify(g, { tolerance: 0.01, mutate: true })));
  }, 'las áreas de provincias y regiones');

  // ---------- Weather: current conditions and 5-day forecast for the world's main cities (Open-Meteo, no key) ----------
  // WMO weather code -> [icon, Spanish text]
  const WMO = (c, day) => (c === 0 ? [day ? '☀️' : '🌙', 'Despejado'] : c <= 2 ? [day ? '⛅' : '☁️', 'Parcialmente nublado'] : c === 3 ? ['☁️', 'Nublado'] : c <= 48 ? ['🌫️', 'Niebla']
    : c <= 57 ? ['🌦️', 'Llovizna'] : c <= 67 ? ['🌧️', 'Lluvia'] : c <= 77 ? ['❄️', 'Nieve'] : c <= 82 ? ['🌧️', 'Chubascos'] : c <= 86 ? ['❄️', 'Nevadas'] : ['⛈️', 'Tormenta']);
  function weatherImage(icon, temp, name) { // drawn at 2x and shown at scale 0.5
    const cv = document.createElement('canvas'), g = cv.getContext('2d');
    cv.width = 220; cv.height = 110;
    g.textAlign = 'center'; g.lineJoin = 'round'; g.strokeStyle = '#000'; g.fillStyle = '#fff';
    g.font = '52px sans-serif'; g.fillText(icon, 66, 56);
    g.font = '700 38px sans-serif'; g.lineWidth = 6; g.strokeText(temp, 152, 50, 128); g.fillText(temp, 152, 50, 128);
    g.font = '600 24px sans-serif'; g.lineWidth = 5; g.strokeText(name, 110, 96, 212); g.fillText(name, 110, 96, 212);
    return cv;
  }
  let weather = null, weatherBusy = false;
  const cbW = $('layerWeather'), wx = []; // wx: { e, w, name } per city
  // What the icons show; switched with the arrows of the bar at the top of the map.
  const MODES = ['Clima actual', 'Hoy: máxima y mínima', 'Mañana', 'Índice UV de hoy'];
  let wxMode = 0;
  const wxBar = Object.assign(document.createElement('div'), { id: 'wxBar', hidden: true, style: 'position:absolute;top:104px;left:50%;transform:translateX(-50%);z-index:1;background:rgba(20,110,40,.92);color:#fff;border-radius:16px;padding:3px 6px;font-weight:700;display:flex;gap:8px;align-items:center' });
  wxBar.innerHTML = '<button class="mini">◀</button><span></span><button class="mini">▶</button>';
  $('main').append(wxBar);
  function paintWeather() {
    wxBar.children[1].textContent = T(MODES[wxMode]);
    for (const { e, w, name } of wx) {
      const d = w.daily, j = wxMode === 2 ? 1 : 0;
      const [icon, val] = wxMode === 0 ? [WMO(w.current.weather_code, w.current.is_day)[0], Math.round(w.current.temperature_2m) + '°']
        : wxMode === 3 ? ['☀️', 'UV ' + Math.round(d.uv_index_max[0] ?? 0)] : [WMO(d.weather_code[j], 1)[0], Math.round(d.temperature_2m_max[j]) + '°/' + Math.round(d.temperature_2m_min[j]) + '°'];
      e.billboard.image = weatherImage(icon, val, name);
    }
  }
  wxBar.children[0].onclick = () => { wxMode = (wxMode + MODES.length - 1) % MODES.length; paintWeather(); };
  wxBar.children[2].onclick = () => { wxMode = (wxMode + 1) % MODES.length; paintWeather(); };
  async function loadWeather() {
    const [s, d] = await Promise.all([buf('110m_cultural/ne_110m_populated_places_simple.shp'), buf('110m_cultural/ne_110m_populated_places_simple.dbf')]);
    const cities = shp.combine([shp.parseShp(s), shp.parseDbf(d)]).features.filter((f) => f.geometry);
    const ds = new C.CustomDataSource('Clima'), clean = (v) => String(v ?? '').replace(/\0/g, '').trim();
    ds.isLayer = true; // does not appear in Places and is not saved
    for (let i = 0; i < cities.length; i += 100) { // Open-Meteo takes many places per request
      const part = cities.slice(i, i + 100), ll = part.map((f) => f.geometry.coordinates);
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${ll.map((c) => c[1].toFixed(2))}&longitude=${ll.map((c) => c[0].toFixed(2))}` +
        '&current=temperature_2m,weather_code,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min,uv_index_max&forecast_days=5&timezone=auto');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      [].concat(await res.json()).forEach((w, k) => {
        const p = part[k].properties, name = clean(p.name || p.NAME), rank = +(p.scalerank ?? p.SCALERANK ?? 5);
        const [icon, text] = WMO(w.current.weather_code, w.current.is_day), temp = Math.round(w.current.temperature_2m) + '°';
        // forecast as five columns: weekday, icon, maximum and minimum
        const day = (t) => new Date(t + 'T12:00').toLocaleDateString(OGE_LANG, { weekday: 'short' }).toUpperCase(), cell = 'style="padding:4px 10px;text-align:center"';
        const row = (fn, st) => `<tr style="${st}">${w.daily.time.map((t, j) => `<td ${cell}>${fn(t, j)}</td>`).join('')}</tr>`;
        const table = `<table style="border-collapse:collapse;background:linear-gradient(#1a4fa0,#0b2a66);color:#fff;border-radius:6px">` +
          row((t) => day(t), 'font-weight:700;background:#0b2a66') + row((t, j) => WMO(w.daily.weather_code[j], 1)[0], 'font-size:26px') +
          row((t, j) => Math.round(w.daily.temperature_2m_max[j]) + '°', 'font-size:18px;font-weight:700;color:#ffd60a') + row((t, j) => Math.round(w.daily.temperature_2m_min[j]) + '°', 'font-size:18px;font-weight:700;color:#9fd3ff') + '</table>';
        const e = ds.entities.add({ name: `${name}: ${temp}C, ${T(text)}`, position: C.Cartesian3.fromDegrees(ll[k][0], ll[k][1]),
          billboard: { image: weatherImage(icon, temp, name), scale: 0.5, disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: new C.DistanceDisplayCondition(0, rank <= 1 ? 4e7 : rank <= 3 ? 1.2e7 : 6e6) }, // smaller cities appear when zooming in
          description: `<p style="font-size:18px">${icon} <b>${temp}C</b> · ${T(text)}</p><p><b>${T('Pronóstico de 5 días')}</b></p>${table}<p><a href="https://open-meteo.com/" target="_blank">Open-Meteo</a> (CC BY 4.0)</p>` });
        wx.push({ e, w, name });
      });
    }
    const occluder = new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, viewer.camera.positionWC); // the icons are not depth-tested: hide the far side by hand
    viewer.scene.preRender.addEventListener(() => {
      if (!ds.show) return;
      occluder.cameraPosition = viewer.camera.positionWC;
      for (const e of ds.entities.values) e.show = occluder.isPointVisible(e.position.getValue());
    });
    await viewer.dataSources.add(ds);
    return ds;
  }
  const syncWeather = async () => {
    if (weather) weather.show = cbW.checked;
    wxBar.hidden = !cbW.checked || !weather;
    if (!cbW.checked || weather || weatherBusy) return;
    weatherBusy = true;
    try { weather = await loadWeather(); weather.show = cbW.checked; wxBar.hidden = !cbW.checked; paintWeather(); } catch (e) { OGE.toast('No se pudo cargar el clima: ' + e.message, true); }
    weatherBusy = false;
  };
  cbW.addEventListener('change', syncWeather);
  syncWeather();

  // Weather where you are looking: with the weather layer on and the camera low, rain, snow or a thunderstorm falls over the view
  // (Open-Meteo's current weather code for the point below the camera, asked again every 5 minutes or after moving ~30 km).
  const fx = Object.assign(document.createElement('canvas'), { id: 'wxFx' });
  fx.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2';
  viewer.container.appendChild(fx);
  let fxKind = null, fxLevel = 0, fxAt = null, fxT = 0, flashT = 0; const drops = [];
  async function askWeatherHere() {
    const c = viewer.camera.positionCartographic, lon = C.Math.toDegrees(c.longitude), lat = C.Math.toDegrees(c.latitude);
    if (!(cbW.checked || OGE.fxForce) || c.height > 6e4) { fxKind = null; return; } // only close to the ground; the game shows the weather without the layer
    if (fxAt && performance.now() - fxT < 3e5 && Math.hypot(lon - fxAt[0], lat - fxAt[1]) < 0.3) return;
    fxAt = [lon, lat]; fxT = performance.now();
    try {
      const j = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}&current=weather_code`)).json(), w = j.current && j.current.weather_code;
      fxKind = w >= 95 ? 'storm' : (w >= 71 && w <= 77) || w === 85 || w === 86 ? 'snow' : (w >= 51 && w <= 67) || (w >= 80 && w <= 82) ? 'rain' : null;
      fxLevel = w >= 95 ? 1 : [55, 57, 65, 67, 75, 82, 86].includes(w) ? 1 : [53, 63, 73, 81].includes(w) ? 0.6 : 0.3; // heavy, moderate or light
    } catch { fxKind = null; }
  }
  setInterval(askWeatherHere, 5000);
  cbW.addEventListener('change', () => { fxAt = null; askWeatherHere(); });
  (function frame() {
    requestAnimationFrame(frame);
    const g = fx.getContext('2d'), W = fx.clientWidth, H = fx.clientHeight, low = viewer.camera.positionCartographic.height < 6e4;
    if (fx.width !== W || fx.height !== H) { fx.width = W; fx.height = H; }
    if (!fxKind || !low || !(cbW.checked || OGE.fxForce)) { if (drops.length) { g.clearRect(0, 0, W, H); drops.length = 0; } return; }
    g.clearRect(0, 0, W, H);
    const snow = fxKind === 'snow', want = Math.round((snow ? 220 : 380) * fxLevel);
    while (drops.length < want) drops.push({ x: Math.random() * W, y: Math.random() * H, v: snow ? 40 + Math.random() * 50 : 700 + Math.random() * 500, r: snow ? 1.5 + Math.random() * 2.5 : 0, ph: Math.random() * 6 });
    drops.length = Math.min(drops.length, want);
    const dt = 1 / 60;
    g.strokeStyle = 'rgba(200,220,255,.55)'; g.lineWidth = 1.2; g.fillStyle = 'rgba(255,255,255,.9)';
    g.beginPath();
    for (const d of drops) {
      d.y += d.v * dt; if (snow) d.x += Math.sin(performance.now() / 700 + d.ph) * 0.6; else d.x -= d.v * dt * 0.15;
      if (d.y > H) { d.y = -10; d.x = Math.random() * W; }
      if (snow) { g.moveTo(d.x + d.r, d.y); g.arc(d.x, d.y, d.r, 0, 7); } else { g.moveTo(d.x, d.y); g.lineTo(d.x + d.v * 0.012 * 0.15, d.y - d.v * 0.012); }
    }
    snow ? g.fill() : g.stroke();
    if (fxKind === 'storm') { // lightning: a white flash and a jagged bolt now and then
      const now = performance.now();
      if (now > flashT && Math.random() < 0.004) { flashT = now + 180; if (OGE.onLightning) OGE.onLightning(); }
      if (flashT - now > 0) {
        g.fillStyle = `rgba(255,255,255,${(flashT - now) / 180 * 0.5})`; g.fillRect(0, 0, W, H);
        g.strokeStyle = 'rgba(255,255,240,.95)'; g.lineWidth = 3; g.beginPath(); let x = W * (0.2 + Math.random() * 0.6), y = 0; g.moveTo(x, y);
        while (y < H * 0.7) { x += (Math.random() - 0.5) * 60; y += 20 + Math.random() * 40; g.lineTo(x, y); } g.stroke();
      }
    }
  })();

  // ---------- Country flags: Natural Earth's Wikidata id -> flag file (property P41) -> Commons thumbnail ----------
  let flagsP = null; // Promise<Map<ADM0_A3, { url, lon, lat, rank, name, cont }>>
  const flagData = () => flagsP || (flagsP = (async () => {
    const clean = (v) => String(v ?? '').replace(/\0/g, '').trim();
    const rows = shp.parseDbf(await buf('50m_cultural/ne_50m_admin_0_countries.dbf')).map((p) => ({ dep: !/country/i.test(clean(p.TYPE)), a3: clean(p.ADM0_A3), q: clean(p.WIKIDATAID), lon: +p.LABEL_X, lat: +p.LABEL_Y, rank: +p.LABELRANK || 5, name: clean(p.NAME_ES) || clean(p.NAME), cont: clean(p.CONTINENT) }))
      .filter((r) => /^Q\d+$/.test(r.q) && isFinite(r.lon) && isFinite(r.lat));
    const sparql = `SELECT ?c ?f ?a WHERE { VALUES ?c { ${rows.map((r) => 'wd:' + r.q).join(' ')} } OPTIONAL { ?c wdt:P41 ?f } OPTIONAL { ?c wdt:P94 ?a } }`; // flag and coat of arms
    const wd = await (await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(sparql))).json();
    const file = new Map(), arms = new Map(), name = (u) => decodeURIComponent(u.split('FilePath/')[1]).replace(/_/g, ' '); // Wikidata id -> Commons file name
    for (const b of wd.results.bindings) { const q = b.c.value.split('/').pop(); if (b.f && !file.has(q)) file.set(q, name(b.f.value)); if (b.a && !arms.has(q)) arms.set(q, name(b.a.value)); }
    const names = [...new Set([...file.values(), ...arms.values()])], thumb = new Map(); // file name -> thumbnail URL
    for (let i = 0; i < names.length; i += 50) { // the Commons API takes 50 titles per request
      const js = await (await fetch('https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url&iiurlwidth=48&format=json&origin=*&titles=' + encodeURIComponent(names.slice(i, i + 50).map((n) => 'File:' + n).join('|')))).json();
      for (const p of Object.values(js.query.pages)) if (p.imageinfo) thumb.set(p.title.replace(/^File:/, ''), p.imageinfo[0].thumburl);
    }
    const out = new Map();
    for (const r of rows) { const url = thumb.get(file.get(r.q)), crest = thumb.get(arms.get(r.q)); if (url) out.set(r.a3, { ...r, url, arms: crest ? crest.replace(/\/\d+px-/, '/250px-') : null }); } // a bigger thumbnail for the coat of arms (Wikimedia only serves its standard widths: 160 px is refused)
    if (OGE.malvinasAR && out.has('ARG') && out.has('FLK')) { const ar = out.get('ARG'), fk = out.get('FLK'); out.set('FLK', { ...fk, url: ar.url, a3: 'ARG', name: ar.name, cont: ar.cont }); } // Argentina's flag over the Malvinas from that point of view
    return out;
  })().catch((e) => { flagsP = null; throw e; }));
  OGE.flags = flagData; // the flight game reuses them
  let flagLayer = null, flagBusy = false;
  const cbF = $('layerFlags');
  const syncFlags = async () => {
    if (flagLayer) flagLayer.show = cbF.checked;
    if (!cbF.checked || flagLayer || flagBusy) return;
    flagBusy = true;
    try {
      const data = await flagData(), bills = viewer.scene.primitives.add(new C.BillboardCollection());
      for (const [key, f] of data) {
        if ((OGE.malvinasAR && (key === 'FLK' || key === 'SGS')) || (OGE.taiwanCN && key === 'TWN')) continue; // part of Argentina from that point of view: no flag of their own
        // dependencies and other non-sovereign territories are treated as subnational: their flag is optional and their card is a region's
        bills.add({ id: { oge: f.dep ? 'region' : 'country', q: f.q, a3: f.a3, name: f.name }, position: C.Cartesian3.fromDegrees(f.lon, f.lat), image: f.url, scale: 0.4, pixelOffset: new C.Cartesian2(0, -16), disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new C.DistanceDisplayCondition(0, 2.2e7 / Math.max(1, f.rank - 1)) })._dep = f.dep; // small countries and islands appear when zooming in, like their names
      }
      const occluder = new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, viewer.camera.positionWC);
      viewer.scene.preRender.addEventListener(() => { if (!bills.show) return; occluder.cameraPosition = viewer.camera.positionWC; for (let i = 0; i < bills.length; i++) { const b = bills.get(i); b.show = occluder.isPointVisible(b.position) && (!b._dep || $('layerFlagsDep').checked); } });
      flagLayer = bills; flagLayer.show = cbF.checked;
    } catch (e) { OGE.toast('No se pudieron cargar las banderas: ' + e.message, true); }
    flagBusy = false;
  };
  cbF.addEventListener('change', syncFlags);
  syncFlags();

  // ---------- Capitals (red star) and cities (red circle), like the old versions of Earth; a click shows their Wikidata facts ----------
  const dotImage = (star) => { // drawn at 2x and shown small
    const cv = Object.assign(document.createElement('canvas'), { width: 36, height: 36 }), g = cv.getContext('2d');
    g.translate(18, 18); g.beginPath();
    if (star) { for (let i = 0; i < 10; i++) { const r = i % 2 ? 6.5 : 15, a = (i * Math.PI) / 5 - Math.PI / 2; g.lineTo(r * Math.cos(a), r * Math.sin(a)); } g.closePath(); } else g.arc(0, 0, 9, 0, 7);
    g.fillStyle = '#e8112d'; g.fill(); g.lineJoin = 'round'; g.lineWidth = star ? 2.5 : 4; g.strokeStyle = '#fff'; g.stroke();
    return cv;
  };
  let placesP = null; // the populated places are loaded once for both layers
  const placeData = () => placesP || (placesP = (async () => {
    const [s, d] = await Promise.all([buf('110m_cultural/ne_110m_populated_places.shp'), buf('110m_cultural/ne_110m_populated_places.dbf')]);
    const clean = (v) => String(v ?? '').replace(/\0/g, '').trim();
    return shp.combine([shp.parseShp(s), shp.parseDbf(d)]).features.filter((f) => f.geometry).map((f) => { const p = f.properties; return { lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
      name: clean(OGE_LANG === 'en' ? p.NAME_EN : p.NAME_ES) || clean(p.NAME), q: clean(p.WIKIDATAID), capital: +p.ADM0CAP === 1, rank: +p.SCALERANK || 0 }; });
  })().catch((e) => { placesP = null; throw e; }));
  let moreP = null; // the 10m places (simple file: no Wikidata ids, no translated names), only for the cities layer
  const moreData = () => moreP || (moreP = (async () => {
    const [base, s, d] = await Promise.all([placeData(), buf('10m_cultural/ne_10m_populated_places_simple.shp'), buf('10m_cultural/ne_10m_populated_places_simple.dbf')]);
    const clean = (v) => String(v ?? '').replace(/\0/g, '').trim(), near = (a, b) => Math.abs(a.lon - b.lon) < 0.15 && Math.abs(a.lat - b.lat) < 0.15;
    return shp.combine([shp.parseShp(s), shp.parseDbf(d)]).features.filter((f) => f.geometry && +f.properties.adm0cap !== 1).map((f) => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], name: clean(f.properties.name), q: '', capital: false, rank: +f.properties.scalerank || 0 }))
      .filter((c) => !base.some((b) => near(b, c))); // the big ones are already there, with their Wikidata card
  })().catch((e) => { moreP = null; throw e; }));
  function placeLayer(cb, capital) { // capital: true = the capitals layer, false = the other cities
    let layer = null, busy = false;
    const sync = async () => {
      if (layer) layer.show = cb.checked;
      if (!cb.checked || layer || busy) return;
      busy = true;
      try {
        const bills = viewer.scene.primitives.add(new C.BillboardCollection()), image = dotImage(capital);
        for (const c of (capital ? await placeData() : [...await placeData(), ...await moreData()]).filter((x) => x.capital === capital)) {
          const far = capital ? 2.5e7 : c.rank <= 1 ? 2e7 : c.rank <= 4 ? 9e6 : c.rank <= 7 ? 3e6 : 1.2e6; // smaller towns appear as one zooms in
          const common = { position: C.Cartesian3.fromDegrees(c.lon, c.lat), disableDepthTestDistance: Number.POSITIVE_INFINITY, id: { oge: 'place', q: c.q, name: c.name, capital } };
          bills.add({ ...common, scale: capital ? 0.32 : 0.4, image, distanceDisplayCondition: new C.DistanceDisplayCondition(0, capital ? 7e6 : far) });
          bills.add({ ...common, scale: 0.5, image: OGE.textImage(c.name, '600 12px sans-serif', C.Color.WHITE), pixelOffset: new C.Cartesian2(0, 15), distanceDisplayCondition: new C.DistanceDisplayCondition(0, Math.min(5e6, far / 2)) }); // names when zooming in
        }
        const occluder = new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, viewer.camera.positionWC);
        viewer.scene.preRender.addEventListener(() => { if (!bills.show) return; occluder.cameraPosition = viewer.camera.positionWC; for (let i = 0; i < bills.length; i++) { const b = bills.get(i); b.show = occluder.isPointVisible(b.position); } });
        layer = bills; layer.show = cb.checked;
      } catch (e) { OGE.toast('No se pudieron cargar las capitales: ' + e.message, true); }
      busy = false;
    };
    cb.addEventListener('change', sync);
    sync();
  }
  placeLayer($('layerCapitals'), true);
  placeLayer($('layerCities'), false);

  // ---------- Wikidata facts of a country, a capital or a city, like Wikipedia's infobox; a click on its name, flag or symbol opens them ----------
  const FACTS = {
    country: [['capital', 'Capital', 'P36'], ['pop', 'Población', 'P1082'], ['area', 'Superficie', 'P2046'], ['currency', 'Moneda', 'P38'], ['lang', 'Idioma oficial', 'P37'], ['religion', 'Religión oficial', 'P3075'], ['worldview', 'Religión o creencia', 'P140'], ['spoken', 'Idioma más hablado', 'P2936'], ['hos', 'Jefe de Estado', 'P35'], ['hog', 'Jefe de Gobierno', 'P6'],
      ['gov', 'Forma de gobierno', 'P122'], ['gdp', 'PIB nominal', 'P2131'], ['hdi', 'Índice de desarrollo humano', 'P1081'], ['inception', 'Fundación', 'P571'], ['code', 'Prefijo telefónico', 'P474'], ['tld', 'Dominio de internet', 'P78'], ['cont', 'Continente', 'P30'], ['anthem', 'Himno nacional', 'P85']],
    region: [['country', 'País', 'P17'], ['capital', 'Capital', 'P36'], ['pop', 'Población', 'P1082'], ['area', 'Superficie', 'P2046'], ['hog', 'Gobernador o jefe de gobierno', 'P6'], ['inception', 'Fundación', 'P571'], ['tz', 'Zona horaria', 'P421'], ['web', 'Sitio web', 'P856']],
    place: [['country', 'País', 'P17'], ['admin', 'Región', 'P131'], ['pop', 'Población', 'P1082'], ['area', 'Superficie', 'P2046'], ['elev', 'Altitud', 'P2044'], ['inception', 'Fundación', 'P571'], ['hog', 'Alcalde o jefe de gobierno', 'P6'], ['tz', 'Zona horaria', 'P421'], ['web', 'Sitio web', 'P856']],
  };
  async function wikiInfo(id) {
    OGE.chime(id.capital); // capitals get the bigger sound
    OGE.toast('Consultando Wikidata…');
    try {
      const facts = FACTS[id.oge];
      // one branch per fact (a UNION), so that multi-valued facts do not multiply each other; the anthem's recording is a qualifier of the country's anthem statement, or comes through the anthem's own item
      const sparql = `SELECT ?k ?v ?vLabel ?when ?pp WHERE { ${facts.map(([k, , p]) => `{ BIND("${k}" AS ?k) wd:${id.q} ${k === 'cont' ? `p:${p}/ps:${p}` : `wdt:${p}`} ?v }`).join(' UNION ')} UNION { BIND("audio" AS ?k) { wd:${id.q} p:P85 ?ast . ?ast pq:P51 ?v } UNION { wd:${id.q} wdt:P85 ?a . ?a wdt:P51 ?v } } ${id.oge === 'country' ? ['hos:P35', 'hog:P6'].map((x) => { const [k, p] = x.split(':'); const all = `wd:${id.q} wdt:${p} ?h . ?h p:P102 ?st . ?st ps:P102 ?pt . OPTIONAL { ?st pq:P580 ?from } OPTIONAL { ?st pq:P582 ?to }`; // every party the leader has belonged to, with its dates
          return `UNION { BIND("${k}Party" AS ?k) ${all} BIND(?pt AS ?v) BIND(COALESCE(?to, ?from) AS ?when) BIND(IF(BOUND(?to), "past", "now") AS ?pp) } UNION { BIND("${k}Pos" AS ?k) ${all} ?pt wdt:P1387 ?v }`; }).join(' ') : ''} UNION { BIND("flag" AS ?k) wd:${id.q} wdt:P41 ?v } UNION { BIND("arms" AS ?k) wd:${id.q} wdt:P94 ?v } UNION { BIND("banner" AS ?k) wd:${id.q} wdt:P948 ?v } SERVICE wikibase:label { bd:serviceParam wikibase:language "${OGE_LANG},en". } }`;
      const res = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(sparql));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const rows = (await res.json()).results.bindings, num = (v) => Number(v).toLocaleString(OGE_LANG);
      const fmt = { pop: (v) => num(v), area: (v) => num(v) + ' km²', elev: (v) => num(v) + ' m', gdp: (v) => 'US$ ' + num(Math.round(v)), inception: (v) => String(new Date(v).getUTCFullYear()), hdi: (v) => String(v), web: (v) => v };
      const table = [];
      for (const [k, label] of facts) {
        const vals = [...new Set(rows.filter((r) => r.k.value === k).map((r) => (fmt[k] ? fmt[k](r.v.value) : r.vLabel.value)))].slice(0, fmt[k] ? 1 : 6);
        const lab = (kk) => [...new Set(rows.filter((r) => r.k.value === kk).map((r) => r.vLabel.value))].slice(0, 2);
        // the leader's current party (or the latest one, if none is current) and the left-right position of every party he or she belonged to
        const parties = rows.filter((r) => r.k.value === k + 'Party'), isIndep = (r) => /independ/i.test(r.vLabel.value);
        const now = parties.filter((r) => r.pp && r.pp.value === 'now'), byDate = (a, b) => String(b.when ? b.when.value : '').localeCompare(String(a.when ? a.when.value : ''));
        const current = now.filter((r) => !isIndep(r)).sort(byDate)[0], latestReal = parties.filter((r) => !isIndep(r)).sort(byDate)[0];
        const independentNow = !current && (now.some(isIndep) || (latestReal && latestReal.pp.value === 'past'));
        const partyTxt = current ? current.vLabel.value : independentNow ? T('independiente') + (latestReal ? ` (${T('antes')}: ${latestReal.vLabel.value})` : '') : latestReal ? latestReal.vLabel.value : '';
        const side = (t) => (/izquierda|left/.test(t) ? -1 : /derecha|right/.test(t) ? 1 : /centro|centre|center/.test(t) ? 0 : null); // far-right counts as right, far-left as left
        const sides = rows.filter((r) => r.k.value === k + 'Pos').map((r) => side(r.vLabel.value.toLowerCase())).filter((x) => x !== null), avg = sides.length ? sides.reduce((a, b) => a + b, 0) / sides.length : null;
        const pos = avg === null ? null : avg <= -0.5 ? ['Izquierda', '#d9483b'] : avg < -0.15 ? ['Centroizquierda', '#e88a6a'] : avg <= 0.15 ? ['Centro', '#e0b020'] : avg < 0.5 ? ['Centroderecha', '#5d9be0'] : ['Derecha', '#1f5fbf'];
        if (vals.length) table.push([T(label), vals.join(', ') + (partyTxt ? ' — ' + partyTxt : '') + (pos ? `\u0002${T(pos[0])}\u0002${pos[1]}` : '')]);
      }
      if (id.osm) table.push(...osmRows(id.osm)); // OpenStreetMap adds its own facts to a municipality or region
      const claim = id.oge === 'country' && OGE.claims && OGE.claims[id.a3];
      if (claim) table.push([T('Reclamación antártica'), `${T(claim[0])} (${claim[2].map(([w, e]) => `${Math.abs(w)}° ${w < 0 ? 'O' : 'E'} – ${Math.abs(((e + 540) % 360) - 180)}° ${((e + 540) % 360) - 180 < 0 ? 'O' : 'E'}`).join(', ')}, ${T('al sur de 60° S')}) — ${T('congelada por el Tratado Antártico')}`]);
      if (!table.length) throw new Error('sin datos');
      if (id.oge === 'country') { // the continent holding most of its land goes first (Natural Earth's CONTINENT field)
        const main = ((await OGE.flags().catch(() => new Map())).get(id.a3) || {}).cont, CN = { Africa: 'Áfr', Asia: 'Asia', Europe: 'Europ', 'North America': 'Norte|North', 'South America': 'Sur|South', Oceania: 'Ocean' };
        const row = table.find((r) => r[0] === T('Continente'));
        if (row && main && CN[main]) { const parts = row[1].split(', '), re = new RegExp(CN[main], 'i'); row[1] = [...parts.filter((p) => re.test(p) && !/insular/i.test(p)), ...parts.filter((p) => !re.test(p) || /insular/i.test(p))].join(', '); }
      }
      const tops = []; // full rankings behind the chips
      const rawOf = (k) => { const r = rows.find((x) => x.k.value === k); return r ? +r.v.value : NaN; }, dens = rawOf('pop') / rawOf('area');
      if (isFinite(dens) && dens > 0) table.splice(table.findIndex((r) => r[0] === T('Superficie')) + 1, 0, [T('Densidad'), num(Math.round(dens * 10) / 10) + ' ' + T('hab./km²')]);
      if (id.oge === 'country') { // rankings in the world and in its continent, and World Bank open data
        const CN = { Africa: 'África', Asia: 'Asia', Europe: 'Europa', 'North America': 'Norteamérica', 'South America': 'Sudamérica', Oceania: 'Oceanía' };
        const flags = await OGE.flags().catch(() => new Map()), contOf = (a3) => (flags.get(a3) || {}).cont, byQ = new Map([...flags].map(([a3, f]) => [f.q, a3]));
        const rank = (m, key, label = '', fmtV = (v) => num(v)) => { // m: Map<ISO3, value>
          const me = m.get(key);
          if (me == null) return '';
          const all = [...m.values()], same = [...m].filter(([k]) => contOf(k) === contOf(key)).map(([, v]) => v);
          const list = (pred) => tops.push({ label, rows: [...m].filter(([k]) => pred(k)).sort((a, b) => b[1] - a[1]).map(([k, v], i) => [i + 1, (flags.get(k) || {}).name || k, fmtV(v), k]) }) - 1; // kept for the click on the chip
          return `\u0001${all.filter((v) => v > me).length + 1}/${all.length}/${T('mundo')}/${list(() => true)}\u0001${same.filter((v) => v > me).length + 1}/${same.length}/${T(CN[contOf(key)] || contOf(key) || '')}/${list((k) => contOf(k) === contOf(key))}`; // rank/total/where/list, drawn as chips

        };
        const add = (label, txt) => { const row = table.find((r) => r[0] === T(label)); if (row && txt) row[1] += txt; };
        const wb = async (code) => { // latest value of a World Bank indicator for every country
          const j = await (await fetch(`https://api.worldbank.org/v2/country/all/indicator/${code}?format=json&mrnev=1&per_page=400`)).json(), m = new Map(), year = new Map();
          for (const d of j[1] || []) if (flags.has(d.countryiso3code) && d.value != null) { m.set(d.countryiso3code, d.value); year.set(d.countryiso3code, d.date); }
          return { m, year };
        };
        const usd = (v) => 'US$ ' + num(Math.round(v));
        try { // its two most populous cities
          const q3 = `SELECT ?cLabel (MAX(?p) AS ?pop) WHERE { VALUES ?t { wd:Q515 wd:Q1549591 wd:Q1637706 wd:Q174844 wd:Q5119 } ?c wdt:P31 ?t ; wdt:P17 wd:${id.q} ; wdt:P1082 ?p . SERVICE wikibase:label { bd:serviceParam wikibase:language "${OGE_LANG},en". } } GROUP BY ?cLabel ORDER BY DESC(?pop) LIMIT 5`;
          const top = (await (await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q3))).json()).results.bindings;
          const seen = []; // the metropolitan area and its own city are the same place: skip names already contained in one another
          const uniq = top.filter((b3) => { const n = b3.cLabel.value.toLowerCase().replace(/ (city|metropolitan area|área metropolitana|greater .*)$/, '').replace(/^(área metropolitana de |gran )/, ''); if (seen.some((x) => x.includes(n) || n.includes(x))) return false; seen.push(n); return true; }).slice(0, 2);
          uniq.forEach((b3, i) => table.splice(table.findIndex((r) => r[0] === T('Capital')) + 1 + i, 0, [T(i ? 'Segunda ciudad más poblada' : 'Ciudad más poblada'), `${b3.cLabel.value} (${num(b3.pop.value)})`]));
        } catch { /* optional */ }
        try {
          const hdi = new Map();
          const q2 = 'SELECT ?c (MAX(?h) AS ?hdi) WHERE { VALUES ?t { wd:Q6256 wd:Q3624078 } ?c wdt:P31 ?t ; wdt:P1081 ?h } GROUP BY ?c';
          for (const b2 of (await (await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q2))).json()).results.bindings) { const a3 = byQ.get(b2.c.value.split('/').pop()); if (a3) hdi.set(a3, +b2.hdi.value); }
          add('Índice de desarrollo humano', rank(hdi, id.a3));
        } catch { /* the ranking is optional */ }
        try {
          const [pop, gdp, pc, mil, life] = await Promise.all(['SP.POP.TOTL', 'NY.GDP.MKTP.CD', 'NY.GDP.PCAP.CD', 'MS.MIL.XPND.CD', 'SP.DYN.LE00.IN'].map(wb));
          add('Población', rank(pop.m, id.a3, T('Población'))); add('PIB nominal', rank(gdp.m, id.a3, T('PIB nominal'), usd));
          for (const [d, label, f] of [[pc, 'PIB per cápita', usd], [mil, 'Gasto militar', usd], [life, 'Esperanza de vida', (v) => num(Math.round(v * 10) / 10) + ' ' + T('años')]]) {
            if (d.m.has(id.a3)) table.push([`${T(label)} (${T('Banco Mundial')}, ${d.year.get(id.a3)})`, f(d.m.get(id.a3)) + rank(d.m, id.a3, T(label), f)]);
          }
        } catch { /* optional too */ }
      }
      // header of the card: Wikivoyage banner, flag and coat of arms (Commons images), and the anthem if there is a recording
      const pic = (k, width) => { const r = rows.find((x) => x.k.value === k); return r ? r.v.value.replace(/^http:/, 'https:') + '?width=' + width : null; };
      const head = document.createElement('div'), img = (src, style, title) => { if (src) head.append(Object.assign(document.createElement('img'), { src, title, alt: title, style })); };
      img(pic('banner', 760), 'width:100%;border-radius:8px;display:block;margin-bottom:6px', T('Banner de Wikiviajes'));
      img(pic('flag', 160), 'height:56px;margin:0 10px 6px 0;border:1px solid #9bb;vertical-align:middle', T('Bandera'));
      img(pic('arms', 120), 'height:72px;margin:0 0 6px 0;vertical-align:middle', T('Escudo'));
      let audio = rows.find((r) => r.k.value === 'audio');
      const anthem = rows.find((r) => r.k.value === 'anthem');
      if (!audio && anthem) { // no recording linked in Wikidata: the first audio file that Commons finds for the anthem's name
        try {
          const js = await (await fetch('https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrlimit=1&prop=imageinfo&iiprop=url&format=json&origin=*&gsrsearch=' + encodeURIComponent('filetype:audio ' + anthem.vLabel.value))).json();
          const page = js.query && Object.values(js.query.pages)[0];
          if (page && page.imageinfo) audio = { v: { value: page.imageinfo[0].url } };
        } catch { /* stays without a recording */ }
      }
      if (audio) head.append(Object.assign(document.createElement('audio'), { controls: true, preload: 'none', src: audio.v.value.replace(/^http:/, 'https:'), style: 'width:100%;margin-bottom:6px;display:block', title: T('Himno nacional') }));
      const chips = (txt) => { // 'value\u0001rank/total/where…' -> the value followed by colored rank chips (green = top quarter, red = bottom quarter)
        const [head, pTxt, pColor] = String(txt).split('\u0002'), [value, ...ranks] = head.split('\u0001');
        if (!ranks.length && !pTxt) return txt;
        if (pTxt) ranks.push(null); // the political position chip goes last
        const span = document.createElement('span');
        span.append(value + ' ');
        for (const r of ranks) {
          if (r === null) { span.append(Object.assign(document.createElement('span'), { textContent: pTxt, style: `display:inline-block;background:${pColor};color:#fff;border-radius:10px;padding:0 8px;margin:1px 4px 1px 0;font-weight:600;font-size:12px` })); continue; }
          const [n, total, where, li] = r.split('/'), q = (n - 1) / Math.max(1, total - 1), color = q <= 0.25 ? '#2e9e3a' : q <= 0.5 ? '#8bbf2a' : q <= 0.75 ? '#e0a020' : '#d9483b';
          const chip = span.appendChild(Object.assign(document.createElement('span'), { title: T('Clic: ver la clasificación'), textContent: `#${n} / ${total} ${where}`, style: `display:inline-block;background:${color};color:#fff;border-radius:10px;padding:0 8px;margin:1px 4px 1px 0;font-weight:600;font-size:12px;text-shadow:0 1px 1px rgba(0,0,0,.35)` })); chip.style.cursor = 'pointer';
          chip.onclick = () => { const t = tops[li]; if (t) OGE.showTable(`${t.label} — ${where}`, ['#', T('País'), T('Valor')], t.rows.map((r) => r.slice(0, 3)), { note: T('Fuente de los datos: Banco Mundial y Wikidata.') + ' ' + T('Clic en un país: su ficha.'), onRow: (i) => { const a3 = t.rows[i][3], f = flags.get(a3); if (f) wikiInfo({ oge: 'country', q: f.q, a3, name: f.name }); } }); }; }
        return span;
      };
      for (const r of table) r[1] = chips(r[1]);
      OGE.showTable(id.name, [T('Dato'), T('Valor')], table, { note: T('Fuente: Wikidata (CC0).') + (id.osm ? ' ' + T('Fuente: OpenStreetMap (ODbL).') : '') + (head.childNodes.length ? ' ' + T('Imágenes y sonido: Wikimedia Commons.') : ''), content: head.childNodes.length ? head : undefined });
    } catch (e) { OGE.toast('No se pudieron obtener los datos: ' + e.message, true); }
  }
  new C.ScreenSpaceEventHandler(viewer.scene.canvas).setInputAction((ev) => {
    if ((OGE.drawing && OGE.drawing()) || document.body.classList.contains('flying')) return; // not while drawing or flying
    const hit = viewer.scene.pick(ev.position), id = hit && hit.id;
    if (id && id.oge === 'sat') { const s = id.s; OGE.chime(); return OGE.showTable(`🛰 ${s.name}`, [T('Dato'), T('Valor')], [[T('Grupo'), s.group], [T('Altitud'), Math.round(s.alt / 1000).toLocaleString(OGE_LANG) + ' km'], [T('Latitud'), s.lat.toFixed(2) + '°'], [T('Longitud'), s.lon.toFixed(2) + '°'], ['NORAD', s.rec.satnum]], { note: T('Fuente: CelesTrak; posición calculada con SGP4.') }); }
    if (id && id.oge === 'plane') { const p = id.a; OGE.chime(); return OGE.showTable(`✈ ${(p.flight || p.r || p.hex || '').trim()}`, [T('Dato'), T('Valor')], [[T('Vuelo'), (p.flight || '').trim()], [T('Matrícula'), p.r], [T('Modelo'), p.desc || p.t], [T('Operador'), p.ownOp], [T('Altitud'), typeof p.alt_baro === 'number' ? `${Math.round(p.alt_baro * 0.3048).toLocaleString(OGE_LANG)} m (${p.alt_baro} ft)` : p.alt_baro], [T('Velocidad'), p.gs != null ? `${Math.round(p.gs * 1.852)} km/h` : ''], [T('Rumbo'), p.track != null ? Math.round(p.track) + '°' : ''], [T('Origen y destino'), ''], ['ICAO 24', p.hex]].filter((x) => x[1]), { note: window.__TAURI__ ? T('Fuente: adsb.fi (datos abiertos ADS-B).') : T('Datos: AvioADSB (CC BY-NC 4.0), avioadsb.org') }); }
    if (id && FACTS[id.oge] && /^Q\d+$/.test(id.q || '')) return wikiInfo(id);
    // nothing picked: with a regional layer on, the municipality (or else the province) under the click, with OpenStreetMap's data and its Wikidata id
    const town = id && id.oge === 'place' && !id.q ? hit.primitive.position : null; // a 10m town: asked to OSM at its position
    if ((hit && !town) || !['layerAdmin1', 'fillAdmin1', 'layerRegionNames', 'layerRoads', 'layerCities'].some((k) => $(k).checked)) return; // the street layer's town names count too
    const p = town || viewer.camera.pickEllipsoid(ev.position);
    if (!p) return;
    const [lon, lat] = geo.toLL(p);
    const rev = (zoom) => fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=${zoom}&extratags=1&namedetails=1&accept-language=${OGE_LANG}&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`).then((r) => r.json());
    OGE.toast('Consultando OpenStreetMap…');
    rev(10).then(async (j) => {
      if (!j || j.error || !/city|town|village|municipality|county/.test(j.addresstype || '')) j = await rev(5); // no municipality there: the province
      if (!j || j.error) return;
      const q = j.extratags && j.extratags.wikidata;
      if (q) wikiInfo({ oge: 'region', q, name: j.name, osm: j });
      else OGE.showTable(j.name || j.display_name, [T('Dato'), T('Valor')], osmRows(j), { note: T('Fuente: OpenStreetMap (ODbL).') });
    }).catch(() => {});
  }, C.ScreenSpaceEventType.LEFT_CLICK);
  // Facts that OpenStreetMap adds to a card (its reverse geocoder result).
  function osmRows(j) {
    const x = j.extratags || {}, a = j.address || {}, n = (v) => Number(v).toLocaleString(OGE_LANG), out = [];
    const add = (label, v) => { if (v) out.push([T(label), v]); };
    add('Tipo (OSM)', j.addresstype);
    add('Nombre oficial (OSM)', (j.namedetails || {}).official_name);
    add('Pertenece a', [a.county, a.state, a.country].filter((v) => v && v !== j.name).join(', '));
    add('Población (OSM)', x.population && n(x.population) + (x['population:date'] ? ` (${x['population:date']})` : ''));
    add('Código ISO 3166-2', x['ISO3166-2']);
    add('Código postal', a.postcode);
    add('Sitio web (OSM)', x.website);
    return out;
  }

  // ---------- Antarctic claims: sectors south of 60° S, frozen by the Antarctic Treaty; each claimant can be switched on or off ----------
  const CLAIMS = { ARG: ['Antártida Argentina', '#74acdf', [[-74, -25]]], CHL: ['Territorio Chileno Antártico', '#d52b1e', [[-90, -53]]], GBR: ['Territorio Antártico Británico', '#1f4fbf', [[-80, -20]]],
    NOR: ['Tierra de la Reina Maud (Noruega)', '#e0457b', [[-20, 45]]], AUS: ['Territorio Antártico Australiano', '#00a651', [[45, 136], [142, 160]]], FRA: ['Tierra Adelia (Francia)', '#5b8def', [[136, 142]]], NZL: ['Dependencia Ross (Nueva Zelanda)', '#c9a227', [[160, 210]]] };
  OGE.claims = CLAIMS; // the country card shows its claim too
  const claimOn = (() => { try { return JSON.parse(localStorage.getItem('oge.claims')) || Object.keys(CLAIMS); } catch { return Object.keys(CLAIMS); } })();
  let claimPrims = [];
  OGE.redrawClaims = () => drawClaims();
  let claimLabels = null; const claimOcc = new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, viewer.camera.positionWC);
  viewer.scene.preRender.addEventListener(() => { // the names only show while their part of Antarctica is on this side of the globe
    if (!claimLabels || claimLabels.isDestroyed() || !claimLabels.show) return;
    claimOcc.cameraPosition = viewer.camera.positionWC;
    for (let i = 0; i < claimLabels.length; i++) { const b = claimLabels.get(i); b.show = claimOcc.isPointVisible(b.position); }
  });
  function stripes(colors) { // a square that repeats into 45° stripes; the first color (Chile) twice as wide
    const bands = colors.flatMap((c, i) => (i ? [c] : [c, c])), B = 6, S = bands.length * B * 2, cv = Object.assign(document.createElement('canvas'), { width: S, height: S }), g = cv.getContext('2d');
    for (let x = -S, k = 0; x < 2 * S; x += B * 2, k++) { g.fillStyle = bands[k % bands.length]; g.beginPath(); g.moveTo(x, 0); g.lineTo(x + B * 2, 0); g.lineTo(x + B * 2 - S, S); g.lineTo(x - S, S); g.closePath(); g.fill(); }
    return cv;
  }
  $('fillCountries').addEventListener('change', () => drawClaims());
  function drawClaims() {
    for (const p of claimPrims) (p instanceof C.ImageryLayer ? viewer.imageryLayers : p instanceof C.BillboardCollection ? viewer.scene.primitives : viewer.scene.groundPrimitives).remove(p);
    claimPrims = [];
    if (!$('layerClaims').checked) return;
    const rhumb = (pts) => C.Cartesian3.fromDegreesArray(pts.flat());
    const line = (a, b, n = 48) => rhumb(Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]));
    const span = ([w, e]) => (e > 180 ? [[w, 180], [-180, e - 360]] : [[w, e]]), box = ([w, e]) => ({ type: 'Polygon', coordinates: [[[w, -60], [e, -60], [e, -89.99], [w, -89.99], [w, -60]]] });
    const filled = $('fillCountries').checked, cl = claimOn.includes('CHL') && filled && !OGE.antarticaCL && OGE.tintOf && OGE.tintOf('CHL'); // with the countries painted, the Chilean Antarctic Territory looks like the rest of Chile
    // Overlapping claims (Chile, Argentina, United Kingdom) are cut into pieces: one claimant = its color; two or three = diagonal stripes of their colors, Chile first and wider
    const on = claimOn.filter((a3) => CLAIMS[a3]), spans = on.flatMap((a3) => CLAIMS[a3][2].flatMap(span).map(([w, e]) => ({ a3, w, e })));
    const cuts = [...new Set(spans.flatMap((x) => [x.w, x.e]))].sort((a, b) => a - b), color = (a3) => (a3 === 'CHL' && cl) || CLAIMS[a3][1], items = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const w = cuts[i], e = cuts[i + 1], who = [...new Set(spans.filter((x) => x.w <= w && x.e >= e).map((x) => x.a3))].sort((a, b) => (b === 'CHL') - (a === 'CHL'));
      if (!who.length || (who.length === 1 && who[0] === 'CHL' && filled && OGE.antarticaCL)) continue; // from Chile its own sector is already painted with the country
      items.push([box([w, e]), who.length === 1 ? color(who[0]) : stripes(who.map(color))]);
    }
    const paint = fillLayer(items);
    paint.alpha = cl ? 0.45 : 0.35;
    claimPrims.push(paint);
    const labels = viewer.scene.primitives.add(new C.BillboardCollection());
    claimPrims.push(labels); claimLabels = labels;
    for (const a3 of [...claimOn].sort((a, b) => (a === 'CHL') - (b === 'CHL'))) { // Chile last: its edges and name on top
      const [name, color, sectors] = CLAIMS[a3] || [];
      if (!name) continue;
      const inst = sectors.flatMap(([w, e]) => [line([w, -60], [w, -89.8]), line([e, -60], [e, -89.8]), line([w, -60], [e, -60])]).map((positions) => new C.GeometryInstance({
        geometry: new C.GroundPolylineGeometry({ positions, width: 2.5, arcType: C.ArcType.RHUMB }), attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.fromCssColorString(color)) } }));
      claimPrims.push(viewer.scene.groundPrimitives.add(new C.GroundPolylinePrimitive({ geometryInstances: inst, appearance: new C.PolylineColorAppearance() })));
      const [w, e] = sectors[0];
      labels.add({ position: C.Cartesian3.fromDegrees(((w + e) / 2 + 540) % 360 - 180, -73 - (Object.keys(CLAIMS).indexOf(a3) % 3) * 3), image: OGE.textImage(name, '600 13px sans-serif', C.Color.fromCssColorString(color).brighten(0.4, new C.Color())),
        scale: 0.5, disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new C.DistanceDisplayCondition(0, 1.5e7) });
    }
  }
  $('claimList').replaceChildren(...Object.entries(CLAIMS).map(([a3, [name, color]]) => { // one checkbox per claimant
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: claimOn.includes(a3) });
    cb.onchange = () => { if (cb.checked) claimOn.push(a3); else claimOn.splice(claimOn.indexOf(a3), 1); localStorage.setItem('oge.claims', JSON.stringify(claimOn)); drawClaims(); };
    const lab = document.createElement('label');
    lab.append(cb, Object.assign(document.createElement('span'), { textContent: ' ■ ', style: `color:${color}` }), T(name));
    return Object.assign(document.createElement('li'), {}).appendChild(lab).parentNode;
  }));
  $('layerClaims').addEventListener('change', () => {
    if ($('layerClaims').checked) OGE.toast('Reclamaciones congeladas por el Tratado Antártico (1959, art. IV): no se reconocen ni se rechazan, y no se pueden hacer nuevas mientras esté vigente.');
    drawClaims();
  });
  drawClaims();

  // ---------- Region names (states, provinces): a click opens their card (Wikidata + OpenStreetMap) ----------
  let regionNames = null, regionBusy = false;
  const cbRN = $('layerRegionNames');
  const syncRegionNames = async () => {
    if (regionNames) regionNames.show = cbRN.checked;
    if (!cbRN.checked || regionNames || regionBusy) return;
    regionBusy = true;
    OGE.toast('Cargando los nombres de regiones…');
    try {
      const clean = (v) => String(v ?? '').replace(/\0/g, '').trim(), bills = viewer.scene.primitives.add(new C.LabelCollection()); // text labels share one glyph atlas (thousands of picture labels overflowed the GPU atlas: black boxes); only the attribute table is needed
      for (const p of shp.parseDbf(await buf('10m_cultural/ne_10m_admin_1_states_provinces.dbf'))) {
        const lon = +p.longitude, lat = +p.latitude, name = clean(OGE_LANG === 'en' ? p.name : p.name_es) || clean(p.name);
        if (!isFinite(lon) || !isFinite(lat) || !name) continue;
        bills.add({ position: C.Cartesian3.fromDegrees(lon, lat), text: name, font: 'italic 600 13px sans-serif', fillColor: C.Color.fromCssColorString('#ffe9a8'), style: C.LabelStyle.FILL_AND_OUTLINE, outlineColor: C.Color.fromCssColorString('#0a1e3c'), outlineWidth: 3, disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new C.DistanceDisplayCondition(0, (+p.min_label || 5) <= 4 ? 4e6 : 2e6), id: { oge: 'region', q: clean(p.wikidataid), name } });
      }
      const occluder = new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, viewer.camera.positionWC);
      viewer.scene.preRender.addEventListener(() => { if (!bills.show) return; occluder.cameraPosition = viewer.camera.positionWC; for (let i = 0; i < bills.length; i++) { const b = bills.get(i); b.show = occluder.isPointVisible(b.position); } });
      regionNames = bills; regionNames.show = cbRN.checked;
    } catch (e) { OGE.toast('No se pudieron cargar los nombres de regiones: ' + e.message, true); }
    regionBusy = false;
  };
  cbRN.addEventListener('change', syncRegionNames);
  syncRegionNames();

  // ---------- Seas and oceans: names from Natural Earth's marine areas; a click opens their card (Wikidata) ----------
  let seas = null, seasBusy = false;
  const cbSea = $('layerSeas');
  const syncSeas = async () => {
    if (seas) seas.show = cbSea.checked;
    if (!cbSea.checked || seas || seasBusy) return;
    seasBusy = true;
    try {
      const [sb, db] = await Promise.all([buf('10m_physical/ne_10m_geography_marine_polys.shp'), buf('10m_physical/ne_10m_geography_marine_polys.dbf')]);
      const clean = (v) => String(v ?? '').replace(/\0/g, '').trim(), labels = viewer.scene.primitives.add(new C.LabelCollection());
      for (const f of shp.combine([shp.parseShp(sb), shp.parseDbf(db)]).features) {
        const p = f.properties, name = clean(OGE_LANG === 'en' ? p.name_en : p.name_es) || clean(p.name);
        if (!f.geometry || !name) continue;
        const c = turf.pointOnFeature(f).geometry.coordinates, rank = +p.scalerank || 3, ocean = /ocean/i.test(clean(p.featurecla));
        labels.add({ position: C.Cartesian3.fromDegrees(c[0], c[1]), text: name, font: `italic ${ocean ? 700 : 600} ${ocean ? 16 : 13}px serif`, fillColor: C.Color.fromCssColorString('#d6f1ff'),
          style: C.LabelStyle.FILL, disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new C.DistanceDisplayCondition(0, ocean ? 4e7 : rank <= 2 ? 1.2e7 : rank <= 4 ? 5e6 : 2e6), id: { oge: 'region', q: clean(p.wikidataid), name } });
      }
      const occ = new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, viewer.camera.positionWC);
      viewer.scene.preRender.addEventListener(() => { if (!labels.show) return; occ.cameraPosition = viewer.camera.positionWC; for (let i = 0; i < labels.length; i++) { const l = labels.get(i); l.show = occ.isPointVisible(l.position); } });
      seas = labels; seas.show = cbSea.checked;
    } catch (e) { OGE.toast('No se pudieron cargar los mares: ' + e.message, true); }
    seasBusy = false;
  };
  cbSea.addEventListener('change', syncSeas);
  syncSeas();

  // ---------- Live aircraft (ADS-B Exchange-style open feed from adsb.fi, no key): icons along their track, refreshed every 10 s ----------
  const planeIcon = (() => { // a white airliner seen from above, pointing up (north)
    const cv = Object.assign(document.createElement('canvas'), { width: 48, height: 48 }), g = cv.getContext('2d');
    g.translate(24, 24); g.fillStyle = '#ffd60a'; g.strokeStyle = '#3a2a00'; g.lineWidth = 1.5; g.beginPath();
    g.moveTo(0, -20); g.lineTo(3, -12); g.lineTo(3, -4); g.lineTo(20, 4); g.lineTo(20, 8); g.lineTo(3, 4); g.lineTo(3, 14); g.lineTo(8, 18); g.lineTo(8, 21); g.lineTo(0, 18); g.lineTo(-8, 21); g.lineTo(-8, 18); g.lineTo(-3, 14); g.lineTo(-3, 4); g.lineTo(-20, 8); g.lineTo(-20, 4); g.lineTo(-3, -4); g.lineTo(-3, -12); g.closePath(); g.fill(); g.stroke();
    return cv;
  })();
  OGE.planeIcon = planeIcon;
  let planes = null, planeTimer = null; // planes: BillboardCollection of the live aircraft
  const cbP = $('layerPlanes');
  if (!window.__TAURI__) { cbP.checked = false; cbP.parentElement.lastChild.textContent = ' ' + T('Aviones en vivo (AvioADSB)'); } // on the web the layer is off until asked for (its feed has a daily limit)
  OGE.livePlanes = async (lon, lat, km = 250) => { // the aircraft around a point (the flight game uses them too)
    const url = `https://opendata.adsb.fi/api/v2/lat/${lat.toFixed(3)}/lon/${lon.toFixed(3)}/dist/${Math.min(250, Math.round(km))}`;
    const tauri = window.__TAURI__ && window.__TAURI__.core; // the open flight feeds refuse browsers (no CORS): the desktop program fetches them itself
    if (!tauri) { // the web page: AvioADSB, the one open feed that lets browsers read it (same readsb fields; fewer receivers; 1 request every 10 s and 100 a day per network)
      const res = await fetch(`https://avioadsb.org/v1/point/${lat.toFixed(3)}/${lon.toFixed(3)}/100`);
      if (res.status === 429) throw new Error(T('límite de consultas de AvioADSB alcanzado por hoy; la app de escritorio no tiene ese límite'));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return ((await res.json()).ac || []).filter((a) => a.lat != null && a.lon != null);
    }
    const j = JSON.parse(await tauri.invoke('fetch_text', { url }));
    return (j.aircraft || []).filter((a) => a.lat != null && a.lon != null);
  };
  async function refreshPlanes() {
    if (!cbP.checked) return;
    const c = viewer.camera.positionCartographic, km = Math.min(250, c.height / 2000);
    const la = OGE.lookAt && OGE.lookAt(), at = la ? la.carto : c;
    try {
      const list = await OGE.livePlanes(C.Math.toDegrees(at.longitude), C.Math.toDegrees(at.latitude), Math.max(40, km));
      planes.removeAll();
      for (const a of list) {
        const ft = typeof a.alt_baro === 'number' ? a.alt_baro : 0;
        planes.add({ position: C.Cartesian3.fromDegrees(a.lon, a.lat, ft * 0.3048), image: planeIcon, scale: 0.55, rotation: -C.Math.toRadians(a.track || 0), alignedAxis: C.Cartesian3.ZERO,
          disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new C.DistanceDisplayCondition(0, 3e6),
          id: { oge: 'plane', a } });
      }
      OGE.hint(`${list.length} ${T('aviones en vivo cerca de la vista')} (${window.__TAURI__ ? 'adsb.fi' : 'AvioADSB, CC BY-NC 4.0'}).`);
    } catch (e) { OGE.toast('No se pudieron cargar los aviones en vivo: ' + e.message, true); }
  }
  if (cbP.checked) setTimeout(() => cbP.dispatchEvent(new Event('change')), 0);
  cbP.addEventListener('change', () => {
    if (!planes) planes = viewer.scene.primitives.add(new C.BillboardCollection());
    planes.show = cbP.checked;
    clearInterval(planeTimer);
    if (cbP.checked) { refreshPlanes(); planeTimer = setInterval(refreshPlanes, window.__TAURI__ ? 10000 : 60000); } else OGE.hint(''); // the web feed allows few requests: once a minute
  });

  // ---------- Live satellites: orbital elements from CelesTrak, positions computed here every second (SGP4, satellite.js) ----------
  let sats = null, satTimer = null, satRecs = null;
  const cbS = $('layerSats');
  OGE.satellites = () => satRecs || []; // the flight game shows them too
  OGE.satHidden = new Set(); // shot down in the game: hidden until the page is reloaded
  async function loadSats() {
    const groups = ['stations', 'visual', 'weather', 'gnss'], recs = [];
    for (const g of groups) {
      const key = 'oge.tle.' + g, old = JSON.parse(localStorage.getItem(key) || 'null');
      const good = (x) => /^1 \d{5}/m.test(x), live = async () => { const r = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=tle`), x = r.ok ? await r.text() : ''; if (!good(x)) throw new Error('CelesTrak ' + r.status); return x; };
      let txt = old && Date.now() - old.t < 6 * 3600e3 ? old.txt : null, fresh = false;
      if (!txt) try { txt = await live(); fresh = true; } catch { txt = old ? old.txt : await (await fetch(`data/tle/${g}.txt`)).text(); } // CelesTrak down or refusing: the last copy kept here, or else the one that ships with the app (orbits drift slowly: fine for weeks)
      const L = txt.split(/\r?\n/);
      if (fresh) try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), txt })); } catch { /* storage full: not cached */ }
      for (let i = 0; i + 2 < L.length; i += 3) if (L[i + 1].startsWith('1 ')) recs.push({ name: L[i].trim(), group: g, rec: satellite.twoline2satrec(L[i + 1], L[i + 2]) });
    }
    return recs;
  }
  function placeSats() {
    const now = new Date(), gmst = satellite.gstime(now);
    const fresh = sats.length !== satRecs.length; // first time: add them; then only move them
    const cam = viewer.camera.positionCartographic, near = $('layerSatsNear').checked, R = C.Math.clamp(cam.height / 6.371e6, 0.25, 1); // "only nearby": within an angle around the point below the camera (wider when far away)
    const close = (s) => !OGE.satHidden.has(s.name) && (!near || /ISS|ZARYA/.test(s.name) || Math.acos(C.Math.clamp(Math.sin(cam.latitude) * Math.sin(C.Math.toRadians(s.lat)) + Math.cos(cam.latitude) * Math.cos(C.Math.toRadians(s.lat)) * Math.cos(cam.longitude - C.Math.toRadians(s.lon)), -1, 1)) < R);
    if (fresh) sats.removeAll();
    satRecs.forEach((s, i) => {
      const pv = satellite.propagate(s.rec, now);
      if (!pv.position) { if (!fresh) sats.get(i).show = false; else sats.add({ position: C.Cartesian3.ZERO, image: satIcon(false), show: false, id: { oge: 'sat', s } }); return; } // decayed or bad elements: hidden, keeps its slot
      const g = satellite.eciToGeodetic(pv.position, gmst);
      s.lon = C.Math.toDegrees(g.longitude); s.lat = C.Math.toDegrees(g.latitude); s.alt = g.height * 1000;
      s.p = C.Cartesian3.fromRadians(g.longitude, g.latitude, s.alt);
      const iss = /ISS|ZARYA/.test(s.name);
      if (fresh) sats.add({ show: close(s), position: s.p, image: satIcon(iss), scale: iss ? 0.7 : 0.4, disableDepthTestDistance: 0, id: { oge: 'sat', s } }); else { const b = sats.get(i); b.position = s.p; b.show = close(s); }
    });
  }
  const satIconCache = {};
  const satIcon = (big) => satIconCache[big] || (satIconCache[big] = (() => { // a body with two solar panels
    const cv = Object.assign(document.createElement('canvas'), { width: 48, height: 48 }), g = cv.getContext('2d');
    g.fillStyle = '#2b6fd6'; g.fillRect(2, 18, 15, 12); g.fillRect(31, 18, 15, 12); g.strokeStyle = '#cfe6ff'; g.strokeRect(2, 18, 15, 12); g.strokeRect(31, 18, 15, 12);
    g.fillStyle = big ? '#ffd60a' : '#e6e9ef'; g.fillRect(18, 15, 12, 18); g.strokeStyle = '#333'; g.strokeRect(18, 15, 12, 18);
    return cv;
  })());
  if (cbS.checked) setTimeout(() => cbS.dispatchEvent(new Event('change')), 0); // ticked from the last session: load it now
  cbS.addEventListener('change', async () => {
    if (!sats) sats = viewer.scene.primitives.add(new C.BillboardCollection());
    sats.show = cbS.checked;
    clearInterval(satTimer);
    if (!cbS.checked) return;
    try {
      if (!satRecs) { OGE.toast('Cargando satélites…'); satRecs = await loadSats(); OGE.toast(`${satRecs.length} ${T('satélites en órbita, posición en vivo')} (CelesTrak).`); }
      placeSats(); satTimer = setInterval(placeSats, 1000);
    } catch (e) { OGE.toast('No se pudieron cargar los satélites: ' + e.message, true); }
  });

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
  // Arrows step through the years (like GeaCron); typing a year jumps to the closest one available.
  const pick = (i) => { i = Math.max(0, Math.min(sel.options.length - 1, i)); if (i !== sel.selectedIndex) { sel.selectedIndex = i; sel.dispatchEvent(new Event('change')); } };
  $('histPrev').onclick = () => pick(sel.selectedIndex - 1);
  $('histNext').onclick = () => pick(sel.selectedIndex + 1);
  $('histGo').onchange = (e) => {
    if (e.target.value === '') return;
    const y = +e.target.value;
    let best = 1;
    for (let i = 2; i < sel.options.length; i++) if (Math.abs(sel.options[i].value - y) < Math.abs(sel.options[best].value - y)) best = i;
    e.target.value = '';
    pick(best);
  };
  fill(YEARS); // fallback list; replaced by the live file list of the fork, so new files show up without rebuilding
  fetch('https://api.github.com/repos/avlopezparra/historical-basemaps/contents/geojson').then((r) => (r.ok ? r.json() : [])).then((files) => {
    const ys = files.map((f) => /^world_(bc)?(\d+)\.geojson$/.exec(f.name)).filter(Boolean).map((m) => (m[1] ? -m[2] : +m[2])).sort((x, y) => x - y);
    if (ys.length) fill(ys);
  }).catch(() => {});
  let hist = null, token = 0; // hist: { lines, labels, tick, gj, fill } of the year on screen
  const cbH = $('fillHistory'), cbL = $('histLines');
  const syncHistFill = () => {
    if (!hist) return;
    if (cbH.checked && !hist.fill) hist.fill = fillLayer(colorize(hist.gj.features.map((f) => f.geometry)));
    if (hist.fill) hist.fill.show = cbH.checked;
    hist.lines.show = cbL.checked;
  };
  cbH.addEventListener('change', syncHistFill);
  cbL.addEventListener('change', syncHistFill);
  function clearHist() {
    if (!hist) return;
    viewer.scene.groundPrimitives.remove(hist.lines);
    if (hist.fill) viewer.imageryLayers.remove(hist.fill);
    viewer.scene.primitives.remove(hist.labels);
    viewer.scene.preRender.removeEventListener(hist.tick);
    hist = null;
  }
  // ---------- OpenHistoryTimeLine: a mode of its own for the historical maps (like GeaCron): only the map of the year and a timeline ----------
  const MODERN = ['fillCountries', 'layerFlags', 'layerFlagsDep', 'layerNames', 'borders', 'layerCapitals', 'layerCities', 'layerDisputed', 'layerClaims', 'layerAdmin1', 'fillAdmin1', 'layerRegionNames', 'layerSats', 'layerWeather'];
  let histWas = null, histPlay = null;
  const bar = Object.assign(document.createElement('div'), { id: 'histBar', hidden: true });
  bar.innerHTML = `<b class="ht">OpenHistoryTimeLine</b><button data-s="-5" title="${T('Retroceder varios años')}">◀◀</button><button data-s="-1" title="${T('Año anterior')}">◀</button>`
    + `<span class="hy"></span><button data-s="1" title="${T('Año siguiente')}">▶</button><button data-s="5" title="${T('Avanzar varios años')}">▶▶</button>`
    + `<button class="hp" title="${T('Reproducir: avanza solo')}">${T('Reproducir')}</button><input class="hr" type="range" min="1" step="1"><button class="hx" title="${T('Salir de OpenHistoryTimeLine')}">✕</button>`;
  viewer.container.appendChild(bar);
  const hy = bar.querySelector('.hy'), hr = bar.querySelector('.hr'), hp = bar.querySelector('.hp');
  const showYear = () => { hr.max = sel.options.length - 1; hr.value = Math.max(1, sel.selectedIndex); hy.textContent = sel.selectedIndex > 0 ? sel.options[sel.selectedIndex].text : '—'; };
  bar.querySelectorAll('[data-s]').forEach((b) => (b.onclick = () => pick(Math.max(1, sel.selectedIndex + +b.dataset.s))));
  hr.oninput = () => pick(+hr.value);
  hp.onclick = () => { // play: one year every 2.5 s, stopping at the last one
    if (histPlay) { clearInterval(histPlay); histPlay = null; hp.textContent = T('Reproducir'); return; }
    hp.textContent = T('Pausa');
    histPlay = setInterval(() => { if (sel.selectedIndex >= sel.options.length - 1) return hp.onclick(); pick(sel.selectedIndex + 1); }, 2500);
  };
  sel.addEventListener('change', showYear);
  function historyMode(on) {
    document.body.classList.toggle('history-mode', on); bar.hidden = !on;
    const flip = (id, v) => { const c = $(id); if (c && c.checked !== v) { c.checked = v; c.dispatchEvent(new Event('change')); } };
    if (on) {
      histWas = Object.fromEntries([...MODERN, 'fillHistory', 'histLines'].map((id) => [id, !!($(id) && $(id).checked)])); // the user's layers, given back on leaving
      for (const id of MODERN) flip(id, false);
      flip('fillHistory', true); flip('histLines', true);
      if (sel.selectedIndex < 1) pick([...sel.options].findIndex((o) => +o.value === 1492) > 0 ? [...sel.options].findIndex((o) => +o.value === 1492) : 1);
      viewer.camera.flyTo({ destination: C.Cartesian3.fromDegrees(15, 30, 2.2e7), duration: 1.5 });
      OGE.toast(T('OpenHistoryTimeLine: muévete por los años con las flechas, la barra o Reproducir.'));
    } else {
      if (histPlay) hp.onclick();
      if (histWas) for (const [id, v] of Object.entries(histWas)) flip(id, v);
      histWas = null;
    }
    showYear();
  }
  OGE.historyMode = historyMode;
  bar.querySelector('.hx').onclick = () => historyMode(false);
  $('histBtn').onclick = () => historyMode(!document.body.classList.contains('history-mode'));
  if (new URLSearchParams(location.search).has('history')) setTimeout(() => historyMode(true), 1200); // opengisearth.com/history opens it directly
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
      hist = { lines: viewer.scene.groundPrimitives.add(new C.GroundPolylinePrimitive({ geometryInstances: inst, appearance: new C.PolylineColorAppearance() })), labels: viewer.scene.primitives.add(labels), tick, gj };
      syncHistFill();
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
      const inst = [];
      for (const g of shp.parseShp(await res.arrayBuffer())) for (const p of !g ? [] : g.type === 'LineString' ? [g.coordinates] : g.coordinates) if (p.length > 1) inst.push(p);
      admin1 = lineLayer(inst, '#64b5f6', 1.3); // as imagery: light to draw, and it lies on the terrain
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
