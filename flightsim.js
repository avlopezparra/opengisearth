// Flight simulator in the style of Earth's: cockpit view with HUD, mouse or keyboard control and two aircraft.
// Mouse: a click grabs or releases the stick; the cursor relative to the center moves it (down = pull = nose up).
// Keyboard: arrows (or W/S) stick · PgUp/PgDn (or E/Q) throttle · A/D (or Shift+←/→) rudder · K key list · F / Shift+F flaps · G gear ·
// A/D also turn (rudder) · T / G turbo up / down · L gear · , . (or B) brakes · Home/End trim · C center · Space pause · H HUD · Esc exit. Starship: X or right click fires.
(() => {
  const C = Cesium, { viewer, $ } = OGE;
  const scene = viewer.scene, rad = C.Math.toRadians, deg = C.Math.toDegrees, clamp = C.Math.clamp;
  const G = 9.81, R = 6371000, KT = 1.94384, FT = 3.28084, GEAR_H = 1.8;
  // vStall/vMax in m/s; thrust: acceleration at full throttle (m/s²); roll/pitch/yaw: maximum angular rates; agl and v0: start
  const PLANES = {
    sr22: { name: 'SR22 — avioneta de hélice, lenta y dócil', vStall: 31, vMax: 95, thrust: 3.2, roll: rad(45), pitch: rad(22), yaw: rad(20), agl: 600, v0: 70 },
    f16: { name: 'F-16 — caza a reacción, rápido y nervioso', vStall: 72, vMax: 420, thrust: 22, roll: rad(130), pitch: rad(38), yaw: rad(18), agl: 1500, v0: 220 },
    // ship: no stall and no gravity (it hovers and climbs to space), bounces off the ground instead of crashing, and fires
    ship: { name: 'Starship — nave muy rápida con láseres; flota y sube al espacio', ship: true, vStall: 0, vMax: 8000, thrust: 400, roll: rad(220), pitch: rad(75), yaw: rad(35), agl: 3000, v0: 600 },
  };
  const hud = $('hud'), g = hud.getContext('2d');
  let on = false, paused = false, mouseCtl = false, showHud = true, A = null, s = null, last = 0;
  const WARPS = [1, 2, 5, 10, 25, 50, 100];
  let warp = 1; // turbo: multiplies the distance covered, to cross long stretches quickly
  const setWarp = (v) => { warp = v; $('flyWarp').textContent = 'Turbo ×' + v + ' ▲ (T)'; $('flyWarp').classList.toggle('active', v > 1); };
  const TURNS = [1, 2, 3, 5];
  let turn = +localStorage.getItem('oge.flyTurn2') || 3; // quick turns by default // multiplies how fast A/D turn
  const setTurn = (v) => { turn = v; localStorage.setItem('oge.flyTurn2', v); $('flyTurn').textContent = T('Giro') + ' ×' + v + ' (N)'; $('flyTurn').classList.toggle('active', v > 1); };
  const keys = new Set(), stick = { x: 0, y: 0 };

  // ---------- Starship lasers: bolts on the HUD, a flash where the aim hits the ground, and a short sound ----------
  let shots = [], audio = null, aimMouse = false; // shots: { t, x, y } on the HUD; aimMouse: lasers follow the cursor
  const mouse = { x: 0, y: 0 };
  function fire() {
    const t = performance.now();
    if (on && !A.ship) return OGE.toast('Disparar y las maniobras son solo de la Starship.');
    if (!on || paused || (shots.length && t - shots[shots.length - 1].t < 110)) return;
    const ax = aimMouse ? mouse.x : hud.clientWidth / 2, ay = aimMouse ? mouse.y : hud.clientHeight / 2; // where the lasers go
    const ray = viewer.camera.getPickRay(new C.Cartesian2(ax, ay)), ground = scene.globe.pick(ray, scene);
    shots.push({ t, x: ax, y: ay });
    if (ground && C.Cartesian3.distance(ground, viewer.camera.positionWC) < 4e5) {
      const e = viewer.entities.add({ position: ground, point: { pixelSize: 16, color: C.Color.ORANGE, outlineColor: C.Color.YELLOW, outlineWidth: 4, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
      e._tmp = true; // not a user feature: never saved
      setTimeout(() => viewer.entities.remove(e), 450);
    }
    beep(1100, 180, 0.16);
    if (!arcade) return;
    const cam = viewer.camera, to = new C.Cartesian3(); // an enemy inside the aim cone is destroyed
    let best = null, bestAng = 9;
    for (const o of objs) {
      if (o.kind !== 'enemy' && o.kind !== 'boss') continue;
      C.Cartesian3.subtract(o.p, cam.positionWC, to);
      const d = C.Cartesian3.magnitude(to), ang = Math.acos(clamp(C.Cartesian3.dot(to, ray.direction) / d, -1, 1));
      if (ang < Math.atan((o.size * 1.5) / d) + rad(1.2) && ang < bestAng) { best = o; bestAng = ang; }
    }
    if (best && best.kind === 'boss') hitBoss(best, 1);
    else if (best) { objs.splice(objs.indexOf(best), 1); score += 100; booms.push({ p: best.p, t: performance.now() }); beep(300, 60, 0.3); }
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
  let noise = null;
  function tone(midi, t, dur, type, vol) {
    const o = audio.createOscillator(), v = audio.createGain();
    o.type = type; o.frequency.value = 440 * 2 ** ((midi - 69) / 12);
    v.gain.setValueAtTime(vol, t); v.gain.setValueAtTime(vol, t + dur * 0.7); v.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(v).connect(master); o.start(t); o.stop(t + dur + 0.02);
  }
  function drum(midi, t) { // 36 kick, 38/40 snare, anything else a hi-hat or cymbal
    if (midi === 35 || midi === 36) {
      const o = audio.createOscillator(), v = audio.createGain();
      o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
      v.gain.setValueAtTime(0.25, t); v.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      return o.connect(v).connect(master), o.start(t), o.stop(t + 0.15);
    }
    if (!noise) { noise = audio.createBuffer(1, audio.sampleRate * 0.3, audio.sampleRate); const ch = noise.getChannelData(0); for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1; }
    const src = audio.createBufferSource(), f = audio.createBiquadFilter(), v = audio.createGain(), snare = midi === 38 || midi === 40, len = snare ? 0.14 : midi === 49 ? 0.3 : 0.05;
    src.buffer = noise; f.type = 'highpass'; f.frequency.value = snare ? 1500 : 7000;
    v.gain.setValueAtTime(snare ? 0.12 : 0.05, t); v.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(f).connect(v).connect(master); src.start(t); src.stop(t + len);
  }
  function music(play) {
    clearInterval(musicTimer); musicTimer = null;
    if (!play || !TH) return;
    try { ac(); } catch { return; } // no audio device
    const u = 60 / TH.bpm / TH.unit, loop = TH.beats * TH.unit, idx = { lead: 0, harmony: 0, bass: 0, drums: 0 }; // u: seconds per stored unit
    let t0 = audio.currentTime + 0.1; // when the current pass of the loop started
    musicTimer = setInterval(() => { // schedules a little ahead of the clock
      const until = (audio.currentTime + 0.3 - t0) / u;
      for (const k of Object.keys(idx)) {
        const n = TH[k];
        while (idx[k] < n.length && n[idx[k]] < until) {
          const at = t0 + n[idx[k]] * u, len = n[idx[k] + 1] * u, pitch = n[idx[k] + 2];
          if (!paused && at > audio.currentTime - 0.05) { if (k === 'drums') drum(pitch, at); else tone(pitch, at, Math.min(len, 1.5), VOICE[k][0], VOICE[k][1]); }
          idx[k] += 3;
        }
      }
      if (until >= loop) { t0 += loop * u; for (const k of Object.keys(idx)) idx[k] = 0; } // next pass
    }, 60);
  }
  const setMute = (v) => { muted = v; localStorage.setItem('oge.mute', v ? '1' : ''); if (master) master.gain.value = v ? 0 : 1; $('flyMute').textContent = (v ? '🔇 ' : '🔊 ') + T('Sonido') + ' (P)'; $('flyMute').classList.toggle('active', v); };

  // ---------- Sprites: enemy craft and bosses drawn once on small canvases (original designs), then scaled on the HUD ----------
  function sprite(size, paint) {
    const cv = Object.assign(document.createElement('canvas'), { width: size, height: size }), c = cv.getContext('2d');
    c.translate(size / 2, size / 2); c.scale(size / 200, size / 200); c.lineJoin = 'round'; // paint in a -100..100 box
    paint(c);
    return cv;
  }
  const poly = (c, pts, fill, stroke) => { c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.fillStyle = fill; c.fill(); if (stroke) { c.strokeStyle = stroke; c.lineWidth = 4; c.stroke(); } };
  const glow = (c, x, y, r, color) => { const gr = c.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, '#fff'); gr.addColorStop(0.4, color); gr.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = gr; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); };
  const ENEMY = [
    sprite(128, (c) => { // dart: swept wings, seen head-on
      poly(c, [[-95, 10], [-30, -8], [0, -38], [30, -8], [95, 10], [40, 22], [0, 40], [-40, 22]], '#8e1b1b', '#ff6b5e');
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

  // ---------- Starship arcade: random enemies to shoot, rings to fly through and coins to collect ----------
  // The objects live in the 3D world and are drawn on the HUD at their projected position and size.
  let arcade = false, objs = [], booms = [], score = 0, coins = 0;
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
    const c = C.Cartographic.fromCartesian(p), floor = (scene.globe.getHeight(c) || 0) + 200;
    if (c.height < floor) C.Cartesian3.fromRadians(c.longitude, c.latitude, floor, undefined, p); // never underground
    objs.push({ kind, p, size: D * 0.06 * SIZE[kind], look: Math.floor(Math.random() * ENEMY.length), next: performance.now() + 3000 + Math.random() * 4000 }); // sized for the speed it was created at; next: when an enemy fires
  }
  function hurt(n) {
    if (shields) { shields--; broke = hit = performance.now(); return beep(1400, 300, 0.2); } // the shield takes the hit and breaks
    hp -= n; hit = performance.now(); beep(200, 80, 0.25);
    if (hp <= 0) stop(`Nave destruida: ${score} puntos y ${coins} monedas.`, true);
  }
  function hitBoss(o, n) { // a boss guards each capital in the arcade: beating it wins the capital
    o.hp -= n; booms.push({ p: o.p, t: performance.now() }); beep(260, 90, 0.2);
    if (o.hp > 0) return;
    objs.splice(objs.indexOf(o), 1); score += 1000; run.bosses++; flash = performance.now(); beep(120, 30, 0.8);
    collect(o.cap);
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
  function arcadeStep(dt) {
    const cam = viewer.camera, t = new C.Cartesian3(), far = reach() * 2.5, eff = s.v * warp, slack = eff * 0.03, now = performance.now(); // slack: distance covered in one frame
    const rolling = man && man.type === 'roll'; // a barrel roll deflects enemies and shots
    objs = objs.filter((o) => {
      C.Cartesian3.subtract(o.p, cam.positionWC, t);
      const d = C.Cartesian3.magnitude(t);
      if (o.kind === 'boss') { if (d < o.size + slack && now - hit > 800 && !rolling) hurt(30); return d < 4e5; } // stays at its capital until left far behind
      if (d < o.size * (o.kind === 'ring' ? 1 : 1.6) + slack) { // touched
        if (o.kind === 'enemy') { if (!rolling) hurt(25); }
        else if (o.kind === 'wall') hurt(20); // obstacles always hurt
        else if (o.kind === 'heart') { hp = Math.min(100, hp + 25); beep(600, 1600, 0.25); }
        else if (o.kind === 'shield') { shields = Math.min(3, shields + 1); beep(500, 1000, 0.25); }
        else if (o.kind === 'bomb') { bombs++; beep(400, 900, 0.25); }
        else {
          score += o.kind === 'ring' ? 50 : 10;
          if (o.kind === 'ring') hp = Math.min(100, hp + 10); // rings repair the ship
          else if (++coins % 25 === 0) bombs++;
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
      const boss = o.kind === 'boss';
      if ((o.kind !== 'enemy' && !boss) || now < o.next) continue;
      o.next = now + (boss ? 1200 + Math.random() * 800 : 4000 + Math.random() * 4000);
      const d = C.Cartesian3.distance(o.p, cam.positionWC), speed = eff * 0.5 + 600, tt = d / (speed + eff);
      if (boss ? d > Math.max(reach() * 1.3, 6e4) : d > reach() * 1.3 || C.Cartesian3.dot(C.Cartesian3.subtract(o.p, cam.positionWC, t), cam.directionWC) < 0) continue;
      const target = C.Cartesian3.add(cam.positionWC, C.Cartesian3.multiplyByScalar(cam.directionWC, eff * tt, new C.Cartesian3()), new C.Cartesian3());
      incoming.push({ p: C.Cartesian3.clone(o.p), vel: C.Cartesian3.multiplyByScalar(C.Cartesian3.subtract(target, o.p, t), 1 / tt, new C.Cartesian3()), t: now });
    }
    incoming = incoming.filter((b) => {
      C.Cartesian3.add(b.p, C.Cartesian3.multiplyByScalar(b.vel, dt, t), b.p);
      if (C.Cartesian3.distance(b.p, cam.positionWC) < 40 + slack * 1.5) { if (!rolling) hurt(8); return false; }
      return now - b.t < 8000;
    });
    while (on && objs.filter((o) => o.kind !== 'boss').length < 10) spawn();
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
      else if (o.kind === 'boss') {
        const R = Math.max(14, pr);
        g.shadowColor = '#ff2df5'; g.shadowBlur = 16; g.drawImage(BOSS, q.x - R * 1.4, q.y - R * 1.4, R * 2.8, R * 2.8);
        g.shadowBlur = 0; g.fillStyle = '#300'; g.fillRect(q.x - 40, q.y - R - 16, 80, 6); g.fillStyle = '#ff453a'; g.fillRect(q.x - 40, q.y - R - 16, (80 * o.hp) / o.max, 6);
        g.fillStyle = '#fff'; g.textAlign = 'center'; g.font = '600 12px sans-serif'; g.fillText(T('Jefe de') + ' ' + o.cap.name, q.x, q.y - R - 22);
      }
      else { const R = Math.max(10, pr * 1.6); g.shadowColor = '#ff453a'; g.drawImage(ENEMY[o.look || 0], q.x - R, q.y - R, R * 2, R * 2); } // enemy craft
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
    const last = (() => { try { return JSON.parse(localStorage.getItem('oge.flyOpts')) || {}; } catch { return {}; } })(); // the dialog remembers the last choices
    const v = await OGE.ask({ title: 'Simulador de vuelo', ok: 'Iniciar vuelo',
      help: 'Arranca en el aire sobre el punto que estás mirando. Mouse: clic toma o suelta la palanca. Teclado: flechas, RePág/AvPág para el gas, L tren, F flaps, Espacio pausa, Esc salir. Starship: X o clic derecho dispara.',
      fields: [{ id: 'plane', label: 'Avión', type: 'select', value: PLANES[last.plane] ? last.plane : 'ship', options: Object.entries(PLANES).map(([k, p]) => [k, p.name]) },
        { id: 'mouse', label: 'Controlar con el mouse (como en Earth)', type: 'checkbox', value: last.mouse ?? true },
        { id: 'arcade', label: 'Starship: modo arcade con enemigos y puntaje (desmárcalo para volar libre)', type: 'checkbox', value: last.arcade ?? true },
        { id: 'aim', label: 'Starship: apuntar los disparos con el mouse (clic dispara; se vuela con el teclado)', type: 'checkbox', value: last.aim ?? false }] });
    if (v) localStorage.setItem('oge.flyOpts', JSON.stringify(v));
    if (v) start(v.plane, v.mouse, v.arcade, v.aim);
  }
  function start(plane, useMouse, useArcade = true, useAim = false) {
    A = PLANES[plane];
    aimMouse = !!A.ship && !!useAim; mouse.x = hud.clientWidth / 2; mouse.y = hud.clientHeight / 2;
    man = null;
    loadCaps();
    loadRegs();
    if (A.ship) OGE.minimap.zoom(99); // the starship starts with the minimap zoomed all the way in
    arcade = !!A.ship && !!useArcade; hp = 100; bombs = 2; incoming = []; flash = hit = 0; shields = 0;
    run = { flags: 0, caps: 0, bosses: 0 };
    music(arcade); objs = []; booms = []; score = coins = 0;
    const la = OGE.lookAt(), c = la ? la.carto : viewer.camera.positionCartographic; // above the look-at point, not from orbit
    const ground = scene.globe.getHeight(c) || 0;
    s = { lon: c.longitude, lat: c.latitude, alt: ground + A.agl, heading: viewer.camera.heading, pitch: 0, roll: 0, v: A.v0, vs: 0,
      throttle: 0.7, flaps: 0, gear: false, brake: false, ail: 0, elev: 0, rud: 0, trim: 0, ground: false, agl: A.agl };
    setWarp(1);
    on = true; paused = false; mouseCtl = !!useMouse && !aimMouse; stick.x = stick.y = 0; keys.clear(); last = performance.now();
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
  function collect(c) {
    got.add(capId(c)); localStorage.setItem(CAPS, JSON.stringify([...got])); run.caps++;
    const [n, all] = capProgress()[c.cont];
    if (arcade) score += 500;
    beep(900, 1800, 0.3);
    OGE.toast(n === all ? `🏆 Logro: todas las capitales de ${c.cont} (${n}).` : `⭐ Capital conseguida: ${c.name} — ${c.cont} ${n}/${all}.`);
  }
  // Free flight: flying close to a capital collects it. Arcade: a boss appears over it and must be beaten first.
  function capStep() {
    if (!caps) return;
    const cam = viewer.camera.positionWC, R = Math.max(5000, s.v * warp * 0.06); // you have to fly close: 5 km, or what is covered in a couple of frames at high speed
    for (const c of caps) {
      if (got.has(capId(c))) continue;
      const d = C.Cartesian3.distance(c.p, cam);
      if (!arcade) { if (d < R) collect(c); continue; }
      if (d > 2e5 || objs.some((o) => o.cap === c)) continue;
      objs.push({ kind: 'boss', cap: c, p: C.Cartesian3.fromDegrees(c.lon, c.lat, 3000), size: 700, hp: 15, max: 15, next: performance.now() + 2500 });
      OGE.toast(`⚠ Jefe de ${c.name}: derrótalo para conseguir la capital.`);
      beep(200, 500, 0.6);
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
      g.save(); g.fillStyle = g.shadowColor = '#e8112d'; g.shadowBlur = 10; g.textAlign = 'center'; g.strokeStyle = '#fff'; g.lineWidth = 2;
      g.font = (d < 3e5 ? 32 : 20) + 'px sans-serif'; g.strokeText('★', q.x, q.y); g.fillText('★', q.x, q.y); g.fillStyle = '#fff';
      g.font = '600 12px sans-serif'; g.fillText(c.name, q.x, q.y + 20); g.restore();
    }
  }
  OGE.minimap.extra = (mg) => { // collected capitals in green, the rest in yellow
    for (const r of regs || []) { // region flags still to collect: small dots, only those inside the map window
      if (gotReg.has(r.id)) continue;
      const [x, y] = OGE.minimap.xy(r.lon, r.lat);
      if (x > 0 && x < 240 && y > 0 && y < 120) { mg.fillStyle = '#7fd4ff'; mg.fillRect(x - 0.75, y - 0.75, 1.5, 1.5); }
    }
    for (const c of caps || []) { // capitals: yellow to collect, green once collected
      const [x, y] = OGE.minimap.xy(c.lon, c.lat);
      mg.fillStyle = got.has(capId(c)) ? '#34c759' : '#ffd60a'; mg.beginPath(); mg.arc(x, y, 2.2, 0, 7); mg.fill();
    }
  };

  // ---------- Region flags: the country's flag over every state or province; countries, continents and the world are achievements ----------
  const REGS = 'oge.regions';
  let regs = null, regsBusy = false; // [{ id, name, a3, country, cont, p, img }]
  const gotReg = new Set((() => { try { return JSON.parse(localStorage.getItem(REGS)) || []; } catch { return []; } })());
  async function loadRegs() {
    if (regs || regsBusy) return;
    regsBusy = true;
    try {
      const get = (p) => fetch(NE + p).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); });
      const [ps, pd, flags] = await Promise.all([get('10m_cultural/ne_10m_admin_1_label_points.shp'), get('10m_cultural/ne_10m_admin_1_label_points.dbf'), OGE.flags()]);
      const clean = (v) => String(v ?? '').replace(/\0/g, '').trim(), seen = new Set(), imgs = new Map(), out = [];
      for (const f of shp.combine([shp.parseShp(ps), shp.parseDbf(pd)]).features) {
        const p = f.properties, id = clean(p.adm1_code), fl = flags.get(clean(p.sr_adm0_a3));
        if (!f.geometry || !id || seen.has(id) || !fl) continue; // the file repeats each region at several scales
        seen.add(id);
        if (!imgs.has(fl.url)) imgs.set(fl.url, Object.assign(new Image(), { src: fl.url }));
        const [lon, lat] = f.geometry.coordinates;
        out.push({ id, lon, lat, name: clean(p.name), a3: fl.a3, country: fl.name, cont: CONT[fl.cont] || 'Islas oceánicas', p: C.Cartesian3.fromDegrees(lon, lat, 1500), img: imgs.get(fl.url) });
      }
      regs = out;
    } catch (e) { OGE.toast('No se pudieron cargar las banderas: ' + e.message, true); }
    regsBusy = false;
  }
  function regStep() { // flying close to a region's flag collects it
    if (!regs) return;
    const cam = viewer.camera.positionWC, R = Math.max(5000, s.v * warp * 0.06); // you have to fly close: 5 km, or what is covered in a couple of frames at high speed
    for (const r of regs) {
      if (gotReg.has(r.id) || C.Cartesian3.distance(r.p, cam) > R) continue;
      gotReg.add(r.id); localStorage.setItem(REGS, JSON.stringify([...gotReg])); run.flags++;
      const all = (fn) => regs.filter(fn).every((x) => gotReg.has(x.id)), mine = regs.filter((x) => x.a3 === r.a3), n = mine.filter((x) => gotReg.has(x.id)).length;
      if (arcade) score += 100;
      beep(1000, 2000, 0.2);
      OGE.toast(all(() => true) ? '🏆 Logro: todas las banderas del mundo.' : all((x) => x.cont === r.cont) ? `🏆 Logro: todas las banderas de ${r.cont}.`
        : n === mine.length ? `🏆 Logro: todas las banderas de ${r.country} (${n}).` : `🚩 Bandera conseguida: ${r.name}, ${r.country} — ${n}/${mine.length}.`);
    }
  }
  function drawRegs() { // the flags still to collect, when near and on this side of the globe
    const toWin = C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates, cam = viewer.camera.positionWC;
    capOcc.cameraPosition = cam;
    for (const r of regs) {
      if (gotReg.has(r.id)) continue;
      const d = C.Cartesian3.distance(r.p, cam);
      if (d > 6e5 || !capOcc.isPointVisible(r.p) || !r.img.complete || !r.img.naturalWidth) continue;
      const q = toWin(scene, r.p);
      if (!q) continue;
      const w = d < 1.5e5 ? 44 : 26, h = (w * r.img.naturalHeight) / r.img.naturalWidth;
      g.save(); g.shadowColor = '#000'; g.shadowBlur = 6; g.drawImage(r.img, q.x - w / 2, q.y - h / 2, w, h);
      if (d < 3e5) { g.fillStyle = '#fff'; g.textAlign = 'center'; g.font = '600 11px sans-serif'; g.fillText(r.name, q.x, q.y + h / 2 + 12); }
      g.restore();
    }
  }

  // Scoreboard: the ten best arcade flights, kept on this computer.
  const SCORES = 'oge.scores', readScores = () => { try { return JSON.parse(localStorage.getItem(SCORES)) || []; } catch { return []; } };
  const showScores = () => OGE.showTable('🏆 Mejores puntajes', ['#', 'Piloto', 'Puntos', 'Monedas', 'Banderas', 'Capitales', 'Jefes', 'Fecha'],
    readScores().map((r, i) => [i + 1, r.name, r.score, r.coins, r.flags ?? 0, r.caps ?? 0, r.bosses ?? 0, r.date]),
    { note: T('Se guardan solo en este equipo.') + (caps ? ' ' + T('Capitales:') + ' ' + Object.entries(capProgress()).map(([k, [n, all]]) => `${n === all ? '🏆 ' : ''}${T(k)} ${n}/${all}`).join(' · ') : '') + (regs ? ' ' + T('Banderas de regiones:') + ' ' + regs.filter((r) => gotReg.has(r.id)).length + '/' + regs.length + '.' : '') });
  async function saveScore(pts, cns) {
    const tally = { ...run }; // the flight may restart while the name is asked
    const v = await OGE.ask({ title: `Puntaje: ${pts} puntos y ${cns} monedas`, ok: 'Guardar', fields: [{ id: 'name', label: 'Tu nombre', value: localStorage.getItem('oge.pilot') || '' }] });
    const name = v && v.name.trim().slice(0, 24);
    if (name) {
      localStorage.setItem('oge.pilot', name);
      localStorage.setItem(SCORES, JSON.stringify([...readScores(), { name, score: pts, coins: cns, ...tally, date: new Date().toISOString().slice(0, 10) }].sort((a, b) => b.score - a.score || b.coins - a.coins).slice(0, 10)));
    }
    showScores();
  }
  function stop(msg, error) {
    on = false;
    music(false);
    if (arcade && !msg && score) msg = `Vuelo terminado: ${score} puntos y ${coins} monedas.`;
    if (arcade && (score || coins)) saveScore(score, coins);
    scene.screenSpaceCameraController.enableInputs = true;
    document.body.classList.remove('flying');
    hud.hidden = true;
    $('flyKeys').hidden = true; $('flyRules').hidden = true;
    $('flyBtn').classList.remove('active');
    viewer.camera.setView({ orientation: { heading: viewer.camera.heading, pitch: Math.min(viewer.camera.pitch, rad(-20)), roll: 0 } }); // level view looking at the ground
    if (msg) OGE.toast(msg, error);
  }

  // ---------- Controls ----------
  function controls(dt) {
    const k = (x) => keys.has(x), ease = Math.min(1, 12 * dt), shift = k('shift'); // quick response to the keys
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
          return stop(`Accidente a ${Math.round(s.v * KT)} nudos.` + (s.gear ? '' : ' El tren estaba arriba (L lo baja).'), true);
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
    if (on) { capStep(); regStep(); }
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
    if (regs) drawRegs();
    if (caps) drawCaps();
    if (arcade) drawArcade(w, h, text);
    shots = shots.filter((sh) => performance.now() - sh.t < 220);
    for (const sh of shots) { // two bolts converging on the aim point
      const a = (performance.now() - sh.t) / 220, b = Math.min(1, a + 0.3);
      g.save(); g.strokeStyle = '#ff3b30'; g.shadowColor = '#ff3b30'; g.shadowBlur = 12; g.lineWidth = 5 * (1 - a) + 1; g.lineCap = 'round';
      for (const sx of [cx - w * 0.38, cx + w * 0.38]) line(sx + (sh.x - sx) * a, h + (sh.y - h) * a, sx + (sh.x - sx) * b, h + (sh.y - h) * b);
      g.restore();
    }
    if (aimMouse) { // crosshair on the cursor
      g.save(); g.strokeStyle = '#ff3b30'; g.lineWidth = 2; g.beginPath(); g.arc(mouse.x, mouse.y, 14, 0, 7); g.stroke();
      line(mouse.x - 22, mouse.y, mouse.x - 6, mouse.y); line(mouse.x + 6, mouse.y, mouse.x + 22, mouse.y); line(mouse.x, mouse.y - 22, mouse.x, mouse.y - 6); line(mouse.x, mouse.y + 6, mouse.x, mouse.y + 22); g.restore();
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
    text(T(aimMouse ? 'MOUSE: apunta, clic dispara' : mouseCtl ? 'MOUSE: clic suelta la palanca' : 'TECLADO: clic para volar con el mouse'), cx, h - 22, 12);
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
    const b = hud.getBoundingClientRect();
    mouse.x = e.clientX - b.left; mouse.y = e.clientY - b.top;
    if (!mouseCtl || aimMouse) return;
    stick.x = clamp((e.clientX - b.left - b.width / 2) / (b.width * 0.3), -1, 1);
    stick.y = clamp((e.clientY - b.top - b.height / 2) / (b.height * 0.3), -1, 1);
  });
  hud.addEventListener('click', () => { if (aimMouse) return fire(); mouseCtl = !mouseCtl; stick.x = stick.y = 0; });
  hud.addEventListener('contextmenu', (e) => e.preventDefault());
  hud.addEventListener('mousedown', (e) => { if (e.button === 2) fire(); }); // right button: fires even where the context menu event is suppressed
  document.addEventListener('keydown', (e) => {
    if (!on || document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') stop();
    else if (k === ' ') { paused = !paused; last = performance.now(); }
    else if (k === 'h') showHud = !showHud;
    else if (k === 'l') s.gear = !s.gear;
    else if (k === 'f' || k === ']' || k === '[') s.flaps = clamp(s.flaps + (e.shiftKey || k === '[' ? -1 : 1), 0, 2);
    else if (k === 'c') { stick.x = stick.y = 0; s.trim = 0; }
    else if (k === 'x') fire();
    else if (k === 'b' && A.ship) bomb();
    else if (k === 't') nextWarp(e.shiftKey ? -1 : 1);
    else if (k === 'g') nextWarp(-1);
    else if (k === '+' || k === '=' || k === '-') OGE.minimap.zoom(k === '-' ? -1 : 1);
    else if (k === 'm') OGE.minimap.toggle();
    else if (k === 'n') nextTurn();
    else if (k === 'p') setMute(!muted);
    else if (k === 'r' || k === 'v' || k === 'u') maneuver(k === 'r' ? 'roll' : k === 'v' ? 'loop' : 'uturn');
    else if (k === 'k') { $('flyKeys').hidden = !$('flyKeys').hidden; $('flyRules').hidden = true; }
    else if (k === 'i') showRules();
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
  $('flyMute').onclick = () => setMute(!muted);
  setMute(muted);
  setTurn(TURNS.includes(turn) ? turn : 3);
  $('flyScores').onclick = () => { paused = true; showScores(); };
  $('flyHelp').onclick = () => { $('flyKeys').hidden = !$('flyKeys').hidden; $('flyRules').hidden = true; };
  const showRules = () => { $('flyRules').hidden = !$('flyRules').hidden; $('flyKeys').hidden = true; }; // how the game is played
  $('flyRulesBtn').onclick = showRules;
  for (const [id, key] of [['flyUp', 'pageup'], ['flyDown', 'pagedown'], ['flyLeft', 'a'], ['flyRight', 'd']]) { // held down like the keys
    const b = $(id);
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); keys.add(key);
      if (s && key.startsWith('page')) s.throttle = clamp(s.throttle + (key === 'pageup' ? 0.1 : -0.1), 0, 1); // a short tap also counts
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => keys.delete(key));
  }
  $('flyBtn').onclick = open;
  OGE.flight = { start, stop, maneuver, state: () => s, flying: () => on, game: () => ({ score, coins, objs, hp, bombs, incoming, shields, regs }) };
})();
