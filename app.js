// OpenGISEarth — núcleo: visor, utilidades compartidas, deshacer, diálogos, búsqueda, barra de estado y paneles.
Cesium.Ion.defaultAccessToken = ''; // sin Cesium ion: solo datos abiertos

(() => {
  const C = Cesium;
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const deg = C.Math.toDegrees;

  // Las casillas de Capas recuerdan su estado entre sesiones (se restauran antes de que cada módulo las lea).
  document.querySelectorAll('.layers input[type=checkbox], .layers select').forEach((c) => {
    const key = 'oge.ui.' + c.id, saved = localStorage.getItem(key);
    if (saved !== null) { if (c.type === 'checkbox') c.checked = saved === '1'; else c.value = saved; }
    c.addEventListener('change', () => localStorage.setItem(key, c.type === 'checkbox' ? (c.checked ? '1' : '0') : c.value));
  });

  // ---------- Visor ----------
  const IMAGERY = {
    // Sentinel-2 cloudless 2016 de EOX (CC BY 4.0). Las ediciones 2018+ son CC BY-NC-SA.
    s2: () => new C.UrlTemplateImageryProvider({
      url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg', maximumLevel: 14,
      credit: 'Sentinel-2 cloudless – https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016)',
    }),
    // Opcional y no libre: el usuario la elige sabiendo que se rige por los términos de uso de Esri.
    esri: () => new C.UrlTemplateImageryProvider({
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maximumLevel: 19,
      credit: 'Imágenes: Esri, Maxar, Earthstar Geographics y la comunidad de usuarios SIG',
    }),
  };
  // Mapas base de OpenStreetMap que no piden clave (los de Thunderforest y Tracestrack sí la piden y no se incluyen).
  const osm = (url, credit, max) => () => new C.UrlTemplateImageryProvider({ url, credit, maximumLevel: max });
  Object.assign(IMAGERY, {
    osm: osm('https://tile.openstreetmap.org/{z}/{x}/{y}.png', '© OpenStreetMap', 19),
    topo: osm('https://a.tile.opentopomap.org/{z}/{x}/{y}.png', '© OpenStreetMap, SRTM · estilo © OpenTopoMap (CC-BY-SA)', 17),
    cyclosm: osm('https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', '© OpenStreetMap · estilo CyclOSM', 19),
    hot: osm('https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', '© OpenStreetMap · estilo Humanitario (HOT)', 19),
  });
  const viewer = new C.Viewer('globe', {
    baseLayer: new C.ImageryLayer((IMAGERY[$('baseImagery').value] || IMAGERY.s2)()),
    baseLayerPicker: false, geocoder: false, sceneModePicker: false,
    timeline: false, animation: false, fullscreenButton: false,
  });
  const scene = viewer.scene;
  viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK); // sin seguimiento de entidad
  let base = viewer.imageryLayers.get(0);
  $('baseImagery').addEventListener('change', (e) => {
    viewer.imageryLayers.remove(base);
    base = viewer.imageryLayers.addImageryProvider(IMAGERY[e.target.value](), 0);
  });

  const OGE = window.OGE = { viewer, $, el };

  // Luz del sol: ilumina el globo según la hora actual (lado de día y lado de noche), como «Sol» en Earth.
  const sun = $('layerSun'), syncSun = () => { scene.globe.enableLighting = sun.checked; };
  sun.addEventListener('change', syncSun);
  syncSun();

  // ---------- Avisos ----------
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
  // true si el usuario está escribiendo o hay un diálogo abierto: los atajos de teclado no deben actuar
  OGE.typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || !!document.querySelector('dialog[open]');
  OGE.setCheck = (cb, v) => { if (cb.checked !== v) { cb.checked = v; cb.dispatchEvent(new Event('change')); } };

  // ---------- Deshacer / rehacer: cada acción es {do, undo} ----------
  const done = [], undone = [], listeners = [];
  const fire = () => listeners.forEach((f) => f());
  OGE.onChange = (f) => listeners.push(f); // se llama tras cada acción, deshacer o rehacer
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

  // ---------- Diálogo genérico de parámetros (reemplaza a prompt/confirm) ----------
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
    // Se resuelve en el propio envío o cancelación (no en el evento «close», que el navegador retrasa si la ventana no se ve).
    let settled = false;
    const finish = (okd) => {
      if (settled) return;
      settled = true;
      const out = okd ? Object.fromEntries(Object.entries(get).map(([k, g]) => [k, g()])) : null;
      if (dlg.open) dlg.close();
      resolve(out);
    };
    cancel.onclick = () => finish(false);
    form.onsubmit = (e) => { e.preventDefault(); finish(true); }; // Enter o el botón principal
    dlg.oncancel = () => finish(false); // Esc
    dlg.showModal();
  });
  OGE.confirm = (title, help) => OGE.ask({ title, help, ok: 'Sí' }).then(Boolean);

  // ---------- Descargas, CSV y tablas ----------
  OGE.download = (name, data, mime = 'application/octet-stream') => {
    const a = el('a', { href: URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: mime })), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 15000);
  };
  OGE.csv = (cols, rows) => '﻿' + [cols, ...rows].map((r) => r.map((v) => {
    const s = v == null ? '' : String(v);
    return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n');
  const cell = (v) => (v == null ? '' : typeof v === 'number' && !Number.isInteger(v) ? String(+v.toFixed(6)) : typeof v === 'object' ? JSON.stringify(v) : String(v));
  // Tabla o informe. content: nodo DOM opcional (p. ej. un gráfico) que se muestra sobre la tabla.
  OGE.showTable = (title, cols, rows, { onRow, note, content } = {}) => {
    const MAX = 1000;
    $('tableTitle').textContent = title;
    $('tableNote').textContent = (note || '') + (rows.length > MAX ? ` Se muestran ${MAX} de ${rows.length} filas; el CSV las incluye todas.` : '');
    const t = el('table', {}, el('tr', {}, ...cols.map((c) => el('th', { textContent: c }))));
    rows.slice(0, MAX).forEach((r, i) => {
      const tr = el('tr', {}, ...r.map((v) => el('td', { textContent: cell(v) })));
      if (onRow) { tr.className = 'click'; tr.onclick = () => onRow(i); }
      t.append(tr);
    });
    $('tableBody').replaceChildren(...(content ? [content] : []), ...(cols.length ? [t] : []));
    $('tableCsv').hidden = !cols.length;
    $('tableCsv').onclick = () => OGE.download(title.replace(/[\\/:*?"<>|]+/g, '_') + '.csv', OGE.csv(cols, rows), 'text/csv');
    if (!$('table').open) $('table').showModal();
  };
  $('tableClose').onclick = () => $('table').close();

  // ---------- Puntería: suelo bajo un píxel, punto mirado y rectángulo visible ----------
  OGE.pickGround = (p) => { const ray = viewer.camera.getPickRay(p); return ray ? scene.globe.pick(ray, scene) : undefined; };
  OGE.lookAt = () => {
    const pos = OGE.pickGround(new C.Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2));
    return pos ? { pos, carto: C.Cartographic.fromCartesian(pos), dist: C.Cartesian3.distance(viewer.camera.positionWC, pos) } : null;
  };
  OGE.viewBbox = () => { // [oeste, sur, este, norte] en grados
    const r = viewer.camera.computeViewRectangle();
    if (!r) return null;
    const b = [r.west, r.south, r.east, r.north].map(deg);
    if (b[0] > b[2]) b[2] = 180; // shortcut: una vista que cruza el antimeridiano se corta en 180°
    return b;
  };

  // ---------- Búsqueda: coordenadas «lat, lon» o topónimo (Nominatim / OpenStreetMap) ----------
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
        const [s, n, w, ea] = h.boundingbox.map(Number); // [sur, norte, oeste, este]
        const a = el('a', { textContent: h.display_name, title: h.display_name });
        a.onclick = () => viewer.camera.flyTo({ destination: C.Rectangle.fromDegrees(w, s, ea, n) });
        ul.append(el('li', {}, a));
      }
      if (hits.length) ul.querySelector('a').click();
    } catch (err) {
      ul.replaceChildren(el('li', { textContent: 'Error de búsqueda: ' + err.message }));
    }
  };

  // ---------- Barra de estado: coordenadas y elevación bajo el cursor, altura del ojo ----------
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

  // ---------- Primera vez: el usuario decide qué imágenes usar (luego se cambia en Capas → Imágenes) ----------
  if (localStorage.getItem('oge.ui.baseImagery') === null) setTimeout(async () => {
    const sel = $('baseImagery');
    const v = await OGE.ask({ title: '¿Qué imágenes satelitales quieres usar?', help: 'Puedes cambiarlo cuando quieras en Capas → Imágenes.',
      fields: [{ id: 'img', label: 'Imágenes', type: 'select', value: sel.value, options: [...sel.options].map((o) => [o.value, o.textContent]) }] });
    sel.value = v ? v.img : sel.value;
    sel.dispatchEvent(new Event('change')); // también guarda la elección
  }, 1500);

  // ---------- Captura de la vista ----------
  $('shotBtn').onclick = () => { viewer.render(); scene.canvas.toBlob((b) => OGE.download('OpenGISEarth.png', b)); };

  // ---------- Paneles: ancho del lateral (arrastrar el borde), ocultarlo, y plegar las barras ----------
  const setSide = (w) => { document.documentElement.style.setProperty('--side', w + 'px'); localStorage.setItem('oge.side', w); };
  const hideSide = (h) => { document.body.classList.toggle('noside', h); localStorage.setItem('oge.noside', h ? '1' : ''); };
  if (localStorage.getItem('oge.side')) setSide(+localStorage.getItem('oge.side'));
  hideSide(!!localStorage.getItem('oge.noside'));
  $('sideBtn').onclick = () => hideSide(!document.body.classList.contains('noside'));
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
