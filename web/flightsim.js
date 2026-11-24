// Flight simulator in the style of Earth's: cockpit view with HUD, mouse or keyboard control and two aircraft.
// Mouse: a click grabs or releases the stick; the cursor relative to the center moves it (down = pull = nose up).
// Keyboard: arrows (or W/S) stick · PgUp/PgDn (or E/Q) throttle · A/D (or Shift+←/→) rudder · K key list · F / Shift+F flaps · G gear ·
// A/D also turn (rudder) · T turbo · , . (or B) brakes · Home/End trim · C center · Space pause · H HUD · Esc exit. Starship: X or right click fires.
(() => {
  const C = Cesium, { viewer, $ } = OGE;
  const scene = viewer.scene, rad = C.Math.toRadians, deg = C.Math.toDegrees, clamp = C.Math.clamp;
  const G = 9.81, R = 6371000, KT = 1.94384, FT = 3.28084, GEAR_H = 1.8;
  // vStall/vMax in m/s; thrust: acceleration at full throttle (m/s²); roll/pitch/yaw: maximum angular rates; agl and v0: start
  const PLANES = {
    sr22: { name: 'SR22 — avioneta de hélice, lenta y dócil', vStall: 31, vMax: 95, thrust: 3.2, roll: rad(45), pitch: rad(22), yaw: rad(20), agl: 600, v0: 70 },
    f16: { name: 'F-16 — caza a reacción, rápido y nervioso', vStall: 72, vMax: 420, thrust: 22, roll: rad(130), pitch: rad(38), yaw: rad(18), agl: 1500, v0: 220 },
    // ship: no stall and no gravity (it hovers and climbs to space), bounces off the ground instead of crashing, and fires
    ship: { name: 'Starship — nave muy rápida con láseres; flota y sube al espacio', ship: true, vStall: 0, vMax: 8000, thrust: 400, roll: rad(160), pitch: rad(50), yaw: rad(35), agl: 3000, v0: 600 },
  };
  const hud = $('hud'), g = hud.getContext('2d');
  let on = false, paused = false, mouseCtl = false, showHud = true, A = null, s = null, last = 0;
  const WARPS = [1, 2, 5, 10, 25];
  let warp = 1; // turbo: multiplies the distance covered, to cross long stretches quickly
  const setWarp = (v) => { warp = v; $('flyWarp').textContent = 'Turbo ×' + v + ' (T)'; $('flyWarp').classList.toggle('active', v > 1); };
  const keys = new Set(), stick = { x: 0, y: 0 };

  // ---------- Starship lasers: bolts on the HUD, a flash where the aim hits the ground, and a short sound ----------
  let shots = [], audio = null;
  function fire() {
    const t = performance.now();
    if (!on || paused || !A.ship || (shots.length && t - shots[shots.length - 1] < 110)) return;
    shots.push(t);
    const hit = scene.globe.pick(viewer.camera.getPickRay(new C.Cartesian2(hud.clientWidth / 2, hud.clientHeight / 2)), scene);
    if (hit && C.Cartesian3.distance(hit, viewer.camera.positionWC) < 4e5) {
      const e = viewer.entities.add({ position: hit, point: { pixelSize: 16, color: C.Color.ORANGE, outlineColor: C.Color.YELLOW, outlineWidth: 4, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
      e._tmp = true; // not a user feature: never saved
      setTimeout(() => viewer.entities.remove(e), 450);
    }
    beep(1100, 180, 0.16);
    if (!arcade) return;
    const cam = viewer.camera, to = new C.Cartesian3(); // an enemy inside the aim cone is destroyed
    let best = null, bestAng = 9;
    for (const o of objs) {
      if (o.kind !== 'enemy') continue;
      C.Cartesian3.subtract(o.p, cam.positionWC, to);
      const d = C.Cartesian3.magnitude(to), ang = Math.acos(clamp(C.Cartesian3.dot(to, cam.directionWC) / d, -1, 1));
      if (ang < Math.atan((o.size * 1.5) / d) + rad(1.2) && ang < bestAng) { best = o; bestAng = ang; }
    }
    if (best) { objs.splice(objs.indexOf(best), 1); score += 100; booms.push({ p: best.p, t: performance.now() }); beep(300, 60, 0.3); }
  }
  function beep(f0, f1, dur) {
    try {
      audio = audio || new AudioContext();
      const o = audio.createOscillator(), v = audio.createGain(), now = audio.currentTime;
      o.type = 'sawtooth'; o.frequency.setValueAtTime(f0, now); o.frequency.exponentialRampToValueAtTime(f1, now + dur);
      v.gain.setValueAtTime(0.06, now); v.gain.exponentialRampToValueAtTime(0.001, now + dur);
      o.connect(v).connect(audio.destination); o.start(now); o.stop(now + dur + 0.01);
    } catch { /* no audio device: the game still works */ }
  }

  // ---------- Starship arcade: random enemies to shoot, rings to fly through and coins to collect ----------
  // The objects live in the 3D world and are drawn on the HUD at their projected position and size.
  let arcade = false, objs = [], booms = [], score = 0, coins = 0;
  const SIZE = { ring: 1, coin: 0.35, enemy: 0.5 };
  const reach = () => Math.max(4000, s.v * warp * 7); // they appear about 7 s ahead, whatever the speed
  function spawn() {
    const cam = viewer.camera, D = reach() * (0.6 + 0.6 * Math.random()), kind = ['ring', 'coin', 'coin', 'enemy', 'enemy'][Math.floor(Math.random() * 5)];
    const p = C.Cartesian3.clone(cam.positionWC), add = (v, k) => C.Cartesian3.add(p, C.Cartesian3.multiplyByScalar(v, k, new C.Cartesian3()), p);
    add(cam.directionWC, D); add(cam.rightWC, (Math.random() - 0.5) * D * 0.5); add(cam.upWC, (Math.random() - 0.5) * D * 0.25);
    const c = C.Cartographic.fromCartesian(p), floor = (scene.globe.getHeight(c) || 0) + 200;
    if (c.height < floor) C.Cartesian3.fromRadians(c.longitude, c.latitude, floor, undefined, p); // never underground
    objs.push({ kind, p, size: D * 0.06 * SIZE[kind] }); // sized for the speed it was created at
  }
  function arcadeStep() {
    const cam = viewer.camera, t = new C.Cartesian3(), far = reach() * 2.5, slack = s.v * warp * 0.03; // slack: distance covered in one frame
    objs = objs.filter((o) => {
      C.Cartesian3.subtract(o.p, cam.positionWC, t);
      const d = C.Cartesian3.magnitude(t);
      if (d < o.size * (o.kind === 'ring' ? 1 : 1.6) + slack) { // touched: rings and coins score, ramming an enemy costs points
        if (o.kind === 'enemy') { if (!(man && man.type === 'roll')) { score = Math.max(0, score - 50); beep(200, 80, 0.25); } } // a barrel roll deflects it
        else { score += o.kind === 'ring' ? 50 : 10; if (o.kind === 'coin') coins++; beep(o.kind === 'coin' ? 1500 : 800, o.kind === 'coin' ? 2200 : 1300, 0.12); }
        return false;
      }
      return C.Cartesian3.dot(t, cam.directionWC) > -o.size && d < far; // left behind or too far: replaced by a new one
    });
    while (objs.length < 7) spawn();
  }
  function drawArcade(w, h, text) {
    const f = h / 2 / Math.tan((viewer.camera.frustum.fovy || rad(60)) / 2), toWin = C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates, now = performance.now();
    for (const o of objs) {
      const q = toWin(scene, o.p);
      if (!q) continue; // behind the camera
      const pr = Math.max(4, (o.size / C.Cartesian3.distance(o.p, viewer.camera.positionWC)) * f);
      g.save(); g.shadowBlur = 8; g.beginPath();
      if (o.kind === 'ring') { g.strokeStyle = g.shadowColor = '#ffd60a'; g.lineWidth = Math.max(2, pr * 0.12); g.arc(q.x, q.y, pr, 0, 7); g.stroke(); }
      else if (o.kind === 'coin') { g.fillStyle = g.shadowColor = '#ffcc00'; g.ellipse(q.x, q.y, pr * Math.abs(Math.cos(now / 300)) + 1, pr, 0, 0, 7); g.fill(); } // spinning
      else { g.fillStyle = g.shadowColor = '#ff453a'; g.moveTo(q.x, q.y - pr); g.lineTo(q.x + pr * 1.3, q.y); g.lineTo(q.x, q.y + pr * 0.5); g.lineTo(q.x - pr * 1.3, q.y); g.closePath(); g.fill(); }
      g.restore();
    }
    booms = booms.filter((b) => now - b.t < 350);
    for (const b of booms) { // explosion where an enemy was hit
      const q = toWin(scene, b.p), k = (now - b.t) / 350;
      if (!q) continue;
      g.save(); g.strokeStyle = g.shadowColor = '#ff9f0a'; g.shadowBlur = 14; g.lineWidth = 6 * (1 - k) + 1; g.beginPath(); g.arc(q.x, q.y, 10 + 50 * k, 0, 7); g.stroke(); g.restore();
    }
    text(`${T('PUNTOS')} ${score}  ·  ${T('MONEDAS')} ${coins}`, 24, 26, 16, 'left');
  }

  async function open() {
    if (on) return stop();
    const v = await OGE.ask({ title: 'Simulador de vuelo', ok: 'Iniciar vuelo',
      help: 'Arranca en el aire sobre el punto que estás mirando. Mouse: clic toma o suelta la palanca. Teclado: flechas, RePág/AvPág para el gas, G tren, F flaps, Espacio pausa, Esc salir. Starship: X o clic derecho dispara.',
      fields: [{ id: 'plane', label: 'Avión', type: 'select', options: Object.entries(PLANES).map(([k, p]) => [k, p.name]) },
        { id: 'mouse', label: 'Controlar con el mouse (como en Earth)', type: 'checkbox', value: true },
        { id: 'arcade', label: 'Starship: modo arcade (enemigos, aros y monedas)', type: 'checkbox', value: true }] });
    if (v) start(v.plane, v.mouse, v.arcade);
  }
  function start(plane, useMouse, useArcade = true) {
    A = PLANES[plane];
    man = null;
    arcade = !!A.ship && !!useArcade; objs = []; booms = []; score = coins = 0;
    const la = OGE.lookAt(), c = la ? la.carto : viewer.camera.positionCartographic; // above the look-at point, not from orbit
    const ground = scene.globe.getHeight(c) || 0;
    s = { lon: c.longitude, lat: c.latitude, alt: ground + A.agl, heading: viewer.camera.heading, pitch: 0, roll: 0, v: A.v0, vs: 0,
      throttle: 0.7, flaps: 0, gear: false, brake: false, ail: 0, elev: 0, rud: 0, trim: 0, ground: false, agl: A.agl };
    setWarp(1);
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
    if (arcade && !msg && score) msg = `Vuelo terminado: ${score} puntos y ${coins} monedas.`;
    scene.screenSpaceCameraController.enableInputs = true;
    document.body.classList.remove('flying');
    hud.hidden = true;
    $('flyKeys').hidden = true;
    $('flyBtn').classList.remove('active');
    viewer.camera.setView({ orientation: { heading: viewer.camera.heading, pitch: Math.min(viewer.camera.pitch, rad(-20)), roll: 0 } }); // level view looking at the ground
    if (msg) OGE.toast(msg, error);
  }

  // ---------- Controls ----------
  function controls(dt) {
    const k = (x) => keys.has(x), ease = Math.min(1, 6 * dt), shift = k('shift');
    const lr = (k('arrowright') ? 1 : 0) - (k('arrowleft') ? 1 : 0), ud = (k('arrowdown') || k('s') ? 1 : 0) - (k('arrowup') || k('w') ? 1 : 0);
    if (mouseCtl) { s.ail = stick.x; s.elev = stick.y; } else { s.ail += ((shift ? 0 : lr) - s.ail) * ease; s.elev += (ud - s.elev) * ease; }
    const rud = (k('d') || k('enter') ? 1 : 0) - (k('a') || k('insert') ? 1 : 0) + (shift ? lr : 0);
    s.rud += (clamp(rud, -1, 1) - s.rud) * ease;
    if (k('pageup') || k('e')) s.throttle = Math.min(1, s.throttle + 0.8 * dt);
    if (k('pagedown') || k('q')) s.throttle = Math.max(0, s.throttle - 0.8 * dt);
    if (k('home')) s.trim = Math.max(-0.4, s.trim - 0.2 * dt);
    if (k('end')) s.trim = Math.min(0.4, s.trim + 0.2 * dt);
    s.brake = k(',') || k('.') || k('b');
  }

  // ---------- Simplified physics ----------
  // Starship maneuvers: barrel roll (R), full loop (V) and half loop with a roll out, to turn back (U).
  let man = null, lastRoll = 1; // man: { type, t0, dur, dir }
  function maneuver(type) {
    if (!on || paused || !A.ship || man) return;
    const dir = keys.has('a') ? -1 : keys.has('d') ? 1 : (lastRoll = -lastRoll);
    man = { type, t0: performance.now(), dur: type === 'roll' ? 600 : type === 'loop' ? 2400 : 1500, dir };
    beep(500, 1200, 0.25);
  }
  function step(dt) {
    controls(dt);
    let pe = s.pitch, rollOff = 0; // effective pitch and extra roll while a maneuver runs
    if (man) {
      const k = (performance.now() - man.t0) / man.dur;
      if (k >= 1) { // the half loop ends inverted and flying back: same attitude as heading + 180° rolled over, then it rolls upright
        if (man.type === 'uturn') { s.heading += Math.PI; s.pitch = -s.pitch; pe = s.pitch; rollOff = Math.PI; man = { type: 'unroll', t0: performance.now(), dur: 500, dir: 1 }; } else man = null;
      } else if (man.type === 'roll') rollOff = man.dir * 2 * Math.PI * k;
      else if (man.type === 'unroll') rollOff = Math.PI * (1 - k);
      else pe += (man.type === 'loop' ? 2 : 1) * Math.PI * k;
    }
    const stallV = A.vStall * (1 - 0.1 * s.flaps), q = A.ship ? 1 : clamp(s.v / (1.4 * A.vStall), 0, 1); // q: control effectiveness with speed
    const grav = A.ship ? 0 : G;
    const elev = clamp(s.elev + s.trim, -1, 1), ground = scene.globe.getHeight(new C.Cartographic(s.lon, s.lat)) || 0;
    const drag = A.thrust * (s.v / A.vMax) ** 2 * (1 + 0.35 * s.flaps + (s.gear ? 0.15 : 0)); // at full throttle and level, vMax is reached
    if (s.ground) { // taxiing: rudder steers, brakes brake; takeoff by pulling with enough speed
      const canFly = s.v > stallV * 1.1;
      s.roll *= 1 - Math.min(1, 5 * dt);
      s.heading += s.rud * 0.6 * Math.min(1, s.v / 15) * dt;
      s.v = Math.max(0, s.v + (s.throttle * A.thrust - drag - 0.4 - (s.brake ? 7 : 0)) * dt);
      s.pitch = clamp(canFly ? s.pitch + elev * A.pitch * 0.5 * dt : s.pitch * (1 - Math.min(1, 3 * dt)), 0, rad(15));
      s.alt = ground + GEAR_H; s.vs = 0;
      if (canFly && s.pitch > rad(4)) s.ground = false;
    } else {
      const pr = elev * A.pitch * q * dt; // pulling the stick raises the nose in the aircraft's axis: when banked, it turns
      s.roll = C.Math.negativePiToPi(s.roll + s.ail * A.roll * q * dt);
      s.pitch += pr * Math.cos(s.roll) - (1 - Math.cos(s.roll)) * (grav / Math.max(s.v, 20)) * dt; // when banked it loses lift: the nose drops
      s.heading += pr * Math.sin(s.roll) + ((G * Math.sin(s.roll)) / Math.max(s.v, 20)) * dt + s.rud * A.yaw * q * dt;
      if (s.v < stallV) s.pitch -= rad(18) * dt; // stall
      s.pitch = clamp(s.pitch, rad(-89), rad(89));
      s.v = clamp(s.v + (s.throttle * A.thrust - drag - grav * Math.sin(s.pitch)) * dt, 0, A.vMax * 1.3);
      s.vs = s.v * Math.sin(pe);
      s.alt += s.vs * dt * warp;
      if (A.ship && s.alt <= ground + 30) { s.alt = ground + 30; s.pitch = Math.max(s.pitch, rad(2)); } // the starship skims the ground
      else if (s.alt <= ground + GEAR_H) { // soft touchdown with the gear down, or crash
        if (!(s.gear && s.vs > -4 && Math.abs(s.roll) < rad(12) && s.pitch > rad(-6))) {
          return stop(`Accidente a ${Math.round(s.v * KT)} nudos.` + (s.gear ? '' : ' El tren estaba arriba (G lo baja).'), true);
        }
        s.ground = true; s.alt = ground + GEAR_H; s.pitch = Math.max(0, s.pitch);
      }
    }
    const horiz = s.v * Math.cos(pe) * dt * warp; // negative over the top of a loop: it flies backwards
    s.lat = clamp(s.lat + (horiz * Math.cos(s.heading)) / R, rad(-89), rad(89));
    s.lon = C.Math.negativePiToPi(s.lon + (horiz * Math.sin(s.heading)) / (R * Math.cos(s.lat)));
    s.heading = C.Math.zeroToTwoPi(s.heading);
    s.agl = s.alt - ground;
    viewer.camera.setView({ destination: C.Cartesian3.fromRadians(s.lon, s.lat, s.alt), orientation: { heading: s.heading, pitch: pe, roll: s.roll + rollOff } });
    if (arcade) arcadeStep();
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
    if (arcade) drawArcade(w, h, text);
    shots = shots.filter((t0) => performance.now() - t0 < 220);
    for (const t0 of shots) { // two bolts converging on the aim point
      const a = (performance.now() - t0) / 220, b = Math.min(1, a + 0.3);
      g.save(); g.strokeStyle = '#ff3b30'; g.shadowColor = '#ff3b30'; g.shadowBlur = 12; g.lineWidth = 5 * (1 - a) + 1; g.lineCap = 'round';
      for (const sx of [cx - w * 0.38, cx + w * 0.38]) line(sx + (cx - sx) * a, h + (cy - h) * a, sx + (cx - sx) * b, h + (cy - h) * b);
      g.restore();
    }
    if (!showHud) return;
    const ppd = h / deg(viewer.camera.frustum.fovy || rad(60)), p0 = deg(s.pitch); // pixels per degree of the view

    // Pitch ladder and bank pointer: they rotate with the horizon
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
    for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) { // fixed bank scale
      const t = rad(a - 90), l = a % 30 === 0 ? 14 : 8;
      line(cx + r * Math.cos(t), cy + r * Math.sin(t), cx + (r + l) * Math.cos(t), cy + (r + l) * Math.sin(t));
    }
    // Aircraft reference
    line(cx - 34, cy, cx - 12, cy); line(cx + 12, cy, cx + 34, cy); line(cx - 12, cy, cx, cy + 9); line(cx, cy + 9, cx + 12, cy);

    // Heading tape
    const hd = deg(s.heading), sc = (w * 0.28) / 30;
    for (let a = Math.ceil((hd - 30) / 5) * 5; a <= hd + 30; a += 5) {
      const x = cx + (a - hd) * sc, n = ((a % 360) + 360) % 360;
      line(x, 46, x, a % 10 === 0 ? 36 : 41);
      if (a % 10 === 0) text(n % 90 === 0 ? (OGE_LANG === 'en' ? 'NESW' : 'NESO')[n / 90] : String(n / 10).padStart(2, '0'), x, 24);
    }
    g.strokeRect(cx - 24, 52, 48, 20); text(String(Math.round(hd) % 360).padStart(3, '0'), cx, 63);
    line(cx, 46, cx, 52);

    // Speed (knots) on the left, altitude (feet) on the right
    const bx = Math.min(r + 70, cx - 60);
    g.strokeRect(cx - bx - 38, cy - 12, 76, 24); text(Math.round(s.v * warp * KT) + ' KT', cx - bx, cy + 1, 14); // the turbo counts as speed
    g.strokeRect(cx + bx - 46, cy - 12, 92, 24); text(Math.round(s.alt * FT) + ' FT', cx + bx, cy + 1, 14);
    text((s.vs >= 0 ? '+' : '') + Math.round((s.vs * FT * 60) / 10) * 10 + ' FPM', cx + bx, cy + 26, 12);
    text(T('SUELO ') + Math.round(s.agl * FT) + ' FT', cx + bx, cy + 42, 12);

    // Engine and configuration (bottom left)
    const x0 = 24, y0 = h - 40;
    g.strokeRect(x0, y0 - 100, 14, 100); g.fillRect(x0, y0 - 100 * s.throttle, 14, 100 * s.throttle);
    text(T('GAS ') + Math.round(s.throttle * 100) + '%', x0 + 24, y0 - 92, 12, 'left');
    text(T('FLAPS ') + s.flaps + '/2', x0 + 24, y0 - 74, 12, 'left');
    text(T('TREN ') + T(s.gear ? 'ABAJO' : 'ARRIBA'), x0 + 24, y0 - 56, 12, 'left');
    if (s.brake) text(T('FRENOS'), x0 + 24, y0 - 38, 12, 'left');
    if (Math.abs(s.trim) > 0.01) text(T('COMP ') + (s.trim > 0 ? '+' : '') + s.trim.toFixed(2), x0 + 24, y0 - 20, 12, 'left');

    // Stick and rudder position (bottom center)
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

  // ---------- Inputs ----------
  hud.addEventListener('mousemove', (e) => {
    if (!mouseCtl) return;
    const b = hud.getBoundingClientRect();
    stick.x = clamp((e.clientX - b.left - b.width / 2) / (b.width * 0.3), -1, 1);
    stick.y = clamp((e.clientY - b.top - b.height / 2) / (b.height * 0.3), -1, 1);
  });
  hud.addEventListener('click', () => { mouseCtl = !mouseCtl; stick.x = stick.y = 0; });
  hud.addEventListener('contextmenu', (e) => { e.preventDefault(); fire(); });
  document.addEventListener('keydown', (e) => {
    if (!on || document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') stop();
    else if (k === ' ') { paused = !paused; last = performance.now(); }
    else if (k === 'h') showHud = !showHud;
    else if (k === 'g') s.gear = !s.gear;
    else if (k === 'f' || k === ']' || k === '[') s.flaps = clamp(s.flaps + (e.shiftKey || k === '[' ? -1 : 1), 0, 2);
    else if (k === 'c') { stick.x = stick.y = 0; s.trim = 0; }
    else if (k === 'x') fire();
    else if (k === 't') nextWarp();
    else if (A.ship && (k === 'r' || k === 'v' || k === 'u')) maneuver(k === 'r' ? 'roll' : k === 'v' ? 'loop' : 'uturn');
    else if (k === 'k') $('flyKeys').hidden = !$('flyKeys').hidden;
    else keys.add(k);
    e.preventDefault(); e.stopPropagation();
  }, true);
  document.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()), true);
  window.addEventListener('blur', () => keys.clear());
  const nextWarp = () => setWarp(WARPS[(WARPS.indexOf(warp) + 1) % WARPS.length]);
  $('flyWarp').onclick = nextWarp;
  $('flyHelp').onclick = () => { $('flyKeys').hidden = !$('flyKeys').hidden; };
  for (const [id, key] of [['flyUp', 'pageup'], ['flyDown', 'pagedown'], ['flyLeft', 'a'], ['flyRight', 'd']]) { // held down like the keys
    const b = $(id);
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); keys.add(key);
      if (s && key.startsWith('page')) s.throttle = clamp(s.throttle + (key === 'pageup' ? 0.1 : -0.1), 0, 1); // a short tap also counts
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => keys.delete(key));
  }
  $('flyBtn').onclick = open;
  OGE.flight = { start, stop, maneuver, state: () => s, flying: () => on, game: () => ({ score, coins, objs }) };
})();
