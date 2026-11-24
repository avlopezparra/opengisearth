// OpenGISEarth — geometry: Cesium entities ⇄ GeoJSON, styles and layers (Places groups).
// All positions are stored at height 0; the terrain is applied when drawing (clampToGround).
(() => {
  const C = Cesium, { viewer } = OGE;
  const now = () => viewer.clock.currentTime;
  const val = (p, d) => (p && p.getValue ? p.getValue(now()) : p) ?? d;
  const r9 = (v) => Math.round(v * 1e9) / 1e9; // ~0.1 mm: stabilizes the equality of shared vertices
  const toLL = (c) => { const k = C.Cartographic.fromCartesian(c); return [r9(C.Math.toDegrees(k.longitude)), r9(C.Math.toDegrees(k.latitude))]; };
  const fromLL = (ll) => C.Cartesian3.fromDegrees(ll[0], ll[1]);
  const flat = (c) => fromLL(toLL(c));
  const same = (a, b) => C.Cartesian3.equalsEpsilon(a, b, 0, 1e-3);
  const css = (hexColor, a = 1) => C.Color.fromCssColorString(hexColor || '#ffffff').withAlpha(a);
  const hex = (c) => c.withAlpha(1).toCssHexString();

  const DEF = { stroke: '#ffd400', strokeOpacity: 1, width: 3, fill: '#ffd400', fillOpacity: 0.35, color: '#e53935', marker: 'pin', scale: 1, opacity: 0.7, rotation: 0 };
  const NEAR = 5e5; // under 500 km it is not clipped against the terrain; from afar the globe does hide what is on the other side
  // names on a soft dark plate: the thin outline alone broke into speckles over bright imagery
  const labelStyle = (text) => ({ text, font: '600 14px sans-serif', fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 1,
    style: C.LabelStyle.FILL, showBackground: true, backgroundColor: C.Color.fromCssColorString('rgba(10,30,60,0.6)'), backgroundPadding: new C.Cartesian2(6, 3), heightReference: C.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: NEAR });
  const pinLabel = (text) => ({ ...labelStyle(text), pixelOffset: new C.Cartesian2(0, -44) });

  // ---------- Placemark icons: drawn here (open designs), in the placemark's color ----------
  // Ids: 'pin' · 'pushpin' · 'paddle:A' (any short text, or circle/diamond/square/star) · 'shape:star' · 'emoji:🍴' · 'url:https://…' · 'dot'
  const iconCache = new Map();
  function icon(id, color) {
    const key = id + '|' + color;
    if (iconCache.has(key)) return iconCache.get(key);
    const cv = Object.assign(document.createElement('canvas'), { width: 64, height: 64 }), g = cv.getContext('2d'), [type, arg = ''] = id.split(/:(.*)/);
    g.lineJoin = 'round'; g.lineWidth = 2.5; g.strokeStyle = 'rgba(0,0,0,.75)'; g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
    const done = () => { g.fill(); g.stroke(); };
    if (type === 'emoji') { g.font = '46px sans-serif'; g.fillText(arg, 32, 35); }
    else if (type === 'shape') {
      g.beginPath();
      if (arg === 'square') g.rect(11, 11, 42, 42);
      else if (arg === 'diamond') { g.moveTo(32, 7); g.lineTo(57, 32); g.lineTo(32, 57); g.lineTo(7, 32); g.closePath(); }
      else if (arg === 'triangle') { g.moveTo(32, 8); g.lineTo(58, 54); g.lineTo(6, 54); g.closePath(); }
      else if (arg === 'star') { for (let i = 0; i < 10; i++) { const r = i % 2 ? 11 : 27, a = (i * Math.PI) / 5 - Math.PI / 2; g.lineTo(32 + r * Math.cos(a), 34 + r * Math.sin(a)); } g.closePath(); }
      else if (arg === 'arrow') { g.moveTo(32, 5); g.lineTo(54, 30); g.lineTo(41, 30); g.lineTo(41, 58); g.lineTo(23, 58); g.lineTo(23, 30); g.lineTo(10, 30); g.closePath(); }
      else g.arc(32, 32, 23, 0, 7);
      done();
      if (arg === 'target') { g.fillStyle = '#fff'; g.beginPath(); g.arc(32, 32, 14, 0, 7); done(); g.fillStyle = color; g.beginPath(); g.arc(32, 32, 6, 0, 7); done(); }
      if (arg === 'cross') { g.strokeStyle = '#fff'; g.lineWidth = 5; g.beginPath(); g.moveTo(32, 16); g.lineTo(32, 48); g.moveTo(16, 32); g.lineTo(48, 32); g.stroke(); }
    } else if (type === 'pushpin') { // a tilted pin: needle and round head
      g.save(); g.strokeStyle = '#555'; g.lineWidth = 3; g.beginPath(); g.moveTo(24, 62); g.lineTo(36, 34); g.stroke(); g.restore();
      g.beginPath(); g.ellipse(38, 30, 15, 7, -0.35, 0, 7); done();
      g.beginPath(); g.arc(41, 19, 13, 0, 7); done();
      g.fillStyle = 'rgba(255,255,255,.55)'; g.beginPath(); g.arc(37, 14, 4.5, 0, 7); g.fill();
    } else { // teardrop: 'pin' (white dot) or 'paddle' (a letter, number or small shape)
      g.beginPath(); g.moveTo(32, 62); g.bezierCurveTo(6, 36, 9, 3, 32, 3); g.bezierCurveTo(55, 3, 58, 36, 32, 62); done();
      const glyph = { circle: '●', diamond: '◆', square: '■', star: '★' }[arg] ?? arg;
      if (type === 'paddle' && glyph) { g.fillStyle = '#111'; g.font = `700 ${glyph.length > 1 ? 19 : 25}px sans-serif`; g.fillText(glyph, 32, 27); }
      else { g.fillStyle = '#fff'; g.beginPath(); g.arc(32, 25, 8, 0, 7); g.fill(); }
    }
    cv._mk = { marker: id, color }; // getStyle reads the icon back from here
    iconCache.set(key, cv);
    return cv;
  }
  // Billboard options of a point style ({ marker, color, scale }).
  const pinGraphics = (st) => {
    const m = st.marker || 'pin', url = m.startsWith('url:'), bottom = /^(pin|pushpin|paddle)/.test(m);
    return { image: url ? m.slice(4) : icon(m, st.color), scale: (url ? 1 : 0.5) * (st.scale || 1), verticalOrigin: bottom ? C.VerticalOrigin.BOTTOM : C.VerticalOrigin.CENTER,
      heightReference: C.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: NEAR };
  };

  // ---------- Type and geometry of an entity ----------
  const isImage = (e) => !!e.rectangle && e.rectangle.material instanceof C.ImageMaterialProperty;
  const kind = (e) => (e.polygon ? 'polygon' : isImage(e) ? 'image' : e.polyline ? 'line' : e.position && (e.billboard || e.point) ? 'point' : null);

  // Position rings: polygon [outer, ...holes] (without repeating the first vertex), line [positions], point [[position]].
  function rings(e) {
    if (e.polygon) {
      const h = val(e.polygon.hierarchy);
      if (!h || !h.positions) return [];
      return [h.positions, ...(h.holes || []).map((x) => x.positions)].map((r) => (r.length > 3 && same(r[0], r[r.length - 1]) ? r.slice(0, -1) : r.slice()));
    }
    if (e.polyline) return [(val(e.polyline.positions) || []).slice()];
    const p = val(e.position);
    return p ? [[p]] : [];
  }
  const center = (ps) => C.Ellipsoid.WGS84.scaleToGeodeticSurface(C.BoundingSphere.fromPoints(ps).center) || ps[0];
  function setRings(e, rs) {
    e._bs = null;
    if (e.polygon) {
      e.polygon.hierarchy = new C.PolygonHierarchy(rs[0], rs.slice(1).map((p) => new C.PolygonHierarchy(p)));
      if (e.polyline) e.polyline.positions = [...rs[0], rs[0][0]]; // the outline follows the fill
      if (e.position) e.position = center(rs[0]);
    } else if (e.polyline) {
      e.polyline.positions = rs[0];
      if (e.position) e.position = center(rs[0]);
    } else e.position = rs[0][0];
  }
  // Cached bounding sphere to quickly discard distant objects (invalidated in setRings).
  const sphere = (e) => e._bs || (e._bs = C.BoundingSphere.fromPoints(rings(e).flat()));

  // ---------- Style ----------
  const col = (p, d) => { const m = val(p); const c = m && (m.red !== undefined ? m : m.color); return c ? C.Color.clone(c) : css(d); };
  function getStyle(e) {
    const k = kind(e), s = {};
    if (k === 'polygon') {
      const f = col(e.polygon.material, DEF.fill), on = !!e.polyline && val(e.polyline.show, true);
      const c = on ? col(e.polyline.material, DEF.stroke) : f;
      Object.assign(s, { fill: hex(f), fillOpacity: f.alpha, stroke: hex(c), strokeOpacity: on ? c.alpha : 1, width: on ? val(e.polyline.width, 2) : 0 });
    } else if (k === 'line') {
      const c = col(e.polyline.material, DEF.stroke);
      Object.assign(s, { stroke: hex(c), strokeOpacity: c.alpha, width: val(e.polyline.width, 2) });
    } else if (k === 'point') {
      const img = e.billboard && val(e.billboard.image), mk = img && img._mk, url = typeof img === 'string' && !img.startsWith('data:image/svg') ? img : null;
      s.marker = !e.billboard ? 'dot' : mk ? mk.marker : url ? 'url:' + url : 'pin';
      s.color = mk ? mk.color : hex(val(e.billboard ? e.billboard.color : e.point.color, C.Color.WHITE));
      s.scale = e.billboard ? +(val(e.billboard.scale, 1) / (url ? 1 : mk ? 0.5 : 1)).toFixed(2) : 1;
    } else if (k === 'image') {
      const m = val(e.rectangle.material) || {};
      s.opacity = m.color ? m.color.alpha : 1;
      s.url = typeof m.image === 'string' ? m.image : (m.image && (m.image.url || m.image.src)) || '';
      s.rotation = Math.round(C.Math.toDegrees(val(e.rectangle.rotation, 0)) * 100) / 100;
    }
    return s;
  }
  function setStyle(e, s) {
    const k = kind(e);
    if (k === 'polygon') {
      e.polygon.material = css(s.fill, s.fillOpacity);
      if (s.width > 0) {
        if (!e.polyline) { const r = rings(e)[0]; e.polyline = new C.PolylineGraphics({ positions: [...r, r[0]], clampToGround: true }); }
        e.polyline.material = css(s.stroke, s.strokeOpacity); e.polyline.width = s.width; e.polyline.show = true;
      } else if (e.polyline) e.polyline.show = false;
    } else if (k === 'line') {
      e.polyline.material = css(s.stroke, s.strokeOpacity); e.polyline.width = s.width || 1;
    } else if (k === 'point') {
      if (s.marker === 'dot') { // a plain dot is a point graphic; every other icon is a billboard
        e.billboard = undefined;
        e.point = new C.PointGraphics({ pixelSize: 8, color: css(s.color), outlineColor: C.Color.BLACK, outlineWidth: 1, heightReference: C.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: NEAR });
      } else { e.point = undefined; e.billboard = new C.BillboardGraphics(pinGraphics(s)); }
    } else if (k === 'image') {
      const color = C.Color.WHITE.withAlpha(s.opacity ?? 1);
      if (s.url && s.url !== getStyle(e).url) e.rectangle.material = new C.ImageMaterialProperty({ image: s.url, transparent: true, color });
      else e.rectangle.material.color = color;
      e.rectangle.rotation = e.rectangle.stRotation = C.Math.toRadians(s.rotation || 0);
    }
  }

  // ---------- Entity → GeoJSON Feature ----------
  const dedupe = (r) => r.filter((c, i) => i === 0 || c[0] !== r[i - 1][0] || c[1] !== r[i - 1][1]);
  function props(e) {
    const p = e.properties ? { ...e.properties.getValue(now()) } : {};
    const x = e.kml && e.kml.extendedData; // attributes of a KML (ExtendedData)
    if (x) for (const k in x) if (!(k in p)) p[k] = x[k].value;
    return p;
  }
  function desc(e) { // Cesium wraps the description when reading KML: the original text is returned
    const d = val(e.description, '');
    const m = typeof d === 'string' && d.match(/^<div class="cesium-infoBox-description-lighter"[^>]*>([\s\S]*)<\/div>$/);
    return m ? m[1] : d || '';
  }
  // The Feature carries in "oge" what GeoJSON lacks (name, style, type) and, unserialized, the source entity.
  function toFeature(e) {
    const k = kind(e);
    if (!k) return null;
    let geometry;
    if (k === 'image') {
      const r = val(e.rectangle.coordinates);
      const [w, s, ea, n] = [r.west, r.south, r.east, r.north].map((v) => r9(C.Math.toDegrees(v)));
      geometry = { type: 'Polygon', coordinates: [[[w, s], [ea, s], [ea, n], [w, n], [w, s]]] };
    } else {
      const rs = rings(e).map((r) => dedupe(r.map(toLL)));
      if (!rs.length) return null;
      if (k === 'point') geometry = { type: 'Point', coordinates: rs[0][0] };
      else if (k === 'line') { if (rs[0].length < 2) return null; geometry = { type: 'LineString', coordinates: rs[0] }; }
      else { if (rs[0].length < 3) return null; geometry = { type: 'Polygon', coordinates: rs.filter((r) => r.length >= 3).map((r) => [...r, r[0]]) }; }
    }
    const f = { type: 'Feature', geometry, properties: props(e), oge: { kind: k, name: e.name || '', desc: desc(e), show: e.show, style: getStyle(e) } };
    if (e.label) { const t = val(e.label.text, ''); if (k !== 'point' || t !== (e.name || '')) f.oge.label = t; } // label different from the name
    Object.defineProperty(f, 'entity', { value: e });
    return f;
  }

  // ---------- GeoJSON Feature → entity options (one per simple part) ----------
  function parts(g) {
    if (!g) return [];
    switch (g.type) {
      case 'Point': case 'LineString': case 'Polygon': return [g];
      case 'MultiPoint': return g.coordinates.map((c) => ({ type: 'Point', coordinates: c }));
      case 'MultiLineString': return g.coordinates.map((c) => ({ type: 'LineString', coordinates: c }));
      case 'MultiPolygon': return g.coordinates.map((c) => ({ type: 'Polygon', coordinates: c }));
      case 'GeometryCollection': return g.geometries.flatMap(parts);
      default: return [];
    }
  }
  const ok = (c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]);
  const path = (cs, closed) => { // coordinates → positions without duplicates (and without the closing vertex if it is a ring)
    const o = [];
    for (const c of cs) { if (!ok(c)) continue; const p = fromLL(c); if (!o.length || !same(o[o.length - 1], p)) o.push(p); }
    if (closed && o.length > 1 && same(o[0], o[o.length - 1])) o.pop();
    return o;
  };
  const SIMPLE = { stroke: 'stroke', 'stroke-width': 'width', 'stroke-opacity': 'strokeOpacity', fill: 'fill', 'fill-opacity': 'fillOpacity', 'marker-color': 'color' };
  // base: default { name, style } for whatever the Feature does not provide.
  function fromFeature(f, base = {}) {
    const o = f.oge || {}, p = { ...(f.properties || {}) }, ext = {};
    if (!f.oge) { // external GeoJSON: name, description and simplestyle style come from the properties
      for (const k in SIMPLE) if (p[k] != null && p[k] !== '') { ext[SIMPLE[k]] = /width|opacity/.test(k) ? +p[k] : p[k]; delete p[k]; }
    }
    const first = (...ks) => { for (const k of ks) if (p[k] != null && p[k] !== '') { const v = String(p[k]); if (!f.oge) delete p[k]; return v; } };
    const name = o.name ?? first('name', 'title', 'Name', 'NAME', 'nombre', 'NOMBRE') ?? base.name ?? '';
    const description = (o.desc ?? first('description')) || undefined;
    const st = { ...DEF, ...base.style, ...ext, ...o.style };
    const gs = parts(f.geometry);
    return gs.map((g, i) => {
      const common = { name: gs.length > 1 && name ? `${name} ${i + 1}` : name, description, show: o.show !== false, properties: Object.keys(p).length ? p : undefined };
      if (o.kind === 'image') {
        const xs = g.coordinates[0].map((c) => c[0]), ys = g.coordinates[0].map((c) => c[1]), rot = C.Math.toRadians(st.rotation || 0);
        return { ...common, properties: undefined, rectangle: { coordinates: C.Rectangle.fromDegrees(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)),
          material: new C.ImageMaterialProperty({ image: st.url, transparent: true, color: C.Color.WHITE.withAlpha(st.opacity) }), rotation: rot, stRotation: rot } };
      }
      if (g.type === 'Point') {
        if (!ok(g.coordinates)) return null;
        const position = fromLL(g.coordinates);
        const text = o.label ?? common.name;
        if (st.marker === 'dot') return { ...common, position, point: { pixelSize: 8, color: css(st.color), outlineColor: C.Color.BLACK, outlineWidth: 1,
          heightReference: C.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: NEAR }, label: o.label ? labelStyle(o.label) : undefined };
        return { ...common, position, billboard: pinGraphics(st), label: text ? pinLabel(text) : undefined };
      }
      const labeled = (ps) => (o.label ? { position: center(ps), label: labelStyle(o.label) } : {});
      if (g.type === 'LineString') {
        const positions = path(g.coordinates, false);
        if (positions.length < 2) return null;
        return { ...common, ...labeled(positions), polyline: { positions, width: st.width || 2, material: css(st.stroke, st.strokeOpacity), clampToGround: true } };
      }
      const rs = g.coordinates.map((r) => path(r, true));
      if (!rs[0] || rs[0].length < 3) return null;
      return { ...common, ...labeled(rs[0]),
        polygon: { hierarchy: new C.PolygonHierarchy(rs[0], rs.slice(1).filter((r) => r.length >= 3).map((r) => new C.PolygonHierarchy(r))), material: css(st.fill, st.fillOpacity) },
        polyline: { positions: [...rs[0], rs[0][0]], width: st.width || 1, material: css(st.stroke, st.strokeOpacity), clampToGround: true, show: st.width > 0 } };
    }).filter(Boolean);
  }

  // ---------- Layers (Places groups) ----------
  const groups = () => { const out = []; for (let i = 0; i < viewer.dataSources.length; i++) { const d = viewer.dataSources.get(i); if (!d.isLayer) out.push(d); } return out; };
  const unique = (name) => {
    const used = new Set(groups().map((d) => d.name));
    if (!used.has(name)) return name;
    let i = 2;
    while (used.has(`${name} (${i})`)) i++;
    return `${name} (${i})`;
  };
  function addGroup(name, feats = [], base = {}) {
    const ds = new C.CustomDataSource(unique(name || 'Capa'));
    ds.oge = true; // own layer: saved as GeoJSON with style and attributes
    ds.entities.suspendEvents();
    for (const f of feats) for (const o of fromFeature(f, base)) ds.entities.add(o);
    ds.entities.resumeEvents();
    viewer.dataSources.add(ds);
    return ds;
  }
  const features = (ds) => ds.entities.values.map(toFeature).filter(Boolean);

  const mine = new C.CustomDataSource('Mis dibujos');
  mine.oge = true;
  viewer.dataSources.add(mine);
  let target = mine; // layer that receives what is drawn
  OGE.mine = mine;
  OGE.target = () => (viewer.dataSources.contains(target) ? target : mine);
  OGE.setTarget = (ds) => { target = ds; };

  // Adds Features to a layer as a single undoable action; returns the created entities.
  function add(feats, ds = OGE.target(), base) {
    const es = feats.flatMap((f) => fromFeature(f, base)).map((o) => new C.Entity(o));
    OGE.run({ do: () => es.forEach((e) => ds.entities.add(e)), undo: () => es.forEach((e) => ds.entities.remove(e)) });
    return es;
  }

  // ---------- Projection onto a line ----------
  // turf.nearestPointOnLine drifts by tens of meters on long segments; here the projection is done in the lon/lat plane
  // (the same one turf uses for boolean operations), so the point falls exactly on the segment.
  function nearest(cs, c) { // → { point, dist (m), index (segment), t (0..1 within the segment) }
    const kx = Math.max(1e-6, Math.cos((c[1] * Math.PI) / 180));
    let best = null, bd = Infinity;
    for (let i = 0; i < cs.length - 1; i++) {
      const ax = (cs[i][0] - c[0]) * kx, ay = cs[i][1] - c[1], dx = (cs[i + 1][0] - cs[i][0]) * kx, dy = cs[i + 1][1] - cs[i][1], L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0, px = ax + t * dx, py = ay + t * dy, d = px * px + py * py;
      if (d < bd) { bd = d; best = { point: [r9(c[0] + px / kx), r9(c[1] + py)], index: i, t }; }
    }
    return best && { ...best, dist: Math.sqrt(bd) * 111320 };
  }
  function sliceLine(cs, p, q) { // stretch of the line between the projections of p and q, oriented from p to q
    const a = nearest(cs, p), b = nearest(cs, q), fwd = a.index + a.t <= b.index + b.t, [s, e] = fwd ? [a, b] : [b, a];
    const out = [s.point, ...cs.slice(s.index + 1, e.index + 1), e.point];
    return fwd ? out : out.reverse();
  }

  // ---------- Export ----------
  function exportFC(ds) { // GeoJSON with name, description, attributes and simplestyle style
    return { type: 'FeatureCollection', features: features(ds).filter((f) => f.oge.kind !== 'image').map((f) => {
      const s = f.oge.style, p = { name: f.oge.name, ...(f.oge.desc ? { description: f.oge.desc } : {}), ...f.properties };
      if (f.oge.kind === 'point') p['marker-color'] = s.color;
      else Object.assign(p, { stroke: s.stroke, 'stroke-width': s.width, 'stroke-opacity': s.strokeOpacity });
      if (f.oge.kind === 'polygon') Object.assign(p, { fill: s.fill, 'fill-opacity': s.fillOpacity });
      return { type: 'Feature', geometry: f.geometry, properties: p };
    }) };
  }
  const wkt = (g) => {
    const pt = (c) => c[0] + ' ' + c[1], ring = (r) => '(' + r.map(pt).join(', ') + ')';
    return g.type === 'Point' ? `POINT (${pt(g.coordinates)})` : g.type === 'LineString' ? 'LINESTRING ' + ring(g.coordinates) : 'POLYGON (' + g.coordinates.map(ring).join(', ') + ')';
  };

  OGE.geo = { toLL, fromLL, flat, kind, rings, setRings, sphere, center, getStyle, setStyle, toFeature, fromFeature, parts,
    groups, addGroup, features, add, exportFC, wkt, pinLabel, labelStyle, nearest, sliceLine, DEF, icon };
})();
