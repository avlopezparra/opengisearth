// Flight simulator in the style of Earth's: cockpit view with HUD, mouse or keyboard control and two aircraft.
// Mouse: a click grabs or releases the stick; the cursor relative to the center moves it (down = pull = nose up).
// Keyboard: arrows (or W/S) stick · PgUp/PgDn (or E/Q) throttle · A/D (or Shift+←/→) rudder · K key list · F / Shift+F flaps · G gear ·
// A/D also turn (rudder) · T / G turbo up / down · L gear · , . (or B) brakes · Home/End trim · C center · Space pause · H HUD · Esc exit. OpenStarshipEarth: X or right click fires.
(() => {
  const C = Cesium, { viewer, $ } = OGE;
  const scene = viewer.scene, rad = C.Math.toRadians, deg = C.Math.toDegrees, clamp = C.Math.clamp;
  const G = 9.81, R = 6371000, KT = 1.94384, FT = 3.28084, GEAR_H = 1.8;
  // vStall/vMax in m/s; thrust: acceleration at full throttle (m/s²); roll/pitch/yaw: maximum angular rates; agl and v0: start
  const PLANES = {
    sr22: { name: 'SR22 — avioneta de hélice, lenta y dócil', vStall: 31, vMax: 95, thrust: 3.2, roll: rad(45), pitch: rad(22), yaw: rad(20), agl: 600, v0: 70 },
    f16: { name: 'F-16 — caza a reacción, rápido y nervioso', vStall: 72, vMax: 420, thrust: 22, roll: rad(130), pitch: rad(38), yaw: rad(18), agl: 1500, v0: 220 },
    // ship: no stall and no gravity (it hovers and climbs to space), bounces off the ground instead of crashing, and fires
    ship: { name: 'OpenStarshipEarth — nave muy rápida con láseres; flota y sube al espacio', ship: true, vStall: 0, vMax: 8000, thrust: 400, roll: rad(220), pitch: rad(75), yaw: rad(35), agl: 3000, v0: 600 },
  };
  const hud = $('hud'), g = hud.getContext('2d');
  let on = false, paused = false, mouseCtl = false, showHud = true, A = null, s = null, last = 0;
  const WARPS = [1, 2, 5, 10, 25, 50, 100];
  let warp = 1; // turbo: multiplies the distance covered, to cross long stretches quickly
  const setWarp = (v) => { if (on && v !== warp) sfx(v > warp ? 'warpUp' : 'warpDown'); warp = v; $('flyWarp').textContent = 'Turbo ×' + v + ' ▲ (Espacio)'; $('flyWarp').classList.toggle('active', v > 1); };
  const TURNS = [1, 2, 3, 5];
  let turn = +localStorage.getItem('oge.flyTurn2') || 3; // quick turns by default // multiplies how fast A/D turn
  const setTurn = (v) => { turn = v; localStorage.setItem('oge.flyTurn2', v); $('flyTurn').textContent = T('Giro') + ' ×' + v + ' (N)'; $('flyTurn').classList.toggle('active', v > 1); };
  const keys = new Set(), stick = { x: 0, y: 0 };

  // ---------- OpenStarshipEarth lasers: bolts on the HUD, a flash where the aim hits the ground, and a short sound ----------
  let shots = [], audio = null, aimMouse = false; // shots: { t, x, y } on the HUD; aimMouse: lasers follow the cursor
  const mouse = { x: 0, y: 0 };
  function fire(who = 1) { // who: 1, or 2 for the local second player (it fires through its own reticle)
    const t = performance.now(), mine = shots.filter((sh) => sh.who === who);
    if (on && !A.ship) return OGE.toast('Disparar y las maniobras son solo de la OpenStarshipEarth.');
    if (!on || paused || (mine.length && t - mine[mine.length - 1].t < 110) || (who === 2 && (!p2 || p2.out || p2.sx == null))) return;
    const ax = who === 2 ? p2.sx : aimMouse ? mouse.x : hud.clientWidth / 2, ay = who === 2 ? p2.sy - p2.R * 1.6 : aimMouse ? mouse.y : hud.clientHeight / 2; // where the lasers go
    const ray = viewer.camera.getPickRay(new C.Cartesian2(ax, ay)), ground = scene.globe.pick(ray, scene);
    shots.push({ t, x: ax, y: ay, who });
    if (arcade) versus(who, ax, ay, ray);
    if (ground && C.Cartesian3.distance(ground, viewer.camera.positionWC) < 4e5) {
      const e = viewer.entities.add({ position: ground, point: { pixelSize: 16, color: C.Color.ORANGE, outlineColor: C.Color.YELLOW, outlineWidth: 4, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
      e._tmp = true; // not a user feature: never saved
      setTimeout(() => viewer.entities.remove(e), 450);
    }
    beep(1100, 180, 0.16);
    if (!arcade) return;
    credit = who; // who scores what this shot destroys
    const cam = viewer.camera, to = new C.Cartesian3(); // an enemy inside the aim cone is destroyed
    let best = null, bestAng = 9, bossHit = null, bossAng = 9;
    for (const o of objs) {
      if (o.kind !== 'enemy' && o.kind !== 'boss' && o.kind !== 'airliner') continue;
      C.Cartesian3.subtract(o.p, cam.positionWC, to);
      const d = C.Cartesian3.magnitude(to), ang = Math.acos(clamp(C.Cartesian3.dot(to, ray.direction) / d, -1, 1));
      if (o.kind === 'boss') { if (ang < Math.atan(o.size / d) + rad(0.4) && ang < bossAng) { bossHit = o; bossAng = ang; } } // a boss only counts when the laser really meets it
      else if (ang < Math.atan((o.size * 1.5) / d) + rad(1.2) && ang < bestAng) { best = o; bestAng = ang; }
    }
    if (!best) best = bossHit; // shots at the enemies around a boss go to those enemies, not to the boss
    if (!best && $('layerSats').checked) for (const sat of OGE.satellites()) { // a satellite hit gives life back and disappears until the page is reloaded
      if (!sat.p || OGE.satHidden.has(sat.name)) continue;
      C.Cartesian3.subtract(sat.p, cam.positionWC, to);
      const d = C.Cartesian3.magnitude(to);
      if (Math.acos(clamp(C.Cartesian3.dot(to, ray.direction) / d, -1, 1)) < rad(1.5)) { OGE.satHidden.add(sat.name); hp = Math.min(maxHp, hp + 25); sfx('heart'); booms.push({ p: sat.p, t: performance.now() }); OGE.toast(`🛰 ${sat.name}: +25 ${T('de vida')}`); return; }
    }
    if (best && best.kind === 'boss') hitBoss(best, 1);
    else if (best && best.kind === 'airliner' && --best.hp > 0) { booms.push({ p: best.p, t: performance.now() }); sfx('shieldBreak'); }
    else if (best && best.kind === 'airliner') { objs.splice(objs.indexOf(best), 1); gain(pts(300)); booms.push({ p: best.p, t: performance.now() }); sfx('down'); }
    else if (best) { objs.splice(objs.indexOf(best), 1); gain(pts(100)); booms.push({ p: best.p, t: performance.now() }); sfx('down'); }
    credit = 1;
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
    race: { idx: 1.5, dec: 0.6, echo: 0.18, bass: 0.5 }, adventure: { idx: 0.8, dec: 1.8, echo: 0.42, bass: 1 }, boss: { idx: 1.2, dec: 1, echo: 0.3, bass: 1 }, main: { idx: 1, dec: 1, echo: 0.28, bass: 1 } };
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
  let tune = null; // the theme playing now: Main Theme or Boss Fight OpenStarshipEarth
  function music(play, th = TH) {
    clearInterval(musicTimer); musicTimer = null; tune = play ? th : null;
    style = th === window.OGE_RACE_THEME ? STYLE.race : th === window.OGE_ADV_THEME ? STYLE.adventure : th === window.OGE_BOSS_THEME ? STYLE.boss : STYLE.main;
    if (musicBus) musicBus.wet.gain.value = style.echo;
    if (!play || !th) return;
    try { ac(); } catch { return; } // no audio device
    const u = 60 / th.bpm / th.unit, loop = th.beats * th.unit, idx = { lead: 0, harmony: 0, bass: 0, drums: 0 }; // u: seconds per stored unit
    let t0 = audio.currentTime + 0.1; // when the current pass of the loop started
    musicTimer = setInterval(() => { // schedules a little ahead of the clock
      const until = (audio.currentTime + 0.3 - t0) / u;
      for (const k of Object.keys(idx)) {
        const n = th[k] || [];
        while (idx[k] < n.length && n[idx[k]] < until) {
          const at = t0 + n[idx[k]] * u, len = n[idx[k] + 1] * u, pitch = n[idx[k] + 2];
          if (!paused && at > audio.currentTime - 0.05) { if (k === 'drums') drum(pitch, at); else fmTone(k, pitch, at, Math.min(len, 1.5)); }
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
  let thrT = 0, boost = null, boostCd = 0, eHeld = false, landing = null; // boost: the ship's single burst on E { t0, base } // landing: 'down' while dropping, 'parked' on the ground, 'up' while lifting off
  let calm = false; // free flight chosen from the mode menu: nothing to collect
  const quest = () => !calm && localStorage.getItem('oge.quest') !== '0';
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
    hand: { name: 'Mano gigante', hp: 16, every: 2200, shots: 1, color: '#ffcc99', sway: 0, grab: true }, // chases the ship and grabs it: a barrel roll (R) breaks free
    beacon: { name: 'Faro', hp: 20, every: 1500, shots: 2, color: '#ff5c5c', sway: 0, phases: true }, // at half life it spins and fires all around
  };
  const SOLO = Object.keys(BOSSES).filter((k) => k !== 'hand'); // the hands come with the stone face
  const bossKind = (name) => SOLO[[...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % SOLO.length];
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
    } else if (k === 'hand') {
      g.save(); if (o.mirror < 0) { g.translate(x * 2, 0); g.scale(-1, 1); } // the left one of a pair is mirrored
      const close = o.held ? 1 : o.phase === 'windup' ? 0 : o.phase === 'lunge' ? 0.6 : 0.25 + 0.2 * Math.sin(t * 4), skin = '#ffcc99', edge = '#8d5a3a';
      if (o.phase === 'windup' || o.phase === 'lunge') { g.fillStyle = 'rgba(255,40,40,.3)'; g.beginPath(); g.arc(x, y, R * (1.8 + 0.2 * Math.sin(t * 20)), 0, 7); g.fill(); } // about to grab
      g.lineCap = 'round'; g.strokeStyle = edge; g.lineWidth = 2;
      g.beginPath(); g.ellipse(x, y + R * 0.2, R * 0.75, R * 0.8, 0, 0, 7); g.fillStyle = skin; g.fill(); g.stroke(); // palm
      for (let i = 0; i < 4; i++) { // fingers: they curl toward the palm as the hand closes
        const fx = x + (i - 1.5) * R * 0.38, len = R * (0.9 + (i === 1 || i === 2 ? 0.2 : 0)), ty = y - R * 0.5 - len * (1 - close), tx = fx + (close * (x - fx)) * 0.3;
        g.beginPath(); g.moveTo(fx, y - R * 0.35); g.quadraticCurveTo(fx, ty, tx, ty + close * R * 0.6); g.strokeStyle = edge; g.lineWidth = R * 0.32; g.stroke(); g.strokeStyle = skin; g.lineWidth = R * 0.24; g.stroke();
        g.fillStyle = '#fff3e6'; g.beginPath(); g.arc(tx, ty + close * R * 0.6, R * 0.08, 0, 7); g.fill(); // nail
      }
      g.beginPath(); g.moveTo(x + R * 0.65, y + R * 0.3); g.quadraticCurveTo(x + R * 1.25, y - R * 0.2 * (1 - close), x + R * (1.1 - close * 0.6), y - R * 0.3); g.strokeStyle = edge; g.lineWidth = R * 0.34; g.stroke(); g.strokeStyle = skin; g.lineWidth = R * 0.26; g.stroke(); // thumb
      g.strokeStyle = 'rgba(141,90,58,.6)'; g.lineWidth = 2; g.beginPath(); g.arc(x, y + R * 0.3, R * 0.4, 3.6, 5.8); g.stroke(); // a palm line
      if (o.held) { g.fillStyle = 'rgba(255,0,0,.25)'; g.beginPath(); g.arc(x, y, R * 1.6, 0, 7); g.fill(); }
      g.restore();
    } else if (k === 'face') { // a stone face whose mouth opens when it spits
      const open = Math.max(0, 1 - (now - (o.spat || 0)) / 500);
      g.beginPath(); g.ellipse(x, y, R * 1.15, R * 1.4, 0, 0, 7); g.fillStyle = '#8d8f99'; g.fill(); g.strokeStyle = '#3a3c44'; g.lineWidth = 3; g.stroke();
      for (const e of [-1, 1]) {
        g.beginPath(); g.ellipse(x + e * R * 0.45, y - R * 0.35, R * 0.26, R * 0.18, e * 0.3, 0, 7); g.fillStyle = '#111'; g.fill();
        g.beginPath(); g.arc(x + e * R * 0.45, y - R * 0.35, R * 0.09, 0, 7); g.fillStyle = BOSSES.face.color; g.fill();
      }
      g.beginPath(); g.moveTo(x - R * 0.12, y - R * 0.05); g.lineTo(x, y + R * 0.25); g.lineTo(x + R * 0.12, y - R * 0.05); g.strokeStyle = '#3a3c44'; g.stroke();
      g.beginPath(); g.ellipse(x, y + R * 0.7, R * 0.5, R * (0.1 + 0.3 * open), 0, 0, 7); g.fillStyle = open > 0.05 ? BOSSES.face.color : '#111'; g.fill(); g.stroke();
    } else { // dragon: a long eastern dragon weaving in an S, with scales, spines, clawed legs, horns, whiskers, a fiery mane and a flaming tail
      const N = 22, pt = (u) => [x + Math.sin(u * 7.5 - t * 2.2) * R * 0.9 * (0.4 + u), y - R * 1.1 + u * R * 3.2]; // u: 0 head … 1 tail
      const tail = pt(1); // flaming tail tip
      for (let j = 0; j < 4; j++) { const a = -Math.PI / 2 + (j - 1.5) * 0.5 + Math.sin(t * 9 + j) * 0.15; g.beginPath(); g.moveTo(tail[0], tail[1]); g.quadraticCurveTo(tail[0] + Math.cos(a) * R * 0.3, tail[1] - Math.sin(a) * R * 0.1 + R * 0.2, tail[0] + Math.cos(a + 1.2) * R * 0.5, tail[1] + R * 0.45); g.strokeStyle = j % 2 ? '#ffb300' : '#ff5722'; g.lineWidth = R * 0.09; g.lineCap = 'round'; g.stroke(); }
      for (const u of [0.3, 0.68]) for (const e of [-1, 1]) { // legs with three claws
        const [lx, ly] = pt(u), fx = lx + e * R * 0.55, fy = ly + R * 0.25;
        g.strokeStyle = '#7f0000'; g.lineWidth = R * 0.1; g.lineCap = 'round'; g.beginPath(); g.moveTo(lx, ly); g.quadraticCurveTo(lx + e * R * 0.4, ly - R * 0.1, fx, fy); g.stroke();
        g.lineWidth = R * 0.04; for (const c of [-0.5, 0, 0.5]) { g.beginPath(); g.moveTo(fx, fy); g.lineTo(fx + e * R * 0.16 * Math.cos(c), fy + R * 0.16 * Math.sin(c) + R * 0.05); g.stroke(); }
      }
      for (let i = N; i >= 1; i--) { // body from tail to neck: scaled segments, belly stripe and back spines
        const u = i / N, [bx, by] = pt(u), r = R * (0.36 - u * 0.26);
        g.beginPath(); g.arc(bx, by, r, 0, 7); g.fillStyle = i % 2 ? '#c62828' : '#e53935'; g.fill(); g.strokeStyle = '#4a0000'; g.lineWidth = 1.5; g.stroke();
        g.beginPath(); g.arc(bx, by + r * 0.2, r * 0.55, 0.2, Math.PI - 0.2); g.strokeStyle = '#ffcc80'; g.lineWidth = Math.max(1, r * 0.25); g.stroke(); // belly
        g.beginPath(); g.moveTo(bx - r * 0.3, by - r * 0.8); g.lineTo(bx, by - r * 1.5); g.lineTo(bx + r * 0.3, by - r * 0.8); g.fillStyle = '#ff8f00'; g.fill(); // spine
      }
      const [hx, hy] = pt(0), face = Math.cos(-t * 2.2) >= 0 ? 1 : -1, jaw = 0.15 + 0.15 * Math.abs(Math.sin(t * 3)); // the head turns with the weave
      for (let j = 0; j < 6; j++) { const a = Math.PI * (0.55 + j * 0.15) * -face + (face < 0 ? Math.PI : 0); g.beginPath(); g.moveTo(hx, hy); g.lineTo(hx + Math.cos(a) * R * 0.75, hy + Math.sin(a) * R * 0.75 - R * 0.1); g.lineTo(hx + Math.cos(a + 0.25) * R * 0.4, hy + Math.sin(a + 0.25) * R * 0.4); g.closePath(); g.fillStyle = j % 2 ? '#ff6f00' : '#ffca28'; g.fill(); } // fiery mane
      g.beginPath(); g.ellipse(hx, hy, R * 0.42, R * 0.32, 0, 0, 7); g.fillStyle = '#d32f2f'; g.fill(); g.strokeStyle = '#4a0000'; g.lineWidth = 2; g.stroke(); // skull
      g.beginPath(); g.moveTo(hx + face * R * 0.2, hy - R * 0.2); g.lineTo(hx + face * R * 0.95, hy - R * 0.08); g.lineTo(hx + face * R * 0.9, hy + R * 0.02); g.lineTo(hx + face * R * 0.2, hy + R * 0.05); g.closePath(); g.fillStyle = '#e53935'; g.fill(); g.stroke(); // upper snout
      g.beginPath(); g.moveTo(hx + face * R * 0.2, hy + R * 0.1); g.lineTo(hx + face * R * 0.8, hy + R * (0.1 + jaw)); g.lineTo(hx + face * R * 0.2, hy + R * 0.25); g.closePath(); g.fillStyle = '#b71c1c'; g.fill(); g.stroke(); // lower jaw
      g.fillStyle = '#fff'; for (let j = 0; j < 3; j++) { const tx = hx + face * R * (0.4 + j * 0.15); g.beginPath(); g.moveTo(tx, hy + R * 0.04); g.lineTo(tx + face * R * 0.04, hy + R * 0.12); g.lineTo(tx + face * R * 0.08, hy + R * 0.04); g.fill(); } // teeth
      g.strokeStyle = '#ffe082'; g.lineWidth = R * 0.05; for (const e of [0, 1]) { g.beginPath(); g.moveTo(hx - face * R * 0.15, hy - R * 0.25); g.quadraticCurveTo(hx - face * R * (0.5 + e * 0.15), hy - R * (0.6 + e * 0.1), hx - face * R * (0.75 + e * 0.1), hy - R * (0.45 + e * 0.2)); g.stroke(); } // horns
      g.strokeStyle = '#ffccbc'; g.lineWidth = 1.5; for (const e of [-1, 1]) { g.beginPath(); g.moveTo(hx + face * R * 0.85, hy - R * 0.04); g.bezierCurveTo(hx + face * R * 1.2, hy + e * R * 0.3, hx + face * R * 1.3, hy + e * R * 0.5 + Math.sin(t * 5) * R * 0.1, hx + face * R * 1.55, hy + e * R * 0.35); g.stroke(); } // whiskers
      g.fillStyle = '#ffeb3b'; g.beginPath(); g.ellipse(hx + face * R * 0.15, hy - R * 0.12, R * 0.09, R * 0.06, 0, 0, 7); g.fill(); g.fillStyle = '#000'; g.beginPath(); g.arc(hx + face * R * 0.17, hy - R * 0.12, R * 0.03, 0, 7); g.fill(); // eye
      if (now - (o.spat || 0) < 400) { g.fillStyle = 'rgba(255,140,0,.8)'; g.beginPath(); g.moveTo(hx + face * R * 0.9, hy + R * 0.05); g.lineTo(hx + face * R * 1.9, hy - R * 0.3); g.lineTo(hx + face * R * 1.9, hy + R * 0.4); g.closePath(); g.fill(); } // fire breath when it shoots
    }
  }

  // ---------- Guided tutorial: one task at a time; it explains, waits until the pilot does it, then moves on ----------
  // While it runs nothing spawns at random and nothing hurts. Each step: text, an optional setup (what to put ahead) and a test.
  let tut = null; // { i, ref } while the tutorial runs
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
    { text: 'Acelera con E y frena con Q.', test: (r) => Math.abs(s.v - r.v) > r.v * 0.3 + 30 },
    { text: 'Ese es un enemigo: apúntale con el centro de la mira y dispara con B o clic derecho.', need: 'enemy', make: () => put('enemy'), test: (r) => score >= r.score + 100 },
    { text: 'Atraviesa el aro: da puntos y repara la nave.', need: 'ring', make: () => put('ring', 0.05), test: (r) => score >= r.score + 50 },
    { text: 'Recoge la moneda, el corazón (vida) y el escudo (absorbe un golpe).', need: 'coin', make: () => { put('coin', -0.08); put('heart'); put('shield', 0.08); }, test: (r) => coins > r.coins },
    { text: 'Los rectángulos grises son obstáculos: esquívalo.', need: 'wall', make: () => put('wall'), test: (r, age) => age > 1500 && !has('wall') },
    { text: 'Haz un tonel con R: desvía disparos y choques.', test: () => !!man && man.type === 'roll' },
    { text: 'Lanza una bomba con V: destruye a todos los enemigos cercanos.', need: 'enemy', make: () => { bombs = Math.max(bombs, 1); put('enemy', -0.1); put('enemy'); put('enemy', 0.1); }, test: (r) => bombs < r.bombs || (r.bombs === 0 && !has('enemy')) },
    { text: 'Un jefe custodia cada capital. Este es de práctica: dispárale hasta vaciar su barra de vida.', need: 'boss', make: () => { const o = put('boss', 0, 0.05, { type: 'fortress', hp: 5, max: 5, cap: null }); o.base = C.Cartesian3.clone(o.p); o.east = viewer.camera.rightWC.clone(); o.size = Math.max(o.size, 400); }, test: (r, age) => age > 1000 && !has('boss') },
    { text: '¡Listo! Ahora colecciona banderas, derrota jefes en las capitales y suma puntos. I: ayuda · O: repetir el tutorial.', test: (r, age) => age > 6000 },
  ];
  const snap = () => ({ heading: s.heading, pitch: s.pitch, v: s.v, score, coins, bombs, t: performance.now() });
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
    objs.push({ kind, big, p, size: D * 0.06 * SIZE[kind] * (big ? 2.5 : 1), look: Math.floor(Math.random() * ENEMY.length), next: performance.now() + 3000 + Math.random() * 4000 }); // sized for the speed it was created at; next: when an enemy fires
  }
  function hurt(n) {
    if (tut || performance.now() < graceT) { hit = performance.now(); return; } // nothing hurts during the tutorial or the grace time
    if (shields) { shields--; broke = hit = performance.now(); return sfx('shieldBreak'); } // the shield takes the hit and breaks
    n *= DIFF[diff].hurt;
    hp -= n; hit = performance.now(); beep(200, 80, 0.25);
    if (hp <= 0) {
      mpSend({ t: 'dead' });
      [520, 390, 290, 200, 110].forEach((f, i) => setTimeout(() => beep(f, f * 0.55, 0.35), i * 190)); // falling notes: the ship is lost
      stop(`Nave destruida: ${score} puntos y ${coins} monedas.`, true);
    }
  }
  const shieldOpen = (o, now = performance.now()) => !BOSSES[o.type].shield || (now - (o.born || 0)) % 5000 > 3000; // open 2 s out of every 5
  const escortsUp = (o) => objs.filter((x) => x.kind === 'enemy' && x.from === o).length;
  function hitBoss(o, n) { // a boss guards each capital in the arcade: beating it wins the capital
    if (!shieldOpen(o)) { booms.push({ p: o.p, t: performance.now() }); return sfx('shieldBreak'); } // deflected by the crystal shield
    if (BOSSES[o.type].spawns && escortsUp(o) >= 2) { booms.push({ p: o.p, t: performance.now() }); return sfx('shieldBreak'); } // the hive's core is covered
    o.hp -= n; booms.push({ p: o.p, t: performance.now() }); beep(260, 90, 0.2); sfx('bossHit'); // a metallic clang for every hit
    if (o.hp > 0) return;
    objs.splice(objs.indexOf(o), 1); gain(pts(o.from ? 300 : 1000)); if (!o.from) run.bosses++; flash = performance.now(); sfx('boss');
    if (o.type === 'face') objs = objs.filter((x) => { if (x.from !== o) return true; booms.push({ p: x.p, t: performance.now() }); return false; }); // its hands fall with it
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
    if (tune) { const BT = window.OGE_BOSS_THEME, near = BT && objs.some((o) => o.kind === 'boss' && C.Cartesian3.distance(o.p, viewer.camera.positionWC) < 3e4), base = (adv && window.OGE_ADV_THEME) || (race && window.OGE_RACE_THEME) || TH, want = near ? BT : base; if (want !== tune) music(true, want); } // Boss Fight OpenStarshipEarth while a boss is close
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
          else if (o.phase === 'hover') { o.met = o.met || now; toward(ahead, chase); if (seen && now - o.met > 6000 && now - o.pt > 4000 + Math.random() * 2000 && now > graceT) { o.phase = 'windup'; o.pt = now; sfx('warpDown'); OGE.toast(T('¡La mano va a atacar! Prepara un tonel (R).')); } } // first it shows itself for a while
          else if (o.phase === 'windup') { toward(ahead, chase); if (now - o.pt > 1500) { o.phase = 'lunge'; o.pt = now; } } // 1.5 s of warning
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
          const p = C.Cartesian3.clone(o.base); // a slow bob and drift for everyone; snakes and dragons weave wider
          C.Cartesian3.add(p, C.Cartesian3.multiplyByScalar(up, Math.sin(now / 900) * 400, t), p);
          C.Cartesian3.add(p, C.Cartesian3.multiplyByScalar(o.east, Math.sin(now / 1300) * (sw || 600), t), p);
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
      const fixed = o.kind === 'crest' || o.kind === 'life' || o.kind === 'airliner' || o.kind === 'itembox' || o.kind === 'mine'; // these wait where they are instead of being left behind
      if (o.kind === 'ring') {
        const along = C.Cartesian3.dot(t, cam.directionWC), side = Math.sqrt(Math.max(0, d * d - along * along)), was = o.along; o.along = along;
        if (was > 0 && along <= 0 && side < o.size * 1.15) { // crossed its plane this frame
          if (side < o.size * 0.85) { score += pts(o.big ? 30 : 50); hp = Math.min(maxHp, hp + 10); sfx('ring'); } // through the middle: points and repair
          else if (!rolling) hurt(15); // clipped the rim
          return false;
        }
      }
      else if (d < o.size * 1.6 + slack) { // touched
        if (o.kind === 'enemy' || o.kind === 'airliner') { if (!rolling) hurt(25); }
        else if (o.kind === 'wall') hurt(20); // obstacles always hurt
        else if (o.kind === 'heart') { hp = Math.min(maxHp, hp + 25); sfx('heart'); }
        else if (o.kind === 'life') { maxHp = Math.min(300, maxHp + 25); hp = maxHp; usedTowns.add(o.town); sfx('achieve'); OGE.toast(`${T('Vida máxima')}: ${maxHp}`); }
        else if (o.kind === 'crest') collect(o.cap); // the coat of arms wins the capital
        else if (o.kind === 'shield') { shields = Math.min(3, shields + 1); sfx('shield'); }
        else if (o.kind === 'bomb') { bombs++; sfx('bombGet'); }
        else if (o.kind === 'itembox') { if (item) return true; item = Object.keys(ITEMS)[Math.floor(Math.random() * 4)]; sfx('achieve'); OGE.toast(`${ITEMS[item][0]} ${T(ITEMS[item][1])} — ${T('U para usarlo')}`); }
        else if (o.kind === 'mine') { if (o.own) return true; hurt(25); booms.push({ p: o.p, t: performance.now() }); }
        else {
          score += pts(10);
          if (++coins % 25 === 0) bombs++;
          sfx(o.kind); // coin
        }
        return false;
      }
      if (fixed) return o.kind === 'itembox' || o.kind === 'mine' || d < 4e5; // the race's boxes stay along the whole route
      const gone = C.Cartesian3.dot(t, cam.directionWC) < -o.size; // left behind
      if (gone && o.kind === 'ring' && on) hurt(5); // a ring that was not flown through costs life
      return !gone && d < far;
    });
    if (!on) return; // destroyed
    for (const o of objs) { // enemies fire at where the ship will be if it keeps flying straight
      const boss = o.kind === 'boss';
      if ((o.kind !== 'enemy' && o.kind !== 'airliner' && !boss) || now < o.next) continue;
      o.next = now + DIFF[diff].fire * (boss ? BOSSES[o.type].every * (0.8 + Math.random() * 0.4) : 4000 + Math.random() * 4000);
      const d = C.Cartesian3.distance(o.p, cam.positionWC), speed = (eff * 0.5 + 600) * DIFF[diff].shot, tt = d / (speed + eff);
      if (boss ? d > Math.max(reach() * 1.3, 6e4) : d > reach() * 1.3 || C.Cartesian3.dot(C.Cartesian3.subtract(o.p, cam.positionWC, t), cam.directionWC) < 0) continue;
      const target = C.Cartesian3.add(p2 && !p2.out && p2.p && Math.random() < 0.5 ? p2.p : cam.positionWC, C.Cartesian3.multiplyByScalar(cam.directionWC, eff * tt, new C.Cartesian3()), new C.Cartesian3()); // half the shots go for player 2
      const panels = boss && o.type === 'face' && (o.volley = (o.volley || 0) + 1) % 2 === 1; // the stone face spits panels one volley, fires lasers the next
      const n = boss ? (o.rage ? 8 : panels ? 7 : BOSSES[o.type].shots) : 1; // a volley fans out sideways (a raging beacon fires eight)
      if (boss) o.spat = now;
      for (let i = 0; i < n; i++) {
        const spread = o.rage ? 0.18 : panels ? 0.09 : 0.05, aim = C.Cartesian3.add(target, C.Cartesian3.multiplyByScalar(o.rage && i % 2 ? cam.upWC : cam.rightWC, (i - (n - 1) / 2) * d * spread, new C.Cartesian3()), new C.Cartesian3());
        incoming.push({ p: C.Cartesian3.clone(o.p), vel: C.Cartesian3.multiplyByScalar(C.Cartesian3.subtract(aim, o.p, t), 1 / tt, new C.Cartesian3()), t: now, color: boss ? BOSSES[o.type].color : '#ff2df5', panel: panels, spin: Math.random() * 6 });
      }
    }
    incoming = incoming.filter((b) => {
      C.Cartesian3.add(b.p, C.Cartesian3.multiplyByScalar(b.vel, dt, t), b.p);
      if (C.Cartesian3.distance(b.p, cam.positionWC) < 40 + slack * 1.5) { if (!rolling) hurt(8); return false; }
      return now - b.t < 8000;
    });
    if (on && !tut && $('layerPlanes').checked && performance.now() > (liveT || 0)) liveEnemies(); // real aircraft nearby join as tougher enemies
    while (on && !tut && objs.filter((o) => !['boss', 'crest', 'life'].includes(o.kind)).length < 10) spawn();
  }
  function drawArcade(w, h, text) {
    const f = h / 2 / Math.tan((viewer.camera.frustum.fovy || rad(60)) / 2), toWin = C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates, now = performance.now();
    for (const o of objs) {
      const q = toWin(scene, o.p);
      if (!q) continue; // behind the camera
      const pr = Math.max(4, (o.size / C.Cartesian3.distance(o.p, viewer.camera.positionWC)) * f);
      g.save(); g.shadowBlur = 8; g.beginPath();
      if (o.kind === 'itembox') { const R = Math.max(8, pr), t = now / 400; g.save(); g.translate(q.x, q.y); g.rotate(t); const gr = g.createLinearGradient(-R, -R, R, R); ['#ff453a', '#ffd60a', '#34c759', '#0a84ff', '#bf5af2'].forEach((c, i) => gr.addColorStop(i / 4, c)); g.fillStyle = gr; g.globalAlpha = 0.85; g.fillRect(-R, -R, R * 2, R * 2); g.globalAlpha = 1; g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(-R, -R, R * 2, R * 2); g.rotate(-t); g.fillStyle = '#fff'; g.font = `700 ${Math.round(R * 1.3)}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('?', 0, 2); g.restore(); }
      else if (o.kind === 'mine') { const R = Math.max(6, pr); g.fillStyle = '#222'; g.strokeStyle = '#888'; g.lineWidth = 2; g.beginPath(); g.arc(q.x, q.y, R, 0, 7); g.fill(); g.stroke(); g.fillStyle = g.shadowColor = (now / 300) % 2 < 1 ? '#ff453a' : '#600'; g.shadowBlur = 10; g.beginPath(); g.arc(q.x, q.y, R * 0.3, 0, 7); g.fill(); }
      else if (o.kind === 'ring') { g.strokeStyle = g.shadowColor = '#ffd60a'; g.lineWidth = Math.max(2, pr * 0.12); g.arc(q.x, q.y, pr, 0, 7); g.stroke(); }
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
      else if (o.kind === 'airliner') { // a real flight: the airliner icon turned along its track, with its callsign
        const R = Math.max(14, pr * 2); g.save(); g.translate(q.x, q.y); g.rotate(C.Math.toRadians((o.a.track || 0)) - viewer.camera.heading); g.shadowColor = '#ffd60a'; g.shadowBlur = 16; g.drawImage(OGE.planeIcon, -R, -R, R * 2, R * 2); g.restore();
        g.fillStyle = '#ffd60a'; g.textAlign = 'center'; g.font = '700 11px sans-serif'; g.fillText(`${(o.a.flight || o.a.r || '').trim()} · ${'●'.repeat(o.hp)}`, q.x, q.y + R + 12);
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
      const br = Math.max(3, (60 / C.Cartesian3.distance(b.p, viewer.camera.positionWC)) * f);
      if (b.panel) { const a = b.spin + performance.now() / 150, sq = Math.abs(Math.cos(a * 0.7)); g.save(); g.translate(q.x, q.y); g.rotate(a); g.fillStyle = '#d7dde5'; g.fillRect(-br * 2, -br * 1.3 * sq, br * 4, br * 2.6 * sq); g.strokeStyle = '#ff7a1a'; g.lineWidth = Math.max(1.5, br * 0.35); g.strokeRect(-br * 2, -br * 1.3 * sq, br * 4, br * 2.6 * sq); g.restore(); continue; } // a tumbling panel
      g.save(); g.fillStyle = g.shadowColor = b.color || '#ff2df5'; g.shadowBlur = 10; g.beginPath(); g.arc(q.x, q.y, br, 0, 7); g.fill(); g.restore();
    }
    const fade = (t0, ms, color) => { const k = (now - t0) / ms; if (k < 1) { g.save(); g.globalAlpha = 0.5 * (1 - k); g.fillStyle = color; g.fillRect(0, 0, w, h); g.restore(); } };
    fade(flash, 450, '#fff'); fade(hit, 250, broke === hit ? '#0a84ff' : '#f00'); // bomb / shield broken / damage
    if (shields) { g.save(); g.strokeStyle = 'rgba(10,132,255,.55)'; g.lineWidth = 3 * shields; g.beginPath(); g.ellipse(w / 2, h / 2, w * 0.46, h * 0.46, 0, 0, 7); g.stroke(); g.restore(); } // shield around the view, thicker with more layers
    if (race) drawRace(g, w, text);
    if (adv) text(`${T('ETAPA')} ${adv.i + 1}: ${adv.name} · ${adv.boss ? T('¡derrota al jefe!') : (adv.left ?? '?') + ' ' + T('banderas restantes')}`, 24, 136, 14, 'left');
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
    calm = useCalm;
    A = PLANES[plane];
    landing = null;
    tut = null;
    aimMouse = !!A.ship && !!useAim; mouse.x = hud.clientWidth / 2; mouse.y = hud.clientHeight / 2;
    man = null;
    loadCaps();
    loadRegs();
    if (A.ship) OGE.minimap.zoom(99); // the starship starts with the minimap zoomed all the way in
    arcade = !!A.ship && !!useArcade;
    autoOn = arcade && window.__TAURI__ && !$('layerPlanes').checked ? ['layerPlanes'] : []; // live aircraft join the arcade in the desktop app, only for this flight
    for (const id of autoOn) { $(id).checked = true; $(id).dispatchEvent(new Event('change')); } // live satellites and aircraft join the arcade
    if (!document.body.classList.contains('noside')) { sideWas = true; OGE.hideSide(true); } // more room for the flight; it comes back afterwards
    stopped = false;
    if (arcade && !airports && !airBusy) { airBusy = true; fetch(NE + '10m_cultural/ne_10m_airports.shp').then((r) => r.arrayBuffer()).then((b) => { airports = shp.parseShp(b).filter((g) => g && g.type === 'Point').map((g) => g.coordinates); }).catch(() => {}).finally(() => { airBusy = false; }); } // 25 KB: only the points
    maxHp = 100; usedTowns.clear(); hp = 100; bombs = 2; incoming = []; flash = hit = 0; shields = 0;
    run = { flags: 0, caps: 0, bosses: 0 };
    p2 = mpMode === 'local' && arcade ? { x: -0.65, y: 0.55, z: 200, hp: 100, score: 0, tilt: 0 } : null; // the second local player starts beside the first
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
      if (adv && (c.a3 !== adv.a3 || !adv.boss)) continue; // in the adventure the boss comes after the flags
      const type = bossKind(c.name), B = BOSSES[type], base = C.Cartesian3.fromDegrees(c.lon, c.lat, (scene.globe.getHeight(C.Cartographic.fromDegrees(c.lon, c.lat)) || 0) + 6000);
      objs.push({ kind: 'boss', born: performance.now(), type, cap: c, base, p: C.Cartesian3.clone(base), east: C.Cartesian3.normalize(C.Cartesian3.cross(C.Cartesian3.UNIT_Z, base, new C.Cartesian3()), new C.Cartesian3()), size: 700, hp: Math.ceil(B.hp * DIFF[diff].boss), max: Math.ceil(B.hp * DIFF[diff].boss), next: performance.now() + 2500 });
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
  OGE.minimap.extra = (mg) => { // collected capitals in green, the rest in yellow; the race goal, kept at the edge when it is outside
    if (remote && remote.to) { const c = C.Cartographic.fromCartesian(remote.to), [x, y] = OGE.minimap.xy(deg(c.longitude), deg(c.latitude)); mg.fillStyle = remote.skin; mg.beginPath(); mg.arc(x, y, 4, 0, 7); mg.fill(); } // the other online player
    if (race) {
      const c = viewer.camera.positionCartographic, [sx, sy] = OGE.minimap.xy(deg(c.longitude), deg(c.latitude));
      let [x, y] = OGE.minimap.xy(race.to.lon, race.to.lat);
      const k = Math.min(1, x - sx ? ((x > sx ? 236 : 4) - sx) / (x - sx) : 1, y - sy ? ((y > sy ? 116 : 4) - sy) / (y - sy) : 1);
      x = sx + (x - sx) * k; y = sy + (y - sy) * k;
      mg.save(); mg.strokeStyle = '#34c759'; mg.setLineDash([4, 3]); mg.lineWidth = 1.5; mg.beginPath(); mg.moveTo(sx, sy); mg.lineTo(x, y); mg.stroke();
      mg.setLineDash([]); mg.fillStyle = '#34c759'; mg.strokeStyle = '#fff'; mg.beginPath(); mg.arc(x, y, 4, 0, 7); mg.fill(); mg.stroke(); mg.restore();
    }
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

  // ---------- Race: fly from one chosen city to another; the goal shows on the screen and on the minimap, the best time per route is kept ----------
  let race = null; // { key, from, to: { name, lon, lat, p }, t0 }
  let item = null; // the race item being held: 'missile' | 'mine' | 'boost' | 'shield'
  const ITEMS = { missile: ['🚀', 'Misil'], mine: ['⚫', 'Mina'], boost: ['⚡', 'Turbo'], shield: ['🛡', 'Escudo'] };
  function placeBoxes(a, b) { // a row of three boxes every few kilometres between the two cities
    const km = raceKm(), n = Math.max(3, Math.min(30, Math.round(km / 8)));
    for (let i = 1; i < n; i++) {
      const f = i / n, lon = a.lon + (b.lon - a.lon) * f, lat = a.lat + (b.lat - a.lat) * f, side = Math.cos(rad(lat));
      for (const o of [-1, 0, 1]) { // across the route
        const L = Math.hypot(b.lat - a.lat, (b.lon - a.lon) * side) || 1e-9, dl = (o * 0.012 * (b.lat - a.lat)) / L, dn = (-o * 0.012 * (b.lon - a.lon) * side) / L;
        const x = lon + dl / side, y = lat + dn, gh = scene.globe.getHeight(C.Cartographic.fromDegrees(x, y)) || 0;
        objs.push({ kind: 'itembox', p: C.Cartesian3.fromDegrees(x, y, gh + 1200), size: 350, next: 1e15 });
      }
    }
  }
  function useItem() {
    if (!item) return;
    const it = item; item = null;
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
      fields: [{ id: 'from', label: 'Salida', type: 'text', value: last.from || 'Santiago de Chile' }, { id: 'to', label: 'Meta', type: 'text', value: last.to || 'Valparaíso' }] });
    if (!v || !v.from || !v.to) return;
    localStorage.setItem('oge.raceLast', JSON.stringify(v));
    let a, b;
    try { [a, b] = await Promise.all([geocode(v.from), geocode(v.to)]); } catch (e) { return OGE.toast(e.message, true); }
    b.p = C.Cartesian3.fromDegrees(b.lon, b.lat, 1500);
    const hd = bearing(a, b);
    viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(a.lon, a.lat, 3000), orientation: { heading: hd, pitch: rad(-10), roll: 0 } });
    adv = null; advShape = null;
    start('ship', true, true, true, false);
    s.heading = hd;
    race = { key: `${v.from}|${v.to}`.toLowerCase(), from: a, to: b, t0: performance.now() };
    item = null; placeBoxes(a, b);
    graceT = performance.now() + 6000;
    const best = +localStorage.getItem('oge.race.' + race.key) || 0;
    OGE.toast(`🏁 ${a.name} → ${b.name}: ${Math.round(raceKm())} km.` + (best ? ` ${T('Mejor tiempo')}: ${fmtT(best)}.` : ''));
  }
  function raceStep() {
    if (raceKm() > Math.max(3, (s.v * warp * 0.06) / 1000)) return; // within 3 km, or a couple of frames at high speed
    const ms = performance.now() - race.t0, key = 'oge.race.' + race.key, best = +localStorage.getItem(key) || 0, rec = !best || ms < best;
    if (rec) localStorage.setItem(key, String(Math.round(ms)));
    score += pts(1000);
    OGE.toast(`🏁 ${T('¡Llegaste a')} ${race.to.name}! ${T('Tiempo')}: ${fmtT(ms)}` + (rec ? ` · ${T('¡Nuevo récord!')}` : ` · ${T('Mejor tiempo')}: ${fmtT(best)}`));
    sfx('achieve');
    race = null;
    setTimeout(() => { if (on) stop(); }, 3000);
  }
  function drawRace(g, w, text) { // the goal: a flag where it is on the screen, and an arrow at the top pointing to it
    const toWin = C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates, q = toWin(scene, race.to.p);
    const ahead = C.Cartesian3.dot(C.Cartesian3.subtract(race.to.p, viewer.camera.positionWC, new C.Cartesian3()), viewer.camera.directionWC) > 0;
    if (q && ahead) { g.save(); g.font = '28px sans-serif'; g.textAlign = 'center'; g.fillText('🏁', q.x, q.y); g.fillStyle = '#fff'; g.font = '600 12px sans-serif'; g.fillText(race.to.name, q.x, q.y + 18); g.restore(); }
    const c = viewer.camera.positionCartographic, rel = bearing({ lon: deg(c.longitude), lat: deg(c.latitude) }, race.to) - viewer.camera.heading;
    g.save(); g.translate(w / 2, 70); g.rotate(rel); g.fillStyle = g.shadowColor = '#34c759'; g.shadowBlur = 10; g.beginPath(); g.moveTo(0, -16); g.lineTo(11, 10); g.lineTo(0, 4); g.lineTo(-11, 10); g.closePath(); g.fill(); g.restore();
    text(`🏁 ${race.to.name} · ${raceKm().toFixed(1)} km · ${fmtT(performance.now() - race.t0)}`, 24, 156, 14, 'left');
    text(item ? `${T('OBJETO')}: ${ITEMS[item][0]} ${T(ITEMS[item][1])} (U)` : `${T('OBJETO')}: — ${T('(toca una caja ?)')}`, 24, 176, 14, 'left');
  }

  // ---------- Adventure: a campaign of country stages. Inside a stage the ship cannot leave the country; once all its region flags
  // are collected, the boss of its capital appears; beating it unlocks the next country. Progress is kept on this computer. ----------
  const ROUTE = ['CHL', 'ARG', 'URY', 'PRY', 'BOL', 'PER', 'ECU', 'COL', 'VEN', 'BRA', 'MEX', 'CUB', 'USA', 'CAN', 'ISL', 'GBR', 'IRL', 'PRT', 'ESP', 'FRA', 'ITA', 'GRC', 'EGY', 'MAR', 'NGA', 'KEN', 'ZAF', 'MDG', 'IND', 'CHN', 'JPN', 'AUS', 'NZL'];
  let adv = null, advShape = null, graceT = 0, liveT = 0;
  async function liveEnemies() {
    liveT = performance.now() + 15000; // asked every 15 s
    try {
      const list = (await OGE.livePlanes(C.Math.toDegrees(s.lon), C.Math.toDegrees(s.lat), 120)).slice(0, 6);
      objs = objs.filter((o) => o.kind !== 'airliner'); // the old positions are replaced
      for (const a of list) {
        const ft = typeof a.alt_baro === 'number' ? a.alt_baro : 20000;
        objs.push({ kind: 'airliner', a, p: C.Cartesian3.fromDegrees(a.lon, a.lat, Math.max(1500, ft * 0.3048)), size: 600, hp: 3, look: 0, next: performance.now() + 2000 + Math.random() * 3000 });
      }
    } catch { /* no feed: the game goes on without them */ }
  } // adv: { i, a3 } while a stage runs; advShape: the country's polygons
  const advDone = () => +localStorage.getItem('oge.adventure') || 0; // stages beaten
  async function adventure(stage = advDone()) {
    const a3 = ROUTE[Math.min(stage, ROUTE.length - 1)];
    const [s2, d2] = await Promise.all([fetch(NE + '50m_cultural/ne_50m_admin_0_countries.shp').then((r) => r.arrayBuffer()), fetch(NE + '50m_cultural/ne_50m_admin_0_countries.dbf').then((r) => r.arrayBuffer())]);
    const f = shp.combine([shp.parseShp(s2), shp.parseDbf(d2)]).features.find((x) => String(x.properties.ADM0_A3).replace(/\0/g, '').trim() === a3);
    if (!f) return OGE.toast('No se encontró el país de la etapa.', true);
    advShape = f;
    const name = String(f.properties.NAME_ES || f.properties.NAME).replace(/\0/g, '').trim(), cp = caps && caps.find((x) => x.a3 === a3);
    const c = cp ? [cp.lon, cp.lat] : [+f.properties.LABEL_X, +f.properties.LABEL_Y]; // the stage starts over its capital
    viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(c[0], c[1], 40000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
    localStorage.setItem('oge.quest', '1');
    adv = { i: stage, a3, name, boss: false };
    start('ship', true, true, true, false); // aim with the mouse, fly with the keyboard
    graceT = performance.now() + 6000; // a few seconds without damage to get one's bearings
    OGE.toast(`${T('Etapa')} ${stage + 1}/${ROUTE.length}: ${name}. ${T('Recoge todas sus banderas y luego derrota al jefe de la capital.')}`);
  }
  function advStep() {
    if (!adv || !regs) return;
    const here = [C.Math.toDegrees(s.lon), C.Math.toDegrees(s.lat)];
    if (advShape && !turf.booleanPointInPolygon(here, advShape)) { // the border bounces the ship back toward the inside
      const c = turf.pointOnFeature(advShape).geometry.coordinates;
      s.heading = Math.atan2((c[0] - here[0]) * Math.cos(s.lat), c[1] - here[1]);
      if (performance.now() - (adv.warned || 0) > 3000) { adv.warned = performance.now(); OGE.toast(T('No puedes salir del país en esta etapa.')); sfx('shieldBreak'); }
    }
    const mine = regs.filter((r) => r.a3 === adv.a3), left = mine.filter((r) => !gotReg.has(r.id)).length;
    adv.left = left;
    if (left === 0 && !adv.boss) { // every flag: the capital's boss shows up
      const cap = caps && caps.find((x) => x.a3 === adv.a3);
      if (cap) { got.delete(capId(cap)); adv.boss = true; adv.cap = cap; OGE.toast(`${T('¡Todas las banderas! El jefe de')} ${cap.name} ${T('te espera.')}`); sfx('achieve'); }
    }
    if (adv.boss && adv.cap && got.has(capId(adv.cap))) { // its capital won: stage cleared
      localStorage.setItem('oge.adventure', String(Math.max(advDone(), adv.i + 1)));
      const next = adv.i + 1;
      OGE.toast(next < ROUTE.length ? `${T('¡Etapa superada!')} ${T('Siguiente')}: ${ROUTE[next]}.` : T('¡Completaste la aventura!'));
      sfx('achieve');
      adv = null; advShape = null;
      if (next < ROUTE.length) setTimeout(() => { stop(); adventure(next); }, 2500);
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
  let autoOn = [];
  let sideWas = false;
  function stop(msg, error) {
    if (sideWas) { sideWas = false; OGE.hideSide(false); }
    for (const id of autoOn) { $(id).checked = false; $(id).dispatchEvent(new Event('change')); } autoOn = [];
    on = false; race = null; if (msg && adv) { adv = null; advShape = null; } // a crash ends the stage tut = null;
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
  const skin = (n) => localStorage.getItem('oge.skin' + n) || (n === 1 ? '#3fa9ff' : '#ff9f0a');
  const P2KEYS = new Set(['i', 'j', 'k', 'l', 'u', 'o', 'enter']);
  let mpMode = 'solo', ws = null, remote = null, p2 = null, credit = 1, mpTimer = null; // credit: which local player scores
  const gain = (n) => { if (credit === 2 && p2) p2.score += n; else score += n; };
  const mpSend = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
  const P1POS = (w, h) => [w / 2, h * 0.8]; // where player 1's own ship is drawn in local mode
  function shipBack(x, y, R, color, roll = 0, hurtT = 0) { // a starship seen from behind, in the player's color
    g.save(); g.translate(x, y); g.rotate(roll); g.lineJoin = 'round'; g.shadowColor = color; g.shadowBlur = 14; g.lineWidth = 2; g.strokeStyle = '#fff';
    g.fillStyle = performance.now() - hurtT < 200 ? '#fff' : color; // blinks white when hit
    g.beginPath(); g.moveTo(-R, R * 0.3); g.lineTo(-R * 0.2, -R * 0.12); g.lineTo(R * 0.2, -R * 0.12); g.lineTo(R, R * 0.3); g.lineTo(R * 0.25, R * 0.2); g.lineTo(-R * 0.25, R * 0.2); g.closePath(); g.fill(); g.stroke(); // wings
    g.beginPath(); g.moveTo(0, -R * 0.62); g.lineTo(R * 0.13, -R * 0.05); g.lineTo(-R * 0.13, -R * 0.05); g.closePath(); g.fill(); g.stroke(); // tail fin
    for (const e of [-1, 1]) { g.beginPath(); g.moveTo(e * R, R * 0.3); g.lineTo(e * R * 0.92, -R * 0.2); g.lineTo(e * R * 0.82, R * 0.26); g.closePath(); g.fill(); g.stroke(); } // wing tips
    g.fillStyle = '#1c2a44'; g.beginPath(); g.ellipse(0, R * 0.05, R * 0.26, R * 0.2, 0, 0, 7); g.fill(); g.stroke(); // hull
    for (const e of [-1, 1]) glow(g, e * R * 0.12, R * 0.08, R * 0.16, '#7fd4ff'); // engines
    g.restore();
  }
  function p2Hurt(n) {
    if (!p2 || p2.out || tut || performance.now() < graceT) return;
    p2.hp -= n * DIFF[diff].hurt; p2.hit = performance.now(); beep(240, 100, 0.2);
    if (p2.hp <= 0) { p2.out = true; OGE.toast(`Jugador 2 derribado: ${p2.score} puntos.`); }
  }
  function versus(who, ax, ay, ray) { // a shot that hits the other player costs it life
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
        shipBack(p2.sx, p2.sy, p2.R, skin(2), p2.tilt, p2.hit);
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
        shipBack(q.x, q.y, R, remote.skin, (remote.r || 0) - s.roll, remote.hitT);
        if (now - (remote.shot || 0) < 150) glow(g, q.x, q.y - R * 0.6, R * 0.5, '#ff3b30'); // its lasers firing
        g.save(); g.fillStyle = remote.skin; text(`${remote.name} · ${(d / 1000).toFixed(1)} km · ${T('VIDA')} ${Math.max(0, Math.round(remote.hp))}`, q.x, q.y + R + 14, 12); g.restore();
      }
    }
  }
  function mpMessage(m) {
    if (m.t === 's') {
      remote = remote || {};
      Object.assign(remote, { to: C.Cartesian3.fromRadians(m.lon, m.lat, m.alt), r: m.r, hp: m.hp, name: String(m.name || '?').slice(0, 24), skin: /^#[0-9a-f]{6}$/i.test(m.skin) ? m.skin : '#ff9f0a', t: performance.now() });
    } else if (m.t === 'shot' && remote) remote.shot = performance.now();
    else if (m.t === 'hit' && on && arcade) hurt(Math.min(25, +m.n || 0));
    else if (m.t === 'mine' && on && Number.isFinite(+m.lon) && Number.isFinite(+m.lat) && Number.isFinite(+m.alt)) objs.push({ kind: 'mine', p: C.Cartesian3.fromRadians(+m.lon, +m.lat, +m.alt), size: 300, next: 1e15, until: performance.now() + 90000 });
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
    mpTimer = setInterval(() => { if (on) mpSend({ t: 's', lon: s.lon, lat: s.lat, alt: s.alt, r: s.roll, hp, score, skin: skin(1), name: localStorage.getItem('oge.pilot') || T('Piloto') }); }, 100); // ten times a second
  }
  async function multiplayer() {
    const wasOn = on; paused = true;
    const v = await OGE.ask({ title: 'OpenStarshipEarth: multijugador', ok: 'Jugar',
      help: 'Local: el jugador 2 mueve su nave con I J K L, se adelanta con O, se retrasa con U y dispara con Enter (su mira es la cruz sobre su nave). En línea: la app de escritorio crea la partida y muestra su IP:puerto; el otro jugador se une con esa dirección desde su app o desde la página (la página publicada en https puede bloquear la conexión: entonces usa la app). Los jugadores pueden dispararse entre ellos.',
      fields: [{ id: 'mode', label: 'Modo', type: 'select', value: mpMode, options: [['solo', 'Un jugador'], ['local', 'Local: 2 jugadores en esta pantalla'], ['host', 'En línea: crear partida (app de escritorio)'], ['join', 'En línea: unirse a una partida']] },
        { id: 'addr', label: 'Dirección del anfitrión (IP:puerto), para unirse', value: localStorage.getItem('oge.mpAddr') || '', placeholder: '192.168.1.20:7777' },
        { id: 'port', label: 'Puerto, para crear la partida', type: 'number', value: +localStorage.getItem('oge.mpPort') || 7777, min: 1024, max: 65535, step: 1 },
        { id: 'c1', label: 'Color de tu nave', type: 'color', value: skin(1) },
        { id: 'c2', label: 'Color de la nave del jugador 2 (modo local)', type: 'color', value: skin(2) }] });
    paused = false; last = performance.now();
    if (!v) return;
    localStorage.setItem('oge.skin1', v.c1); localStorage.setItem('oge.skin2', v.c2);
    mpMode = v.mode;
    if (v.mode !== 'host' && v.mode !== 'join') mpClose();
    try {
      if (v.mode === 'host') {
        const tauri = window.__TAURI__ && window.__TAURI__.core;
        if (!tauri) { mpMode = 'solo'; return OGE.toast('Crear una partida en línea necesita la app de escritorio; desde la página puedes unirte a una.', true); }
        localStorage.setItem('oge.mpPort', v.port);
        const addr = await tauri.invoke('mp_host', { port: v.port });
        await mpOnline('127.0.0.1:' + v.port);
        OGE.toast(`${T('Partida creada. El otro jugador se une con')} ${addr}`);
      } else if (v.mode === 'join') {
        const addr = v.addr.trim().replace(/^wss?:\/\//, '');
        if (!/^[\w.-]+:\d{2,5}$/.test(addr)) { mpMode = 'solo'; return OGE.toast('Escribe la dirección como IP:puerto, por ejemplo 192.168.1.20:7777.', true); }
        localStorage.setItem('oge.mpAddr', addr);
        await mpOnline(addr);
        OGE.toast(`${T('Conectado a')} ${addr}`);
      }
    } catch (e) { mpMode = 'solo'; return OGE.toast(T('Multijugador') + ': ' + (e.message || e), true); }
    p2 = mpMode === 'local' && wasOn && arcade ? { x: -0.65, y: 0.55, z: 200, hp: 100, score: 0, tilt: 0 } : null; // joins the flight in progress
    if (!wasOn) { mpLaunch = true; $('shipBtn').click(); } // the mode menu: free play, race or adventure, now with the second player
  }

  // ---------- Controls ----------
  // Gamepad, Xbox 360 layout by default (browsers report XInput pads in the 'standard' mapping):
  // left stick steers, right stick aims; A fire · B bomb · X barrel roll · Y loop · LB / RB turbo − / + · LT stop · RT turbo burst
  // Back controls · Start pause · L3 turn back · R3 camera · D-pad ↑ climb · ↓ land · ← race item · → take off
  const PAD = ['b', 'v', 'r', 'x', 'shift', ' ', 'q', 'e', 'k', 'enter', 'f', 'y', 't', 'z', 'u', 'c'];
  const padPrev = [], pad = { x: 0, y: 0, on: false };
  let padFireT = 0;
  function readPad() {
    const gp = [...(navigator.getGamepads ? navigator.getGamepads() : [])].find((p) => p && p.connected);
    pad.on = !!gp; if (!gp) return;
    const dz = (v) => (Math.abs(v) < 0.15 ? 0 : v);
    pad.x = dz(gp.axes[0] || 0); pad.y = dz(gp.axes[1] || 0);
    const rx = dz(gp.axes[2] || 0), ry = dz(gp.axes[3] || 0);
    if (aimMouse && (rx || ry)) { mouse.x = clamp(mouse.x + rx * 14, 0, hud.clientWidth); mouse.y = clamp(mouse.y + ry * 14, 0, hud.clientHeight); }
    PAD.forEach((key, i) => {
      const b = gp.buttons[i], down = !!b && (b.pressed || b.value > 0.5);
      if (down && !padPrev[i]) document.dispatchEvent(new KeyboardEvent('keydown', { key, code: key === 'shift' ? 'ShiftLeft' : '' }));
      if (!down && padPrev[i]) document.dispatchEvent(new KeyboardEvent('keyup', { key }));
      if (down && key === 'b' && performance.now() > padFireT) { padFireT = performance.now() + 160; if (padPrev[i]) fire(); } // A held: keeps firing
      padPrev[i] = down;
    });
  }
  window.addEventListener('gamepadconnected', (e) => { OGE.toast(`${T('Mando conectado')}: ${e.gamepad.id.slice(0, 40)}`); $('padMap').hidden = false; });
  window.addEventListener('gamepaddisconnected', () => { $('padMap').hidden = true; });
  function controls(dt) {
    readPad();
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
    const to = WARPS[Math.min(WARPS.length - 1, WARPS.indexOf(warp) + 2)]; // two turbo levels up
    boost = { t0: performance.now(), from: warp, to }; boostCd = performance.now() + 3500; setWarp(to); sfx('thrust');
  }
  function maneuver(type) {
    if (on && !A.ship) return OGE.toast('Disparar y las maniobras son solo de la OpenStarshipEarth.');
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
    const airbrake = (A.ship ? stopped : keys.has('q')) || keys.has('pagedown') ? (A.ship ? A.thrust * 1.5 + s.v * 2 : 6) : 0; // Q also brakes: drag alone is too weak at low speed; the ship halves its speed about every 0.3 s and stops
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
      if (A.ship && airbrake) { s.v = Math.max(0, s.v - Math.max(A.thrust * 3, s.v * 4) * dt); if (boost) { if (warp === boost.to) setWarp(boost.from); boost = null; } } // Q: the ship stops in about a second and hovers
      else if (A.ship && boost && performance.now() - boost.t0 > 2500) { if (warp === boost.to) setWarp(boost.from); boost = null; } // after 2.5 s, back to the turbo it had (unless changed by hand) // the burst rises and falls back to the speed it had
      s.vs = s.v * Math.sin(pe);
      s.alt += s.vs * dt * warp;
      if (A.ship && keys.has('t')) { s.alt += 250 * dt; s.vs += 250; } // T held: a gentle climb, ~250 m/s
      if (A.ship && s.alt <= ground + 30) { // the starship bounces off the ground; in the arcade a hard touch costs life
        s.alt = ground + 30; s.pitch = Math.max(s.pitch, rad(arcade ? 8 : 2));
        if (arcade && !landing && !shields && !man && performance.now() - hit > 800) hurt(15); // an intended landing (Z) does no harm, nor touching the ground with a shield up or during a roll, loop or turn
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
    s.rollOff = rollOff; // the drawing of the own ship (third person) turns with the maneuvers
    viewer.camera.setView({ destination: C.Cartesian3.fromRadians(s.lon, s.lat, s.alt), orientation: { heading: s.heading, pitch: pe, roll: s.roll + rollOff } });
    if (third && A.ship) { const c = viewer.camera; c.moveBackward(380); c.moveUp(110); c.lookDown(Math.atan2(110, 380) * 0.8); } // third person: the camera sits behind and above the ship
    if (landing && A && A.ship) {
      const gnd = (scene.globe.getHeight(new C.Cartographic(s.lon, s.lat)) || 0) * scene.verticalExaggeration;
      if (landing !== 'parked') refuelMsg = false;
      if (landing === 'down') { s.v = Math.min(s.v, 60); s.pitch = 0; s.alt = Math.max(gnd + 30, s.alt - Math.max(400, (s.alt - gnd) * 1.6) * dt); if (s.alt <= gnd + 31) { landing = 'parked'; sfx('down'); OGE.toast('Aterrizaste. Pulsa Despegar (C) para volver a volar.'); } }
      else if (landing === 'parked') { // on the ground it rolls slowly: forward with W / ↑ / E, back with S / ↓ / Q; A, D and the arrows steer
        const lo = C.Math.toDegrees(s.lon), la = C.Math.toDegrees(s.lat), field = arcade && airports && airports.find(([x, y]) => Math.abs(y - la) < 0.04 && Math.abs((x - lo) * Math.cos(s.lat)) < 0.04); // ~4 km
        if (field && hp < maxHp) { hp = Math.min(maxHp, hp + 8 * dt); if (!refuelMsg) { refuelMsg = true; OGE.toast(T('🛬 Aeródromo: recuperando vida…')); sfx('heart'); } }
        s.v = 0; s.throttle = 0; s.pitch = 0; stopped = false;
        // like a car: W / ↑ / E accelerate up to ~400 km/h, S / ↓ / Q brake and then reverse; the steering only turns while it rolls (and reverses backwards)
        const kd = (x) => keys.has(x), gas = kd('w') || kd('arrowup') || kd('e') || kd('pageup') || stick.y < -0.2, brake = kd('s') || kd('arrowdown') || kd('q') || kd('pagedown') || stick.y > 0.2;
        let v = s.taxi || 0;
        if (gas) v += (v < 0 ? 60 : 28) * dt; else if (brake) v -= (v > 0 ? 50 : 12) * dt; else v -= Math.sign(v) * Math.min(Math.abs(v), 4 * dt); // engine braking when nothing is pressed
        s.taxi = v = clamp(v, -25, 110); // ground speed: up to ~400 km/h, separate from the flight speed
        s.lat += (v * dt * Math.cos(s.heading)) / R; s.lon = C.Math.negativePiToPi(s.lon + (v * dt * Math.sin(s.heading)) / (R * Math.cos(s.lat)));
        s.heading = C.Math.zeroToTwoPi(s.heading + s.rud * clamp(v / 12, -1, 1) * 0.9 * dt);
        s.alt = gnd + 12; // closer to the ground, like a car
      }
      else if (landing === 'up') { s.pitch = 0; s.alt += Math.max(300, (gnd + 3000 - s.alt) * 1.5) * dt; if (s.alt >= gnd + 3000) { landing = null; s.throttle = 0.5; s.v = Math.max(s.v, 400); } }
      viewer.camera.setView({ destination: C.Cartesian3.fromRadians(s.lon, s.lat, s.alt), orientation: { heading: s.heading, pitch: s.pitch, roll: 0 } });
      if (third && A.ship) { const c = viewer.camera; c.moveBackward(380); c.moveUp(110); c.lookDown(Math.atan2(110, 380) * 0.8); } // third person: the camera sits behind and above the ship
    }
    if (arcade && on) arcadeStep(dt);
    if (on) mpStep(dt);
    if (tut && on) tutStep();
    if (on && race) raceStep();
    if (on && quest()) { capStep(); regStep(); advStep(); } // the collection can be switched off to fly just for the views
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
    if ($('layerSats').checked) for (const sat of OGE.satellites()) { // live satellites, as bright moving dots when they are in view
      if (!sat.p || OGE.satHidden.has(sat.name) || C.Cartesian3.distance(sat.p, viewer.camera.positionWC) > 2.5e6) continue; // only the satellites near the ship, and not the ones shot down
      const q = (C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates)(scene, sat.p);
      if (!q || q.x < 0 || q.y < 0 || q.x > w || q.y > h) continue;
      const sd = C.Cartesian3.distance(sat.p, viewer.camera.positionWC), iss = /ISS|ZARYA/.test(sat.name);
      if (C.Cartesian3.dot(C.Cartesian3.subtract(sat.p, viewer.camera.positionWC, new C.Cartesian3()), viewer.camera.directionWC) < 0) continue; // behind the view
      const fy = h / 2 / Math.tan((viewer.camera.frustum.fovy || rad(60)) / 2), sr = clamp(((iss ? 3000 : 1800) * (arcade ? 5 : 1) * fy) / sd, arcade ? 14 : 3, 220); // in the arcade they are never smaller than a full sprite // drawn as if a couple of km wide: it grows as you fly up to it
      g.save(); g.translate(q.x, q.y);
      if (sr < 7) { g.fillStyle = g.shadowColor = iss ? '#ffd60a' : '#bfe6ff'; g.shadowBlur = 10; g.beginPath(); g.arc(0, 0, sr, 0, 7); g.fill(); }
      else { // body, two solar wings with cells, an antenna dish
        g.rotate(Math.sin(performance.now() / 3000 + sat.p.x) * 0.3); g.shadowColor = '#bfe6ff'; g.shadowBlur = 12;
        for (const e of [-1, 1]) {
          const x0 = e > 0 ? sr * 0.7 : -sr * 2.9, pw = sr * 2.2, ph = sr * 0.9;
          g.fillStyle = '#1f4fa8'; g.fillRect(x0, -ph / 2, pw, ph); g.strokeStyle = '#9cc9ff'; g.lineWidth = Math.max(1, sr * 0.04); g.strokeRect(x0, -ph / 2, pw, ph);
          g.beginPath(); for (let i = 1; i < 4; i++) { g.moveTo(x0 + (pw * i) / 4, -ph / 2); g.lineTo(x0 + (pw * i) / 4, ph / 2); } g.moveTo(x0, 0); g.lineTo(x0 + pw, 0); g.stroke();
          g.strokeStyle = '#c8ccd4'; g.lineWidth = Math.max(1, sr * 0.08); g.beginPath(); g.moveTo(e * sr * 0.45, 0); g.lineTo(e > 0 ? x0 : x0 + pw, 0); g.stroke(); // boom
        }
        const gr = g.createLinearGradient(0, -sr * 0.6, 0, sr * 0.6); gr.addColorStop(0, iss ? '#fff3c4' : '#f5f7fa'); gr.addColorStop(1, iss ? '#d4a017' : '#9aa3b2');
        g.fillStyle = gr; g.fillRect(-sr * 0.45, -sr * 0.6, sr * 0.9, sr * 1.2); g.strokeStyle = '#555'; g.lineWidth = Math.max(1, sr * 0.04); g.strokeRect(-sr * 0.45, -sr * 0.6, sr * 0.9, sr * 1.2);
        g.fillStyle = '#e6e6e6'; g.beginPath(); g.ellipse(0, -sr * 0.85, sr * 0.3, sr * 0.12, 0, 0, 7); g.fill(); g.stroke(); // dish
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
    if (regs && quest()) drawRegs();
    if (caps && quest()) drawCaps();
    if (arcade) drawArcade(w, h, text);
    if (third && A.ship && !p2) { // the own ship, where it really is, seen from behind
      const q = (C.SceneTransforms.worldToWindowCoordinates || C.SceneTransforms.wgs84ToWindowCoordinates)(scene, C.Cartesian3.fromRadians(s.lon, s.lat, s.alt));
      if (q) shipBack(q.x, q.y, 34, skin(1), s.roll * 0.6 + (s.rollOff || 0), hit);
    }
    if (p2 || remote) mpDraw(w, h, text);
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
    g.strokeRect(cx - bx - 38, cy - 12, 76, 24); text(landing === 'parked' ? Math.round((s.taxi || 0) * 3.6) + ' km/h' : Math.round(s.v * warp * KT) + ' KT', cx - bx, cy + 1, 14); // the turbo counts as speed; on the ground, the driving speed
    { // turbo gauge under the speed: one segment per turbo level, lit up to the current one, and the real speed in km/h
      const n = WARPS.indexOf(warp), sw = 76 / WARPS.length;
      g.save(); WARPS.forEach((_, i) => { g.fillStyle = i <= n ? (i >= 4 ? '#ff453a' : i >= 2 ? '#ffd60a' : '#39ff14') : 'rgba(57,255,20,.18)'; g.fillRect(cx - bx - 38 + i * sw + 1, cy + 18, sw - 2, 8); }); g.restore();
      text(`TURBO ×${warp} · ${Math.round(s.v * warp * 3.6).toLocaleString(OGE_LANG)} km/h`, cx - bx, cy + 40, 12);
    }
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
    text(A.name.split(' — ')[0], w - 24, h - 22, 12, 'right');
    if ($('flyBtns').classList.contains('keyboard')) text(T('K: ver los controles'), w - 24, h - 40, 12, 'right'); // with a keyboard there are no buttons: this is the reminder
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
      const shape = (v) => { const m = Math.abs(clamp(v, -1, 1)); return m < 0.12 ? 0 : Math.sign(v) * ((m - 0.12) / 0.88) ** 1.7; }; // a small dead zone and a gentle curve: fine control near the middle, full turn at the edge
      stick.x = shape((t.clientX - b.left - touch.x0) / r); stick.y = shape((t.clientY - b.top - touch.y0) / r);
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
    if (p2 && P2KEYS.has(k)) { if (k === 'enter') fire(2); else keys.add(k); e.preventDefault(); e.stopPropagation(); return; } // player 2's keys
    if (k === 'escape') stop();
    else if (k === 'enter' && !p2) { paused = !paused; last = performance.now(); OGE.toast(paused ? T('Pausa (Intro para seguir)') : T('Sigue el vuelo')); } // Enter (or Space) pauses
    else if (k === ' ' && !(A && A.ship)) { paused = !paused; last = performance.now(); } // the aircraft still pause with Space
    else if (k === ' ') { nextWarp(1); e.preventDefault(); } // on the ship Space raises the turbo
    else if (k === 'shift' && e.code !== 'ShiftRight' && A && A.ship) nextWarp(-1); // left Shift lowers it
    else if (k === 'h') showHud = !showHud;
    else if (k === 'y' && A && A.ship) { third = !third; localStorage.setItem('oge.third', third ? '1' : ''); OGE.toast(third ? T('Cámara en tercera persona (Y)') : T('Cámara en primera persona (Y)')); }
    else if (k === 'l') s.gear = !s.gear;
    else if (k === 'u' && race && A.ship) useItem(); // U uses the race item
    else if (k === 'f' && A && A.ship) maneuver('uturn'); // F: turn back (on the ship F has no flaps)
    else if (k === 'f' || k === ']' || k === '[') s.flaps = clamp(s.flaps + (e.shiftKey || k === '[' ? -1 : 1), 0, 2);
    else if (k === 'c' && A.ship && landing) $('flyLift').click(); // C takes off again after landing
    else if (k === 'c') { stick.x = stick.y = 0; s.trim = 0; }
    else if (k === 'q' && A && A.ship && !e.repeat) { stopped = !stopped; if (!stopped) { s.v = Math.max(s.v, A.v0 || 300); s.throttle = Math.max(s.throttle, 0.5); } } // Q: stop and hover; Q again: fly on
    else if (k === 'b') fire(); // B fires
    else if (k === 'v' && A.ship) bomb(); // V drops a bomb
    else if (k === 'g') nextWarp(-1);
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
  // OpenStarshipEarth: drop straight down to the ground and lift off again
  $('flyLand').onclick = () => { if (!on || !A.ship) return OGE.toast('Aterrizar y despegar son de la OpenStarshipEarth.'); landing = landing ? null : 'down'; sfx(landing ? 'land' : 'liftoff'); };
  $('flyLift').onclick = () => { if (!on || !A.ship) return; landing = 'up'; sfx('liftoff'); };
  $('advBtn').onclick = () => { if (on) stop(); adventure(); };
  $('raceBtn').onclick = () => { if (on) stop(); raceMode(); };
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
  $('mpBtn').onclick = $('flyMp').onclick = multiplayer;
  for (const b of document.querySelectorAll('#flyActs button')) b.addEventListener('pointerdown', (e) => { e.preventDefault(); document.dispatchEvent(new KeyboardEvent('keydown', { key: b.dataset.key })); setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', { key: b.dataset.key })), 80); }); // the same as their keys
  if (!matchMedia('(pointer: coarse)').matches) { // with a keyboard the key buttons are not needed: only Controls and Scores stay at hand
    $('flyBtns').classList.add('keyboard');
    $('flyKeys').append(Object.assign(document.createElement('li'), { className: 'keyBtns' })); $('flyKeys').lastChild.append($('flyScores'), $('flyMp'), $('flyReset')); $('flyKeys').style.right = $('flyRules').style.right = '12px'; // no column of buttons beside them // the few actions without a key live in the K panel
  } else $('flyBtns').classList.add('touch'); // on a phone the stick steers (left half of the screen): the right column keeps the touch actions and the speed
  $('flyThird').onclick = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y' }));
  $('flyMore').onclick = () => { const more = $('flyBtns').classList.toggle('more'); localStorage.setItem('oge.flyMore', more ? '1' : ''); }; // remembered
  $('flyBtns').classList.toggle('more', !!localStorage.getItem('oge.flyMore'));
  if (new URLSearchParams(location.search).has('play')) setTimeout(() => { document.body.classList.add('game-only'); $('shipBtn').click(); }, 1500); // the OpenStarshipEarth page opens the game directly
  const lastOpts = () => { try { return JSON.parse(localStorage.getItem('oge.flyOpts')) || {}; } catch { return {}; } };
  function quickShip(mode = 'arcade') { // the OpenStarshipEarth arcade with the options used last time; 'free': no enemies, no goals
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
        ['adventure', '🗺 Aventura: países por etapas, banderas y jefe final'],
        ['arcade', '🎯 Partida libre con ranking: enemigos, aros, monedas y jefes'],
        ['race', '🏁 De ciudad a ciudad: llega a la meta en el menor tiempo'],
        ['free', '🕊 Vuelo libre: sin enemigos ni objetivos, solo las vistas']] },
        { id: 'diff', label: 'Dificultad (cada una tiene su propio ranking)', type: 'select', value: diff, options: Object.entries(DIFF).map(([k, d]) => [k, d.name]) }] });
    if (!v) return;
    localStorage.setItem('oge.shipMode', v.mode);
    if (DIFF[v.diff]) { diff = v.diff; localStorage.setItem('oge.diff', diff); }
    if (v.mode === 'adventure') adventure(); else if (v.mode === 'race') raceMode(); else quickShip(v.mode);
  };
  OGE.flight = { start, stop, maneuver, state: () => s, flying: () => on, game: () => ({ score, coins, objs, hp, bombs, incoming, shields, regs, tut: tut && tut.i, p2, remote }) };
})();
