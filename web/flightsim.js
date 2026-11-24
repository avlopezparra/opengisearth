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
  const setWarp = (v) => { if (on && v !== warp) sfx(v > warp ? 'warpUp' : 'warpDown'); warp = v; $('flyWarp').textContent = 'Turbo ×' + v + ' ▲ (T)'; $('flyWarp').classList.toggle('active', v > 1); };
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
    else if (best) { objs.splice(objs.indexOf(best), 1); score += pts(100); booms.push({ p: best.p, t: performance.now() }); sfx('down'); }
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
  // Sound effects: short bell-like phrases (MIDI notes), one per event. [wave, seconds per note, notes]
  const SFX = { coin: ['sine', 0.06, [88, 95]], ring: ['sine', 0.07, [84, 88, 91]], heart: ['sine', 0.09, [79, 84, 88]], shield: ['triangle', 0.09, [72, 79, 84]], bombGet: ['triangle', 0.08, [69, 76, 81]],
    shieldBreak: ['sine', 0.05, [98, 93, 88, 81]], down: ['triangle', 0.05, [76, 72, 67]], flag: ['sine', 0.08, [79, 83, 86]], capital: ['triangle', 0.1, [72, 79, 84, 88]],
    boss: ['triangle', 0.11, [72, 76, 79, 84, 88, 91, 96]], achieve: ['triangle', 0.13, [72, 76, 79, 84, 79, 84, 88, 96]], step: ['sine', 0.08, [84, 91]],
    roll: ['triangle', 0.05, [67, 74, 79, 86, 91]], loop: ['triangle', 0.08, [60, 67, 72, 79, 84, 79, 72]], warpUp: ['sawtooth', 0.05, [60, 72, 84]], warpDown: ['sawtooth', 0.05, [84, 72, 60]], thrust: ['sawtooth', 0.06, [48, 55]] };
  const DIFF = { easy: { name: 'Fácil', hurt: 0.5, fire: 1.6, shot: 0.7, boss: 0.6, pts: 0.5 }, normal: { name: 'Normal', hurt: 1, fire: 1, shot: 1, boss: 1, pts: 1 },
    hard: { name: 'Difícil', hurt: 1.6, fire: 0.6, shot: 1.4, boss: 1.6, pts: 2 }, ace: { name: 'As', hurt: 2.5, fire: 0.4, shot: 1.8, boss: 2.5, pts: 4 } };
  let diff = DIFF[localStorage.getItem('oge.diff')] ? localStorage.getItem('oge.diff') : 'normal';
  const pts = (n) => Math.round(n * DIFF[diff].pts); // points earned scale with the difficulty
  let thrT = 0, landing = null; // landing: 'down' while dropping, 'parked' on the ground, 'up' while lifting off
  const quest = () => localStorage.getItem('oge.quest') !== '0';
  function sfx(name) {
    const d = SFX[name];
    try { ac(); d[2].forEach((n, i) => tone(n, audio.currentTime + i * d[1], d[1] * 2.4, d[0], 0.07)); } catch { /* no audio device */ }
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
  const glow = (c, x, y, r, color) => { const gr = c.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, '#fff'); gr.addColorStop(0.4, color); gr.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = gr; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); };
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
    fortress: { name: 'Fortaleza', hp: 15, every: 1600, shots: 1, color: '#ff2df5', sway: 0 },
    snake: { name: 'Serpiente', hp: 12, every: 2200, shots: 1, color: '#7CFC00', sway: 2600 },
    face: { name: 'Cara gigante', hp: 20, every: 2600, shots: 3, color: '#40e0ff', sway: 0 },
    dragon: { name: 'Dragón', hp: 18, every: 1100, shots: 1, color: '#ff9f0a', sway: 1800 },
    crystal: { name: 'Coloso de cristal', hp: 16, every: 1800, shots: 2, color: '#9fe8ff', sway: 0, shield: true }, // only hurt while its shield is open
    hive: { name: 'Colmena', hp: 14, every: 2600, shots: 1, color: '#ffd23a', sway: 900, spawns: true }, // launches escorts; its core is protected while two or more fly
    beacon: { name: 'Faro', hp: 20, every: 1500, shots: 2, color: '#ff5c5c', sway: 0, phases: true }, // at half life it spins and fires all around
  };
  const bossKind = (name) => Object.keys(BOSSES)[[...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % Object.keys(BOSSES).length];
  function drawBoss(o, x, y, R, now) {
    const t = now / 1000, k = o.type;
    g.shadowColor = BOSSES[k].color; g.shadowBlur = 16; g.lineJoin = 'round';
    if (k === 'fortress') g.drawImage(BOSS, x - R * 1.4, y - R * 1.4, R * 2.8, R * 2.8);
    else if (k === 'crystal') { // a crystal with a dome that opens and closes
      const open = shieldOpen(o, now);
      g.beginPath(); for (let i = 0; i < 6; i++) { const a = (i * Math.PI) / 3 + t * 0.3; g.lineTo(x + R * 1.2 * Math.cos(a), y + R * 1.2 * Math.sin(a)); } g.closePath();
      const gr = g.createLinearGradient(x, y - R, x, y + R); gr.addColorStop(0, '#e9fbff'); gr.addColorStop(1, '#3f8fb8'); g.fillStyle = gr; g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
      g.fillStyle = open ? '#ff2d55' : '#7fb8d8'; g.beginPath(); g.arc(x, y, R * 0.35, 0, 7); g.fill(); // its core, red while exposed
      if (!open) { g.strokeStyle = 'rgba(160,230,255,.8)'; g.lineWidth = 4; g.beginPath(); g.arc(x, y, R * 1.55, 0, 7); g.stroke(); }
    } else if (k === 'hive') { // a honeycomb shell around a core
      for (let i = 0; i < 7; i++) { const a = (i * Math.PI) / 3, cx = i ? x + R * 0.8 * Math.cos(a) : x, cy = i ? y + R * 0.8 * Math.sin(a) : y;
        g.beginPath(); for (let j = 0; j < 6; j++) { const b = (j * Math.PI) / 3 + Math.PI / 6; g.lineTo(cx + R * 0.45 * Math.cos(b), cy + R * 0.45 * Math.sin(b)); } g.closePath();
        g.fillStyle = i ? '#c98a00' : escortsUp(o) >= 2 ? '#7a5200' : '#ff2d55'; g.fill(); g.strokeStyle = '#ffe27a'; g.lineWidth = 2; g.stroke(); }
    } else if (k === 'beacon') { // a tower with a lamp; it spins red when raging
      g.fillStyle = '#d8dbe3'; g.beginPath(); g.moveTo(x - R * 0.45, y + R * 1.2); g.lineTo(x - R * 0.25, y - R * 0.6); g.lineTo(x + R * 0.25, y - R * 0.6); g.lineTo(x + R * 0.45, y + R * 1.2); g.closePath(); g.fill();
      g.fillStyle = '#c0392b'; for (let i = 0; i < 3; i++) g.fillRect(x - R * 0.42 + i * 0.03 * R, y + R * (0.0 + i * 0.4), R * (0.84 - i * 0.06), R * 0.15);
      const ang = t * (o.rage ? 6 : 1.5); g.fillStyle = o.rage ? 'rgba(255,60,60,.35)' : 'rgba(255,240,150,.3)';
      for (const a of [ang, ang + Math.PI]) { g.beginPath(); g.moveTo(x, y - R * 0.8); g.arc(x, y - R * 0.8, R * 3, a - 0.18, a + 0.18); g.closePath(); g.fill(); }
      g.fillStyle = o.rage ? '#ff3b30' : '#fff2a8'; g.beginPath(); g.arc(x, y - R * 0.8, R * 0.25, 0, 7); g.fill();
    }
    else if (k === 'snake') { // a chain of segments undulating behind the head
      for (let i = 9; i >= 0; i--) {
        const sx = x + i * R * 0.42, sy = y + Math.sin(t * 4 + i * 0.7) * R * 0.45, r = R * (0.5 - i * 0.03);
        g.beginPath(); g.arc(sx, sy, r, 0, 7); g.fillStyle = i % 2 ? '#2e7d32' : '#66bb6a'; g.fill(); g.strokeStyle = '#0b3d0b'; g.lineWidth = 2; g.stroke();
        if (!i) { // eyes and tongue
          g.fillStyle = '#ffeb3b'; for (const e of [-1, 1]) { g.beginPath(); g.arc(sx - r * 0.35, sy + e * r * 0.35, r * 0.18, 0, 7); g.fill(); }
          g.strokeStyle = '#ff1744'; g.lineWidth = 3; g.beginPath(); g.moveTo(sx - r, sy); g.lineTo(sx - r * 1.6, sy + Math.sin(t * 12) * r * 0.2); g.stroke();
        }
      }
    } else if (k === 'face') { // a stone face whose mouth opens when it spits
      const open = Math.max(0, 1 - (now - (o.spat || 0)) / 500);
      g.beginPath(); g.ellipse(x, y, R * 1.15, R * 1.4, 0, 0, 7); g.fillStyle = '#8d8f99'; g.fill(); g.strokeStyle = '#3a3c44'; g.lineWidth = 3; g.stroke();
      for (const e of [-1, 1]) {
        g.beginPath(); g.ellipse(x + e * R * 0.45, y - R * 0.35, R * 0.26, R * 0.18, e * 0.3, 0, 7); g.fillStyle = '#111'; g.fill();
        g.beginPath(); g.arc(x + e * R * 0.45, y - R * 0.35, R * 0.09, 0, 7); g.fillStyle = BOSSES.face.color; g.fill();
      }
      g.beginPath(); g.moveTo(x - R * 0.12, y - R * 0.05); g.lineTo(x, y + R * 0.25); g.lineTo(x + R * 0.12, y - R * 0.05); g.strokeStyle = '#3a3c44'; g.stroke();
      g.beginPath(); g.ellipse(x, y + R * 0.7, R * 0.5, R * (0.1 + 0.3 * open), 0, 0, 7); g.fillStyle = open > 0.05 ? BOSSES.face.color : '#111'; g.fill(); g.stroke();
    } else { // dragon: body, head and two flapping wings
      const flap = Math.sin(t * 6) * 0.6;
      for (const e of [-1, 1]) {
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + e * R * 1.9, y - R * (0.9 + flap)); g.lineTo(x + e * R * 1.5, y + R * 0.1); g.lineTo(x + e * R * 1.0, y - R * 0.2 * flap); g.lineTo(x + e * R * 0.6, y + R * 0.35); g.closePath();
        g.fillStyle = '#b71c1c'; g.fill(); g.strokeStyle = '#4a0000'; g.lineWidth = 2; g.stroke();
      }
      g.beginPath(); g.ellipse(x, y + R * 0.1, R * 0.55, R * 0.8, 0, 0, 7); g.fillStyle = '#e53935'; g.fill(); g.stroke();
      g.beginPath(); g.moveTo(x - R * 0.4, y - R * 0.6); g.lineTo(x, y - R * 1.3); g.lineTo(x + R * 0.4, y - R * 0.6); g.closePath(); g.fillStyle = '#c62828'; g.fill(); g.stroke(); // head
      g.fillStyle = '#ffeb3b'; for (const e of [-1, 1]) { g.beginPath(); g.arc(x + e * R * 0.16, y - R * 0.85, R * 0.07, 0, 7); g.fill(); }
    }
  }

  // ---------- Guided tutorial: one task at a time; it explains, waits until the pilot does it, then moves on ----------
  // While it runs nothing spawns at random and nothing hurts. Each step: text, an optional setup (what to put ahead) and a test.
  let tut = null; // { i, ref } while the tutorial runs
  function put(kind, side = 0, up = 0, extra = {}) { // places one object ahead of the ship
    const cam = viewer.camera, D = Math.max(2500, s.v * warp * 3.5), p = C.Cartesian3.clone(cam.positionWC);
    for (const [v, k] of [[cam.directionWC, D], [cam.rightWC, side * D], [cam.upWC, up * D]]) C.Cartesian3.add(p, C.Cartesian3.multiplyByScalar(v, k, new C.Cartesian3()), p);
    const o = { kind, p, size: D * 0.07 * (SIZE[kind] || 1), look: 0, next: 1e15, ...extra };
    objs.push(o);
    return o;
  }
  const has = (kind) => objs.some((o) => o.kind === kind);
  const turned = (a, b) => Math.abs(C.Math.negativePiToPi(a - b));
  const STEPS = [
    { text: 'Dobla a la izquierda y a la derecha con A y D.', test: (r) => turned(s.heading, r.heading) > rad(25) },
    { text: 'Sube y baja la nariz con S y W.', test: (r) => Math.abs(s.pitch - r.pitch) > rad(8) },
    { text: 'Acelera con E y frena con Q.', test: (r) => Math.abs(s.v - r.v) > r.v * 0.3 + 30 },
    { text: 'Ese es un enemigo: apúntale con el centro de la mira y dispara con X o clic derecho.', need: 'enemy', make: () => put('enemy'), test: (r) => score >= r.score + 100 },
    { text: 'Atraviesa el aro: da puntos y repara la nave.', need: 'ring', make: () => put('ring', 0.05), test: (r) => score >= r.score + 50 },
    { text: 'Recoge la moneda, el corazón (vida) y el escudo (absorbe un golpe).', need: 'coin', make: () => { put('coin', -0.08); put('heart'); put('shield', 0.08); }, test: (r) => coins > r.coins },
    { text: 'Los rectángulos grises son obstáculos: esquívalo.', need: 'wall', make: () => put('wall'), test: (r, age) => age > 1500 && !has('wall') },
    { text: 'Haz un tonel con R: desvía disparos y choques.', test: () => !!man && man.type === 'roll' },
    { text: 'Lanza una bomba con B: destruye a todos los enemigos cercanos.', need: 'enemy', make: () => { bombs = Math.max(bombs, 1); put('enemy', -0.1); put('enemy'); put('enemy', 0.1); }, test: (r) => bombs < r.bombs || (r.bombs === 0 && !has('enemy')) },
    { text: 'Un jefe custodia cada capital. Este es de práctica: dispárale hasta vaciar su barra de vida.', need: 'boss', make: () => { const o = put('boss', 0, 0.05, { type: 'fortress', hp: 5, max: 5, cap: null }); o.base = C.Cartesian3.clone(o.p); o.east = viewer.camera.rightWC.clone(); o.size = Math.max(o.size, 400); }, test: (r, age) => age > 1000 && !has('boss') },
    { text: '¡Listo! Ahora colecciona banderas, derrota jefes en las capitales y suma puntos. I: ayuda · O: repetir el tutorial.', test: (r, age) => age > 6000 },
  ];
  const snap = () => ({ heading: s.heading, pitch: s.pitch, v: s.v, score, coins, bombs, t: performance.now() });
  function tutorial(startIt) {
    if (!startIt) { tut = null; return; }
    if (!A || !A.ship) return OGE.toast('El tutorial guiado es para la Starship: elígela al pulsar Volar.');
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

  // ---------- Starship arcade: random enemies to shoot, rings to fly through and coins to collect ----------
  // The objects live in the 3D world and are drawn on the HUD at their projected position and size.
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
    const c = C.Cartographic.fromCartesian(p), floor = (scene.globe.getHeight(c) || 0) + 200;
    if (c.height < floor) C.Cartesian3.fromRadians(c.longitude, c.latitude, floor, undefined, p); // never underground
    objs.push({ kind, p, size: D * 0.06 * SIZE[kind], look: Math.floor(Math.random() * ENEMY.length), next: performance.now() + 3000 + Math.random() * 4000 }); // sized for the speed it was created at; next: when an enemy fires
  }
  function hurt(n) {
    if (tut) { hit = performance.now(); return; } // nothing hurts during the tutorial
    if (shields) { shields--; broke = hit = performance.now(); return sfx('shieldBreak'); } // the shield takes the hit and breaks
    n *= DIFF[diff].hurt;
    hp -= n; hit = performance.now(); beep(200, 80, 0.25);
    if (hp <= 0) {
      [520, 390, 290, 200, 110].forEach((f, i) => setTimeout(() => beep(f, f * 0.55, 0.35), i * 190)); // falling notes: the ship is lost
      stop(`Nave destruida: ${score} puntos y ${coins} monedas.`, true);
    }
  }
  const shieldOpen = (o, now = performance.now()) => !BOSSES[o.type].shield || (now - (o.born || 0)) % 5000 > 3000; // open 2 s out of every 5
  const escortsUp = (o) => objs.filter((x) => x.kind === 'enemy' && x.from === o).length;
  function hitBoss(o, n) { // a boss guards each capital in the arcade: beating it wins the capital
    if (!shieldOpen(o)) { booms.push({ p: o.p, t: performance.now() }); return sfx('shieldBreak'); } // deflected by the crystal shield
    if (BOSSES[o.type].spawns && escortsUp(o) >= 2) { booms.push({ p: o.p, t: performance.now() }); return sfx('shieldBreak'); } // the hive's core is covered
    o.hp -= n; booms.push({ p: o.p, t: performance.now() }); beep(260, 90, 0.2);
    if (o.hp > 0) return;
    objs.splice(objs.indexOf(o), 1); score += pts(1000); run.bosses++; flash = performance.now(); sfx('boss');
    if (o.cap) { // the practice boss of the tutorial guards no capital
      const c = o.cap, fl = flagMap && flagMap.get(c.a3), img = fl && fl.arms ? Object.assign(new Image(), { src: fl.arms }) : null;
      objs.push({ kind: 'crest', cap: c, img, p: C.Cartesian3.fromDegrees(c.lon, c.lat, 5500), size: 900, next: 1e15 });
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
  function arcadeStep(dt) {
    const cam = viewer.camera, t = new C.Cartesian3(), far = reach() * 2.5, eff = s.v * warp, slack = eff * 0.03, now = performance.now(); // slack: distance covered in one frame
    const rolling = man && man.type === 'roll'; // a barrel roll deflects enemies and shots
    objs = objs.filter((o) => {
      C.Cartesian3.subtract(o.p, cam.positionWC, t);
      const d = C.Cartesian3.magnitude(t);
      if (o.kind === 'boss') { // stays at its capital until left far behind
        const sw = BOSSES[o.type].sway; // snakes and dragons weave around their post
        if (sw) C.Cartesian3.add(o.base, C.Cartesian3.multiplyByScalar(o.east, Math.sin(now / 1300) * sw, t), o.p);
        const B = BOSSES[o.type];
        if (B.spawns && now > (o.spawnT || 0) && escortsUp(o) < 3) { // the hive launches an escort near itself
          o.spawnT = now + 4500;
          const p = C.Cartesian3.add(o.p, C.Cartesian3.multiplyByScalar(cam.rightWC, (Math.random() - 0.5) * 2500, new C.Cartesian3()), new C.Cartesian3());
          objs.push({ kind: 'enemy', from: o, look: 2, p, size: 260, next: now + 1500 });
        }
        if (B.phases && o.hp <= o.max / 2 && !o.rage) { o.rage = true; OGE.toast(T('¡El Faro entra en furia!')); sfx('warpUp'); } // second phase
        if (d < o.size + slack && now - hit > 800 && !rolling) hurt(30);
        return d < 4e5;
      }
      const fixed = o.kind === 'crest' || o.kind === 'life'; // these wait where they are instead of being left behind
      if (d < o.size * (o.kind === 'ring' ? 1 : 1.6) + slack) { // touched
        if (o.kind === 'enemy') { if (!rolling) hurt(25); }
        else if (o.kind === 'wall') hurt(20); // obstacles always hurt
        else if (o.kind === 'heart') { hp = Math.min(maxHp, hp + 25); sfx('heart'); }
        else if (o.kind === 'life') { maxHp = Math.min(300, maxHp + 25); hp = maxHp; usedTowns.add(o.town); sfx('achieve'); OGE.toast(`${T('Vida máxima')}: ${maxHp}`); }
        else if (o.kind === 'crest') collect(o.cap); // the coat of arms wins the capital
        else if (o.kind === 'shield') { shields = Math.min(3, shields + 1); sfx('shield'); }
        else if (o.kind === 'bomb') { bombs++; sfx('bombGet'); }
        else {
          score += pts(o.kind === 'ring' ? 50 : 10);
          if (o.kind === 'ring') hp = Math.min(maxHp, hp + 10); // rings repair the ship
          else if (++coins % 25 === 0) bombs++;
          sfx(o.kind); // coin or ring
        }
        return false;
      }
      if (fixed) return d < 4e5;
      const gone = C.Cartesian3.dot(t, cam.directionWC) < -o.size; // left behind
      if (gone && o.kind === 'ring' && on) hurt(5); // a ring that was not flown through costs life
      return !gone && d < far;
    });
    if (!on) return; // destroyed
    for (const o of objs) { // enemies fire at where the ship will be if it keeps flying straight
      const boss = o.kind === 'boss';
      if ((o.kind !== 'enemy' && !boss) || now < o.next) continue;
      o.next = now + DIFF[diff].fire * (boss ? BOSSES[o.type].every * (0.8 + Math.random() * 0.4) : 4000 + Math.random() * 4000);
      const d = C.Cartesian3.distance(o.p, cam.positionWC), speed = (eff * 0.5 + 600) * DIFF[diff].shot, tt = d / (speed + eff);
      if (boss ? d > Math.max(reach() * 1.3, 6e4) : d > reach() * 1.3 || C.Cartesian3.dot(C.Cartesian3.subtract(o.p, cam.positionWC, t), cam.directionWC) < 0) continue;
      const target = C.Cartesian3.add(cam.positionWC, C.Cartesian3.multiplyByScalar(cam.directionWC, eff * tt, new C.Cartesian3()), new C.Cartesian3());
      const n = boss ? (o.rage ? 8 : BOSSES[o.type].shots) : 1; // a volley fans out sideways (a raging beacon fires eight)
      if (boss) o.spat = now;
      for (let i = 0; i < n; i++) {
        const spread = o.rage ? 0.18 : 0.05, aim = C.Cartesian3.add(target, C.Cartesian3.multiplyByScalar(o.rage && i % 2 ? cam.upWC : cam.rightWC, (i - (n - 1) / 2) * d * spread, new C.Cartesian3()), new C.Cartesian3());
        incoming.push({ p: C.Cartesian3.clone(o.p), vel: C.Cartesian3.multiplyByScalar(C.Cartesian3.subtract(aim, o.p, t), 1 / tt, new C.Cartesian3()), t: now, color: boss ? BOSSES[o.type].color : '#ff2df5' });
      }
    }
    incoming = incoming.filter((b) => {
      C.Cartesian3.add(b.p, C.Cartesian3.multiplyByScalar(b.vel, dt, t), b.p);
      if (C.Cartesian3.distance(b.p, cam.positionWC) < 40 + slack * 1.5) { if (!rolling) hurt(8); return false; }
      return now - b.t < 8000;
    });
    while (on && !tut && objs.filter((o) => !['boss', 'crest', 'life'].includes(o.kind)).length < 10) spawn();
  }
  function drawArcade(w, h, text) {
    const f = h / 2 / Math.tan((viewer.camera.frustum.fovy || rad(60)) / 2), toWin = C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates, now = performance.now();
    for (const o of objs) {
      const q = toWin(scene, o.p);
      if (!q) continue; // behind the camera
      const pr = Math.max(4, (o.size / C.Cartesian3.distance(o.p, viewer.camera.positionWC)) * f);
      g.save(); g.shadowBlur = 8; g.beginPath();
      if (o.kind === 'ring') { g.strokeStyle = g.shadowColor = '#ffd60a'; g.lineWidth = Math.max(2, pr * 0.12); g.arc(q.x, q.y, pr, 0, 7); g.stroke(); }
      else if (o.kind === 'coin') { // a flat gold coin spinning on its axis: edge, raised rim, face and a stamped star
        const turn = Math.cos(now / 300), rx = pr * Math.abs(turn) + 0.5, edge = Math.max(1.5, pr * 0.16) * Math.sqrt(1 - turn * turn), side = turn < 0 ? -1 : 1;
        g.shadowColor = '#ffd23a'; g.shadowBlur = 12;
        g.fillStyle = '#a86a00'; g.beginPath(); g.ellipse(q.x + side * edge, q.y, rx, pr, 0, 0, 7); g.fill(); // the edge seen as it turns
        g.fillRect(q.x + Math.min(0, side * edge), q.y - pr, Math.abs(edge), pr * 2);
        g.shadowBlur = 0;
        const rim = g.createLinearGradient(q.x - rx, q.y - pr, q.x + rx, q.y + pr); rim.addColorStop(0, '#fff3b0'); rim.addColorStop(0.5, '#e9a800'); rim.addColorStop(1, '#8a5600');
        g.fillStyle = rim; g.beginPath(); g.ellipse(q.x, q.y, rx, pr, 0, 0, 7); g.fill();
        const face = g.createLinearGradient(q.x - rx, q.y - pr, q.x + rx, q.y + pr); face.addColorStop(0, '#ffe066'); face.addColorStop(1, '#d99a00');
        g.fillStyle = face; g.beginPath(); g.ellipse(q.x, q.y, rx * 0.78, pr * 0.78, 0, 0, 7); g.fill();
        g.save(); g.translate(q.x, q.y); g.scale(Math.max(0.05, rx / pr), 1); g.beginPath(); // the star, squeezed with the turn
        for (let i = 0; i < 10; i++) { const r = (i % 2 ? 0.22 : 0.5) * pr, a = (i * Math.PI) / 5 - Math.PI / 2; g.lineTo(r * Math.cos(a), r * Math.sin(a)); }
        g.closePath(); g.fillStyle = '#b87a00'; g.fill(); g.restore();
        g.fillStyle = 'rgba(255,255,255,.55)'; g.beginPath(); g.ellipse(q.x - rx * 0.3, q.y - pr * 0.45, rx * 0.35, pr * 0.16, -0.4, 0, 7); g.fill(); // shine
      }
      else if (o.kind === 'shield') { g.strokeStyle = g.shadowColor = '#0a84ff'; g.fillStyle = 'rgba(10,132,255,.35)'; g.lineWidth = Math.max(2, pr * 0.15); for (let a = 0; a < 6; a++) g.lineTo(q.x + pr * Math.sin((a * Math.PI) / 3), q.y - pr * Math.cos((a * Math.PI) / 3)); g.closePath(); g.fill(); g.stroke(); }
      else if (o.kind === 'bomb') { g.shadowColor = '#ff9f0a'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = Math.max(12, pr * 2) + 'px sans-serif'; g.fillText('💣', q.x, q.y); }
      else if (o.kind === 'heart' || o.kind === 'life') { // glossy heart; the life booster is green and bigger
        const R = Math.max(10, pr) * (o.kind === 'life' ? 1.5 : 1), gr = g.createLinearGradient(0, q.y - R, 0, q.y + R), life = o.kind === 'life';
        gr.addColorStop(0, life ? '#c9ffb0' : '#ffb3c4'); gr.addColorStop(0.5, life ? '#4fd12e' : '#ff2d55'); gr.addColorStop(1, life ? '#1f7a10' : '#b00030');
        g.shadowColor = life ? '#7dff5a' : '#ff5c7c'; g.shadowBlur = 16; g.fillStyle = gr; g.strokeStyle = '#fff'; g.lineWidth = 2;
        g.moveTo(q.x, q.y + R * 0.9); g.bezierCurveTo(q.x - R * 1.6, q.y - R * 0.2, q.x - R * 0.7, q.y - R * 1.3, q.x, q.y - R * 0.45); g.bezierCurveTo(q.x + R * 0.7, q.y - R * 1.3, q.x + R * 1.6, q.y - R * 0.2, q.x, q.y + R * 0.9); g.fill(); g.stroke();
        g.shadowBlur = 0; g.fillStyle = 'rgba(255,255,255,.55)'; g.beginPath(); g.ellipse(q.x - R * 0.42, q.y - R * 0.5, R * 0.26, R * 0.16, -0.6, 0, 7); g.fill();
        if (life) { g.fillStyle = '#fff'; g.fillRect(q.x - R * 0.42, q.y - R * 0.12, R * 0.84, R * 0.22); g.fillRect(q.x - R * 0.11, q.y - R * 0.42, R * 0.22, R * 0.84); } // a white cross: more life
        if (life) { g.fillStyle = '#fff'; g.textAlign = 'center'; g.font = '600 11px sans-serif'; g.fillText(T('Más vida') + (o.town ? ' · ' + o.town.name : ''), q.x, q.y + R + 14); }
      }
      else if (o.kind === 'wall') { // glass block
        const x = q.x - pr, y = q.y - pr * 0.6, w2 = pr * 2, h2 = pr * 1.2, gr = g.createLinearGradient(0, y, 0, y + h2);
        gr.addColorStop(0, 'rgba(220,240,255,.85)'); gr.addColorStop(0.5, 'rgba(120,180,230,.7)'); gr.addColorStop(1, 'rgba(60,120,190,.8)');
        g.shadowColor = '#bfe6ff'; g.shadowBlur = 12; g.fillStyle = gr; g.strokeStyle = '#fff'; g.lineWidth = 2; g.roundRect(x, y, w2, h2, Math.min(10, pr * 0.2)); g.fill(); g.stroke();
        g.shadowBlur = 0; g.fillStyle = 'rgba(255,255,255,.45)'; g.beginPath(); g.roundRect(x + w2 * 0.06, y + h2 * 0.08, w2 * 0.88, h2 * 0.32, Math.min(8, pr * 0.15)); g.fill();
      }
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
      else { const R = Math.max(10, pr * 1.6); g.shadowColor = ['#ff6b5e', '#7fe3ff', '#e08bff'][o.look || 0]; g.shadowBlur = 18; g.drawImage(ENEMY[o.look || 0], q.x - R, q.y - R, R * 2, R * 2); } // enemy craft
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
      g.save(); g.fillStyle = g.shadowColor = b.color || '#ff2df5'; g.shadowBlur = 10; g.beginPath(); g.arc(q.x, q.y, Math.max(3, (60 / C.Cartesian3.distance(b.p, viewer.camera.positionWC)) * f), 0, 7); g.fill(); g.restore();
    }
    const fade = (t0, ms, color) => { const k = (now - t0) / ms; if (k < 1) { g.save(); g.globalAlpha = 0.5 * (1 - k); g.fillStyle = color; g.fillRect(0, 0, w, h); g.restore(); } };
    fade(flash, 450, '#fff'); fade(hit, 250, broke === hit ? '#0a84ff' : '#f00'); // bomb / shield broken / damage
    if (shields) { g.save(); g.strokeStyle = 'rgba(10,132,255,.55)'; g.lineWidth = 3 * shields; g.beginPath(); g.ellipse(w / 2, h / 2, w * 0.46, h * 0.46, 0, 0, 7); g.stroke(); g.restore(); } // shield around the view, thicker with more layers
    text(`${T('PUNTOS')} ${score}  ·  ${T('MONEDAS')} ${coins}  ·  ${T('BOMBAS')} ${bombs}`, 24, 96, 16, 'left'); // below the heading tape
    g.save(); g.strokeRect(24, 110, 180, 12); g.fillStyle = hp > maxHp / 2 ? '#39ff14' : hp > maxHp / 4 ? '#ffd60a' : '#ff453a'; g.fillRect(24, 110, (180 * Math.max(0, hp)) / maxHp, 12); g.restore();
    text(`${T('VIDA')} ${Math.max(0, Math.round(hp))}/${maxHp}  ·  ${T('ESCUDOS')} ${shields}/3`, 212, 117, 12, 'left');
  }

  async function open() {
    if (on) return stop();
    const last = (() => { try { return JSON.parse(localStorage.getItem('oge.flyOpts')) || {}; } catch { return {}; } })(); // the dialog remembers the last choices
    const v = await OGE.ask({ title: 'Simulador de vuelo', ok: 'Iniciar vuelo',
      help: 'Arranca en el aire sobre el punto que estás mirando. Mouse: clic toma o suelta la palanca. Teclado: flechas, RePág/AvPág para el gas, L tren, F flaps, Espacio pausa, Esc salir. Starship: X o clic derecho dispara.',
      fields: [{ id: 'plane', label: 'Avión', type: 'select', value: PLANES[last.plane] ? last.plane : 'ship', options: Object.entries(PLANES).map(([k, p]) => [k, p.name]) },
        { id: 'mouse', label: 'Controlar con el mouse (como en Earth)', type: 'checkbox', value: last.mouse ?? true },
        { id: 'arcade', label: 'Starship: modo arcade con enemigos y puntaje (desmárcalo para volar libre)', type: 'checkbox', value: last.arcade ?? true },
        { id: 'aim', label: 'Starship: apuntar los disparos con el mouse (clic dispara; se vuela con el teclado)', type: 'checkbox', value: last.aim ?? false },
        { id: 'diff', label: 'Starship: dificultad (cada una tiene su propio ranking)', type: 'select', value: diff, options: Object.entries(DIFF).map(([k, d]) => [k, d.name]) },
        { id: 'quest', label: 'Coleccionar banderas y capitales (desmárcalo para volar solo por las vistas)', type: 'checkbox', value: quest() },
        { id: 'tut', label: 'Starship: hacer el tutorial guiado (va diciendo qué hacer)', type: 'checkbox', value: !localStorage.getItem('oge.tutorial') }] }); // offered ticked the first time
    if (v) localStorage.setItem('oge.flyOpts', JSON.stringify({ ...v, tut: undefined }));
    if (v) { if (DIFF[v.diff]) { diff = v.diff; localStorage.setItem('oge.diff', diff); } localStorage.setItem('oge.quest', v.quest ? '1' : '0'); start(v.plane, v.mouse, v.arcade, v.aim, v.tut); }
  }
  function start(plane, useMouse, useArcade = true, useAim = false, useTut = false) {
    A = PLANES[plane];
    landing = null;
    tut = null;
    aimMouse = !!A.ship && !!useAim; mouse.x = hud.clientWidth / 2; mouse.y = hud.clientHeight / 2;
    man = null;
    loadCaps();
    loadRegs();
    if (A.ship) OGE.minimap.zoom(99); // the starship starts with the minimap zoomed all the way in
    arcade = !!A.ship && !!useArcade; maxHp = 100; usedTowns.clear(); hp = 100; bombs = 2; incoming = []; flash = hit = 0; shields = 0;
    run = { flags: 0, caps: 0, bosses: 0 };
    music(arcade);
    objs = []; booms = []; score = coins = 0;
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
    if (A.ship && useTut) { localStorage.setItem('oge.tutorial', '1'); tutorial(true); music(true); } // once the ship exists
  }
  // ---------- Capitals: a collectible over each national capital; a whole continent is an achievement ----------
  const NE = 'https://raw.githubusercontent.com/avlopezparra/natural-earth-vector/master/', CAPS = 'oge.capitals';
  const CONT = { Africa: 'África', Asia: 'Asia', Europe: 'Europa', 'North America': 'Norteamérica', 'South America': 'Sudamérica', Oceania: 'Oceanía', Antarctica: 'Antártida' };
  let towns = [], flagMap = null; // big cities that are not capitals; country flags and coats of arms
  const usedTowns = new Set(); // life boosters already taken in this flight
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
      const all = shp.combine([shp.parseShp(ps), shp.parseDbf(pd)]).features.filter((f) => f.geometry);
      towns = all.filter((f) => +f.properties.adm0cap !== 1).map((f) => ({ name: clean(f.properties.name), lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], p: C.Cartesian3.fromDegrees(f.geometry.coordinates[0], f.geometry.coordinates[1], 4000) }));
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
    got.add(capId(c)); localStorage.setItem(CAPS, JSON.stringify([...got])); run.caps++;
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
      if (d > 2e5 || objs.some((o) => o.cap === c)) continue; // its boss or its coat of arms is already there
      const type = bossKind(c.name), B = BOSSES[type], base = C.Cartesian3.fromDegrees(c.lon, c.lat, 3000);
      objs.push({ kind: 'boss', born: performance.now(), type, cap: c, base, p: C.Cartesian3.clone(base), east: C.Cartesian3.normalize(C.Cartesian3.cross(C.Cartesian3.UNIT_Z, base, new C.Cartesian3()), new C.Cartesian3()), size: 700, hp: Math.ceil(B.hp * DIFF[diff].boss), max: Math.ceil(B.hp * DIFF[diff].boss), next: performance.now() + 2500 });
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
        out.push({ id, lon, lat, name: clean(p.name), a3: fl.a3, country: fl.name, cont: CONT[fl.cont] || 'Islas oceánicas', p: C.Cartesian3.fromDegrees(lon, lat, 4500), img: imgs.get(fl.url) }); // high enough to be collected without scraping the ground
      }
      regs = out;
    } catch (e) { OGE.toast('No se pudieron cargar las banderas: ' + e.message, true); }
    regsBusy = false;
  }
  function regStep() { // flying close to a region's flag collects it
    if (!regs) return;
    const cam = viewer.camera.positionWC, R = Math.max(5000, s.v * warp * 0.06); // you have to fly close: 5 km, or what is covered in a couple of frames at high speed
    for (const r of regs) {
      if (gotReg.has(r.id)) continue;
      const d = C.Cartesian3.distance(r.p, cam);
      if (!r.onRelief && d < 6e5) { // once its terrain is loaded, the flag floats 2.5 km above the relief (mountains included)
        const h = scene.globe.getHeight(C.Cartographic.fromDegrees(r.lon, r.lat));
        if (h !== undefined) { r.p = C.Cartesian3.fromDegrees(r.lon, r.lat, h * scene.verticalExaggeration + 2500); r.onRelief = true; }
      }
      if (d > R) continue;
      gotReg.add(r.id); localStorage.setItem(REGS, JSON.stringify([...gotReg])); run.flags++;
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
  // One scoreboard per difficulty (the easy one keeps the old key, so earlier scores stay there)
  const scoreKey = (d = diff) => (d === 'normal' ? 'oge.scores' : 'oge.scores.' + d);
  const readScores = (d) => { try { return JSON.parse(localStorage.getItem(scoreKey(d))) || []; } catch { return []; } };
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
  function stop(msg, error) {
    on = false; tut = null;
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
    if ((k('pageup') || k('e')) && s.throttle < 1 && !(thrT > performance.now())) { thrT = performance.now() + 450; sfx('thrust'); } // a whoosh while speeding up
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
    sfx(type === 'roll' ? 'roll' : 'loop');
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
    if (landing && A && A.ship) {
      const gnd = (scene.globe.getHeight(new C.Cartographic(s.lon, s.lat)) || 0) * scene.verticalExaggeration;
      if (landing === 'down') { s.v = Math.min(s.v, 60); s.pitch = 0; s.alt = Math.max(gnd + 30, s.alt - Math.max(400, (s.alt - gnd) * 1.6) * dt); if (s.alt <= gnd + 31) { landing = 'parked'; sfx('down'); OGE.toast('Aterrizaste. Pulsa Despegar (Shift+C) para volver a volar.'); } }
      else if (landing === 'parked') { s.v = 0; s.throttle = 0; s.alt = gnd + 30; s.pitch = 0; }
      else if (landing === 'up') { s.pitch = 0; s.alt += Math.max(300, (gnd + 3000 - s.alt) * 1.5) * dt; if (s.alt >= gnd + 3000) { landing = null; s.throttle = 0.5; s.v = Math.max(s.v, 400); } }
      viewer.camera.setView({ destination: C.Cartesian3.fromRadians(s.lon, s.lat, s.alt), orientation: { heading: s.heading, pitch: s.pitch, roll: 0 } });
    }
    if (arcade && on) arcadeStep(dt);
    if (tut && on) tutStep();
    if (on && quest()) { capStep(); regStep(); } // the collection can be switched off to fly just for the views
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
    if (regs && quest()) drawRegs();
    if (caps && quest()) drawCaps();
    if (arcade) drawArcade(w, h, text);
    if (tut) drawTutorial(w);
    if (touch.id !== null) { const r = Math.min(w, h) * 0.18; g.save(); g.strokeStyle = 'rgba(255,255,255,.6)'; g.lineWidth = 3; g.beginPath(); g.arc(touch.x0, touch.y0, r, 0, 7); g.stroke(); g.fillStyle = 'rgba(127,212,255,.7)'; g.beginPath(); g.arc(touch.x0 + stick.x * r, touch.y0 + stick.y * r, 18, 0, 7); g.fill(); g.restore(); } // the virtual stick
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
      stick.x = clamp((t.clientX - b.left - touch.x0) / r, -1, 1); stick.y = clamp((t.clientY - b.top - touch.y0) / r, -1, 1);
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
    else if (k === 'c' && e.shiftKey) $('flyLift').click();
    else if (k === 'c') { stick.x = stick.y = 0; s.trim = 0; }
    else if (k === 'x') fire();
    else if (k === 'b' && A.ship) bomb();
    else if (k === 't') nextWarp(e.shiftKey ? -1 : 1);
    else if (k === 'g') nextWarp(-1);
    else if (k === '+' || k === '=' || k === '-') OGE.minimap.zoom(k === '-' ? -1 : 1);
    else if (k === 'm') OGE.minimap.toggle();
    else if (k === 'n') nextTurn();
    else if (k === 'j') $('flyQuest').click();
    else if (k === 'z') $('flyLand').click();
    else if (k === 'p') setMute(!muted);
    else if (k === 'r' || k === 'v' || k === 'u') maneuver(k === 'r' ? 'roll' : k === 'v' ? 'loop' : 'uturn');
    else if (k === 'k') { $('flyKeys').hidden = !$('flyKeys').hidden; $('flyRules').hidden = true; }
    else if (k === 'i') showRules();
    else if (k === 'o') tutorial(true);
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
  const syncQuest = () => { $('flyQuest').textContent = (quest() ? '🚩 ' : '🚫 ') + T('Colección') + ' (J)'; $('flyQuest').classList.toggle('active', quest()); };
  $('flyQuest').onclick = () => { localStorage.setItem('oge.quest', quest() ? '0' : '1'); syncQuest(); OGE.toast(quest() ? 'Colección activada.' : 'Colección desactivada: vuelo libre por las vistas.'); };
  syncQuest();
  // Starship: drop straight down to the ground and lift off again
  $('flyLand').onclick = () => { if (!on || !A.ship) return OGE.toast('Aterrizar y despegar son de la Starship.'); landing = landing ? null : 'down'; sfx(landing ? 'warpDown' : 'warpUp'); };
  $('flyLift').onclick = () => { if (!on || !A.ship) return; landing = 'up'; sfx('warpUp'); };
  $('flyReset').onclick = async () => { // start the collection again: flags and capitals collected so far are forgotten
    paused = true;
    const v = await OGE.ask({ title: 'Reiniciar la colección', ok: 'Reiniciar', help: 'Se olvidan las banderas de regiones y las capitales conseguidas. Los puntajes no se borran.', fields: [] });
    if (v) { gotReg.clear(); got.clear(); localStorage.removeItem(REGS); localStorage.removeItem(CAPS); OGE.toast('Colección reiniciada.'); }
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
  $('shipBtn').onclick = () => { // straight into the Starship arcade, with the options used last time
    if (on) return stop();
    let last = {}; try { last = JSON.parse(localStorage.getItem('oge.flyOpts')) || {}; } catch { /* first time */ }
    start('ship', last.mouse ?? true, true, last.aim ?? false, !localStorage.getItem('oge.tutorial'));
  };
  OGE.flight = { start, stop, maneuver, state: () => s, flying: () => on, game: () => ({ score, coins, objs, hp, bombs, incoming, shields, regs, tut: tut && tut.i }) };
})();
