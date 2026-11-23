// OpenStreetMap streets, cities and regional boundaries as a transparent vector layer over the satellite imagery (Earth style).
// Reads the official OSM vector tiles (Shortbread schema, MVT format) and draws them on one canvas per tile.
(() => {
  const C = Cesium, { viewer, $ } = OGE;
  const URL_MVT = 'https://vector.openstreetmap.org/shortbread_v1/';
  const MAXZ = 14, TS = 512;

  // ---------- Minimal MVT decoder (protobuf): { layer: [{ type, props, geom: [[[x, y], …], …] }] } ----------
  function decode(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(buf), td = new TextDecoder();
    let pos = 0;
    const varint = () => { let v = 0, s = 1, b; do { b = u8[pos++]; v += (b & 0x7f) * s; s *= 128; } while (b & 0x80); return v; };
    const zz = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);
    const skip = (wt) => { if (wt === 0) varint(); else if (wt === 1) pos += 8; else if (wt === 2) pos += varint(); else if (wt === 5) pos += 4; };
    const str = () => { const n = varint(), s = td.decode(u8.subarray(pos, pos + n)); pos += n; return s; };
    function value(end) {
      let v = null;
      while (pos < end) {
        const tag = varint(), f = tag >> 3;
        if (f === 1) v = str();
        else if (f === 2) { v = dv.getFloat32(pos, true); pos += 4; } else if (f === 3) { v = dv.getFloat64(pos, true); pos += 8; }
        else if (f === 4 || f === 5) v = varint();
        else if (f === 6) v = zz(varint());
        else if (f === 7) v = !!varint();
        else skip(tag & 7);
      }
      return v;
    }
    function feature(end) {
      const ft = { type: 0, props: {}, geom: [] };
      let tags = [], g = [];
      while (pos < end) {
        const tag = varint(), f = tag >> 3;
        if (f === 2) { const len = varint(), e = pos + len; tags = []; while (pos < e) tags.push(varint()); }
        else if (f === 3) ft.type = varint();
        else if (f === 4) { const len = varint(), e = pos + len; g = []; while (pos < e) g.push(varint()); }
        else skip(tag & 7);
      }
      ft.tags = tags; // keys and values may come later in the layer: they are resolved at the end
      let x = 0, y = 0, ring = null;
      for (let i = 0; i < g.length;) {
        const cmd = g[i] & 7, cnt = g[i] >> 3;
        i++;
        if (cmd === 7) { if (ring) ring.push(ring[0]); continue; }
        for (let k = 0; k < cnt; k++) {
          x += zz(g[i++]); y += zz(g[i++]);
          if (cmd === 1) { ring = [[x, y]]; ft.geom.push(ring); } else ring.push([x, y]);
        }
      }
      return ft;
    }
    const layers = {};
    while (pos < u8.length) {
      const tag = varint();
      if (tag >> 3 !== 3) { skip(tag & 7); continue; }
      const size = varint(), end = pos + size, keys = [], values = [], feats = [];
      let name = '';
      while (pos < end) {
        const t = varint(), f = t >> 3;
        if (f === 1) name = str();
        else if (f === 2) { const len = varint(), e = pos + len; feats.push(feature(e)); pos = e; }
        else if (f === 3) keys.push(str());
        else if (f === 4) { const len = varint(), e = pos + len; values.push(value(e)); pos = e; }
        else skip(t & 7);
      }
      for (const ft of feats) { for (let i = 0; i < ft.tags.length; i += 2) ft.props[keys[ft.tags[i]]] = values[ft.tags[i + 1]]; delete ft.tags; }
      layers[name] = feats;
    }
    return layers;
  }
  // Tile source with LRU cache: urlOf(z, x, y) may be asynchronous. Returns Promise<layers | null>.
  function source(urlOf) {
    const cache = new Map();
    return (z, x, y) => {
      const key = z + '/' + x + '/' + y;
      let p = cache.get(key);
      if (p) { cache.delete(key); cache.set(key, p); return p; }
      if (cache.size > 120) cache.delete(cache.keys().next().value);
      p = Promise.resolve(urlOf(z, x, y)).then((u) => fetch(u)).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b && b.byteLength ? decode(b) : null));
      p.catch(() => cache.delete(key));
      cache.set(key, p);
      return p;
    };
  }
  const tile = source((z, x, y) => `${URL_MVT}${z}/${x}/${y}.mvt`);
  // OpenFreeMap (OpenMapTiles schema): named parks and buildings with height. Its URL changes with every weekly release: it is read from the TileJSON.
  let ofmTpl = null;
  const ofmTile = source(async (z, x, y) => {
    if (!ofmTpl) { ofmTpl = fetch('https://tiles.openfreemap.org/planet').then((r) => r.json()).then((j) => j.tiles[0]); ofmTpl.catch(() => { ofmTpl = null; }); }
    return (await ofmTpl).replace('{z}', z).replace('{x}', x).replace('{y}', y);
  });
  const lonLat = (z, x, y, px, py) => { const n = 2 ** z, fx = x + px / 4096, fy = y + py / 4096; return [(fx / n) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * fy) / n))) * 180) / Math.PI]; };

  // ---------- Style: [minimum level, width px, color] per road type ----------
  const ROAD = {
    motorway: [4, 3.2, '#ffa726'], trunk: [5, 2.8, '#ffb74d'], primary: [7, 2.4, '#ffd54f'], secondary: [8, 2, '#ffe082'],
    tertiary: [10, 1.6, '#ffffff'], unclassified: [11, 1.2, '#f2f2f2'], residential: [12, 1.2, '#f2f2f2'], living_street: [12, 1.1, '#f2f2f2'],
    pedestrian: [13, 1, '#e0e0e0'], service: [13, 0.8, '#e0e0e0'], track: [13, 0.8, '#d7ccc8'], rail: [9, 1.2, '#b0bec5'],
  };
  const PLACE = { // [minimum level, size px, style]
    capital: [3, 15, '700'], state_capital: [4, 14, '700'], city: [5, 14, '700'], town: [8, 13, '600'], village: [10, 12, '600'],
    suburb: [10, 12, 'italic 600'], island: [9, 12, 'italic 600'], hamlet: [12, 11, '600'], quarter: [12, 11, 'italic 600'], neighbourhood: [13, 11, 'italic 600'],
  };
  const font = (px, style) => `${style} ${px}px sans-serif`;
  const inside = (x, y, w, h) => [Math.max(w / 2 + 3, Math.min(TS - w / 2 - 3, x)), Math.max(h / 2 + 3, Math.min(TS - h / 2 - 3, y))]; // the canvas does not paint outside its tile

  function draw(ctx, layers, level, k, ox, oy) {
    const X = (p) => p[0] * k - ox, Y = (p) => p[1] * k - oy;
    const stroke = (geom, width, color, dash) => {
      ctx.beginPath();
      for (const line of geom) { ctx.moveTo(X(line[0]), Y(line[0])); for (let i = 1; i < line.length; i++) ctx.lineTo(X(line[i]), Y(line[i])); }
      ctx.lineWidth = width; ctx.strokeStyle = color; ctx.setLineDash(dash || []); ctx.stroke();
    };
    ctx.lineJoin = ctx.lineCap = 'round';
    // Regional boundaries (admin_level 4): the international ones are already drawn by the borders layer
    for (const f of layers.boundaries || []) if (f.props.admin_level === 4 && !f.props.maritime) stroke(f.geom, 1.3, 'rgba(255,255,255,.75)', [6, 4]);
    // Roads: minor ones first; each with a dark casing so it reads over the satellite imagery
    const roads = (layers.streets || []).map((f) => [f, ROAD[f.props.rail ? 'rail' : f.props.kind]]).filter(([, s]) => s && level >= s[0]).sort((a, b) => a[1][1] - b[1][1]);
    for (const [f, s] of roads) stroke(f.geom, s[1] + 1.6, 'rgba(0,0,0,.45)');
    for (const [f, s] of roads) stroke(f.geom, s[1], f.props.tunnel ? 'rgba(255,255,255,.35)' : s[2], f.props.rail ? [5, 4] : null);

    // Labels with halo; overlaps within the tile are avoided
    const boxes = [];
    const free = (x, y, w, h) => { const b = [x - w / 2 - 2, y - h / 2 - 2, x + w / 2 + 2, y + h / 2 + 2]; if (boxes.some((o) => b[0] < o[2] && o[0] < b[2] && b[1] < o[3] && o[1] < b[3])) return false; boxes.push(b); return true; };
    const text = (t, x, y, angle, color) => {
      ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.strokeText(t, 0, 0);
      ctx.fillStyle = color; ctx.fillText(t, 0, 0); ctx.restore();
    };
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.setLineDash([]);
    const places = (layers.place_labels || []).filter((f) => f.props.name && PLACE[f.props.kind] && level >= PLACE[f.props.kind][0]).sort((a, b) => (b.props.population || 0) - (a.props.population || 0));
    for (const f of places) {
      const s = PLACE[f.props.kind], x = X(f.geom[0][0]), y = Y(f.geom[0][0]);
      ctx.font = font(s[1], s[2]);
      const w = ctx.measureText(f.props.name).width;
      if (x < 0 || x > TS || y < 0 || y > TS) continue;
      const [lx, ly] = inside(x, y, w, s[1]);
      if (!free(lx, ly, w, s[1])) continue;
      text(f.props.name, lx, ly, 0, '#fff');
    }
    for (const f of layers.boundary_labels || []) { // names of regions/states
      if (f.props.admin_level !== 4 || !f.props.name || level < 4 || level > 8) continue;
      const x = X(f.geom[0][0]), y = Y(f.geom[0][0]);
      ctx.font = font(12, 'italic 600');
      const w = ctx.measureText(f.props.name).width;
      if (x < 0 || x > TS || y < 0 || y > TS) continue;
      const [lx, ly] = inside(x, y, w * 1.15, 12);
      if (!free(lx, ly, w * 1.15, 12)) continue;
      text(f.props.name.toUpperCase(), lx, ly, 0, '#ffe9a8');
    }
    ctx.font = font(11, '600');
    for (const f of layers.street_labels || []) { // street name following its longest stretch
      const s = ROAD[f.props.kind], name = f.props.name || f.props.ref;
      if (!name || !s || level < s[0] + 2) continue;
      const line = f.geom[0];
      let best = null, bl = 0;
      for (let i = 1; i < line.length; i++) { const l = Math.hypot(X(line[i]) - X(line[i - 1]), Y(line[i]) - Y(line[i - 1])); if (l > bl) { bl = l; best = i; } }
      const w = ctx.measureText(name).width;
      if (!best || bl < w * 0.6) continue;
      const a = line[best - 1], b = line[best], x = (X(a) + X(b)) / 2, y = (Y(a) + Y(b)) / 2;
      if (x < w / 2 || x > TS - w / 2 || y < w / 2 || y > TS - w / 2 || !free(x, y, w, w)) continue; // entirely inside the tile; square box because it is rotated
      let ang = Math.atan2(Y(b) - Y(a), X(b) - X(a));
      if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI; // never upside down
      text(name, x, y, ang, '#fff');
    }
  }

  // National parks and protected areas (OpenFreeMap "park" layer): green area, outline and name.
  function drawParks(ctx, layers, level, k, ox, oy) {
    const X = (p) => p[0] * k - ox, Y = (p) => p[1] * k - oy, labels = [];
    for (const f of layers.park || []) {
      const name = f.props[OGE_LANG === 'en' ? 'name:en' : 'name:es'] || f.props.name;
      if (f.type === 1) { if (name) labels.push([name, X(f.geom[0][0]), Y(f.geom[0][0])]); continue; }
      const national = /national_park|parque_nacional/.test(f.props.class || '');
      ctx.beginPath();
      for (const ring of f.geom) { ctx.moveTo(X(ring[0]), Y(ring[0])); for (let i = 1; i < ring.length; i++) ctx.lineTo(X(ring[i]), Y(ring[i])); ctx.closePath(); }
      ctx.fillStyle = national ? 'rgba(46,160,67,.30)' : 'rgba(102,187,106,.16)'; ctx.fill('evenodd');
      ctx.lineWidth = national ? 2 : 1; ctx.strokeStyle = national ? '#1b8a3a' : 'rgba(27,138,58,.6)'; ctx.stroke();
    }
    ctx.font = font(12, 'italic 600'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const used = [];
    for (const [t, x0, y0] of labels) {
      const w = ctx.measureText(t).width;
      if (x0 < 0 || x0 > TS || y0 < 0 || y0 > TS || w > TS - 8) continue;
      const [x, y] = inside(x0, y0, w, 14);
      if (used.some((o) => Math.abs(o[0] - x) < (o[2] + w) / 2 + 4 && Math.abs(o[1] - y) < 16)) continue;
      used.push([x, y, w]);
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.strokeText(t, x, y); ctx.fillStyle = '#b9f6ca'; ctx.fillText(t, x, y);
    }
  }

  // ---------- Imagery provider for Cesium: one canvas per tile ----------
  const scheme = new C.WebMercatorTilingScheme();
  const provider = (src, drawFn, credit, minLevel) => ({
    tilingScheme: scheme, rectangle: scheme.rectangle, tileWidth: TS, tileHeight: TS, minimumLevel: 0, maximumLevel: 17,
    hasAlphaChannel: true, errorEvent: new C.Event(), credit: new C.Credit(credit), tileDiscardPolicy: undefined, proxy: undefined,
    getTileCredits: () => undefined, pickFeatures: () => undefined,
    requestImage(x, y, level) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = TS;
      if (level < minLevel) return Promise.resolve(cv);
      const dz = Math.max(0, level - MAXZ), sub = 2 ** dz; // beyond zoom 14 the data tile is enlarged
      return src(level - dz, Math.floor(x / sub), Math.floor(y / sub)).then((layers) => {
        if (layers) drawFn(cv.getContext('2d'), layers, level, (TS / 4096) * sub, (x % sub) * TS, (y % sub) * TS);
        return cv;
      }).catch(() => cv);
    },
  });
  function toggle(cb, make) { // the layer is created the first time it is switched on
    let layer = null;
    const sync = () => { if (cb.checked && !layer) layer = viewer.imageryLayers.addImageryProvider(make()); if (layer) layer.show = cb.checked; };
    cb.addEventListener('change', sync);
    sync();
  }
  toggle($('layerParks'), () => provider(ofmTile, drawParks, '© OpenStreetMap · teselas de OpenFreeMap', 4));
  toggle($('layerRoads'), () => provider(tile, draw, '© OpenStreetMap (teselas vectoriales)', 3));
  // ---------- Clouds: NASA's daily satellite image (GIBS, VIIRS true color), of which only the white is kept ----------
  // shortcut: snow and ice are also white and show up as cloud; there is no open cloud-only product with transparency.
  function cloudsProvider() {
    const day = new Date(Date.now() - 36 * 3600e3).toISOString().slice(0, 10); // yesterday's: today's is still being assembled
    return {
      tilingScheme: scheme, rectangle: scheme.rectangle, tileWidth: 256, tileHeight: 256, minimumLevel: 0, maximumLevel: 8,
      hasAlphaChannel: true, errorEvent: new C.Event(), credit: new C.Credit('Nubes: NASA GIBS, VIIRS NOAA-20 del ' + day), tileDiscardPolicy: undefined, proxy: undefined,
      getTileCredits: () => undefined, pickFeatures: () => undefined,
      async requestImage(x, y, level) {
        const cv = document.createElement('canvas');
        cv.width = cv.height = 256;
        try {
          const res = await fetch(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/${day}/GoogleMapsCompatible_Level9/${level}/${y}/${x}.jpg`);
          if (!res.ok) return cv;
          const bmp = await createImageBitmap(await res.blob()), ctx = cv.getContext('2d');
          ctx.drawImage(bmp, 0, 0);
          bmp.close();
          const img = ctx.getImageData(0, 0, 256, 256), p = img.data;
          for (let i = 0; i < p.length; i += 4) { // white, with opacity according to how light and unsaturated the pixel is
            p[i + 3] = Math.max(0, Math.min(255, (Math.min(p[i], p[i + 1], p[i + 2]) - 120) * 2.4));
            p[i] = p[i + 1] = p[i + 2] = 255;
          }
          ctx.putImageData(img, 0, 0);
        } catch { /* offline: empty tile */ }
        return cv;
      },
    };
  }
  let clouds = null;
  const syncClouds = () => { // as in Earth, the clouds fade out when approaching the ground
    const on = $('layerClouds').checked;
    if (on && !clouds) clouds = viewer.imageryLayers.addImageryProvider(cloudsProvider());
    if (clouds) { clouds.show = on; clouds.alpha = C.Math.clamp((viewer.camera.positionCartographic.height - 2e5) / 1.5e6, 0, 0.9); }
  };
  $('layerClouds').addEventListener('change', syncClouds);
  viewer.camera.changed.addEventListener(syncClouds);
  syncClouds();

  OGE.mvt = { tile, ofmTile, lonLat };
})();
