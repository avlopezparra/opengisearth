// OpenGISEarth — core: viewer, shared utilities, undo, dialogs, search, status bar and panels.
Cesium.Ion.defaultAccessToken = ''; // no Cesium ion: open data only

(() => {
  const C = Cesium;
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const deg = C.Math.toDegrees;

  // The Layers checkboxes remember their state between sessions (restored before each module reads them).
  if (matchMedia('(pointer: coarse)').matches && !localStorage.getItem('oge.fix.satsPhone')) { localStorage.removeItem('oge.ui.layerSats'); localStorage.setItem('oge.fix.satsPhone', '1'); } // phones: satellites off (left on by earlier versions)
  if (!localStorage.getItem('oge.fix.liveOff')) { localStorage.removeItem('oge.ui.layerSats'); localStorage.removeItem('oge.ui.layerPlanes'); localStorage.setItem('oge.fix.liveOff', '1'); }
  // Another world instead of the Earth (?body=moon or ?body=mars): NASA Solar System Treks imagery on the globe; the Earth's layers stay off and are not saved.
  const BODIES = {
    moon: { name: 'Luna', max: 8, url: 'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg', credit: 'Luna: NASA / GSFC / Arizona State University (LRO WAC) · NASA Solar System Treks' },
    sky: { name: 'Cielo' }, // no imagery of its own: the star map is already there, sky.js draws the constellations
    mars: { name: 'Marte', max: 7, url: 'https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg', credit: 'Marte: NASA / JPL / USGS (Viking MDIM 2.1) · NASA Solar System Treks' },
  };
  const BODY = BODIES[new URLSearchParams(location.search).get('body')] ? new URLSearchParams(location.search).get('body') : null;
  document.querySelectorAll('.layers input[type=checkbox], .layers select').forEach((c) => {
    if (BODY) { if (c.type === 'checkbox') c.checked = false; c.disabled = true; return; }
    const key = 'oge.ui.' + c.id, saved = localStorage.getItem(key);
    if (saved !== null) { if (c.type === 'checkbox') c.checked = saved === '1'; else c.value = saved; }
    c.addEventListener('change', () => localStorage.setItem(key, c.type === 'checkbox' ? (c.checked ? '1' : '0') : c.value));
  });

  // Layers that can slow the app down: marked "pesada", they ask before switching on, and one button switches them all off
  const HEAVY = ['layerSats', 'layerCities', 'layerAdmin1', 'fillAdmin1', 'layerRegionNames', 'layerWeather', 'layerRoads', 'layerBuildings', 'layerGoogle3d', 'fillHistory'];
  for (const id of HEAVY) {
    const c = $(id);
    if (!c) continue;
    c.parentElement.append(Object.assign(document.createElement('span'), { className: 'heavy', textContent: T('pesada'), title: T('Puede hacer lenta la aplicación') }));
    c.addEventListener('click', async (e) => { // only a person's click asks; the app may still switch them on by itself
      if (!e.isTrusted || !c.checked || c.dataset.ok) return;
      e.preventDefault(); // the box stays off until the answer
      const v = await OGE.ask({ title: 'Esta opción puede hacer lenta la aplicación', ok: 'Activar igualmente', help: 'Dibuja muchos elementos o descarga muchos datos. En equipos modestos el mapa puede ir a tirones. Puedes apagar todas las opciones pesadas con el botón «Desactivar opciones pesadas» de Capas.' });
      if (!v) return;
      c.dataset.ok = '1'; c.checked = true; c.dispatchEvent(new Event('change')); delete c.dataset.ok;
    });
  }
  $('lightBtn').onclick = () => { let n = 0; for (const id of HEAVY) { const c = $(id); if (c && c.checked) { c.checked = false; c.dispatchEvent(new Event('change')); n++; } } OGE.toast(n ? `${n} ${T('opciones pesadas desactivadas.')}` : T('No había opciones pesadas activas.')); };

  // ---------- Viewer ----------
  const IMAGERY = {
    // Sentinel-2 cloudless 2016 by EOX (CC BY 4.0). The 2018+ editions are CC BY-NC-SA.
    s2: () => new C.UrlTemplateImageryProvider({
      url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg', maximumLevel: 14,
      credit: 'Sentinel-2 cloudless – https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016)',
    }),
    // Optional and not free: the user picks it knowing it is governed by Esri's terms of use.
    esri: () => new C.UrlTemplateImageryProvider({
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maximumLevel: 19,
      credit: 'Imágenes: Esri, Maxar, Earthstar Geographics y la comunidad de usuarios SIG',
    }),
  };
  // OpenStreetMap base maps that need no key (the Thunderforest and Tracestrack ones do, so they are not included).
  const osm = (url, credit, max) => () => new C.UrlTemplateImageryProvider({ url, credit, maximumLevel: max });
  Object.assign(IMAGERY, {
    osm: osm('https://tile.openstreetmap.org/{z}/{x}/{y}.png', '© OpenStreetMap', 19),
    topo: osm('https://a.tile.opentopomap.org/{z}/{x}/{y}.png', '© OpenStreetMap, SRTM · estilo © OpenTopoMap (CC-BY-SA)', 17),
    cyclosm: osm('https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', '© OpenStreetMap · estilo CyclOSM', 19),
    hot: osm('https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', '© OpenStreetMap · estilo Humanitario (HOT)', 19),
  });
  const viewer = new C.Viewer('globe', {
    baseLayer: new C.ImageryLayer(BODY && BODIES[BODY].url ? new C.UrlTemplateImageryProvider({ url: BODIES[BODY].url, maximumLevel: BODIES[BODY].max, tilingScheme: new C.GeographicTilingScheme(), credit: BODIES[BODY].credit }) : (IMAGERY[$('baseImagery').value] || IMAGERY.s2)()),
    baseLayerPicker: false, geocoder: false, sceneModePicker: false,
    timeline: false, animation: false, fullscreenButton: false,
  });
  viewer.scene.globe.preloadSiblings = true; viewer.scene.globe.tileCacheSize = 800; // the tiles around the view are fetched too: a new area is ready sooner
  C.RequestScheduler.requestsByServer['tiles.maps.eox.at:443'] = 12; // the default imagery host serves over HTTP/2: more tiles at once
  const scene = viewer.scene;
  viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK); // no entity tracking
  let base = viewer.imageryLayers.get(0);
  $('baseImagery').addEventListener('change', (e) => {
    viewer.imageryLayers.remove(base);
    base = viewer.imageryLayers.addImageryProvider(IMAGERY[e.target.value](), 0);
  });

  const OGE = window.OGE = { viewer, $, el };
  OGE.body = BODY; // null on the Earth
  if (BODY) { // no blue sky, no sea of air: the Moon has none, and Mars gets a thin butterscotch one
    scene.globe.showGroundAtmosphere = false; scene.fog.enabled = false; scene.moon.show = false; scene.globe.enableLighting = false; scene.globe.baseColor = C.Color.fromCssColorString(BODY === 'moon' ? '#3a3a3a' : '#7a4a30');
    if (BODY === 'moon') scene.skyAtmosphere.show = false; else { scene.skyAtmosphere.hueShift = -0.5; scene.skyAtmosphere.saturationShift = -0.3; scene.skyAtmosphere.brightnessShift = -0.25; }
    if (BODY === 'sky') { scene.globe.show = false; scene.skyAtmosphere.show = false; scene.moon.show = true; }
    document.title = BODIES[BODY].name + ' · OpenGISEarth';
  }
  $('bodySel').value = BODY || ''; // the Earth, the Moon or Mars: the page reloads on the chosen one
  $('bodySel').addEventListener('change', (e) => { const u = new URL(location.href); if (e.target.value) u.searchParams.set('body', e.target.value); else u.searchParams.delete('body'); location.href = u; });
  // Point of view of the visitor's country (from the browser language or time zone), as Natural Earth does with its POV fields.
  // In Argentina and Spain the Malvinas / Falkland Islands are shown as part of Argentina.
  OGE.pov = (() => { const l = navigator.language || '', tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '', force = new URLSearchParams(location.search).get('pov');
    if (force) return force.toUpperCase();
    if (/^ru(-RU)?$/i.test(l) || /^Europe\/(Moscow|Kaliningrad|Samara|Volgograd)$|^Asia\/(Yekaterinburg|Omsk|Novosibirsk|Krasnoyarsk|Irkutsk|Yakutsk|Vladivostok|Magadan|Kamchatka)$/.test(tz)) return 'RU';
    if (/^zh-(CN|Hans)/i.test(l) || /^Asia\/(Shanghai|Urumqi|Chongqing|Harbin)$/.test(tz)) return 'CN';
    if (/-IN$/i.test(l) || /^Asia\/(Kolkata|Calcutta)$/.test(tz)) return 'IN';
    return /-CL$/i.test(l) || /America\/(Santiago|Punta_Arenas)|Pacific\/Easter/.test(tz) ? 'CL' : /-AR$/i.test(l) || /Argentina|Buenos_Aires/.test(tz) ? 'AR' : /-ES$/i.test(l) || tz === 'Europe/Madrid' ? 'ES' : ''; })();
  if (window.__TAURI__) $('dlBtn').hidden = true; // already the desktop program
  if (window.__TAURI__) setTimeout(async () => { // update check: only the tag of the latest public release is read; nothing about this computer is sent
    try {
      const inv = window.__TAURI__.core.invoke, tag = String((await (await fetch('https://api.github.com/repos/avlopezparra/opengisearth/releases/latest')).json()).tag_name || '').slice(0, 30);
      const mine = tag && await inv('newer_than_mine', { tag });
      if (mine && await OGE.ask({ title: `Hay una versión nueva: ${tag}`, ok: 'Descargar', help: `Esta es la ${mine}. Se abrirá la página de descargas en tu navegador.` })) inv('open_release');
    } catch { /* offline, or no release published yet: nothing to say */ }
  }, 8000);
  // Full screen on phones and tablets (where the browser bars take room); the same button leaves it
  const fsOk = document.fullscreenEnabled || document.webkitFullscreenEnabled, touchDev = matchMedia('(pointer: coarse)').matches;
  const fsToggle = () => { const on = document.fullscreenElement || document.webkitFullscreenElement;
    if (on) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen).call(document.documentElement, { navigationUI: 'hide' })?.catch?.(() => {}); };
  for (const id of ['fsBtn', 'flyFs']) { $(id).hidden = !(fsOk && touchDev); $(id).onclick = fsToggle; }
  const fsLabel = () => { const on = !!(document.fullscreenElement || document.webkitFullscreenElement); for (const id of ['fsBtn', 'flyFs']) $(id).textContent = on ? T('⛶ Salir de pantalla completa') : T('⛶ Pantalla completa'); };
  document.addEventListener('fullscreenchange', fsLabel); document.addEventListener('webkitfullscreenchange', fsLabel);
  OGE.malvinasAR = OGE.pov === 'AR' || OGE.pov === 'ES';
  // Areas painted in the claimant's color from its own point of view (names as in Natural Earth's disputed areas)
  OGE.povClaims = { RU: ['RUS', ['Crimea', "Donetsk People's Republic", "Luhansk People's Republic"]],
    CN: ['CHN', ['Taiwan', 'Arunachal Pradesh', 'Demchok', 'Samdu Valleys', 'Tirpani Valleys', 'Bara Hotii Valleys']],
    IN: ['IND', ['Aksai Chin', 'Shaksam Valley', 'Gilgit-Baltistan', 'Azad Kashmir', 'Siachen Glacier']] }[OGE.pov] || null;
  OGE.taiwanCN = OGE.pov === 'CN';
  OGE.antarticaCL = OGE.pov === 'CL'; // in Chile the Chilean Antarctic Territory (53° W – 90° W, south of 60° S) is shown as part of the country

  // Sunlight: lights the globe according to the current time (day side and night side), like "Sun" in Earth.
  const sun = $('layerSun'), syncSun = () => { scene.globe.enableLighting = sun.checked; };
  sun.addEventListener('change', syncSun);
  syncSun();

  // ---------- Notices ----------
  let toastT;
  OGE.toast = (msg, error) => {
    const t = $('toast');
    t.textContent = msg; t.className = error ? 'err' : ''; t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.hidden = true; }, error ? 9000 : 5000);
  };
  OGE.hint = (t) => { $('hint').textContent = t || ''; };
  OGE.fmtLen = (m) => (m >= 1000 ? (m / 1000).toLocaleString('es', { maximumFractionDigits: 2 }) + ' km' : Math.round(m) + ' m');
  OGE.fmtArea = (m2) => (m2 >= 1e6 ? (m2 / 1e6).toLocaleString('es', { maximumFractionDigits: 2 }) + ' km²'
    : m2 >= 1e4 ? (m2 / 1e4).toLocaleString('es', { maximumFractionDigits: 2 }) + ' ha' : Math.round(m2).toLocaleString('es') + ' m²');
  // true if the user is typing or a dialog is open: keyboard shortcuts must not act
  OGE.typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || !!document.querySelector('dialog[open]');
  OGE.setCheck = (cb, v) => { if (cb.checked !== v) { cb.checked = v; cb.dispatchEvent(new Event('change')); } };

  // ---------- Undo / redo: each action is {do, undo} ----------
  const done = [], undone = [], listeners = [];
  const fire = () => listeners.forEach((f) => f());
  OGE.onChange = (f) => listeners.push(f); // called after every action, undo or redo
  OGE.run = (cmd) => { cmd.do(); done.push(cmd); if (done.length > 300) done.shift(); undone.length = 0; fire(); };
  OGE.undo = () => { const c = done.pop(); if (c) { c.undo(); undone.push(c); fire(); } };
  OGE.redo = () => { const c = undone.pop(); if (c) { c.do(); done.push(c); fire(); } };
  $('undo').onclick = OGE.undo;
  $('redo').onclick = OGE.redo;
  document.addEventListener('keydown', (e) => {
    if (OGE.typing(e) || !e.ctrlKey) return;
    const k = e.key.toLowerCase();
    if (k === 'z') { e.preventDefault(); (e.shiftKey ? OGE.redo : OGE.undo)(); } else if (k === 'y') { e.preventDefault(); OGE.redo(); }
  });

  // ---------- Generic parameter dialog (replaces prompt/confirm) ----------
  // fields: [{id, label, type: number|text|select|checkbox|textarea|color|range, value, options, min, max, step, hint}]
  OGE.ask = ({ title, help, fields = [], ok = 'Aceptar' }) => new Promise((resolve) => {
    const dlg = $('ask'), form = dlg.firstElementChild, get = {};
    form.replaceChildren(el('h2', { textContent: title }));
    if (help) form.append(el('p', { className: 'small', textContent: help }));
    for (const f of fields) {
      let inp;
      if (f.type === 'select') {
        inp = el('select');
        for (const o of f.options) inp.append(Array.isArray(o) ? new Option(o[1], o[0]) : new Option(o, o));
        if (f.value != null) inp.value = f.value;
        get[f.id] = () => inp.value;
      } else if (f.type === 'checkbox') {
        inp = el('input', { type: 'checkbox', checked: !!f.value });
        get[f.id] = () => inp.checked;
      } else if (f.type === 'textarea') {
        inp = el('textarea', { rows: f.rows || 4, value: f.value ?? '' });
        get[f.id] = () => inp.value;
      } else {
        inp = el('input', { type: f.type || 'text', value: f.value ?? '' });
        for (const k of ['min', 'max', 'step', 'placeholder']) if (f[k] != null) inp[k] = f[k];
        const numeric = f.type === 'number' || f.type === 'range';
        if (f.type === 'number') { if (f.step == null) inp.step = 'any'; inp.required = f.required !== false; }
        get[f.id] = numeric ? () => (inp.value === '' ? null : Number(inp.value)) : () => inp.value;
      }
      form.append(f.type === 'checkbox' ? el('label', { className: 'check' }, inp, f.label) : el('label', {}, f.label, inp));
      if (f.hint) form.append(el('div', { className: 'small', textContent: f.hint }));
    }
    const cancel = el('button', { type: 'button', textContent: 'Cancelar' });
    form.append(el('div', { className: 'row end' }, cancel, el('button', { textContent: ok })));
    // Resolved on the submit or cancel itself (not on the "close" event, which the browser delays if the window is not visible).
    let settled = false;
    const finish = (okd) => {
      if (settled) return;
      settled = true;
      const out = okd ? Object.fromEntries(Object.entries(get).map(([k, g]) => [k, g()])) : null;
      if (dlg.open) dlg.close();
      resolve(out);
    };
    cancel.onclick = () => finish(false);
    form.onsubmit = (e) => { e.preventDefault(); finish(true); }; // Enter or the main button
    dlg.oncancel = () => finish(false); // Esc
    dlg.showModal();
  });
  OGE.confirm = (title, help) => OGE.ask({ title, help, ok: 'Sí' }).then(Boolean);

  // ---------- Downloads, CSV and tables ----------
  OGE.download = (name, data, mime = 'application/octet-stream') => {
    const a = el('a', { href: URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: mime })), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 15000);
  };
  OGE.csv = (cols, rows) => '﻿' + [cols, ...rows].map((r) => r.map((v) => {
    const s = v == null ? '' : String(v);
    return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n');
  const cell = (v) => (v instanceof Node ? v.textContent : v == null ? '' : typeof v === 'number' && !Number.isInteger(v) ? String(+v.toFixed(6)) : typeof v === 'object' ? JSON.stringify(v) : String(v));
  // Table or report. content: optional DOM node (e.g. a chart) shown above the table.
  OGE.showTable = (title, cols, rows, { onRow, note, content } = {}) => {
    const MAX = 1000;
    $('tableTitle').textContent = title;
    $('tableNote').textContent = (note || '') + (rows.length > MAX ? ` Se muestran ${MAX} de ${rows.length} filas; el CSV las incluye todas.` : '');
    const t = el('table', {}, el('tr', {}, ...cols.map((c) => el('th', { textContent: c }))));
    rows.slice(0, MAX).forEach((r, i) => {
      const tr = el('tr', {}, ...r.map((v) => (v instanceof Node ? el('td', {}, v) : el('td', { textContent: cell(v) })))); // a cell may be ready-made content
      if (onRow) { tr.className = 'click'; tr.onclick = () => onRow(i); }
      t.append(tr);
    });
    $('tableBody').replaceChildren(...(content ? [content] : []), ...(cols.length ? [t] : []));
    $('tableCsv').hidden = !cols.length;
    $('tableCsv').onclick = () => OGE.download(title.replace(/[\\/:*?"<>|]+/g, '_') + '.csv', OGE.csv(cols, rows), 'text/csv');
    if (!$('table').open) { $('table').showModal(); OGE.chime('open'); }
  };
  $('tableClose').onclick = () => $('table').close();
  $('table').addEventListener('close', () => OGE.chime('close'));

  // ---------- Aiming: ground under a pixel, look-at point and visible rectangle ----------
  OGE.pickGround = (p) => { const ray = viewer.camera.getPickRay(p); return ray ? scene.globe.pick(ray, scene) : undefined; };
  OGE.lookAt = () => {
    const pos = OGE.pickGround(new C.Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2));
    return pos ? { pos, carto: C.Cartographic.fromCartesian(pos), dist: C.Cartesian3.distance(viewer.camera.positionWC, pos) } : null;
  };
  OGE.viewBbox = () => { // [west, south, east, north] in degrees
    const r = viewer.camera.computeViewRectangle();
    if (!r) return null;
    const b = [r.west, r.south, r.east, r.north].map(deg);
    if (b[0] > b[2]) b[2] = 180; // shortcut: a view that crosses the antimeridian is cut at 180°
    return b;
  };

  // ---------- Search: "lat, lon" coordinates or place name (Nominatim / OpenStreetMap) ----------
  $('search').onsubmit = async (e) => {
    e.preventDefault();
    const q = $('q').value.trim(), ul = $('results');
    if (!q) return;
    const m = q.match(/^(-?\d+(?:\.\d+)?)[\s,;]+(-?\d+(?:\.\d+)?)$/);
    if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180) {
      ul.replaceChildren();
      return viewer.camera.flyTo({ destination: C.Cartesian3.fromDegrees(+m[2], +m[1], 5000) });
    }
    ul.replaceChildren(el('li', { textContent: 'Buscando…' }));
    try {
      const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=6&accept-language=' + OGE_LANG + '&q=' + encodeURIComponent(q));
      const hits = await r.json();
      ul.replaceChildren(...(hits.length ? [] : [el('li', { textContent: 'Sin resultados' })]));
      for (const h of hits) {
        const [s, n, w, ea] = h.boundingbox.map(Number); // [south, north, west, east]
        const a = el('a', { textContent: h.display_name, title: h.display_name });
        a.onclick = () => viewer.camera.flyTo({ destination: C.Rectangle.fromDegrees(w, s, ea, n) });
        ul.append(el('li', {}, a));
      }
      if (hits.length) ul.querySelector('a').click();
    } catch (err) {
      ul.replaceChildren(el('li', { textContent: 'Error de búsqueda: ' + err.message }));
    }
  };

  // ---------- Status bar: coordinates and elevation under the cursor, eye altitude ----------
  let mouse = null, lastSb = 0;
  new C.ScreenSpaceEventHandler(scene.canvas).setInputAction((m) => { mouse = m.endPosition; }, C.ScreenSpaceEventType.MOUSE_MOVE);
  scene.postRender.addEventListener(() => {
    const t = performance.now();
    if (t - lastSb < 200) return;
    lastSb = t;
    let s = '';
    const g = mouse && OGE.pickGround(mouse);
    if (g) {
      const c = C.Cartographic.fromCartesian(g), la = deg(c.latitude), lo = deg(c.longitude);
      s = `${Math.abs(la).toFixed(5)}° ${la < 0 ? 'S' : 'N'}  ${Math.abs(lo).toFixed(5)}° ${lo < 0 ? 'O' : 'E'}  elev. ${Math.round(c.height / scene.verticalExaggeration)} m  ·  `;
    }
    const eye = viewer.camera.positionCartographic.height;
    $('statusbar').textContent = s + 'ojo a ' + (eye > 10000 ? Math.round(eye / 1000).toLocaleString('es') + ' km' : Math.round(eye) + ' m');
  });

  // Map text drawn on our own canvas (at 2x, shown at scale 0.5): Cesium's SDF label outlines render as noise on some GPUs.
  OGE.textImage = (text, font, color) => C.writeTextToCanvas(text, { font: font.replace(/(\d+)px/, (m, n) => n * 2 + 'px'),
    fillColor: color, stroke: true, strokeColor: C.Color.BLACK, strokeWidth: 5, padding: 4 });

  // ---------- Compass: the needle follows the camera heading; a click turns the view north-up ----------
  scene.postRender.addEventListener(() => { $('compass').firstElementChild.style.transform = `rotate(${-viewer.camera.heading}rad)`; });
  $('compass').onclick = () => viewer.camera.flyTo({ destination: viewer.camera.positionWC.clone(), orientation: { heading: 0, pitch: viewer.camera.pitch, roll: 0 }, duration: 0.6 });
  // GPS: the location service of the browser itself; the position stays on this device
  let gpsDot = null;
  $('gpsBtn').hidden = !!BODY || !navigator.geolocation;
  $('gpsBtn').onclick = () => {
    OGE.toast('Buscando tu ubicación…');
    navigator.geolocation.getCurrentPosition(({ coords: c }) => {
      if (gpsDot) viewer.entities.remove(gpsDot);
      gpsDot = viewer.entities.add({ position: C.Cartesian3.fromDegrees(c.longitude, c.latitude), point: { pixelSize: 14, color: C.Color.fromCssColorString('#0a84ff'), outlineColor: C.Color.WHITE, outlineWidth: 3, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
      gpsDot._tmp = true; // not a user feature: never saved
      viewer.camera.flyTo({ destination: C.Cartesian3.fromDegrees(c.longitude, c.latitude, Math.max(1500, c.accuracy * 6)), duration: 2 });
      OGE.toast(`Tu ubicación: ${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)} (±${Math.round(c.accuracy)} m)`);
    }, (e) => OGE.toast(e.code === 1 ? 'Permiso de ubicación denegado: actívalo en el navegador para usar el GPS.' : 'No se pudo obtener tu ubicación.', true), { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  };

  // ---------- World minimap: where the camera (or the aircraft) is; other modules add their marks through OGE.minimap.extra ----------
  const mm = $('minimap'), mg = mm.getContext('2d'), mmTiles = new Map(); // Natural Earth II level 2 (8 × 4 tiles of 45°), loaded when first needed
  const mmTile = (i, j) => { const k = i + '/' + j; if (!mmTiles.has(k)) mmTiles.set(k, Object.assign(new Image(), { src: `cesium/Assets/Textures/NaturalEarthII/2/${i}/${3 - j}.jpg` })); return mmTiles.get(k); }; // TMS rows count from the south
  const MMZ = [1, 2, 4, 8, 16, 32, 64, 128, 256]; // from 16× up, Esri satellite imagery is drawn on top (Natural Earth is too coarse)
  let mmImg = null, mmBusy = false; // mmImg: { img, w, s, e, n, z }
  let mmZoom = +localStorage.getItem('oge.mmZoom') || 4, mmLon = 0, mmLat = 0, mmLast = 0; // the map is centered on the camera
  const mmSetZoom = (d) => { mmZoom = MMZ[C.Math.clamp(MMZ.indexOf(mmZoom) + d, 0, MMZ.length - 1)] || 4; localStorage.setItem('oge.mmZoom', mmZoom); mmLast = 0; };
  const mmDx = (lon) => (((lon - mmLon + 540) % 360) - 180) / 360; // fraction of the world, wrapped around the center
  OGE.minimap = { extra: null, zoom: mmSetZoom,
    xy: (lon, lat) => [mm.width / 2 + mmDx(lon) * mm.width * mmZoom, mm.height / 2 - ((lat - mmLat) / 180) * mm.height * mmZoom] };
  scene.postRender.addEventListener(() => {
    const now = performance.now();
    if ($('mmBox').hidden || $('mmBox').classList.contains('min') || now - mmLast < 200) return; // five times per second is enough
    mmLast = now;
    const W = mm.width, H = mm.height, c = viewer.camera.positionCartographic, tw = (W * mmZoom) / 8, th = (H * mmZoom) / 4;
    mmLon = deg(c.longitude);
    mmLat = C.Math.clamp(deg(c.latitude), -90 + 90 / mmZoom, 90 - 90 / mmZoom); // do not scroll past the poles
    mg.fillStyle = '#0b1a2b'; mg.fillRect(0, 0, W, H);
    for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) {
      const y = H / 2 - ((90 - 45 * j - mmLat) / 180) * H * mmZoom;
      for (const x of [W / 2 + mmDx(-180 + 45 * i) * W * mmZoom, W / 2 + (mmDx(-180 + 45 * i) - 1) * W * mmZoom]) { // second copy: a tile cut by the wrap also shows at the other edge
        if (x > W || x + tw < 0 || y > H || y + th < 0) continue;
        const im = mmTile(i, j);
        if (im.complete && im.naturalWidth) mg.drawImage(im, x, y, tw + 0.5, th + 0.5);
      }
    }
    if (mmZoom >= 16) { // a sharper picture for the close zooms: one Esri export covering twice the window, fetched again when the view leaves it
      const hw = 180 / mmZoom, hh = 90 / mmZoom, fits = mmImg && mmImg.z === mmZoom && mmLon - hw > mmImg.w && mmLon + hw < mmImg.e && mmLat - hh > mmImg.s && mmLat + hh < mmImg.n;
      if (!fits && !mmBusy) {
        mmBusy = true;
        const b = { w: mmLon - hw * 2, e: mmLon + hw * 2, s: Math.max(-89.9, mmLat - hh * 2), n: Math.min(89.9, mmLat + hh * 2), z: mmZoom }, img = new Image();
        img.onload = () => { mmImg = { ...b, img }; mmBusy = false; mmLast = 0; }; img.onerror = () => { mmBusy = false; };
        img.src = `https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export?bbox=${b.w},${b.s},${b.e},${b.n}&bboxSR=4326&imageSR=4326&size=${W * 4},${H * 4}&format=jpg&f=image`;
      }
      if (mmImg && mmImg.z === mmZoom) { const [x0, y0] = OGE.minimap.xy(mmImg.w, mmImg.n), [x1, y1] = OGE.minimap.xy(mmImg.e, mmImg.s); if (x1 > x0) mg.drawImage(mmImg.img, x0, y0, x1 - x0, y1 - y0); }
    }
    if (OGE.minimap.extra) OGE.minimap.extra(mg);
    const [x, y] = OGE.minimap.xy(deg(c.longitude), deg(c.latitude));
    mg.save(); mg.translate(x, y); mg.rotate(viewer.camera.heading); mg.fillStyle = '#ff3b30'; mg.strokeStyle = '#fff'; mg.lineWidth = 1.5;
    mg.beginPath(); mg.moveTo(0, -8); mg.lineTo(5, 6); mg.lineTo(0, 3); mg.lineTo(-5, 6); mg.closePath(); mg.fill(); mg.stroke(); mg.restore();
  });
  mm.onclick = (e) => { // fly to the clicked place; in flight the aircraft's autopilot takes it there (OGE.minimap.pick)
    const b = mm.getBoundingClientRect(), fx = (e.clientX - b.left) / b.width - 0.5, fy = (e.clientY - b.top) / b.height - 0.5, lon = mmLon + (fx * 360) / mmZoom, lat = C.Math.clamp(mmLat - (fy * 180) / mmZoom, -89, 89);
    if (OGE.minimap.pick && OGE.minimap.pick(lon, lat)) return;
    viewer.camera.flyTo({ destination: C.Cartesian3.fromDegrees(lon, lat, Math.max(2e6, viewer.camera.positionCartographic.height)) });
  };
  const mmMin = (v) => { $('mmBox').classList.toggle('min', v); $('mmMin').textContent = v ? '🗺' : '▾'; localStorage.setItem('oge.mmMin', v ? '1' : ''); mmLast = 0; };
  $('mmMin').onclick = () => mmMin(!$('mmBox').classList.contains('min'));
  mmMin(!!localStorage.getItem('oge.mmMin'));
  OGE.minimap.toggle = $('mmMin').onclick;
  OGE.minimap.open = () => { const cb = $('layerMinimap'); if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); } mmMin(false); }; // the arcade starts with it open
  $('mmIn').onclick = () => mmSetZoom(1);
  $('mmOut').onclick = () => mmSetZoom(-1);
  mm.addEventListener('wheel', (e) => { e.preventDefault(); mmSetZoom(e.deltaY < 0 ? 1 : -1); }, { passive: false });
  const cbMm = $('layerMinimap'), syncMm = () => { $('mmBox').hidden = !cbMm.checked; };
  cbMm.addEventListener('change', syncMm);
  syncMm();

  // ---------- Chime when an information box opens (a place, a city's weather, a country's data) ----------
  let chimeAc = null;
  OGE.chime = (big) => { // big: the fuller sound of a capital
    if (localStorage.getItem('oge.mute')) return;
    try {
      chimeAc = chimeAc || new AudioContext();
      const notes = big === 'open' ? [[660, 0], [990, 0.07]] : big === 'close' ? [[990, 0], [660, 0.07]] : big ? [[523, 0], [659, 0.1], [784, 0.2], [1047, 0.32], [1319, 0.44]] : [[880, 0], [1320, 0.09]];
      big = big === true; // 'open' and 'close' are the short sounds of a table
      notes.forEach(([f, d]) => { // two soft bell notes, or a rising fanfare
        const o = chimeAc.createOscillator(), v = chimeAc.createGain(), t = chimeAc.currentTime + d;
        o.type = big ? 'triangle' : 'sine'; o.frequency.value = f; v.gain.setValueAtTime(big ? 0.1 : 0.07, t); v.gain.exponentialRampToValueAtTime(0.001, t + (big ? 0.5 : 0.35));
        o.connect(v).connect(chimeAc.destination); o.start(t); o.stop(t + 0.52);
      });
    } catch { /* no audio device */ }
  };
  viewer.selectedEntityChanged.addEventListener((e) => { if (e) OGE.chime(); });

  // ---------- Zoom sounds: sounds/zoom_in.wav and sounds/zoom_out.wav if they exist, otherwise a short synthesized sweep ----------
  const zoomClip = { in: new Audio('sounds/zoom_in.wav'), out: new Audio('sounds/zoom_out.wav') };
  for (const a of Object.values(zoomClip)) { a.preload = 'auto'; a.volume = 0.5; a.onerror = () => { a.bad = true; }; }
  let zoomAc = null, zoomH = null, zoomT = 0, zoomDir = null;
  function zoomSound(dir) {
    if (!$('layerZoomSound').checked || localStorage.getItem('oge.mute') || document.body.classList.contains('flying')) return; // switched off, muted, or the flight has its own sounds
    const far = C.Math.clamp((Math.log10(Math.max(1, viewer.camera.positionCartographic.height)) - 4) / 3.3, 0, 1), rate = 1.7 - far; // slow from far away, quick up close
    const clip = zoomClip[dir] || { bad: true };
    if (!clip.bad && clip.readyState >= 2) { clip.playbackRate = rate; clip.currentTime = 0; clip.play().catch(() => {}); return; }
    try {
      zoomAc = zoomAc || new AudioContext();
      const o = zoomAc.createOscillator(), v = zoomAc.createGain(), t = zoomAc.currentTime, len = 0.2 / rate;
      const [f0, f1] = dir === 'spin' ? [180, 520] : dir === 'in' ? [320 * rate, 880 * rate] : [880 * rate, 320 * rate];
      o.type = dir === 'spin' ? 'triangle' : 'sine'; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + len * 0.9);
      v.gain.setValueAtTime(0.05, t); v.gain.exponentialRampToValueAtTime(0.001, t + len);
      o.connect(v).connect(zoomAc.destination); o.start(t); o.stop(t + len + 0.01);
    } catch { /* no audio device */ }
  }
  scene.postRender.addEventListener(() => { // sampled three times a second: a clear change of height is a zoom
    const now = performance.now();
    if (now - zoomT < 320) return;
    const h = viewer.camera.positionCartographic.height;
    const dir = C.Cartesian3.normalize(viewer.camera.positionWC, new C.Cartesian3());
    if (zoomH !== null && (h < zoomH * 0.88 || h > zoomH * 1.14)) zoomSound(h < zoomH ? 'in' : 'out');
    else if (zoomDir && C.Cartesian3.angleBetween(dir, zoomDir) > Math.min(0.16, (0.3 * h) / 6371000)) zoomSound('spin'); // the view is being dragged fast: ~9° per sample from afar, or a third of the eye height up close
    zoomH = h; zoomT = now; zoomDir = dir;
  });

  // ---------- View screenshot ----------
  $('shotBtn').onclick = () => { viewer.render(); scene.canvas.toBlob((b) => OGE.download('OpenGISEarth.png', b)); };

  // ---------- Panels: sidebar width (drag the edge), hiding it, and collapsing the bars ----------
  const setSide = (w) => { document.documentElement.style.setProperty('--side', w + 'px'); localStorage.setItem('oge.side', w); };
  const hideSide = (h) => { document.body.classList.toggle('noside', h); localStorage.setItem('oge.noside', h ? '1' : ''); };
  if (localStorage.getItem('oge.side')) setSide(+localStorage.getItem('oge.side'));
  hideSide(!!localStorage.getItem('oge.noside'));
  const PHONE = matchMedia('(max-width: 700px)').matches;
  if (PHONE) document.body.classList.add('noside'); // phones start on the map; the panel opens over it with the ☰ button
  if (PHONE || matchMedia('(pointer: coarse)').matches) { scene.msaaSamples = 1; scene.globe.showGroundAtmosphere = false; } // mobile GPUs: antialiasing costs too much memory, and the ground atmosphere shader can turn the far globe black
  $('sideBtn').onclick = () => hideSide(!document.body.classList.contains('noside'));
  OGE.hideSide = hideSide;
  $('sideClose').onclick = () => hideSide(true);
  if (matchMedia('(pointer: coarse)').matches) viewer.canvas.addEventListener('pointerdown', () => { if (!document.body.classList.contains('noside') && matchMedia('(max-width: 1100px)').matches) hideSide(true); }); // phones: touching the map closes the panel // the flight closes the panel and gives it back afterwards
  const sp = $('splitter');
  sp.onpointerdown = (e) => { sp.setPointerCapture(e.pointerId); sp.classList.add('drag'); };
  sp.onpointermove = (e) => { if (sp.classList.contains('drag')) setSide(Math.max(180, Math.min(window.innerWidth - 200, e.clientX))); };
  sp.onpointerup = sp.onpointercancel = () => sp.classList.remove('drag');
  sp.ondblclick = () => hideSide(true);
  document.querySelectorAll('.bar > .fold').forEach((b) => {
    const bar = b.parentElement, key = 'oge.fold.' + bar.id;
    const set = (f) => { bar.classList.toggle('folded', f); b.textContent = f ? '▸' : '▾'; localStorage.setItem(key, f ? '1' : ''); };
    set(!!localStorage.getItem(key));
    b.onclick = () => set(!bar.classList.contains('folded'));
  });
})();
