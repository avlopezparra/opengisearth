// The sky: the 88 constellations drawn over the stars, turning with them as the clock runs (layer "Constelaciones").
// With ?body=sky the Earth is hidden and the view looks around from where the camera stood, as a planetarium does.
// Lines and names: d3-celestial by Olaf Frohn (BSD 3-Clause, data/constellations.LICENSE.txt).
(() => {
  const { viewer, $ } = OGE, C = Cesium, scene = viewer.scene, cam = viewer.camera, rad = C.Math.toRadians, R = 1e8, SKY = OGE.body === 'sky', cb = $('layerStars');
  const at = ([ra, dec]) => { const a = rad(ra), d = rad(dec); return new C.Cartesian3(R * Math.cos(d) * Math.cos(a), R * Math.cos(d) * Math.sin(a), R * Math.sin(d)); }; // on a sphere around the camera, in the frame of the stars
  let lines = null, names = null, busy = false;
  async function load() {
    if (lines || busy) return;
    busy = true;
    try {
      const data = await (await fetch('data/constellations.json')).json(), L = new C.PolylineCollection(), N = new C.LabelCollection(), blue = C.Color.fromCssColorString('#8fc1ff').withAlpha(0.6);
      for (const c of data) {
        for (const l of c.l) L.add({ positions: l.map(at), width: 1.5, material: C.Material.fromType('Color', { color: blue }) });
        N.add({ position: at(c.p), text: OGE_LANG === 'en' ? c.en : c.es, font: '600 13px sans-serif', fillColor: C.Color.fromCssColorString('#d6e6ff'), outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, horizontalOrigin: C.HorizontalOrigin.CENTER });
      }
      lines = scene.primitives.add(L); names = scene.primitives.add(N); show();
    } catch { OGE.toast('No se pudieron cargar las constelaciones.', true); }
    busy = false;
  }
  const show = () => { if (cb.checked) load(); if (lines) lines.show = names.show = cb.checked; };
  cb.addEventListener('change', show);

  // Sky mode looks from the place the camera stood on; az turns around the axis of the Earth, el rises over its equator.
  const cg = cam.positionCartographic, here = C.Cartesian3.fromRadians(cg.longitude, cg.latitude, 2), rot = new C.Matrix3(), mm = new C.Matrix4();
  let az = null, el = 0;
  scene.preRender.addEventListener((_, time) => {
    C.Transforms.computeTemeToPseudoFixedMatrix(time, rot); // the same turn Cesium gives its star map
    if (SKY) {
      if (az === null) { const o = C.Matrix3.multiplyByVector(rot, at([84, 0]), new C.Cartesian3()); az = Math.atan2(o.y, o.x); } // towards Orion at first
      const ce = Math.cos(el), se = Math.sin(el);
      cam.setView({ destination: here, orientation: { direction: new C.Cartesian3(ce * Math.cos(az), ce * Math.sin(az), se), up: new C.Cartesian3(-se * Math.cos(az), -se * Math.sin(az), ce) } });
    }
    if (lines && lines.show) lines.modelMatrix = names.modelMatrix = C.Matrix4.fromRotationTranslation(rot, cam.positionWC, mm); // centred on the camera: the lines stay on their stars from anywhere
  });

  if (!SKY) return show();
  // Drag to look around; the wheel or two fingers zoom. shortcut: mouse and touch only, add keys if someone asks for them.
  const cv = scene.canvas, touch = new Map(), zoom = (k) => { cam.frustum.fov = C.Math.clamp(cam.frustum.fov * k, rad(4), rad(100)); };
  scene.screenSpaceCameraController.enableInputs = false;
  cb.checked = true; show();
  cv.addEventListener('pointerdown', (e) => { touch.set(e.pointerId, [e.clientX, e.clientY]); cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', (e) => {
    const was = touch.get(e.pointerId); if (!was) return;
    const now = [e.clientX, e.clientY], other = [...touch].find(([id]) => id !== e.pointerId);
    if (other) zoom(Math.hypot(was[0] - other[1][0], was[1] - other[1][1]) / Math.max(1, Math.hypot(now[0] - other[1][0], now[1] - other[1][1]))); // two fingers: pinch
    else { const k = cam.frustum.fov / Math.max(cv.clientWidth, cv.clientHeight); az += (now[0] - was[0]) * k; el = C.Math.clamp(el + (now[1] - was[1]) * k, rad(-89), rad(89)); } // the sky follows the finger
    touch.set(e.pointerId, now);
  });
  for (const ev of ['pointerup', 'pointercancel']) cv.addEventListener(ev, (e) => touch.delete(e.pointerId));
  cv.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY > 0 ? 1.1 : 0.9); }, { passive: false });
  // From the outer space the trip goes on to a world. Nothing flies here, so the autopilot takes the ship straight there.
  const bar = Object.assign(document.createElement('div'), { style: 'position:absolute;left:50%;bottom:14px;transform:translateX(-50%);z-index:5;display:flex;gap:8px' });
  for (const [to, name] of [['', 'la Tierra'], ['moon', 'la Luna'], ['mars', 'Marte']]) bar.append(Object.assign(document.createElement('button'), { type: 'button', textContent: `${T('Piloto automático a')} ${T(name)}`,
    onclick: () => { const u = new URL(location.href); if (to) u.searchParams.set('body', to); else u.searchParams.delete('body'); u.searchParams.set('land', '1'); location.href = u; } }));
  cv.parentElement.append(bar);
  OGE.toast('Cielo: arrastra para mirar alrededor y usa la rueda para acercar. El Sol y la Luna están donde se ven ahora.');
})();
