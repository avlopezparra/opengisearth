// OpenGISEarth — editing: selection, nodes with snapping and topology, images, attributes and path operations.
// shortcut: the operations work in lon/lat (turf); polygons that cross the antimeridian are not processed correctly.
(() => {
  const C = Cesium, T = turf, { viewer, geo, $, el } = OGE;
  const scene = viewer.scene;
  const now = () => viewer.clock.currentTime;
  const SNAP_PX = 12;      // snapping tolerance in screen pixels (like ArcGIS and QGIS)
  const SAME_M = 0.5;      // nodes closer than this are considered shared (topology)
  const MAX_HANDLES = 500; // on huge objects only the nodes in view are shown

  let editMode = false, snap = true, topo = true;
  let sel = [], handles = [], marks = [], drag = null, bigSel = false;
  const tmp = (o) => { const e = viewer.entities.add(o); e._tmp = true; return e; };
  const alive = (e) => !!e.entityCollection && e.entityCollection.contains(e);

  // Editable objects: everything visible in the Places layers.
  function editables() {
    const out = [];
    for (const ds of geo.groups()) if (ds.show) for (const e of ds.entities.values) if (e.isShowing && geo.kind(e)) out.push(e);
    return out;
  }

  // ---------- Selection: marked with a cyan outline, without touching the object's style ----------
  const rectOf = (e) => e.rectangle.coordinates.getValue(now());
  const corners = (r) => [[r.west, r.south], [r.east, r.south], [r.east, r.north], [r.west, r.north]].map(([x, y]) => C.Cartesian3.fromRadians(x, y));
  function mark() {
    marks.forEach((m) => viewer.entities.remove(m));
    marks = [];
    const line = (positions) => marks.push(tmp({ polyline: { positions, width: 4, material: C.Color.CYAN.withAlpha(0.9), clampToGround: true, zIndex: 10 } }));
    for (const e of sel.slice(0, 300)) {
      const k = geo.kind(e);
      if (k === 'point') marks.push(tmp({ position: geo.rings(e)[0][0], point: { pixelSize: 22, color: C.Color.CYAN.withAlpha(0.25), outlineColor: C.Color.CYAN, outlineWidth: 3,
        heightReference: C.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY } }));
      else if (k === 'image') { const c = corners(rectOf(e)); line([...c, c[0]]); }
      else for (const r of geo.rings(e)) if (r.length > 1) line(k === 'polygon' ? [...r, r[0]] : r);
    }
  }
  function select(list) {
    sel = [...new Set(list)].filter((e) => e && alive(e) && geo.kind(e));
    mark(); buildHandles(); renderPanel();
  }
  const refresh = () => select(sel);
  OGE.onChange(refresh); // after every action, undo or redo

  // ---------- Handles: nodes (white), midpoints (gray, insert a node) and image corners (green) ----------
  const H = (color, size) => ({ pixelSize: size, color, outlineColor: C.Color.BLACK, outlineWidth: 2,
    heightReference: C.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY });
  function clearHandles() { handles.forEach((h) => viewer.entities.remove(h)); handles = []; }
  function buildHandles() {
    clearHandles();
    bigSel = false;
    if (!editMode || sel.length !== 1 || drag) return;
    const e = sel[0], k = geo.kind(e);
    const add = (position, tag, style) => { const h = tmp({ position, point: style }); Object.assign(h, tag); handles.push(h); };
    if (k === 'point') return; // the point is dragged directly
    if (k === 'image') {
      const r = rectOf(e);
      corners(r).forEach((p, c) => add(p, { _img: { e, c } }, H(C.Color.LIME, 12)));
      return add(C.Cartesian3.fromRadians((r.west + r.east) / 2, (r.south + r.north) / 2), { _img: { e, c: 'm' } }, H(C.Color.LIME, 15));
    }
    const rs = geo.rings(e);
    let refs = rs.flatMap((ring, r) => ring.map((p, i) => ({ r, i, p })));
    const total = refs.length;
    if (total > MAX_HANDLES) { // only the visible nodes closest to the center of the screen
      bigSel = true;
      const w = scene.canvas.clientWidth, hh = scene.canvas.clientHeight;
      refs = refs.map((v) => ({ ...v, s: scene.cartesianToCanvasCoordinates(v.p) }))
        .filter((v) => v.s && v.s.x >= 0 && v.s.x <= w && v.s.y >= 0 && v.s.y <= hh)
        .sort((a, b) => Math.hypot(a.s.x - w / 2, a.s.y - hh / 2) - Math.hypot(b.s.x - w / 2, b.s.y - hh / 2)).slice(0, MAX_HANDLES);
    }
    for (const v of refs) add(v.p, { _v: { e, r: v.r, i: v.i } }, H(C.Color.WHITE, 10));
    if (total <= 250) rs.forEach((ring, r) => {
      const n = ring.length;
      for (let i = 0; i < (k === 'polygon' ? n : n - 1); i++) {
        add(geo.flat(C.Cartesian3.midpoint(ring[i], ring[(i + 1) % n], new C.Cartesian3())), { _m: { e, r, i: i + 1 } }, H(C.Color.GRAY.withAlpha(0.9), 7));
      }
    });
  }
  viewer.camera.moveEnd.addEventListener(() => { if (bigSel && !drag) buildHandles(); });

  // ---------- Snapping on the terrain: first to nodes, then to edges ----------
  // Meters per screen pixel at the distance of p: the tolerance is defined in pixels.
  const mpp = (p) => scene.camera.getPixelSize(new C.BoundingSphere(p, 0), scene.drawingBufferWidth, scene.drawingBufferHeight) * (scene.drawingBufferWidth / scene.canvas.clientWidth);
  // Returns {pos} and, if it snapped to a node, also {e, r, i}. skip(e, r, i) excludes nodes (the ones being dragged).
  function snapAt(screenPos, skip) {
    const hit = OGE.pickGround(screenPos);
    if (!hit) return null;
    const g = geo.flat(hit);
    if (!snap) return { pos: g };
    const tol = SNAP_PX * mpp(hit), ab = new C.Cartesian3(), ag = new C.Cartesian3(), q = new C.Cartesian3();
    let best = null, bd = tol, edge = null, ed = tol;
    for (const e of editables()) {
      const k = geo.kind(e);
      if (k === 'image') continue;
      const bs = geo.sphere(e);
      if (C.Cartesian3.distance(g, bs.center) > bs.radius + tol) continue;
      geo.rings(e).forEach((ring, r) => {
        const n = ring.length;
        for (let i = 0; i < n; i++) {
          if (skip && skip(e, r, i)) continue;
          const d = C.Cartesian3.distance(g, ring[i]);
          if (d < bd) { bd = d; best = { pos: C.Cartesian3.clone(ring[i]), e, r, i }; }
        }
        if (k === 'point') return;
        for (let i = 0; i < (k === 'polygon' ? n : n - 1); i++) {
          const j = (i + 1) % n;
          if (skip && (skip(e, r, i) || skip(e, r, j))) continue;
          C.Cartesian3.subtract(ring[j], ring[i], ab);
          const L = C.Cartesian3.magnitudeSquared(ab);
          if (!L) continue;
          const t = Math.max(0, Math.min(1, C.Cartesian3.dot(C.Cartesian3.subtract(g, ring[i], ag), ab) / L));
          C.Cartesian3.add(ring[i], C.Cartesian3.multiplyByScalar(ab, t, q), q);
          const d = C.Cartesian3.distance(g, q);
          if (d < ed) { ed = d; edge = { pos: geo.flat(q) }; }
        }
      });
    }
    return best || edge || { pos: g };
  }
  // Nodes of e (ring r) between i and j along the shortest path, excluding the endpoints.
  function borderPath(e, r, i, j) {
    const ring = geo.rings(e)[r], n = ring.length;
    if (geo.kind(e) !== 'polygon') { const mid = ring.slice(Math.min(i, j) + 1, Math.max(i, j)); return i < j ? mid : mid.reverse(); }
    const fwd = (j - i + n) % n, back = (i - j + n) % n, out = [];
    if (fwd <= back) for (let k = 1; k < fwd; k++) out.push(ring[(i + k) % n]);
    else for (let k = 1; k < back; k++) out.push(ring[(i - k + n) % n]);
    return out;
  }

  // ---------- Node dragging (with topology) ----------
  const setAll = (map) => map.forEach((rs, e) => geo.setRings(e, rs.map((r) => r.slice())));
  function coincident(p0) { // nodes of any object at the same spot as p0
    const out = [];
    for (const o of editables()) {
      if (geo.kind(o) === 'image') continue;
      const bs = geo.sphere(o);
      if (C.Cartesian3.distance(p0, bs.center) > bs.radius + SAME_M) continue;
      geo.rings(o).forEach((ring, r) => ring.forEach((q, i) => { if (C.Cartesian3.distance(p0, q) < SAME_M) out.push({ e: o, r, i }); }));
    }
    return out;
  }
  function startDrag(e, r, i, before) {
    const p0 = geo.rings(e)[r][i];
    const targets = topo ? coincident(p0) : [];
    if (!targets.some((t) => t.e === e && t.r === r && t.i === i)) targets.push({ e, r, i });
    const base = new Map();
    for (const t of targets) if (!base.has(t.e)) base.set(t.e, geo.rings(t.e));
    const keys = new Set(targets.map((t) => `${t.e.id}:${t.r}:${t.i}`));
    drag = { targets, base, before: new Map([...base, ...(before || [])]), skip: (e2, r2, i2) => keys.has(`${e2.id}:${r2}:${i2}`) };
    scene.screenSpaceCameraController.enableInputs = false;
    marks.forEach((m) => { m.show = false; });
  }
  function moveDrag(screenPos) {
    const s = snapAt(screenPos, drag.skip);
    if (!s) return;
    const work = new Map();
    for (const t of drag.targets) {
      if (!work.has(t.e)) work.set(t.e, drag.base.get(t.e).map((r) => r.slice()));
      work.get(t.e)[t.r][t.i] = s.pos;
    }
    setAll(work);
    drag.after = work;
    for (const h of handles) if (h._v && drag.skip(h._v.e, h._v.r, h._v.i)) h.position = s.pos;
  }
  function endDrag() {
    scene.screenSpaceCameraController.enableInputs = true;
    const d = drag;
    drag = null;
    if (d.img) {
      if (d.r1) OGE.run({ do: () => { d.img.rectangle.coordinates = d.r1; }, undo: () => { d.img.rectangle.coordinates = d.r0; } });
      else refresh();
    } else if (d.after) OGE.run({ do: () => setAll(d.after), undo: () => setAll(d.before) });
    else { setAll(d.before); refresh(); } // click without moving: cancels an insertion
  }
  function removeVertex(e, r, i) {
    const rs = geo.rings(e), min = geo.kind(e) === 'polygon' ? 3 : 2;
    if (rs[r].length <= min) return OGE.toast('No se puede borrar: quedaría con menos de ' + min + ' nodos.', true);
    const after = rs.map((ring, k) => (k === r ? ring.filter((_, n) => n !== i) : ring));
    OGE.run({ do: () => geo.setRings(e, after), undo: () => geo.setRings(e, rs) });
  }

  // ---------- Images: corners to stretch, center to move ----------
  function startImg(e, c, screenPos) {
    const g = OGE.pickGround(screenPos);
    drag = { img: e, c, r0: C.Rectangle.clone(rectOf(e)), g0: g && C.Cartographic.fromCartesian(g) };
    scene.screenSpaceCameraController.enableInputs = false;
    clearHandles();
  }
  function moveImg(screenPos) {
    const g = OGE.pickGround(screenPos);
    if (!g || !drag.g0) return;
    const k = C.Cartographic.fromCartesian(g), r0 = drag.r0;
    let r;
    if (drag.c === 'm') {
      const dx = k.longitude - drag.g0.longitude, dy = k.latitude - drag.g0.latitude;
      r = new C.Rectangle(r0.west + dx, r0.south + dy, r0.east + dx, r0.north + dy);
    } else { // corners 0 SW, 1 SE, 2 NE, 3 NW: the opposite one stays fixed
      const fx = drag.c === 0 || drag.c === 3 ? r0.east : r0.west, fy = drag.c < 2 ? r0.north : r0.south;
      r = new C.Rectangle(Math.min(fx, k.longitude), Math.min(fy, k.latitude), Math.max(fx, k.longitude), Math.max(fy, k.latitude));
    }
    if (r.east - r.west < 1e-7 || r.north - r.south < 1e-7 || r.north > Math.PI / 2 || r.south < -Math.PI / 2) return;
    drag.img.rectangle.coordinates = r;
    drag.r1 = r;
  }

  // ---------- Mouse events ----------
  const hd = new C.ScreenSpaceEventHandler(scene.canvas);
  const active = () => editMode && !OGE.drawing();
  const pickHandle = (pos) => { const p = scene.pick(pos); return p && p.id && (p.id._v || p.id._m || p.id._img) ? p.id : null; };
  function pickFeature(pos) {
    for (const p of scene.drillPick(pos, 8)) {
      const e = p.id;
      if (e instanceof C.Entity && !e._tmp && geo.kind(e) && e.entityCollection && e.entityCollection.owner && !e.entityCollection.owner.isLayer) return e;
    }
    return null;
  }
  hd.setInputAction((ev) => {
    if (!active()) return;
    const h = pickHandle(ev.position);
    if (h && h._img) return startImg(h._img.e, h._img.c, ev.position);
    if (h && h._v) return startDrag(h._v.e, h._v.r, h._v.i);
    if (h) { // midpoint: inserts a node and drags it; undo goes back to before the insertion
      const { e, r, i } = h._m, rs = geo.rings(e), before = rs.map((x) => x.slice());
      rs[r].splice(i, 0, h.position.getValue(now()));
      geo.setRings(e, rs);
      return startDrag(e, r, i, [[e, before]]);
    }
    if (sel.length === 1 && geo.kind(sel[0]) === 'point' && pickFeature(ev.position) === sel[0]) startDrag(sel[0], 0, 0);
  }, C.ScreenSpaceEventType.LEFT_DOWN);
  hd.setInputAction((ev) => { if (drag) (drag.img ? moveImg : moveDrag)(ev.endPosition); }, C.ScreenSpaceEventType.MOUSE_MOVE);
  hd.setInputAction(() => { if (drag) endDrag(); }, C.ScreenSpaceEventType.LEFT_UP);
  window.addEventListener('pointerup', () => setTimeout(() => { if (drag) endDrag(); })); // if released outside the map
  const clickSel = (add) => (ev) => {
    if (!active() || pickHandle(ev.position)) return;
    const e = pickFeature(ev.position);
    if (!add) select(e ? [e] : []);
    else if (e) select(sel.includes(e) ? sel.filter((x) => x !== e) : [...sel, e]);
  };
  hd.setInputAction(clickSel(false), C.ScreenSpaceEventType.LEFT_CLICK);
  hd.setInputAction(clickSel(true), C.ScreenSpaceEventType.LEFT_CLICK, C.KeyboardEventModifier.CTRL);
  hd.setInputAction(clickSel(true), C.ScreenSpaceEventType.LEFT_CLICK, C.KeyboardEventModifier.SHIFT);
  hd.setInputAction((ev) => {
    if (!active()) return;
    const h = pickHandle(ev.position);
    if (h && h._v) removeVertex(h._v.e, h._v.r, h._v.i);
  }, C.ScreenSpaceEventType.LEFT_CLICK, C.KeyboardEventModifier.ALT);
  // While editing or drawing the info balloon does not open, and handles are never selected.
  viewer.selectedEntityChanged.addEventListener((e) => { if (e && (e._tmp || editMode || OGE.drawing())) viewer.selectedEntity = undefined; });

  // ---------- Selection panel: measurements and attributes ----------
  function measure(f) {
    const k = f.oge.kind;
    if (k === 'point') return f.geometry.coordinates[1].toFixed(6) + ', ' + f.geometry.coordinates[0].toFixed(6);
    if (k === 'line') return 'Longitud ' + OGE.fmtLen(T.length(f) * 1000) + ' · ' + f.geometry.coordinates.length + ' nodos';
    return 'Área ' + OGE.fmtArea(T.area(f)) + ' · perímetro ' + OGE.fmtLen(T.length(f) * 1000);
  }
  function renderPanel() {
    const p = $('editPanel');
    p.hidden = !editMode || !sel.length;
    if (p.hidden) return;
    const fs = sel.map(geo.toFeature).filter(Boolean), t = $('attrs');
    t.replaceChildren();
    $('addAttr').hidden = $('selProps').hidden = sel.length !== 1;
    if (sel.length > 1) {
      $('selTitle').textContent = sel.length + ' objetos seleccionados';
      const area = fs.filter((f) => f.oge.kind === 'polygon').reduce((s, f) => s + T.area(f), 0);
      const len = fs.filter((f) => f.oge.kind === 'line').reduce((s, f) => s + T.length(f) * 1000, 0);
      $('measure').textContent = [area && 'Área total ' + OGE.fmtArea(area), len && 'Longitud total ' + OGE.fmtLen(len)].filter(Boolean).join(' · ');
      return;
    }
    const e = sel[0];
    $('selTitle').textContent = e.name || 'Sin nombre';
    $('measure').textContent = fs[0] ? measure(fs[0]) : '';
    const row = (k, v, onKey, onVal) => {
      const a = el('input', { value: k, disabled: !onKey, title: onKey ? 'Nombre del campo (vacío = borrar el campo)' : '' }), b = el('input', { value: v ?? '' });
      a.setAttribute('aria-label', 'Campo'); b.setAttribute('aria-label', 'Valor de ' + k);
      if (onKey) a.onchange = () => onKey(a.value.trim());
      b.onchange = () => onVal(b.value);
      t.append(el('tr', {}, el('td', {}, a), el('td', {}, b)));
    };
    row('nombre', e.name, null, (v) => OGE.run({ do: () => rename(e, v), undo: ((old) => () => rename(e, old))(e.name) }));
    if (geo.kind(e) === 'image') return;
    for (const [k, v] of Object.entries(fs[0] ? fs[0].properties : {})) row(k, v, (nk) => setProps(e, k, nk), (nv) => setProps(e, k, k, nv));
  }
  function rename(e, v) { e.name = v; if (e.label && geo.kind(e) === 'point') e.label.text = v; }
  // Changes an attribute: empty new key = delete; numeric value if it looks like one.
  function setProps(e, key, newKey, value) {
    const before = e.properties ? e.properties.getValue(now()) : {}, after = {};
    if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) value = Number(value);
    for (const [k, v] of Object.entries(before)) {
      if (k !== key) after[k] = v;
      else if (newKey) after[newKey] = value === undefined ? v : value;
    }
    if (!(key in before) && newKey) after[newKey] = value ?? '';
    const put = (p) => { e.properties = Object.keys(p).length ? new C.PropertyBag(p) : undefined; };
    OGE.run({ do: () => put(after), undo: () => put(before) });
  }
  $('addAttr').onclick = async () => {
    const v = await OGE.ask({ title: 'Nuevo atributo', fields: [{ id: 'k', label: 'Nombre del campo' }, { id: 'v', label: 'Valor' }] });
    if (v && v.k.trim() && sel.length === 1) setProps(sel[0], v.k.trim(), v.k.trim(), v.v);
  };
  $('selProps').onclick = () => { if (sel.length === 1) OGE.editProps(sel[0]); };
  $('selZoom').onclick = () => viewer.flyTo(sel);
  $('selDel').onclick = () => doOp('delete');

  // ---------- Path operations on the selection (like Inkscape); they replace the objects in their layer ----------
  const F = geo.toFeature, fc = (...fs) => T.featureCollection(fs);
  const polys = () => sel.filter((e) => geo.kind(e) === 'polygon');
  const lines = () => sel.filter((e) => geo.kind(e) === 'line');
  // results: [[turfGeometry, baseEntity], …]; each result inherits name, style and attributes from its base.
  function put(olds, results, extraName) {
    const news = [];
    for (const [g, baseE] of results) {
      if (!g) continue;
      const b = baseE ? F(baseE) : { properties: {}, oge: {} };
      const f = { type: 'Feature', geometry: g.geometry, properties: b.properties, oge: { ...b.oge, kind: undefined, label: undefined, ...(extraName ? { name: extraName } : {}) } };
      if (!baseE) delete f.oge.style;
      for (const o of geo.fromFeature(f)) news.push(new C.Entity(o));
    }
    if (!news.length) return OGE.toast('El resultado está vacío: no se cambió nada.', true);
    const owners = olds.map((e) => e.entityCollection), target = (olds[0] || sel[0]).entityCollection;
    OGE.run({ do: () => { olds.forEach((e, i) => owners[i].remove(e)); news.forEach((e) => target.add(e)); },
      undo: () => { news.forEach((e) => target.remove(e)); olds.forEach((e, i) => owners[i].add(e)); } });
    select(news);
  }
  // Cuts a polygon with a line: subtracts a 5 cm corridor and then closes the slot by projecting the edges onto the line.
  function splitPolygon(pf, lf) {
    const cut = T.difference(fc(pf, T.buffer(lf, 0.00005, { units: 'kilometers', steps: 2 })));
    if (!cut || cut.geometry.type !== 'MultiPolygon') return null;
    T.coordEach(cut, (c) => {
      const np = geo.nearest(lf.geometry.coordinates, c);
      if (np.dist < 0.2) { c[0] = np.point[0]; c[1] = np.point[1]; }
    });
    return cut;
  }
  const need = (okd, msg) => { if (!okd) throw new Error(msg); };
  const OPS = {
    union() {
      const p = polys();
      need(p.length >= 2, 'Selecciona dos o más polígonos (Ctrl+clic).');
      put(p, [[T.union(fc(...p.map(F))), p[0]]]);
    },
    difference() {
      const p = polys();
      need(p.length >= 2, 'Selecciona primero el polígono a recortar y luego los que se restan (Ctrl+clic).');
      put([p[0]], [[T.difference(fc(...p.map(F))), p[0]]]);
    },
    intersect() {
      const p = polys();
      need(p.length >= 2, 'Selecciona dos o más polígonos (Ctrl+clic).');
      put(p, [[T.intersect(fc(...p.map(F))), p[0]]]);
    },
    xor() { // Exclusion: (A ∪ B) − (A ∩ B)
      const p = polys();
      need(p.length === 2, 'Selecciona dos polígonos (Ctrl+clic).');
      const both = T.intersect(fc(...p.map(F))), all = T.union(fc(...p.map(F)));
      put(p, [[both ? T.difference(fc(all, both)) : all, p[0]]]);
    },
    divide() { // Division: the second cuts the first; the pieces inside and outside remain
      const p = polys();
      need(p.length === 2, 'Selecciona el polígono a dividir y luego el que corta (Ctrl+clic).');
      const inside = T.intersect(fc(...p.map(F)));
      need(inside, 'Los polígonos no se tocan.');
      put(p, [[inside, p[0]], [T.difference(fc(...p.map(F))), p[0]]]);
    },
    split() {
      const p = polys(), l = lines();
      need(p.length === 1 && l.length === 1, 'Selecciona un polígono y una línea que lo cruce (Ctrl+clic).');
      const cut = splitPolygon(F(p[0]), F(l[0]));
      need(cut, 'La línea no atraviesa el polígono de lado a lado.');
      put([p[0]], [[cut, p[0]]]);
    },
    fill() { // area between two lines; an optional third one closes the ends following its course
      const l = lines();
      need(l.length === 2 || l.length === 3, 'Selecciona dos líneas (y, si quieres, una tercera que cierre los extremos) con Ctrl+clic.');
      const [a, b0, lim] = l.map((e) => F(e).geometry.coordinates);
      const d2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
      const b = d2(a[0], b0[0]) + d2(a.at(-1), b0.at(-1)) > d2(a[0], b0.at(-1)) + d2(a.at(-1), b0[0]) ? b0.slice().reverse() : b0;
      const along = (p, q) => (lim ? geo.sliceLine(lim, p, q) : []); // stretch of the boundary line between the projections of p and q
      const ring = [...a, ...along(a.at(-1), b.at(-1)), ...b.slice().reverse(), ...along(b[0], a[0])].filter((c, i, r) => i === 0 || d2(c, r[i - 1]) > 0);
      ring.push(ring[0]);
      need(ring.length >= 4, 'Las líneas no encierran un área.');
      let pieces; // if the ring crosses itself, it is split into lobes and they are merged
      try { pieces = T.unkinkPolygon(T.polygon([ring])).features; } catch { pieces = [T.polygon([ring])]; }
      const geom = pieces.length > 1 ? T.union(T.featureCollection(pieces)) : pieces[0];
      put([], [[geom, null]], 'Área entre ' + (l[0].name || 'línea') + ' y ' + (l[1].name || 'línea'));
    },
    transfer() { // the area of the cutting shape moves from one polygon to another, without overlaps
      const p = polys();
      need(p.length === 3, 'Selecciona, en orden: el polígono que cede, el que recibe y la forma de corte (Ctrl+clic).');
      const [src, dst, cut] = p.map(F), moved = T.intersect(fc(src, cut));
      need(moved, 'La forma de corte no toca el polígono que cede.');
      put(p, [[T.difference(fc(src, cut)), p[0]], [T.union(fc(dst, moved)), p[1]]]); // the cutting shape is consumed
    },
    async closeGaps() { // snaps the nodes of the first polygon to the edge of the others (closes gaps and slivers)
      const p = polys();
      need(p.length >= 2, 'Selecciona primero el polígono a ajustar y luego su(s) vecino(s) (Ctrl+clic).');
      const v = await OGE.ask({ title: 'Cerrar huecos', help: 'Los nodos del primer polígono que estén cerca del borde de los vecinos se pegan a ese borde.',
        fields: [{ id: 'tol', label: 'Distancia máxima para pegar (m)', type: 'number', value: 200, min: 0 }] });
      if (!v || !v.tol) return;
      const e = p[0], before = geo.rings(e), borders = p.slice(1).flatMap((o) => F(o).geometry.coordinates);
      let moved = 0;
      const after = before.map((ring) => ring.map((c) => {
        let best = null, bd = v.tol;
        for (const b of borders) { const np = geo.nearest(b, geo.toLL(c)); if (np.dist < bd) { bd = np.dist; best = np.point; } }
        if (best) moved++;
        return best ? geo.fromLL(best) : c;
      }));
      need(moved, 'Ningún nodo está a menos de ' + v.tol + ' m de un vecino.');
      OGE.run({ do: () => geo.setRings(e, after), undo: () => geo.setRings(e, before) });
      OGE.toast(moved + ' nodos pegados al borde vecino.');
    },
    delete() {
      if (!sel.length) return;
      const olds = sel.slice(), owners = olds.map((e) => e.entityCollection);
      OGE.run({ do: () => olds.forEach((e, i) => owners[i].remove(e)), undo: () => olds.forEach((e, i) => owners[i].add(e)) });
    },
  };
  async function doOp(op) {
    if (!editMode) setEdit(true);
    if (!sel.length) return OGE.hint('Primero selecciona los objetos: clic en uno y Ctrl+clic en los demás (el orden importa). Luego vuelve a pulsar la operación.');
    try { await OPS[op](); } catch (err) { OGE.toast(err.message, true); }
  }
  document.querySelectorAll('[data-op]').forEach((b) => { b.onclick = () => doOp(b.dataset.op); });

  // ---------- Buttons and keys ----------
  const toggle = (btn, v) => { btn.classList.toggle('active', v); return v; };
  function setEdit(v) {
    editMode = toggle($('editBtn'), v);
    if (v) { OGE.activate(null); OGE.hint('Clic selecciona; Ctrl o Mayús+clic agrega. Arrastra los nodos; el punto gris inserta uno; Alt+clic lo borra.'); } else OGE.hint('');
    select(v ? sel : []);
  }
  $('editBtn').onclick = () => setEdit(!editMode);
  $('snapBtn').onclick = () => { snap = toggle($('snapBtn'), !snap); };
  $('topoBtn').onclick = () => { topo = toggle($('topoBtn'), !topo); };
  const INK = { '+': 'union', '-': 'difference', '*': 'intersect', '^': 'xor', '/': 'divide' }; // shortcuts of Inkscape's Path menu
  document.addEventListener('keydown', (e) => {
    if (OGE.typing(e)) return;
    if (e.ctrlKey) {
      if (e.altKey && e.key === '/') { e.preventDefault(); doOp('split'); } else if (INK[e.key]) { e.preventDefault(); doOp(INK[e.key]); }
      return;
    }
    if (e.altKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    if (k === 's') $('snapBtn').click();
    else if (k === 't') $('topoBtn').click();
    else if (k === 'e') $('editBtn').click();
    else if (e.key === 'Delete' && editMode && sel.length) doOp('delete');
    else if (e.key === 'Escape') select([]);
  });

  Object.assign(OGE, { select, selection: () => sel, setEdit, editing: () => editMode, snapAt, borderPath, splitPolygon, OPS, startDrag, moveDrag, endDrag });
})();
