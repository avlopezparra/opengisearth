// OpenGISEarth — dibujo: marca, trazado, polígono, regla e imágenes superpuestas (archivo o URL).
(() => {
  const C = Cesium, { viewer, geo, $ } = OGE;
  const scene = viewer.scene;

  // ---------- Boceto en curso ----------
  let tool = null, pts = [], temp = [], nodes = [], lastSnap = null;
  const HINTS = {
    point: 'Clic en el mapa para poner la marca.',
    line: 'Clics para trazar; dos clics seguidos sobre un mismo borde lo siguen. Doble clic o Enter termina, clic derecho borra el último, Esc cancela.',
    polygon: 'Clics para trazar; dos clics seguidos sobre un mismo borde lo siguen. Doble clic o Enter termina, clic derecho borra el último, Esc cancela.',
    ruler: 'Clics para medir; doble clic o Enter termina.',
  };
  const NODE = { pixelSize: 9, color: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 2,
    heightReference: C.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY };
  const tmp = (o) => { const e = viewer.entities.add(o); e._tmp = true; return e; };
  const lenM = (p) => {
    let d = 0;
    for (let i = 1; i < p.length; i++) d += new C.EllipsoidGeodesic(C.Cartographic.fromCartesian(p[i - 1]), C.Cartographic.fromCartesian(p[i])).surfaceDistance;
    return d;
  };
  function measure() { // medida en vivo del boceto
    if (pts.length < 2) return '';
    let t = 'Longitud ' + OGE.fmtLen(lenM(tool === 'polygon' ? [...pts, pts[0]] : pts));
    const ll = pts.map(geo.toLL);
    if (tool === 'polygon' && pts.length > 2) t += ' · área ' + OGE.fmtArea(turf.area(turf.polygon([[...ll, ll[0]]])));
    if (tool === 'ruler') t += ' · rumbo del último tramo ' + Math.round((turf.bearing(ll[ll.length - 2], ll[ll.length - 1]) + 360) % 360) + '°';
    return t;
  }
  function syncNodes() { // un nodo blanco por vértice, como en Earth
    nodes.forEach((n) => viewer.entities.remove(n));
    nodes = pts.map((p) => tmp({ position: p, point: NODE }));
    const m = tool && tool !== 'point' && measure();
    if (m) OGE.hint(m + ' — doble clic o Enter termina.');
  }
  function clearSketch() {
    temp.forEach((e) => viewer.entities.remove(e));
    temp = []; pts = []; lastSnap = null;
    syncNodes();
  }
  // keep: conserva el boceto en pantalla (la regla deja a la vista lo medido hasta la siguiente acción)
  function activate(t, keep) {
    if (!keep) clearSketch();
    tool = t;
    document.querySelectorAll('#tools [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    if (!keep) OGE.hint(HINTS[tool]);
    if (!tool || tool === 'point') return;
    temp.push(tmp({ polyline: { positions: new C.CallbackProperty(() => (tool === 'polygon' && pts.length > 2 ? [...pts, pts[0]] : pts), false),
      width: 3, material: C.Color.ORANGE, clampToGround: true } }));
    if (tool === 'polygon') temp.push(tmp({ polygon: { material: C.Color.ORANGE.withAlpha(0.25),
      hierarchy: new C.CallbackProperty(() => (pts.length > 2 ? new C.PolygonHierarchy(pts) : undefined), false) } }));
  }
  const setTool = (t) => activate(tool === t ? null : t); // el botón activo se apaga al pulsarlo otra vez

  const feature = (geometry, oge) => ({ type: 'Feature', geometry, properties: {}, oge });
  function finish() {
    const t = tool, p = pts.slice();
    if (t === 'ruler') {
      if (p.length < 2) return;
      const m = measure();
      activate(null, true);
      OGE.hint(m + ' — Esc o otra herramienta borra la medida.');
      return;
    }
    if ((t === 'line' && p.length < 2) || (t === 'polygon' && p.length < 3)) return OGE.toast('Faltan puntos: un trazado necesita 2 y un polígono 3.', true);
    const ll = p.map(geo.toLL);
    const [e] = geo.add([feature(t === 'line' ? { type: 'LineString', coordinates: ll } : { type: 'Polygon', coordinates: [[...ll, ll[0]]] },
      { name: T(t === 'line' ? 'Trazado' : 'Polígono') })]);
    activate(t); // listo para el siguiente
    if (e) OGE.editProps(e, true); else OGE.toast('La figura no es válida (puntos repetidos).', true);
  }

  // ---------- Eventos ----------
  const h = new C.ScreenSpaceEventHandler(scene.canvas);
  h.setInputAction((ev) => {
    if (!tool) return;
    const s = OGE.snapAt(ev.position); // nodo o borde cercano si el ajuste está activo
    if (!s) return;
    if (tool === 'point') {
      const [e] = geo.add([feature({ type: 'Point', coordinates: geo.toLL(s.pos) }, { name: T('Marca') })]);
      return OGE.editProps(e, true);
    }
    // Dos clics seguidos sobre nodos del mismo borde lo siguen (como el editor de regiones de Making History).
    if (s.i != null && lastSnap && lastSnap.e === s.e && lastSnap.r === s.r && lastSnap.i !== s.i) pts.push(...OGE.borderPath(s.e, s.r, lastSnap.i, s.i));
    lastSnap = s.i != null ? s : null;
    pts.push(s.pos);
    syncNodes();
  }, C.ScreenSpaceEventType.LEFT_CLICK);
  // El doble clic llega después de dos LEFT_CLICK en el mismo sitio: se quita el punto duplicado.
  h.setInputAction(() => { if (tool && tool !== 'point') { pts.pop(); finish(); } }, C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  h.setInputAction(() => { if (tool) { pts.pop(); lastSnap = null; syncNodes(); } }, C.ScreenSpaceEventType.RIGHT_CLICK);

  document.querySelectorAll('#tools [data-tool]').forEach((b) => { b.onclick = () => setTool(b.dataset.tool); });
  document.addEventListener('keydown', (e) => {
    if (OGE.typing(e)) return;
    if (e.key === 'Escape') activate(null);
    else if (e.key === 'Enter' && tool && tool !== 'point') finish();
  });

  // ---------- Imágenes superpuestas ----------
  // Se colocan centradas en la vista con la proporción de la imagen; luego se mueven y estiran en modo Editar.
  function addImage(url, name, w, hgt) {
    const b = OGE.viewBbox() || [-10, -10, 10, 10];
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, kx = Math.max(0.05, Math.cos((cy * Math.PI) / 180));
    let dx = (b[2] - b[0]) / 4, dy = (dx * kx * hgt) / w; // semiancho y semialto en grados
    const maxDy = (b[3] - b[1]) / 4;
    if (dy > maxDy) { dx *= maxDy / dy; dy = maxDy; }
    const [e] = geo.add([feature({ type: 'Polygon', coordinates: [[[cx - dx, cy - dy], [cx + dx, cy - dy], [cx + dx, cy + dy], [cx - dx, cy + dy], [cx - dx, cy - dy]]] },
      { kind: 'image', name, style: { url, opacity: 0.7, rotation: 0 } })]);
    OGE.editProps(e, true).then((okd) => { if (okd) { OGE.setEdit(true); OGE.select([e]); OGE.toast('Arrastra las esquinas verdes para ajustar la imagen y el centro para moverla.'); } });
  }
  function loadImage(url, name) {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => addImage(url, name, im.naturalWidth, im.naturalHeight);
    im.onerror = () => OGE.toast('No se pudo cargar la imagen. Revisa la dirección, o que el sitio permita mostrarla en otras páginas.', true);
    im.src = url;
  }
  $('overlay').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const reader = new FileReader(); // data: URL para que la imagen se guarde con el proyecto (un blob: no sobrevive)
    reader.onload = () => loadImage(reader.result, f.name);
    reader.readAsDataURL(f);
  };
  $('overlayUrl').onclick = async () => {
    const v = await OGE.ask({ title: 'Imagen desde una dirección web', fields: [{ id: 'url', label: 'Dirección (URL) de la imagen', type: 'url', value: 'https://' }] });
    if (!v || !/^https?:\/\/./i.test(v.url)) return;
    loadImage(v.url.trim(), decodeURIComponent(v.url.split('/').pop().split('?')[0]) || T('Imagen'));
  };

  Object.assign(OGE, { setTool, activate, finish, drawing: () => tool });
})();
