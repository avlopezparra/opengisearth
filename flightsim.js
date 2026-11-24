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
  const WARPS = [1, 2, 5, 10, 25, 50, 100];
  let warp = 1; // turbo: multiplies the distance covered, to cross long stretches quickly
  const setWarp = (v) => { warp = v; $('flyWarp').textContent = 'Turbo ×' + v + ' ▲ (T)'; $('flyWarp').classList.toggle('active', v > 1); };
  const TURNS = [1, 2, 3, 5];
  let turn = +localStorage.getItem('oge.flyTurn') || 1; // multiplies how fast A/D turn
  const setTurn = (v) => { turn = v; localStorage.setItem('oge.flyTurn', v); $('flyTurn').textContent = T('Giro') + ' ×' + v + ' (N)'; $('flyTurn').classList.toggle('active', v > 1); };
  const keys = new Set(), stick = { x: 0, y: 0 };

  // ---------- Starship lasers: bolts on the HUD, a flash where the aim hits the ground, and a short sound ----------
  let shots = [], audio = null;
  function fire() {
    const t = performance.now();
    if (on && !A.ship) return OGE.toast('Disparar y las maniobras son solo de la Starship.');
    if (!on || paused || (shots.length && t - shots[shots.length - 1] < 110)) return;
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
  let hp = 100, bombs = 3, incoming = [], flash = 0, hit = 0; // incoming: enemy shots { p, vel, t }; flash/hit: time of the last bomb / damage
  const SIZE = { ring: 1, coin: 0.35, enemy: 0.5, wall: 0.6, heart: 0.4, shield: 0.4, bomb: 0.4 };
  let shields = 0, broke = 0; // each shield absorbs one hit and breaks; broke: when the last one broke
  const reach = () => Math.max(4000, s.v * warp * 7); // they appear about 7 s ahead, whatever the speed
  function spawn() {
    const cam = viewer.camera, D = reach() * (0.6 + 0.6 * Math.random()), kind = ['ring', 'coin', 'coin', 'coin', 'enemy', 'enemy', 'enemy', 'wall', 'wall', 'heart', 'shield', 'bomb'][Math.floor(Math.random() * 12)]; // hearts, shields and bombs are rare
    const p = C.Cartesian3.clone(cam.positionWC), add = (v, k) => C.Cartesian3.add(p, C.Cartesian3.multiplyByScalar(v, k, new C.Cartesian3()), p);
    add(cam.directionWC, D); add(cam.rightWC, (Math.random() - 0.5) * D * 0.5); add(cam.upWC, (Math.random() - 0.5) * D * 0.25);
    const c = C.Cartographic.fromCartesian(p), floor = (scene.globe.getHeight(c) || 0) + 200;
    if (c.height < floor) C.Cartesian3.fromRadians(c.longitude, c.latitude, floor, undefined, p); // never underground
    objs.push({ kind, p, size: D * 0.06 * SIZE[kind], next: performance.now() + 3000 + Math.random() * 4000 }); // sized for the speed it was created at; next: when an enemy fires
  }
  function hurt(n) {
    if (shields) { shields--; broke = hit = performance.now(); return beep(1400, 300, 0.2); } // the shield takes the hit and breaks
    hp -= n; hit = performance.now(); beep(200, 80, 0.25);
    if (hp <= 0) stop(`Nave destruida: ${score} puntos y ${coins} monedas.`, true);
  }
  function bomb() { // clears every enemy and shot in range
    if (!on || paused || !arcade) return;
    if (!bombs) return OGE.toast('Sin bombas: cada 10 monedas ganas una.');
    const cam = viewer.camera, R = reach() * 1.3;
    bombs--; incoming = []; flash = performance.now(); beep(160, 40, 0.6);
    objs = objs.filter((o) => {
      if (o.kind !== 'enemy' || C.Cartesian3.distance(o.p, cam.positionWC) > R) return true;
      score += 100; booms.push({ p: o.p, t: flash });
      return false;
    });
  }
  function arcadeStep(dt) {
    const cam = viewer.camera, t = new C.Cartesian3(), far = reach() * 2.5, eff = s.v * warp, slack = eff * 0.03, now = performance.now(); // slack: distance covered in one frame
    const rolling = man && man.type === 'roll'; // a barrel roll deflects enemies and shots
    objs = objs.filter((o) => {
      C.Cartesian3.subtract(o.p, cam.positionWC, t);
      const d = C.Cartesian3.magnitude(t);
      if (d < o.size * (o.kind === 'ring' ? 1 : 1.6) + slack) { // touched
        if (o.kind === 'enemy') { if (!rolling) hurt(25); }
        else if (o.kind === 'wall') hurt(20); // obstacles always hurt
        else if (o.kind === 'heart') { hp = Math.min(100, hp + 25); beep(600, 1600, 0.25); }
        else if (o.kind === 'shield') { shields = Math.min(3, shields + 1); beep(500, 1000, 0.25); }
        else if (o.kind === 'bomb') { bombs++; beep(400, 900, 0.25); }
        else {
          score += o.kind === 'ring' ? 50 : 10;
          if (o.kind === 'ring') hp = Math.min(100, hp + 10); // rings repair the ship
          else if (++coins % 10 === 0) bombs++;
          beep(o.kind === 'coin' ? 1500 : 800, o.kind === 'coin' ? 2200 : 1300, 0.12);
        }
        return false;
      }
      const gone = C.Cartesian3.dot(t, cam.directionWC) < -o.size; // left behind
      if (gone && o.kind === 'ring' && on) hurt(5); // a ring that was not flown through costs life
      return !gone && d < far;
    });
    if (!on) return; // destroyed
    for (const o of objs) { // enemies fire at where the ship will be if it keeps flying straight
      if (o.kind !== 'enemy' || now < o.next) continue;
      o.next = now + 4000 + Math.random() * 4000;
      const d = C.Cartesian3.distance(o.p, cam.positionWC), speed = eff * 0.5 + 600, tt = d / (speed + eff);
      if (d > reach() * 1.3 || C.Cartesian3.dot(C.Cartesian3.subtract(o.p, cam.positionWC, t), cam.directionWC) < 0) continue;
      const target = C.Cartesian3.add(cam.positionWC, C.Cartesian3.multiplyByScalar(cam.directionWC, eff * tt, new C.Cartesian3()), new C.Cartesian3());
      incoming.push({ p: C.Cartesian3.clone(o.p), vel: C.Cartesian3.multiplyByScalar(C.Cartesian3.subtract(target, o.p, t), 1 / tt, new C.Cartesian3()), t: now });
    }
    incoming = incoming.filter((b) => {
      C.Cartesian3.add(b.p, C.Cartesian3.multiplyByScalar(b.vel, dt, t), b.p);
      if (C.Cartesian3.distance(b.p, cam.positionWC) < 40 + slack * 1.5) { if (!rolling) hurt(8); return false; }
      return now - b.t < 8000;
    });
    while (on && objs.length < 7) spawn();
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
      else if (o.kind === 'shield') { g.strokeStyle = g.shadowColor = '#0a84ff'; g.fillStyle = 'rgba(10,132,255,.35)'; g.lineWidth = Math.max(2, pr * 0.15); for (let a = 0; a < 6; a++) g.lineTo(q.x + pr * Math.sin((a * Math.PI) / 3), q.y - pr * Math.cos((a * Math.PI) / 3)); g.closePath(); g.fill(); g.stroke(); }
      else if (o.kind === 'bomb') { g.shadowColor = '#ff9f0a'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = Math.max(12, pr * 2) + 'px sans-serif'; g.fillText('💣', q.x, q.y); }
      else if (o.kind === 'heart') { g.fillStyle = g.shadowColor = '#ff2d55'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = Math.max(12, pr * 2) + 'px sans-serif'; g.fillText('♥', q.x, q.y); }
      else if (o.kind === 'wall') { g.fillStyle = 'rgba(120,130,150,.85)'; g.strokeStyle = g.shadowColor = '#e5e5ea'; g.lineWidth = 2; g.rect(q.x - pr, q.y - pr * 0.6, pr * 2, pr * 1.2); g.fill(); g.stroke(); }
      else { g.fillStyle = g.shadowColor = '#ff453a'; g.moveTo(q.x, q.y - pr); g.lineTo(q.x + pr * 1.3, q.y); g.lineTo(q.x, q.y + pr * 0.5); g.lineTo(q.x - pr * 1.3, q.y); g.closePath(); g.fill(); }
      g.restore();
    }
    booms = booms.filter((b) => now - b.t < 350);
    for (const b of booms) { // explosion where an enemy was hit
      const q = toWin(scene, b.p), k = (now - b.t) / 350;
      if (!q) continue;
      g.save(); g.strokeStyle = g.shadowColor = '#ff9f0a'; g.shadowBlur = 14; g.lineWidth = 6 * (1 - k) + 1; g.beginPath(); g.arc(q.x, q.y, 10 + 50 * k, 0, 7); g.stroke(); g.restore();
    }
    for (const b of incoming) { // enemy shots
      const q = toWin(scene, b.p);
      if (!q) continue;
      g.save(); g.fillStyle = g.shadowColor = '#ff2df5'; g.shadowBlur = 10; g.beginPath(); g.arc(q.x, q.y, Math.max(3, (60 / C.Cartesian3.distance(b.p, viewer.camera.positionWC)) * f), 0, 7); g.fill(); g.restore();
    }
    const fade = (t0, ms, color) => { const k = (now - t0) / ms; if (k < 1) { g.save(); g.globalAlpha = 0.5 * (1 - k); g.fillStyle = color; g.fillRect(0, 0, w, h); g.restore(); } };
    fade(flash, 450, '#fff'); fade(hit, 250, broke === hit ? '#0a84ff' : '#f00'); // bomb / shield broken / damage
    if (shields) { g.save(); g.strokeStyle = 'rgba(10,132,255,.55)'; g.lineWidth = 3 * shields; g.beginPath(); g.ellipse(w / 2, h / 2, w * 0.46, h * 0.46, 0, 0, 7); g.stroke(); g.restore(); } // shield around the view, thicker with more layers
    text(`${T('PUNTOS')} ${score}  ·  ${T('MONEDAS')} ${coins}  ·  ${T('BOMBAS')} ${bombs}`, 24, 96, 16, 'left'); // below the heading tape
    g.save(); g.strokeRect(24, 110, 180, 12); g.fillStyle = hp > 50 ? '#39ff14' : hp > 25 ? '#ffd60a' : '#ff453a'; g.fillRect(24, 110, 1.8 * Math.max(0, hp), 12); g.restore();
    text(`${T('VIDA')} ${Math.max(0, Math.round(hp))}  ·  ${T('ESCUDOS')} ${shields}/3`, 212, 117, 12, 'left');
  }

  async function open() {
    if (on) return stop();
    const v = await OGE.ask({ title: 'Simulador de vuelo', ok: 'Iniciar vuelo',
      help: 'Arranca en el aire sobre el punto que estás mirando. Mouse: clic toma o suelta la palanca. Teclado: flechas, RePág/AvPág para el gas, G tren, F flaps, Espacio pausa, Esc salir. Starship: X o clic derecho dispara.',
      fields: [{ id: 'plane', label: 'Avión', type: 'select', options: Object.entries(PLANES).map(([k, p]) => [k, p.name]) },
        { id: 'mouse', label: 'Controlar con el mouse (como en Earth)', type: 'checkbox', value: true },
        { id: 'arcade', label: 'Starship: modo arcade con enemigos y puntaje (desmárcalo para volar libre)', type: 'checkbox', value: true }] });
    if (v) start(v.plane, v.mouse, v.arcade);
  }
  function start(plane, useMouse, useArcade = true) {
    A = PLANES[plane];
    man = null;
    loadCaps();
    arcade = !!A.ship && !!useArcade; hp = 100; bombs = 3; incoming = []; flash = hit = 0; shields = 0; objs = []; booms = []; score = coins = 0;
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
  // ---------- Capitals: a collectible over each national capital; a whole continent is an achievement ----------
  const NE = 'https://raw.githubusercontent.com/avlopezparra/natural-earth-vector/master/', CAPS = 'oge.capitals';
  const CONT = { Africa: 'África', Asia: 'Asia', Europe: 'Europa', 'North America': 'Norteamérica', 'South America': 'Sudamérica', Oceania: 'Oceanía', Antarctica: 'Antártida' };
  let caps = null, capsBusy = false; // [{ name, lon, lat, cont, p }]
  const got = new Set((() => { try { return JSON.parse(localStorage.getItem(CAPS)) || []; } catch { return []; } })()), capId = (c) => c.name + '|' + c.cont;
  const capOcc = new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, viewer.camera.positionWC);
  async function loadCaps() {
    if (caps || capsBusy) return;
    capsBusy = true;
    try {
      const get = (p) => fetch(NE + p).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); });
      const [ps, pd, cd] = await Promise.all([get('110m_cultural/ne_110m_populated_places_simple.shp'), get('110m_cultural/ne_110m_populated_places_simple.dbf'), get('50m_cultural/ne_50m_admin_0_countries.dbf')]);
      const clean = (v) => String(v ?? '').replace(/\0/g, '').trim(), cont = new Map(shp.parseDbf(cd).map((r) => [clean(r.ADM0_A3), clean(r.CONTINENT)]));
      caps = shp.combine([shp.parseShp(ps), shp.parseDbf(pd)]).features.filter((f) => f.geometry && +f.properties.adm0cap === 1).map((f) => {
        const [lon, lat] = f.geometry.coordinates;
        return { name: clean(f.properties.name), lon, lat, cont: CONT[cont.get(clean(f.properties.adm0_a3))] || 'Islas oceánicas', p: C.Cartesian3.fromDegrees(lon, lat, 1500) };
      });
    } catch (e) { OGE.toast('No se pudieron cargar las capitales: ' + e.message, true); }
    capsBusy = false;
  }
  const capProgress = () => { // { continent: [collected, total] }
    const out = {};
    for (const c of caps || []) { const r = (out[c.cont] = out[c.cont] || [0, 0]); r[1]++; if (got.has(capId(c))) r[0]++; }
    return out;
  };
  function capStep() { // flying close to a capital collects it
    if (!caps) return;
    const cam = viewer.camera.positionWC, R = Math.max(8000, s.v * warp * 3);
    for (const c of caps) {
      if (got.has(capId(c)) || C.Cartesian3.distance(c.p, cam) > R) continue;
      got.add(capId(c)); localStorage.setItem(CAPS, JSON.stringify([...got]));
      const [n, all] = capProgress()[c.cont];
      if (arcade) score += 500;
      beep(900, 1800, 0.3);
      OGE.toast(n === all ? `🏆 Logro: todas las capitales de ${c.cont} (${n}).` : `⭐ Capital conseguida: ${c.name} — ${c.cont} ${n}/${all}.`);
    }
  }
  function drawCaps() { // a star over each capital still to collect, when it is near and on this side of the globe
    const toWin = C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates, cam = viewer.camera.positionWC;
    capOcc.cameraPosition = cam;
    for (const c of caps) {
      const d = C.Cartesian3.distance(c.p, cam);
      if (got.has(capId(c)) || d > 2.5e6 || !capOcc.isPointVisible(c.p)) continue;
      const q = toWin(scene, c.p);
      if (!q) continue;
      g.save(); g.fillStyle = g.shadowColor = '#5ac8fa'; g.shadowBlur = 10; g.textAlign = 'center';
      g.font = (d < 3e5 ? 32 : 20) + 'px sans-serif'; g.fillText('★', q.x, q.y);
      g.font = '600 12px sans-serif'; g.fillText(c.name, q.x, q.y + 20); g.restore();
    }
  }
  OGE.minimap.extra = (mg) => { // collected capitals in green, the rest in yellow
    for (const c of caps || []) { const [x, y] = OGE.minimap.xy(c.lon, c.lat); mg.fillStyle = got.has(capId(c)) ? '#34c759' : '#ffd60a'; mg.fillRect(x - 1, y - 1, 2.5, 2.5); }
  };

  // Scoreboard: the ten best arcade flights, kept on this computer.
  const SCORES = 'oge.scores', readScores = () => { try { return JSON.parse(localStorage.getItem(SCORES)) || []; } catch { return []; } };
  const showScores = () => OGE.showTable('🏆 Mejores puntajes', ['#', 'Piloto', 'Puntos', 'Monedas', 'Fecha'],
    readScores().map((r, i) => [i + 1, r.name, r.score, r.coins, r.date]),
    { note: T('Se guardan solo en este equipo.') + (caps ? ' ' + T('Capitales:') + ' ' + Object.entries(capProgress()).map(([k, [n, all]]) => `${n === all ? '🏆 ' : ''}${T(k)} ${n}/${all}`).join(' · ') : '') });
  async function saveScore(pts, cns) {
    const v = await OGE.ask({ title: `Puntaje: ${pts} puntos y ${cns} monedas`, ok: 'Guardar', fields: [{ id: 'name', label: 'Tu nombre', value: localStorage.getItem('oge.pilot') || '' }] });
    const name = v && v.name.trim().slice(0, 24);
    if (name) {
      localStorage.setItem('oge.pilot', name);
      localStorage.setItem(SCORES, JSON.stringify([...readScores(), { name, score: pts, coins: cns, date: new Date().toISOString().slice(0, 10) }].sort((a, b) => b.score - a.score || b.coins - a.coins).slice(0, 10)));
    }
    showScores();
  }
  function stop(msg, error) {
    on = false;
    if (arcade && !msg && score) msg = `Vuelo terminado: ${score} puntos y ${coins} monedas.`;
    if (arcade && (score || coins)) saveScore(score, coins);
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
    if (on && !A.ship) return OGE.toast('Disparar y las maniobras son solo de la Starship.');
    if (!on || paused || man) return;
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
    const airbrake = keys.has('q') || keys.has('pagedown') ? (A.ship ? A.thrust * 1.5 : 6) : 0; // Q also brakes: drag alone is too weak at low speed
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
      s.heading += pr * Math.sin(s.roll) + ((G * Math.sin(s.roll)) / Math.max(s.v, 20)) * dt + s.rud * A.yaw * q * dt * turn;
      if (s.v < stallV) s.pitch -= rad(18) * dt; // stall
      s.pitch = clamp(s.pitch, rad(-89), rad(89));
      s.v = clamp(s.v + (s.throttle * A.thrust - drag - airbrake - grav * Math.sin(s.pitch)) * dt, 0, A.vMax * 1.3);
      s.vs = s.v * Math.sin(pe);
      s.alt += s.vs * dt * warp;
      if (A.ship && s.alt <= ground + 30) { // the starship bounces off the ground; in the arcade a hard touch costs life
        s.alt = ground + 30; s.pitch = Math.max(s.pitch, rad(arcade ? 8 : 2));
        if (arcade && performance.now() - hit > 800) hurt(15);
      }
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
    if (arcade && on) arcadeStep(dt);
    if (on) capStep();
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
    if (caps) drawCaps();
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
  hud.addEventListener('contextmenu', (e) => e.preventDefault());
  hud.addEventListener('mousedown', (e) => { if (e.button === 2) fire(); }); // right button: fires even where the context menu event is suppressed
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
    else if (k === 'b' && A.ship) bomb();
    else if (k === 't') nextWarp(e.shiftKey ? -1 : 1);
    else if (k === 'y') nextWarp(-1);
    else if (k === '+' || k === '=' || k === '-') OGE.minimap.zoom(k === '-' ? -1 : 1);
    else if (k === 'm') OGE.minimap.toggle();
    else if (k === 'n') nextTurn();
    else if (k === 'r' || k === 'v' || k === 'u') maneuver(k === 'r' ? 'roll' : k === 'v' ? 'loop' : 'uturn');
    else if (k === 'k') $('flyKeys').hidden = !$('flyKeys').hidden;
    else keys.add(k);
    e.preventDefault(); e.stopPropagation();
  }, true);
  document.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()), true);
  window.addEventListener('blur', () => keys.clear());
  const nextWarp = (d = 1) => setWarp(WARPS[clamp(WARPS.indexOf(warp) + d, 0, WARPS.length - 1)]); // stops at both ends
  $('flyWarp').onclick = () => nextWarp(1);
  $('flyWarpDown').onclick = () => nextWarp(-1);
  const nextTurn = () => setTurn(TURNS[(TURNS.indexOf(turn) + 1) % TURNS.length] || 1);
  $('flyTurn').onclick = nextTurn;
  setTurn(TURNS.includes(turn) ? turn : 1);
  $('flyScores').onclick = () => { paused = true; showScores(); };
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
  OGE.flight = { start, stop, maneuver, state: () => s, flying: () => on, game: () => ({ score, coins, objs, hp, bombs, incoming, shields }) };
})();
