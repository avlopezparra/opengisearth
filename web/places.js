// OpenGISEarth — Places: tree with checkboxes (like Earth), properties and style, opening/exporting files and autosave.
(() => {
  const C = Cesium, { viewer, geo, $, el } = OGE;
  const now = () => viewer.clock.currentTime;
  const expanded = new Set(['Mis dibujos']);
  const MAX_ROWS = 300; // rows per layer in the tree; the rest is seen in the attribute table
  const ICON = { point: '📍', line: '〰', polygon: '⬠', image: '🖼' };
  const TYPE = { point: 'marca', line: 'trazado', polygon: 'polígono', image: 'imagen superpuesta' };

  // ---------- Tree ----------
  const btn = (txt, title, fn, cls) => { const b = el('button', { textContent: txt, title, className: cls || '' }); b.onclick = (ev) => { ev.stopPropagation(); fn(); }; return b; };
  function row({ key, label, title, show, onShow, onOpen, kids, buttons = [] }) {
    const open = expanded.has(key);
    const tw = el('span', { className: 'tw', textContent: kids ? (open ? '▾' : '▸') : '' });
    tw.onclick = () => { if (open) expanded.delete(key); else expanded.add(key); renderTree(); };
    const cb = el('input', { type: 'checkbox', checked: show });
    cb.setAttribute('aria-label', 'Mostrar ' + label);
    cb.onchange = () => { onShow(cb.checked); save(); };
    const a = el('a', { textContent: label, title: title || label });
    a.onclick = onOpen;
    const li = el('li', {}, el('div', { className: 'node' }, tw, cb, a, ...buttons));
    if (kids && open) li.append(el('ul', {}, ...kids()));
    return li;
  }
  function entityRows(ds) {
    const byParent = new Map(); // KML folders: children hang from their parent entity
    for (const e of ds.entities.values) {
      const pid = e.parent && ds.entities.contains(e.parent) ? e.parent.id : '';
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid).push(e);
    }
    const build = (pid) => {
      const list = byParent.get(pid) || [];
      const rows = list.slice(0, MAX_ROWS).map((e) => {
        const k = geo.kind(e);
        return row({
          key: 'e:' + e.id, label: (ICON[k] || '📁') + ' ' + (e.name || '(sin nombre)'), show: e.show,
          onShow: (v) => { e.show = v; },
          onOpen: () => { if (k) viewer.flyTo(e); if (OGE.editing()) OGE.select([e]); else viewer.selectedEntity = e; },
          kids: byParent.has(e.id) ? () => build(e.id) : null,
          buttons: [btn('✎', 'Propiedades: nombre, descripción y estilo', () => editProps(e)),
            btn('✕', 'Borrar', () => { const coll = e.entityCollection; OGE.run({ do: () => coll.remove(e), undo: () => coll.add(e) }); })],
        });
      });
      if (list.length > MAX_ROWS) rows.push(el('li', { className: 'small', textContent: `… y ${list.length - MAX_ROWS} más (ábrelos con 📋)` }));
      return rows;
    };
    return build('');
  }
  function renderTree() {
    const active = OGE.target();
    $('places').replaceChildren(...geo.groups().map((ds) => row({
      key: ds.name, label: `📂 ${ds.name} (${ds.entities.values.length})`, title: ds.name, show: ds.show,
      onShow: (v) => { ds.show = v; },
      onOpen: () => viewer.flyTo(ds),
      kids: ds.entities.values.length ? () => entityRows(ds) : null,
      buttons: [
        ...(ds.oge ? [btn('✏', ds === active ? 'Capa activa: aquí cae lo que dibujes' : 'Hacer activa: dibujar en esta capa', () => { OGE.setTarget(ds); renderTree(); save(); }, ds === active ? 'on' : '')] : []),
        btn('📋', 'Tabla de atributos', () => table(ds)),
        btn('💾', 'Guardar como: KMZ, KML, GeoJSON, Shapefile, GeoPackage, SVG o CSV', () => exportGroup(ds)),
        ...(ds === OGE.mine ? [] : [btn('✕', 'Quitar de Lugares', async () => { if (await OGE.confirm('¿Quitar «' + ds.name + '» de Lugares?', 'No se puede deshacer.')) viewer.dataSources.remove(ds, true); })]),
      ],
    })));
  }
  let rt;
  const later = () => { clearTimeout(rt); rt = setTimeout(renderTree, 60); };
  const watch = (ds) => { if (!ds.isLayer) ds.entities.collectionChanged.addEventListener(() => { ds._dirty = true; later(); save(); }); };
  geo.groups().forEach(watch);
  viewer.dataSources.dataSourceAdded.addEventListener((_, ds) => { watch(ds); later(); save(); });
  viewer.dataSources.dataSourceRemoved.addEventListener(() => { later(); save(); });
  $('newGroup').onclick = async () => {
    const v = await OGE.ask({ title: 'Nueva capa', fields: [{ id: 'name', label: 'Nombre', value: T('Capa nueva') }] });
    if (v && v.name.trim()) { OGE.setTarget(geo.addGroup(v.name.trim())); later(); }
  };

  // ---------- Icon library of a placemark (own drawings and system symbols; Google Earth's icons map to these) ----------
  const EMOJI = '🍴 ☕ 🍸 🍔 🚹 🚺 ♿ 🅿️ 🚕 🚌 🚚 🚆 ✈️ ⛴️ 🚁 🚇 🚊 ℹ️ ❓ 🚩 🌧️ 🌊 ❄️ ⚓ 🎣 ⛵ 🏊 ⛷️ 🌲 🔥 🧺 ⛺ 🏠 🚻 🥾 🚴 🏍️ 🏇 ⚽ ⛳ 🛍️ 🎬 🏪 🛒 🎭 🏡 📺 🔧 ⛽ 🏘️ 💇 💲 💶 💴 🚒 🏥 🛏️ 📞 ⚠️ 📈 ✉️ 👮 ☀️ ⛅ 🌋 📷 🎥 ⛰️ 🏛️ ⛪ 🕌 🏰 🎓 🏭 🌉'.split(' ');
  const ICONS = ['pin', 'pushpin', 'dot', 'paddle:', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ...'1 2 3 4 5 6 7 8 9 10'.split(' '), 'circle', 'diamond', 'square', 'star'].map((x, i) => (i < 4 ? x : 'paddle:' + x))
    .concat(['circle', 'square', 'diamond', 'star', 'triangle', 'target', 'cross', 'arrow'].map((x) => 'shape:' + x), EMOJI.map((x) => 'emoji:' + x));
  // Icons of Google Earth's own library (maps.google.com/mapfiles/kml/…) -> the open equivalent.
  const GCOL = { ylw: '#ffd400', blue: '#1e88e5', blu: '#1e88e5', grn: '#43a047', ltblu: '#4fc3f7', pink: '#ec407a', purple: '#8e24aa', red: '#e53935', wht: '#ffffff', orange: '#fb8c00' };
  const GSHAPE = { dining: '🍴', coffee: '☕', bars: '🍸', snack_bar: '🍔', man: '🚹', woman: '🚺', wheel_chair_accessible: '♿', parking_lot: '🅿️', cabs: '🚕', bus: '🚌', truck: '🚚', rail: '🚆', airports: '✈️', ferry: '⛴️', heliport: '🚁',
    subway: '🚇', tram: '🚊', info: 'ℹ️', 'info-i': 'ℹ️', info_circle: 'ℹ️', flag: '🚩', rainy: '🌧️', water: '🌊', snowflake_simple: '❄️', marina: '⚓', fishing: '🎣', sailing: '⛵', swimming: '🏊', ski: '⛷️', parks: '🌲', campfire: '🔥',
    picnic: '🧺', campground: '⛺', ranger_station: '🏠', toilets: '🚻', hiker: '🥾', trail: '🥾', cycling: '🚴', motorcycling: '🏍️', horsebackriding: '🏇', play: '⚽', golf: '⛳', shopping: '🛍️', movies: '🎬', convenience: '🏪',
    grocery: '🛒', arts: '🎭', homegardenbusiness: '🏡', electronics: '📺', mechanic: '🔧', gas_stations: '⛽', realestate: '🏘️', salon: '💇', dollar: '💲', euro: '💶', yen: '💴', firedept: '🚒', hospitals: '🏥', lodging: '🛏️',
    phone: '📞', caution: '⚠️', earthquake: '📈', post_office: '✉️', police: '👮', sunny: '☀️', partly_cloudy: '⛅', volcano: '🌋', camera: '📷', webcam: '🎥', mountains: '⛰️', forbidden: '🚫' };
  const GFORM = { placemark_circle: 'circle', placemark_square: 'square', star: 'star', target: 'target', triangle: 'triangle', donut: 'circle', 'open-diamond': 'diamond', square: 'square', 'cross-hairs': 'cross', arrow: 'arrow', shaded_dot: 'circle', polygon: 'diamond' };
  function googleIcon(u) {
    const m = /mapfiles\/kml\/(pushpin|paddle|shapes|pal\d)\/([\w-]+?)(?:_maps|-lv)?\.png/i.exec(u);
    if (!m) return /maps\.google\.|gstatic\.com/.test(u) ? { marker: 'pin', color: '#e53935' } : null; // other hosts keep their own image
    const [, dir, n] = m, p = n.split('-');
    if (dir === 'pushpin') return { marker: 'pushpin', color: GCOL[p[0]] || '#ffd400' };
    if (dir === 'paddle') return p.length === 1 ? { marker: 'paddle:' + (GCOL[n] ? '' : n.toUpperCase()), color: GCOL[n] || '#e53935' }
      : { marker: 'paddle:' + ({ circle: 'circle', diamond: 'diamond', square: 'square', stars: 'star' }[p[1]] || ''), color: GCOL[p[0]] || '#e53935' };
    return GSHAPE[n] ? { marker: 'emoji:' + GSHAPE[n], color: '#ffffff' } : GFORM[n] ? { marker: 'shape:' + GFORM[n], color: '#ffd400' } : { marker: 'pin', color: '#e53935' };
  }
  function openIcons(ds) { // called on every KML that is opened
    for (const e of ds.entities.values) {
      const img = e.billboard && e.billboard.image && e.billboard.image.getValue(C.JulianDate.now()), st = img && googleIcon(String(img.url || img));
      if (st) geo.setStyle(e, { ...geo.getStyle(e), ...st, scale: 1 });
    }
  }
  let mk = 'pin'; // icon chosen in the dialog
  function drawIcons() {
    const color = $('pColor').value;
    $('pIcons').replaceChildren(...ICONS.map((id) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: id === mk ? 'active' : '', title: id });
      if (id === 'dot') b.textContent = '●'; else b.style.backgroundImage = `url(${geo.icon(id, color).toDataURL()})`;
      b.onclick = () => { mk = id; $('pIconUrl').value = ''; drawIcons(); $('pIcons').dispatchEvent(new Event('input', { bubbles: true })); };
      return b;
    }));
  }
  $('pColor').addEventListener('input', drawIcons);

  // ---------- Properties (like Earth's dialog): name, description and style, with preview ----------
  const dlg = $('props'), form = dlg.firstElementChild;
  function apply(e, v) {
    const k = geo.kind(e);
    e.name = v.name;
    e.description = v.desc || undefined;
    if (k === 'point' && e.billboard) { if (e.label) e.label.text = v.name; else if (v.name) e.label = new C.LabelGraphics(geo.pinLabel(v.name)); }
    if (k) geo.setStyle(e, v.style);
  }
  // Returns a promise: true if accepted. isNew: cancelling undoes the creation of the object.
  function editProps(e, isNew) {
    return new Promise((resolve) => {
      const k = geo.kind(e), f = k && geo.toFeature(e), s = k ? geo.getStyle(e) : {};
      const before = { name: e.name || '', desc: f ? f.oge.desc : '', style: s };
      const lineLike = k === 'line' || k === 'polygon';
      $('pTitle').textContent = isNew ? 'Nuevo: ' + (TYPE[k] || 'objeto') : 'Propiedades';
      $('pName').value = before.name; $('pDesc').value = before.desc;
      $('rStroke').hidden = !lineLike; $('rFill').hidden = k !== 'polygon'; $('rColor').hidden = k !== 'point'; $('rImg').hidden = k !== 'image';
      if (lineLike) { $('pStroke').value = s.stroke; $('pWidth').value = s.width; }
      if (k === 'polygon') { $('pFill').value = s.fill; $('pFillOp').value = Math.round(s.fillOpacity * 100); }
      if (k === 'point') { $('pColor').value = s.color; $('pScale').value = s.scale || 1; const u = (s.marker || '').startsWith('url:'); $('pIconUrl').value = u ? s.marker.slice(4) : ''; mk = u ? 'pin' : s.marker || 'pin'; drawIcons(); }
      if (k === 'image') { $('pUrl').value = /^data:/.test(s.url) ? '' : s.url; $('pOpacity').value = Math.round(s.opacity * 100); $('pRot').value = s.rotation; }
      const read = () => ({ name: $('pName').value, desc: $('pDesc').value, style: { ...s,
        ...(lineLike ? { stroke: $('pStroke').value, width: Math.max(0, +$('pWidth').value || 0) } : {}),
        ...(k === 'polygon' ? { fill: $('pFill').value, fillOpacity: $('pFillOp').value / 100 } : {}),
        ...(k === 'point' ? { color: $('pColor').value, scale: Math.max(0.2, +$('pScale').value || 1), marker: $('pIconUrl').value.trim() ? 'url:' + $('pIconUrl').value.trim() : mk } : {}),
        ...(k === 'image' ? { url: $('pUrl').value.trim() || s.url, opacity: $('pOpacity').value / 100, rotation: +$('pRot').value || 0 } : {}) } });
      form.oninput = (ev) => { if (ev.target.id !== 'pUrl' && ev.target.id !== 'pIconUrl') apply(e, read()); }; // the URL is applied on accept, not on every keystroke
      let settled = false;
      const finish = (okd) => { // on the submit or cancel itself, without relying on the "close" event
        if (settled) return;
        settled = true;
        form.oninput = null;
        const after = read();
        apply(e, before);
        if (okd) OGE.run({ do: () => apply(e, after), undo: () => apply(e, before) });
        else if (isNew) OGE.undo();
        if (dlg.open) dlg.close();
        later();
        resolve(okd);
      };
      form.onsubmit = (ev) => { ev.preventDefault(); finish(true); }; // Enter or "OK"
      $('pCancel').onclick = () => finish(false);
      dlg.oncancel = () => finish(false); // Esc
      dlg.showModal();
      $('pName').select();
    });
  }

  // ---------- Attribute table ----------
  function table(ds) {
    const fs = geo.features(ds), keys = [...new Set(fs.flatMap((f) => Object.keys(f.properties)))];
    OGE.showTable('Atributos de ' + ds.name, ['nombre', 'tipo', ...keys], fs.map((f) => [f.oge.name, TYPE[f.oge.kind], ...keys.map((k) => f.properties[k])]), {
      note: 'Clic en una fila para ir al objeto.',
      onRow: (i) => { $('table').close(); viewer.flyTo(fs[i].entity); OGE.setEdit(true); OGE.select([fs[i].entity]); },
    });
  }

  // ---------- Opening files ----------
  const feat = (geometry, name, properties = {}) => ({ type: 'Feature', geometry, properties: { ...properties, ...(name ? { name } : {}) } });
  function parseGpx(text) {
    const x = new DOMParser().parseFromString(text, 'application/xml'), out = [];
    const pt = (n) => [parseFloat(n.getAttribute('lon')), parseFloat(n.getAttribute('lat'))];
    const child = (n, tag) => { for (const c of n.children) if (c.localName === tag) return c.textContent.trim(); return ''; };
    x.querySelectorAll('wpt').forEach((w) => out.push(feat({ type: 'Point', coordinates: pt(w) }, child(w, 'name'), child(w, 'ele') ? { ele: +child(w, 'ele') } : {})));
    x.querySelectorAll('trk').forEach((t) => t.querySelectorAll('trkseg').forEach((s) => out.push(feat({ type: 'LineString', coordinates: [...s.querySelectorAll('trkpt')].map(pt) }, child(t, 'name')))));
    x.querySelectorAll('rte').forEach((r) => out.push(feat({ type: 'LineString', coordinates: [...r.querySelectorAll('rtept')].map(pt) }, child(r, 'name'))));
    return out;
  }
  function parseCsv(text) { // rows of cells; separator , ; or tab, and double quotes
    const head = text.slice(0, text.indexOf('\n') + 1 || text.length), d = head.includes(';') ? ';' : head.includes('\t') ? '\t' : ',';
    const rows = [];
    let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch !== '"') cur += ch; else if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else if (ch === '"') q = true;
      else if (ch === d) { row.push(cur); cur = ''; }
      else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (ch !== '\r') cur += ch;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }
  function csvPoints(text) {
    const rows = parseCsv(text.replace(/^﻿/, '')), head = (rows.shift() || []).map((h) => h.trim());
    const ix = (re) => head.findIndex((h) => re.test(h));
    const la = ix(/^(lat|latitude|latitud|y)$/i), lo = ix(/^(lon|lng|long|longitude|longitud|x)$/i);
    if (la < 0 || lo < 0) throw new Error('el CSV necesita columnas de latitud y longitud (lat/lon, latitud/longitud o y/x)');
    const num = (s) => Number(String(s).trim().replace(',', '.'));
    return rows.filter((r) => r.length > Math.max(la, lo) && r[la] !== '' && Number.isFinite(num(r[la])) && Number.isFinite(num(r[lo]))).map((r) => {
      const p = {};
      head.forEach((h, i) => { if (i !== la && i !== lo && h) p[h] = r[i] !== '' && !Number.isNaN(Number(r[i])) ? Number(r[i]) : r[i]; });
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [num(r[lo]), num(r[la])] }, properties: p };
    });
  }
  const toFeatures = (g) => (!g ? [] : Array.isArray(g) ? g.flatMap(toFeatures) : g.type === 'FeatureCollection' ? g.features.filter((f) => f && f.geometry)
    : g.type === 'Feature' ? (g.geometry ? [g] : []) : g.coordinates || g.geometries ? [{ type: 'Feature', geometry: g, properties: {} }] : []);
  async function openFile(file) {
    const ext = file.name.split('.').pop().toLowerCase(), base = file.name.replace(/\.[^.]+$/, '');
    let ds;
    if (ext === 'svg') return OGE.importSvg(file);
    if (ext === 'gpkg') { const ls = await OGE.db.open(file); viewer.flyTo(ls[0]); ls.forEach((d) => expanded.add(d.name)); return later(); }
    if (ext === 'kml' || ext === 'kmz') {
      ds = await C.KmlDataSource.load(file, { camera: viewer.scene.camera, canvas: viewer.scene.canvas, clampToGround: true });
      ds.name = ds.name || base;
      openIcons(ds);
      for (const e of ds.entities.values) { // everything at height 0: snapping and topology compare positions
        const k = geo.kind(e);
        if (k && k !== 'image') geo.setRings(e, geo.rings(e).map((r) => r.map(geo.flat)));
      }
      ds._blob = file; // if unchanged, the original file is saved, with all its fidelity
      ds._dirty = false;
      await viewer.dataSources.add(ds);
    } else {
      let fs;
      if (ext === 'gpx') fs = parseGpx(await file.text());
      else if (ext === 'csv') fs = csvPoints(await file.text());
      else if (ext === 'zip') fs = toFeatures(await shp(await file.arrayBuffer()));
      else if (ext === 'shp') fs = shp.parseShp(await file.arrayBuffer()).map((g) => ({ type: 'Feature', geometry: g, properties: {} }));
      else fs = toFeatures(JSON.parse(await file.text()));
      if (!fs.length) throw new Error('no contiene geometrías reconocibles');
      if (fs.length > 3000) OGE.toast(`Cargando ${fs.length} objetos; puede tardar…`);
      ds = geo.addGroup(base, fs, { style: { marker: fs.length > 150 ? 'dot' : 'pin' } });
    }
    viewer.flyTo(ds);
    expanded.add(ds.name);
    later();
  }
  async function openFiles(files) {
    for (const f of files) {
      try { await openFile(f); } catch (err) { OGE.toast('No se pudo abrir ' + f.name + ': ' + err.message, true); }
    }
  }
  $('open').onchange = (e) => { openFiles([...e.target.files]); e.target.value = ''; };
  document.body.ondragover = (e) => e.preventDefault(); // drag and drop files onto the window
  document.body.ondrop = (e) => { e.preventDefault(); openFiles([...e.dataTransfer.files]); };

  // ---------- Exporting a layer ----------
  const kmz = async (ds) => (await C.exportKml({ entities: ds.entities, kmz: true })).kmz;
  async function exportGroup(ds) {
    const v = await OGE.ask({ title: 'Guardar «' + ds.name + '» como…', ok: 'Guardar', fields: [{ id: 'fmt', label: 'Formato', type: 'select', options: [
      ['kmz', 'KMZ (Google Earth; incluye imágenes, no atributos)'], ['kml', 'KML (Google Earth; sin imágenes locales ni atributos)'],
      ['geojson', 'GeoJSON (QGIS/ArcGIS; con atributos y estilo)'], ['shp', 'Shapefile (.zip; un archivo por tipo de geometría, con atributos)'], ['gpkg', 'GeoPackage (.gpkg; base de datos SQLite que abre QGIS, con atributos)'], ['svg', 'SVG vectorial (solo esta capa; para Inkscape)'], ['csv', 'CSV (tabla de atributos con geometría WKT)']] }] });
    if (!v) return;
    const name = ds.name.replace(/[\\/:*?"<>|]+/g, '_');
    try {
      if (v.fmt === 'kmz') OGE.download(name + '.kmz', await kmz(ds), 'application/vnd.google-earth.kmz');
      else if (v.fmt === 'kml') OGE.download(name + '.kml', (await C.exportKml({ entities: ds.entities })).kml, 'application/vnd.google-earth.kml+xml');
      else if (v.fmt === 'geojson') OGE.download(name + '.geojson', JSON.stringify(geo.exportFC(ds)), 'application/geo+json');
      else if (v.fmt === 'gpkg') OGE.download(name + '.gpkg', await OGE.db.save(ds));
      else if (v.fmt === 'svg') { // this layer only: the others are hidden for a moment to reuse the map exporter
        const others = geo.groups().filter((d) => d !== ds && d.show), was = ds.show;
        others.forEach((d) => { d.show = false; }); ds.show = true;
        try { OGE.download(name + '.svg', OGE.svgMap(ds.name, false), 'image/svg+xml'); } finally { others.forEach((d) => { d.show = true; }); ds.show = was; }
      }
      else if (v.fmt === 'shp') { // shortcut: field names are cut to 10 characters (DBF format limit) and the style is not saved
        const fc = geo.exportFC(ds);
        const utf8 = (t) => unescape(encodeURIComponent(t)); // the library writes one byte per character: this way the DBF ends up in UTF-8 (accents and ñ)
        for (const f of fc.features) {
          for (const k of ['stroke', 'stroke-width', 'stroke-opacity', 'fill', 'fill-opacity', 'marker-color']) delete f.properties[k];
          f.properties = Object.fromEntries(Object.entries(f.properties).map(([k, v]) => [utf8(k), typeof v === 'string' ? utf8(v) : v]));
        }
        if (!fc.features.length) throw new Error('la capa no tiene geometrías');
        OGE.download(name + '.zip', await shpwrite.zip(fc, { outputType: 'blob', compression: 'DEFLATE', filename: name, folder: name }), 'application/zip');
      }
      else {
        const fs = geo.features(ds).filter((f) => f.oge.kind !== 'image'), keys = [...new Set(fs.flatMap((f) => Object.keys(f.properties)))];
        OGE.download(name + '.csv', OGE.csv(['nombre', ...keys, 'wkt'], fs.map((f) => [f.oge.name, ...keys.map((k) => f.properties[k]), geo.wkt(f.geometry)])), 'text/csv');
      }
    } catch (err) { OGE.toast('No se pudo exportar: ' + err.message, true); }
  }
  OGE.saveKmz = async (ds) => OGE.download(ds.name + '.kmz', await kmz(ds));

  // ---------- Autosave between sessions (IndexedDB) ----------
  // Own layers: GeoJSON with style and attributes. Opened KMLs: the original file, or a re-exported KMZ if they were edited.
  const DB = new Promise((okd, ko) => {
    const r = indexedDB.open('opengisearth', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => okd(r.result);
    r.onerror = () => ko(r.error);
  });
  const idb = async (mode, fn) => {
    const db = await DB;
    return new Promise((okd, ko) => { const t = db.transaction('kv', mode), q = fn(t.objectStore('kv')); t.oncomplete = () => okd(q && q.result); t.onerror = () => ko(t.error); });
  };
  const NOSAVE = location.search.includes('nosave'); // test tabs: they do not overwrite what is saved
  let restoring = true, st;
  function save() {
    if (restoring || NOSAVE) return;
    clearTimeout(st);
    st = setTimeout(async () => {
      try {
        const recs = [];
        for (const ds of geo.groups()) {
          const rec = { name: ds.name, show: ds.show, active: ds === OGE.target() };
          if (ds.oge) rec.features = geo.features(ds);
          else {
            if (ds._dirty || !ds._blob) {
              try { ds._blob = await kmz(ds); }
              catch { ds._blob = new Blob([(await C.exportKml({ entities: ds.entities })).kml]); } // remote image without CORS: stays as a link
              ds._dirty = false;
            }
            rec.blob = ds._blob;
          }
          recs.push(rec);
        }
        await idb('readwrite', (s) => s.put(recs, 'places'));
      } catch (e) { console.error('No se pudieron guardar los lugares', e); }
    }, 1000);
  }
  OGE.onChange(save);
  async function restore() {
    try {
      const recs = (await idb('readonly', (s) => s.get('places'))) || [];
      for (const r of recs) {
        let ds;
        if (r.features) {
          if (r.name === OGE.mine.name) { ds = OGE.mine; for (const f of r.features) for (const o of geo.fromFeature(f)) ds.entities.add(o); }
          else ds = geo.addGroup(r.name, r.features);
        } else if (r.blob) {
          const kml = await C.KmlDataSource.load(r.blob, { camera: viewer.scene.camera, canvas: viewer.scene.canvas, clampToGround: true });
          openIcons(kml);
          if (r.name === OGE.mine.name) { // previous format: drawings were saved as KMZ
            ds = OGE.mine;
            for (const f of kml.entities.values.map(geo.toFeature).filter(Boolean)) for (const o of geo.fromFeature(f)) ds.entities.add(o);
          } else { ds = kml; ds.name = r.name; ds._blob = r.blob; await viewer.dataSources.add(ds); ds._dirty = false; }
        }
        if (!ds) continue;
        ds.show = r.show !== false;
        if (r.active && ds.oge) OGE.setTarget(ds);
      }
    } catch (e) {
      console.error('No se pudieron recuperar los lugares guardados', e);
    }
    setTimeout(() => { restoring = false; renderTree(); }, 300); // after the layer-added notices
  }

  Object.assign(OGE, { renderTree, editProps, openFiles, flushSave: () => { restoring = false; save(); } });
  restore();
})();
