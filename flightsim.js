// Flight simulator in the style of Earth's: cockpit view with HUD, mouse or keyboard control and two aircraft.
// Mouse: a click grabs or releases the stick; the cursor relative to the center moves it (down = pull = nose up).
// Keyboard: arrows (or W/S) stick · PgUp/PgDn (or E/Q) throttle · A/D (or Shift+←/→) rudder · K key list · F / Shift+F flaps · G gear ·
// A/D also turn (rudder) · T / G turbo up / down · L gear · , . (or B) brakes · Home/End trim · C center · Space pause · H HUD · Esc exit. OpenStarshipEarth: X or right click fires.
(() => {
  const C = Cesium, { viewer, $ } = OGE;
  const scene = viewer.scene, rad = C.Math.toRadians, deg = C.Math.toDegrees, clamp = C.Math.clamp;
  const G = 9.81, R = 6371000, KT = 1.94384, FT = 3.28084, GEAR_H = 1.8;
  const IMPERIAL = /-(US|LR|MM)$/i.test(navigator.language || ''); // knots and feet only where feet are the everyday unit; the rest of the world reads km/h and metres
  const num = (v) => String(Math.round(v)), spd = (v) => (IMPERIAL ? Math.round(v * KT) + ' KT' : v * 3.6 < 1e5 ? num(v * 3.6) + ' km/h' : num((v * 3.6) / 1000) + 'k km/h'), high = (m) => (IMPERIAL ? Math.round(m * FT) + ' FT' : Math.abs(m) < 1e5 ? num(m) + ' m' : num(m / 1000) + ' km');
  // vStall/vMax in m/s; thrust: acceleration at full throttle (m/s²); roll/pitch/yaw: maximum angular rates; agl and v0: start
  const PLANES = {
    sr22: { name: 'SR22 — avioneta de hélice, lenta y dócil', vStall: 31, vMax: 95, thrust: 3.2, roll: rad(45), pitch: rad(22), yaw: rad(20), agl: 600, v0: 70 },
    f16: { name: 'F-16 — caza a reacción, rápido y nervioso', gun: true, vStall: 72, vMax: 420, thrust: 22, roll: rad(130), pitch: rad(38), yaw: rad(18), agl: 1500, v0: 220 },
    // ship: no stall and no gravity (it hovers and climbs to space), bounces off the ground instead of crashing, and fires
    ship: { name: 'OpenStarshipEarth — nave muy rápida con láseres; flota y sube al espacio', ship: true, vStall: 0, vMax: 8000, thrust: 400, roll: rad(220), pitch: rad(75), yaw: rad(35), agl: 3000, v0: 600 },
  };
  const hud = $('hud'), g = hud.getContext('2d');
  let on = false, paused = false, mouseCtl = false, showHud = true, A = null, s = null, last = 0;
  const WARPS = [1, 2, 5, 10, 25, 50, 100];
  const GWARPS = [1, 2, 5, 10];
  let gWarp = 1, warpShown = 0; // gWarp: the turbo for driving on the ground, apart from the one in the air
  let warp = 1; // turbo: multiplies the distance covered, to cross long stretches quickly
  const setWarp = (v) => { if (typeof race !== 'undefined' && race && race.maxWarp && v > race.maxWarp) v = race.maxWarp; // a race may cap the turbo
 if (on && v !== warp) sfx(v > warp ? 'warpUp' : 'warpDown'); warp = v; warpLabel(); };
  function warpLabel() { // the button shows the turbo in use: the ground one while parked
    const v = typeof landing !== 'undefined' && landing === 'parked' ? gWarp : warp; if (v === warpShown) return;
    warpShown = v; $('flyWarp').textContent = 'Turbo ×' + v + ' ▲ (Espacio)'; $('flyWarp').classList.toggle('active', v > 1);
  }
  const TURNS = [1, 2, 3, 5];
  let turn = +localStorage.getItem('oge.flyTurn2') || 3; // quick turns by default // multiplies how fast A/D turn
  const setTurn = (v) => { turn = v; localStorage.setItem('oge.flyTurn2', v); $('flyTurn').textContent = T('Giro') + ' ×' + v + ' (N)'; $('flyTurn').classList.toggle('active', v > 1); };
  const keys = new Set(), stick = { x: 0, y: 0 };

  // ---------- OpenStarshipEarth lasers: bolts on the HUD, a flash where the aim hits the ground, and a short sound ----------
  let shots = [], audio = null, aimMouse = false; // shots: { t, x, y } on the HUD; aimMouse: lasers follow the cursor
  const mouse = { x: 0, y: 0 };
  let lock = null; // where the last auto-aimed shot went { x, y, t }
  let loading = 0; // until when the start of a flight may wait for the terrain and the flags (0: flying)
  let charge = 0, chargeAuto = false; // charge: when the fire key or button went down (0: not held); chargeAuto: the charged shot seeks its target (B) or goes where the mouse aims
  const trigger = (auto) => { fire(1, auto); if (on && A.ship && !paused) { charge = performance.now(); chargeAuto = auto; } }; // fires at once; held, it charges
  const letGo = () => { if (!charge) return; const held = performance.now() - charge; charge = 0; if (held >= CHARGE_MS) fire(1, chargeAuto, 4); }; // letting go of a full charge fires it
  const CHARGE_MS = 700;
  function fire(who = 1, auto = false, power = 1) { // power > 1: a charged shot // auto: aim by itself at the enemy nearest the middle of the view (B key, touch button, pad) // who: 1, or 2 for the local second player (it fires through its own reticle)
    const t = performance.now(), mine = shots.filter((sh) => sh.who === who);
    if (on && A.gun) return; // the F-16 fires its own cannon (gunStep)
    if (on && !A.ship) return OGE.toast('Disparar y las maniobras son solo de la OpenStarshipEarth.');
    if (!on || paused || (mine.length && t - mine[mine.length - 1].t < 110) || (who === 2 && (!p2 || p2.out || p2.sx == null))) return;
    let ax = who === 2 ? p2.sx : aimMouse ? mouse.x : hud.clientWidth / 2, ay = who === 2 ? p2.sy - p2.R * 1.6 : aimMouse ? mouse.y : hud.clientHeight / 2; // where the lasers go
    let acx = hud.clientWidth / 2, acy = hud.clientHeight / 2; // the point auto-aim searches around
    if (who === 1 && tps()) { const far = (C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates)(scene, shipPoint(shipAxes(), 0, 0, 5200)); if (far) { acx = far.x; acy = far.y; if (!aimMouse) { ax = acx; ay = acy; } } } // third person: along the nose, through the far reticle, unless the mouse aims
    if (auto && who === 1 && arcade) {
      const toW = C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates, cw = hud.clientWidth, ch = hud.clientHeight, camP = viewer.camera.positionWC;
      let bestQ = null, bestS = Infinity;
      for (const o of objs) {
        if (o.kind !== 'enemy' && o.kind !== 'boss' && o.kind !== 'airliner') continue;
        const d = C.Cartesian3.distance(o.p, camP); if (d > reach() * 1.5 && o.kind !== 'boss') continue;
        if (C.Cartesian3.dot(C.Cartesian3.subtract(o.p, camP, new C.Cartesian3()), viewer.camera.directionWC) <= 0) continue;
        const q = toW(scene, o.p); if (!q || q.x < 0 || q.y < 0 || q.x > cw || q.y > ch) continue;
        const sc = Math.hypot(q.x - acx, q.y - acy) + d / 200; if (sc < bestS) { bestS = sc; bestQ = q; }
      }
      if (padLock) { const q = objs.includes(padLock) && C.Cartesian3.dot(C.Cartesian3.subtract(padLock.p, camP, new C.Cartesian3()), viewer.camera.directionWC) > 0 ? toW(scene, padLock.p) : null; if (q && q.x >= 0 && q.y >= 0 && q.x <= cw && q.y <= ch) bestQ = q; } // the enemy picked with the pad comes first
      if (bestQ) { ax = bestQ.x; ay = bestQ.y; lock = { x: ax, y: ay, t }; }
    }
    let ray = viewer.camera.getPickRay(new C.Cartesian2(ax, ay));
    if (!ray) return; // no view to aim through (the map is not drawn yet)
    if (who === 1 && man && tps()) { // mid-maneuver the chase camera sees the ship from elsewhere: the lasers leave along its nose, not towards the click, and the auto-aim takes what the ship has in front
      const sa = shipAxes(), toWin = C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates; let dir = sa.F;
      if (auto && arcade) { let bestA = rad(30); for (const o of objs) { if (o.kind !== 'enemy' && o.kind !== 'boss' && o.kind !== 'airliner') continue; const v = C.Cartesian3.subtract(o.p, sa.P, new C.Cartesian3()), d = C.Cartesian3.magnitude(v); if (d > reach() * 1.5 && o.kind !== 'boss') continue; const a = Math.acos(clamp(C.Cartesian3.dot(v, sa.F) / d, -1, 1)); if (a < bestA) { bestA = a; dir = C.Cartesian3.normalize(v, v); } } }
      ray = new C.Ray(sa.P, dir);
      const q = toWin(scene, C.Cartesian3.add(sa.P, C.Cartesian3.multiplyByScalar(dir, 250, new C.Cartesian3()), new C.Cartesian3())); if (q) { ax = q.x; ay = q.y; }
    }
    const ground = scene.globe.pick(ray, scene);
    shots.push({ t, x: ax, y: ay, who, big: power > 1 });
    if (arcade) versus(who, ax, ay, ray);
    if (ground && C.Cartesian3.distance(ground, viewer.camera.positionWC) < 4e5) {
      const e = viewer.entities.add({ position: ground, point: { pixelSize: 16, color: C.Color.ORANGE, outlineColor: C.Color.YELLOW, outlineWidth: 4, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
      e._tmp = true; // not a user feature: never saved
      setTimeout(() => viewer.entities.remove(e), 450);
    }
    if (power > 1) beep(300, 1500, 0.35); else beep(1100, 180, 0.16);
    if (!arcade) return;
    credit = who; // who scores what this shot destroys
    const cam = viewer.camera, to = new C.Cartesian3(); // an enemy inside the aim cone is destroyed
    let best = null, bestAng = 9, bossHit = null, bossAng = 9;
    for (const o of objs) {
      if (o.kind !== 'enemy' && o.kind !== 'boss' && o.kind !== 'airliner' && o.kind !== 'aa' && o.kind !== 'octo' && o.kind !== 'ship' && !(power > 1 && o.kind === 'wall')) continue; // a charged shot also breaks crates and asteroids
      C.Cartesian3.subtract(o.p, ray.origin, to); // from where the shot leaves: the camera, or the ship itself mid-maneuver
      const d = C.Cartesian3.magnitude(to), ang = Math.acos(clamp(C.Cartesian3.dot(to, ray.direction) / d, -1, 1));
      if (o.kind === 'boss') { if (ang < Math.atan(o.size / d) + rad(0.4) && ang < bossAng) { bossHit = o; bossAng = ang; } } // a boss only counts when the laser really meets it
      else if (ang < Math.atan((o.size * 1.5) / d) + rad(1.2) && ang < bestAng) { best = o; bestAng = ang; }
    }
    if (!best) best = bossHit; // shots at the enemies around a boss go to those enemies, not to the boss
    const occ = new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, cam.positionWC);
    if (!best && $('layerSats').checked) for (const sat of OGE.satellites()) { // a satellite hit gives life back and disappears until the page is reloaded
      if (!sat.p || OGE.satHidden.has(sat.name) || !occ.isPointVisible(sat.p)) continue; // the Earth in between stops the laser
      C.Cartesian3.subtract(sat.p, ray.origin, to);
      const d = C.Cartesian3.magnitude(to);
      if (Math.acos(clamp(C.Cartesian3.dot(to, ray.direction) / d, -1, 1)) < rad(1.5)) { OGE.satHidden.add(sat.name); hp = Math.min(maxHp, hp + 25); sfx('heart'); booms.push({ p: sat.p, t: performance.now() }); OGE.toast(`🛰 ${sat.name}: +25 ${T('de vida')}`); return; }
    }
    if (best && best.kind === 'boss') hitBoss(best, power > 1 ? power * 2.5 : power); // a charged shot hits a boss hardest: 10
    else if (best && best.kind === 'ship' && (best.hp -= power) > 0) { booms.push({ p: best.p, t: performance.now() }); sfx('bossHit'); }
    else if (best && best.kind === 'ship') { objs.splice(objs.indexOf(best), 1); if (best.mmsi) sunk.add(best.mmsi); gain(pts(250)); hp = Math.min(maxHp, hp + 15); booms.push({ p: best.p, t: performance.now() }); sfx('down'); sfx('heart'); OGE.toast(T('Barco hundido: +15 de vida')); }
    else if (best && best.kind === 'octo' && (best.hp -= power) > 0) { booms.push({ p: best.p, t: performance.now() }); sfx('bossHit'); }
    else if (best && best.kind === 'octo') { objs.splice(objs.indexOf(best), 1); gain(pts(150)); booms.push({ p: best.p, t: performance.now() }); sfx('down'); }
    else if (best && best.kind === 'aa' && (best.hp -= power) > 0) { booms.push({ p: best.p, t: performance.now() }); sfx('bossHit'); }
    else if (best && best.kind === 'aa') { objs.splice(objs.indexOf(best), 1); gain(pts(250)); booms.push({ p: best.p, t: performance.now() }); sfx('down'); }
    else if (best && best.kind === 'airliner' && (best.hp -= power) > 0) { booms.push({ p: best.p, t: performance.now() }); sfx('shieldBreak'); }
    else if (best && best.kind === 'airliner') { objs.splice(objs.indexOf(best), 1); gain(pts(300)); booms.push({ p: best.p, t: performance.now() }); sfx('down'); }
    else if (best) { objs.splice(objs.indexOf(best), 1); gain(pts(100)); booms.push({ p: best.p, t: performance.now() }); sfx('down'); }
    if (power > 1 && best) { const c = best.p, t1 = performance.now(); objs = objs.filter((o) => { if (o.kind !== 'enemy' || o === best || C.Cartesian3.distance(o.p, c) > 1500) return true; gain(pts(100)); booms.push({ p: o.p, t: t1 }); return false; }); } // the blast takes the craft around its target too
    credit = 1;
  }
  // F-16 cannon: a 20 mm rotary gun like the real one: 511 rounds at 100 a second (five seconds of fire in all), rounds that leave at 1050 m/s over the aircraft's own speed and drop with gravity.
  // One round in five is a tracer, the only ones drawn. No reload in the air. shortcut: there is nothing to hit yet; add targets if someone asks for them.
  let rounds = [], ammo = 0, gunHeld = false, gunAcc = 0, gunSnd = 0, gunDust = 0;
  function gunStep(dt, firing) {
    const now = performance.now();
    if (firing && ammo > 0) {
      gunAcc += dt * 100; const n = Math.min(ammo, Math.floor(gunAcc)); gunAcc -= n; ammo -= n;
      if (n) { const ax = axesAt(C.Cartesian3.fromRadians(s.lon, s.lat, s.alt), s.heading, s.pitch, s.roll); rounds.push({ p: shipPoint(ax, 1, -1, 8), v: C.Cartesian3.multiplyByScalar(ax.F, s.v + 1050, new C.Cartesian3()), t: now }); } // a tracer for this frame's rounds
      if (n && now > gunSnd) { gunSnd = now + 55; beep(170, 110, 0.05); }
    }
    rounds = rounds.filter((b) => {
      const up = C.Cartesian3.normalize(b.p, new C.Cartesian3());
      b.v.x -= up.x * G * dt; b.v.y -= up.y * G * dt; b.v.z -= up.z * G * dt; // it falls as it flies
      b.p = new C.Cartesian3(b.p.x + b.v.x * dt, b.p.y + b.v.y * dt, b.p.z + b.v.z * dt);
      if (now - b.t > 3500) return false;
      const cg = C.Cartographic.fromCartesian(b.p);
      if (cg.height > (scene.globe.getHeight(cg) || 0)) return true;
      if (now > gunDust) { gunDust = now + 120; const e = viewer.entities.add({ position: b.p, point: { pixelSize: 7, color: C.Color.fromCssColorString('#d8c9a8'), disableDepthTestDistance: Number.POSITIVE_INFINITY } }); e._tmp = true; setTimeout(() => viewer.entities.remove(e), 350); } // dust where it hits the ground
      return false;
    });
  }
  function beep(f0, f1, dur) {
    try {
      ac();
      const o = audio.createOscillator(), v = audio.createGain(), now = audio.currentTime;
      o.type = 'sawtooth'; o.frequency.setValueAtTime(f0, now); o.frequency.exponentialRampToValueAtTime(f1, now + dur);
      v.gain.setValueAtTime(0.06, now); v.gain.exponentialRampToValueAtTime(0.001, now + dur);
      o.connect(v).connect(master); o.start(now); o.stop(now + dur + 0.01);
    } catch { /* no audio device: the game still works */ }
  }

  // ---------- Sound: master volume (mute) and an original looping arcade theme, synthesized on the fly ----------
  let master = null, muted = !!localStorage.getItem('oge.mute'), musicTimer = null;
  function ac() {
    if (!audio) { audio = new AudioContext(); master = audio.createGain(); master.gain.value = muted ? 0 : 1; master.connect(audio.destination); }
    return audio;
  }
  // The theme (theme.js: the user's own loop) is played by a small synth: brass lead and harmony, bass and three drum sounds.
  const TH = window.OGE_THEME, VOICE = { lead: ['sawtooth', 0.045], harmony: ['square', 0.018], bass: ['triangle', 0.09] };
  // [modulator ratio, modulation index at the attack, index it decays to, decay seconds, volume, carrier detune in cents]
  const FM = { lead: [1, 3.2, 1.1, 0.25, 0.07, 4], harmony: [2, 1.6, 0.4, 0.4, 0.028, -6], bass: [1, 4.5, 1.4, 0.12, 0.11, 0] };
  let musicBus = null; // music → (dry + echo) → master
  function bus() {
    if (musicBus) return musicBus;
    musicBus = audio.createGain();
    const echo = audio.createDelay(1), fb = audio.createGain(), lp = audio.createBiquadFilter(), wet = audio.createGain();
    echo.delayTime.value = 0.19; fb.gain.value = 0.32; lp.type = 'lowpass'; lp.frequency.value = 2800; wet.gain.value = 0.28;
    musicBus.connect(master); musicBus.connect(echo); echo.connect(lp).connect(fb).connect(echo); lp.connect(wet).connect(master); musicBus.wet = wet;
    return musicBus;
  }
  const STYLE = { // per theme: index multiplier, decay multiplier, echo amount, bass modulator ratio
    race: { idx: 1.5, dec: 0.6, echo: 0.18, bass: 0.5 }, adventure: { idx: 1.25, dec: 1, echo: 0.3, bass: 1 }, boss: { idx: 1.2, dec: 1, echo: 0.3, bass: 1 }, main: { idx: 1, dec: 1, echo: 0.28, bass: 1 } };
  let style = STYLE.main;
  function fmTone(k, midi, t, dur) { // a carrier sine whose frequency is swung by a modulator sine: bright at the attack, mellower after
    let [ratio, i0, i1, dec, vol, cents] = FM[k]; i0 *= style.idx; i1 *= style.idx; dec *= style.dec; if (k === 'bass') ratio = style.bass;
    const f = 440 * 2 ** ((midi - 69) / 12) * 2 ** (cents / 1200);
    const car = audio.createOscillator(), mod = audio.createOscillator(), depth = audio.createGain(), v = audio.createGain();
    car.frequency.value = f; mod.frequency.value = f * ratio;
    depth.gain.setValueAtTime(f * i0, t); depth.gain.exponentialRampToValueAtTime(f * i1, t + Math.min(dec, dur));
    v.gain.setValueAtTime(0.0001, t); v.gain.exponentialRampToValueAtTime(vol, t + 0.008); v.gain.setValueAtTime(vol, t + dur * 0.75); v.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.05);
    mod.connect(depth).connect(car.frequency); car.connect(v).connect(bus());
    car.start(t); mod.start(t); car.stop(t + dur + 0.08); mod.stop(t + dur + 0.08);
  }
  let noise = null;
  function tone(midi, t, dur, type, vol) {
    const o = audio.createOscillator(), v = audio.createGain();
    o.type = type; o.frequency.value = 440 * 2 ** ((midi - 69) / 12);
    v.gain.setValueAtTime(vol, t); v.gain.setValueAtTime(vol, t + dur * 0.7); v.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(v).connect(master); o.start(t); o.stop(t + dur + 0.02);
  }
  function drum(midi, t) { // drums as the Mega Drive makes them: two-operator FM (its YM2612 chip) for the body of each hit, with a high modulation that dies away at once for the crack, and the coarse stepped noise of its PSG chip on top for snares and cymbals
    const fm = (f0, f1, ratio, idx, dur, vol) => { // a carrier whose pitch falls from f0 to f1, bent by a modulator at ratio times its pitch; idx: how hard, at the attack
      const car = audio.createOscillator(), mod = audio.createOscillator(), depth = audio.createGain(), v = audio.createGain(), end = t + dur;
      car.frequency.setValueAtTime(f0, t); car.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.6);
      mod.frequency.setValueAtTime(f0 * ratio, t); mod.frequency.exponentialRampToValueAtTime(f1 * ratio, t + dur * 0.6);
      depth.gain.setValueAtTime(f0 * idx, t); depth.gain.exponentialRampToValueAtTime(1, t + dur * 0.45);
      v.gain.setValueAtTime(vol, t); v.gain.exponentialRampToValueAtTime(0.001, end);
      mod.connect(depth).connect(car.frequency); car.connect(v).connect(master); car.start(t); mod.start(t); car.stop(end + 0.01); mod.stop(end + 0.01);
    };
    if (!noise) { // PSG noise: one of two levels held for several samples, so it is gritty and a little pitched
      noise = audio.createBuffer(1, audio.sampleRate * 0.5, audio.sampleRate); const ch = noise.getChannelData(0), hold = Math.max(1, Math.round(audio.sampleRate / 7000)); let lv = 1;
      for (let i = 0; i < ch.length; i++) { if (i % hold === 0) lv = Math.random() < 0.5 ? -1 : 1; ch[i] = lv; }
    }
    const hiss = (rate, len, vol, hp) => { const src = audio.createBufferSource(), f = audio.createBiquadFilter(), v = audio.createGain(); src.buffer = noise; src.playbackRate.value = rate; f.type = 'highpass'; f.frequency.value = hp; v.gain.setValueAtTime(vol, t); v.gain.exponentialRampToValueAtTime(0.001, t + len); src.connect(f).connect(v).connect(master); src.start(t); src.stop(t + len); };
    if (midi === 35 || midi === 36) return fm(190, 44, 0.5, 7, 0.17, 0.36); // kick: a deep thud with a hard FM click in front
    if (midi === 38 || midi === 40) { fm(250, 140, 2.37, 10, 0.13, 0.15); return hiss(0.7, 0.13, 0.11, 1100); } // snare: an inharmonic FM crack, PSG noise over it
    if (midi === 37 || midi === 39) return fm(520, 400, 3.3, 6, 0.05, 0.12); // rim shot, clap: short and bright
    if (midi >= 41 && midi <= 48 && ![42, 44, 46].includes(midi)) { const f = 80 + (midi - 41) * 26; return fm(f * 1.5, f * 0.8, 1, 4, 0.22, 0.24); } // toms: the classic falling FM tom
    const crash = midi === 49 || midi === 57 || midi === 52 || midi === 55;
    if (crash) fm(3100, 2900, 1.41, 9, 0.45, 0.03); // a metallic shimmer under the cymbal
    hiss(crash ? 0.9 : 1.7, crash ? 0.45 : midi === 46 ? 0.2 : 0.04, crash ? 0.07 : 0.05, crash ? 3500 : 6500); // crash, open hat, closed hat: PSG noise, as on the console
  }
  function march(th) { // the adventure theme rearranged as a space march: the same tune of ours, in the minor, faster, over a galloping bass and a marching snare
    if (th.marched) return; th.marched = true; th.bpm = 148;
    const minor = (p) => p - ([4, 9, 11].includes((((p - 7) % 12) + 12) % 12) ? 1 : 0); // G major to G minor: its third, sixth and seventh come down a semitone
    for (const k of ['lead', 'harmony', 'bass']) for (let i = 2; i < th[k].length; i += 3) th[k][i] = minor(th[k][i]);
    const bass = [], notes = [], drums = [];
    for (let i = 0; i < th.bass.length; i += 3) { const t = th.bass[i], p = th.bass[i + 2]; bass.push(t, 5, p, t + 6, 5, (t / th.unit) % 4 >= 3 ? p + 12 : p); } // every eighth becomes two sixteenths; the last beat of the bar leaps an octave
    for (let i = 0; i < th.harmony.length; i += 3) notes.push([th.harmony[i], th.harmony[i + 1], th.harmony[i + 2]]);
    for (let i = 0; i < th.lead.length; i += 3) notes.push([th.lead[i], th.lead[i + 1], th.lead[i + 2] - 12]); // the tune doubled an octave below, like low brass
    for (let b = 0; b < th.beats; b++) { // kick on every beat, snare on 2 and 4 with a pick-up, sixteenth hats, a snare roll closing every four bars, a crash every eight
      const t = b * th.unit, back = b % 4 === 1 || b % 4 === 3, roll = b % 16 === 15;
      if (b % 32 === 0) drums.push(t, 5, 49);
      drums.push(t, 5, 36); if (back) drums.push(t, 5, 38);
      for (let q = 0; q < 4; q++) drums.push(t + (q * th.unit) / 4, 3, roll || (back && q === 3) ? 38 : 42);
    }
    th.bass = bass; th.harmony = notes.sort((x, y) => x[0] - y[0]).flat(); th.drums = drums;
  }
  OGE.music = (play, th) => music(play, th); // the sky view of the atlas plays its own piece
  let tune = null; // the theme playing now: Main Theme or Boss Fight OpenStarshipEarth
  function music(play, th = TH) {
    clearInterval(musicTimer); musicTimer = null; tune = play ? th : null;
    style = th === window.OGE_RACE_THEME ? STYLE.race : th === window.OGE_ADV_THEME ? STYLE.adventure : th === window.OGE_BOSS_THEME ? STYLE.boss : STYLE.main;
    if (musicBus) musicBus.wet.gain.value = style.echo;
    if (!play || !th) return;
    if (th === window.OGE_ADV_THEME) march(th);
    try { ac(); } catch { return; } // no audio device
    const u = 60 / th.bpm / th.unit, loop = th.beats * th.unit, idx = { lead: 0, harmony: 0, bass: 0, drums: 0 }; // u: seconds per stored unit
    let t0 = audio.currentTime + 0.1; // when the current pass of the loop started
    musicTimer = setInterval(() => { // schedules a little ahead of the clock
      const until = (audio.currentTime + 0.3 - t0) / u;
      for (const k of Object.keys(idx)) {
        const n = th[k] || [];
        while (idx[k] < n.length && n[idx[k]] < until) {
          const at = t0 + n[idx[k]] * u, len = n[idx[k] + 1] * u, pitch = n[idx[k] + 2];
          if (!paused && at > audio.currentTime - 0.05) { if (k === 'drums') drum(pitch, at); else fmTone(k, pitch, at, Math.min(len, th === window.OGE_SKY_THEME ? 6 : 1.5)); } // the slow sky piece holds its notes
          idx[k] += 3;
        }
      }
      if (until >= loop) { t0 += loop * u; for (const k of Object.keys(idx)) idx[k] = 0; } // next pass
    }, 60);
  }
  // Sound effects: short bell-like phrases (MIDI notes), one per event. [wave, seconds per note, notes]
  const SFX = { coin: ['sine', 0.06, [88, 95]], ring: ['sine', 0.07, [84, 88, 91]], heart: ['sine', 0.09, [79, 84, 88]], shield: ['triangle', 0.09, [72, 79, 84]], bombGet: ['triangle', 0.08, [69, 76, 81]],
    shieldBreak: ['sine', 0.05, [98, 93, 88, 81]], down: ['triangle', 0.05, [76, 72, 67]], flag: ['sine', 0.08, [79, 83, 86]], capital: ['triangle', 0.1, [72, 79, 84, 88]],
    boss: ['triangle', 0.11, [72, 76, 79, 84, 88, 91, 96]], achieve: ['triangle', 0.13, [72, 76, 79, 84, 79, 84, 88, 96]], step: ['sine', 0.08, [84, 91]],
    roll: ['triangle', 0.05, [67, 74, 79, 86, 91]], loop: ['triangle', 0.08, [60, 67, 72, 79, 84, 79, 72]], warpUp: ['sawtooth', 0.05, [60, 72, 84]], warpDown: ['sawtooth', 0.05, [84, 72, 60]], thrust: ['sawtooth', 0.06, [48, 55]],
    bossHit: ['square', 0.035, [52, 45, 40, 64]], land: ['triangle', 0.09, [84, 79, 76, 72, 67, 64, 60, 55, 48]], liftoff: ['triangle', 0.09, [48, 55, 60, 64, 67, 72, 76, 79, 84]] }; // long falling / rising runs for landing and taking off
  const DIFF = { easy: { name: 'Fácil', hurt: 0.5, fire: 1.6, shot: 0.7, boss: 0.6, pts: 0.5 }, normal: { name: 'Normal', hurt: 1, fire: 1, shot: 1, boss: 1, pts: 1 },
    hard: { name: 'Difícil', hurt: 1.6, fire: 0.6, shot: 1.4, boss: 1.6, pts: 2 }, ace: { name: 'As', hurt: 2.5, fire: 0.4, shot: 1.8, boss: 2.5, pts: 4 } };
  let diff = DIFF[localStorage.getItem('oge.diff')] ? localStorage.getItem('oge.diff') : 'normal';
  const pts = (n) => Math.round(n * DIFF[diff].pts); // points earned scale with the difficulty
  let third = localStorage.getItem('oge.third') === '1'; // third-person camera: behind and above the ship (Y switches)
  let stopped = false, airports = null, airBusy = false, refuelMsg = false; // stopped: Q toggles a hover; airports: [[lon, lat]] (Natural Earth) where landing heals
  let relaunch = null; // starts the last game again (same mode, stage or race)
  let thrT = 0, boost = null, boostCd = 0, eHeld = false, landing = null; // boost: the ship's single burst on E { t0, base } // landing: 'down' while dropping, 'parked' on the ground, 'up' while lifting off
  let calm = false; // free flight chosen from the mode menu: nothing to collect
  const quest = () => !calm && localStorage.getItem('oge.quest') !== '0';
  const PICKS = new Set(['coin', 'ring', 'heart', 'shield', 'bombGet', 'flag', 'capital']);
  function sfx(name) {
    const d = SFX[name];
    try {
      ac(); d[2].forEach((n, i) => tone(n, audio.currentTime + i * d[1], d[1] * 2.4, d[0], 0.07));
      if (PICKS.has(name)) chime(d[2][d[2].length - 1] + 12, d[1] * (d[2].length - 1)); // something caught: a bell rings on its last note
      if (name === 'boss') blast();
    } catch { /* no audio device */ }
  }
  function chime(midi, delay) { // a small FM bell through the echo
    const t = audio.currentTime + delay, f = 440 * 2 ** ((midi - 69) / 12), car = audio.createOscillator(), mod = audio.createOscillator(), depth = audio.createGain(), v = audio.createGain();
    car.frequency.value = f; mod.frequency.value = f * 3.5; depth.gain.setValueAtTime(f * 2, t); depth.gain.exponentialRampToValueAtTime(1, t + 0.4); v.gain.setValueAtTime(0.06, t); v.gain.exponentialRampToValueAtTime(0.0005, t + 0.6);
    mod.connect(depth).connect(car.frequency); car.connect(v).connect(bus()); car.start(t); mod.start(t); car.stop(t + 0.65); mod.stop(t + 0.65);
  }
  function blast(k = 1) { // a boss going down: a long rumble closing in, a falling boom and a string of smaller blasts (k < 1: just the rumble, for thunder)
    const t = audio.currentTime; if (!noise) drum(42, t); // the hi-hat makes the noise buffer
    const src = audio.createBufferSource(), f = audio.createBiquadFilter(), v = audio.createGain(), o = audio.createOscillator(), ov = audio.createGain();
    src.buffer = noise; src.loop = true; f.type = 'lowpass'; f.frequency.setValueAtTime(2400, t); f.frequency.exponentialRampToValueAtTime(70, t + 1.6); v.gain.setValueAtTime(0.5 * k, t); v.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
    src.connect(f).connect(v).connect(master); src.start(t); src.stop(t + 1.9);
    o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(28, t + 1.2); ov.gain.setValueAtTime(0.4 * k, t); ov.gain.exponentialRampToValueAtTime(0.001, t + 1.4); o.connect(ov).connect(master); o.start(t); o.stop(t + 1.5);
    if (k >= 1) for (let i = 1; i < 6; i++) drum(38, t + i * 0.17 + Math.random() * 0.08);
  }
  OGE.onLightning = () => { // a bolt of the storm overhead: thunder, and now and then it strikes an enemy nearby or the ship
    if (!on || !arcade || paused) return;
    try { ac(); blast(0.5); } catch { /* no audio device */ }
    if (Math.random() > 0.35) return;
    const cam = viewer.camera.positionWC, foes = objs.filter((o) => ['enemy', 'octo', 'aa', 'ship'].includes(o.kind) && C.Cartesian3.distance(o.p, cam) < 2e4);
    if (foes.length && Math.random() < 0.6) { const o = foes[Math.floor(Math.random() * foes.length)]; objs.splice(objs.indexOf(o), 1); booms.push({ p: o.p, t: performance.now() }); sfx('down'); OGE.toast(T('Un rayo destruyó a un enemigo')); }
    else if (!(man && man.type === 'roll')) { hurt(10); OGE.toast(T('Un rayo alcanzó la nave: −10')); }
  };
  let aisT = 0; const sunk = new Set(); // live ships: when to ask again, and the ones already sunk in this session
  function aisStep() { // real vessels as warships, where an open AIS feed exists without a key: Finnish waters (Digitraffic, Fintraffic, CC BY 4.0)
    const la = deg(s.lat), lo = deg(s.lon);
    if (OGE.body || performance.now() < aisT || tut || race || la < 58.5 || la > 66.5 || lo < 17 || lo > 31) return;
    aisT = performance.now() + 60000;
    fetch(`https://meri.digitraffic.fi/api/ais/v1/locations?latitude=${la.toFixed(2)}&longitude=${lo.toFixed(2)}&radius=60`).then((r) => r.json()).then((j) => {
      const t0 = performance.now(), far = (f) => Math.hypot((f.geometry.coordinates[0] - lo) * Math.cos(s.lat), f.geometry.coordinates[1] - la), near = j.features.filter((f) => f.properties.sog > 0.5 && !sunk.has(f.mmsi)).sort((x, y) => far(x) - far(y)).slice(0, 6); // the six nearest that are under way
      objs = objs.filter((o) => !(o.kind === 'ship' && o.mmsi)); // the fresh positions replace the old ones
      for (const f of near) { const [x, y] = f.geometry.coordinates; objs.push({ kind: 'ship', mmsi: f.mmsi, p: C.Cartesian3.fromDegrees(x, y, 15), lon0: rad(x), lat0: rad(y), cog: rad(f.properties.cog), sog: f.properties.sog, t0, size: 320, hp: 4, next: t0 + 2000 }); }
    }).catch(() => { /* no live ships: the generated ones remain */ });
  }
  let hum = null; // the engine: two detuned oscillators through a filter that opens with the gas and the turbo
  function engineHum(level, turbo = 0) { // level 0 silences it
    try {
      if (!hum) {
        if (!level) return;
        ac(); const o = audio.createOscillator(), o2 = audio.createOscillator(), f = audio.createBiquadFilter(), v = audio.createGain();
        o.type = 'sawtooth'; o2.type = 'square'; f.type = 'lowpass'; v.gain.value = 0; o.connect(f); o2.connect(f); f.connect(v).connect(master); o.start(); o2.start(); hum = { o, o2, f, v };
      }
      const t = audio.currentTime, base = 48 + 34 * level + 14 * turbo;
      hum.o.frequency.setTargetAtTime(base, t, 0.15); hum.o2.frequency.setTargetAtTime(base * 1.505, t, 0.15); hum.f.frequency.setTargetAtTime(180 + 500 * level + 260 * turbo, t, 0.15); hum.v.gain.setTargetAtTime(level ? 0.016 + 0.02 * level : 0, t, 0.2);
    } catch { /* no audio device */ }
  }
  const setMute = (v) => { muted = v; localStorage.setItem('oge.mute', v ? '1' : ''); if (master) master.gain.value = v ? 0 : 1; $('flyMute').textContent = (v ? '🔇 ' : '🔊 ') + T('Sonido') + ' (P)'; $('flyMute').classList.toggle('active', v); };

  // ---------- Sprites: enemy craft and bosses drawn once on small canvases (original designs), then scaled on the HUD ----------
  function sprite(size, paint) {
    const cv = Object.assign(document.createElement('canvas'), { width: size, height: size }), c = cv.getContext('2d');
    c.translate(size / 2, size / 2); c.scale(size / 200, size / 200); c.lineJoin = 'round'; // paint in a -100..100 box
    paint(c);
    const gl = c.createLinearGradient(0, -70, 0, 10); gl.addColorStop(0, 'rgba(255,255,255,.6)'); gl.addColorStop(1, 'rgba(255,255,255,0)'); // glossy highlight
    c.globalCompositeOperation = 'source-atop'; c.fillStyle = gl; c.beginPath(); c.ellipse(0, -30, 80, 38, 0, 0, 7); c.fill();
    const sh = c.createLinearGradient(0, -10, 0, 70); sh.addColorStop(0, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,.45)'); // shade underneath: gives it volume
    c.fillStyle = sh; c.fillRect(-100, -10, 200, 110); c.globalCompositeOperation = 'source-over';
    return cv;
  }
  const poly = (c, pts, fill, stroke) => { c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.fillStyle = fill; c.fill(); if (stroke) { c.strokeStyle = stroke; c.lineWidth = 4; c.stroke(); } };
  const glow = (c, x, y, r, color) => { const was = c.fillStyle, gr = c.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, '#fff'); gr.addColorStop(0.4, color); gr.addColorStop(1, /^#[0-9a-f]{6}$/i.test(color) ? color + '00' : 'rgba(0,0,0,0)'); c.fillStyle = gr; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); c.fillStyle = was; }; // the fill colour goes back: the HUD texts drawn afterwards use it // fading to the same colour: through black it left a dark ring
  const ENEMY = [
    sprite(128, (c) => { // dart: swept wings, seen head-on
      poly(c, [[-95, 10], [-30, -8], [0, -38], [30, -8], [95, 10], [40, 22], [0, 40], [-40, 22]], '#8e1b1b', '#ff6b5e');
      poly(c, [[-95, 10], [-30, -8], [0, -38], [0, 40], [-40, 22]], '#b52a2a'); // the lit half of the hull, and panel lines
      c.strokeStyle = 'rgba(40,0,0,.6)'; c.lineWidth = 2; c.beginPath(); c.moveTo(0, -38); c.lineTo(0, 40); c.moveTo(-60, 4); c.lineTo(-26, 18); c.moveTo(60, 4); c.lineTo(26, 18); c.stroke();
      poly(c, [[-18, -10], [0, -30], [18, -10], [0, 8]], '#1c2a44', '#9fd3ff');
      glow(c, -52, 14, 16, '#ff9f0a'); glow(c, 52, 14, 16, '#ff9f0a');
    }),
    sprite(128, (c) => { // saucer
      c.beginPath(); c.ellipse(0, 10, 92, 30, 0, 0, 7); c.fillStyle = '#5a5f6b'; c.fill(); c.strokeStyle = '#c7ccd6'; c.lineWidth = 4; c.stroke();
      c.beginPath(); c.ellipse(0, -8, 44, 30, 0, Math.PI, 0); c.fillStyle = '#2b6f8f'; c.fill(); c.strokeStyle = '#9fe3ff'; c.stroke();
      for (const x of [-60, -30, 0, 30, 60]) glow(c, x, 16, 9, '#ff453a');
    }),
    sprite(128, (c) => { // claw: two prongs around a core
      poly(c, [[-92, -50], [-60, -34], [-44, 30], [-70, 56], [-84, 10]], '#4a2a6b', '#c79bff');
      poly(c, [[92, -50], [60, -34], [44, 30], [70, 56], [84, 10]], '#4a2a6b', '#c79bff');
      poly(c, [[-46, -14], [0, -34], [46, -14], [36, 26], [0, 40], [-36, 26]], '#2a2233', '#c79bff');
      glow(c, 0, 2, 22, '#ff2df5');
    }),
  ];
  const BOSS = sprite(256, (c) => { // fortress: armored hull, side cannons and a glowing core
    poly(c, [[-98, -6], [-70, -40], [-30, -52], [30, -52], [70, -40], [98, -6], [80, 34], [34, 58], [-34, 58], [-80, 34]], '#3a1250', '#ff5cf4');
    poly(c, [[-98, -6], [-124, 6], [-98, 22]], '#6b1d8c', '#ff5cf4'); poly(c, [[98, -6], [124, 6], [98, 22]], '#6b1d8c', '#ff5cf4');
    poly(c, [[-60, -34], [-22, -42], [-22, -18], [-56, -12]], '#1d0b2b'); poly(c, [[60, -34], [22, -42], [22, -18], [56, -12]], '#1d0b2b');
    for (const x of [-70, -46, 46, 70]) { c.fillStyle = '#9aa0ad'; c.fillRect(x - 5, 30, 10, 34); glow(c, x, 66, 10, '#ff9f0a'); }
    glow(c, 0, 8, 34, '#ff2d55');
    c.beginPath(); c.arc(0, 8, 14, 0, 7); c.fillStyle = '#fff'; c.fill();
  });

  // ---------- Boss types: each capital gets one (by its name). They are drawn procedurally so they can move. ----------
  // hp: shots to beat it · every: ms between volleys · shots: per volley · color of its shots · sway: how far it moves around its post (m)
  const BOSSES = {
    fortress: { name: 'Fortaleza', hp: 30, every: 1600, shots: 1, color: '#ff2df5', sway: 0 },
    snake: { name: 'Serpiente', hp: 18, every: 2200, shots: 1, color: '#7CFC00', sway: 2600 },
    face: { name: 'Cara gigante', hp: 45, every: 2600, shots: 3, color: '#40e0ff', sway: 0 },
    dragon: { name: 'Dragón', hp: 40, every: 1100, shots: 1, color: '#ff9f0a', sway: 1800 },
    crystal: { name: 'Coloso de cristal', hp: 24, every: 1800, shots: 2, color: '#9fe8ff', sway: 0, shield: true }, // only hurt while its shield is open
    hive: { name: 'Colmena', hp: 20, every: 2600, shots: 1, color: '#ffd23a', sway: 900, spawns: true }, // launches escorts; its core is protected while two or more fly
    hand: { name: 'Mano gigante', hp: 16, every: 2200, shots: 1, color: '#ffcc99', sway: 0, grab: true }, // chases the ship and grabs it: a barrel roll (R) breaks free
    beacon: { name: 'Faro', hp: 42, every: 1500, shots: 2, color: '#ff5c5c', sway: 0, phases: true }, // at half life it spins and fires all around
    saucer: { name: 'Platillo nodriza', hp: 34, every: 1300, shots: 2, color: '#b47cff', sway: 2200 },
    golem: { name: 'Gólem de piedra', hp: 50, every: 2400, shots: 3, color: '#ffb347', sway: 0 },
    dread: { name: 'Acorazado', hp: 8, every: 1700, shots: 2, color: '#ff2d55', sway: 1200, weak: true }, // only its reactor can be hurt, while the bow doors are open: 3 hits, 3 more, then 2
    station: { name: 'Estación orbital', hp: 28, every: 1500, shots: 2, color: '#6ee7ff', sway: 600, shield: true }, // its shield opens like the crystal's
  };
  const SOLO = Object.keys(BOSSES).filter((k) => k !== 'hand'); // the hands come with the stone face
  const bossKind = (name) => SOLO[[...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % SOLO.length];
  const drawBoss = (o, x, y, R, now) => drawBoss3D(o, x, y, R, now); // every boss is a lit low-poly solid
  function lift(p, kind, size) { // never underground; rings keep a good margin over the terrain so their lower edge can be flown
    const c = C.Cartographic.fromCartesian(p), floor = (scene.globe.getHeight(c) || 0) + (kind === 'ring' ? Math.max(700, size * 1.4) : 200);
    if (c.height < floor) C.Cartesian3.fromRadians(c.longitude, c.latitude, floor, undefined, p);
  }
  function put(kind, side = 0, up = 0, extra = {}) { // places one object ahead of the ship
    const cam = viewer.camera, D = Math.max(2500, s.v * warp * 3.5), p = C.Cartesian3.clone(cam.positionWC);
    for (const [v, k] of [[cam.directionWC, D], [cam.rightWC, side * D], [cam.upWC, up * D]]) C.Cartesian3.add(p, C.Cartesian3.multiplyByScalar(v, k, new C.Cartesian3()), p);
    const o = { kind, p, size: D * 0.07 * (SIZE[kind] || 1), look: 0, next: 1e15, ...extra };
    lift(p, kind, o.size);
    objs.push(o);
    return o;
  }
  const has = (kind) => objs.some((o) => o.kind === kind);
  const turned = (a, b) => Math.abs(C.Math.negativePiToPi(a - b));
  const STEPS = [
    { text: 'Dobla a la izquierda y a la derecha con A y D.', test: (r) => turned(s.heading, r.heading) > rad(25) },
    { text: 'Sube y baja la nariz con S y W.', test: (r) => Math.abs(s.pitch - r.pitch) > rad(8) },
    { text: 'Pulsa E para un turbo breve y Q para detenerte (Q otra vez sigue).', test: (r) => Math.abs(s.v - r.v) > r.v * 0.3 + 30 },
    { text: 'Espacio sube el turbo y Shift izquierdo lo baja; T te eleva un poco.', test: (r) => warp !== r.warp },
    { text: 'Pulsa Y para cambiar entre primera y tercera persona (la nave vista desde atrás).', test: (r) => third !== r.third },
    { text: 'Ese es un enemigo: apúntale con el centro de la mira y dispara con B o clic derecho.', need: 'enemy', make: () => put('enemy'), test: (r) => score >= r.score + 100 },
    { text: 'Atraviesa el aro: da puntos y repara la nave.', need: 'ring', make: () => put('ring', 0.05), test: (r) => score >= r.score + 50 },
    { text: 'Recoge la moneda, el corazón (vida) y el escudo (absorbe un golpe).', need: 'coin', make: () => { put('coin', -0.08); put('heart'); put('shield', 0.08); }, test: (r) => coins > r.coins },
    { text: 'Las cajas de metal son obstáculos: esquívala.', need: 'wall', make: () => put('wall'), test: (r, age) => age > 1500 && !has('wall') },
    { text: 'Haz un tonel con R: desvía disparos y choques.', test: () => !!man && man.type === 'roll' },
    { text: 'Rizo con X y media vuelta con F.', test: () => !!man && (man.type === 'loop' || man.type === 'uturn' || man.type === 'unroll') },
    { text: 'Z aterriza y C despega; en tierra se maneja como un auto.', test: (r, age) => age > 6000 },
    { text: 'Lanza una bomba con V: destruye a todos los enemigos cercanos.', need: 'enemy', make: () => { bombs = Math.max(bombs, 1); put('enemy', -0.1); put('enemy'); put('enemy', 0.1); }, test: (r) => bombs < r.bombs || (r.bombs === 0 && !has('enemy')) },
    { text: 'Un jefe custodia cada capital. Este es de práctica: dispárale hasta vaciar su barra de vida.', need: 'boss', make: () => { const o = put('boss', 0, 0.05, { type: 'fortress', hp: 5, max: 5, cap: null }); o.base = C.Cartesian3.clone(o.p); o.east = viewer.camera.rightWC.clone(); o.size = Math.max(o.size, 400); }, test: (r, age) => age > 1000 && !has('boss') },
    { text: '¡Listo! Ahora colecciona banderas, derrota jefes en las capitales y suma puntos. I: ayuda · O: repetir el tutorial.', test: (r, age) => age > 6000 },
  ];
  const snap = () => ({ warp, third, heading: s.heading, pitch: s.pitch, v: s.v, score, coins, bombs, t: performance.now() });
  function tutorial(startIt) {
    if (!startIt) { tut = null; return; }
    if (!A || !A.ship) return OGE.toast('El tutorial guiado es para la OpenStarshipEarth: elígela al pulsar Volar.');
    arcade = true; objs = []; incoming = []; hp = 100; shields = 0;
    tut = { i: 0, ref: snap() };
  }
  function tutStep() {
    const st = STEPS[tut.i], age = performance.now() - tut.ref.t;
    if (tut.i !== 2) s.v = Math.max(s.v, 250); // keeps moving so the objects ahead are reached (except while practicing the brake)
    if (!st.test(tut.ref, age)) { // not done yet: what the step needs is put ahead, and put back if it was lost
      if (st.make && !has(st.need) && (!tut.made || age > 900)) { st.make(); if (!tut.made) tut.ref = snap(); tut.made = true; }
      return;
    }
    sfx('step');
    objs = []; incoming = [];
    if (++tut.i >= STEPS.length) { tut = null; return OGE.toast('Tutorial terminado. ¡Buen vuelo!'); }
    tut.ref = snap(); tut.made = false;
  }
  function drawTutorial(w) {
    const txt = T(STEPS[tut.i].text), bw = Math.min(w - 40, 620), x = (w - bw) / 2, words = txt.split(' '), lines = [''];
    g.save(); g.font = '600 15px sans-serif';
    for (const wd of words) { if (g.measureText(lines[lines.length - 1] + ' ' + wd).width > bw - 28) lines.push(wd); else lines[lines.length - 1] += (lines[lines.length - 1] ? ' ' : '') + wd; }
    const bh = 40 + lines.length * 20;
    g.shadowBlur = 0; g.fillStyle = 'rgba(8,40,70,.82)'; g.strokeStyle = '#7fd4ff'; g.lineWidth = 2; g.beginPath(); g.roundRect(x, 130, bw, bh, 12); g.fill(); g.stroke();
    g.fillStyle = '#ffd60a'; g.textAlign = 'center'; g.font = '700 12px sans-serif'; g.fillText(`${T('TUTORIAL')} ${tut.i + 1}/${STEPS.length}`, w / 2, 148);
    g.fillStyle = '#fff'; g.font = '600 15px sans-serif'; lines.forEach((l, i) => g.fillText(l, w / 2, 170 + i * 20));
    g.restore();
  }

  // ---------- OpenStarshipEarth arcade: random enemies to shoot, rings to fly through and coins to collect ----------
  // The objects live in the 3D world and are drawn on the HUD at their projected position and size.
  let bursts = []; // bosses blowing up: { p, t, color }
  let arcade = false, objs = [], booms = [], score = 0, coins = 0;
  let maxHp = 100; // grows with the life boosters found over big cities
  let run = { flags: 0, caps: 0, bosses: 0 }; // collected in this flight, for the scoreboard
  let hp = 100, bombs = 3, incoming = [], flash = 0, hit = 0; // incoming: enemy shots { p, vel, t }; flash/hit: time of the last bomb / damage
  const SIZE = { ring: 1, coin: 0.35, enemy: 0.5, wall: 0.6, heart: 0.4, shield: 0.4, bomb: 0.4 };
  // How often each kind appears: hearts and shields are rare, bombs are scarce (about 1 in 40).
  const POOL = Object.entries({ ring: 4, coin: 12, enemy: 12, wall: 8, heart: 2, shield: 2, bomb: 1 }).flatMap(([k, n]) => Array(n).fill(k));
  let shields = 0, broke = 0; // each shield absorbs one hit and breaks; broke: when the last one broke
  const reach = () => Math.max(3000, s.v * warp * 4); // they appear about 4 s ahead, whatever the speed
  function spawn() {
    const cam = viewer.camera, D = reach() * (0.6 + 0.6 * Math.random()), kind = POOL[Math.floor(Math.random() * POOL.length)];
    const p = C.Cartesian3.clone(cam.positionWC), add = (v, k) => C.Cartesian3.add(p, C.Cartesian3.multiplyByScalar(v, k, new C.Cartesian3()), p);
    add(cam.directionWC, D); add(cam.rightWC, (Math.random() - 0.5) * D * 0.5); add(cam.upWC, (Math.random() - 0.5) * D * 0.25);
    const big = kind === 'ring' && Math.random() < 0.25;
    lift(p, kind, D * 0.06 * SIZE[kind] * (big ? 2.5 : 1));
    { const cg = C.Cartographic.fromCartesian(p), sea = scene.globe.getHeight(new C.Cartographic(cg.longitude, cg.latitude)); if (!tut && !OGE.body && sea !== undefined && sea < 1.5 && Math.random() < 0.15 && objs.filter((o) => o.kind === 'ship').length < 3) { objs.push({ kind: 'ship', p: C.Cartesian3.fromRadians(cg.longitude, cg.latitude, 15), cog: Math.random() * 6.28, size: 320, hp: 4, next: performance.now() + 2000 }); return; } // a warship, only over the water
      if (!tut && !OGE.body && sea !== undefined && sea < 1.5 && Math.random() < 0.3 && objs.filter((o) => o.kind === 'octo').length < 4) { objs.push({ kind: 'octo', p: C.Cartesian3.fromRadians(cg.longitude, cg.latitude, 30), size: 260, hp: 2, next: performance.now() + 1500 + Math.random() * 2500 }); return; } } // sea creatures, only over the water
    objs.push({ kind, big, p, rock: kind === 'wall' && (!!OGE.body || (s.alt > SPACE && (s.alt > DEEP || Math.random() < 0.5))), size: D * 0.06 * SIZE[kind] * (big ? 2.5 : 1), look: Math.floor(Math.random() * ENEMY.length), next: performance.now() + 3000 + Math.random() * 4000 }); // sized for the speed it was created at; next: when an enemy fires
  }
  function hurt(n) {
    if (tut || performance.now() < graceT) { hit = performance.now(); return; } // nothing hurts during the tutorial or the grace time
    if (landing === 'parked' && OGE.body) return; // landed (Z) and driving over the Moon or Mars: nothing hurts
    if (shields) { shields--; broke = hit = performance.now(); return sfx('shieldBreak'); } // the shield takes the hit and breaks
    n *= DIFF[diff].hurt;
    hp -= n; hit = performance.now(); beep(200, 80, 0.25);
    if (race && race.coins) { race.coins = Math.max(0, race.coins - 2); A.vMax = race.vBase * (1 + 0.04 * race.coins); } // a hit costs speed coins
    if (hp <= 0) {
      mpSend({ t: 'dead' });
      [520, 390, 290, 200, 110].forEach((f, i) => setTimeout(() => beep(f, f * 0.55, 0.35), i * 190)); // falling notes: the ship is lost
      stop(`Nave destruida: ${score} puntos y ${coins} monedas.`, true);
      const again = relaunch, offer = () => { if (document.querySelector('dialog[open]')) return setTimeout(offer, 300); OGE.ask({ title: T('Nave destruida'), ok: T('Reintentar'), help: T('¿Lo intentas otra vez?') }).then((v) => { if (v && again && !on) again(); }); };
      if (again) setTimeout(offer, 600);
    }
  }
  const shieldOpen = (o, now = performance.now()) => { // can it be hurt now? the crystal's shield opens 2 s out of every 5; a weak point shows 2.5 s out of every 7, and stays shut for a while after each phase
    const B = BOSSES[o.type];
    return B.weak ? now > (o.lockT || 0) && (now - (o.born || 0)) % 7000 > 4500 : !B.shield || (now - (o.born || 0)) % 5000 > 3000;
  };
  const escortsUp = (o) => objs.filter((x) => x.kind === 'enemy' && x.from === o).length;
  function hitBoss(o, n) { // a boss guards each capital in the arcade: beating it wins the capital
    if (!shieldOpen(o)) { booms.push({ p: o.p, t: performance.now() }); return sfx('shieldBreak'); } // deflected by the crystal shield
    if (BOSSES[o.type].spawns && escortsUp(o) >= 2) { booms.push({ p: o.p, t: performance.now() }); return sfx('shieldBreak'); } // the hive's core is covered
    if (BOSSES[o.type].weak) n = 1; // the reactor takes one hit at a time, whatever hits it
    if (BOSSES[o.type].grab && o.phase === 'windup') { n *= 2; o.phase = 'stun'; o.pt = performance.now(); o.held = 0; OGE.toast(T('¡Punto débil! La mano se retira.')); } // caught open: double damage and it backs off
    o.hp -= n; o.hitT = performance.now(); booms.push({ p: o.p, t: performance.now() }); beep(260, 90, 0.2); sfx('bossHit'); // a metallic clang for every hit
    if (BOSSES[o.type].weak && (o.hp === 5 || o.hp === 2)) { o.stage = o.hp === 5 ? 2 : 3; o.lockT = performance.now() + 3000; OGE.toast(`${T('El Acorazado cierra su reactor: fase')} ${o.stage}/3`); sfx('warpUp'); } // next phase: it shuts and fires faster
    if (o.hp > 0) return;
    bursts.push({ p: C.Cartesian3.clone(o.p), t: performance.now(), color: BOSSES[o.type].color });
    objs.splice(objs.indexOf(o), 1); gain(pts(o.from ? 300 : 1000)); if (!o.from) run.bosses++; flash = performance.now(); sfx('boss');
    if (o.type === 'face') objs = objs.filter((x) => { if (x.from !== o) return true; booms.push({ p: x.p, t: performance.now() }); return false; }); // its hands fall with it
    if (o.cap) { // the practice boss of the tutorial guards no capital
      const c = o.cap; dropCrest(c); owe(c, true);
      OGE.toast(`${T('Jefe derrotado: recoge el escudo de')} ${c.name}.`);
    }
  }
  function bomb() { // clears every enemy and shot in range
    if (!on || paused || !arcade) return;
    if (!bombs) return OGE.toast('Sin bombas: cada 25 monedas ganas una.');
    const cam = viewer.camera, R = reach() * 1.3;
    bombs--; incoming = []; flash = performance.now(); beep(160, 40, 0.6);
    for (const o of objs.filter((x) => x.kind === 'boss' && C.Cartesian3.distance(x.p, cam.positionWC) < Math.max(R, 6e4))) hitBoss(o, 6);
    objs = objs.filter((o) => {
      if (o.kind !== 'enemy' || C.Cartesian3.distance(o.p, cam.positionWC) > R) return true;
      score += 100; booms.push({ p: o.p, t: flash });
      return false;
    });
  }
  let aaT = 0, aaBusy = false, aaAt = null; // anti-aircraft sites from OpenStreetMap, asked again after flying ~40 km
  async function aaSites() {
    if (OGE.body) return;
    const lo = deg(s.lon), la = deg(s.lat);
    if (aaBusy || (aaAt && Math.hypot(lo - aaAt[0], la - aaAt[1]) < 0.15) || performance.now() < aaT) return;
    aaBusy = true; aaT = performance.now() + 20000; aaAt = [lo, la];
    try {
      const r = 0.12, bb = `${la - r},${lo - r},${la + r},${lo + r}`; // about 13 km around: only the nearby ones, and few, to keep the game light
      const q = `[out:json][timeout:20];(way[landuse=military](${bb});node[military](${bb});)->.m;node[amenity=police](${bb})->.p;node[amenity=fuel](${bb})->.f;nwr[aeroway=aerodrome](${bb})->.a;.m out center 4;.p out center 4;.f out center 2;.a out center 8;`; // military and police first: a big city has hundreds of fuel stations
      const j = await OGE.overpass(q, 25000); // several mirrors at once: the main server is often full
      objs = objs.filter((o) => o.kind !== 'aa' || C.Cartesian3.distance(o.p, viewer.camera.positionWC) < 2e4); // the far ones go
      for (const e of j.elements || []) { // airfields: places to land and heal
        const lon = e.lon ?? (e.center && e.center.lon), lat = e.lat ?? (e.center && e.center.lat);
        if (lon != null && e.tags && e.tags.aeroway === 'aerodrome' && airports && !airports.some(([x, y]) => Math.abs(x - lon) < 0.02 && Math.abs(y - lat) < 0.02)) airports.push([lon, lat]);
      }
      for (const e of (j.elements || []).filter((x) => !(x.tags && x.tags.aeroway)).slice(0, 8)) {
        const lon = e.lon ?? (e.center && e.center.lon), lat = e.lat ?? (e.center && e.center.lat);
        if (lon == null || objs.some((o) => o.kind === 'aa' && o.osm === e.id)) continue;
        const gh = scene.globe.getHeight(C.Cartographic.fromDegrees(lon, lat)) || 0, t = e.tags || {};
        objs.push({ kind: 'aa', osm: e.id, lon, lat, p: C.Cartesian3.fromDegrees(lon, lat, gh + 40), size: 300, hp: 2, next: performance.now() + 2000 + Math.random() * 3000,
          label: t.landuse === 'military' || t.military ? T('Base militar') : t.amenity === 'police' ? T('Policía') : T('Gasolinera') });
      }
    } catch { /* no data: the flight goes on without them */ }
    aaBusy = false;
  }
  function arcadeStep(dt) {
    if (auto) return; // the autopilot brings its own enemies
    if (A.ship && s.alt > 1e5 && warp > 100) { if (objs.length || incoming.length) { objs = objs.filter((o) => o.kind === 'boss' || o.kind === 'crest'); incoming = []; } return; } // hyper turbo: nothing to dodge or collect on the way (it would run into everything); at the turbo of the air, space has its enemies and prizes too
    if (!tut && !race && performance.now() > aaT) aaSites();
    if (tune) { const BT = window.OGE_BOSS_THEME, near = BT && objs.some((o) => o.kind === 'boss' && C.Cartesian3.distance(o.p, viewer.camera.positionWC) < 1e5), base = (OGE.body === 'moon' && window.OGE_MOON_THEME) || (OGE.body === 'mars' && window.OGE_MARS_THEME) || (adv && window.OGE_ADV_THEME) || (race && window.OGE_RACE_THEME) || TH, want = near ? BT : base; if (want !== tune) music(true, want); } // Boss Fight OpenStarshipEarth while a boss is close
    const cam = viewer.camera, t = new C.Cartesian3(), far = reach() * 2.5, eff = s.v * warp, slack = eff * 0.03, now = performance.now(); // slack: distance covered in one frame
    const rolling = man && man.type === 'roll'; // a barrel roll deflects enemies and shots
    objs = objs.filter((o) => {
      C.Cartesian3.subtract(o.p, cam.positionWC, t);
      const d = C.Cartesian3.magnitude(t);
      if (o.kind === 'boss') { // stays at its capital until left far behind
        const sw = BOSSES[o.type].sway; // snakes and dragons weave around their post
        const bc = C.Cartographic.fromCartesian(o.base), gh = scene.globe.getHeight(bc); // finer terrain may load later: keep 6 km over it
        if (gh !== undefined && bc.height < gh + 5000) o.base = C.Cartesian3.fromRadians(bc.longitude, bc.latitude, gh + 6000);
        const B = BOSSES[o.type], up = C.Cartesian3.normalize(o.base, new C.Cartesian3());
        if (B.grab) { // the hand: keeps pace a little ahead of the ship, winds up (fingers spread, red glow), then lunges to grab it
          const cp = cam.positionWC, ahead = C.Cartesian3.add(cp, C.Cartesian3.multiplyByScalar(cam.directionWC, 2500, new C.Cartesian3()), new C.Cartesian3());
          C.Cartesian3.add(ahead, C.Cartesian3.multiplyByScalar(cam.rightWC, (o.mirror || 0) * 1300 + Math.sin(now / 900) * 900, t), ahead); // sways from side to side; a pair keeps to each side
          const chase = Math.max(900, s.v * warp * 1.3) * dt, toward = (p, sp) => { const v = C.Cartesian3.subtract(p, o.p, new C.Cartesian3()), m = C.Cartesian3.magnitude(v); if (m > 1) C.Cartesian3.add(o.p, C.Cartesian3.multiplyByScalar(v, Math.min(1, sp / m), v), o.p); };
          const far = C.Cartesian3.distance(cp, o.base) > 3e4; // only near its capital (30 km): otherwise it waits at home
          const seen = C.Cartesian3.dot(C.Cartesian3.subtract(o.p, cp, new C.Cartesian3()), cam.directionWC) > 0; // it only lunges from in front, where it can be seen
          o.phase = o.phase || 'hover'; o.pt = o.pt || now;
          if (o.held) { C.Cartesian3.clone(cp, o.p); C.Cartesian3.add(o.p, C.Cartesian3.multiplyByScalar(cam.directionWC, 250, t), o.p); }
          else if (far) { toward(o.base, chase); o.phase = 'hover'; o.pt = now; o.met = 0; }
          else if (o.phase === 'hover') { o.met = o.met || now; toward(ahead, chase); if (seen && now - o.met > 6000 && now - o.pt > 4000 + Math.random() * 2000 && now > graceT) { o.phase = 'windup'; o.pt = now; sfx('warpDown'); OGE.toast(T('¡La mano va a atacar! Dispara a su punto débil o prepara un tonel (R).')); } } // first it shows itself for a while
          else if (o.phase === 'windup') { toward(ahead, chase); if (now - o.pt > 2500) { o.beamT = now; sfx('shieldBreak'); if (!rolling) hurt(18); o.phase = 'lunge'; o.pt = now; } } // 2.5 s with its weak point open: left alone, the ray fires (a barrel roll deflects it) and then it lunges
          else if (o.phase === 'stun') { toward(o.from ? C.Cartesian3.add(o.base, C.Cartesian3.multiplyByScalar(o.east, (o.mirror || 0) * 1500, new C.Cartesian3()), new C.Cartesian3()) : o.base, chase * 1.5); if (now - o.pt > 6000) { o.phase = 'hover'; o.pt = now; o.met = now; } } // hit on its weak point: back beside its face (or home), closed, until it recovers
          else if (o.phase === 'lunge') { toward(cp, Math.max(1200, s.v * warp * 1.6) * dt); if (now - o.pt > 1500) { o.phase = 'back'; o.pt = now; } }
          else { toward(ahead, chase * 0.6); if (now - o.pt > 1200) { o.phase = 'hover'; o.pt = now; } }
          const dd = C.Cartesian3.distance(cp, o.p);
          if (!o.held && o.phase === 'lunge' && dd < 600 + slack && now > (o.grabCd || 0)) { o.held = now; o.phase = 'back'; OGE.toast(T('¡La mano te atrapó! Haz un tonel (R) para soltarte.')); sfx('shieldBreak'); }
          if (o.held) {
            s.v *= Math.max(0, 1 - 4 * dt); // it holds the ship still
            if (rolling || now - o.held > 4000) { o.held = 0; o.grabCd = now + 4000; o.pt = now; sfx('roll'); } // a barrel roll breaks free (it lets go by itself after 4 s)
            else if (now - (o.squeeze || 0) > 600) { o.squeeze = now; hurt(6); }
          }
        } else {
          const p = C.Cartesian3.clone(o.base), north = C.Cartesian3.cross(up, o.east, new C.Cartesian3()), wide = Math.max(2500, (sw || 0) * 1.6); // they roam around their post
          C.Cartesian3.add(p, C.Cartesian3.multiplyByScalar(up, Math.sin(now / 1700) * 900, t), p);
          C.Cartesian3.add(p, C.Cartesian3.multiplyByScalar(o.east, Math.sin(now / 2300) * wide, t), p);
          C.Cartesian3.add(p, C.Cartesian3.multiplyByScalar(north, Math.sin(now / 1150) * wide * 0.6, t), p); // a slow figure eight
          C.Cartesian3.clone(p, o.p);
        }
        if (B.spawns && now > (o.spawnT || 0) && escortsUp(o) < 3) { // the hive launches an escort near itself
          o.spawnT = now + 4500;
          const p = C.Cartesian3.add(o.p, C.Cartesian3.multiplyByScalar(cam.rightWC, (Math.random() - 0.5) * 2500, new C.Cartesian3()), new C.Cartesian3());
          objs.push({ kind: 'enemy', from: o, look: 2, p, size: 260, next: now + 1500 });
        }
        if (B.phases && o.hp <= o.max / 2 && !o.rage) { o.rage = true; OGE.toast(T('¡El Faro entra en furia!')); sfx('warpUp'); } // second phase
        if (d < o.size + slack && now - hit > 800 && !rolling) hurt(30);
        return d < 4e5;
      }
      if (o.kind === 'mine' && performance.now() > o.until) return false; // mines go off after a while
      if (o.lon != null && !o.lifted && ['itembox', 'gate', 'zip', 'scoin'].includes(o.kind)) { const gh = scene.globe.getHeight(C.Cartographic.fromDegrees(o.lon, o.lat)); if (gh !== undefined) { o.p = C.Cartesian3.fromDegrees(o.lon, o.lat, gh + (o.up || 1200)); o.lifted = true; } } // over the terrain once it is known
      const fixed = ['crest', 'life', 'airliner', 'itembox', 'mine', 'aa', 'gate', 'zip', 'scoin', 'octo', 'ship'].includes(o.kind); // these wait where they are instead of being left behind
      if (o.kind === 'ring') {
        const along = C.Cartesian3.dot(t, cam.directionWC), side = Math.sqrt(Math.max(0, d * d - along * along)), was = o.along; o.along = along;
        if (was > 0 && along <= 0 && side < o.size * 1.15) { // crossed its plane this frame
          if (side < o.size * 0.85) { score += pts(o.big ? 30 : 50); hp = Math.min(maxHp, hp + 10); sfx('ring'); } // through the middle: points and repair
          else if (!rolling) hurt(15); // clipped the rim
          return false;
        }
      }
      else if (d < o.size * 1.6 + slack) { // touched
        if (o.kind === 'enemy' || o.kind === 'airliner') { if (!rolling && landing !== 'parked') hurt(25); } // driving on the ground, what lies in the way does not hurt
        else if (o.kind === 'wall') { if (landing !== 'parked') hurt(20); } // obstacles always hurt in the air
        else if (o.kind === 'heart') { hp = Math.min(maxHp, hp + 25); sfx('heart'); }
        else if (o.kind === 'life') { maxHp = Math.min(300, maxHp + 25); hp = maxHp; usedTowns.add(o.town); sfx('achieve'); OGE.toast(`${T('Vida máxima')}: ${maxHp}`); }
        else if (o.kind === 'crest') collect(o.cap); // the coat of arms wins the capital
        else if (o.kind === 'shield') { shields = Math.min(3, shields + 1); sfx('shield'); }
        else if (o.kind === 'bomb') { bombs++; sfx('bombGet'); }
        else if (o.kind === 'itembox') { if (!giveItem(o.item || Object.keys(BALLOON)[Math.floor(Math.random() * 4)])) return true; }
        else if (o.kind === 'gate') { if (race && race.gates[race.nextGate] === o) { race.nextGate++; sfx('ring'); beep(990, 120, 0.25); return false; } return true; } // only the next gate counts
        else if (o.kind === 'zip') { if (!boost) { boostCd = 0; startBoost(); sfx('warpUp'); } return true; } // boost rings stay
        else if (o.kind === 'scoin') { if (race) { race.coins = Math.min(10, race.coins + 1); A.vMax = race.vBase * (1 + 0.04 * race.coins); } sfx('coin'); }
        else if (o.kind === 'mine') { if (o.own) return true; hurt(25); booms.push({ p: o.p, t: performance.now() }); }
        else {
          score += pts(10);
          if (++coins % 25 === 0) bombs++;
          sfx(o.kind); // coin
        }
        return false;
      }
      if (fixed) return ['itembox', 'mine', 'gate', 'zip', 'scoin'].includes(o.kind) || (o.kind === 'aa' || o.kind === 'octo' || o.kind === 'ship' ? d < 6e4 : d < 4e5); // the race's boxes stay along the whole route
      const gone = C.Cartesian3.dot(t, cam.directionWC) < -o.size; // left behind
      if (gone && o.kind === 'ring' && on) hurt(5); // a ring that was not flown through costs life
      return !gone && d < far;
    });
    if (!on) return; // destroyed
    for (const o of objs) { // enemies fire at where the ship will be if it keeps flying straight
      const boss = o.kind === 'boss';
      if ((o.kind !== 'enemy' && o.kind !== 'airliner' && o.kind !== 'aa' && o.kind !== 'octo' && o.kind !== 'ship' && !boss) || now < o.next) continue;
      if (o.kind === 'octo' && C.Cartesian3.distance(o.p, cam.positionWC) > 1.2e4) { o.next = now + 1500; continue; }
      if (o.kind === 'ship' && C.Cartesian3.distance(o.p, cam.positionWC) > 1.4e4) { o.next = now + 1500; continue; } // its guns reach further than the octopus's ink
      if (o.kind === 'aa' && C.Cartesian3.distance(o.p, cam.positionWC) > 1e4) { o.next = now + 1500; continue; } // anti-aircraft: only within 10 km
      o.next = now + DIFF[diff].fire * (boss ? (BOSSES[o.type].every / (o.stage || 1)) * (0.8 + Math.random() * 0.4) : o.kind === 'ship' ? 1600 + Math.random() * 1400 : 4000 + Math.random() * 4000); // a warship fires about three times as often
      const d = C.Cartesian3.distance(o.p, cam.positionWC), speed = (eff * 0.5 + 600) * DIFF[diff].shot, tt = d / (speed + eff);
      if (boss ? d > Math.max(reach() * 1.3, 6e4) : d > reach() * 1.3 || C.Cartesian3.dot(C.Cartesian3.subtract(o.p, cam.positionWC, t), cam.directionWC) < 0) continue;
      const target = C.Cartesian3.add(p2 && !p2.out && p2.p && Math.random() < 0.5 ? p2.p : cam.positionWC, C.Cartesian3.multiplyByScalar(cam.directionWC, eff * tt, new C.Cartesian3()), new C.Cartesian3()); // half the shots go for player 2
      const panels = boss && o.type === 'face' && (o.volley = (o.volley || 0) + 1) % 2 === 1; // the stone face spits panels one volley, fires lasers the next
      const n = boss ? (o.rage ? 8 : panels ? 7 : BOSSES[o.type].shots) : 1; // a volley fans out sideways (a raging beacon fires eight)
      if (boss || o.kind === 'aa' || o.kind === 'octo' || o.kind === 'ship') o.spat = now;
      for (let i = 0; i < n; i++) {
        const spread = o.rage ? 0.18 : panels ? 0.09 : 0.05, aim = C.Cartesian3.add(target, C.Cartesian3.multiplyByScalar(o.rage && i % 2 ? cam.upWC : cam.rightWC, (i - (n - 1) / 2) * d * spread, new C.Cartesian3()), new C.Cartesian3());
        incoming.push({ p: C.Cartesian3.clone(o.p), vel: C.Cartesian3.multiplyByScalar(C.Cartesian3.subtract(aim, o.p, t), 1 / tt, new C.Cartesian3()), t: now, color: boss ? BOSSES[o.type].color : o.kind === 'octo' ? '#2b1640' : o.kind === 'ship' ? '#ffb300' : '#ff2df5', dmg: o.kind === 'ship' ? 14 : 8, ink: o.kind === 'octo', panel: panels, fire: boss && o.type === 'dragon', spin: Math.random() * 6 });
      }
    }
    incoming = incoming.filter((b) => {
      if (b.fire) { const sp = C.Cartesian3.magnitude(b.vel), to = C.Cartesian3.normalize(C.Cartesian3.subtract(cam.positionWC, b.p, new C.Cartesian3()), new C.Cartesian3()), cur = C.Cartesian3.normalize(b.vel, new C.Cartesian3()); C.Cartesian3.lerp(cur, to, Math.min(1, 2.2 * dt), cur); C.Cartesian3.multiplyByScalar(C.Cartesian3.normalize(cur, cur), sp, b.vel); } // fireballs turn towards the ship
      C.Cartesian3.add(b.p, C.Cartesian3.multiplyByScalar(b.vel, dt, t), b.p);
      if (C.Cartesian3.distance(b.p, cam.positionWC) < 40 + slack * 1.5) { if (!rolling) hurt(b.dmg || 8); return false; }
      return now - b.t < 8000;
    });
    if (on && !tut && $('layerPlanes').checked && performance.now() > (liveT || 0)) liveEnemies(); // real aircraft nearby join as tougher enemies
    aisStep();
    while (on && !tut && objs.filter((o) => !['boss', 'crest', 'life', 'octo', 'aa', 'ship'].includes(o.kind)).length < 10) spawn();
  }
  function drawArcade(w, h, text) {
    const f = h / 2 / Math.tan((viewer.camera.frustum.fovy || rad(60)) / 2), toWin = C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates, now = performance.now();
    const occ = new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, viewer.camera.positionWC), camP = viewer.camera.positionWC;
    for (const o of objs) {
      if (!occ.isPointVisible(o.p) || (['itembox', 'mine', 'gate', 'zip', 'scoin'].includes(o.kind) && C.Cartesian3.distance(o.p, camP) > 6e4)) continue; // beyond the horizon, or race items too far to matter
      const q = toWin(scene, o.p);
      if (!q) continue; // behind the camera
      const pr = Math.max(4, (o.size / C.Cartesian3.distance(o.p, viewer.camera.positionWC)) * f);
      g.save(); g.shadowBlur = 8; g.beginPath();
      if (o.kind === 'gate') { const nx = race && race.gates[race.nextGate] === o, R = Math.max(10, pr); g.save(); g.lineWidth = Math.max(3, R * 0.14); g.strokeStyle = g.shadowColor = nx ? '#34c759' : 'rgba(52,199,89,.35)'; g.shadowBlur = nx ? 16 : 0; g.beginPath(); g.arc(q.x, q.y, R, 0, 7); g.stroke(); g.fillStyle = '#fff'; g.textAlign = 'center'; g.font = `800 ${Math.round(Math.max(12, R * 0.45))}px sans-serif`; g.fillText(String(o.n), q.x, q.y - R - 6); g.restore(); }
      else if (o.kind === 'zip') { const R = Math.max(8, pr), t = now / 150; g.save(); g.lineWidth = Math.max(3, R * 0.18); g.strokeStyle = g.shadowColor = `hsl(${(t * 40) % 360},100%,60%)`; g.shadowBlur = 18; g.beginPath(); g.arc(q.x, q.y, R, 0, 7); g.stroke(); g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `800 ${Math.round(R * 0.8)}px sans-serif`; g.fillText('»', q.x, q.y); g.restore(); }
      else if (o.kind === 'scoin') { const R = Math.max(5, pr), turn = Math.abs(Math.cos(now / 250)); g.save(); g.fillStyle = g.shadowColor = '#d7d7e0'; g.shadowBlur = 10; g.beginPath(); g.ellipse(q.x, q.y, R * turn + 1, R, 0, 0, 7); g.fill(); g.fillStyle = '#9aa0b0'; g.beginPath(); g.ellipse(q.x, q.y, (R * turn + 1) * 0.6, R * 0.6, 0, 0, 7); g.fill(); g.restore(); }
      else if (o.kind === 'itembox' && o.item) { const R = Math.max(8, pr), c = BALLOON[o.item], bob = Math.sin(now / 400 + o.lon * 100) * R * 0.15; g.save(); g.strokeStyle = '#ddd'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(q.x, q.y + R + bob); g.quadraticCurveTo(q.x + R * 0.3, q.y + R * 1.6, q.x, q.y + R * 2.2); g.stroke(); const gr = g.createRadialGradient(q.x - R * 0.35, q.y - R * 0.4 + bob, R * 0.1, q.x, q.y + bob, R); gr.addColorStop(0, '#fff'); gr.addColorStop(0.25, c); gr.addColorStop(1, '#222'); g.fillStyle = gr; g.shadowColor = c; g.shadowBlur = 12; g.beginPath(); g.ellipse(q.x, q.y + bob, R * 0.85, R, 0, 0, 7); g.fill(); g.restore(); } // a balloon in the colour of its item
      else if (o.kind === 'itembox') { const R = Math.max(8, pr), t = now / 400; g.save(); g.translate(q.x, q.y); g.rotate(t); const gr = g.createLinearGradient(-R, -R, R, R); ['#ff453a', '#ffd60a', '#34c759', '#0a84ff', '#bf5af2'].forEach((c, i) => gr.addColorStop(i / 4, c)); g.fillStyle = gr; g.globalAlpha = 0.85; g.fillRect(-R, -R, R * 2, R * 2); g.globalAlpha = 1; g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(-R, -R, R * 2, R * 2); g.rotate(-t); g.fillStyle = '#fff'; g.font = `700 ${Math.round(R * 1.3)}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('?', 0, 2); g.restore(); }
      else if (o.kind === 'mine') drawMesh(MINE, foeAxes(o.p, now / 1100), { h: '#3d424e', s: '#23262e', w: '#8b93a5', e: (now / 300) % 2 < 1 ? '#ff453a' : '#5a0d0a' }, false, meshScale(o.p, Math.max(6, pr) * 1.3, h), null, true); // a spiked sea mine, its light blinking
      else if (o.kind === 'ship') { // a grey warship on the water, pointing where it sails
        if (o.sog) { const dd = (o.sog * 0.5144 * (now - o.t0)) / 1000 / 6371000; o.p = C.Cartesian3.fromRadians(o.lon0 + (dd * Math.sin(o.cog)) / Math.cos(o.lat0), o.lat0 + dd * Math.cos(o.cog), 15); } // a live one keeps its course and speed between reports
        const R = Math.max(12, pr * 1.6); drawMesh(WARSHIP, axesAt(o.p, o.cog || 0, 0, 0), { h: '#b8c0cc', s: '#8a93a2', d: '#59616f', e: '#7a2f28' }, now - (o.hitT || 0) < 90, meshScale(o.p, R, h), null, true);
        if (now - (o.spat || 0) < 250) glow(g, q.x, q.y - R * 0.3, R * 0.5, '#ffd60a'); // its guns firing
        if (o.mmsi) { g.shadowBlur = 0; g.fillStyle = '#cfe8ff'; g.textAlign = 'center'; g.font = '600 11px sans-serif'; g.fillText('AIS ' + o.mmsi, q.x, q.y + R + 12); }
      }
      else if (o.kind === 'octo') { // a hill between the camera and the sea hides it: checked four times a second
        if (now > (o.seeT || 0)) { o.seeT = now + 250; const cp = viewer.camera.positionWC, hitG = scene.globe.pick(new C.Ray(cp, C.Cartesian3.normalize(C.Cartesian3.subtract(o.p, cp, new C.Cartesian3()), new C.Cartesian3())), scene); o.hid = !!hitG && C.Cartesian3.distance(hitG, cp) < C.Cartesian3.distance(o.p, cp) - 300; }
        if (!o.hid) drawMesh(octoMesh(now / 1000, now - (o.spat || 0) < 300), foeAxes(o.p, Math.sin(now / 1300) * 0.3), { h: '#6fe0d2', s: '#2fb8a8', d: '#155e58', e: '#ffffff', m: '#d0302a', k: '#0e3f3a' }, now - (o.hitT || 0) < 90, meshScale(o.p, Math.max(10, pr * 1.5) * 1.2, h), '#2fd3c4');
      }
      else if (o.kind === 'aa') { // an anti-aircraft gun: a squat base, a turret and twin barrels raised towards the ship
        const R = Math.max(10, pr * 1.4); g.save();
        drawMesh(AAGUN, foeAxes(o.p, 0), { h: '#7d8c3a', s: '#5f6d2a', d: '#3a4219' }, false, meshScale(o.p, R * 1.3, h), null, true);
        if (now - (o.spat || 0) < 250) glow(g, q.x, q.y - R * 0.9, R * 0.45, '#ffd60a'); // muzzle flash
        g.restore(); g.fillStyle = '#ffb3a8'; g.textAlign = 'center'; g.font = '600 11px sans-serif'; g.fillText(o.label, q.x, q.y + R + 12);
      }
      else if (o.kind === 'ring') { // it always faces the ship, so it is shaded as a torus rather than built as a mesh
        const lw = Math.max(3, pr * 0.15), gr = g.createLinearGradient(0, q.y - pr - lw, 0, q.y + pr + lw); gr.addColorStop(0, '#fff6b0'); gr.addColorStop(0.35, '#ffd21a'); gr.addColorStop(0.7, '#f09a00'); gr.addColorStop(1, '#a85a00');
        g.shadowColor = '#ffd60a'; g.shadowBlur = 14; g.strokeStyle = '#7a4200'; g.lineWidth = lw + 3; g.arc(q.x, q.y, pr, 0, 7); g.stroke(); g.shadowBlur = 0; g.strokeStyle = gr; g.lineWidth = lw; g.stroke();
        g.lineCap = 'round'; g.strokeStyle = 'rgba(255,255,255,.8)'; g.lineWidth = Math.max(1, lw * 0.22); g.beginPath(); g.arc(q.x, q.y, pr + lw * 0.2, -2.6, -1.3); g.stroke(); // the light it catches
        g.strokeStyle = 'rgba(110,55,0,.5)'; g.beginPath(); g.arc(q.x, q.y, pr - lw * 0.25, 0.4, 2.2); g.stroke(); // the shade inside
        g.lineCap = 'butt'; g.strokeStyle = 'rgba(122,66,0,.7)'; g.lineWidth = Math.max(1, lw * 0.16); for (let n = 0; n < 8; n++) { const a = now / 2500 + (n * Math.PI) / 4, c = Math.cos(a), sn = Math.sin(a); g.beginPath(); g.moveTo(q.x + c * (pr - lw / 2), q.y + sn * (pr - lw / 2)); g.lineTo(q.x + c * (pr + lw / 2), q.y + sn * (pr + lw / 2)); g.stroke(); } // its eight segments, turning slowly
      }
      else if (o.kind === 'coin') drawMesh(COIN, foeAxes(o.p, now / 260 + (o.p.x % 6)), { h: '#ffcf1a', d: '#b87400', w: '#fff1a0' }, false, meshScale(o.p, Math.max(6, pr) * 1.25, h), '#ffd60a'); // a thick gold coin with a star on each face, spinning
      else if (o.kind === 'shield') { const R = Math.max(8, pr), br = R * (1.35 + 0.06 * Math.sin(now / 300)), gr = g.createRadialGradient(q.x - br * 0.3, q.y - br * 0.35, br * 0.1, q.x, q.y, br); gr.addColorStop(0, 'rgba(255,255,255,.55)'); gr.addColorStop(0.4, 'rgba(90,180,255,.18)'); gr.addColorStop(1, 'rgba(10,132,255,.5)');
        g.shadowColor = '#0a84ff'; g.shadowBlur = 14; g.fillStyle = gr; g.arc(q.x, q.y, br, 0, 7); g.fill(); g.shadowBlur = 0; g.strokeStyle = 'rgba(200,235,255,.8)'; g.lineWidth = 1.5; g.stroke(); // the bubble
        drawMesh(GEM, foeAxes(o.p, Math.sin(now / 600) * 0.9), { h: '#8fd0ff', s: '#2f8df0', d: '#0b4fb0', g: '#e6f6ff' }, false, meshScale(o.p, R * 1.1, h)); }
      else if (o.kind === 'bomb') drawMesh(BOMB, foeAxes(o.p, now / 700), { h: '#3d424e', s: '#262a33', w: '#9aa2ae', e: '#ffb300' }, false, meshScale(o.p, Math.max(8, pr) * 1.2, h), '#ff9f0a');
      else if (o.kind === 'heart' || o.kind === 'life') { // glossy heart; the life booster is green and bigger
        const life = o.kind === 'life', R = Math.max(10, pr) * (life ? 1.5 : 1);
        drawMesh(HEART, foeAxes(o.p, Math.sin(now / 450 + (o.p.x % 5)) * 1.1), life ? { h: '#5fe03a', s: '#2f9a1c', d: '#1f7a10', x: '#ffffff' } : { h: '#ff3b62', s: '#c4103a', d: '#8f0028', x: '#ff3b62' }, false, meshScale(o.p, R * 1.15, h), life ? '#7dff5a' : '#ff5c7c');
        g.shadowBlur = 0;
        if (life) { g.fillStyle = '#fff'; g.textAlign = 'center'; g.font = '600 11px sans-serif'; g.fillText(T('Más vida') + (o.town ? ' · ' + o.town.name : ''), q.x, q.y + R + 14); }
      }
      else if (o.kind === 'wall' && o.rock) drawMesh(ASTEROID, foeAxes(o.p, now / 1400 + (o.p.x % 6)), { h: '#9a8f84', s: '#6b625a', d: '#453e38' }, false, meshScale(o.p, pr * 1.15, h), null, true); // out in space the obstacle is an asteroid
      else if (o.kind === 'wall') drawMesh(CRATE, foeAxes(o.p, now / 900 + (o.p.x % 6)), { h: '#c3c9d2', d: '#4e5561', s: '#8d95a1', w: '#6a727e', f: '#a3abb7', r: '#e6eaf0', y: '#e3b21c', k: '#22252b' }, false, meshScale(o.p, pr * 1.15, h), null, true); // a steel crate, turning
      else if (o.kind === 'crest') { // the national coat of arms dropped by a beaten boss
        const R = Math.max(26, pr * 2), im = o.img;
        g.shadowColor = '#ffe27a'; g.shadowBlur = 22;
        if (im && im.complete && im.naturalWidth) g.drawImage(im, q.x - R, q.y - (R * im.naturalHeight) / im.naturalWidth, R * 2, (R * 2 * im.naturalHeight) / im.naturalWidth);
        else { g.fillStyle = '#ffd23a'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = R * 1.6 + 'px sans-serif'; g.fillText('★', q.x, q.y); }
        g.shadowBlur = 0; g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.font = '600 12px sans-serif'; g.fillText(T('Recoge el escudo de') + ' ' + o.cap.name, q.x, q.y + R + 16);
      }
      else if (o.kind === 'boss') {
        const R = Math.max(14, pr);
        drawBoss(o, q.x, q.y, R, now);
        g.shadowBlur = 0; g.fillStyle = '#300'; g.fillRect(q.x - 40, q.y - R * 1.5 - 16, 80, 6); g.fillStyle = '#ff453a'; g.fillRect(q.x - 40, q.y - R * 1.5 - 16, (80 * o.hp) / o.max, 6); // its life
        g.fillStyle = '#fff'; g.textAlign = 'center'; g.font = '600 12px sans-serif'; g.fillText(`${T(BOSSES[o.type].name)} · ${o.cap ? o.cap.name : T('práctica')} · ${o.hp}/${o.max}`, q.x, q.y - R * 1.5 - 22);
      }
      else if (o.kind === 'airliner') { // a real flight: the airliner icon turned along its track, with its callsign
        const R = Math.max(14, pr * 2); drawMesh(AIRLINER, axesAt(o.p, rad(o.a.track || 0), 0, 0), { h: '#f4f6f9', s: '#d5dae3', d: '#9aa3b2', w: '#ffd60a' }, now - (o.hitT || 0) < 90, meshScale(o.p, R, h), '#ffd60a', true);
        g.fillStyle = '#ffd60a'; g.textAlign = 'center'; g.font = '700 11px sans-serif'; g.fillText(`${(o.a.flight || o.a.r || '').trim()} · ${'●'.repeat(o.hp)}`, q.x, q.y + R + 12);
      }
      else { const R = Math.max(12, pr * 1.6), fo = FOES[(o.look || 0) % FOES.length]; drawMesh(fo.mesh, foeAxes(o.p, Math.sin(now / 700 + o.p.x) * 0.35), fo.col, false, meshScale(o.p, R, h), ['#ff6b5e', '#7fe3ff', '#e08bff'][(o.look || 0) % 3]); } // enemy craft, in 3D
      g.restore();
    }
    booms = booms.filter((b) => now - b.t < 350);
    for (const b of booms) { // explosion where an enemy was hit
      const q = toWin(scene, b.p), k = (now - b.t) / 350;
      if (!q) continue;
      g.save(); g.strokeStyle = g.shadowColor = '#ff9f0a'; g.shadowBlur = 14; g.lineWidth = 6 * (1 - k) + 1; g.beginPath(); g.arc(q.x, q.y, 10 + 50 * k, 0, 7); g.stroke(); g.restore();
    }
    bursts = bursts.filter((b) => now - b.t < 1800);
    for (const b of bursts) {
      const q = toWin(scene, b.p);
      if (!q) continue;
      const k = (now - b.t) / 1800, R = Math.max(40, (700 / C.Cartesian3.distance(b.p, viewer.camera.positionWC)) * f) * 2.2;
      g.save(); g.shadowBlur = 0;
      for (let n = 0; n < 6; n++) { const kk = (k - n * 0.11) / 0.35; if (kk < 0 || kk > 1) continue; const a = n * 2.4, r0 = n ? R * 0.45 : 0; glow(g, q.x + Math.cos(a) * r0, q.y + Math.sin(a) * r0, R * (0.35 + 0.7 * kk), n % 2 ? '#ffd60a' : '#ff6a00'); } // chained blasts
      g.globalAlpha = 1 - k;
      for (const [kk, c] of [[k, '#ffffff'], [Math.max(0, k - 0.15), b.color]]) { g.strokeStyle = c; g.lineWidth = 6 * (1 - kk) + 1; g.beginPath(); g.ellipse(q.x, q.y, R * 2.2 * kk + 1, R * 0.8 * kk + 1, 0, 0, 7); g.stroke(); } // shock rings, seen at an angle
      for (let n = 0; n < 16; n++) { // shards tumbling away and falling
        const a = n * 2.39996 + 0.5, far = R * (0.3 + 2.4 * k) * (0.6 + ((n * 37) % 10) / 14), sx = q.x + Math.cos(a) * far, sy = q.y + Math.sin(a) * far + R * 0.6 * k * k, rot = a + k * (6 + n), sz = R * 0.16 * (1 - k * 0.5), sq = Math.abs(Math.cos(rot * 1.7));
        g.save(); g.translate(sx, sy); g.rotate(rot); g.fillStyle = n % 3 ? shade('#c8ccd4', 0.6 + 0.4 * sq) : b.color; g.beginPath(); g.moveTo(-sz, -sz * 0.7 * sq); g.lineTo(sz, -sz * 0.4 * sq); g.lineTo(sz * 0.3, sz * 0.8 * sq); g.closePath(); g.fill(); g.restore();
      }
      g.restore();
    }
    for (const b of incoming) { // enemy shots
      const q = toWin(scene, b.p);
      if (!q) continue;
      const br = Math.max(3, (60 / C.Cartesian3.distance(b.p, viewer.camera.positionWC)) * f);
      if (b.ink) { g.save(); g.fillStyle = '#2b1640'; g.globalAlpha = 0.85; for (let k = 0; k < 4; k++) { g.beginPath(); g.arc(q.x + Math.cos(k * 1.7 + b.spin) * br * 0.9, q.y + Math.sin(k * 2.3 + b.spin) * br * 0.9, br * (1.4 - k * 0.2), 0, 7); g.fill(); } g.restore(); continue; } // an ink blot
      if (b.fire) { const r = br * 2.4, gr = g.createRadialGradient(q.x, q.y, 0, q.x, q.y, r); gr.addColorStop(0, '#fff6c0'); gr.addColorStop(0.35, '#ffb300'); gr.addColorStop(0.75, '#ff3d00'); gr.addColorStop(1, 'rgba(255,61,0,0)'); g.save(); g.fillStyle = gr; g.beginPath(); g.arc(q.x, q.y, r, 0, 7); g.fill(); g.fillStyle = 'rgba(255,120,0,.35)'; for (let k = 1; k < 4; k++) { g.beginPath(); g.arc(q.x + Math.sin(b.spin + k) * r * 0.4, q.y + k * r * 0.45, r * (0.7 - k * 0.15), 0, 7); g.fill(); } g.restore(); continue; } // a fireball with a flaming tail
      if (b.panel) { const a = b.spin + performance.now() / 150, sq = Math.abs(Math.cos(a * 0.7)); g.save(); g.translate(q.x, q.y); g.rotate(a); g.fillStyle = '#d7dde5'; g.fillRect(-br * 2, -br * 1.3 * sq, br * 4, br * 2.6 * sq); g.strokeStyle = '#ff7a1a'; g.lineWidth = Math.max(1.5, br * 0.35); g.strokeRect(-br * 2, -br * 1.3 * sq, br * 4, br * 2.6 * sq); g.restore(); continue; } // a tumbling panel
      g.save(); g.fillStyle = g.shadowColor = b.color || '#ff2df5'; g.shadowBlur = 10; g.beginPath(); g.arc(q.x, q.y, br, 0, 7); g.fill(); g.restore();
    }
    const fade = (t0, ms, color) => { const k = (now - t0) / ms; if (k < 1) { g.save(); g.globalAlpha = 0.5 * (1 - k); g.fillStyle = color; g.fillRect(0, 0, w, h); g.restore(); } };
    fade(flash, 450, '#fff'); fade(hit, 250, broke === hit ? '#0a84ff' : '#f00'); // bomb / shield broken / damage
    if (shields) { g.save(); g.strokeStyle = 'rgba(10,132,255,.55)'; g.lineWidth = 3 * shields; g.beginPath(); g.ellipse(w / 2, h / 2, w * 0.46, h * 0.46, 0, 0, 7); g.stroke(); g.restore(); } // shield around the view, thicker with more layers
    if (adv) for (const gl of adv.goals) { // the places to visit: a glowing dot on the ground when it is in sight
      if (gl.done) continue; const occ = new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, viewer.camera.positionWC), dd = C.Cartesian3.distance(gl.p, viewer.camera.positionWC);
      if (dd > 3e5 || !occ.isPointVisible(gl.p) || C.Cartesian3.dot(C.Cartesian3.subtract(gl.p, viewer.camera.positionWC, new C.Cartesian3()), viewer.camera.directionWC) < 0) continue;
      const q = (C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates)(scene, gl.p); if (!q) continue;
      g.save(); g.fillStyle = g.shadowColor = '#40e0ff'; g.shadowBlur = 14; g.beginPath(); g.arc(q.x, q.y, 7, 0, 7); g.fill(); g.fillStyle = '#e8fbff'; g.textAlign = 'center'; g.font = '600 12px sans-serif'; g.fillText(gl.n, q.x, q.y + 22); g.restore();
    }
    if (race) drawRace(g, w, text);
    if (adv) text(`${T('ETAPA')} ${adv.i + 1}: ${adv.name} · ${adv.boss ? T('¡derrota al jefe!') : (adv.left ?? '?') + ' ' + T('banderas restantes') + (adv.goalsLeft ? ` · ${T('visita')}: ${adv.goals.filter((gl) => !gl.done).map((gl) => gl.n).join(', ')}` : '')}`, 24, 136, 14, 'left');
    text(`${T('PUNTOS')} ${score}  ·  ${T('MONEDAS')} ${coins}  ·  ${T('BOMBAS')} ${bombs}`, 24, 96, 16, 'left'); // below the heading tape
    g.save(); g.strokeRect(24, 110, 180, 12); g.fillStyle = hp > maxHp / 2 ? '#39ff14' : hp > maxHp / 4 ? '#ffd60a' : '#ff453a'; g.fillRect(24, 110, (180 * Math.max(0, hp)) / maxHp, 12); g.restore();
    text(`${T('VIDA')} ${Math.max(0, Math.round(hp))}/${maxHp}  ·  ${T('ESCUDOS')} ${shields}/3`, 212, 117, 12, 'left');
  }

  async function open() {
    if (on) return stop();
    const last = (() => { try { return JSON.parse(localStorage.getItem('oge.flyOpts')) || {}; } catch { return {}; } })(); // the dialog remembers the last choices
    const v = await OGE.ask({ title: 'Simulador de vuelo', ok: 'Iniciar vuelo',
      help: 'Arranca en el aire sobre el punto que estás mirando. Mouse: clic toma o suelta la palanca. Teclado: flechas, RePág/AvPág para el gas, L tren, F flaps, Intro pausa, Espacio sube, Esc salir. OpenStarshipEarth: B o clic derecho dispara.',
      fields: [{ id: 'plane', label: 'Avión', type: 'select', value: PLANES[last.plane] ? last.plane : 'ship', options: Object.entries(PLANES).map(([k, p]) => [k, p.name]) },
        { id: 'mouse', label: 'Controlar con el mouse (como en Earth)', type: 'checkbox', value: last.mouse ?? true },
        { id: 'arcade', label: 'OpenStarshipEarth: modo arcade con enemigos y puntaje (desmárcalo para volar libre)', type: 'checkbox', value: last.arcade ?? true },
        { id: 'aim', label: 'OpenStarshipEarth: apuntar los disparos con el mouse (clic dispara; se vuela con el teclado)', type: 'checkbox', value: last.aim ?? true },
        { id: 'diff', label: 'OpenStarshipEarth: dificultad (cada una tiene su propio ranking)', type: 'select', value: diff, options: Object.entries(DIFF).map(([k, d]) => [k, d.name]) },
        { id: 'quest', label: 'Coleccionar banderas y capitales (desmárcalo para volar solo por las vistas)', type: 'checkbox', value: quest() },
        { id: 'tut', label: 'OpenStarshipEarth: hacer el tutorial guiado (va diciendo qué hacer)', type: 'checkbox', value: !localStorage.getItem('oge.tutorial') }] }); // offered ticked the first time
    if (v) localStorage.setItem('oge.flyOpts', JSON.stringify({ ...v, tut: undefined }));
    if (v) { if (DIFF[v.diff]) { diff = v.diff; localStorage.setItem('oge.diff', diff); } localStorage.setItem('oge.quest', v.quest ? '1' : '0'); start(v.plane, v.mouse, v.arcade, v.aim, v.tut); }
  }
  function start(plane, useMouse, useArcade = true, useAim = false, useTut = false, useCalm = false) {
    if (OGE.body === 'sky') return OGE.toast(T('El cielo es para mirar: elige la Tierra, la Luna o Marte para volar.'), true);
    calm = useCalm;
    A = PLANES[plane];
    landing = null;
    tut = null;
    ammo = A.gun ? 511 : 0;
    aimMouse = !!A.ship && !!useAim; mouse.x = hud.clientWidth / 2; mouse.y = hud.clientHeight / 2;
    requestAnimationFrame(() => { mouse.x = hud.clientWidth / 2; mouse.y = hud.clientHeight / 2; }); // once the HUD has its size: the aim starts centred
    if (matchMedia('(pointer: coarse)').matches) { // touch devices: full screen and landscape
      const de = document.documentElement, fs = de.requestFullscreen || de.webkitRequestFullscreen;
      try { const pr = !document.fullscreenElement && fs && fs.call(de, { navigationUI: 'hide' }); Promise.resolve(pr).then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape')).catch(() => {}); } catch { /* not allowed here */ }
    }
    man = null; chase = null;
    loadCaps();
    loadRegs();
    if (A.ship) OGE.minimap.zoom(99); // the starship starts with the minimap zoomed all the way in
    if (A.ship && OGE.minimap.open) OGE.minimap.open(); // every world has its map
    arcade = !!A.ship && !!useArcade;
    autoOn = !arcade || OGE.body ? [] : ['layerSats', ...(window.__TAURI__ ? ['layerPlanes'] : [])].filter((id) => $(id) && !$(id).checked); // for this flight only: nearby satellites, region names to find the way, live aircraft (desktop)
    if (autoOn.includes('layerSats') && $('layerSatsNear')) { $('layerSatsNear').checked = true; $('layerSatsNear').dispatchEvent(new Event('change')); } // only the nearby ones: light
    for (const id of autoOn) { $(id).checked = true; $(id).dispatchEvent(new Event('change')); }
    OGE.fxForce = !!arcade && !OGE.body; // rain, snow and storms of the place show in the game
    autoOff = !arcade ? [] : ['layerRegionNames', 'layerFlags', 'layerFlagsDep'].filter((id) => $(id) && $(id).checked); // the atlas labels and flags confuse in the game: off for the flight
    for (const id of autoOff) { $(id).checked = false; $(id).dispatchEvent(new Event('change')); } // live satellites and aircraft join the arcade
    if (!document.body.classList.contains('noside')) { sideWas = true; OGE.hideSide(true); } // more room for the flight; it comes back afterwards
    stopped = false;
    if (arcade && !airports && !airBusy && !OGE.body) { airBusy = true; fetch(NE + '10m_cultural/ne_10m_airports.shp').then((r) => r.arrayBuffer()).then((b) => { airports = shp.parseShp(b).filter((g) => g && g.type === 'Point').map((g) => g.coordinates); }).catch(() => {}).finally(() => { airBusy = false; }); } // 25 KB: only the points
    maxHp = 100; usedTowns.clear(); hp = 100; bombs = 2; incoming = []; flash = hit = 0; shields = 0;
    run = { flags: 0, caps: 0, bosses: 0 };
    p2 = mpMode === 'local' && arcade ? { x: -0.65, y: 0.55, z: 200, hp: 100, score: 0, tilt: 0 } : null; // the second local player starts beside the first
    music(arcade);
    objs = []; booms = []; bursts = []; score = coins = 0;
    const la = OGE.lookAt(), c = la ? la.carto : viewer.camera.positionCartographic; // above the look-at point, not from orbit
    const ground = scene.globe.getHeight(c) || 0;
    s = { lon: c.longitude, lat: c.latitude, alt: ground + A.agl, heading: viewer.camera.heading, pitch: 0, roll: 0, v: A.v0, vs: 0,
      throttle: 0.7, flaps: 0, gear: false, brake: false, ail: 0, elev: 0, rud: 0, trim: 0, ground: false, agl: A.agl };
    setWarp(1);
    auto = nav = padLock = null; pad.free = pad.menu = pad.held = false; rounds = []; gunHeld = false; loading = performance.now() + 6000; on = true; paused = false; mouseCtl = !!useMouse && !aimMouse; stick.x = stick.y = 0; keys.clear(); last = performance.now();
    if (OGE.activate) OGE.activate(null);
    if (OGE.setEdit) OGE.setEdit(false);
    scene.screenSpaceCameraController.enableInputs = false;
    document.body.classList.add('flying');
    hud.hidden = false;
    $('flyBtn').classList.add('active');
    if (A.ship && useTut) { localStorage.setItem('oge.tutorial', '1'); tutorial(true); music(true); } // once the ship exists
  }
  // ---------- Capitals: a collectible over each national capital; a whole continent is an achievement ----------
  const NE = 'https://raw.githubusercontent.com/avlopezparra/natural-earth-vector/master/', CAPS = 'oge.capitals';
  const CONT = { Africa: 'África', Asia: 'Asia', Europe: 'Europa', 'North America': 'Norteamérica', 'South America': 'Sudamérica', Oceania: 'Oceanía', Antarctica: 'Antártida' };
  let towns = [], flagMap = null; // big cities that are not capitals; country flags and coats of arms
  const usedTowns = new Set(); // life boosters already taken in this flight
  let caps = null, capsBusy = false; // [{ name, lon, lat, cont, p }]
  const got = new Set((() => { try { return JSON.parse(localStorage.getItem(CAPS)) || []; } catch { return []; } })()), capId = (c) => c.name + '|' + c.cont;
  const OWED = 'oge.crestsOwed', owed = new Set((() => { try { return JSON.parse(localStorage.getItem(OWED)) || []; } catch { return []; } })()); // capitals whose boss is beaten and whose coat of arms was never picked up
  const owe = (c, yes) => { if (yes) owed.add(capId(c)); else owed.delete(capId(c)); localStorage.setItem(OWED, JSON.stringify([...owed])); };
  const dropCrest = (c) => { const fl = flagMap && flagMap.get(c.a3); objs.push({ kind: 'crest', cap: c, img: fl && fl.arms ? Object.assign(new Image(), { src: fl.arms }) : null, p: C.Cartesian3.fromDegrees(c.lon, c.lat, 5500), size: 900, next: 1e15 }); };
  const capOcc = new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, viewer.camera.positionWC);
  async function loadCaps() {
    if (OGE.body) caps = caps || []; // no capitals or bosses away from the Earth
    if (caps || capsBusy) return;
    capsBusy = true;
    try {
      const get = (p) => fetch(NE + p).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); });
      const [ps, pd, cd] = await Promise.all([get('110m_cultural/ne_110m_populated_places_simple.shp'), get('110m_cultural/ne_110m_populated_places_simple.dbf'), get('50m_cultural/ne_50m_admin_0_countries.dbf')]);
      const clean = (v) => String(v ?? '').replace(/\0/g, '').trim(), cont = new Map(shp.parseDbf(cd).map((r) => [clean(r.ADM0_A3), clean(r.CONTINENT)]));
      const all = shp.combine([shp.parseShp(ps), shp.parseDbf(pd)]).features.filter((f) => f.geometry);
      towns = all.filter((f) => +f.properties.adm0cap !== 1).map((f) => ({ name: clean(f.properties.name), lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], p: C.Cartesian3.fromDegrees(f.geometry.coordinates[0], f.geometry.coordinates[1], 4000) }));
      try { // more big cities for the life boosters
        const [ms, md] = await Promise.all([get('50m_cultural/ne_50m_populated_places_simple.shp'), get('50m_cultural/ne_50m_populated_places_simple.dbf')]);
        const big = shp.combine([shp.parseShp(ms), shp.parseDbf(md)]).features.filter((f) => f.geometry && +f.properties.pop_max >= 5e5 && +f.properties.adm0cap !== 1).sort((a, b) => b.properties.pop_max - a.properties.pop_max);
        const near = (a, b) => Math.abs(a[1] - b[1]) < 0.55 && Math.abs((a[0] - b[0]) * Math.cos(rad(a[1]))) < 0.55; // ~60 km: the same metropolitan area
        const capPts = all.filter((f) => +f.properties.adm0cap === 1).map((f) => f.geometry.coordinates);
        for (const f of big) { const c = f.geometry.coordinates; if (towns.some((t) => near([t.lon, t.lat], c)) || capPts.some((p) => near(p, c))) continue; towns.push({ name: clean(f.properties.name), lon: c[0], lat: c[1], p: C.Cartesian3.fromDegrees(c[0], c[1], 4000) }); }
      } catch { /* the small list stays */ }
      OGE.flags().then((m) => { flagMap = m; }).catch(() => {}); // flags and coats of arms by country
      caps = all.filter((f) => +f.properties.adm0cap === 1).map((f) => {
        const [lon, lat] = f.geometry.coordinates;
        return { name: clean(f.properties.name), a3: clean(f.properties.adm0_a3), lon, lat, cont: CONT[cont.get(clean(f.properties.adm0_a3))] || 'Islas oceánicas', p: C.Cartesian3.fromDegrees(lon, lat, 1500) };
      });
    } catch (e) { OGE.toast('No se pudieron cargar las capitales: ' + e.message, true); }
    capsBusy = false;
  }
  const capProgress = () => { // { continent: [collected, total] }
    const out = {};
    for (const c of caps || []) { const r = (out[c.cont] = out[c.cont] || [0, 0]); r[1]++; if (got.has(capId(c))) r[0]++; }
    return out;
  };
  function collect(c) {
    got.add(capId(c)); localStorage.setItem(CAPS, JSON.stringify([...got])); run.caps++; owe(c, false);
    const [n, all] = capProgress()[c.cont];
    if (arcade) score += 500;
    sfx(n === all ? 'achieve' : 'capital');
    OGE.toast(n === all ? `🏆 Logro: todas las capitales de ${c.cont} (${n}).` : `⭐ Capital conseguida: ${c.name} — ${c.cont} ${n}/${all}.`);
  }
  // Free flight: flying close to a capital collects it. Arcade: a boss appears over it and must be beaten first.
  function capStep() {
    if (!caps) return;
    if (arcade && !tut) for (const tw of towns) { // a life booster floats over each big city nearby
      if (usedTowns.has(tw) || objs.some((o) => o.town === tw) || C.Cartesian3.distance(tw.p, viewer.camera.positionWC) > 2e5) continue;
      objs.push({ kind: 'life', town: tw, p: tw.p, size: 700, next: 1e15 });
    }
    const cam = viewer.camera.positionWC, R = Math.max(5000, s.v * warp * 0.06); // you have to fly close: 5 km, or what is covered in a couple of frames at high speed
    for (const c of caps) {
      if (got.has(capId(c))) continue;
      const d = C.Cartesian3.distance(c.p, cam);
      if (!arcade) { if (d < R) collect(c); continue; }
      if (race || d > 2e5 || objs.some((o) => o.cap === c)) continue; // its boss or its coat of arms is already there (no bosses in a race)
      if (owed.has(capId(c))) { dropCrest(c); continue; } // its boss fell in an earlier game: only the coat of arms is left to pick up
      if (adv && (c.a3 !== adv.a3 || !adv.boss)) continue; // in the adventure the boss comes after the flags
      const type = bossKind(c.name), B = BOSSES[type], base = C.Cartesian3.fromDegrees(c.lon, c.lat, (scene.globe.getHeight(C.Cartographic.fromDegrees(c.lon, c.lat)) || 0) + 6000);
      objs.push({ kind: 'boss', born: performance.now(), type, cap: c, base, p: C.Cartesian3.clone(base), east: C.Cartesian3.normalize(C.Cartesian3.cross(C.Cartesian3.UNIT_Z, base, new C.Cartesian3()), new C.Cartesian3()), size: 700, hp: Math.ceil(B.hp * (B.weak ? 1 : DIFF[diff].boss)), max: Math.ceil(B.hp * (B.weak ? 1 : DIFF[diff].boss)), next: performance.now() + 2500 }); // the phases of a weak-point boss are counted in hits: not scaled
      if (type === 'face') { const face = objs[objs.length - 1]; for (const side of [-1, 1]) objs.push({ kind: 'boss', born: performance.now(), type: 'hand', cap: null, from: face, base, p: C.Cartesian3.add(base, C.Cartesian3.multiplyByScalar(face.east, side * 1500, new C.Cartesian3()), new C.Cartesian3()), east: face.east, size: 500, hp: 6, max: 6, next: performance.now() + 4000, pt: performance.now() + side * 1500, mirror: side }); }
      OGE.toast(`⚠ Jefe de ${c.name}: derrótalo para conseguir la capital.`);
      beep(200, 500, 0.6);
    }
  }
  function drawCaps() { // a star over each capital still to collect (a green check over the ones already won), when it is near and on this side of the globe
    const toWin = C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates, cam = viewer.camera.positionWC;
    capOcc.cameraPosition = cam;
    for (const c of caps) {
      const d = C.Cartesian3.distance(c.p, cam);
      if (d > 2.5e6 || !capOcc.isPointVisible(c.p)) continue;
      const q = toWin(scene, c.p);
      if (!q) continue;
      if (got.has(capId(c))) { // already won: a green seal with a check mark, so it is clear why no boss waits there
        const r = d < 3e5 ? 13 : 9; g.save(); g.fillStyle = g.shadowColor = '#2fb24a'; g.shadowBlur = 8; g.beginPath(); g.arc(q.x, q.y - r * 0.5, r, 0, 7); g.fill();
        g.strokeStyle = '#fff'; g.lineWidth = Math.max(2, r * 0.28); g.lineCap = 'round'; g.lineJoin = 'round'; g.beginPath(); g.moveTo(q.x - r * 0.45, q.y - r * 0.5); g.lineTo(q.x - r * 0.1, q.y - r * 0.15); g.lineTo(q.x + r * 0.5, q.y - r * 0.9); g.stroke();
        g.shadowBlur = 0; g.fillStyle = '#d8ffd8'; g.textAlign = 'center'; g.font = '600 12px sans-serif'; g.fillText(`${c.name} · ${T('obtenida')}`, q.x, q.y + r + 8); g.restore();
        continue;
      }
      g.save(); g.fillStyle = g.shadowColor = '#e8112d'; g.shadowBlur = 10; g.textAlign = 'center'; g.strokeStyle = '#fff'; g.lineWidth = 2;
      g.font = (d < 3e5 ? 32 : 20) + 'px sans-serif'; g.strokeText('★', q.x, q.y); g.fillText('★', q.x, q.y); g.fillStyle = '#fff';
      g.font = '600 12px sans-serif'; g.fillText(c.name, q.x, q.y + 20); g.restore();
    }
  }
  OGE.minimap.extra = (mg) => {
    if (race && race.path && race.path.length > 1) { mg.save(); mg.strokeStyle = 'rgba(52,199,89,.85)'; mg.lineWidth = 1.5; mg.beginPath(); race.path.forEach(([x, y], i) => { const [px, py] = OGE.minimap.xy(x, y); if (i) mg.lineTo(px, py); else mg.moveTo(px, py); }); mg.stroke(); mg.restore(); } // the race route
    const edge = (x, y, color) => { // a point inside the map, or an arrow on its edge pointing to it
      const W = 240, H = 120, cx = W / 2, cy = H / 2;
      if (x > 4 && x < W - 4 && y > 4 && y < H - 4) { mg.fillStyle = color; mg.strokeStyle = '#fff'; mg.lineWidth = 1.5; mg.beginPath(); mg.arc(x, y, 4, 0, 7); mg.fill(); mg.stroke(); return; }
      const a = Math.atan2(y - cy, x - cx), k = Math.min((cx - 8) / Math.abs(Math.cos(a) || 1e-9), (cy - 8) / Math.abs(Math.sin(a) || 1e-9)), ex = cx + Math.cos(a) * k, ey = cy + Math.sin(a) * k;
      mg.save(); mg.translate(ex, ey); mg.rotate(a); mg.fillStyle = color; mg.strokeStyle = '#000'; mg.lineWidth = 1; mg.beginPath(); mg.moveTo(7, 0); mg.lineTo(-5, -5); mg.lineTo(-5, 5); mg.closePath(); mg.fill(); mg.stroke(); mg.restore();
    };
    if (adv) for (const gl of adv.goals) if (!gl.done) edge(...OGE.minimap.xy(gl.lon, gl.lat), '#40e0ff');
    if (nav) edge(...OGE.minimap.xy(deg(nav.lon), deg(nav.lat)), '#ff2d55'); // where the autopilot is going
    if (adv && regs) { const c = viewer.camera.positionCartographic, lo = deg(c.longitude), la = deg(c.latitude); for (const r of regs.filter((r) => r.a3 === adv.a3 && !gotReg.has(r.id)).sort((x, y) => Math.hypot(x.lon - lo, x.lat - la) - Math.hypot(y.lon - lo, y.lat - la)).slice(0, 3)) edge(...OGE.minimap.xy(r.lon, r.lat), '#ffd60a'); } // only the three nearest: a whole country of arrows piled up on the edge // the stage's flags still to collect // collected capitals in green, the rest in yellow; the race goal, kept at the edge when it is outside
    if (remote && remote.to) { const c = C.Cartographic.fromCartesian(remote.to), [x, y] = OGE.minimap.xy(deg(c.longitude), deg(c.latitude)); mg.fillStyle = remote.skin; mg.beginPath(); mg.arc(x, y, 4, 0, 7); mg.fill(); } // the other online player
    if (race) {
      const c = viewer.camera.positionCartographic, [sx, sy] = OGE.minimap.xy(deg(c.longitude), deg(c.latitude));
      let [x, y] = OGE.minimap.xy(race.to.lon, race.to.lat);
      const k = Math.min(1, x - sx ? ((x > sx ? 236 : 4) - sx) / (x - sx) : 1, y - sy ? ((y > sy ? 116 : 4) - sy) / (y - sy) : 1);
      x = sx + (x - sx) * k; y = sy + (y - sy) * k;
      mg.save(); mg.strokeStyle = '#34c759'; mg.setLineDash([4, 3]); mg.lineWidth = 1.5; mg.beginPath(); mg.moveTo(sx, sy); mg.lineTo(x, y); mg.stroke();
      mg.setLineDash([]); mg.fillStyle = '#34c759'; mg.strokeStyle = '#fff'; mg.beginPath(); mg.arc(x, y, 4, 0, 7); mg.fill(); mg.stroke(); mg.restore();
    }
    if (!on || !arcade) return; // flags and capitals are marks of the game: not on the atlas, nor in free flight
    const nearest = (list, n) => list.map((o) => { const [x, y] = OGE.minimap.xy(o.lon, o.lat); return { o, x, y, d: (x - 120) ** 2 + (y - 60) ** 2 }; }).filter((m) => m.x > 0 && m.x < 240 && m.y > 0 && m.y < 120).sort((a, b) => a.d - b.d).slice(0, n); // only those inside the map window, the closest to the ship first
    for (const m of nearest(regs || [], 40)) { mg.fillStyle = gotReg.has(m.o.id) ? '#34c759' : '#ffd60a'; mg.fillRect(m.x - 1, m.y - 1, 2, 2); } // region flags: plain dots, yellow to collect and green once collected
    for (const m of nearest(caps || [], 12)) { mg.fillStyle = got.has(capId(m.o)) ? '#34c759' : '#ffd60a'; mg.fillRect(m.x - 2.5, m.y - 2.5, 5, 5); } // capitals: a bigger dot
  };

  // ---------- Region flags: the country's flag over every state or province; countries, continents and the world are achievements ----------
  const REGS = 'oge.regions';
  const moonFlags = () => { // the flags left on the Moon: the six Apollo landings, and the two Chang'e sample missions that unfurled one
    const flag = (f) => Object.assign(new Image(), { src: 'https://commons.wikimedia.org/wiki/Special:FilePath/' + f + '?width=120' }), us = flag('Flag_of_the_United_States.svg'), cn = flag('Flag_of_the_People%27s_Republic_of_China.svg');
    return [['Apolo 11 (1969)', 23.47297, 0.67408, us], ['Apolo 12 (1969)', -23.42157, -3.01239, us], ['Apolo 14 (1971)', -17.47136, -3.6453, us], ['Apolo 15 (1971)', 3.63386, 26.13222, us], ['Apolo 16 (1972)', 15.50019, -8.97301, us], ['Apolo 17 (1972)', 30.77168, 20.1908, us], ["Chang'e 5 (2020)", -51.916, 43.058, cn], ["Chang'e 6 (2024)", -153.986, -41.638, cn]]
      .map(([name, lon, lat, img], i) => ({ id: 'moon-' + i, lon, lat, lifted: true, name, a3: 'MOON', country: 'Luna', cont: 'Luna', p: C.Cartesian3.fromDegrees(lon, lat, 2000), img }));
  };
  let subMap = null, subAsked = false; // adm1_code -> Commons file of the region's own emblem (data/subflags.json, built from Wikidata by tools/subflags.py)
  const subImgs = new Map(), subImg = (f) => { if (!subImgs.has(f)) subImgs.set(f, Object.assign(new Image(), { src: 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(f) + '?width=120' })); return subImgs.get(f); };
  let regs = null, regsBusy = false; // [{ id, name, a3, country, cont, p, img }]
  const gotReg = new Set((() => { try { return JSON.parse(localStorage.getItem(REGS)) || []; } catch { return []; } })());
  let regKey = REGS; // where the flags are kept: the free game's collection, or the adventure's own
  const syncRegs = () => { const key = adv ? REGS + '.adv' : REGS; if (key === regKey) return; regKey = key; gotReg.clear(); try { for (const x of JSON.parse(localStorage.getItem(key)) || []) gotReg.add(x); } catch { /* an empty collection */ } };
  async function loadRegs() {
    if (OGE.body) regs = regs || (OGE.body === 'moon' ? moonFlags() : []);
    if (regs || regsBusy) return;
    regsBusy = true;
    try {
      const get = (p) => fetch(NE + p).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); });
      const [ps, pd, flags, grp] = await Promise.all([get('10m_cultural/ne_10m_admin_1_label_points.shp'), get('10m_cultural/ne_10m_admin_1_label_points.dbf'), OGE.flags(), fetch('data/subregions.json').then((r) => r.json()).catch(() => ({}))]); // grp: units that belong to a larger region (Spanish provinces to their autonomous community)
      const clean = (v) => String(v ?? '').replace(/\0/g, '').trim(), cand = new Map(), imgs = new Map(), out = [];
      for (const f of shp.combine([shp.parseShp(ps), shp.parseDbf(pd)]).features) { // a point for every part of a region (each island too)
        const p = f.properties, id = clean(p.adm1_code), fl = flags.get(clean(p.sr_adm0_a3));
        if (!f.geometry || !id || !fl) continue;
        if (OGE.malvinasAR && ['FLK', 'SGS'].includes(clean(p.sr_adm0_a3))) continue; // part of Argentina from that point of view: no flag of their own, nor in any mission
        const big = grp[id], key = big ? fl.a3 + ':' + big : id; // the flag stands for the largest subdivision: one per region, not one per province inside it
        if (!cand.has(key)) cand.set(key, { p, fl, pts: [], name: big || clean(p.name), ids: new Set() });
        cand.get(key).pts.push(f.geometry.coordinates); cand.get(key).ids.add(id);
      }
      let lands = null; // country outlines: a flag must stand on land, not offshore
      try { const [s2, d2] = await Promise.all([get('50m_cultural/ne_50m_admin_0_countries.shp'), get('50m_cultural/ne_50m_admin_0_countries.dbf')]); lands = new Map(shp.combine([shp.parseShp(s2), shp.parseDbf(d2)]).features.filter((x) => x.geometry).map((x) => [clean(x.properties.ADM0_A3), x])); } catch { /* without outlines: the nearest point */ }
      for (const [id, { p, fl, pts, name, ids }] of cand) {
        if (!ids.has(id) && [...ids].some((x) => gotReg.has(x))) gotReg.add(id); // a province collected before the regions were grouped counts for its region
        const land = lands && lands.get(fl.a3), onLand = land ? pts.filter((c) => turf.booleanPointInPolygon(c, land)) : [];
        const pool = onLand.length ? onLand : pts, [lon, lat] = pool.reduce((a, c) => (Math.hypot(c[0] - fl.lon, c[1] - fl.lat) < Math.hypot(a[0] - fl.lon, a[1] - fl.lat) ? c : a));
        if (!imgs.has(fl.url)) imgs.set(fl.url, Object.assign(new Image(), { src: fl.url }));
        const gh = scene.globe.getHeight(C.Cartographic.fromDegrees(lon, lat));
        out.push({ id, lon, lat, lifted: gh !== undefined, iso: clean(p.iso_a2), name, a3: fl.a3, country: fl.name, cont: CONT[fl.cont] || 'Islas oceánicas', p: C.Cartesian3.fromDegrees(lon, lat, (gh || 0) + 2000), img: imgs.get(fl.url) });
      }
      regs = out;
    } catch (e) { OGE.toast('No se pudieron cargar las banderas: ' + e.message, true); }
    regsBusy = false;
  }
  function giveItem(kind) { // a race item into the first free slot (a second one of the same kind upgrades it); false when the three slots are taken
    const same = items.indexOf(kind); if (same < 0 && items.length >= 3) return false;
    let item = kind; if (same >= 0) { items[same] = kind + '+'; item = kind + '+'; } else items.push(kind);
    sfx('achieve'); OGE.toast(`${ITEMS[item][0]} ${T(ITEMS[item][1])} — ${T('U para usarlo')}`); return true;
  }
  function regStep() { // flying close to a region's flag collects it; in a race it hands out an item instead, once
    if (!regs || (race && !race.flags)) return;
    syncRegs();
    const taken = race ? race.used : gotReg;
    const cam = viewer.camera.positionWC, R = Math.max(5000, s.v * warp * 0.06); // you have to fly close: 5 km, or what is covered in a couple of frames at high speed
    for (const r of regs) {
      if (taken.has(r.id)) continue;
      const d = C.Cartesian3.distance(r.p, cam);
      if (!r.onRelief && d < 6e5) { // once its terrain is loaded, the flag floats 2.5 km above the relief (mountains included)
        const h = scene.globe.getHeight(C.Cartographic.fromDegrees(r.lon, r.lat));
        if (h !== undefined) { r.p = C.Cartesian3.fromDegrees(r.lon, r.lat, h * scene.verticalExaggeration + 2500); r.onRelief = true; }
      }
      if (d > R || s.alt > 1e5) continue; // flags are picked up flying past them, not from space
      if (race) { if (giveItem(Object.keys(BALLOON)[Math.floor(Math.random() * 4)])) race.used.add(r.id); continue; } // a full hand leaves the flag for later
      gotReg.add(r.id); localStorage.setItem(regKey, JSON.stringify([...gotReg])); run.flags++;
      const all = (fn) => regs.filter(fn).every((x) => gotReg.has(x.id)), mine = regs.filter((x) => x.a3 === r.a3), n = mine.filter((x) => gotReg.has(x.id)).length;
      if (arcade) score += 100;
      sfx(n === mine.length ? 'achieve' : 'flag'); // a completed country (or continent, or the world) is an achievement
      OGE.toast(all(() => true) ? '🏆 Logro: todas las banderas del mundo.' : all((x) => x.cont === r.cont) ? `🏆 Logro: todas las banderas de ${r.cont}.`
        : n === mine.length ? `🏆 Logro: todas las banderas de ${r.country} (${n}).` : `🚩 Bandera conseguida: ${r.name}, ${r.country} — ${n}/${mine.length}.`);
    }
  }
  function drawRegs() { // the flags still to collect, when near and on this side of the globe
    const toWin = C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates, cam = viewer.camera.positionWC;
    capOcc.cameraPosition = cam;
    for (const r of regs) {
      if (race ? race.used.has(r.id) : gotReg.has(r.id)) continue;
      if (adv && adv.a3 === 'ARG' && (r.a3 === 'FLK' || r.a3 === 'SGS')) continue; // for Argentina they are part of Tierra del Fuego: no flag of their own
      if (!r.lifted) { const gh = scene.globe.getHeight(C.Cartographic.fromDegrees(r.lon, r.lat)); if (gh !== undefined) { r.p = C.Cartesian3.fromDegrees(r.lon, r.lat, gh + 2000); r.lifted = true; } } // over the real terrain
      const d = C.Cartesian3.distance(r.p, cam);
      if (d > 6e5 || !capOcc.isPointVisible(r.p) || !r.img.complete || !r.img.naturalWidth) continue;
      const q = toWin(scene, r.p);
      if (!q) continue;
      if (r.sub === undefined) { // the region's own flag or arms, fetched only once it is near
        if (subMap) r.sub = subMap[r.id] ? subImg(subMap[r.id]) : null;
        else if (!subAsked) { subAsked = true; fetch('data/subflags.json').then((x) => x.json()).then((j) => { subMap = j; }).catch(() => { subMap = {}; }); } // without the table the national flag stays alone
      }
      const w = d < 1.5e5 ? 44 : 26, h = (w * r.img.naturalHeight) / r.img.naturalWidth, sub = r.sub && r.sub.complete && r.sub.naturalWidth ? r.sub : null, sh = sub ? Math.min(w, (w * sub.naturalHeight) / sub.naturalWidth) : 0;
      g.save(); g.shadowColor = '#000'; g.shadowBlur = 6; g.drawImage(r.img, q.x - w / 2, q.y - h / 2, w, h);
      if (sub) g.drawImage(sub, q.x - w / 2, q.y + h / 2 + 2, w, sh); // the region's own flag under the national one
      if (d < 3e5) { g.fillStyle = '#fff'; g.textAlign = 'center'; g.font = '600 11px sans-serif'; g.fillText(r.name, q.x, q.y + h / 2 + (sub ? sh + 2 : 0) + 12); }
      g.restore();
    }
    if (OGE.body === 'moon') { // no minimap here: an arrow and the distance to the nearest flag still to find
      let best = null, bd = Infinity;
      for (const r of regs) { if (gotReg.has(r.id)) continue; const d = C.Cartesian3.distance(r.p, cam); if (d < bd) { bd = d; best = r; } }
      if (best) {
        const la = rad(best.lat), dl = rad(best.lon) - s.lon, brg = Math.atan2(Math.sin(dl) * Math.cos(la), Math.cos(s.lat) * Math.sin(la) - Math.sin(s.lat) * Math.cos(la) * Math.cos(dl)), x = hud.clientWidth / 2;
        g.save(); g.fillStyle = '#ffd60a'; g.shadowColor = '#000'; g.shadowBlur = 4; g.textAlign = 'center'; g.font = '600 13px sans-serif'; g.fillText(`${best.name} · ${Math.round(bd / 3670)} km`, x, 124); // the globe is drawn Earth-sized: distances are scaled back to the Moon's
        g.translate(x, 98); g.rotate(C.Math.negativePiToPi(brg - s.heading)); g.beginPath(); g.moveTo(0, -12); g.lineTo(8, 8); g.lineTo(0, 3); g.lineTo(-8, 8); g.closePath(); g.fill(); g.restore();
      }
    }
  }

  // ---------- Race: fly from one chosen city to another; the goal shows on the screen and on the minimap, the best time per route is kept ----------
  let race = null; // { key, from, to: { name, lon, lat, p }, t0 }
  let items = []; // the race items held (up to 3): 'missile' | 'mine' | 'boost' | 'shield'; U uses the first
  const ITEMS = { missile: ['🚀', 'Misil'], mine: ['⚫', 'Mina'], boost: ['⚡', 'Turbo'], shield: ['🛡', 'Escudo'], 'missile+': ['🚀', 'Misil x3'], 'mine+': ['⚫', 'Minas x3'], 'boost+': ['⚡', 'Turbo largo'], 'shield+': ['🛡', 'Escudo doble'] };
  const BALLOON = { missile: '#ff453a', mine: '#bf5af2', boost: '#ffd60a', shield: '#0a84ff' }; // the colour tells what a balloon holds
  function placeBoxes() { // the course along the race path: a row of three balloons every few km, numbered gates, boost rings and speed coins
    objs = objs.filter((o) => !['itembox', 'gate', 'zip', 'scoin'].includes(o.kind));
    const at = (f, side = 0, up = 3000) => { const [lon, lat, hd] = pathAt(f), x = lon + (side * Math.cos(hd)) / Math.cos(rad(lat)), y = lat - side * Math.sin(hd), gh = scene.globe.getHeight(C.Cartographic.fromDegrees(x, y)); return { lon: x, lat: y, up, lifted: gh !== undefined, p: C.Cartesian3.fromDegrees(x, y, (gh || 0) + up) }; };
    const ng = Math.max(3, Math.min(25, Math.round(race.pathLen / 10000)));
    race.gates = race.rings === false ? null : [];
    if (race.gates) for (let i = 1; i <= ng; i++) { const g0 = { kind: 'gate', n: i, f: i / (ng + 1), size: 1400, next: 1e15, ...at(i / (ng + 1)) }; race.gates.push(g0); objs.push(g0); } // pass them in order
    race.nextGate = 0; race.missed = 0;
    for (let i = 0; i < ng; i++) { const f = (i + 0.5) / (ng + 1); objs.push({ kind: 'zip', size: 800, next: 1e15, ...at(f, (i % 2 ? 1 : -1) * 0.004) }); } // boost rings, a little off the line
    for (let i = 0; i < ng * 4; i++) { const f = (i + 0.25) / (ng * 4 + 1); objs.push({ kind: 'scoin', size: 350, next: 1e15, ...at(f, ((i % 3) - 1) * 0.006) }); } // speed coins
    race.coins = 0; race.vBase = race.vBase || A.vMax;
    const n = Math.max(3, Math.min(40, Math.round(race.pathLen / 8000)));
    for (let i = 1; i < n; i++) {
      const [lon, lat, hd] = pathAt(i / n), side = Math.cos(rad(lat));
      for (const o of [-1, 0, 1]) { // across the route
        const x = lon + (o * 0.012 * Math.cos(hd)) / side, y = lat - o * 0.012 * Math.sin(hd), gh = scene.globe.getHeight(C.Cartographic.fromDegrees(x, y));
        objs.push({ kind: 'itembox', item: Object.keys(BALLOON)[(i + o + 3) % 4], lon: x, lat: y, up: 3000, lifted: gh !== undefined, p: C.Cartesian3.fromDegrees(x, y, (gh || 0) + 3000), size: 560, next: 1e15 });
      }
    }
  }
  function setPath(pts) { // [[lon, lat]...] with cumulative lengths in metres
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + C.Cartesian3.distance(C.Cartesian3.fromDegrees(pts[i - 1][0], pts[i - 1][1]), C.Cartesian3.fromDegrees(pts[i][0], pts[i][1])));
    Object.assign(race, { path: pts, cum, pathLen: cum[cum.length - 1] || 1, myT: 0, myIdx: 0 });
  }
  function pathAt(f) { // position and heading (radians from north) at a fraction of the path
    const P = race.path, cum = race.cum, d = Math.min(1, Math.max(0, f)) * race.pathLen;
    let i = 1; while (i < P.length - 1 && cum[i] < d) i++;
    const a = P[i - 1], b = P[i], k = (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, Math.atan2((b[0] - a[0]) * Math.cos(rad(a[1])), b[1] - a[1])];
  }
  async function roadPath(stops) { // OSRM (OpenStreetMap routing): roads and ferries through every stop; none: the straight lines stay
    try {
      const j = await (await fetch(`https://router.project-osrm.org/route/v1/driving/${stops.map((p) => `${p.lon},${p.lat}`).join(';')}?overview=simplified&geometries=geojson`)).json();
      const pts = j.routes && j.routes[0] && j.routes[0].geometry.coordinates;
      return pts && pts.length > 1 ? pts : null;
    } catch { return null; }
  }
  function useItem() {
    if (!items.length) return;
    let it = items.shift();
    if (it.endsWith('+')) { it = it.slice(0, -1); if (it === 'boost') { startBoost(); setTimeout(() => { boost = null; boostCd = 0; startBoost(); }, 2600); return; } if (it === 'shield') { shields = Math.min(3, shields + 2); return sfx('shield'); } items.unshift(it, it); } // upgraded: three missiles or mines (one now, two kept), a long boost, a double shield
    if (it === 'boost') startBoost();
    else if (it === 'shield') { shields = Math.min(3, shields + 1); sfx('shield'); }
    else if (it === 'mine') { // dropped right here: whoever flies into it gets hurt (not the one who dropped it)
      const p = C.Cartesian3.fromRadians(s.lon, s.lat, s.alt);
      objs.push({ kind: 'mine', own: true, p, size: 300, next: 1e15, until: performance.now() + 90000 });
      mpSend({ t: 'mine', lon: s.lon, lat: s.lat, alt: s.alt }); sfx('bombGet');
    } else if (it === 'missile') { // homes in on the other player (online or on this screen); with nobody else, on the nearest enemy
      sfx('warpUp');
      setTimeout(() => {
        if (remote && remote.p) { mpSend({ t: 'hit', n: 25 }); booms.push({ p: remote.p, t: performance.now() }); OGE.toast(`🚀 ${T('¡Misil en el blanco!')} ${remote.name || ''}`); }
        else if (p2 && !p2.out) { p2Hurt(25); OGE.toast(`🚀 ${T('¡Misil en el blanco!')} ${T('Jugador 2')}`); }
        else if (race && race.cpus.length && race.cpus.some((c) => c.f < 1)) { const me = myProgress(), c = race.cpus.filter((x) => x.f < 1).sort((x, y) => Math.abs(x.f - me) - Math.abs(y.f - me))[0]; c.stunT = performance.now() + 4000; OGE.toast(`🚀 ${T('¡Misil en el blanco!')} ${c.name}`); }
        else { const cam = viewer.camera.positionWC, e = objs.filter((o) => o.kind === 'enemy').sort((x, y) => C.Cartesian3.distance(x.p, cam) - C.Cartesian3.distance(y.p, cam))[0]; if (e) { objs.splice(objs.indexOf(e), 1); booms.push({ p: e.p, t: performance.now() }); score += pts(100); } }
        sfx('down');
      }, 1200);
    }
  }

  const geocode = async (q) => {
    const [r] = await (await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=${OGE_LANG}&q=${encodeURIComponent(q)}`)).json();
    if (!r) throw new Error(`${T('No se encontró')}: ${q}`);
    return { name: r.name || q, lon: +r.lon, lat: +r.lat };
  };
  const bearing = (a, b) => Math.atan2((b.lon - a.lon) * Math.cos(rad(a.lat)), b.lat - a.lat); // flat approximation, good enough to steer
  const fmtT = (ms) => { const t = Math.round(ms / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  const raceKm = () => { const c = viewer.camera.positionCartographic; return C.Cartesian3.distance(C.Cartesian3.fromRadians(c.longitude, c.latitude, 0), C.Cartesian3.fromDegrees(race.to.lon, race.to.lat, 0)) / 1000; };
  async function raceMode() {
    const last = (() => { try { return JSON.parse(localStorage.getItem('oge.raceLast')) || {}; } catch { return {}; } })();
    const v = await OGE.ask({ title: '🏁 Carrera entre ciudades', ok: 'Despegar',
      help: 'Vuela de una ciudad a otra lo más rápido que puedas. La meta se marca en la pantalla y en el minimapa; se guarda tu mejor tiempo de cada ruta.',
      fields: [{ id: 'from', label: 'Salida', type: 'text', value: last.from || 'Santiago de Chile' }, { id: 'to', label: 'Meta', type: 'text', value: last.to || 'Valparaíso' },
        { id: 'cpus', label: 'Rivales de la CPU (si no hay otros jugadores)', type: 'select', value: String(last.cpus ?? 5), options: Array.from({ length: 13 }, (_, i) => [String(i), i ? String(i) : 'Ninguno']) },
        { id: 'maxWarp', label: 'Turbo máximo', type: 'select', value: String(Math.min(10, last.maxWarp ?? 2)), options: WARPS.filter((x) => x <= 10).map((x) => [String(x), '×' + x]) }, // the higher ones are for crossing the world, not for a course
        { id: 'route', label: 'Ruta de la carrera', type: 'select', value: last.route === 'line' ? 'line' : 'road', options: [['road', 'Por carreteras y ferris (OpenStreetMap)'], ['line', 'Línea recta entre las ciudades']] },
        { id: 'lands', label: 'Volar solo sobre estos países (separados por comas; vacío = todos)', type: 'text', value: last.lands || '' },
        { id: 'via', label: 'Metas intermedias: ciudades por las que pasar (separadas por comas)', type: 'text', value: last.via || '' },
        { id: 'rings', label: 'Aros numerados que hay que pasar en orden (desmárcalo para correr sin aros)', type: 'checkbox', value: last.rings ?? true },
        { id: 'flags', label: 'Banderas que dan un objeto al pasar por ellas (desmárcalo para correr sin banderas)', type: 'checkbox', value: last.flags ?? true },
        { id: 'laps', label: 'Vueltas (2 o más: circuito que vuelve a la salida)', type: 'select', value: String(last.laps ?? 1), options: [1, 2, 3, 4, 5].map((n) => [String(n), n === 1 ? '1 (de una ciudad a otra)' : String(n)]) }] });
    if (!v || !v.from || !v.to) return;
    localStorage.setItem('oge.raceLast', JSON.stringify(v));
    let a, b;
    let via = [];
    try { [a, b, ...via] = await Promise.all([geocode(v.from), geocode(v.to), ...String(v.via || '').split(',').map((x) => x.trim()).filter(Boolean).map(geocode)]); } catch (e) { return OGE.toast(e.message, true); }
    raceGo(v, a, b, via);
  }
  function raceGo(v, a, b, via = []) {
    relaunch = () => raceGo(v, a, b, via);
    mpGo({ mode: 'race', v, a: { lon: a.lon, lat: a.lat, name: a.name }, b: { lon: b.lon, lat: b.lat, name: b.name }, via: via.map((p) => ({ lon: p.lon, lat: p.lat, name: p.name })) });
    const laps = Math.max(1, +v.laps || 1); if (laps > 1) b = { ...a }; // a circuit ends where it starts
    b.p = C.Cartesian3.fromDegrees(b.lon, b.lat, 1500);
    const hd = bearing(a, b);
    viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(a.lon, a.lat, 3000), orientation: { heading: hd, pitch: rad(-10), roll: 0 } });
    adv = null; advShape = null;
    start('ship', true, true, true, false);
    s.heading = hd;
    race = { laps, via, key: `${v.from}|${v.to}|${v.maxWarp}|${v.lands}|${v.via || ''}|${laps}${v.route === 'line' ? '|line' : ''}${v.rings === false ? '|norings' : ''}`.toLowerCase(), from: a, to: b, t0: performance.now(), km: raceKmFrom(a, b), cpus: [], maxWarp: Math.min(10, +v.maxWarp || 10), rings: v.rings !== false, flags: v.flags !== false, used: new Set(), others: null };
    if (warp > race.maxWarp) setWarp(race.maxWarp);
    if (v.lands && v.lands.trim()) raceLands(v.lands); // only these countries (the sea and Antarctica stay open)
    if (!p2 && !remote) race.cpus = Array.from({ length: +v.cpus || 0 }, (_, i) => ({ // rivals: each flies the route at its own pace
      name: CPU_NAMES[i], color: CPU_COLORS[i], model: Object.keys(SHIPS)[i % Object.keys(SHIPS).length], f: 0, side: ((i % 2 ? 1 : -1) * (1 + Math.floor(i / 2))) * 0.004, speed: A.vMax * race.maxWarp * (0.8 + Math.random() * 0.25), stunT: 0, itemT: performance.now() + 8000 + Math.random() * 10000 }));
    const stops = laps > 1 ? [a, ...via, a] : [a, ...via, b], lap1 = stops.map((p) => [p.lon, p.lat]);
    const repeat = (pts) => { let out = pts.slice(); for (let i = 1; i < laps; i++) out = out.concat(pts.slice(1)); return out; }; // the same loop once per lap
    items = []; setPath(repeat(lap1.length > 1 ? lap1 : [[a.lon, a.lat], [b.lon, b.lat]])); placeBoxes();
    const me = race, road = () => roadPath(stops).then((pts) => { if (pts && race === me) { setPath(repeat(pts)); placeBoxes(); OGE.toast(`${T('Ruta por carreteras y ferris')}: ${Math.round(race.pathLen / 1000)} km`); } }); // the rivals follow the roads, in the air
    if (v.route !== 'line') road();
    else lineLeaves(stops).then((home) => { if (home && race === me) { OGE.toast(`${T('La línea recta sale de')} ${home}: ${T('se usa la ruta por carreteras.')}`); road(); } }); // a race inside one country does not cut across another
    race.go = performance.now() + 3000; race.boostOk = false; graceT = race.go + 3000; stopped = true; // the countdown holds everyone at the start
    const best = +localStorage.getItem('oge.race.' + race.key) || 0;
    OGE.toast(`🏁 ${a.name} → ${b.name}: ${Math.round(raceKm())} km.` + (best ? ` ${T('Mejor tiempo')}: ${fmtT(best)}.` : ''));
  }
  const CPU_NAMES = ['Cóndor', 'Halcón', 'Albatros', 'Gaviota', 'Colibrí', 'Pelícano', 'Águila', 'Petrel', 'Garza', 'Flamenco', 'Tucán', 'Búho'];
  const CPU_COLORS = ['#ff453a', '#ff9f0a', '#ffd60a', '#34c759', '#64d2ff', '#bf5af2', '#ff375f', '#ac8e68', '#30d158', '#5e5ce6', '#ffffff', '#8e8e93'];
  const raceKmFrom = (a, b) => C.Cartesian3.distance(C.Cartesian3.fromDegrees(a.lon, a.lat, 0), C.Cartesian3.fromDegrees(b.lon, b.lat, 0)) / 1000;
  const cpuPos = (c) => { // along the race path (roads and ferries), a little to one side, 1.5 km over the ground
    const [lon, lat, hd] = pathAt(c.f), x = lon + (c.side * Math.cos(hd)) / Math.cos(rad(lat)), y = lat - c.side * Math.sin(hd);
    return C.Cartesian3.fromDegrees(x, y, (scene.globe.getHeight(C.Cartographic.fromDegrees(x, y)) || 0) + 3000);
  };
  const myProgress = () => { // the nearest point of the path, checked a few times a second
    const now = performance.now();
    if (race.myT && now - race.myT < 300) return race.my;
    const lo = deg(s.lon), la = deg(s.lat), P = race.path, cl = Math.cos(s.lat) ** 2, from = Math.max(0, (race.myIdx || 0) - 5), to = Math.min(P.length, from + Math.max(60, Math.ceil(P.length / (race.laps || 1) / 2))); let best = race.myIdx || 0, bd = Infinity;
    for (let i = from; i < to; i++) { const d = (P[i][0] - lo) ** 2 * cl + (P[i][1] - la) ** 2; if (d < bd) { bd = d; best = i; } }
    race.myT = now; race.myIdx = best; race.my = race.cum[best] / race.pathLen; return race.my;
  };
  let landsP = null; // the country outlines (Natural Earth 1:50m) with their boxes, loaded once
  const countries = () => landsP || (landsP = Promise.all(['shp', 'dbf'].map((x) => fetch(NE + '50m_cultural/ne_50m_admin_0_countries.' + x).then((r) => r.arrayBuffer()))).then(([s2, d2]) => shp.combine([shp.parseShp(s2), shp.parseDbf(d2)]).features.filter((f) => f.geometry).map((f) => ({ f, box: turf.bbox(f) }))).catch(() => { landsP = null; return []; }));
  async function lineLeaves(stops) { // the name of the country every stop is in, when the straight course between them crosses the land of another one; null when the line is fine
    const all = await countries(), inside = (c, pt) => pt[0] >= c.box[0] && pt[0] <= c.box[2] && pt[1] >= c.box[1] && pt[1] <= c.box[3] && turf.booleanPointInPolygon(pt, c.f);
    const near = (c, p) => [[0, 0], [0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]].some(([dx, dy]) => inside(c, [p.lon + dx, p.lat + dy])); // a harbour town may fall just off the simplified coast
    const home = all.find((c) => inside(c, [stops[0].lon, stops[0].lat])) || all.find((c) => near(c, stops[0]));
    if (!home || !stops.every((p) => near(home, p))) return null; // an international race may cross whatever lies between
    for (let i = 0; i + 1 < stops.length; i++) { // a point every 10 km of each leg; the sea belongs to nobody
      const a = stops[i], b = stops[i + 1], n = Math.max(2, Math.ceil(raceKmFrom(a, b) / 10));
      for (let k = 1; k < n; k++) { const pt = [a.lon + ((b.lon - a.lon) * k) / n, a.lat + ((b.lat - a.lat) * k) / n]; if (!inside(home, pt) && all.some((c) => c !== home && inside(c, pt))) return String(home.f.properties.NAME_ES || home.f.properties.NAME || '').replace(/\0/g, '').trim(); }
    }
    return null;
  }
  async function raceLands(list) { // the countries named (by name or ISO code) are allowed; any other one turns the ship back, as in the adventure
    try {
      const [s2, d2] = await Promise.all([fetch(NE + '50m_cultural/ne_50m_admin_0_countries.shp').then((r) => r.arrayBuffer()), fetch(NE + '50m_cultural/ne_50m_admin_0_countries.dbf').then((r) => r.arrayBuffer())]);
      const all = shp.combine([shp.parseShp(s2), shp.parseDbf(d2)]).features, cl = (v) => String(v ?? '').replace(/\0/g, '').trim().toLowerCase();
      const want = list.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean), ok = (f) => { const p = f.properties; return want.some((w) => [p.ADM0_A3, p.ISO_A3, p.ISO_A2, p.NAME, p.NAME_ES, p.NAME_EN, p.ADMIN].some((x) => cl(x) === w)); };
      if (!all.some(ok)) return OGE.toast(T('No reconocí esos países: la carrera no tiene límites.'), true);
      if (race) race.others = all.filter((f) => f.geometry && !ok(f) && cl(f.properties.ADM0_A3) !== 'ata').map((f) => ({ f, box: turf.bbox(f) }));
    } catch { /* without the map of countries the race has no limits */ }
  }
  function borderStep(st, others) { // shared by the adventure and the races: inside a forbidden country, back to the last free point and turned around
    const now = performance.now();
    if (!others || now - (st.checkT || 0) < 150) return;
    st.checkT = now;
    const here = [C.Math.toDegrees(s.lon), C.Math.toDegrees(s.lat)], inside = others.find((o) => here[0] >= o.box[0] && here[0] <= o.box[2] && here[1] >= o.box[1] && here[1] <= o.box[3] && turf.booleanPointInPolygon(here, o.f));
    const inZone = (zs) => zs && zs.some((o) => here[0] >= o.box[0] && here[0] <= o.box[2] && here[1] >= o.box[1] && here[1] <= o.box[3] && turf.booleanPointInPolygon(here, o.f));
    if (!inside || inZone(st.allow)) { st.safe = [s.lon, s.lat]; return; } // free, or one of the country's own disputed areas
    if (st.safe) { s.lon = st.safe[0]; s.lat = st.safe[1]; }
    s.heading = C.Math.zeroToTwoPi(s.heading + Math.PI); boost = null;
    if (now - (st.warned || 0) > 2500) { st.warned = now; OGE.toast(`${T('No puedes entrar en otro país en esta etapa')}: ${String(inside.f.properties.NAME_ES || inside.f.properties.NAME).replace(/\0/g, '').trim()}`); sfx('shieldBreak'); }
  }
  function cpuStep(dt) {
    const now = performance.now(), me = myProgress();
    if (race.go) return; // waiting for the start
    for (const c of race.cpus) {
      if (c.f >= 1) continue;
      const pace = now < c.stunT ? 0.15 : 1, rubber = me > c.f + 0.15 ? 1.25 : me < c.f - 0.15 ? 0.85 : 1; // hit by a missile it crawls; a little rubber band keeps the race close
      c.f += (c.speed * pace * rubber * dt) / race.pathLen;
      if (now > c.itemT) { // now and then a rival close behind fires at the player
        c.itemT = now + 10000 + Math.random() * 12000;
        if (c.f < me && me - c.f < 0.08 && now > graceT) { OGE.toast(`${c.name} ${T('te lanzó un misil')}`); hurt(10); }
      }
    }
  }
  function raceStep() {
    const now = performance.now();
    if (race.go) {
      const left = race.go - now;
      if (left > 0) { stopped = true; s.v = 0; if (left < 2000 && left > 1000 && keys.has('e')) race.boostOk = true; const n = Math.ceil(left / 1000); if (n !== race.beep) { race.beep = n; beep(440, 160, 0.3); } return; } // 3 · 2 · 1; E held on the 2 earns a boost
      race.go = 0; stopped = false; race.t0 = now; beep(880, 300, 0.35); setWarp(race.maxWarp); s.v = A.vMax; s.throttle = 1; // go: flat out, at the top turbo allowed
      if (race.boostOk) { boost = null; boostCd = 0; startBoost(); OGE.toast(T('¡Salida perfecta!')); }
    }
    if (race.cpus.length) cpuStep(1 / 60);
    if (race.others) borderStep(race, race.others);
    const ng = race.gates && race.gates[race.nextGate];
    if (ng && myProgress() > ng.f + 0.04) { race.nextGate++; race.missed++; race.t0 -= 5000; objs = objs.filter((o) => o !== ng); OGE.toast(`${T('Te saltaste el aro')} ${ng.n}: +5 s`); sfx('shieldBreak'); } // a skipped gate: 5 s penalty
    if (race.gates ? race.nextGate < race.gates.length : myProgress() < 0.9) return; // the gates first (laps and intermediate goals); without rings, most of the course flown
    if (raceKm() > Math.max(3, (s.v * warp * 0.06) / 1000)) return; // within 3 km, or a couple of frames at high speed
    const ms = performance.now() - race.t0, key = 'oge.race.' + race.key, best = +localStorage.getItem(key) || 0, rec = !best || ms < best;
    if (rec) localStorage.setItem(key, String(Math.round(ms)));
    score += pts(1000);
    const place = race.cpus.length ? 1 + race.cpus.filter((c) => c.f >= 1).length : 0;
    mpSend({ t: 'fin', ms });
    OGE.toast(`🏁 ${T('¡Llegaste a')} ${race.to.name}! ${T('Tiempo')}: ${fmtT(ms)}` + (place ? ` · ${T('Puesto')} ${place}/${race.cpus.length + 1}` : '') + (rec ? ` · ${T('¡Nuevo récord!')}` : ` · ${T('Mejor tiempo')}: ${fmtT(best)}`));
    sfx('achieve');
    race = null;
    setTimeout(() => { if (on) stop(); }, 3000);
  }
  function drawRace(g, w, text) { // the goal: a flag where it is on the screen, and an arrow at the top pointing to it
    const h = hud.clientHeight;
    const toWin = C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates, q = toWin(scene, race.to.p);
    const ahead = C.Cartesian3.dot(C.Cartesian3.subtract(race.to.p, viewer.camera.positionWC, new C.Cartesian3()), viewer.camera.directionWC) > 0;
    if (q && ahead && new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, viewer.camera.positionWC).isPointVisible(race.to.p)) { g.save(); g.font = '28px sans-serif'; g.textAlign = 'center'; g.fillText('🏁', q.x, q.y); g.fillStyle = '#fff'; g.font = '600 12px sans-serif'; g.fillText(race.to.name, q.x, q.y + 18); g.restore(); }
    const c = viewer.camera.positionCartographic, rel = bearing({ lon: deg(c.longitude), lat: deg(c.latitude) }, race.to) - viewer.camera.heading;
    g.save(); g.translate(w / 2, 70); g.rotate(rel); g.fillStyle = g.shadowColor = '#34c759'; g.shadowBlur = 10; g.beginPath(); g.moveTo(0, -16); g.lineTo(11, 10); g.lineTo(0, 4); g.lineTo(-11, 10); g.closePath(); g.fill(); g.restore();
    const me = myProgress(), place = 1 + race.cpus.filter((c) => c.f > me).length;
    if (race.go && race.go > performance.now()) { const n = Math.ceil((race.go - performance.now()) / 1000); g.save(); g.textAlign = 'center'; g.font = '900 120px sans-serif'; g.lineWidth = 8; g.strokeStyle = '#000'; g.fillStyle = n === 2 ? '#ffd60a' : n === 1 ? '#34c759' : '#ff453a'; g.strokeText(String(n), w / 2, h / 2); g.fillText(String(n), w / 2, h / 2); g.font = '700 18px sans-serif'; g.lineWidth = 4; g.fillStyle = '#fff'; if (n === 2) { g.strokeText(T('¡Mantén E para salir con turbo!'), w / 2, h / 2 + 40); g.fillText(T('¡Mantén E para salir con turbo!'), w / 2, h / 2 + 40); } g.restore(); }
    text(`🏁 ${race.to.name} · ${raceKm().toFixed(1)} km · ${fmtT(race.go ? 0 : performance.now() - race.t0)}` + (race.cpus.length ? ` · ${T('Puesto')} ${place}/${race.cpus.length + 1}` : ''), 24, 156, 14, 'left');
    g.save(); g.textAlign = 'right'; g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 4; g.font = '800 34px sans-serif'; const pl = `${place}/${race.cpus.length + 1}`; g.strokeText(pl, w - 24, h - 90); g.fillText(pl, w - 24, h - 90); g.font = '600 13px sans-serif'; g.lineWidth = 3; g.strokeText(T('PUESTO'), w - 24, h - 128); g.fillText(T('PUESTO'), w - 24, h - 128); g.restore(); // the place, big
    const occ = new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, viewer.camera.positionWC);
    for (const c of race.cpus) { // the rivals, as ships in their colors with their names
      const p = cpuPos(c), d = C.Cartesian3.distance(p, viewer.camera.positionWC);
      if (d > 2e5 || !occ.isPointVisible(p) || C.Cartesian3.dot(C.Cartesian3.subtract(p, viewer.camera.positionWC, new C.Cartesian3()), viewer.camera.directionWC) < 0) continue;
      const q = toWin(scene, p); if (!q) continue;
      const R = clamp(4e5 / d, 10, 44); shipBack(q.x, q.y, R, c.color, Math.sin(performance.now() / 700 + c.side * 900) * 0.2, c.stunT > performance.now() ? performance.now() : 0, c.model, p);
      g.save(); g.fillStyle = c.color; g.textAlign = 'center'; g.font = '600 11px sans-serif'; g.fillText(c.name, q.x, q.y + R + 12); g.restore();
    }
    const gt = race.gates && race.gates[race.nextGate]; // where the next ring is: a mark over it, or an arrow at the edge of the view
    if (gt) {
      const cam = viewer.camera, v = C.Cartesian3.subtract(gt.p, cam.positionWC, new C.Cartesian3()), label = `${T('Aro')} ${gt.n} · ${(C.Cartesian3.magnitude(v) / 1000).toFixed(1)} km`, q = C.Cartesian3.dot(v, cam.directionWC) > 0 ? toWin(scene, gt.p) : null;
      g.save(); g.fillStyle = g.strokeStyle = '#34c759'; g.shadowColor = '#000'; g.shadowBlur = 4; g.lineWidth = 2; g.textAlign = 'center'; g.font = '700 13px sans-serif';
      if (q && q.x > 0 && q.y > 0 && q.x < w && q.y < h) { g.fillText(label, q.x, q.y - 28); g.beginPath(); g.moveTo(q.x, q.y - 8); g.lineTo(q.x - 7, q.y - 21); g.lineTo(q.x + 7, q.y - 21); g.closePath(); g.fill(); }
      else { const a = Math.atan2(-C.Cartesian3.dot(v, cam.upWC), C.Cartesian3.dot(v, cam.rightWC)), rr = Math.min(w, h) * 0.4; g.translate(w / 2 + Math.cos(a) * rr, h / 2 + Math.sin(a) * rr); g.fillText(label, 0, -18); g.rotate(a + Math.PI / 2); g.beginPath(); g.moveTo(0, -12); g.lineTo(8, 8); g.lineTo(0, 3); g.lineTo(-8, 8); g.closePath(); g.fill(); }
      g.restore();
    }
    if (race.gates) text((race.laps > 1 ? `${T('Vuelta')} ${Math.min(race.laps, 1 + Math.floor((race.nextGate * race.laps) / race.gates.length))}/${race.laps} · ` : '') + `${T('Aro')} ${Math.min(race.nextGate + 1, race.gates.length)}/${race.gates.length}` + (race.missed ? ` · ${T('saltados')}: ${race.missed}` : '') + ` · ${T('Monedas de velocidad')}: ${race.coins || 0}/10`, 24, 196, 14, 'left');
    text(`${T('OBJETOS')} (U): ` + [0, 1, 2].map((i) => (items[i] ? `[${ITEMS[items[i]][0]} ${T(ITEMS[items[i]][1])}]` : '[ ]')).join(' '), 24, 176, 14, 'left'); // three slots, the first is used next
  }

  // ---------- Adventure: a campaign of country stages. Inside a stage the ship cannot leave the country; once all its region flags
  // are collected, the boss of its capital appears; beating it unlocks the next country. Progress is kept on this computer. ----------
  // The adventure, by continent: each one has its own route and progress (the first South American stage keeps the old progress)
  const ROUTES = { 'Sudamérica': ['CHL', 'ARG', 'URY', 'PRY', 'BOL', 'PER', 'ECU', 'COL', 'VEN', 'GUY', 'SUR', 'BRA'],
    'Norteamérica': ['MEX', 'USA', 'CAN'], 'Centroamérica': ['GTM', 'BLZ', 'SLV', 'HND', 'NIC', 'CRI', 'PAN'], 'Caribe': ['CUB', 'JAM', 'HTI', 'DOM', 'BHS', 'TTO'],
    'Europa': ['ISL', 'GBR', 'IRL', 'PRT', 'ESP', 'FRA', 'ITA', 'CHE', 'DEU', 'POL', 'UKR', 'GRC', 'NOR', 'SWE'], 'Magreb': ['MAR', 'DZA', 'TUN', 'LBY', 'EGY'],
    'Sahel': ['MRT', 'MLI', 'NER', 'TCD', 'SDN'], 'África subsahariana': ['SEN', 'NGA', 'ETH', 'KEN', 'COD', 'AGO', 'ZAF', 'MDG'],
    'Medio Oriente': ['TUR', 'SYR', 'JOR', 'IRQ', 'IRN', 'SAU', 'ARE'], 'Asia': ['KAZ', 'UZB', 'IND', 'CHN', 'MNG', 'KOR', 'JPN', 'IDN'], 'Oceanía': ['AUS', 'NZL', 'PNG'],
    'Ultramar': ['GRL', 'FRO', 'BMU', 'PRI', 'ABW', 'CUW', 'CYM', 'NCL', 'PYF', 'GUM'] }; // territories of other countries, a campaign of their own
  let advCont = ROUTES[localStorage.getItem('oge.advCont')] ? localStorage.getItem('oge.advCont') : 'Sudamérica';
  const route = () => ROUTES[advCont], advKey = () => (advCont === 'Sudamérica' ? 'oge.adventure' : 'oge.adventure.' + advCont);
  // Places some stages ask you to reach before the boss (within ~30 km): Chile's islands and its Antarctic territory
  // Places some stages ask you to reach before the boss (within ~30 km): islands, exclaves and far territories that are part of the country
  const STAGE_GOALS = {
    CHL: [['Isla de Pascua', -109.35, -27.12], ['Antártica Chilena (Villa Las Estrellas)', -58.97, -62.2]],
    ARG: [['Fortín Sargento Cabral (Base Esperanza)', -56.99, -63.40], ['Cementerio de Darwin (Malvinas)', -58.97, -51.81]],
    USA: [['Alaska (Anchorage)', -149.90, 61.22], ['Hawái (Honolulu)', -157.86, 21.31]],
    ESP: [['Islas Canarias (Las Palmas)', -15.43, 28.12], ['Ceuta', -5.32, 35.89], ['Melilla', -2.94, 35.29], ['Islas Baleares (Palma)', 2.65, 39.57]],
    NOR: [['Svalbard (Longyearbyen)', 15.63, 78.22]],
    AUS: [['Tasmania (Hobart)', 147.33, -42.88], ['Isla Norfolk', 167.95, -29.04]],
    NZL: [['Isla Sur (Christchurch)', 172.64, -43.53], ['Islas Chatham', -176.55, -43.95]],
    PRT: [['Azores (Ponta Delgada)', -25.67, 37.74], ['Madeira (Funchal)', -16.91, 32.65]],
    ITA: [['Sicilia (Palermo)', 13.36, 38.12], ['Cerdeña (Cagliari)', 9.11, 39.22]],
    GRC: [['Creta (Heraklion)', 25.13, 35.34]], FRA: [['Córcega (Ajaccio)', 8.74, 41.92]], GBR: [['Irlanda del Norte (Belfast)', -5.93, 54.60]],
    ECU: [['Islas Galápagos', -90.31, -0.74]], COL: [['San Andrés', -81.70, 12.58]], BRA: [['Fernando de Noronha', -32.42, -3.85]],
    MEX: [['Baja California Sur (La Paz)', -110.31, 24.14]], CAN: [['Nunavut (Iqaluit)', -68.52, 63.75]],
    JPN: [['Hokkaido (Sapporo)', 141.35, 43.06], ['Okinawa (Naha)', 127.68, 26.21]], IND: [['Islas Andamán (Port Blair)', 92.73, 11.62]], CHN: [['Hainan (Haikou)', 110.35, 20.02]],
    IDN: [['Papúa (Jayapura)', 140.70, -2.53]], DNK: [['Bornholm', 14.87, 55.10]], EQG: [['Bioko (Malabo)', 8.78, 3.75]],
  };
  let advOthers = null, advAllow = null; // [{ f, box }] the countries the adventure stage forbids
  let adv = null, advShape = null, graceT = 0, liveT = 0;
  async function liveEnemies() {
    if (OGE.body) { liveT = Infinity; return; }
    liveT = performance.now() + (window.__TAURI__ ? 15000 : 90000); // asked every 15 s (the web feed has a small daily quota: every 90 s)
    try {
      const list = (await OGE.livePlanes(C.Math.toDegrees(s.lon), C.Math.toDegrees(s.lat), 120)).slice(0, 6);
      objs = objs.filter((o) => o.kind !== 'airliner'); // the old positions are replaced
      for (const a of list) {
        const ft = typeof a.alt_baro === 'number' ? a.alt_baro : 20000;
        objs.push({ kind: 'airliner', a, p: C.Cartesian3.fromDegrees(a.lon, a.lat, Math.max(1500, ft * 0.3048)), size: 600, hp: 3, look: 0, next: performance.now() + 2000 + Math.random() * 3000 });
      }
    } catch { /* no feed: the game goes on without them */ }
  } // adv: { i, a3 } while a stage runs; advShape: the country's polygons
  const advDone = () => +localStorage.getItem(advKey()) || 0; // stages beaten on this continent
  async function pickAdventure() { // any stage of any continent's campaign, not only the next one
    const fm = flagMap || await OGE.flags().catch(() => null), name = (a3) => (fm && fm.get(a3) && fm.get(a3).name) || a3, opts = []; // the countries by name once the flags table is in; by code otherwise
    for (const k of Object.keys(ROUTES)) { const done = +localStorage.getItem(k === 'Sudamérica' ? 'oge.adventure' : 'oge.adventure.' + k) || 0; ROUTES[k].forEach((a3, i) => { if (i <= done) opts.push([k + '|' + i, `${T(k)} · ${i + 1}. ${name(a3)}${i < done ? ' — ' + T('superada') : ''}`]); }); } // only the stages beaten and the next one
    const v = await OGE.ask({ title: 'Aventura: elegir etapa', ok: 'Jugar', help: 'Cada continente es una campaña. Sus etapas se desbloquean a medida que avanzas: puedes repetir las superadas o seguir con la siguiente.',
      fields: [{ id: 'st', label: 'Campaña y etapa', type: 'select', value: advCont + '|' + Math.min(advDone(), route().length - 1), options: opts }] });
    if (!v) return;
    const [k, i] = String(v.st).split('|'); if (!ROUTES[k]) return;
    advCont = k; localStorage.setItem('oge.advCont', k); adventure(+i);
  }
  async function adventure(stage = advDone()) {
    relaunch = () => adventure(stage);
    mpGo({ mode: 'adventure', cont: advCont, stage });
    const a3 = route()[Math.min(stage, route().length - 1)];
    const [s2, d2] = await Promise.all([fetch(NE + '50m_cultural/ne_50m_admin_0_countries.shp').then((r) => r.arrayBuffer()), fetch(NE + '50m_cultural/ne_50m_admin_0_countries.dbf').then((r) => r.arrayBuffer())]);
    const all = shp.combine([shp.parseShp(s2), shp.parseDbf(d2)]).features, A3 = (x) => String(x.properties.ADM0_A3).replace(/\0/g, '').trim();
    const f = all.find((x) => A3(x) === a3);
    const parts = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates.map((c) => ({ type: 'Polygon', coordinates: c })) : [f.geometry];
    const mainPart = parts.reduce((a, b) => (turf.area(b) > turf.area(a) ? b : a)), around = new Set(); // exclaves: the country that surrounds each one may be crossed
    for (const pt of parts) {
      if (pt === mainPart) continue;
      const [w, so, e, n] = turf.bbox(pt), m = 0.03;
      const hits = [[w - m, so - m], [e + m, so - m], [w - m, n + m], [e + m, n + m]].map((c) => all.find((x) => x.geometry && A3(x) !== a3 && turf.booleanPointInPolygon(c, x)));
      if (hits.every(Boolean)) for (const x of hits) around.add(A3(x)); // only a part shut in by land on every side: one the sea reaches (Chile's Tierra del Fuego) is flown to over the water
    }
    advOthers = all.filter((x) => x.geometry && A3(x) !== a3 && A3(x) !== 'ATA' && !around.has(A3(x)) && !(a3 === 'ARG' && ['FLK', 'SGS'].includes(A3(x)))).map((x) => ({ f: x, box: turf.bbox(x) })); // the other countries (Antarctica is open to all)
    if (!f) return OGE.toast('No se encontró el país de la etapa.', true);
    advShape = f;
    advAllow = null; // the stage country's claimed or disputed areas (Crimea for Ukraine…): open to it
    fetch(NE + '10m_cultural/ne_10m_admin_0_disputed_areas.shp').then((r) => r.arrayBuffer()).then(async (b) => {
      const dbf = await (await fetch(NE + '10m_cultural/ne_10m_admin_0_disputed_areas.dbf')).arrayBuffer(), cl = (v) => String(v ?? '').replace(/\0/g, '').trim();
      const nm = [cl(f.properties.NAME), cl(f.properties.ADMIN), cl(f.properties.NAME_LONG)].filter(Boolean);
      advAllow = shp.combine([shp.parseShp(b), shp.parseDbf(dbf)]).features.filter((d) => d.geometry && (cl(d.properties.ADM0_A3) === a3 || nm.some((n) => cl(d.properties.NOTE_BRK).includes(n)))).map((d) => ({ f: d, box: turf.bbox(d) }));
    }).catch(() => {});
    const name = String(f.properties.NAME_ES || f.properties.NAME).replace(/\0/g, '').trim(), cp = caps && caps.find((x) => x.a3 === a3);
    const c = cp ? [cp.lon, cp.lat] : [+f.properties.LABEL_X, +f.properties.LABEL_Y]; // the stage starts over its capital
    viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(c[0], c[1], 40000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
    localStorage.setItem('oge.quest', '1');
    const doneGoals = (() => { try { return JSON.parse(localStorage.getItem('oge.advGoals.' + a3)) || []; } catch { return []; } })();
    adv = { i: stage, a3, name, boss: false, goals: (STAGE_GOALS[a3] || []).map(([n, lon, lat]) => ({ n, lon, lat, p: C.Cartesian3.fromDegrees(lon, lat, 300), done: doneGoals.includes(n) })) }; // places the stage asks to visit (kept between tries)
    start('ship', true, true, true, false); // aim with the mouse, fly with the keyboard
    graceT = performance.now() + 6000; // a few seconds without damage to get one's bearings
    OGE.toast(`${T('Etapa')} ${stage + 1}/${route().length}: ${name}. ${T('Recoge todas sus banderas y luego derrota al jefe de la capital.')}`);
  }
  function advStep() {
    if (!adv) return;
    const here = [C.Math.toDegrees(s.lon), C.Math.toDegrees(s.lat)];
    adv.allow = advAllow; borderStep(adv, advOthers); // the sea, its islands (Easter Island…) and Antarctica are free: only the other countries are off limits
    if (!regs) return; // the flags of the stage are still loading
    const mine = regs.filter((r) => r.a3 === adv.a3), left = mine.filter((r) => !gotReg.has(r.id)).length;
    adv.left = left;
    for (const gl of adv.goals) if (!gl.done && Math.abs(gl.lat - here[1]) < 0.3 && Math.abs((gl.lon - here[0]) * Math.cos(s.lat)) < 0.3) { gl.done = true; localStorage.setItem('oge.advGoals.' + adv.a3, JSON.stringify(adv.goals.filter((x) => x.done).map((x) => x.n))); OGE.toast(`${T('¡Llegaste a')} ${gl.n}!`); sfx('achieve'); }
    const goalsLeft = adv.goals.filter((gl) => !gl.done).length; adv.goalsLeft = goalsLeft;
    if (left === 0 && goalsLeft === 0 && !adv.boss) { // every flag and every place: the capital's boss shows up
      const cap = caps && caps.find((x) => x.a3 === adv.a3);
      if (!cap) { adv.boss = true; adv.cap = null; } // no capital with a boss (some territories): the stage is done
      else if (cap) { got.delete(capId(cap)); adv.boss = true; adv.cap = cap; OGE.toast(`${T('¡Todas las banderas! El jefe de')} ${cap.name} ${T('te espera.')}`); sfx('achieve'); }
    }
    if (adv.boss && (!adv.cap || got.has(capId(adv.cap)))) { // its capital won (or none to win): stage cleared
      localStorage.setItem(advKey(), String(Math.max(advDone(), adv.i + 1))); localStorage.removeItem('oge.advGoals.' + adv.a3);
      const next = adv.i + 1;
      OGE.toast(next < route().length ? `${T('¡Etapa superada!')} ${T('Siguiente')}: ${route()[next]}.` : `${T('¡Completaste la aventura de')} ${T(advCont)}!`);
      sfx('achieve');
      adv = null; advShape = null;
      if (next < route().length) setTimeout(() => { stop(); adventure(next); }, 2500);
    }
  }

  // Scoreboard: the ten best arcade flights, kept on this computer.
  // One scoreboard per difficulty (the easy one keeps the old key, so earlier scores stay there)
  const scoreKey = (d = diff) => (d === 'normal' ? 'oge.scores' : 'oge.scores.' + d);
  const readScores = (d) => { try { return JSON.parse(localStorage.getItem(scoreKey(d))) || []; } catch { return []; } };
  const menuPause = () => { // a menu over the game stops it until it closes; not in a multiplayer game, where the others keep flying
    if (!on || paused || p2 || ws || remote) return;
    paused = true; $('table').addEventListener('close', () => { paused = false; last = performance.now(); }, { once: true });
  };
  function showFlags() { syncRegs(); // the region flags collected: the stage's in the adventure, otherwise the totals per country
    if (!regs) return OGE.toast(T('Las banderas aún se están cargando.'));
    menuPause();
    if (adv) {
      const mine = regs.filter((r) => r.a3 === adv.a3).sort((a, b) => a.name.localeCompare(b.name));
      return OGE.showTable(`${T('Banderas de')} ${adv.name}: ${mine.filter((r) => gotReg.has(r.id)).length}/${mine.length}`, [T('Región'), T('Estado')], mine.map((r) => [r.name, gotReg.has(r.id) ? T('recolectada') : T('pendiente')]));
    }
    const per = new Map();
    for (const r of regs) { const e = per.get(r.country) || [0, 0]; e[1]++; if (gotReg.has(r.id)) e[0]++; per.set(r.country, e); }
    const rows = [...per].filter(([, [n]]) => n).sort((a, b) => b[1][0] - a[1][0]).map(([c, [n, all]]) => [c, `${n}/${all}`]);
    OGE.showTable(`${T('Banderas recolectadas')}: ${gotReg.size}/${regs.length}`, [T('País'), T('Banderas')], rows.length ? rows : [[T('Aún ninguna'), '']]);
  }
  OGE.showFlags = showFlags;
  function showArms() { // the coats of arms won from the bosses, one per capital
    if (!caps || !flagMap) return OGE.toast(T('Los escudos aún se están cargando: abre el arcade primero.'));
    menuPause();
    const mine = caps.filter((c) => got.has(capId(c))).sort((x, y) => x.name.localeCompare(y.name)), box = Object.assign(document.createElement('div'), { style: 'display:flex;flex-wrap:wrap;gap:14px;justify-content:center' });
    const btn = (text, fn) => Object.assign(document.createElement('button'), { type: 'button', textContent: T(text), onclick: fn, style: 'display:block;width:100%;margin-top:4px;font-size:11px' });
    const where = Object.assign(document.createElement('select'), { style: 'flex-basis:100%;font-size:12px' }); // one insignia for the whole ship by default; each wing can wear its own
    for (const [v, txt] of [['both', 'Insignia en las dos alas'], ['L', 'Solo en el ala izquierda'], ['R', 'Solo en el ala derecha']]) where.append(new Option(T(txt), v));
    const wear = (u) => {
      if (!u) { localStorage.removeItem('oge.insignia'); localStorage.removeItem('oge.insigniaR'); }
      else { localStorage.setItem(where.value === 'R' ? 'oge.insigniaR' : 'oge.insignia', u); if (where.value === 'both') localStorage.removeItem('oge.insigniaR'); }
      OGE.toast(T(u ? 'Insignia puesta en las alas y los costados de tu nave.' : 'Nave sin insignia.'));
    };
    if (mine.length) box.append(where, Object.assign(btn('Quitar la insignia de la nave', () => wear(null)), { style: 'flex-basis:100%;font-size:12px' }));
    for (const c of mine) {
      const fl = flagMap.get(c.a3), fig = Object.assign(document.createElement('figure'), { style: 'margin:0;width:110px;text-align:center;font-size:12px' });
      if (fl && fl.arms) fig.append(Object.assign(new Image(), { src: fl.arms, alt: '', loading: 'lazy', style: 'max-width:100px;max-height:100px' }));
      fig.append(Object.assign(document.createElement('figcaption'), { textContent: c.name + (fl && fl.name ? ' · ' + fl.name : '') }));
      if (fl && fl.arms) fig.append(btn('Escudo en la nave', () => wear(fl.arms)), btn('Escarapela aérea', async (e) => { // the roundel, as Wikidata has it; without one, the coat of arms
        e.target.disabled = true; const u = await roundel(fl.q).catch(() => null); e.target.disabled = false;
        if (!u) OGE.toast(T('Wikidata no tiene la insignia de esa fuerza aérea: se usa el escudo.')); wear(u || fl.arms); }));
      box.append(fig);
    }
    OGE.showTable(`${T('Escudos de armas')}: ${mine.length}/${caps.length}`, [], [], { content: box, note: mine.length ? T('Imágenes: Wikimedia Commons. Elige un escudo, o la escarapela de la fuerza aérea de ese país (Wikidata), para llevarlo en la nave.') : T('Aún ninguno: vence al jefe de una capital y recoge su escudo.') });
  }
  OGE.showArms = showArms;
  const TINTS = [['#3fa9ff', 'Azul'], ['#ff375f', 'Rojo'], ['#30d158', 'Verde'], ['#ffd60a', 'Amarillo'], ['#ff9f0a', 'Naranja'], ['#bf5af2', 'Morado'], ['#f2f2f7', 'Blanco'], ['#1c1c1e', 'Negro'], ['#8e8e93', 'Gris'], ['#c9cfd8', 'Plateado'], ['#766b6b', 'Gris acero'], ['#ff7300', 'Naranja intenso']];
  const tintFields = (id, label, hexLabel, value) => { const v = String(value || '').toLowerCase(), known = TINTS.some(([c]) => c === v); // a list of named colours, and a hex code for any other
    return [{ id, label, type: 'select', value: known ? v : 'custom', options: [...TINTS, ['custom', 'Personalizado (código hex)']] }, { id: id + 'Hex', label: hexLabel, type: 'text', value: v, placeholder: '#3fa9ff' }]; };
  const tintOf = (v, id, old) => (v[id] !== 'custom' ? v[id] : hex('#' + String(v[id + 'Hex'] || '').trim().replace(/^#/, ''), old)); // a wrong code keeps the colour it had
  async function shipStyle() { // the pilot's ship: its model, the colour of its wings and of its hull
    const live = !!(p2 || ws || remote), was = paused; if (on && !live) paused = true; // in a multiplayer game the others keep flying: no pause
    if (!subMap) try { subMap = await (await fetch('data/subflags.json')).json(); subAsked = true; } catch { /* only the national flags, then */ }
    const flagOpts = [], seen = new Set(), add = (u, label) => { if (u && !seen.has(u)) { seen.add(u); flagOpts.push([u, label]); } }; // every flag collected: the country's, and the region's own where it has one
    for (const r of regs || []) { if (!gotReg.has(r.id)) continue; add(r.img && r.img.src, r.country); if (subMap && subMap[r.id]) add('https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(subMap[r.id]) + '?width=250', `${r.name} (${r.country})`); }
    flagOpts.sort((x, y) => x[1].localeCompare(y[1]));
    for (const k of ['oge.finFlag', 'oge.finFlagR']) add(localStorage.getItem(k), T('La que lleva ahora'));
    const v = await OGE.ask({ title: 'Nave: estilo y colores', ok: 'Aplicar', help: 'La nave se ve en tercera persona (Y). La insignia de las alas se elige en «Escudos de armas».',
      fields: [{ id: 'model', label: 'Estilo de nave', type: 'select', value: SHIPS[localStorage.getItem('oge.shipModel')] ? localStorage.getItem('oge.shipModel') : 'dardo', options: Object.entries(SHIPS).map(([k, m]) => [k, m.name]) },
        ...tintFields('wing', 'Color de las alas', 'Alas: código hex (con «Personalizado»)', skin(1)), ...tintFields('hull', 'Color del fuselaje', 'Fuselaje: código hex (con «Personalizado»)', hull1()),
        { id: 'fin', label: 'Bandera en las derivas (de tus banderas recolectadas)', type: 'select', value: localStorage.getItem('oge.finFlag') || '', options: [['', 'Sin bandera'], ...flagOpts] },
        { id: 'finR', label: 'Bandera de la deriva derecha, si quieres otra', type: 'select', value: localStorage.getItem('oge.finFlagR') || '', options: [['', 'La misma que la izquierda'], ...flagOpts] }] });
    if (on && !live) { paused = was; last = performance.now(); }
    if (!v) return;
    if (SHIPS[v.model]) localStorage.setItem('oge.shipModel', v.model);
    for (const [k, u] of [['oge.finFlag', v.fin], ['oge.finFlagR', v.finR]]) { if (u) localStorage.setItem(k, u); else localStorage.removeItem(k); }
    localStorage.setItem('oge.skin1', tintOf(v, 'wing', skin(1))); localStorage.setItem('oge.hull1', tintOf(v, 'hull', hull1()));
  }
  OGE.shipStyle = shipStyle;
  const showScores = () => OGE.showTable('🏆 Mejores puntajes', [T('Dificultad'), '#', 'Piloto', 'Puntos', 'Monedas', 'Banderas', 'Capitales', 'Jefes', 'Fecha'],
    Object.keys(DIFF).flatMap((d) => readScores(d).map((r, i) => [T(DIFF[d].name), i + 1, r.name, r.score, r.coins, r.flags ?? 0, r.caps ?? 0, r.bosses ?? 0, r.date])),
    { note: T('Se guardan solo en este equipo.') + (caps ? ' ' + T('Capitales:') + ' ' + Object.entries(capProgress()).map(([k, [n, all]]) => `${n === all ? '🏆 ' : ''}${T(k)} ${n}/${all}`).join(' · ') : '') + (regs ? ' ' + T('Banderas de regiones:') + ' ' + regs.filter((r) => gotReg.has(r.id)).length + '/' + regs.length + '.' : '') });
  async function saveScore(pts, cns) {
    const tally = { ...run }; // the flight may restart while the name is asked
    const v = await OGE.ask({ title: `Puntaje: ${pts} puntos y ${cns} monedas`, ok: 'Guardar', fields: [{ id: 'name', label: 'Tu nombre', value: localStorage.getItem('oge.pilot') || '' }] });
    const name = v && v.name.trim().slice(0, 24);
    if (name) {
      localStorage.setItem('oge.pilot', name);
      localStorage.setItem(scoreKey(), JSON.stringify([...readScores(diff), { name, score: pts, coins: cns, ...tally, date: new Date().toISOString().slice(0, 10) }].sort((a, b) => b.score - a.score || b.coins - a.coins).slice(0, 10)));
    }
    showScores();
  }
  let autoOn = [], autoOff = [];
  let sideWas = false;
  function stop(msg, error) {
    if (sideWas) { sideWas = false; OGE.hideSide(false); }
    for (const id of autoOn) { $(id).checked = false; $(id).dispatchEvent(new Event('change')); } autoOn = [];
    for (const id of autoOff) { $(id).checked = true; $(id).dispatchEvent(new Event('change')); } autoOff = [];
    engineHum(0); scene.globe.maximumScreenSpaceError = 2; OGE.fxForce = false;
    on = false; if (race && race.vBase) A.vMax = race.vBase; race = null; if (msg && adv) { adv = null; advShape = null; } // a crash ends the stage tut = null;
    music(false);
    if (arcade && !msg && score) msg = `Vuelo terminado: ${score} puntos y ${coins} monedas.`;
    if (arcade && (score || coins)) saveScore(score, coins);
    if (p2) { const n = p2.score; setTimeout(() => OGE.toast(`Jugador 2: ${n} puntos.`), 3500); p2 = null; }
    scene.screenSpaceCameraController.enableInputs = true;
    document.body.classList.remove('flying');
    hud.hidden = true;
    $('flyKeys').hidden = true; $('flyRules').hidden = true;
    $('flyBtn').classList.remove('active');
    viewer.camera.setView({ orientation: { heading: viewer.camera.heading, pitch: Math.min(viewer.camera.pitch, rad(-20)), roll: 0 } }); // level view looking at the ground
    if (msg) OGE.toast(msg, error);
  }

  // ---------- Multiplayer: a second player on this screen (I J K L, U/O, Enter) or a remote one over a WebSocket ----------
  // Local: player 2 is a wingman drawn ahead of the view; the reticle above its ship aims. Online: the desktop app relays
  // a few messages a second between the players (src-tauri mp_host); each side checks its own shots and tells the other one.
  const PAL = ['#3fa9ff', '#ff9f0a', '#30d158', '#ff375f', '#bf5af2', '#ffd60a'], rgb = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)), isHex = (c) => /^#[0-9a-f]{6}$/i.test(c || '');
  const near = (a, b) => isHex(a) && isHex(b) && Math.hypot(...rgb(a).map((x, i) => x - rgb(b)[i])) < 90;
  const apart = (c, taken) => (taken.some((t) => near(c, t)) ? PAL.find((p) => !taken.some((t) => near(p, t))) || c : c); // a colour already taken gives way to the first free one
  const skin = (n) => { // the colour each player flies in: player 2 yields to player 1, and online whoever joined yields to the host
    const own = (k) => localStorage.getItem('oge.skin' + k) || (k === 1 ? '#766b6b' : '#3fa9ff');
    if (n === 2) return apart(own(2), [skin(1)]);
    return ws && remote && remote.skin && mpMode !== 'host' ? apart(own(1), [remote.skin]) : own(1);
  };
  const P2KEYS = new Set(['i', 'j', 'k', 'l', 'u', 'o', 'enter']);
  let mpMode = 'solo', ws = null, remote = null, p2 = null, credit = 1, mpTimer = null; // credit: which local player scores
  const gain = (n) => { if (credit === 2 && p2) p2.score += n; else score += n; };
  const mpSend = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
  let mpEcho = false; // true while a game is being started from the other player's invitation: it is not announced back
  const mpGo = (m) => { if (!mpEcho) mpSend({ t: 'go', name: localStorage.getItem('oge.pilot') || T('Piloto'), ...m }); }; // tells the other player which game starts
  async function mpJoin(m) { // the other player started a game: offer to play the same one, in the same place
    const what = m.mode === 'race' ? T('una carrera') : m.mode === 'adventure' ? T('la aventura') : m.mode === 'free' ? T('un vuelo libre') : T('una partida libre');
    if (on) paused = true;
    const ok = await OGE.ask({ title: `${String(m.name || T('Piloto')).slice(0, 24)} ${T('inició')} ${what}`, ok: 'Unirme', help: 'Jugarán el mismo modo, en el mismo lugar.' });
    paused = false; last = performance.now();
    if (!ok) return;
    const num = (x) => Number.isFinite(+x), place = (p) => p && num(p.lon) && num(p.lat) && { lon: +p.lon, lat: +p.lat, name: String(p.name || '').slice(0, 60) }, txt = (x, n) => String(x ?? '').slice(0, n); // what arrives from the network is checked and trimmed
    mpEcho = true;
    try {
      const a = place(m.a), b = place(m.b), via = Array.isArray(m.via) ? m.via.slice(0, 8).map(place) : [];
      if (m.mode === 'race' && m.v && a && b && via.every(Boolean)) raceGo({ from: txt(m.v.from, 60), to: txt(m.v.to, 60), lands: txt(m.v.lands, 200), via: txt(m.v.via, 300), maxWarp: WARPS.includes(+m.v.maxWarp) ? +m.v.maxWarp : 2, laps: clamp(Math.round(+m.v.laps) || 1, 1, 5), cpus: clamp(Math.round(+m.v.cpus) || 0, 0, 12) }, a, b, via);
      else if (m.mode === 'adventure' && ROUTES[m.cont] && Number.isInteger(m.stage) && m.stage >= 0) { advCont = m.cont; await adventure(m.stage); }
      else if (m.mode !== 'race' && m.mode !== 'adventure') { if (num(m.lon) && num(m.lat)) viewer.camera.setView({ destination: C.Cartesian3.fromRadians(+m.lon, +m.lat, 3000) }); quickShip(m.mode === 'free' ? 'free' : 'arcade'); } // a race or an adventure with bad data starts nothing
    } finally { mpEcho = false; }
  }
  const P1POS = (w, h) => [w / 2, h * 0.8]; // where player 1's own ship is drawn in local mode
  // ---------- Third person: a chase camera with some lag, our own low-poly ship drawn in 3D, and twin reticles ahead of its nose ----------
  let chase = null; // { h, p, bank, d }: the camera's heading and pitch (they trail the ship's), the ship's bank into the turn, the distance
  const tps = () => third && A && A.ship && !p2; // the local two-player view keeps its own cameras
  const shipAxes = () => axesAt(C.Cartesian3.fromRadians(s.lon, s.lat, s.alt), s.heading, landing ? s.pitch : (s.pe ?? s.pitch), (chase ? chase.bank : 0) + (landing ? 0 : s.roll + (s.rollOff || 0)));
  function axesAt(P, hd, pt, bank) { // a place and its axes in the world from heading, pitch and bank (positive: right wing down)
    const m = C.Transforms.eastNorthUpToFixedFrame(P);
    const E = new C.Cartesian3(m[0], m[1], m[2]), N = new C.Cartesian3(m[4], m[5], m[6]), U = new C.Cartesian3(m[8], m[9], m[10]);
    const mix = (a, ka, b, kb, c, kc) => new C.Cartesian3(a.x * ka + b.x * kb + c.x * kc, a.y * ka + b.y * kb + c.y * kc, a.z * ka + b.z * kb + c.z * kc);
    const F = mix(E, Math.sin(hd) * Math.cos(pt), N, Math.cos(hd) * Math.cos(pt), U, Math.sin(pt)), R0 = mix(E, Math.cos(hd), N, -Math.sin(hd), U, 0), U0 = C.Cartesian3.cross(R0, F, new C.Cartesian3());
    const cb = Math.cos(bank), sb = Math.sin(bank);
    return { P, F, R: mix(R0, cb, U0, -sb, F, 0), U: mix(R0, sb, U0, cb, F, 0) };
  }
  const shipPoint = (ax, x, y, z) => new C.Cartesian3(ax.P.x + ax.R.x * x + ax.U.x * y + ax.F.x * z, ax.P.y + ax.R.y * x + ax.U.y * y + ax.F.y * z, ax.P.z + ax.R.z * x + ax.U.z * y + ax.F.z * z);
  function chaseCam(dt) {
    if (!chase) chase = { h: s.heading, p: s.pitch, bank: 0, d: 380 };
    const deep = (s.alt > DEEP || !!auto || Math.abs(s.lat) > rad(88)) && !landing; // no horizon there (and over a pole the heading spins): the camera keeps the ship's own attitude
    if (deep) { chase.h = s.heading; chase.p = s.pitch; }
    else { chase.h += C.Math.negativePiToPi(s.heading - chase.h) * Math.min(1, 3.5 * dt); chase.p += (s.pitch - chase.p) * Math.min(1, 3 * dt); } // the camera turns after the ship: the ship swings across the view
    chase.bank += ((landing ? 0 : s.rud * 1.05) - chase.bank) * Math.min(1, 6 * dt); // it banks into the turn
    const want = landing ? 240 : stopped ? 250 : boost ? 560 : 340 + 80 * s.throttle; // closer when braking, further with the turbo
    chase.d += (want - chase.d) * Math.min(1, 2.5 * dt);
    const c = viewer.camera;
    c.setView({ destination: C.Cartesian3.fromRadians(s.lon, s.lat, s.alt), orientation: { heading: chase.h, pitch: chase.p, roll: deep ? s.roll : 0 } });
    c.moveBackward(chase.d); c.moveUp(chase.d * 0.27 - (s.pitch - chase.p) * chase.d * 0.8); c.moveRight(-chase.bank * chase.d * 0.16); c.lookDown(0.2);
  }
  // Low-poly meshes of our own: x right, y up, z forward (about 100 units across). poly() adds a face, sym() adds it and its mirror,
  // hull() a faceted body from rings [z, half-width, height above, depth below]. Face letters pick the colour: h light hull, d dark hull, s skin, w accent, g glass, e glow, m mouth.
  const meshOf = (build) => {
    const V = [], F = [];
    const poly = (c, ...pts) => F.push([pts.map((p) => V.push(p) - 1), c]) - 1; // returns the face's index
    const on = (par, c, ...pts) => { F.push([pts.map((p) => V.push(p) - 1), c, par]); }; // a detail lying on face par: drawn right after it
    const sym = (c, ...pts) => { poly(c, ...pts); poly(c, ...pts.map(([x, y, z]) => [-x, y, z])); };
    const hull = (nose, rings, n = 8, cap = 'e') => {
      const R = rings.map(([z, rx, top, bot]) => Array.from({ length: n }, (_, k) => { const a = (2 * Math.PI * (k + 0.5)) / n, cy = Math.cos(a); return [rx * Math.sin(a), cy >= 0 ? top * cy : bot * cy, z]; }));
      const col = (k) => (Math.cos((2 * Math.PI * (k + 1)) / n) >= -0.01 ? 'h' : 'd'); // the upper faces are the light ones
      for (let k = 0; k < n; k++) poly(col(k), [0, 0, nose], R[0][k], R[0][(k + 1) % n]);
      for (let r = 0; r + 1 < R.length; r++) for (let k = 0; k < n; k++) poly(col(k), R[r][k], R[r + 1][k], R[r + 1][(k + 1) % n], R[r][(k + 1) % n]);
      poly(cap, ...R[R.length - 1]);
    };
    build({ poly, sym, hull, on });
    return { V, F };
  };
  const canopy = (m, zf, zb, y, hgt, wd) => { const top = [0, y + hgt, (zf + zb) / 2 - 2], l = [-wd, y + hgt * 0.55, zb], r = [wd, y + hgt * 0.55, zb]; m.poly('g', [0, y, zf], l, top); m.poly('g', [0, y, zf], top, r); m.poly('g', l, r, top); };
  const SHIPS = { // tip: where the lasers leave (right wing; the left one is mirrored) · tail: where the engine flame is
    dardo: { name: 'Dardo', tip: [52, -4, -20], tail: -46, mesh: meshOf((m) => { m.hull(64, [[40, 4, 4, 3], [14, 9, 9, 6], [-18, 9, 8.5, 6], [-42, 6.5, 6.5, 4.5]]); canopy(m, 40, 12, 5.5, 8, 4.5);
      m.sym('s', [9, 0, 12], [52, -4, -22], [52, -4, -34], [7, 0, -38]); m.sym('w', [52, -4, -20], [52, -4, -36], [57, 10, -40]); m.sym('s', [5, 6, -20], [5, 6, -40], [15, 24, -46]); m.sym('w', [7, 2, 38], [22, 1, 28], [7, 2, 26]); }) },
    delta: { name: 'Delta', tip: [60, -2, -40], tail: -42, mesh: meshOf((m) => { m.hull(54, [[30, 5, 5, 3], [0, 10, 9, 5], [-38, 8, 7, 4]]); canopy(m, 32, 6, 6, 8, 5);
      m.sym('s', [6, 1, 34], [60, -2, -40], [34, 0, -46], [8, 0, -40]); m.sym('w', [60, -2, -40], [66, 6, -50], [46, -1, -44]); m.poly('s', [0, 7, -10], [0, 7, -40], [0, 28, -50]); }) },
    halcon: { name: 'Halcón', tip: [48, 2, 10], tail: -50, mesh: meshOf((m) => { m.hull(60, [[34, 4.5, 4.5, 3.5], [4, 9, 9, 6], [-28, 9, 8, 6], [-46, 6, 6, 4]]); canopy(m, 36, 10, 5.5, 8, 4.5);
      m.sym('s', [8, 0, -34], [48, 2, 10], [44, 2, -6], [8, 0, -10]); m.sym('w', [48, 2, 10], [53, 3, 18], [44, 2, -6]); m.sym('s', [6, 5, -28], [6, 5, -46], [22, 20, -54]); m.sym('d', [10, -3, -18], [18, -3, -18], [18, -3, -50], [10, -3, -50]); }) },
    cometa: { name: 'Cometa', tip: [40, 22, -44], tail: -48, mesh: meshOf((m) => { m.hull(72, [[44, 3.5, 3.5, 3.5], [6, 7, 7, 7], [-44, 6, 6, 6]]); canopy(m, 40, 16, 4.5, 7, 4);
      m.sym('s', [6, 3, -8], [40, 22, -44], [36, 20, -54], [6, 3, -40]); m.sym('s', [6, -3, -8], [40, -22, -44], [36, -20, -54], [6, -3, -40]); m.sym('w', [5, 1, 30], [18, 0, 20], [5, 1, 16]); }) },
    // Three more silhouettes of our own, after the classic shapes of space fighters: a long wedge, a pod between two forward blades with end plates, and a flying wing.
    flecha: { name: 'Flecha', tip: [48, -1, -34], tail: -46, mesh: meshOf((m) => { m.hull(70, [[40, 4, 3.5, 2.5], [6, 8, 7, 4], [-30, 9, 7.5, 4.5], [-44, 7, 6, 4]]); canopy(m, 16, -10, 6, 7, 4.5);
      m.sym('s', [4, 1.5, 58], [50, -1, -34], [44, -1, -46], [7, 1, -44]); m.sym('w', [50, -1, -34], [44, -1, -46], [52, 9, -50]); m.sym('d', [14, -2.5, -10], [22, -2.5, -10], [22, -2.5, -48], [14, -2.5, -48]); }) },
    tridente: { name: 'Tridente', tip: [44, 0, 52], tail: -40, mesh: meshOf((m) => { m.hull(30, [[18, 7, 7, 6], [-6, 10, 10, 8], [-30, 9, 9, 7], [-40, 6, 6, 5]]); canopy(m, 22, -2, 7, 7, 5);
      m.sym('s', [9, 0, 10], [44, 0, 4], [44, 0, -28], [9, 0, -22]); m.sym('h', [40, 1.5, 4], [48, 1.5, 4], [46, 1.5, 52], [42, 1.5, 52]); m.sym('d', [40, -1.5, 4], [48, -1.5, 4], [46, -1.5, 52], [42, -1.5, 52]); m.sym('w', [48, -12, 2], [48, 12, 2], [48, 7, -30], [48, -7, -30]); }) },
    manta: { name: 'Manta', tip: [58, 3, -8], tail: -38, mesh: meshOf((m) => { m.hull(40, [[22, 6, 5, 3], [-8, 11, 7, 4], [-36, 8, 5, 3]]); canopy(m, 26, 2, 4.5, 6.5, 5);
      m.sym('s', [8, 5, 26], [40, -1, 2], [58, -7, -30], [9, 5, -34]); m.sym('w', [40, -1, 2], [60, -4, 8], [58, -7, -30]); m.sym('s', [10, 6, -18], [10, 6, -36], [19, 22, -44]); }) },
  };
  const shipModel = (id) => SHIPS[id] || SHIPS[localStorage.getItem('oge.shipModel')] || SHIPS.dardo;
  const mixHex = (a, b, k) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - k) + parseInt(b.slice(i, i + 2), 16) * k).toString(16).padStart(2, '0')).join('');
  const hex = (c, d) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : d), hull1 = () => hex(localStorage.getItem('oge.hull1'), '#ff7300'); // the pilot's hull: orange unless chosen
  const shipCol = (sk, hl) => { const h = hex(hl, '#c9cfd8'); return { h, d: mixHex(h, '#10141c', 0.5), s: mixHex(hex(sk, '#3fa9ff'), '#565d6a', 0.3), w: '#c2901c', g: '#1b3a57', e: '#ffb300' }; }; // painted metal: the wing colour, a little worn, and the hull colour with its shaded side
  const insignia = (M, onHull) => { // where an air force paints its roundel: on top of each wing and on each side of the fuselage. These 'i' faces are drawn only when the pilot wears an image
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], unit = (a) => { const l = Math.hypot(...a) || 1; return a.map((x) => x / l); };
    const quads = M.F.map(([idx, c], fi) => { if (idx.length !== 4) return null; const P = idx.map((k) => M.V[k]), nn = cross(sub(P[1], P[0]), sub(P[2], P[0])); return { fi, c, P, n: unit(nn), area: Math.hypot(...nn), mid: [0, 1, 2].map((k) => (P[0][k] + P[1][k] + P[2][k] + P[3][k]) / 4) }; }).filter(Boolean);
    const put = (q, n, up, k, len = 1, c = 'i', side = Math.sign(q.mid[0]), wid = 1) => { // c: 'i' insignia, 'j' tail flag; side: -1 left, 1 right; wid: wider than tall (a flag) // len: stretched along its top-to-bottom axis, for a face seen almost edge-on // a square lying on face q, its top towards up, read the right way round from the side n points to; k times the room to the nearest edge
      const a = unit(sub(up, n.map((x) => x * dot(n, up)))), b = cross(n, a);
      const r = k * Math.min(...q.P.map((p, j) => { const e = unit(sub(q.P[(j + 1) % q.P.length], p)), d = sub(q.mid, p); return Math.hypot(...sub(d, e.map((x) => x * dot(d, e)))); }));
      const at = (ka, kb) => q.mid.map((x, j) => x + (a[j] * ka * len + b[j] * kb * wid) * r);
      M.F.push([[at(1, -1), at(1, 1), at(-1, 1), at(-1, -1)].map((p) => M.V.push(p) - 1), c, q.fi, side]); // top left, top right, bottom right, bottom left
    };
    // The tail flag ('j' faces): on each fin, that is, the biggest wing or accent plate standing more upright than flat on that side; a single middle fin carries one on each face; a ship without fins wears it on the sides of the hull.
    const plates = M.F.map(([idx, c], fi) => { const P = idx.map((k) => M.V[k]), nn = cross(sub(P[1], P[0]), sub(P[2], P[0])); return { fi, c, P, n: unit(nn), area: Math.hypot(...nn) / (P.length === 3 ? 2 : 1), mid: [0, 1, 2].map((k) => P.reduce((s, p) => s + p[k], 0) / P.length) }; }).filter((q) => q.P.length <= 4 && 'sw'.includes(q.c) && Math.abs(q.n[0]) > 0.5).sort((x, y) => y.area - x.area);
    for (const e of [-1, 1]) { const fin = plates.find((q) => q.mid[0] * e > 1) || plates.find((q) => Math.abs(q.mid[0]) <= 1), side = fin || quads.filter((q) => 'hd'.includes(q.c) && Math.abs(q.n[0]) > 0.9 && q.mid[0] * e > 0).sort((x, y) => y.area - x.area)[0]; if (side) put(side, fin && Math.abs(fin.mid[0]) > 1 ? (fin.n[0] * e < 0 ? fin.n.map((x) => -x) : fin.n) : [e, 0, 0], [0, 1, 0], fin ? 0.55 : 1.1, 1, 'j', e, 1.5); } // lying on the fin itself, facing outwards
    if (onHull) { for (const e of [-1, 1]) { const q = quads.filter((q) => q.c === 'h' && q.mid[0] * e > 0 && Math.abs(q.n[1]) > 0.3 && Math.abs(q.n[0]) > 0.3).sort((x, y) => y.area - x.area)[0]; if (q) put(q, q.n[1] < 0 ? q.n.map((x) => -x) : q.n, [0, 0, 1], 1.6, 2.7); } return; } // the biggest plate on each upper side of the hull: a little proud of it and longer towards the nose, because the camera sees that plate almost edge-on
    for (const q of quads.filter((q) => q.c === 's').slice(0, 2)) put(q, q.n[1] < 0 ? q.n.map((x) => -x) : q.n, [0, 0, 1], 0.62); // the wings: the first mirrored pair, the image's top towards the nose
    for (const e of [-1, 1]) { const q = quads.filter((q) => 'hd'.includes(q.c) && Math.abs(q.n[0]) > 0.9 && q.mid[0] * e > 0).sort((x, y) => y.area - x.area)[0]; if (q) put(q, [e, 0, 0], [0, 1, 0], 1.6); } // the biggest plate on each side of the hull (the square stands a little proud of it)
  };
  for (const k in SHIPS) insignia(SHIPS[k].mesh, k === 'halcon');
  const worn = {}; // the images the pilot wears, by the localStorage key that names each; only from Wikimedia
  const wornImg = (key) => { const u = localStorage.getItem(key) || ''; if (!worn[key] || worn[key].u !== u) worn[key] = { u, im: /^https:\/\/[a-z]+\.wikimedia\.org\//.test(u) ? Object.assign(new Image(), { src: u }) : null }; return worn[key].im; };
  const wornCol = () => ({ i: wornImg('oge.insignia'), iR: wornImg('oge.insigniaR'), j: wornImg('oge.finFlag'), jR: wornImg('oge.finFlagR') }); // the insignia and the tail flag; iR and jR: the right side's own, when it differs

  async function roundel(q) { // Wikidata, searched as the Making History editor does: the air forces (P31) of the country (P17) that have a logo (P154), the roundel their aircraft wear; the best known one still in service wins
    if (!/^Q\d+$/.test(q || '')) return null;
    const api = (p) => fetch('https://www.wikidata.org/w/api.php?format=json&origin=*&' + new URLSearchParams(p)).then((r) => r.json());
    const ids = ((await api({ action: 'query', list: 'search', srlimit: 20, srsearch: `haswbstatement:P17=${q} haswbstatement:P31=Q61883|P31=Q133505337 haswbstatement:P154` })).query.search || []).map((x) => x.title).filter((id) => /^Q\d+$/.test(id)); // air force, aerospace force
    if (!ids.length) return null;
    const file = (e) => { const v = ((e.claims || {}).P154 || [])[0]; return v && v.mainsnak.datavalue && v.mainsnak.datavalue.value; }, links = (e) => Object.keys(e.sitelinks || {}).length;
    const best = Object.values((await api({ action: 'wbgetentities', ids: ids.join('|'), props: 'claims|sitelinks' })).entities || {}).filter(file).sort((a, b) => !!a.claims.P576 - !!b.claims.P576 || links(b) - links(a))[0];
    return best ? 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(file(best).replace(/ /g, '_')) + '?width=250' : null;
  }
  const FOES = [ // three enemy craft of our own, drawn nose-on to the player
    { col: { h: '#e2574c', d: '#7a1f1f', s: '#ff8a65', w: '#ffd60a', g: '#1c2a44', e: '#ffb300' }, mesh: meshOf((m) => { m.hull(40, [[12, 9, 8, 6], [-22, 7, 6, 5]], 6); canopy(m, 26, 6, 6, 6, 4);
      m.sym('s', [8, 0, 10], [46, -12, -16], [40, -12, -26], [6, 0, -18]); m.sym('w', [46, -12, -16], [50, -2, -24], [40, -12, -26]); }) },
    { col: { h: '#8fdcf0', d: '#2a6f86', s: '#c8f3ff', w: '#ff5ad1', g: '#0b2a3a', e: '#e9fbff' }, mesh: meshOf((m) => { const N = [0, 4, 30], Tp = [0, 12, -6], B = [0, -8, -4], K = [0, 4, -34];
      m.sym('h', N, [44, 0, 0], Tp); m.sym('h', [44, 0, 0], K, Tp); m.sym('d', N, B, [44, 0, 0]); m.sym('d', [44, 0, 0], B, K); m.poly('g', [0, 12.6, -6], [-8, 9.5, 8], [0, 7.4, 20], [8, 9.5, 8]); m.sym('w', [44, 0, 0], [52, 8, -10], [40, 1, -10]); }) },
    { col: { h: '#b99cff', d: '#4a2a86', s: '#e3d2ff', w: '#39ff14', g: '#1a0f33', e: '#ff5ad1' }, mesh: meshOf((m) => { m.hull(30, [[8, 10, 10, 10], [-18, 10, 10, 10]], 6);
      for (const a of [90, 210, 330]) { const c = Math.cos(rad(a)), sn = Math.sin(rad(a)), px = -sn, py = c; m.poly('s', [c * 9 + px * 5, sn * 9 + py * 5, 4], [c * 46, sn * 46, -12], [c * 9 - px * 5, sn * 9 - py * 5, 4]); m.poly('w', [c * 46, sn * 46, -12], [c * 52 + px * 4, sn * 52 + py * 4, 6], [c * 52 - px * 4, sn * 52 - py * 4, 6]); } }) },
  ];
  const GEM = meshOf((m) => { // the shield pickup: a cut hexagonal gem
    const P = (r, z) => Array.from({ length: 6 }, (_, k) => [r * Math.sin((k * Math.PI) / 3), r * Math.cos((k * Math.PI) / 3), z]), o = P(40, 0), i = P(22, 12);
    m.poly('g', ...i); for (let k = 0; k < 6; k++) { m.poly(k % 2 ? 'h' : 's', o[k], o[(k + 1) % 6], i[(k + 1) % 6], i[k]); m.poly('d', [0, 0, -16], o[(k + 1) % 6], o[k]); } });
  const lathe = (m, prof, n = 8, cols = 'hs', cx = 0, cz = 0) => { // a solid turned about a vertical axis: prof is [[y, radius, colours of the band below], ...] from the top down
    const R = prof.map(([y, r]) => Array.from({ length: n }, (_, k) => [cx + r * Math.sin((2 * Math.PI * (k + 0.5)) / n), y, cz + r * Math.cos((2 * Math.PI * (k + 0.5)) / n)]));
    for (let i = 0; i + 1 < R.length; i++) { const cc = prof[i][2] || cols; for (let k = 0; k < n; k++) m.poly(cc[k % cc.length], R[i][k], R[i + 1][k], R[i + 1][(k + 1) % n], R[i][(k + 1) % n]); }
    m.poly((prof[0][2] || cols)[0], ...R[0]); m.poly((prof[prof.length - 1][2] || cols)[0], ...R[R.length - 1]);
  };
  const ballAt = (m, cx, cy, cz, r, cols) => lathe(m, [[cy + r, 1], [cy + r * 0.5, r * 0.87], [cy - r * 0.5, r * 0.87], [cy - r, 1]], 6, cols, cx, cz);
  const boxM = (m, x0, y0, z0, x1, y1, z1, c = 'hsd') => { // a box: c is the colour of its front and top, of its sides, and of its back and bottom
    m.poly(c[0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); m.poly(c[2], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]); m.poly(c[1], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
    m.poly(c[1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]); m.poly(c[0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]); m.poly(c[2], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  };
  const WARSHIP = meshOf((m) => { m.hull(62, [[34, 9, 7, 6], [-40, 12, 7, 6], [-58, 9, 7, 5]], 6, 'e'); // the hull, bow forward
    boxM(m, -6, 7, -26, 6, 19, 4); boxM(m, -3, 19, -18, 3, 28, -10, 'ddd'); boxM(m, -0.8, 19, -4, 0.8, 38, -2, 'ddd'); // the bridge, the funnel, the mast
    boxM(m, -4, 7, 16, 4, 11, 27, 'sdd'); boxM(m, -1, 8.5, 27, 1, 10.5, 46, 'ddd'); boxM(m, -4, 7, -46, 4, 11, -36, 'sdd'); boxM(m, -1, 8.5, -58, 1, 10.5, -46, 'ddd'); }); // a turret and its gun, fore and aft
  const HEART = meshOf((m) => { // a thick heart; the cross on it is only painted white on the life booster
    const pts = (z) => Array.from({ length: 18 }, (_, k) => { const t = (2 * Math.PI * k) / 18; return [2.3 * 16 * Math.sin(t) ** 3, 2.3 * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) + 6, z]; }), f = pts(9), b = pts(-9);
    for (let k = 0; k < 18; k++) m.poly('s', f[k], f[(k + 1) % 18], b[(k + 1) % 18], b[k]);
    for (const [face, z] of [[m.poly('h', ...f), 9.6], [m.poly('d', ...b), -9.6]]) { m.on(face, 'x', [-16, 3, z], [16, 3, z], [16, 11, z], [-16, 11, z]); m.on(face, 'x', [-4, -9, z], [4, -9, z], [4, 23, z], [-4, 23, z]); } });
  const AIRLINER = meshOf((m) => { m.hull(60, [[46, 5, 5, 5], [-38, 5, 5, 5], [-58, 2, 4, 0]], 8, 'd'); // fuselage, nose forward
    m.sym('s', [5, -2, 14], [60, 1, -16], [60, 1, -24], [5, -2, -10]); m.sym('s', [3, 2, -42], [22, 3, -56], [22, 3, -61], [3, 2, -54]); m.poly('w', [0, 5, -38], [0, 24, -61], [0, 5, -57]); // wings, tailplane, fin
    for (const e of [-1, 1]) boxM(m, e * 22 - 3, -7, -8, e * 22 + 3, -2, 8, 'ddd'); }); // an engine under each wing
  const AAGUN = meshOf((m) => { lathe(m, [[8, 22], [0, 27], [-10, 30]], 8, 'sd'); lathe(m, [[22, 6], [15, 15], [8, 17]], 8, 'hs'); // the base and the turret
    for (const e of [-1, 1]) { m.poly('d', [e * 5 - 1.6, 15, 4], [e * 5 + 1.6, 15, 4], [e * 5 + 1.6, 46, 36], [e * 5 - 1.6, 46, 36]); m.poly('d', [e * 5, 13.4, 5.6], [e * 5, 16.6, 2.4], [e * 5, 47.6, 34.4], [e * 5, 44.4, 37.6]); } }); // twin barrels raised at the ship
  const MINE = meshOf((m) => { ballAt(m, 0, 0, 0, 22, 'hs');
    for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) { const u = [y, z, x], v = [z, x, y], P = (k, a, c) => [x * k + u[0] * a + v[0] * c, y * k + u[1] * a + v[1] * c, z * k + u[2] * a + v[2] * c]; m.poly('w', P(19, -5, 0), P(36, 0, 0), P(19, 5, 0)); m.poly('w', P(19, 0, -5), P(36, 0, 0), P(19, 0, 5)); } // a spike on each side
    m.poly('e', [-4, -4, 20.5], [4, -4, 20.5], [4, 4, 20.5], [-4, 4, 20.5]); }); // its warning light
  const octoMesh = (t, spit) => meshOf((m) => { // a round head over six waving arms; its mouth opens when it spits
    ballAt(m, 0, 14, 0, 24, 'hs');
    for (let k = 0; k < 6; k++) { const a = (k * Math.PI) / 3 + 0.3, c = Math.cos(a), sn = Math.sin(a), w = Math.sin(t * 3 + k * 1.3) * 5, at = (r, y, half) => [[c * r - sn * half, y, sn * r + c * half], [c * r + sn * half, y, sn * r - c * half]];
      const [a0, a1] = at(12, -4, 5), [b0, b1] = at(24 + w * 0.4, -20, 3.5), tip = [c * (32 + w), -34 + Math.abs(w) * 0.5, sn * (32 + w)]; m.poly('s', a0, a1, b1, b0); m.poly('d', b0, b1, tip); }
    for (const e of [-1, 1]) { m.poly('e', [e * 9 - 5, 14, 22.5], [e * 9 + 5, 14, 22.5], [e * 9 + 5, 24, 22.5], [e * 9 - 5, 24, 22.5]); m.poly('m', [e * 9 - 2, 16, 23.2], [e * 9 + 2, 16, 23.2], [e * 9 + 2, 21, 23.2], [e * 9 - 2, 21, 23.2]); } // eyes
    const o = spit ? 5 : 2; m.poly('k', [-5, 6 - o, 22.6], [5, 6 - o, 22.6], [5, 6 + o, 22.6], [-5, 6 + o, 22.6]); });
  const BOMB = meshOf((m) => { lathe(m, [[30, 5], [24, 19], [9, 30], [-9, 30], [-24, 19], [-30, 5]], 8, 'hs'); lathe(m, [[40, 7, 'w'], [29, 7, 'w']], 6, 'w'); m.poly('e', [-3, 40, 0], [3, 40, 0], [7, 51, 0], [0, 46, 0], [-7, 51, 0]); }); // the bomb pickup: a ball, its neck and a spark
  const HIVE = meshOf((m) => { // seven hexagonal cells; the middle one is the core
    const hex = (cx, cy, r, z) => Array.from({ length: 6 }, (_, j) => [cx + r * Math.cos((j * Math.PI) / 3 + Math.PI / 6), cy + r * Math.sin((j * Math.PI) / 3 + Math.PI / 6), z]);
    for (let i = 0; i < 7; i++) { const a = (i * Math.PI) / 3, cx = i ? 36 * Math.cos(a) : 0, cy = i ? 36 * Math.sin(a) : 0, zf = i ? 10 : 14, f = hex(cx, cy, 20, zf), b = hex(cx, cy, 20, -10);
      m.poly('d', ...b); for (let j = 0; j < 6; j++) m.poly('s', f[j], f[(j + 1) % 6], b[(j + 1) % 6], b[j]); m.on(m.poly('h', ...f), i ? 'd' : 'm', ...hex(cx, cy, 13, zf + 0.6)); } });
  const BEACON = meshOf((m) => lathe(m, [[72, 2, 'd'], [60, 15, 'e'], [44, 15, 'd'], [40, 20, 'd'], [36, 12, 'hs'], [10, 14, 'w'], [0, 15, 'hs'], [-25, 17, 'w'], [-35, 18, 'hs'], [-60, 22, 'd'], [-66, 27, 'd']], 8)); // roof, lamp, gallery, banded tower, base
  const SAUCER = meshOf((m) => lathe(m, [[26, 3, 'g'], [20, 16, 'g'], [8, 24, 'hs'], [2, 62, 'sd'], [-5, 62, 'd'], [-12, 34, 'e'], [-16, 30, 'd'], [-22, 10, 'd']], 10)); // dome, hull, rim, a glowing band underneath
  const STATION = meshOf((m) => { lathe(m, [[20, 2], [10, 18], [-10, 18], [-20, 2]], 8, 'hs'); // the core module
    boxM(m, -62, -4, -4, -18, 4, 4, 'sdd'); boxM(m, 18, -4, -4, 62, 4, 4, 'sdd'); boxM(m, -4, 18, -4, 4, 54, 4, 'sdd'); boxM(m, -4, -54, -4, 4, -18, 4, 'sdd'); // four arms
    for (const e of [-1, 1]) for (let i = 0; i < 3; i++) for (const v of [-1, 1]) m.poly((i + (v > 0 ? 1 : 0)) % 2 ? 'w' : 'p', [e * (26 + i * 12), v * 6, 0], [e * (38 + i * 12), v * 6, 0], [e * (38 + i * 12), v * 30, 0], [e * (26 + i * 12), v * 30, 0]); // solar wings
    m.poly('m', [0, 9, 18.5], [8, 0, 18.5], [0, -9, 18.5], [-8, 0, 18.5]); }); // its eye: red while the shield is open
  const dreadMesh = (gap) => meshOf((m) => { // an armoured warship, bow on: the doors on its bow slide apart to show the reactor
    m.hull(46, [[40, 26, 18, 16], [0, 34, 22, 18], [-45, 30, 20, 16], [-70, 20, 12, 10]], 8, 'e');
    boxM(m, -9, 20, -30, 9, 40, -4); boxM(m, -5, 40, -24, 5, 48, -12, 'sdd'); // the bridge tower
    for (const e of [-1, 1]) { boxM(m, e * 34 - 6, -4, -10, e * 34 + 6, 4, 34, 'sdd'); boxM(m, e * 34 - 2.5, -2, 34, e * 34 + 2.5, 2, 52, 'ddd'); } // the side guns
    m.poly('m', ...Array.from({ length: 6 }, (_, k) => [10 * Math.cos((k * Math.PI) / 3), 10 * Math.sin((k * Math.PI) / 3), 46.5])); // the reactor
    for (const e of [-1, 1]) m.poly('w', [e * gap * 13, -11, 47.5], [e * (13 + gap * 13), -11, 47.5], [e * (13 + gap * 13), 11, 47.5], [e * gap * 13, 11, 47.5]); // the doors
    [-1, 0, 1].forEach((x, n) => m.poly('abc'[n], [x * 5 - 1.8, 43, -11.5], [x * 5 + 1.8, 43, -11.5], [x * 5 + 1.8, 46, -11.5], [x * 5 - 1.8, 46, -11.5])); // a light for each phase it has left
  });
  const golemMesh = (t) => meshOf((m) => { const sw = Math.sin(t * 2) * 6; // a stone giant: its arms swing as it hovers
    boxM(m, -24, -20, -12, 24, 26, 12); boxM(m, -13, 28, -10, 13, 50, 10); // torso and head
    boxM(m, -44, -14 + sw, -9, -27, 24 + sw, 9, 'sdd'); boxM(m, 27, -14 - sw, -9, 44, 24 - sw, 9, 'sdd'); boxM(m, -47, -34 + sw, -11, -26, -16 + sw, 11); boxM(m, 26, -34 - sw, -11, 47, -16 - sw, 11); // arms and fists
    boxM(m, -20, -52, -9, -4, -22, 9, 'sdd'); boxM(m, 4, -52, -9, 20, -22, 9, 'sdd'); // legs
    for (const e of [-1, 1]) m.poly('e', [e * 8 - 3, 38, 10.6], [e * 8 + 3, 38, 10.6], [e * 8 + 3, 43, 10.6], [e * 8 - 3, 43, 10.6]); // eyes
    m.poly('e', [0, 14, 12.6], [9, 4, 12.6], [0, -6, 12.6], [-9, 4, 12.6]); }); // the core in its chest
  const snakeMesh = (t) => meshOf((m) => { // a chain of balls weaving behind the head
    for (let i = 9; i >= 0; i--) { const cx = -45 + i * 13, cy = Math.sin(t * 4 + i * 0.7) * 14, cz = Math.cos(t * 4 + i * 0.7) * 8, r = 13 - i * 0.7;
      ballAt(m, cx, cy, cz, r, i % 2 ? 'sd' : 'hs');
      if (!i) { m.poly('e', [cx - 7, cy + 2, cz + r * 0.95], [cx - 2, cy + 2, cz + r * 0.95], [cx - 2, cy + 7, cz + r * 0.95], [cx - 7, cy + 7, cz + r * 0.95]); m.poly('w', [cx - r, cy + 1, cz], [cx - r - 13, cy + 3 + Math.sin(t * 12) * 3, cz], [cx - r - 13, cy - 3 + Math.sin(t * 12) * 3, cz]); } } }); // its eye and its flicking tongue
  const dragonMesh = (t, fire) => meshOf((m) => { // an eastern dragon: a long weaving body with a crest of spines, clawed legs, horns and a flame on its tail
    const N = 12, at = (i) => [-52 + i * 10, Math.sin(t * 3 + i * 0.6) * 16, Math.cos(t * 3 + i * 0.6) * 10], drop = fire ? 6 : 0;
    for (let i = N - 1; i >= 0; i--) { const [cx, cy, cz] = at(i), r = i ? 10 - i * 0.45 : 14;
      ballAt(m, cx, cy, cz, r, i % 2 ? 'sd' : 'hs');
      if (i) m.poly('w', [cx - 4, cy + r - 1, cz], [cx + 1, cy + r + 9, cz], [cx + 5, cy + r - 1, cz]);
      if (i === 3 || i === 8) for (const e of [-1, 1]) m.poly('d', [cx - 3, cy - r + 2, cz + e * 4], [cx + 3, cy - r + 2, cz + e * 4], [cx - 2, cy - r - 10, cz + e * 9]); }
    const [hx, hy, hz] = at(0), [tx, ty, tz] = at(N - 1);
    m.poly('h', [hx - 10, hy + 6, hz + 6], [hx - 30, hy + 2, hz + 3], [hx - 30, hy + 2, hz - 3], [hx - 10, hy + 6, hz - 6]); m.poly('s', [hx - 10, hy + 6, hz + 6], [hx - 30, hy + 2, hz + 3], [hx - 28, hy - 3, hz + 3], [hx - 10, hy - 4, hz + 6]); // the snout
    m.poly('d', [hx - 10, hy - 6 - drop, hz + 5], [hx - 27, hy - 5 - drop * 1.3, hz + 2], [hx - 27, hy - 5 - drop * 1.3, hz - 2], [hx - 10, hy - 6 - drop, hz - 5]); // the jaw, dropping when it spits
    for (const e of [-1, 1]) m.poly('w', [hx + 2, hy + 11, hz + e * 5], [hx + 16, hy + 26, hz + e * 9], [hx + 8, hy + 10, hz + e * 5]); // horns
    m.poly('e', [hx - 9, hy + 5, hz + 12.6], [hx - 3, hy + 6, hz + 12.6], [hx - 5, hy + 1, hz + 12.6]); // the eye
    m.poly('e', [tx + 3, ty + 5, tz], [tx + 22, ty + Math.sin(t * 14) * 5, tz], [tx + 3, ty - 5, tz]); // the flame on its tail
    if (fire) m.poly('e', [hx - 30, hy + 1, hz], [hx - 54, hy + 7, hz], [hx - 50, hy - 9, hz]); // its breath
  });
  const COIN = meshOf((m) => { const n = 14, t = 5, P = (z) => Array.from({ length: n }, (_, k) => [40 * Math.sin((2 * Math.PI * k) / n), 40 * Math.cos((2 * Math.PI * k) / n), z]), f = P(t), b = P(-t);
    m.poly('h', ...f); m.poly('h', ...b); for (let k = 0; k < n; k++) m.poly('d', f[k], f[(k + 1) % n], b[(k + 1) % n], b[k]); // two faces and the edge
    for (const z of [t + 1.2, -t - 1.2]) m.poly('w', ...Array.from({ length: 10 }, (_, k) => { const r = k % 2 ? 11 : 27, a = (Math.PI * k) / 5; return [r * Math.sin(a), r * Math.cos(a), z]; })); }); // the star stamped on each
  const ASTEROID = meshOf((m) => { lathe(m, [[30, 1], [21, 22], [6, 31], [-9, 25], [-22, 18], [-30, 1]], 7, 'hs'); ballAt(m, 17, 9, 12, 14, 'sd'); ballAt(m, -15, -9, -11, 12, 'sd'); ballAt(m, -6, 16, -15, 10, 'hd'); }); // a lumpy rock
  const CRATE = meshOf((m) => { const a = 32; // the obstacle: a steel box; each side has a sunken panel, a frame, rivets and a brace or warning stripes
    for (const [ax, sg] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]]) {
      const pt = (u, v, w) => { const p = [0, 0, 0]; p[ax] = w * sg; p[(ax + 1) % 3] = u; p[(ax + 2) % 3] = v; return p; }, f = m.poly(ax === 1 ? (sg > 0 ? 'h' : 'd') : 's', pt(-a, -a, a), pt(a, -a, a), pt(a, a, a), pt(-a, a, a));
      const rect = (c, u0, v0, u1, v1, w) => m.on(f, c, pt(u0, v0, w), pt(u1, v0, w), pt(u1, v1, w), pt(u0, v1, w));
      rect('w', -26, -26, 26, 26, 31.5);
      if (ax === 0) for (let k = 0; k < 6; k++) { const u = -26 + k * 8.67; m.on(f, k % 2 ? 'k' : 'y', pt(u, -5, 31.8), pt(u + 8.67, -5, 31.8), pt(u + 12.67, 5, 31.8), pt(u + 4, 5, 31.8)); }
      else m.on(f, 'd', pt(-26, -21, 32), pt(-21, -26, 32), pt(26, 21, 32), pt(21, 26, 32));
      for (const [u0, v0, u1, v1] of [[-32, 26, 32, 32], [-32, -32, 32, -26], [-32, -26, -26, 26], [26, -26, 32, 26]]) rect('f', u0, v0, u1, v1, 33);
      for (const u of [-29, 29]) for (const v of [-29, 0, 29]) rect('r', u - 1.6, v - 1.6, u + 1.6, v + 1.6, 33.6);
    } });
  const SAT = meshOf((m) => { m.hull(12, [[8, 7, 7, 7], [-10, 7, 7, 7]], 6, 'd'); // the bus
    for (let i = 0; i < 3; i++) m.sym(i % 2 ? 'w' : 's', [10 + i * 11, -7, 0], [21 + i * 11, -7, 0], [21 + i * 11, 7, 0], [10 + i * 11, 7, 0]); // the solar wings, cell by cell
    m.sym('d', [6, -1, 0], [10, -1, 0], [10, 1, 0], [6, 1, 0]); // their booms
    for (let k = 0; k < 6; k++) { const a0 = (k * Math.PI) / 3, a1 = ((k + 1) * Math.PI) / 3; m.poly('h', [0, 9, 0], [7 * Math.cos(a0), 14, 7 * Math.sin(a0)], [7 * Math.cos(a1), 14, 7 * Math.sin(a1)]); } }); // the dish
  const handMesh = (close, side = 1) => meshOf((m) => { // a blocky hand of our own, palm towards the ship; its fingers curl as it closes
    const box = (x0, y0, z0, x1, y1, z1, f = (p) => p) => { const P = (x, y, z) => f([x * side, y, z]);
      m.poly('h', P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)); m.poly('d', P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0), P(x1, y0, z0)); m.poly('s', P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0));
      m.poly('s', P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1)); m.poly('h', P(x0, y1, z0), P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0)); m.poly('d', P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1)); };
    const bend = (py, a) => ([x, y, z]) => [x, py + (y - py) * Math.cos(a) - z * Math.sin(a), (y - py) * Math.sin(a) + z * Math.cos(a)]; // turns about a knuckle, towards the ship
    box(-22, -34, -7, 22, 8, 7); // the palm
    for (let i = 0; i < 4; i++) { const x = -21 + i * 11, len = i === 1 || i === 2 ? 22 : 18, k1 = bend(8, close * 1.1), k2 = (p) => k1(bend(8 + len, close * 1.3)(p)); box(x, 8, -5, x + 9, 8 + len, 5, k1); box(x + 0.5, 8 + len, -4.5, x + 8.5, 8 + len * 1.9, 4.5, k2); }
    const th = ([x, y, z]) => { const a = 0.9 - close * 0.7, dx = x - 22, dy = y + 22; return [22 + dx * Math.cos(a) + dy * Math.sin(a), -22 - dx * Math.sin(a) + dy * Math.cos(a), z + close * 6]; }; box(22, -27, -5, 32, 2, 5, th); // the thumb
  });
  const BOSS3D = {
    fortress: { col: { h: '#c3c9da', d: '#5d6480', s: '#8a5ad6', w: '#ff2df5', g: '#1c2a44', e: '#ff2df5' }, mesh: meshOf((m) => { m.hull(34, [[14, 30, 30, 30], [-24, 40, 40, 40]], 8, 'd');
      m.poly('e', [0, 9, 35], [8, 4.5, 33], [8, -4.5, 33], [0, -9, 35], [-8, -4.5, 33], [-8, 4.5, 33]); m.sym('s', [30, 6, -4], [62, 10, -16], [62, -10, -16], [30, -6, -4]); m.sym('w', [62, 10, -16], [72, 0, -8], [62, -10, -16]);
      for (const e of [1, -1]) { m.poly('s', [6, 30 * e, -4], [10, 62 * e, -16], [-10, 62 * e, -16], [-6, 30 * e, -4]); m.poly('w', [10, 62 * e, -16], [0, 72 * e, -8], [-10, 62 * e, -16]); } }) },
    crystal: { col: { h: '#f0fcff', d: '#3f8fb8', s: '#9fe8ff', w: '#ffffff', g: '#9fe8ff', e: '#ff2d55' }, mesh: meshOf((m) => { const ring = Array.from({ length: 6 }, (_, k) => [36 * Math.cos((k * Math.PI) / 3), 0, 36 * Math.sin((k * Math.PI) / 3)]);
      for (let k = 0; k < 6; k++) { m.poly(k % 2 ? 'h' : 's', [0, 60, 0], ring[k], ring[(k + 1) % 6]); m.poly(k % 2 ? 'd' : 's', [0, -60, 0], ring[(k + 1) % 6], ring[k]); } }) },
  };
  const faceMesh = (open) => meshOf((m) => { // a faceted stone mask of our own; the jaw drops as it opens
    const T0 = [0, 62, -4], FH = [0, 40, 10], NB = [0, 22, 16], NT = [0, -6, 30], UL = [0, -20, 14], LL = [0, -34 - open * 14, 12], CH = [0, -62 - open * 10, 0];
    const TR = [28, 50, -10], SR = [42, 18, -14], CR = [38, -14, -10], JR = [24, -44 - open * 6, -8], BR = [22, 26, 8], NR = [9, -10, 14], EI = [7, 18, 12], EO = [30, 22, 2], EL = [18, 8, 8], MR = [16, -26, 10];
    m.sym('h', T0, FH, TR); m.sym('s', TR, FH, BR); m.sym('d', TR, BR, SR); m.sym('s', FH, NB, BR); m.sym('h', NB, EI, BR); m.sym('d', BR, EI, EO); m.sym('d', BR, EO, SR); m.sym('e', EI, EO, EL);
    m.sym('h', EO, SR, CR); m.sym('s', EO, CR, EL); m.sym('s', NB, NT, EI); m.sym('d', EI, NT, NR); m.sym('h', EI, NR, EL); m.sym('h', EL, NR, CR); m.sym('d', NR, MR, CR); m.sym('d', NT, NR, UL); m.sym('s', NR, UL, MR);
    m.sym('h', CR, MR, JR); m.sym('d', MR, LL, JR); m.sym('h', JR, LL, CH); m.poly('m', [-16, -26, 10], UL, MR, LL);
  });
  const shade = (hex, k) => { const n = parseInt(hex.slice(1), 16); return `rgb(${Math.min(255, Math.round(((n >> 16) & 255) * k))},${Math.min(255, Math.round(((n >> 8) & 255) * k))},${Math.min(255, Math.round((n & 255) * k))})`; };
  // Draws a mesh placed with axes { P, F, R, U }: far faces first, each one lit, shaded from top to bottom and with a glossy highlight where it catches the light.
  function drawMesh(M, ax, COL, white = false, scale = 1, aura = null, real = false) { // real: harder light and panel lines (ships, satellites)
    const toWin = C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates, cam = viewer.camera, cp = cam.positionWC;
    const W = M.V.map(([x, y, z]) => shipPoint(ax, x * scale, y * scale, z * scale)), S = W.map((p) => toWin(scene, p));
    const L = C.Cartesian3.normalize(new C.Cartesian3(cam.upWC.x * 0.75 - cam.directionWC.x * 0.6 - cam.rightWC.x * 0.25, cam.upWC.y * 0.75 - cam.directionWC.y * 0.6 - cam.rightWC.y * 0.25, cam.upWC.z * 0.75 - cam.directionWC.z * 0.6 - cam.rightWC.z * 0.25), new C.Cartesian3());
    const a = new C.Cartesian3(), b = new C.Cartesian3(), n = new C.Cartesian3(), v = new C.Cartesian3(), hv = new C.Cartesian3(), faces = [];
    const dist = []; let fi = -1;
    for (const [idx, c, par, side] of M.F) {
      fi++;
      const im = c === 'i' || c === 'j' ? [side > 0 && COL[c + 'R'], COL[c]].find((x) => x && x.complete && x.naturalWidth) : null; // the insignia or the tail flag of that side, once its image has arrived
      if ((c === 'i' || c === 'j') && !im) continue;
      if (idx.some((k) => !S[k])) continue; // a corner behind the camera
      C.Cartesian3.cross(C.Cartesian3.subtract(W[idx[1]], W[idx[0]], a), C.Cartesian3.subtract(W[idx[2]], W[idx[0]], b), n);
      if (C.Cartesian3.magnitudeSquared(n) < 1e-12) continue;
      C.Cartesian3.normalize(n, n);
      const mid = idx.reduce((mm, k) => C.Cartesian3.add(mm, W[k], mm), new C.Cartesian3()); C.Cartesian3.multiplyByScalar(mid, 1 / idx.length, mid);
      C.Cartesian3.normalize(C.Cartesian3.subtract(cp, mid, v), v); C.Cartesian3.normalize(C.Cartesian3.add(L, v, hv), hv);
      faces.push({ idx, c, im, lum: (real ? 0.3 : 0.45) + (real ? 0.7 : 0.55) * Math.abs(C.Cartesian3.dot(n, L)), sp: Math.abs(C.Cartesian3.dot(n, hv)) ** 40, d: (dist[fi] = par != null && dist[par] != null ? dist[par] : C.Cartesian3.distance(cp, mid)), o: fi });
    }
    faces.sort((x, y) => y.d - x.d || x.o - y.o); // far to near; a detail right after the face it lies on
    g.save(); g.lineJoin = 'round'; g.lineWidth = 0.8;
    for (const f of faces) {
      if (f.im) { // painted on: the image stretched over its square
        if (!white) { const o = S[f.idx[0]], u = S[f.idx[1]], v = S[f.idx[3]], im = f.im, k = Math.max(im.naturalWidth, im.naturalHeight), iw = im.naturalWidth / k, ih = im.naturalHeight / k; g.save(); g.transform(u.x - o.x, u.y - o.y, v.x - o.x, v.y - o.y, o.x, o.y); g.drawImage(im, (1 - iw) / 2, (1 - ih) / 2, iw, ih); g.restore(); }
        continue;
      }
      let y0 = Infinity, y1 = -Infinity;
      g.beginPath(); f.idx.forEach((k, q) => { const p = S[k]; if (q) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }); g.closePath();
      const base = COL[f.c] || '#cccccc';
      g.shadowColor = aura || 'transparent'; g.shadowBlur = aura ? 7 : 0;
      if (white) g.fillStyle = '#fff';
      else if (f.c === 'e' || f.c === 'm') g.fillStyle = base;
      else { const gr = g.createLinearGradient(0, y0, 0, y1 + 0.01); if (f.c === 'g') { gr.addColorStop(0, '#f4fdff'); gr.addColorStop(0.45, base); gr.addColorStop(1, shade(base, 0.4)); } else { gr.addColorStop(0, shade(base, f.lum * 1.22)); gr.addColorStop(1, shade(base, f.lum * 0.72)); } g.fillStyle = gr; }
      g.fill(); g.shadowBlur = 0;
      if (!white && f.c !== 'e' && f.c !== 'm' && f.sp > 0.04) { g.fillStyle = `rgba(255,255,255,${Math.min(0.8, f.sp * 0.9).toFixed(3)})`; g.fill(); } // the gloss
      g.strokeStyle = white ? '#ddd' : shade(base, f.c === 'e' ? 0.8 : f.lum * 0.5); g.stroke();
      if (real && !white && f.idx.length === 4 && 'hds'.includes(f.c)) { const mx = (i, j) => (S[f.idx[i]].x + S[f.idx[j]].x) / 2, my = (i, j) => (S[f.idx[i]].y + S[f.idx[j]].y) / 2; g.strokeStyle = 'rgba(0,0,0,.28)'; g.lineWidth = 0.7; g.beginPath(); g.moveTo(mx(0, 1), my(0, 1)); g.lineTo(mx(2, 3), my(2, 3)); g.stroke(); } // a panel line across each plate
    }
    g.restore();
  }
  function foeAxes(p, spin = 0) { // facing the camera and upright; spin turns it about its vertical
    const cam = viewer.camera, F = C.Cartesian3.normalize(C.Cartesian3.subtract(cam.positionWC, p, new C.Cartesian3()), new C.Cartesian3());
    let R = C.Cartesian3.cross(F, C.Cartesian3.normalize(p, new C.Cartesian3()), new C.Cartesian3());
    R = C.Cartesian3.magnitudeSquared(R) < 1e-8 ? C.Cartesian3.clone(cam.rightWC) : C.Cartesian3.normalize(R, R); // seen from straight above: any side will do
    const U = C.Cartesian3.cross(R, F, new C.Cartesian3());
    if (!spin) return { P: p, F, R, U };
    const c = Math.cos(spin), sn = Math.sin(spin), lin = (a, ka, b, kb) => new C.Cartesian3(a.x * ka + b.x * kb, a.y * ka + b.y * kb, a.z * ka + b.z * kb);
    return { P: p, F: lin(R, sn, F, c), R: lin(R, c, F, -sn), U };
  }
  const meshScale = (p, px, h) => (px * C.Cartesian3.distance(p, viewer.camera.positionWC)) / (h / 2 / Math.tan((viewer.camera.frustum.fovy || rad(60)) / 2)) / 50; // so that 50 mesh units span px pixels on screen
  function drawBoss3D(o, x, y, R, now) { // every boss as a lit low-poly solid
    const k = o.type, sc = meshScale(o.p, R * 1.35, hud.clientHeight), white = now - (o.hitT || 0) < 90, col = BOSSES[k].color, t = now / 1000, open = shieldOpen(o, now);
    if (k === 'fortress') drawMesh(BOSS3D.fortress.mesh, foeAxes(o.p, Math.sin(now / 1500) * 0.4), BOSS3D.fortress.col, white, sc * 0.75, col);
    else if (k === 'crystal') {
      drawMesh(BOSS3D.crystal.mesh, foeAxes(o.p, now / 1200), BOSS3D.crystal.col, white, sc * 0.95, '#9fe8ff');
      g.save(); g.shadowBlur = 0; g.fillStyle = open ? '#ff2d55' : '#7fb8d8'; g.beginPath(); g.arc(x, y, R * 0.28, 0, 7); g.fill(); g.restore(); // its core, red while exposed
    } else if (k === 'hand') {
      const close = o.held || o.phase === 'stun' ? 1 : o.phase === 'windup' ? 0 : o.phase === 'lunge' ? 0.6 : 0.25 + 0.2 * Math.sin(now / 250);
      if (o.phase === 'windup' || o.phase === 'lunge') { g.save(); g.shadowBlur = 0; g.fillStyle = 'rgba(255,40,40,.3)'; g.beginPath(); g.arc(x, y, R * (1.8 + 0.2 * Math.sin(now / 50)), 0, 7); g.fill(); g.restore(); } // about to grab
      drawMesh(handMesh(close, o.mirror < 0 ? -1 : 1), foeAxes(o.p, Math.sin(now / 900) * 0.35), { h: '#ffd2a6', d: '#a8714a', s: '#e0a678' }, white, sc * 1.1, null);
      if (o.phase === 'windup') { const k = Math.min(1, (now - o.pt) / 2500); glow(g, x, y, R * (0.35 + 0.5 * k) * (1 + 0.15 * Math.sin(now / 40)), k < 0.7 ? '#ffd60a' : '#ff2d55'); g.save(); g.shadowBlur = 0; g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, R * 0.5, 0, 7); g.stroke(); g.restore(); } // the weak point in its palm: the ray charging there, redder as it fills
      if (now - (o.beamT || 0) < 350) { g.save(); g.strokeStyle = g.shadowColor = '#ff2d55'; g.shadowBlur = 24; g.lineWidth = 14 * (1 - (now - o.beamT) / 350) + 2; g.lineCap = 'round'; g.beginPath(); g.moveTo(x, y); g.lineTo(hud.clientWidth / 2, hud.clientHeight * 0.8); g.stroke(); g.restore(); } // the ray, from the palm to the ship
      if (o.held) { g.save(); g.shadowBlur = 0; g.fillStyle = 'rgba(255,0,0,.25)'; g.beginPath(); g.arc(x, y, R * 1.6, 0, 7); g.fill(); g.restore(); }
    } else if (k === 'face') { // the stone face: its mouth opens when it spits
      const gape = Math.max(0, 1 - (now - (o.spat || 0)) / 500);
      drawMesh(faceMesh(gape), foeAxes(o.p, Math.sin(now / 1700) * 0.3), { h: '#f0c648', d: '#8f6410', s: '#ffe690', e: col, m: gape > 0.05 ? col : '#2a1c04' }, white, sc, null);
    } else if (k === 'hive') drawMesh(HIVE, foeAxes(o.p, Math.sin(t) * 0.5), { h: '#e8ad2a', s: '#c98a00', d: '#6e4a00', m: escortsUp(o) >= 2 ? '#7a5200' : '#ff2d55' }, white, sc * 0.85, col); // the core shows red when it can be hurt
    else if (k === 'beacon') {
      const ang = t * (o.rage ? 6 : 1.5), ly = y - R * 1.2; g.save(); g.shadowBlur = 0; g.fillStyle = o.rage ? 'rgba(255,60,60,.35)' : 'rgba(255,240,150,.3)';
      for (const a of [ang, ang + Math.PI]) { g.beginPath(); g.moveTo(x, ly); g.arc(x, ly, R * 3, a - 0.18, a + 0.18); g.closePath(); g.fill(); } g.restore(); // the sweeping beams of its lamp
      drawMesh(BEACON, foeAxes(o.p, t * (o.rage ? 3 : 0.6)), { h: '#eef0f4', s: '#c9ccd4', d: '#5c6170', w: '#c0392b', e: o.rage ? '#ff3b30' : '#fff2a8' }, white, sc * 0.9, null);
    } else if (k === 'snake') drawMesh(snakeMesh(t), foeAxes(o.p, 0.45), { h: '#7ddc6f', s: '#3f9a45', d: '#1f5c2a', w: '#ff1744', e: '#ffeb3b' }, white, sc * 0.85, null);
    else if (k === 'dragon') drawMesh(dragonMesh(t, now - (o.spat || 0) < 400), foeAxes(o.p, 0.4), { h: '#ff8a3c', s: '#d6451f', d: '#7a1f12', w: '#ffd23a', e: '#fff07a' }, white, sc * 0.95, null);
    else if (k === 'saucer') drawMesh(SAUCER, foeAxes(o.p, t * 1.5), { h: '#e6e9f0', s: '#aeb5c4', d: '#565d70', g: '#7fdcff', e: col }, white, sc * 0.9, col);
    else if (k === 'golem') drawMesh(golemMesh(t), foeAxes(o.p, Math.sin(t * 0.8) * 0.5), { h: '#b9aa94', s: '#8c7d69', d: '#544a3d', e: col }, white, sc * 0.9, null);
    else if (k === 'dread') { const lit = (n) => (n <= 3 - (o.stage || 1) ? '#39ff14' : '#1c2a1c'); drawMesh(dreadMesh(open ? 1 : 0), foeAxes(o.p, Math.sin(t * 0.6) * 0.45), { h: '#aeb6c4', s: '#7c8596', d: '#474e5c', e: '#6ee7ff', w: '#59616f', m: open ? (Math.sin(now / 60) > 0 ? '#ff2d55' : '#ffd0d8') : '#141820', a: lit(0), b: lit(1), c: lit(2) }, white, sc, null); }
    else drawMesh(STATION, foeAxes(o.p, Math.sin(t * 0.5) * 0.8), { h: '#dfe5ee', s: '#aab3c2', d: '#5d6678', w: '#2f6fd8', p: '#1f4fa8', m: open ? '#ff2d55' : '#33415c' }, white, sc * 0.9, null); // the orbital station
    if (!open && !BOSSES[k].weak) { g.save(); g.shadowBlur = 0; g.strokeStyle = 'rgba(160,230,255,.8)'; g.lineWidth = 4; g.beginPath(); g.arc(x, y, R * 1.55, 0, 7); g.stroke(); g.restore(); } // the shield, while it is closed
  }
  const FLAME = ['#ff6a1a', '#ff9d0a', '#ffd60a', '#fff1a8', '#bfe9ff', '#7fd4ff', '#3d9bff', '#6f78ff', '#b06bff', '#ff5cf0']; // one colour per turbo level, hyper turbo included
  function drawShip3D(w, h) {
    const ax = shipAxes(), toWin = C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates, cam = viewer.camera, md = shipModel();
    const px = (h / 2 / Math.tan((cam.frustum.fovy || rad(60)) / 2)) / Math.max(60, chase ? chase.d : 380); // pixels per metre at the ship
    drawMesh(md.mesh, ax, { ...shipCol(skin(1), hull1()), ...wornCol() }, performance.now() - hit < 200, 1, null, true);
    const tail = toWin(scene, shipPoint(ax, 0, 1, md.tail));
    const drive = landing === 'parked', lv = drive ? GWARPS.indexOf(gWarp) * 2 : Math.max(0, [...WARPS, ...HYPER].indexOf(warp)), gas = drive ? Math.min(1, Math.abs(s.taxi || 0) / 300) : s.throttle; // the ground turbo has fewer levels: every other colour
    if (tail && (drive ? gas > 0.02 : !landing)) { const fr = px * (9 + 12 * gas + 3.5 * lv + (boost ? 8 : 0)) * (drive ? 0.6 : 1) * (0.9 + 0.1 * Math.sin(performance.now() / (40 - 2 * lv))); glow(g, tail.x, tail.y, fr, FLAME[lv]); if (lv > 2) glow(g, tail.x, tail.y, fr * (0.25 + 0.04 * lv), '#ffffff'); } // the engine flame: bigger with the gas, and bigger, hotter and with a white core as the turbo rises
    const mid = toWin(scene, ax.P);
    if (mid && man && man.type === 'roll') { const k = (performance.now() - man.t0) / man.dur; g.save(); g.globalAlpha = 0.35; glow(g, mid.x, mid.y, px * 58, '#7fd4ff'); g.globalAlpha = 1; g.strokeStyle = 'rgba(225,245,255,.85)'; g.lineWidth = 3; g.lineCap = 'round';
      for (const n of [0, 1, 2]) { const a = k * 5 * Math.PI * man.dir + n * 2.09; g.beginPath(); g.arc(mid.x, mid.y, px * (50 + 7 * n), a, a + 1.2); g.stroke(); } g.restore(); }
    if (mid && (shields || auto)) { g.save(); g.strokeStyle = shields ? 'rgba(10,132,255,.7)' : 'rgba(48,209,88,.75)'; g.fillStyle = shields ? 'rgba(10,132,255,.12)' : 'rgba(48,209,88,.14)'; g.lineWidth = 2 + shields; g.beginPath(); g.arc(mid.x, mid.y, px * 62, 0, 7); g.fill(); g.stroke(); g.restore(); } // the shield around it
    // twin reticles on the line of the nose: what is under the far one gets hit
    const near = toWin(scene, shipPoint(ax, 0, 0, 1800)), far = toWin(scene, shipPoint(ax, 0, 0, 5200));
    g.save(); g.strokeStyle = '#39ff14'; g.shadowColor = '#000'; g.shadowBlur = 3; g.lineWidth = 2;
    if (near && !aimMouse) { const r = 20; for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { g.beginPath(); g.moveTo(near.x + sx * r, near.y + sy * (r - 9)); g.lineTo(near.x + sx * r, near.y + sy * r); g.lineTo(near.x + sx * (r - 9), near.y + sy * r); g.stroke(); } }
    if (far && !aimMouse) { g.strokeStyle = '#ff3b30'; g.strokeRect(far.x - 9, far.y - 9, 18, 18); g.beginPath(); g.arc(far.x, far.y, 1.5, 0, 7); g.stroke(); }
    g.restore();
    const [tx, ty, tz] = md.tip;
    return { far, nose: toWin(scene, shipPoint(ax, 0, 0, 72)), tips: [toWin(scene, shipPoint(ax, -tx, ty, tz)), toWin(scene, shipPoint(ax, tx, ty, tz))] };
  }
  const backAxes = (p, roll = 0) => { // a ship flying away from the camera, seen from behind and a little above, banked by roll
    const c = viewer.camera, mix = (a, ka, b, kb) => new C.Cartesian3(a.x * ka + b.x * kb, a.y * ka + b.y * kb, a.z * ka + b.z * kb), U0 = mix(c.upWC, 0.95, c.directionWC, -0.31), cr = Math.cos(roll), sr = Math.sin(roll);
    return { P: p, F: mix(c.directionWC, 0.95, c.upWC, 0.31), R: mix(c.rightWC, cr, U0, -sr), U: mix(U0, cr, c.rightWC, sr) };
  };
  function shipBack(x, y, R, color, roll = 0, hurtT = 0, model, P) { // a starship flying ahead, in its model and colour: R pixels from the middle to a wing tip, at the world point P or 200 m into the screen at x, y
    if (!P) { const ray = viewer.camera.getPickRay(new C.Cartesian2(x, y)); if (!ray) return; P = C.Cartesian3.add(ray.origin, C.Cartesian3.multiplyByScalar(ray.direction, 200, new C.Cartesian3()), new C.Cartesian3()); }
    const md = shipModel(model), ax = backAxes(P, roll), sc = meshScale(P, R, hud.clientHeight);
    drawMesh(md.mesh, ax, { ...shipCol(color, model ? null : hull1()), ...(model ? {} : wornCol()) }, performance.now() - hurtT < 200, sc, null, true); // only the pilot's own ship wears the insignia
    const t = (C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates)(scene, shipPoint(ax, 0, sc, md.tail * sc));
    if (t) glow(g, t.x, t.y, R * 0.3, '#7fd4ff'); // its engine
  }
  function p2Hurt(n) {
    if (!p2 || p2.out || tut || performance.now() < graceT) return;
    p2.hp -= n * DIFF[diff].hurt; p2.hit = performance.now(); beep(240, 100, 0.2);
    if (p2.hp <= 0) { p2.out = true; OGE.toast(`Jugador 2 derribado: ${p2.score} puntos.`); }
  }
  const pvp = () => localStorage.getItem('oge.pvp') !== '0'; // players can hurt each other (the multiplayer dialog turns it off)
  function versus(who, ax, ay, ray) { // a shot that hits the other player costs it life
    if (!pvp()) { if (who === 1) mpSend({ t: 'shot' }); return; }
    const w = hud.clientWidth, h = hud.clientHeight, near = (x, y, r) => Math.hypot(ax - x, ay - y) < r;
    if (p2 && !p2.out && p2.sx != null) {
      if (who === 1 && near(p2.sx, p2.sy, p2.R * 0.9)) { p2Hurt(10); score += pts(200); sfx('down'); }
      if (who === 2 && near(...P1POS(w, h), 40)) { hurt(10); p2.score += pts(200); sfx('down'); }
    }
    if (who === 1 && remote && remote.p) { // the remote ship inside the aim cone
      const to = C.Cartesian3.subtract(remote.p, ray.origin, new C.Cartesian3()), d = C.Cartesian3.magnitude(to);
      if (Math.acos(clamp(C.Cartesian3.dot(to, ray.direction) / d, -1, 1)) < Math.atan(150 / d) + rad(1.5)) { mpSend({ t: 'hit', n: 10 }); score += pts(200); remote.hitT = performance.now(); booms.push({ p: remote.p, t: performance.now() }); sfx('down'); }
    }
    if (who === 1) mpSend({ t: 'shot' });
  }
  function mpStep(dt) {
    if (p2 && !p2.out && p2.sx != null) { // the wingman flies on the screen; U/O drop back or pull ahead
      const k = (x) => keys.has(x), lr = (k('l') ? 1 : 0) - (k('j') ? 1 : 0);
      p2.x = clamp(p2.x + lr * 1.1 * dt, -0.9, 0.9); p2.y = clamp(p2.y + ((k('k') ? 1 : 0) - (k('i') ? 1 : 0)) * 1.1 * dt, -0.6, 0.85);
      p2.z = clamp(p2.z + ((k('o') ? 1 : 0) - (k('u') ? 1 : 0)) * 250 * dt, 90, 600); p2.tilt += (lr * 0.4 - p2.tilt) * Math.min(1, 8 * dt);
      const ray = viewer.camera.getPickRay(new C.Cartesian2(p2.sx, p2.sy));
      p2.p = C.Cartesian3.add(ray.origin, C.Cartesian3.multiplyByScalar(ray.direction, p2.z, new C.Cartesian3()), new C.Cartesian3()); // its place in the world, for enemy shots
      incoming = incoming.filter((b) => { if (C.Cartesian3.distance(b.p, p2.p) < 60 + s.v * warp * 0.05) { p2Hurt(8); return false; } return true; });
    }
    if (remote && remote.to) { // glide toward the last reported place between messages
      remote.p = remote.p ? C.Cartesian3.lerp(remote.p, remote.to, Math.min(1, 10 * dt), new C.Cartesian3()) : C.Cartesian3.clone(remote.to);
      if (performance.now() - remote.t > 3000) remote.p = null; // no news: it left the game
    }
  }
  function mpDraw(w, h, text) {
    const now = performance.now();
    if (p2) {
      shipBack(...P1POS(w, h), 34, skin(1), s.roll * 0.3, hit);
      p2.sx = w / 2 + (p2.x * w) / 2; p2.sy = h / 2 + (p2.y * h) / 2; p2.R = clamp(9000 / p2.z, 16, 80);
      if (!p2.out) {
        shipBack(p2.sx, p2.sy, p2.R, skin(2), p2.tilt, p2.hit, localStorage.getItem('oge.shipModel2') || 'delta', p2.p);
        const rx = p2.sx, ry = p2.sy - p2.R * 1.6; // its reticle
        g.save(); g.strokeStyle = skin(2); g.lineWidth = 2; g.beginPath(); g.arc(rx, ry, 10, 0, 7); g.moveTo(rx - 16, ry); g.lineTo(rx + 16, ry); g.moveTo(rx, ry - 16); g.lineTo(rx, ry + 16); g.stroke(); g.restore();
      }
      g.save(); g.fillStyle = skin(2);
      const y2 = adv ? 166 : 146; // under player 1's score and life
      text(`${T('JUGADOR 2')}  ${T('PUNTOS')} ${p2.score}`, 24, y2, 15, 'left');
      g.strokeStyle = skin(2); g.strokeRect(24, y2 + 14, 180, 12); g.fillRect(24, y2 + 14, (180 * Math.max(0, p2.hp)) / 100, 12);
      text(p2.out ? T('DERRIBADO') : `${T('VIDA')} ${Math.max(0, Math.round(p2.hp))}/100`, 212, y2 + 21, 12, 'left'); g.restore();
    }
    if (remote && remote.p) {
      const toWin = C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates, q = toWin(scene, remote.p), d = C.Cartesian3.distance(remote.p, viewer.camera.positionWC);
      if (q) {
        const R = clamp(40000 / d, 14, 90);
        drawMesh(shipModel(remote.m).mesh, remote.h == null ? foeAxes(remote.p, Math.PI) : axesAt(remote.p, remote.h, remote.pt, remote.r), shipCol(remote.skin), now - (remote.hitT || 0) < 200, meshScale(remote.p, R, h), null, true); // the other pilot's ship, with its model and colour
        if (now - (remote.shot || 0) < 150) glow(g, q.x, q.y - R * 0.6, R * 0.5, '#ff3b30'); // its lasers firing
        g.save(); g.fillStyle = remote.skin; text(`${remote.name} · ${(d / 1000).toFixed(1)} km · ${T('VIDA')} ${Math.max(0, Math.round(remote.hp))}`, q.x, q.y + R + 14, 12); g.restore();
      }
    }
  }
  function mpMessage(m) {
    if (m.t === 's') {
      remote = remote || {};
      Object.assign(remote, { to: C.Cartesian3.fromRadians(m.lon, m.lat, m.alt), r: +m.r || 0, h: Number.isFinite(+m.h) ? +m.h : null, pt: +m.pt || 0, m: SHIPS[m.m] ? m.m : 'dardo', hp: m.hp, name: String(m.name || '?').slice(0, 24), skin: /^#[0-9a-f]{6}$/i.test(m.skin) ? m.skin : '#ff9f0a', t: performance.now() });
    } else if (m.t === 'shot' && remote) remote.shot = performance.now();
    else if (m.t === 'hit' && on && arcade && pvp()) hurt(Math.min(25, +m.n || 0));
    else if (m.t === 'mine' && on && Number.isFinite(+m.lon) && Number.isFinite(+m.lat) && Number.isFinite(+m.alt)) objs.push({ kind: 'mine', p: C.Cartesian3.fromRadians(+m.lon, +m.lat, +m.alt), size: 300, next: 1e15, until: performance.now() + 90000 });
    else if (m.t === 'go') mpJoin(m);
    else if (m.t === 'fin' && remote) OGE.toast(`${remote.name} ${T('llegó a la meta')}: ${fmtT(Math.max(0, +m.ms || 0))}`);
    else if (m.t === 'dead' && remote) { OGE.toast(`${remote.name} ${T('fue derribado.')}`); remote.p = remote.to = null; }
  }
  const mpClose = () => { const c = ws; ws = null; remote = null; clearInterval(mpTimer); if (c) c.close(); };
  async function mpOnline(addr) { // connects to the relay (the host's own one included)
    mpClose();
    const c = await new Promise((ok, fail) => { const c = new WebSocket('ws://' + addr); c.onopen = () => ok(c); c.onerror = () => fail(new Error(T('no se pudo conectar a') + ' ' + addr)); });
    ws = c;
    c.onmessage = (e) => { try { mpMessage(JSON.parse(e.data)); } catch { /* a malformed message is ignored */ } };
    c.onclose = () => { if (ws !== c) return; OGE.toast('Se cortó la conexión con el otro jugador.', true); ws = null; remote = null; clearInterval(mpTimer); }; // not when closed on purpose
    clearInterval(mpTimer);
    mpTimer = setInterval(() => { if (on) mpSend({ t: 's', lon: s.lon, lat: s.lat, alt: s.alt, r: s.roll, h: s.heading, pt: s.pitch, m: localStorage.getItem('oge.shipModel') || 'dardo', hp, score, skin: skin(1), name: localStorage.getItem('oge.pilot') || T('Piloto') }); }, 100); // ten times a second
  }
  async function multiplayer() {
    const wasOn = on, live = !!(p2 || ws || remote); if (!live) paused = true; // in a multiplayer game the others keep flying: no pause
    const v = await OGE.ask({ title: 'OpenStarshipEarth: multijugador', ok: 'Jugar',
      help: 'Local: el jugador 2 mueve su nave con I J K L, se adelanta con O, se retrasa con U y dispara con Enter (su mira es la cruz sobre su nave). En línea: la app de escritorio crea la partida y muestra su IP:puerto; el otro jugador se une con esa dirección desde su app o desde la página (la página publicada en https puede bloquear la conexión: entonces usa la app). En la misma red Wi-Fi o por cable, el otro jugador elige «buscar partidas en esta red local» en su app y no escribe ninguna dirección. Los jugadores pueden dispararse entre ellos.',
      fields: [{ id: 'mode', label: 'Modo', type: 'select', value: mpMode, options: [['solo', 'Un jugador'], ['local', 'Local: 2 jugadores en esta pantalla'], ['host', 'En línea: crear partida (app de escritorio)'], ['join', 'En línea: unirse a una partida'], ['lan', 'En línea: buscar partidas en esta red local (app de escritorio)']] },
        { id: 'addr', label: 'Dirección del anfitrión (IP:puerto), para unirse', value: localStorage.getItem('oge.mpAddr') || '', placeholder: '192.168.1.20:7777' },
        { id: 'port', label: 'Puerto, para crear la partida', type: 'number', value: +localStorage.getItem('oge.mpPort') || 7777, min: 1024, max: 65535, step: 1 },
        { id: 'model', label: 'Modelo de tu nave', type: 'select', value: SHIPS[localStorage.getItem('oge.shipModel')] ? localStorage.getItem('oge.shipModel') : 'dardo', options: Object.entries(SHIPS).map(([k, m]) => [k, m.name]) },
        { id: 'model2', label: 'Modelo de la nave del jugador 2 (modo local)', type: 'select', value: SHIPS[localStorage.getItem('oge.shipModel2')] ? localStorage.getItem('oge.shipModel2') : 'delta', options: Object.entries(SHIPS).map(([k, m]) => [k, m.name]) },
        { id: 'pvp', label: 'Los jugadores pueden dañarse entre sí con sus disparos', type: 'checkbox', value: pvp() },
        ...tintFields('c1', 'Color de tu nave', 'Tu nave: código hex (con «Personalizado»)', skin(1)), ...tintFields('c2', 'Color de la nave del jugador 2 (modo local)', 'Jugador 2: código hex (con «Personalizado»)', skin(2))] });
    if (!live) { paused = false; last = performance.now(); }
    if (!v) return;
    localStorage.setItem('oge.skin1', tintOf(v, 'c1', skin(1))); localStorage.setItem('oge.skin2', tintOf(v, 'c2', skin(2))); localStorage.setItem('oge.pvp', v.pvp ? '1' : '0'); if (SHIPS[v.model]) localStorage.setItem('oge.shipModel', v.model); if (SHIPS[v.model2]) localStorage.setItem('oge.shipModel2', v.model2);
    mpMode = v.mode;
    if (!['host', 'join', 'lan'].includes(v.mode)) mpClose();
    try {
      if (v.mode === 'host') {
        const tauri = window.__TAURI__ && window.__TAURI__.core;
        if (!tauri) { mpMode = 'solo'; return OGE.toast('Crear una partida en línea necesita la app de escritorio; desde la página puedes unirte a una.', true); }
        localStorage.setItem('oge.mpPort', v.port);
        const addr = await tauri.invoke('mp_host', { port: v.port, name: localStorage.getItem('oge.pilot') || T('Piloto') });
        await mpOnline('127.0.0.1:' + v.port);
        OGE.toast(`${T('Partida creada. El otro jugador se une con')} ${addr} ${T('o buscándola en su red local.')}`);
      } else if (v.mode === 'join') {
        const addr = v.addr.trim().replace(/^wss?:\/\//, '');
        if (!/^[\w.-]+:\d{2,5}$/.test(addr)) { mpMode = 'solo'; return OGE.toast('Escribe la dirección como IP:puerto, por ejemplo 192.168.1.20:7777.', true); }
        localStorage.setItem('oge.mpAddr', addr);
        await mpOnline(addr);
        OGE.toast(`${T('Conectado a')} ${addr}`);
      } else if (v.mode === 'lan') {
        const tauri = window.__TAURI__ && window.__TAURI__.core;
        if (!tauri) { mpMode = 'solo'; return OGE.toast('Buscar partidas en la red local necesita la app de escritorio.', true); }
        const games = (await tauri.invoke('mp_find')).map((x) => /^([\d.]+:\d{2,5})\|(.*)$/.exec(x)).filter(Boolean); // each one: IP:port|pilot
        if (!games.length) { mpMode = 'solo'; return OGE.toast('No hay ninguna partida en esta red: el anfitrión debe crearla antes y permitir la app en su firewall.', true); }
        let addr = games[0][1];
        if (games.length > 1) { const pick = await OGE.ask({ title: 'Partidas en esta red', ok: 'Unirme', fields: [{ id: 'g', label: 'Partida', type: 'select', value: addr, options: games.map((m) => [m[1], `${m[2].slice(0, 24) || T('Piloto')} · ${m[1]}`]) }] }); if (!pick) { mpMode = 'solo'; return; } addr = pick.g; }
        await mpOnline(addr);
        OGE.toast(`${T('Conectado a')} ${games.find((m) => m[1] === addr)[2] || addr}`);
      }
    } catch (e) { mpMode = 'solo'; return OGE.toast(T('Multijugador') + ': ' + (e.message || e), true); }
    p2 = mpMode === 'local' && wasOn && arcade ? { x: -0.65, y: 0.55, z: 200, hp: 100, score: 0, tilt: 0 } : null; // joins the flight in progress
    if (!wasOn) { mpLaunch = true; $('shipBtn').click(); } // the mode menu: free play, race or adventure, now with the second player
  }

  // ---------- Controls ----------
  // Gamepad, Xbox 360 layout by default (browsers report XInput pads in the 'standard' mapping):
  // left stick steers, right stick aims; A fire · B bomb · X barrel roll · Y loop · LB / RB turbo − / + · LT stop · RT turbo burst
  // Back controls · Start pause · L3 turn back · R3 camera · D-pad ↑ climb · ↓ land · ← race item · → take off
  // XInput pad, standard layout. Buttons that stand for a key: A turbo burst · B turn back · X barrel roll · Y loop · LB race item · RB bomb · RT fire with auto-aim (held: charge)
  // Start pause · L3 stop · d-pad up take off, down land, left / right turbo. By hand below: LT fire where it points, Back the options menu, R3 lock-on or free aim, the right stick.
  const PAD = ['e', 'f', 'r', 'x', null, null, null, 'b', null, 'enter', 'q', null, 'c', 'z', 'shift', ' ']; // 'shift' stands for the left Shift: turbo down
  const padPrev = [], pad = { x: 0, y: 0, on: false, free: false, flick: false, menu: false, navT: 0, el: null };
  let padLock = null; // the enemy the right stick picked: the auto-aim fires at it
  const LOCKABLE = ['enemy', 'boss', 'airliner', 'aa', 'octo', 'ship'];
  function pickLock(dx, dy) { // the right stick points at the enemy to lock on: the nearest one that way from the current target (or from the middle of the view)
    const toW = C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates, cw = hud.clientWidth, ch = hud.clientHeight, camP = viewer.camera.positionWC, t = new C.Cartesian3();
    const seen = objs.filter((o) => LOCKABLE.includes(o.kind) && C.Cartesian3.dot(C.Cartesian3.subtract(o.p, camP, t), viewer.camera.directionWC) > 0).map((o) => ({ o, q: toW(scene, o.p) })).filter(({ q }) => q && q.x >= 0 && q.y >= 0 && q.x <= cw && q.y <= ch);
    const cur = seen.find((c) => c.o === padLock), from = cur ? cur.q : { x: cw / 2, y: ch / 2 };
    let best = null, bs = Infinity;
    for (const c of seen) { if (c === cur) continue; const vx = c.q.x - from.x, vy = c.q.y - from.y, d = Math.hypot(vx, vy) || 1, al = (vx * dx + vy * dy) / d; if (al < 0.3) continue; const sc = d * (2 - al); if (sc < bs) { bs = sc; best = c; } } // near and well in line with the stick
    if (best) { padLock = best.o; beep(900, 1300, 0.08); }
  }
  const padFocus = (e) => { if (pad.el) pad.el.classList.remove('padfocus'); pad.el = e || null; if (e) { e.classList.add('padfocus'); e.focus(); e.scrollIntoView({ block: 'nearest' }); } };
  const desk = () => $('flyBtns').classList.contains('keyboard'); // with a keyboard the column of buttons is hidden: the options are in the K panel
  function padMenu(open) { // Back: the options of the flight, chosen with the pad; alone, the game waits meanwhile
    pad.menu = open; keys.clear(); padFocus(null);
    if (desk()) { $('flyKeys').hidden = !open; $('flyRules').hidden = true; } else $('flyBtns').classList.toggle('more', open || !!localStorage.getItem('oge.flyMore'));
    if (open && !paused && !(p2 || ws || remote)) { paused = pad.held = true; } else if (!open && pad.held) { pad.held = paused = false; last = performance.now(); }
  }
  function padUI(dlg, hit, lx, ly) { // the pad in a menu or a dialog: d-pad or left stick move the focus (left / right change a list or a number), A presses, B or Back close
    const els = [...(dlg || (desk() ? $('flyKeys') : $('flyExtra'))).querySelectorAll('button, select, input, textarea')].filter((e) => !e.disabled && e.offsetParent), now = performance.now();
    const tilt = now > pad.navT, dir = (i, v) => hit(i) || (tilt && v), up = dir(12, ly < -0.6), dn = dir(13, ly > 0.6), lf = dir(14, lx < -0.6), rt = dir(15, lx > 0.6);
    if (up || dn || lf || rt) pad.navT = now + 220; // a held stick steps four times a second
    const cur = els.includes(pad.el) ? pad.el : null, i = els.indexOf(cur);
    if (!cur) { const first = (on && A.ship && s.alt > SPACE && els.find((e) => e.classList.contains('autoDest'))) || els[0]; if (first) padFocus(first); } // out in space the menu opens on the autopilot's destinations
    else if ((lf || rt) && cur.tagName === 'SELECT') { cur.selectedIndex = clamp(cur.selectedIndex + (rt ? 1 : -1), 0, cur.options.length - 1); cur.dispatchEvent(new Event('change', { bubbles: true })); }
    else if ((lf || rt) && (cur.type === 'range' || cur.type === 'number')) { try { if (rt) cur.stepUp(); else cur.stepDown(); cur.dispatchEvent(new Event('input', { bubbles: true })); } catch { /* a number without a step stays as it is */ } }
    else if (up || dn || lf || rt) padFocus(els[(i + (dn || rt ? 1 : -1) + els.length) % els.length]);
    if (hit(0) && cur) cur.click();
    if (hit(1) || hit(8)) { padFocus(null); if (dlg) { dlg.dispatchEvent(new Event('cancel')); if (dlg.open) dlg.close(); } else padMenu(false); }
  }
  function readPad() {
    const gp = [...(navigator.getGamepads ? navigator.getGamepads() : [])].find((p) => p && p.connected);
    pad.on = !!gp; if (!gp) return;
    const dz = (v) => (Math.abs(v) < 0.15 ? 0 : v), down = (i) => { const b = gp.buttons[i]; return !!b && (b.pressed || b.value > 0.5); }, hit = (i) => down(i) && !padPrev[i];
    const lx = dz(gp.axes[0] || 0), ly = dz(gp.axes[1] || 0), rx = dz(gp.axes[2] || 0), ry = dz(gp.axes[3] || 0), dlg = document.querySelector('dialog[open]');
    if (dlg || pad.menu) { pad.x = pad.y = 0; padUI(dlg, hit, lx, ly); }
    else if (hit(8)) padMenu(true);
    else {
      pad.x = lx; pad.y = ly;
      if (hit(11)) { // R3: the right stick locks on enemies, or moves the crosshair freely
        pad.free = !pad.free; padLock = null;
        if (pad.free) { pad.aim0 = aimMouse; aimMouse = true; } else aimMouse = !!pad.aim0;
        OGE.toast(T(pad.free ? 'Mando: apuntado libre con el stick derecho (R3 vuelve a fijar enemigos).' : 'Mando: el stick derecho elige el enemigo fijado.'));
      }
      if (pad.free) { if (rx || ry) { mouse.x = clamp(mouse.x + rx * 14, 0, hud.clientWidth); mouse.y = clamp(mouse.y + ry * 14, 0, hud.clientHeight); } }
      else { const m = Math.hypot(rx, ry); if (m > 0.6 && !pad.flick) { pad.flick = true; pickLock(rx / m, ry / m); } else if (m < 0.3) pad.flick = false; } // one push of the stick, one change of target
      if (down(4) && down(5)) { if (!pad.combo) { pad.combo = true; document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y' })); } } // both bumpers together: first or third person
      else { for (const [i, key] of [[4, 'u'], [5, 'v']]) if (padPrev[i] && !down(i) && !pad.combo) { document.dispatchEvent(new KeyboardEvent('keydown', { key })); document.dispatchEvent(new KeyboardEvent('keyup', { key })); } // alone, a bumper acts as it is let go (LB the race item, RB the bomb): pressed, it could still become the pair
        if (!down(4) && !down(5)) pad.combo = false; }
      if (hit(6)) trigger(false); // LT: fires where the ship (or the free crosshair) points; held, it charges
      if (!down(6) && padPrev[6]) letGo();
      PAD.forEach((key, i) => {
        if (!key) return;
        if (hit(i)) document.dispatchEvent(new KeyboardEvent('keydown', { key }));
        if (!down(i) && padPrev[i]) document.dispatchEvent(new KeyboardEvent('keyup', { key }));
      });
    }
    for (let i = 0; i < 17; i++) padPrev[i] = down(i);
  }
  window.addEventListener('gamepadconnected', (e) => { OGE.toast(`${T('Mando conectado')}: ${e.gamepad.id.slice(0, 40)}. ${T('Select (Back) abre las opciones: piloto automático, nave, puntajes.')}`); $('padMap').hidden = false; });
  window.addEventListener('gamepaddisconnected', () => { $('padMap').hidden = true; });
  function controls(dt) {
    const k = (x) => keys.has(x), ease = Math.min(1, 12 * dt), shift = k('shift'); // quick response to the keys
    const lr = (k('arrowright') ? 1 : 0) - (k('arrowleft') ? 1 : 0), ud = (k('arrowdown') || k('s') ? 1 : 0) - (k('arrowup') || k('w') ? 1 : 0);
    const turnArrows = A.ship || touch.id !== null; // the ship (and the touch stick) turns left and right instead of banking
    if (mouseCtl) { s.ail = touch.id !== null ? 0 : stick.x; s.elev = stick.y; } else { s.ail += ((shift || turnArrows ? 0 : lr) - s.ail) * ease; s.elev += (clamp(ud + (pad.on ? pad.y : 0), -1, 1) - s.elev) * ease; }
    const rud = (pad.on ? pad.x : 0) + (k('d') ? 1 : 0) - (k('a') || k('insert') ? 1 : 0) + (shift || turnArrows ? lr : 0) + (touch.id !== null ? stick.x : 0);
    s.rud += (clamp(rud, -1, 1) - s.rud) * ease;
    const gas = k('pageup') || (k('e') && !A.ship); // on the ship E is the boost, not the throttle
    if (gas && s.throttle < 1 && !(thrT > performance.now())) { thrT = performance.now() + 450; sfx('thrust'); } // a whoosh while speeding up
    if (gas) s.throttle = Math.min(1, s.throttle + 0.8 * dt);
    if (A.ship && k('e') && !eHeld) startBoost(); // one press: a temporary turbo
    eHeld = A.ship && k('e');
    if (k('pagedown') || k('q')) s.throttle = Math.max(0, s.throttle - 0.8 * dt);
    if (k('home')) s.trim = Math.max(-0.4, s.trim - 0.2 * dt);
    if (k('end')) s.trim = Math.min(0.4, s.trim + 0.2 * dt);
    s.brake = k(',') || k('.') || k('b');
  }

  // ---------- Simplified physics ----------
  // OpenStarshipEarth maneuvers: barrel roll (R), full loop (V) and half loop with a roll out, to turn back (F).
  let man = null, lastRoll = 1; // man: { type, t0, dur, dir }
  function startBoost() { // two turbo levels for 2.5 seconds
    if (landing) return; // on the ground E is the accelerator of the 'car'
    stopped = false;
    if (s.v < (A.v0 || 300)) { s.v = A.v0 || 300; s.throttle = Math.max(s.throttle, 0.5); } // stopped with Q: E gets it moving again
    if (boost || performance.now() < boostCd) return;
    stopped = false;
    const to = warp > 100 ? warp : WARPS[Math.min(WARPS.length - 1, WARPS.indexOf(warp) + 2)]; // two turbo levels up (the hyper turbo is already past them)
    boost = { t0: performance.now(), from: warp, to }; boostCd = performance.now() + 3500; setWarp(to); sfx('thrust');
  }
  function maneuver(type) {
    if (on && !A.ship) return OGE.toast('Disparar y las maniobras son solo de la OpenStarshipEarth.');
    if (!on || paused || man || auto) return;
    const dir = keys.has('a') ? -1 : keys.has('d') ? 1 : (lastRoll = -lastRoll);
    man = { type, t0: performance.now(), dur: type === 'roll' ? 600 : type === 'loop' ? 2400 : 1500, dir };
    sfx(type === 'roll' ? 'roll' : 'loop');
  }
  function step(dt) {
    if (A && A.ship) engineHum(paused ? 0 : landing === 'parked' ? 0.2 + Math.min(0.8, Math.abs(s.taxi || 0) / 700) : stopped ? 0.15 : 0.45 + 0.55 * s.throttle, Math.log2(Math.max(1, landing === 'parked' ? gWarp : warp)) / 2 + (boost ? 1.5 : 0));
    scene.globe.maximumScreenSpaceError = warp >= 16 ? 5 : warp >= 4 ? 3 : 2; // fast: fewer, coarser tiles first
    controls(dt); warpLabel(); if (auto && landing) endAuto();
    if (A.gun) gunStep(dt, !s.ground && (keys.has('b') || gunHeld)); // in the air: on the ground B is the brakes
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
    const airbrake = (A.ship ? stopped : keys.has('q')) || keys.has('pagedown') ? (A.ship ? A.thrust * 1.5 + s.v * 2 : 6) : 0; // Q also brakes: drag alone is too weak at low speed; the ship halves its speed about every 0.3 s and stops
    const elev = clamp(s.elev + s.trim, -1, 1), ground = scene.globe.getHeight(new C.Cartographic(s.lon, s.lat)) || 0, deep = !!A.ship && !landing && (s.alt > DEEP || !!auto);
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
      if (deep) { if (!man && !auto) freeTurn(elev * A.pitch * dt, s.rud * A.yaw * dt * turn, s.ail * A.roll * dt); } else {
      const pr = elev * A.pitch * q * dt; // pulling the stick raises the nose in the aircraft's axis: when banked, it turns
      s.roll = C.Math.negativePiToPi(s.roll + s.ail * A.roll * q * dt);
      s.pitch += pr * Math.cos(s.roll) - (1 - Math.cos(s.roll)) * (grav / Math.max(s.v, 20)) * dt; // when banked it loses lift: the nose drops
      s.heading += pr * Math.sin(s.roll) + ((G * Math.sin(s.roll)) / Math.max(s.v, 20)) * dt + s.rud * A.yaw * q * dt * turn * (chase ? 1 + 0.4 * Math.min(1, Math.abs(chase.bank) / 1.05) : A.ship ? 1.4 : 1); // the ship in first person turns at the full rate at once
      if (s.v < stallV) s.pitch -= rad(18) * dt; // stall
      s.pitch = clamp(s.pitch, rad(-89), rad(89));
      if (nav) navStep(dt);
      if (A.ship && !mouseCtl) s.roll *= 1 - Math.min(1, 3 * dt); // back from deep space: the keys cannot level the wings, so they level by themselves
      }
      s.v = clamp(s.v + (s.throttle * A.thrust - drag - airbrake - grav * Math.sin(s.pitch)) * dt, 0, A.vMax * 1.3);
      if (A.ship && airbrake) { s.v = Math.max(0, s.v - Math.max(A.thrust * 3, s.v * 4) * dt); if (boost) { if (warp === boost.to) setWarp(boost.from); boost = null; } } // Q: the ship stops in about a second and hovers
      else if (A.ship && boost && performance.now() - boost.t0 > 2500) { if (warp === boost.to) setWarp(boost.from); boost = null; } // after 2.5 s, back to the turbo it had (unless changed by hand) // the burst rises and falls back to the speed it had
      s.vs = s.v * Math.sin(pe);
      if (!deep) s.alt += s.vs * dt * warp; // in deep space the whole move is made below, in a straight line
      if (A.ship && keys.has('t')) { s.alt += 250 * dt; s.vs += 250; } // T held: a gentle climb, ~250 m/s
      if (A.ship && s.alt <= ground + 30) { // the starship bounces off the ground; in the arcade a hard touch costs life
        s.alt = ground + 30; s.pitch = Math.max(s.pitch, rad(arcade ? 8 : 2));
        if (arcade && !landing && !shields && !man && performance.now() - hit > 800) hurt(15); // an intended landing (Z) does no harm, nor touching the ground with a shield up or during a roll, loop or turn
      }
      else if (s.alt <= ground + GEAR_H) { // soft touchdown with the gear down, or crash
        if (!(s.gear && s.vs > -4 && Math.abs(s.roll) < rad(12) && s.pitch > rad(-6))) {
          return stop((IMPERIAL ? `Accidente a ${Math.round(s.v * KT)} nudos.` : `Accidente a ${Math.round(s.v * 3.6)} km/h.`) + (s.gear ? '' : ' El tren estaba arriba (L lo baja).'), true);
        }
        s.ground = true; s.alt = ground + GEAR_H; s.pitch = Math.max(0, s.pitch);
      }
    }
    const horiz = s.v * Math.cos(pe) * dt * warp; // negative over the top of a loop: it flies backwards
    if (A.ship && s.alt > SPACE && !spaceMsg) { spaceMsg = true; OGE.toast(`${T('Fuera de la atmósfera.')} ${T('Piloto automático, con hiperturbo:')} ${DEST.map((d, i) => `${i + 1} ${T(PLACES[d])}`).join(' · ')} · 4 ${T('la superficie')}`); }
    if (deep) { if (auto) autoStep(dt); else spaceStep(dt, man ? pe : s.pitch); if (!man) pe = s.pitch; }
    else {
      if (warp > 100) setWarp(100); // flown by hand: no hyper turbo
      glide(horiz);
    }
    s.heading = C.Math.zeroToTwoPi(s.heading);
    s.agl = s.alt - ground;
    s.rollOff = rollOff; s.pe = pe; // the drawing of the own ship (third person) turns with the maneuvers
    viewer.camera.setView({ destination: C.Cartesian3.fromRadians(s.lon, s.lat, s.alt), orientation: { heading: s.heading, pitch: pe, roll: s.roll + rollOff } });
    if (landing && A && A.ship) {
      const gnd = (scene.globe.getHeight(new C.Cartographic(s.lon, s.lat)) || 0) * scene.verticalExaggeration;
      if (landing !== 'parked') refuelMsg = false;
      if (landing === 'down') { s.v = Math.min(s.v, 60); s.pitch = 0; s.alt = Math.max(gnd + 30, s.alt - Math.max(400, (s.alt - gnd) * 1.6) * dt); if (s.alt <= gnd + 31) { landing = 'parked'; sfx('down'); OGE.toast('Aterrizaste. Pulsa Despegar (C) para volver a volar.'); } }
      else if (landing === 'parked') { // on the ground it rolls slowly: forward with W / ↑ / E, back with S / ↓ / Q; A, D and the arrows steer
        const lo = C.Math.toDegrees(s.lon), la = C.Math.toDegrees(s.lat), field = arcade && airports && airports.find(([x, y]) => Math.abs(y - la) < 0.04 && Math.abs((x - lo) * Math.cos(s.lat)) < 0.04); // ~4 km
        if (field && hp < maxHp) { hp = Math.min(maxHp, hp + 8 * dt); if (!refuelMsg) { refuelMsg = true; OGE.toast(T('🛬 Aeródromo: recuperando vida…')); sfx('heart'); } }
        s.v = 0; s.throttle = 0; s.pitch = 0; stopped = false;
        // like a car: W / ↑ / E accelerate up to ~3600 km/h, S / ↓ / Q brake and then reverse; the steering only turns while it rolls (and reverses backwards)
        const kd = (x) => keys.has(x), gas = kd('w') || kd('arrowup') || kd('e') || kd('pageup') || stick.y < -0.2, brake = kd('s') || kd('arrowdown') || stick.y > 0.2, halt = kd('q') || kd('pagedown'); // Q only stops: down to zero, never into reverse, and W drives on
        let v = s.taxi || 0;
        if (halt) v -= Math.sign(v) * Math.min(Math.abs(v), Math.max(150, Math.abs(v) * 1.5) * dt);
        else if (gas) v += (v < 0 ? 60 : 60 + v * 0.25) * dt; else if (brake) v -= (v > 0 ? 50 : 12) * dt; else v -= Math.sign(v) * Math.min(Math.abs(v), 4 * dt); // engine braking when nothing is pressed
        s.taxi = v = clamp(v, -25, 1000); // ground speed: up to ~3600 km/h, separate from the flight speed
        glide(v * gWarp * dt);
        s.heading = C.Math.zeroToTwoPi(s.heading + s.rud * clamp(v / 12, -1, 1) * 0.9 * dt);
        s.alt = gnd + 12; // closer to the ground, like a car
      }
      else if (landing === 'up') { s.pitch = 0; s.alt += Math.max(300, (gnd + 3000 - s.alt) * 1.5) * dt; if (s.alt >= gnd + 3000) { landing = null; s.throttle = 0.5; s.v = Math.max(s.v, 400); } }
      viewer.camera.setView({ destination: C.Cartesian3.fromRadians(s.lon, s.lat, s.alt), orientation: { heading: s.heading, pitch: s.pitch, roll: 0 } });
    }
    if (arcade && on) arcadeStep(dt);
    if (on) mpStep(dt);
    if (tut && on) tutStep();
    if (on && race) raceStep();
    if (on && quest()) { capStep(); regStep(); advStep(); } else if (on && race) regStep(); // a race has its item flags whatever the collection switch says // the collection can be switched off to fly just for the views
    if (on && tps()) chaseCam(dt); else chase = null; // last: the game logic above ran with the camera on the ship itself
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
    if (loading) text(T('Cargando el terreno y las banderas…'), cx, cy - 70, 16);
    else if (paused) text(T('PAUSA — Espacio para seguir'), cx, cy - r - 46, 16);
    else if (s.ground) text(T('EN TIERRA'), cx, cy - r - 46, 16);
    else if (s.v < A.vStall * (1 - 0.1 * s.flaps)) text(T('PÉRDIDA — baja la nariz y da gas'), cx, cy - r - 46, 16);
    const satOcc = new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, viewer.camera.positionWC); // behind the Earth: not drawn
    if ($('layerSats').checked) for (const sat of OGE.satellites()) { // live satellites, as bright moving dots when they are in view
      if (!sat.p || OGE.satHidden.has(sat.name) || C.Cartesian3.distance(sat.p, viewer.camera.positionWC) > 2.5e6 || !satOcc.isPointVisible(sat.p)) continue; // only the satellites near the ship, and not the ones shot down
      const q = (C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates)(scene, sat.p);
      if (!q || q.x < 0 || q.y < 0 || q.x > w || q.y > h) continue;
      const sd = C.Cartesian3.distance(sat.p, viewer.camera.positionWC), iss = /ISS|ZARYA/.test(sat.name);
      if (C.Cartesian3.dot(C.Cartesian3.subtract(sat.p, viewer.camera.positionWC, new C.Cartesian3()), viewer.camera.directionWC) < 0) continue; // behind the view
      const fy = h / 2 / Math.tan((viewer.camera.frustum.fovy || rad(60)) / 2), sr = clamp(((iss ? 3000 : 1800) * (arcade ? 5 : 1) * fy) / sd, arcade ? 14 : 3, 220); // in the arcade they are never smaller than a full sprite // drawn as if a couple of km wide: it grows as you fly up to it
      g.save(); g.translate(q.x, q.y);
      if (sr < 7) { g.fillStyle = g.shadowColor = iss ? '#ffd60a' : '#bfe6ff'; g.shadowBlur = 10; g.beginPath(); g.arc(0, 0, sr, 0, 7); g.fill(); }
      else { // body, two solar wings with cells, an antenna dish
        g.translate(-q.x, -q.y); // the solid is placed in the world, not on the sprite's origin
        drawMesh(SAT, foeAxes(sat.p, Math.sin(performance.now() / 3000 + (sat.p.x % 7)) * 0.7), iss ? { h: '#fff3c4', d: '#d4a017', s: '#1f4fa8', w: '#2f6fd8' } : { h: '#eef1f6', d: '#8b93a5', s: '#1f4fa8', w: '#2f6fd8' }, false, meshScale(sat.p, sr * 3.2, h), '#bfe6ff', true);
        g.translate(q.x, q.y);
        g.shadowBlur = 0; g.fillStyle = '#fff'; g.font = `600 ${Math.round(clamp(sr * 0.35, 10, 16))}px sans-serif`; g.textAlign = 'center'; g.fillText(sat.name.slice(0, 24), 0, sr * 0.6 + 16);
      }
      if (iss && sr < 7) { g.fillStyle = '#ffd60a'; g.font = '600 11px sans-serif'; g.fillText('ISS', 6, 4); }
      g.restore();
    }
    if (arcade && airports) { // airfields within ~150 km: land on one (Z) to heal
      const lo = C.Math.toDegrees(s.lon), la = C.Math.toDegrees(s.lat);
      for (const [x, y] of airports) {
        if (Math.abs(y - la) > 1.4 || Math.abs(x - lo) > 1.4 / Math.max(0.2, Math.cos(s.lat))) continue;
        const p = C.Cartesian3.fromDegrees(x, y, (scene.globe.getHeight(C.Cartographic.fromDegrees(x, y)) || 0) + 50), q = (C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates)(scene, p);
        if (!q || q.x < 0 || q.y < 0 || q.x > w || q.y > h || C.Cartesian3.dot(C.Cartesian3.subtract(p, viewer.camera.positionWC, new C.Cartesian3()), viewer.camera.directionWC) < 0) continue;
        g.save(); g.font = '18px sans-serif'; g.textAlign = 'center'; g.fillStyle = g.shadowColor = '#34c759'; g.shadowBlur = 8; g.fillText('🛬', q.x, q.y); g.font = '600 10px sans-serif'; g.fillText('+ VIDA', q.x, q.y + 14); g.restore();
      }
    }
    if (regs && (race ? race.flags : quest())) drawRegs();
    if (caps && quest()) drawCaps();
    if (arcade) drawArcade(w, h, text);
    if (A.ship && !OGE.body) moonHud(w, h);
    if (nav) text(`${T('PILOTO AUTOMÁTICO AL PUNTO DEL MINIMAPA')} · ${Math.round(nav.left / 1000).toLocaleString(OGE_LANG)} km`, cx, cy - r - 28, 14);
    if (auto) text(`${T('PILOTO AUTOMÁTICO A')} ${T(PLACES[auto.to] || 'la superficie').toUpperCase()} · ${T('dispara o esquiva (A D W S) · escudo contra asteroides')}${auto.real || auto.to === 'down' ? '' : ' · ' + Math.max(0, Math.ceil((TRIP_MS - (performance.now() - auto.t0)) / 1000)) + ' s'}`, cx, cy - r - 28, 14);
    const tp3 = tps() && !loading ? drawShip3D(w, h) : null; // while loading the chase camera has not pulled back yet // third person: the ship in 3D and its reticles
    if (p2 || remote) mpDraw(w, h, text);
    if (tut) drawTutorial(w);
    if (touch.id !== null) { const r = Math.min(w, h) * 0.18; g.save(); g.strokeStyle = 'rgba(255,255,255,.6)'; g.lineWidth = 3; g.beginPath(); g.arc(touch.x0, touch.y0, r, 0, 7); g.stroke(); g.fillStyle = 'rgba(127,212,255,.7)'; g.beginPath(); g.arc(touch.x0 + stick.x * r, touch.y0 + stick.y * r, 18, 0, 7); g.fill(); g.restore(); } // the virtual stick
    shots = shots.filter((sh) => performance.now() - sh.t < 220);
    for (const sh of shots) { // two bolts converging on the aim point
      const a = (performance.now() - sh.t) / 220, b = Math.min(1, a + 0.3);
      const col = sh.big ? '#39ff14' : '#ff3b30';
      g.save(); g.strokeStyle = col; g.shadowColor = col; g.shadowBlur = sh.big ? 24 : 12; g.lineWidth = (sh.big ? 12 : 5) * (1 - a) + 1; g.lineCap = 'round';
      if (sh.big) glow(g, sh.x, sh.y, 14 + 40 * a, col);
      const from = tp3 && sh.who === 1 && tp3.tips[0] && tp3.tips[1] ? tp3.tips.map((q) => [q.x, q.y]) : [[cx - w * 0.38, h], [cx + w * 0.38, h]]; // from the wing tips in third person
      for (const [sx, sy] of from) line(sx + (sh.x - sx) * a, sy + (sh.y - sy) * a, sx + (sh.x - sx) * b, sy + (sh.y - sy) * b);
      g.restore();
    }
    if (charge && performance.now() - charge > 200) { // the charge building up: full when it pulses
      const k = Math.min(1, (performance.now() - charge) / CHARGE_MS), at = tp3 && tp3.nose ? tp3.nose : { x: aimMouse ? mouse.x : cx, y: aimMouse ? mouse.y : h / 2 };
      glow(g, at.x, at.y, (6 + 20 * k) * (k < 1 ? 1 : 1 + 0.25 * Math.sin(performance.now() / 45)), k < 1 ? '#b6ff9a' : '#39ff14');
    }
    if (padLock) { const q = objs.includes(padLock) ? (C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates)(scene, padLock.p) : null; // the pad's lock-on: brackets round the enemy the auto-aim will fire at
      if (!q) padLock = null; else { g.save(); g.strokeStyle = '#ff9f0a'; g.lineWidth = 2.5; for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { g.beginPath(); g.moveTo(q.x + sx * 22, q.y + sy * 12); g.lineTo(q.x + sx * 22, q.y + sy * 22); g.lineTo(q.x + sx * 12, q.y + sy * 22); g.stroke(); } g.restore(); } }
    if (lock && performance.now() - lock.t < 600) { g.save(); g.strokeStyle = '#39ff14'; g.lineWidth = 2; g.translate(lock.x, lock.y); g.rotate(Math.PI / 4); g.strokeRect(-11, -11, 22, 22); g.restore(); } // the auto-aim's own mark: a diamond on what it fired at
    if (aimMouse) { // crosshair on the cursor
      g.save(); g.strokeStyle = '#ff3b30'; g.lineWidth = 2; g.beginPath(); g.arc(mouse.x, mouse.y, 14, 0, 7); g.stroke();
      line(mouse.x - 22, mouse.y, mouse.x - 6, mouse.y); line(mouse.x + 6, mouse.y, mouse.x + 22, mouse.y); line(mouse.x, mouse.y - 22, mouse.x, mouse.y - 6); line(mouse.x, mouse.y + 6, mouse.x, mouse.y + 22); g.restore();
    }
    if (!showHud) return;
    const ppd = h / deg(viewer.camera.frustum.fovy || rad(60)), p0 = deg(s.pitch); // pixels per degree of the view

    if (!tps()) { // the cockpit's attitude display is not shown from outside
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

    }
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
    g.strokeRect(cx - bx - 38, cy - 12, 76, 24); text(landing === 'parked' ? Math.round((s.taxi || 0) * gWarp * 3.6) + ' km/h' : spd(s.v * warp), cx - bx, cy + 1, IMPERIAL ? 14 : 12); // the turbo counts as speed; on the ground, the driving speed
    { // turbo gauge under the speed: one segment per turbo level, lit up to the current one, and the real speed in km/h
      const gnd = landing === 'parked', n = gnd ? GWARPS.indexOf(gWarp) : warp > 100 ? WARPS.length - 1 : WARPS.indexOf(warp), sw = 76 / WARPS.length;
      g.save(); WARPS.forEach((_, i) => { g.fillStyle = i <= n ? (i >= 4 ? '#ff453a' : i >= 2 ? '#ffd60a' : '#39ff14') : 'rgba(57,255,20,.18)'; g.fillRect(cx - bx - 38 + i * sw + 1, cy + 18, sw - 2, 8); }); g.restore();
      text(`TURBO ×${gnd ? gWarp : warp}` + (IMPERIAL ? ` · ${num((gnd ? (s.taxi || 0) * gWarp : s.v * warp) * 3.6)} km/h` : ''), cx - bx, cy + 40, 12);
    }
    g.strokeRect(cx + bx - 46, cy - 12, 92, 24); text(high(s.alt), cx + bx, cy + 1, 14);
    text((s.vs >= 0 ? '+' : '') + (IMPERIAL ? Math.round((s.vs * FT * 60) / 10) * 10 + ' FPM' : num(s.vs) + ' m/s'), cx + bx, cy + 26, 12);
    text(T('SUELO ') + high(s.agl), cx + bx, cy + 42, 12);

    // Engine and configuration (bottom left)
    const x0 = 24, y0 = h - 40;
    g.strokeRect(x0, y0 - 100, 14, 100); g.fillRect(x0, y0 - 100 * s.throttle, 14, 100 * s.throttle);
    text(T('GAS ') + Math.round(s.throttle * 100) + '%', x0 + 24, y0 - 92, 12, 'left');
    text(T('FLAPS ') + s.flaps + '/2', x0 + 24, y0 - 74, 12, 'left');
    text(T('TREN ') + T(s.gear ? 'ABAJO' : 'ARRIBA'), x0 + 24, y0 - 56, 12, 'left');
    if (A.gun) { text(`${T('CAÑÓN')} ${ammo}`, x0 + 24, y0 - 72, 12, 'left'); // rounds left, and the tracers on their way
      const toW = C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates; g.save(); g.strokeStyle = '#ffe9a0'; g.shadowColor = '#ff9f0a'; g.shadowBlur = 6; g.lineWidth = 2; g.lineCap = 'round';
      for (const b of rounds) { if (C.Cartesian3.dot(C.Cartesian3.subtract(b.p, viewer.camera.positionWC, new C.Cartesian3()), viewer.camera.directionWC) <= 0) continue; const q = toW(scene, b.p), q0 = toW(scene, new C.Cartesian3(b.p.x - b.v.x * 0.02, b.p.y - b.v.y * 0.02, b.p.z - b.v.z * 0.02)); if (q && q0) line(q0.x, q0.y, q.x, q.y); }
      g.restore(); }
    if (s.brake) text(T('FRENOS'), x0 + 24, y0 - 38, 12, 'left');
    if (Math.abs(s.trim) > 0.01) text(T('COMP ') + (s.trim > 0 ? '+' : '') + s.trim.toFixed(2), x0 + 24, y0 - 20, 12, 'left');

    // Stick and rudder position (bottom center)
    const jx = cx, jy = h - 76, js = 30;
    g.strokeRect(jx - js, jy - js, js * 2, js * 2);
    line(jx - 5 + s.ail * js, jy + s.elev * js, jx + 5 + s.ail * js, jy + s.elev * js); line(jx + s.ail * js, jy - 5 + s.elev * js, jx + s.ail * js, jy + 5 + s.elev * js);
    line(jx - js, jy + js + 8, jx + js, jy + js + 8); g.fillRect(jx + s.rud * js - 3, jy + js + 4, 6, 8);
    text(T(aimMouse ? 'MOUSE: apunta, clic dispara, mantenido carga' : mouseCtl ? 'MOUSE: clic suelta la palanca' : 'TECLADO: clic para volar con el mouse'), cx, h - 22, 12);
    text(A.name.split(' — ')[0], w - 24, h - 22, 12, 'right');
    if (pad.on) text(T('Select: opciones y piloto automático'), w - 24, h - 40, 12, 'right'); // with a pad in hand, its own way to the options
    else if ($('flyBtns').classList.contains('keyboard')) text(T('K: ver los controles'), w - 24, h - 40, 12, 'right');
    if (third && A.ship) text(T('Cámara en tercera persona · Y: volver a primera persona'), w - 24, h - 58, 12, 'right'); // with a keyboard there are no buttons: this is the reminder
  }

  scene.preRender.addEventListener(() => {
    if (!on) return;
    const t = performance.now(), dt = Math.min(0.1, (t - last) / 1000);
    last = t;
    readPad(); // every frame, paused or not: the pad can resume the game and work the menus
    if (loading && (race || tut || t > loading || (t > loading - 5200 && scene.globe.tilesLoaded && (regs || !arcade)))) loading = 0; // the start waits for the terrain in view and the flags: at least 0.8 s, at most 6 s (a race or the tutorial start at once)
    if (!paused && !loading) step(dt);
    if (on) draw();
  });

  // ---------- Inputs ----------
  // ---------- Touch: the left half of the screen is a virtual stick (drag from where the finger lands); a tap on the right half fires ----------
  const touch = { id: null, x0: 0, y0: 0 };
  hud.addEventListener('touchstart', (e) => {
    for (const t of e.changedTouches) {
      const b = hud.getBoundingClientRect(), x = t.clientX - b.left, y = t.clientY - b.top;
      if (x < b.width / 2 && touch.id === null) { Object.assign(touch, { id: t.identifier, x0: x, y0: y }); mouseCtl = true; stick.x = stick.y = 0; }
      else if (x >= b.width / 2 && A && A.ship) { if (aimMouse) { mouse.x = x; mouse.y = y; } fire(); }
    }
    e.preventDefault();
  }, { passive: false });
  hud.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) if (t.identifier === touch.id) {
      const b = hud.getBoundingClientRect(), r = Math.min(b.width, b.height) * 0.18;
      const shape = (v) => { const m = Math.abs(clamp(v, -1, 1)); return m < 0.12 ? 0 : Math.sign(v) * ((m - 0.12) / 0.88) ** 1.7; }; // a small dead zone and a gentle curve: fine control near the middle, full turn at the edge
      stick.x = shape(((t.clientX - b.left - touch.x0) / r) * stickK); stick.y = shape(((t.clientY - b.top - touch.y0) / r) * stickK);
    }
    e.preventDefault();
  }, { passive: false });
  const touchEnd = (e) => { for (const t of e.changedTouches) if (t.identifier === touch.id) { touch.id = null; stick.x = stick.y = 0; } };
  hud.addEventListener('touchend', touchEnd); hud.addEventListener('touchcancel', touchEnd);
  hud.addEventListener('mousemove', (e) => {
    const b = hud.getBoundingClientRect();
    mouse.x = e.clientX - b.left; mouse.y = e.clientY - b.top;
    if (!mouseCtl || aimMouse) return;
    stick.x = clamp((e.clientX - b.left - b.width / 2) / (b.width * 0.3), -1, 1);
    stick.y = clamp((e.clientY - b.top - b.height / 2) / (b.height * 0.3), -1, 1);
  });
  hud.addEventListener('click', () => { if (race && A && A.ship && items.length) return useItem(); if (aimMouse) return; mouseCtl = !mouseCtl; stick.x = stick.y = 0; });
  hud.addEventListener('contextmenu', (e) => e.preventDefault());
  hud.addEventListener('mousedown', (e) => { if (e.button === 2 && on && A.gun) gunHeld = true; }); // the cannon fires while the right button is held
  window.addEventListener('mouseup', () => { gunHeld = false; });
  hud.addEventListener('mousedown', (e) => { if (e.button === 2 || (e.button === 0 && aimMouse && !(race && A && A.ship && items.length))) trigger(false); }); // the right button always fires, the left one when the mouse aims (with a race item in hand it uses the item); held, they charge
  window.addEventListener('mouseup', letGo);
  document.addEventListener('keydown', (e) => {
    if (!on || document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    if (p2 && P2KEYS.has(k)) { if (k === 'enter') fire(2); else keys.add(k); e.preventDefault(); e.stopPropagation(); return; } // player 2's keys
    if (k === 'escape') stop();
    else if (k === 'enter' && !p2) { paused = !paused; last = performance.now(); OGE.toast(paused ? T('Pausa (Intro para seguir)') : T('Sigue el vuelo')); } // Enter (or Space) pauses
    else if (k === ' ' && !(A && A.ship)) { paused = !paused; last = performance.now(); } // the aircraft still pause with Space
    else if (k === ' ') { nextWarp(1); e.preventDefault(); } // on the ship Space raises the turbo
    else if (k === 'shift' && e.code !== 'ShiftRight' && A && A.ship) nextWarp(-1); // left Shift lowers it
    else if (k === 'h') showHud = !showHud;
    else if (k === 'y' && A && A.ship) { third = !third; localStorage.setItem('oge.third', third ? '1' : ''); chase = null; OGE.toast(third ? T('Cámara en tercera persona (Y)') : T('Cámara en primera persona (Y)')); }
    else if (k === 'l') s.gear = !s.gear;
    else if (k === 'u' && race && A.ship) useItem(); // U uses the race item
    else if (k === 'f' && A && A.ship) maneuver('uturn'); // F: turn back (on the ship F has no flaps)
    else if (k === 'f' || k === ']' || k === '[') s.flaps = clamp(s.flaps + (e.shiftKey || k === '[' ? -1 : 1), 0, 2);
    else if (k === 'c' && A.ship && landing) $('flyLift').click(); // C takes off again after landing
    else if (k === 'c') { stick.x = stick.y = 0; s.trim = 0; }
    else if (k === 'q' && A && A.ship && landing !== 'parked' && !e.repeat) { stopped = !stopped; if (!stopped) { s.v = Math.max(s.v, A.v0 || 300); s.throttle = Math.max(s.throttle, 0.5); } } // Q: stop and hover; Q again: fly on
    else if (k === 'b' && A && A.ship) { if (!e.repeat) trigger(true); } // B fires, aiming by itself at the nearest enemy; held, it charges
    else if (k === 'v' && A.ship) bomb(); // V drops a bomb
    else if (k === '+' || k === '=' || k === '-') OGE.minimap.zoom(k === '-' ? -1 : 1);
    else if (k === 'm') OGE.minimap.toggle();
    else if (k === 'n') nextTurn();
    else if (k === 'j') $('flyQuest').click();
    else if (k === 'z') $('flyLand').click();
    else if (k === 'p') setMute(!muted);
    else if (k === 'r' || k === 'x') maneuver(k === 'r' ? 'roll' : 'loop'); // R barrel roll, X loop
    else if (k === 'k') { $('flyKeys').hidden = !$('flyKeys').hidden; $('flyRules').hidden = true; }
    else if (k === 'i') showRules();
    else if (k === 'o') tutorial(true);
    else if ('1234'.includes(k) && A && A.ship) autopilot(k === '4' ? 'down' : DEST[k - 1]); // 4: back down to the surface of this world
    else keys.add(k);
    e.preventDefault(); e.stopPropagation();
  }, true);
  document.addEventListener('keyup', (e) => { const k = e.key.toLowerCase(); keys.delete(k); if (k === 'b') letGo(); }, true);
  window.addEventListener('blur', () => { keys.clear(); charge = 0; });
  const SPACE = 1e5, DEEP = 2e6, HYPER = [1000, 10000, 50000]; // DEEP: above it the flight is a straight line and the ship turns freely // out of the atmosphere: turbo levels only for space, enough to reach the Moon in under a minute
  const levels = () => WARPS; // by hand the turbo ends at ×100 everywhere: the hyper turbo is the autopilot's
  const nextWarp = (d = 1) => { if (auto) return; // the autopilot keeps its own turbo
    if (on && landing === 'parked') { const v = GWARPS[clamp(GWARPS.indexOf(gWarp) + d, 0, GWARPS.length - 1)]; if (v !== gWarp) sfx(v > gWarp ? 'warpUp' : 'warpDown'); gWarp = v; return warpLabel(); }
    const L = levels(); setWarp(L[clamp(L.indexOf(warp) + d, 0, L.length - 1)]); }; // stops at both ends
  let moonAt = null, moonT = 0, spaceMsg = false, deepMsg = false;
  function moonPos() { // the Moon in the Earth's frame at the clock's time: the same place where it is drawn, in step with the sun's light
    if (moonAt && performance.now() < moonT) return moonAt;
    const t = viewer.clock.currentTime, m = C.Transforms.computeIcrfToFixedMatrix(t) || C.Transforms.computeTemeToPseudoFixedMatrix(t);
    moonAt = C.Matrix3.multiplyByVector(m, C.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(t), new C.Cartesian3()); moonT = performance.now() + 2000;
    return moonAt;
  }
  const lin = (a, ka, b, kb) => new C.Cartesian3(a.x * ka + b.x * kb, a.y * ka + b.y * kb, a.z * ka + b.z * kb);
  function glide(d) { // d metres along the heading, as a straight line over the globe. Past a pole the same line goes on down the opposite meridian (70° W becomes 110° E) and the heading turns round by itself
    const P0 = C.Cartesian3.fromRadians(s.lon, s.lat, s.alt), F = axesAt(P0, s.heading, 0, 0).F, P1 = lin(P0, 1, F, d), cg = C.Cartographic.fromCartesian(P1), m = C.Transforms.eastNorthUpToFixedFrame(P1);
    s.lon = cg.longitude; s.lat = cg.latitude; s.heading = Math.atan2(F.x * m[0] + F.y * m[1] + F.z * m[2], F.x * m[4] + F.y * m[5] + F.z * m[6]); // the same direction, read against the east and north of the new place
  }
  let nav = null; // autopilot to a point picked on the minimap { lon, lat, left: metres to go }
  OGE.minimap.pick = (lon, lat) => { // a click on the minimap in flight: the aircraft turns towards that point and holds the course
    if (!on || paused) return false;
    nav = { lon: rad(lon), lat: rad(lat), left: 0 }; OGE.toast(T('Piloto automático al punto del minimapa: A o D lo apagan.')); return true;
  };
  function navStep(dt) {
    const dl = nav.lon - s.lon, brg = Math.atan2(Math.sin(dl) * Math.cos(nav.lat), Math.cos(s.lat) * Math.sin(nav.lat) - Math.sin(s.lat) * Math.cos(nav.lat) * Math.cos(dl));
    nav.left = R * Math.acos(clamp(Math.sin(s.lat) * Math.sin(nav.lat) + Math.cos(s.lat) * Math.cos(nav.lat) * Math.cos(dl), -1, 1));
    const there = nav.left < Math.max(3000, s.v * warp * 0.3);
    if (there || Math.abs(s.rud) > 0.5) { nav = null; return OGE.toast(T(there ? 'Llegaste al punto del minimapa.' : 'Piloto automático apagado.')); } // steering by hand takes the ship back
    s.heading += clamp(C.Math.negativePiToPi(brg - s.heading) * 3, -1, 1) * A.yaw * turn * dt;
  }
  function setAttitude(P, F, U) { // the heading, pitch and roll that put the nose along F and the roof along U at the place P
    const m = C.Transforms.eastNorthUpToFixedFrame(P), along = (i) => F.x * m[i * 4] + F.y * m[i * 4 + 1] + F.z * m[i * 4 + 2]; // the nose along east (0), north (1) and up (2) there
    s.heading = Math.atan2(along(0), along(1)); s.pitch = Math.asin(clamp(along(2), -1, 1));
    const a = axesAt(P, s.heading, s.pitch, 0); s.roll = Math.atan2(C.Cartesian3.dot(U, a.R), C.Cartesian3.dot(U, a.U));
  }
  function freeTurn(dp, dy, dr) { // deep space has no horizon: the ship turns about its own axes (nose up, nose right, right wing down), so it can point anywhere, the Moon included
    const P = C.Cartesian3.fromRadians(s.lon, s.lat, s.alt), a = axesAt(P, s.heading, s.pitch, s.roll);
    const F1 = lin(a.F, Math.cos(dp), a.U, Math.sin(dp)), U1 = lin(a.U, Math.cos(dp), a.F, -Math.sin(dp));
    const F2 = lin(F1, Math.cos(dy), a.R, Math.sin(dy)), R2 = lin(a.R, Math.cos(dy), F1, -Math.sin(dy));
    setAttitude(P, F2, lin(U1, Math.cos(dr), R2, Math.sin(dr)));
  }
  function spaceStep(dt, pe) { // a straight line through space: move along the nose, then express that same attitude in the new place's own east, north and up
    if (!deepMsg) { deepMsg = true; OGE.toast(T(OGE.body ? 'Espacio profundo: la nave gira libremente.' : 'Espacio profundo: la nave gira libremente. Apunta a la Luna para viajar a ella.')); }
    const P0 = C.Cartesian3.fromRadians(s.lon, s.lat, s.alt), a = axesAt(P0, s.heading, pe, s.roll), P1 = C.Cartesian3.add(P0, C.Cartesian3.multiplyByScalar(a.F, s.v * dt * warp, new C.Cartesian3()), new C.Cartesian3());
    const cg = C.Cartographic.fromCartesian(P1);
    s.lon = cg.longitude; s.lat = cg.latitude; s.alt = cg.height;
    if (!man) setAttitude(P1, a.F, a.U); // a maneuver keeps its own attitude until it ends
    const mv = C.Cartesian3.subtract(moonPos(), P0, new C.Cartesian3()), md = C.Cartesian3.dot(mv, a.F), mt = clamp(md, 0, s.v * dt * warp); // the nearest point of this frame's path: at hyper turbo a frame is as long as the Moon is wide
    if (!OGE.body && !paused && C.Cartesian3.magnitudeSquared(mv) - 2 * mt * md + mt * mt < 2e7 ** 2) { // within 20,000 km: the trip goes on over the Moon itself
      arrive('moon');
    }
  }
  const PLACES = { earth: 'la Tierra', moon: 'la Luna', mars: 'Marte', sky: 'el espacio exterior' }, DEST = Object.keys(PLACES).filter((k) => k !== (OGE.body || 'earth')); // the autopilot keys 1, 2 and 3: every place but this one
  [...DEST, 'down'].forEach((d, i) => { const b = document.querySelector(`#flyTL button[data-key="${i + 1}"]`); if (b) b.textContent = '→ ' + T(PLACES[d] || 'la superficie'); });
  function arrive(to) { // the trip goes on over the other world itself; the outer space is the sky view
    paused = true; OGE.toast(`${T('Llegando a')} ${T(PLACES[to])}…`); const u = new URL(location.href);
    if (to === 'earth') u.searchParams.delete('body'); else u.searchParams.set('body', to);
    if (to === 'sky') u.searchParams.delete('land'); else u.searchParams.set('land', '1');
    u.searchParams.delete('play'); setTimeout(() => { location.href = u; }, 1500);
  }
  // Autopilot (keys 1, 2, 3): the ship flies the trip by itself and the pilot only slides sideways to dodge what comes down the path.
  // shortcut: only the Moon seen from the Earth has a real position; every other trip is TRIP_MS straight out. Give the planets an ephemeris if the sky ever shows them.
  const TRIP_MS = 45000;
  let auto = null; // { to, real: towards the real Moon, t0, ox, oy: the dodge, sideways and up from the path, next: when the next enemy comes, speed, dir }
  function endAuto() { if (auto) setWarp(Math.min(100, auto.warp0 || 1)); auto = null; objs = objs.filter((o) => !o.auto); } // the turbo it had comes back
  function autopilot(to) {
    if (!on || !A.ship || paused || !to) return;
    if (auto) { endAuto(); return OGE.toast(T('Piloto automático apagado.')); }
    if (s.alt <= SPACE || landing) return OGE.toast(T('El piloto automático se enciende fuera de la atmósfera.'));
    man = null; incoming = []; objs = objs.filter((o) => o.kind === 'boss' || o.kind === 'crest');
    auto = { to, real: to === 'moon' && !OGE.body, t0: performance.now(), ox: 0, oy: 0, next: performance.now() + 3500, warp0: warp }; setWarp(HYPER[HYPER.length - 1]);
    OGE.toast(`${T('Piloto automático a')} ${T(PLACES[to] || 'la superficie')}: ${T('dispara o esquiva a los enemigos (A D W S); el escudo frena los asteroides. La misma tecla lo apaga.')}`);
  }
  function autoStep(dt) {
    const now = performance.now(), P = C.Cartesian3.fromRadians(s.lon, s.lat, s.alt), a = axesAt(P, s.heading, s.pitch, s.roll), up = C.Cartesian3.normalize(P, new C.Cartesian3()), unit = (v) => C.Cartesian3.normalize(v, v);
    let to = auto.real ? unit(C.Cartesian3.subtract(moonPos(), P, new C.Cartesian3())) : auto.to === 'down' ? C.Cartesian3.negate(up, new C.Cartesian3()) : (auto.dir || (auto.dir = up));
    const down = C.Cartesian3.dot(to, up);
    if (auto.to !== 'down' && down < 0 && C.Cartesian3.magnitude(lin(P, 1, to, -C.Cartesian3.dot(P, to))) < R + 3e5) to = unit(lin(lin(to, 1, up, -down), 1, up, 0.35)); // the Earth is in the way: around it, climbing a little
    if (!auto.speed) auto.speed = auto.real ? Math.max(1e6, C.Cartesian3.distance(P, moonPos()) / 40) : 1e7; // about 40 s to the Moon
    const F = unit(lin(a.F, 1, to, Math.min(1, 2.5 * dt))), go = (auto.to === 'down' ? Math.max(3000, s.alt * 0.6) : auto.speed) * clamp(C.Cartesian3.dot(F, to), 0, 1) ** 4 * Math.min(1, (now - auto.t0) / 3000) * dt; // it turns to its course first, then gathers speed
    const ox = clamp(auto.ox + clamp(s.rud + s.ail, -1, 1) * 1100 * dt, -1400, 1400), oy = clamp(auto.oy + s.elev * 1100 * dt, -900, 900); // the dodge: A D sideways, S up, W down
    const P1 = lin(lin(P, 1, F, go), 1, lin(a.R, ox - auto.ox, a.U, oy - auto.oy), 1), cg = C.Cartographic.fromCartesian(P1);
    auto.ox = ox; auto.oy = oy; s.lon = cg.longitude; s.lat = cg.latitude; s.alt = cg.height; setAttitude(P1, F, a.U);
    if (arcade && now > auto.next) { // they come straight at where the ship is: staying still gets hit
      const rock = Math.random() < 0.4; auto.next = now + 600 + Math.random() * 500;
      objs.push({ kind: rock ? 'wall' : 'enemy', rock, auto: [ox + (Math.random() - 0.5) * 900, oy + (Math.random() - 0.5) * 600, 9000], p: P1, size: 260, look: Math.floor(Math.random() * ENEMY.length), next: Infinity });
    }
    const ax = axesAt(P1, s.heading, s.pitch, s.roll); let hits = 0, rocks = 0;
    objs = objs.filter((o) => {
      if (!o.auto) return true;
      o.auto[2] -= 3200 * dt; o.p = shipPoint(ax, o.auto[0] - ox, o.auto[1] - oy, o.auto[2]);
      if (o.auto[2] > 60) return true;
      if (Math.hypot(o.auto[0] - ox, o.auto[1] - oy) < 300) { booms.push({ p: o.p, t: now }); if (o.rock) rocks++; else hits++; } else gain(pts(20)); // a clean dodge scores
      return false;
    });
    const done = auto.to === 'down' ? s.alt < 4e4 : auto.real ? C.Cartesian3.distance(P1, moonPos()) < 2e7 : now - auto.t0 > TRIP_MS, dest = auto.to;
    if (rocks) { broke = hit = now; sfx('shieldBreak'); } // the trip's shield takes every asteroid
    if (hits) { if (hp - 15 * hits * DIFF[diff].hurt > 1) hurt(15 * hits); else hit = now; } // enemies hurt, but the trip is never the end of the ship
    if (done && on && !paused) { endAuto(); if (dest === 'down') { s.pitch = s.roll = 0; s.v = Math.min(s.v, A.v0 || 600); OGE.toast(T('De vuelta en la atmósfera.')); } else arrive(dest); } // down: levelled out at 40 km, the flight goes on
  }
  function moonHud(w, h) { // where the Moon is and how far, once the ship is high enough to go
    if (s.alt < DEEP && !(auto && auto.real)) return; // not all the time: only out where the ship can be pointed at it, or while the autopilot flies there
    const mp = moonPos(), cam = viewer.camera, v = C.Cartesian3.subtract(mp, cam.positionWC, new C.Cartesian3()), label = `${T('Luna')} · ${Math.round(C.Cartesian3.magnitude(v) / 1000).toLocaleString()} km`;
    const q = C.Cartesian3.dot(v, cam.directionWC) > 0 ? (C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates)(scene, mp) : null;
    g.save(); g.strokeStyle = g.fillStyle = '#e8e8f0'; g.shadowColor = '#000'; g.shadowBlur = 4; g.lineWidth = 2; g.textAlign = 'center'; g.font = '600 13px sans-serif';
    if (q && q.x > 0 && q.y > 0 && q.x < w && q.y < h) { g.beginPath(); g.arc(q.x, q.y, 22, 0, 7); g.stroke(); g.fillText(label, q.x, q.y + 40); }
    else { const a = Math.atan2(-C.Cartesian3.dot(v, cam.upWC), C.Cartesian3.dot(v, cam.rightWC)), r = Math.min(w, h) * 0.36; g.translate(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r); g.fillText(label, 0, -18); g.rotate(a + Math.PI / 2); g.beginPath(); g.moveTo(0, -12); g.lineTo(8, 8); g.lineTo(0, 3); g.lineTo(-8, 8); g.closePath(); g.fill(); } // out of view: an arrow towards it
    g.restore();
  }
  $('flyWarp').onclick = () => nextWarp(1);
  $('flyWarpDown').onclick = () => nextWarp(-1);
  const nextTurn = () => setTurn(TURNS[(TURNS.indexOf(turn) + 1) % TURNS.length] || 1);
  $('flyTurn').onclick = nextTurn;
  const STICKS = [0.5, 0.75, 1, 1.5, 2]; // how far the touch stick answers to the same drag
  let stickK = 1;
  const setStick = (v) => { stickK = v; localStorage.setItem('oge.stickSens', v); $('flyStick').textContent = T('Palanca táctil') + ' ×' + v; $('flyStick').classList.toggle('active', v !== 1); };
  $('flyStick').onclick = () => setStick(STICKS[(STICKS.indexOf(stickK) + 1) % STICKS.length]);
  setStick(STICKS.includes(+localStorage.getItem('oge.stickSens')) ? +localStorage.getItem('oge.stickSens') : 1);
  $('flyMute').onclick = () => setMute(!muted);
  setMute(muted);
  setTurn(TURNS.includes(turn) ? turn : 3);
  $('flyScores').onclick = () => { paused = true; showScores(); };
  const syncQuest = () => { $('flyQuest').textContent = (quest() ? '🚩 ' : '🚫 ') + T('Colección') + ' (J)'; $('flyQuest').classList.toggle('active', quest()); };
  $('flyQuest').onclick = () => { localStorage.setItem('oge.quest', quest() ? '0' : '1'); syncQuest(); OGE.toast(quest() ? 'Colección activada.' : 'Colección desactivada: vuelo libre por las vistas.'); };
  syncQuest();
  const syncSun = () => { $('flySun').textContent = T('Día y noche') + ': ' + T($('layerSun').checked ? 'sí' : 'no'); $('flySun').classList.toggle('active', $('layerSun').checked); }; // the same switch as the layer "Luz del sol", at hand during the flight
  $('flySun').onclick = () => $('layerSun').click();
  $('layerSun').addEventListener('change', syncSun); syncSun(); $('flySun').hidden = !!OGE.body; // the other worlds are drawn without sunlight
  // OpenStarshipEarth: drop straight down to the ground and lift off again
  $('flyLand').onclick = () => { if (!on || !A.ship) return OGE.toast('Aterrizar y despegar son de la OpenStarshipEarth.'); landing = landing ? null : 'down'; sfx(landing ? 'land' : 'liftoff'); };
  $('flyLift').onclick = () => { if (!on || !A.ship) return; landing = 'up'; sfx('liftoff'); };
  $('advBtn').onclick = () => { if (on) stop(); pickAdventure(); };
  $('raceBtn').onclick = () => { if (on) stop(); raceMode(); };
  $('flyReset').onclick = async () => { // start the collection again: flags and capitals collected so far are forgotten
    paused = true;
    const v = await OGE.ask({ title: 'Reiniciar la colección', ok: 'Reiniciar', help: 'Se olvidan las banderas de regiones y las capitales conseguidas. Los puntajes no se borran.', fields: [] });
    if (v) { gotReg.clear(); got.clear(); owed.clear(); localStorage.removeItem(regKey); localStorage.removeItem(CAPS); localStorage.removeItem(OWED); OGE.toast('Colección reiniciada.'); }
    paused = false; last = performance.now();
  };
  $('flyHelp').onclick = () => { $('flyKeys').hidden = !$('flyKeys').hidden; $('flyRules').hidden = true; };
  const showRules = () => { // the tutorial; the game waits while it is open
    $('flyRules').hidden = !$('flyRules').hidden; $('flyKeys').hidden = true;
    if (on) { paused = !$('flyRules').hidden; last = performance.now(); }
  };
  $('flyRulesBtn').onclick = showRules;
  $('flyTutBtn').onclick = () => tutorial(true);
  for (const [id, key] of [['flyUp', 'pageup'], ['flyDown', 'pagedown'], ['flyLeft', 'a'], ['flyRight', 'd']]) { // held down like the keys
    const b = $(id);
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); keys.add(key);
      if (s && key.startsWith('page')) s.throttle = clamp(s.throttle + (key === 'pageup' ? 0.1 : -0.1), 0, 1); // a short tap also counts
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => keys.delete(key));
  }
  $('flyBtn').onclick = open;
  $('mpBtn').onclick = $('flyMp').onclick = multiplayer;
  for (const b of document.querySelectorAll('#flyTL button')) { // phones: landing, take-off and the rest of the keys, top left
    const key = b.dataset.key, up = () => document.dispatchEvent(new KeyboardEvent('keyup', { key }));
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); document.dispatchEvent(new KeyboardEvent('keydown', { key })); if (!b.dataset.hold) setTimeout(up, 80); });
    if (b.dataset.hold) for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, up); // held keys (T: climb)
  }
  for (const b of document.querySelectorAll('#flyActs button')) b.addEventListener('pointerdown', (e) => { e.preventDefault(); const key = b.dataset.key, up = () => document.dispatchEvent(new KeyboardEvent('keyup', { key })); document.dispatchEvent(new KeyboardEvent('keydown', { key })); if (key === 'b') { b.addEventListener('pointerup', up, { once: true }); b.addEventListener('pointercancel', up, { once: true }); } else setTimeout(up, 80); }); // the fire button can be held to charge // the same as their keys
  if (!matchMedia('(pointer: coarse)').matches) { // with a keyboard the key buttons are not needed: only Controls and Scores stay at hand
    $('flyBtns').classList.add('keyboard');
    $('flyKeys').append(Object.assign(document.createElement('li'), { className: 'keyBtns' })); $('flyKeys').lastChild.append($('flyScores'), $('flyFlags'), $('flyArms'), $('flyColors'), $('flyMp'), $('flyReset'), $('flyShip'), $('flySun'), $('flyThird'),
      ...[...DEST, 'down'].map((d) => Object.assign(document.createElement('button'), { type: 'button', className: 'autoDest', textContent: `${T('Piloto automático')} → ${T(PLACES[d] || 'la superficie')}`, onclick: () => { if (pad.menu) padMenu(false); autopilot(d); } }))); // the autopilot can be chosen here as well as with 1, 2, 3 $('flyKeys').style.right = $('flyRules').style.right = '12px'; // no column of buttons beside them // the few actions without a key live in the K panel
  } else { $('flyBtns').classList.add('touch'); document.body.classList.add('touchdev'); } // on a phone the stick steers (left half of the screen): the right column keeps the touch actions and the speed
  $('flyThird').onclick = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y' }));
  $('flyMore').onclick = () => { const more = $('flyBtns').classList.toggle('more'); localStorage.setItem('oge.flyMore', more ? '1' : ''); }; // remembered
  $('flyBtns').classList.toggle('more', !!localStorage.getItem('oge.flyMore'));
  if (OGE.body !== 'sky' && new URLSearchParams(location.search).has('land')) setTimeout(() => { OGE.hideSide(true); if (OGE.body) viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(20, 5, 40000) }); quickShip('arcade');
    const u = new URL(location.href); u.searchParams.delete('land'); history.replaceState(null, '', u); // a reload does not arrive again
    OGE.toast(T(!OGE.body ? 'Has vuelto a la Tierra.' : OGE.body === 'mars' ? 'Has llegado a Marte.' : 'Has llegado a la Luna: busca las banderas de las misiones.')); }, 2500); // arriving from the Earth: straight into the flight
  if (new URLSearchParams(location.search).has('play')) setTimeout(() => { OGE.hideSide(true); $('shipBtn').click(); }, 1500); // the OpenStarshipEarth page opens the game directly
  const lastOpts = () => { try { return JSON.parse(localStorage.getItem('oge.flyOpts')) || {}; } catch { return {}; } };
  function quickShip(mode = 'arcade') { // the OpenStarshipEarth arcade with the options used last time; 'free': no enemies, no goals
    relaunch = () => quickShip(mode);
    adv = null; advShape = null; // a free game is not a stage of the adventure: without this the last stage's borders and goals stayed on
    { const c = viewer.camera.positionCartographic; mpGo({ mode, lon: c.longitude, lat: c.latitude }); }
    const last = lastOpts();
    start('ship', last.mouse ?? true, mode !== 'free', true, mode !== 'free' && !localStorage.getItem('oge.tutorial'), mode === 'free');
  }
  let mpLaunch = false; // the menu was opened by the multiplayer dialog: keep its mode
  $('shipBtn').onclick = async () => { // first the game mode
    if (on) return stop();
    if (!mpLaunch && mpMode === 'local') mpMode = 'solo'; // a normal game starts alone: the second local player stays only for the multiplayer launch
    mpLaunch = false;
    const v = await OGE.ask({ title: '🚀 OpenStarshipEarth', ok: 'Jugar', help: 'Hecho por Alejandro Víctor López Parra @avlopezparra (github)',
      fields: [{ id: 'mode', label: 'Modo de juego', type: 'select', value: localStorage.getItem('oge.shipMode') || 'arcade', options: [
        ['adventure', advDone() ? `🗺 ${T('Aventura: continuar en la etapa')} ${advDone() + 1} (${route()[Math.min(advDone(), route().length - 1)]})` : '🗺 Aventura: países por etapas, banderas y jefe final'],
        ...(advDone() ? [['adventure0', `🗺 ${T('Aventura: empezar de nuevo desde la etapa 1')}`]] : []),
        ['arcade', '🎯 Partida libre con ranking: enemigos, aros, monedas y jefes'],
        ['race', '🏁 De ciudad a ciudad: llega a la meta en el menor tiempo'],
        ['free', '🕊 Vuelo libre: sin enemigos ni objetivos, solo las vistas']] },
        { id: 'model', label: 'Nave (se ve en tercera persona, tecla Y)', type: 'select', value: SHIPS[localStorage.getItem('oge.shipModel')] ? localStorage.getItem('oge.shipModel') : 'dardo', options: Object.entries(SHIPS).map(([k, m]) => [k, m.name]) },
        { id: 'cont', label: 'Continente de la aventura (solo para el modo Aventura)', type: 'select', value: advCont, options: Object.keys(ROUTES).map((k) => [k, `${k} (${ROUTES[k].length} ${T('etapas')})`]) },
        { id: 'diff', label: 'Dificultad (cada una tiene su propio ranking)', type: 'select', value: diff, options: Object.entries(DIFF).map(([k, d]) => [k, d.name]) }] });
    if (!v) return;
    localStorage.setItem('oge.shipMode', v.mode);
    if (DIFF[v.diff]) { diff = v.diff; localStorage.setItem('oge.diff', diff); }
    if (SHIPS[v.model]) localStorage.setItem('oge.shipModel', v.model);
    if (/^adventure/.test(v.mode) && ROUTES[v.cont]) { advCont = v.cont; localStorage.setItem('oge.advCont', advCont); } // the continent only counts for the adventure
    if (OGE.body && /^adventure|^race/.test(v.mode)) { OGE.toast(T('La aventura y las carreras son de la Tierra: aquí, partida libre.')); v.mode = 'arcade'; }
    if (v.mode === 'adventure0') { localStorage.setItem(advKey(), '0'); adventure(0); } else if (v.mode === 'adventure') adventure(); else if (v.mode === 'race') raceMode(); else quickShip(v.mode);
  };
  OGE.flight = { start, stop, maneuver, state: () => s, flying: () => on, game: () => ({ score, coins, objs, hp, bombs, incoming, shields, regs, tut: tut && tut.i, p2, remote }) };
})();
