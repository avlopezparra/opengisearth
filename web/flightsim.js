// Simulador de vuelo al estilo del de Earth: vista de cabina con HUD, control por mouse o teclado y dos aviones.
// Mouse: clic toma o suelta la palanca; el cursor respecto del centro la mueve (hacia abajo = tirar = nariz arriba).
// Teclado: flechas palanca · RePág/AvPág (o W/S) gas · Mayús+←/→ (o Q/E) timón · F / Mayús+F flaps · G tren ·
// , . (o B) frenos · Inicio/Fin compensador · C centrar · Espacio pausa · H HUD · Esc salir.
(() => {
  const C = Cesium, { viewer, $ } = OGE;
  const scene = viewer.scene, rad = C.Math.toRadians, deg = C.Math.toDegrees, clamp = C.Math.clamp;
  const G = 9.81, R = 6371000, KT = 1.94384, FT = 3.28084, GEAR_H = 1.8;
  // vStall/vMax en m/s; thrust: aceleración a pleno gas (m/s²); roll/pitch/yaw: velocidades angulares máximas; agl y v0: arranque
  const PLANES = {
    sr22: { name: 'SR22 — avioneta de hélice, lenta y dócil', vStall: 31, vMax: 95, thrust: 3.2, roll: rad(45), pitch: rad(22), yaw: rad(12), agl: 600, v0: 70 },
    f16: { name: 'F-16 — caza a reacción, rápido y nervioso', vStall: 72, vMax: 420, thrust: 22, roll: rad(130), pitch: rad(38), yaw: rad(10), agl: 1500, v0: 220 },
  };
  const hud = $('hud'), g = hud.getContext('2d');
  let on = false, paused = false, mouseCtl = false, showHud = true, A = null, s = null, last = 0;
  const keys = new Set(), stick = { x: 0, y: 0 };

  async function open() {
    if (on) return stop();
    const v = await OGE.ask({ title: 'Simulador de vuelo', ok: 'Iniciar vuelo',
      help: 'Arranca en el aire sobre el punto que estás mirando. Mouse: clic toma o suelta la palanca. Teclado: flechas, RePág/AvPág para el gas, G tren, F flaps, Espacio pausa, Esc salir.',
      fields: [{ id: 'plane', label: 'Avión', type: 'select', options: Object.entries(PLANES).map(([k, p]) => [k, p.name]) },
        { id: 'mouse', label: 'Controlar con el mouse (como en Earth)', type: 'checkbox', value: true }] });
    if (v) start(v.plane, v.mouse);
  }
  function start(plane, useMouse) {
    A = PLANES[plane];
    const la = OGE.lookAt(), c = la ? la.carto : viewer.camera.positionCartographic; // sobre el punto mirado, no desde la órbita
    const ground = scene.globe.getHeight(c) || 0;
    s = { lon: c.longitude, lat: c.latitude, alt: ground + A.agl, heading: viewer.camera.heading, pitch: 0, roll: 0, v: A.v0, vs: 0,
      throttle: 0.7, flaps: 0, gear: false, brake: false, ail: 0, elev: 0, rud: 0, trim: 0, ground: false, agl: A.agl };
    on = true; paused = false; mouseCtl = !!useMouse; stick.x = stick.y = 0; keys.clear(); last = performance.now();
    if (OGE.activate) OGE.activate(null);
    if (OGE.setEdit) OGE.setEdit(false);
    scene.screenSpaceCameraController.enableInputs = false;
    document.body.classList.add('flying');
    hud.hidden = false;
    $('flyBtn').classList.add('active');
  }
  function stop(msg, error) {
    on = false;
    scene.screenSpaceCameraController.enableInputs = true;
    document.body.classList.remove('flying');
    hud.hidden = true;
    $('flyBtn').classList.remove('active');
    viewer.camera.setView({ orientation: { heading: viewer.camera.heading, pitch: Math.min(viewer.camera.pitch, rad(-20)), roll: 0 } }); // vista nivelada mirando al suelo
    if (msg) OGE.toast(msg, error);
  }

  // ---------- Mandos ----------
  function controls(dt) {
    const k = (x) => keys.has(x), ease = Math.min(1, 6 * dt), shift = k('shift');
    const lr = (k('arrowright') ? 1 : 0) - (k('arrowleft') ? 1 : 0), ud = (k('arrowdown') ? 1 : 0) - (k('arrowup') ? 1 : 0);
    if (mouseCtl) { s.ail = stick.x; s.elev = stick.y; } else { s.ail += ((shift ? 0 : lr) - s.ail) * ease; s.elev += (ud - s.elev) * ease; }
    const rud = (k('e') || k('enter') ? 1 : 0) - (k('q') || k('insert') ? 1 : 0) + (shift ? lr : 0);
    s.rud += (clamp(rud, -1, 1) - s.rud) * ease;
    if (k('pageup') || k('w')) s.throttle = Math.min(1, s.throttle + 0.5 * dt);
    if (k('pagedown') || k('s')) s.throttle = Math.max(0, s.throttle - 0.5 * dt);
    if (k('home')) s.trim = Math.max(-0.4, s.trim - 0.2 * dt);
    if (k('end')) s.trim = Math.min(0.4, s.trim + 0.2 * dt);
    s.brake = k(',') || k('.') || k('b');
  }

  // ---------- Física simplificada ----------
  function step(dt) {
    controls(dt);
    const stallV = A.vStall * (1 - 0.1 * s.flaps), q = clamp(s.v / (1.4 * A.vStall), 0, 1); // q: eficacia de los mandos con la velocidad
    const elev = clamp(s.elev + s.trim, -1, 1), ground = scene.globe.getHeight(new C.Cartographic(s.lon, s.lat)) || 0;
    const drag = A.thrust * (s.v / A.vMax) ** 2 * (1 + 0.35 * s.flaps + (s.gear ? 0.15 : 0)); // a pleno gas y nivelado se llega a vMax
    if (s.ground) { // rodaje: timón dirige, frenos frenan; se despega tirando con velocidad suficiente
      const canFly = s.v > stallV * 1.1;
      s.roll *= 1 - Math.min(1, 5 * dt);
      s.heading += s.rud * 0.6 * Math.min(1, s.v / 15) * dt;
      s.v = Math.max(0, s.v + (s.throttle * A.thrust - drag - 0.4 - (s.brake ? 7 : 0)) * dt);
      s.pitch = clamp(canFly ? s.pitch + elev * A.pitch * 0.5 * dt : s.pitch * (1 - Math.min(1, 3 * dt)), 0, rad(15));
      s.alt = ground + GEAR_H; s.vs = 0;
      if (canFly && s.pitch > rad(4)) s.ground = false;
    } else {
      const pr = elev * A.pitch * q * dt; // tirar de la palanca sube la nariz en el eje del avión: alabeado, vira
      s.roll = C.Math.negativePiToPi(s.roll + s.ail * A.roll * q * dt);
      s.pitch += pr * Math.cos(s.roll) - (1 - Math.cos(s.roll)) * (G / Math.max(s.v, 20)) * dt; // alabeado pierde sustentación: baja la nariz
      s.heading += pr * Math.sin(s.roll) + ((G * Math.sin(s.roll)) / Math.max(s.v, 20)) * dt + s.rud * A.yaw * q * dt;
      if (s.v < stallV) s.pitch -= rad(18) * dt; // pérdida
      s.pitch = clamp(s.pitch, rad(-89), rad(89));
      s.v = clamp(s.v + (s.throttle * A.thrust - drag - G * Math.sin(s.pitch)) * dt, 0, A.vMax * 1.3);
      s.vs = s.v * Math.sin(s.pitch);
      s.alt += s.vs * dt;
      if (s.alt <= ground + GEAR_H) { // toma de tierra suave con el tren abajo, o accidente
        if (!(s.gear && s.vs > -4 && Math.abs(s.roll) < rad(12) && s.pitch > rad(-6))) {
          return stop(`Accidente a ${Math.round(s.v * KT)} nudos.` + (s.gear ? '' : ' El tren estaba arriba (G lo baja).'), true);
        }
        s.ground = true; s.alt = ground + GEAR_H; s.pitch = Math.max(0, s.pitch);
      }
    }
    const horiz = s.v * Math.cos(s.pitch) * dt;
    s.lat = clamp(s.lat + (horiz * Math.cos(s.heading)) / R, rad(-89), rad(89));
    s.lon = C.Math.negativePiToPi(s.lon + (horiz * Math.sin(s.heading)) / (R * Math.cos(s.lat)));
    s.heading = C.Math.zeroToTwoPi(s.heading);
    s.agl = s.alt - ground;
    viewer.camera.setView({ destination: C.Cartesian3.fromRadians(s.lon, s.lat, s.alt), orientation: { heading: s.heading, pitch: s.pitch, roll: s.roll } });
  }

  // ---------- HUD ----------
  function draw() {
    const w = hud.clientWidth, h = hud.clientHeight, dpr = window.devicePixelRatio || 1;
    if (hud.width !== Math.round(w * dpr) || hud.height !== Math.round(h * dpr)) { hud.width = Math.round(w * dpr); hud.height = Math.round(h * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.36;
    g.strokeStyle = g.fillStyle = '#39ff14'; g.lineWidth = 1.6; g.shadowColor = '#000'; g.shadowBlur = 3;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const text = (t, x, y, size = 13, align = 'center') => { g.font = `600 ${size}px ui-monospace, monospace`; g.textAlign = align; g.fillText(t, x, y); };
    const line = (x1, y1, x2, y2) => { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
    if (paused) text(T('PAUSA — Espacio para seguir'), cx, cy - r - 46, 16);
    else if (s.ground) text(T('EN TIERRA'), cx, cy - r - 46, 16);
    else if (s.v < A.vStall * (1 - 0.1 * s.flaps)) text(T('PÉRDIDA — baja la nariz y da gas'), cx, cy - r - 46, 16);
    if (!showHud) return;
    const ppd = h / deg(viewer.camera.frustum.fovy || rad(60)), p0 = deg(s.pitch); // píxeles por grado de la vista

    // Escalera de cabeceo y aguja de alabeo: giran con el horizonte
    g.save(); g.translate(cx, cy); g.rotate(-s.roll);
    for (let a = -90; a <= 90; a += 10) {
      const y = (p0 - a) * ppd, half = a === 0 ? r * 0.95 : 62;
      if (Math.abs(y) > r * 0.8) continue;
      g.setLineDash(a < 0 ? [8, 6] : []);
      line(-half, y, -20, y); line(20, y, half, y);
      if (a) { text(Math.abs(a), -half - 16, y); text(Math.abs(a), half + 16, y); }
    }
    g.setLineDash([]);
    g.beginPath(); g.moveTo(0, -r + 2); g.lineTo(-7, -r + 15); g.lineTo(7, -r + 15); g.closePath(); g.stroke();
    g.restore();
    for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) { // escala fija de alabeo
      const t = rad(a - 90), l = a % 30 === 0 ? 14 : 8;
      line(cx + r * Math.cos(t), cy + r * Math.sin(t), cx + (r + l) * Math.cos(t), cy + (r + l) * Math.sin(t));
    }
    // Referencia del avión
    line(cx - 34, cy, cx - 12, cy); line(cx + 12, cy, cx + 34, cy); line(cx - 12, cy, cx, cy + 9); line(cx, cy + 9, cx + 12, cy);

    // Cinta de rumbo
    const hd = deg(s.heading), sc = (w * 0.28) / 30;
    for (let a = Math.ceil((hd - 30) / 5) * 5; a <= hd + 30; a += 5) {
      const x = cx + (a - hd) * sc, n = ((a % 360) + 360) % 360;
      line(x, 46, x, a % 10 === 0 ? 36 : 41);
      if (a % 10 === 0) text(n % 90 === 0 ? (OGE_LANG === 'en' ? 'NESW' : 'NESO')[n / 90] : String(n / 10).padStart(2, '0'), x, 24);
    }
    g.strokeRect(cx - 24, 52, 48, 20); text(String(Math.round(hd) % 360).padStart(3, '0'), cx, 63);
    line(cx, 46, cx, 52);

    // Velocidad (nudos) a la izquierda, altitud (pies) a la derecha
    const bx = Math.min(r + 70, cx - 60);
    g.strokeRect(cx - bx - 38, cy - 12, 76, 24); text(Math.round(s.v * KT) + ' KT', cx - bx, cy + 1, 14);
    g.strokeRect(cx + bx - 46, cy - 12, 92, 24); text(Math.round(s.alt * FT) + ' FT', cx + bx, cy + 1, 14);
    text((s.vs >= 0 ? '+' : '') + Math.round((s.vs * FT * 60) / 10) * 10 + ' FPM', cx + bx, cy + 26, 12);
    text(T('SUELO ') + Math.round(s.agl * FT) + ' FT', cx + bx, cy + 42, 12);

    // Motor y configuración (abajo a la izquierda)
    const x0 = 24, y0 = h - 40;
    g.strokeRect(x0, y0 - 100, 14, 100); g.fillRect(x0, y0 - 100 * s.throttle, 14, 100 * s.throttle);
    text(T('GAS ') + Math.round(s.throttle * 100) + '%', x0 + 24, y0 - 92, 12, 'left');
    text(T('FLAPS ') + s.flaps + '/2', x0 + 24, y0 - 74, 12, 'left');
    text(T('TREN ') + T(s.gear ? 'ABAJO' : 'ARRIBA'), x0 + 24, y0 - 56, 12, 'left');
    if (s.brake) text(T('FRENOS'), x0 + 24, y0 - 38, 12, 'left');
    if (Math.abs(s.trim) > 0.01) text(T('COMP ') + (s.trim > 0 ? '+' : '') + s.trim.toFixed(2), x0 + 24, y0 - 20, 12, 'left');

    // Posición de la palanca y del timón (abajo al centro)
    const jx = cx, jy = h - 76, js = 30;
    g.strokeRect(jx - js, jy - js, js * 2, js * 2);
    line(jx - 5 + s.ail * js, jy + s.elev * js, jx + 5 + s.ail * js, jy + s.elev * js); line(jx + s.ail * js, jy - 5 + s.elev * js, jx + s.ail * js, jy + 5 + s.elev * js);
    line(jx - js, jy + js + 8, jx + js, jy + js + 8); g.fillRect(jx + s.rud * js - 3, jy + js + 4, 6, 8);
    text(T(mouseCtl ? 'MOUSE: clic suelta la palanca' : 'TECLADO: clic para volar con el mouse'), cx, h - 22, 12);
    text(A.name.split(' — ')[0], w - 60, h - 22, 12);
  }

  scene.preRender.addEventListener(() => {
    if (!on) return;
    const t = performance.now(), dt = Math.min(0.1, (t - last) / 1000);
    last = t;
    if (!paused) step(dt);
    if (on) draw();
  });

  // ---------- Entradas ----------
  hud.addEventListener('mousemove', (e) => {
    if (!mouseCtl) return;
    const b = hud.getBoundingClientRect();
    stick.x = clamp((e.clientX - b.left - b.width / 2) / (b.width * 0.3), -1, 1);
    stick.y = clamp((e.clientY - b.top - b.height / 2) / (b.height * 0.3), -1, 1);
  });
  hud.addEventListener('click', () => { mouseCtl = !mouseCtl; stick.x = stick.y = 0; });
  document.addEventListener('keydown', (e) => {
    if (!on || document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') stop();
    else if (k === ' ') { paused = !paused; last = performance.now(); }
    else if (k === 'h') showHud = !showHud;
    else if (k === 'g') s.gear = !s.gear;
    else if (k === 'f' || k === ']' || k === '[') s.flaps = clamp(s.flaps + (e.shiftKey || k === '[' ? -1 : 1), 0, 2);
    else if (k === 'c') { stick.x = stick.y = 0; s.trim = 0; }
    else keys.add(k);
    e.preventDefault(); e.stopPropagation();
  }, true);
  document.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()), true);
  window.addEventListener('blur', () => keys.clear());
  $('flyBtn').onclick = open;
  OGE.flight = { start, stop, state: () => s, flying: () => on };
})();
