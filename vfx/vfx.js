/* Barrel Ninja – VFX-Modul (vfx.js)
   Abhängigkeitsfrei, plain script, Stil wie index.html. Stellt global `BNVFX` bereit:
     const vfx = BNVFX.create({ maxParticles: 280 });
   Einheiten: Welt-Einheiten von index.html (WORLD_H = 800), Zeiten in ms (wie update(dtMs)).
   Regeln: nur Palettenfarben aus concepts/art-direction.md, keine Warn-Marker/Indikatoren –
   der Mauerriss IST die Ausholbewegung der Pflanze, nichts darüber hinaus.
   Performance: Struct-of-Arrays-Partikelpool (Float32Array), feste Pools für Hiebe/Risse/Seile,
   vorgerenderte Sprites (Offscreen-Canvas in Pixeldichte scale*dpr), kein shadowBlur, keine
   Gradienten pro Frame, keine Allokationen pro Frame. */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ PALETTE (verbindlich) */
  const PALETTE = {
    abyss:'#05070F', fog:'#0B1426', top:'#12304A',
    stone:'#1C2A3A', joint:'#0E1724', edge:'#3A5670', moss:'#2F5B4A',
    moon:'#9FD8FF', lantern:'#FFB347', lanternCore:'#FFE2A8',
    suit:'#1F2A5C', suitShade:'#121833', skin:'#E8C9A6', scarf:'#E2283C',
    steel:'#D8E4EE', trail:'#4FF0FF',
    wood:'#8A5A2E', woodDark:'#5A3518', iron:'#4A4F57', ironGlint:'#9AA3AD',
    rope:'#C9A66B', ropeShade:'#8C6E3F',
    krabbler:'#3B3F4A', krabblerSpike:'#8C8F99', krabblerEye:'#FF5A2A',
    bat:'#241B3A', batBlade:'#B9C3D6', batEye:'#FFC23A',
    cutter:'#4E7A3A', cutterClaw:'#C7CED6',
    spike:'#6E7682', spikeTip:'#DDE3EA',
    text:'#F4F1EA', accentCyan:'#4FF0FF', accentRed:'#E2283C',
    flash:'#FFFFFF'   // „1 Frame weißer Flash am Treffpunkt“ (art-direction.md, Abschnitt Licht & Effekte)
  };
  const ALLOWED = new Set(Object.values(PALETTE).map(c => c.toUpperCase()));

  // Partikelfarben je Gegner (nur Palette). Pflanzen haben in art-direction.md keine eigenen Farben → Moos/Grün (offene Frage).
  const ENEMY_COLS = {
    krabbler:   ['krabbler', 'krabblerSpike', 'krabblerEye'],
    fledermaus: ['bat', 'batBlade', 'batEye'],
    seilschneider: ['cutter', 'cutterClaw'],
    beisspflanze: ['moss', 'cutter', 'scarf'],
    spuckpflanze: ['moss', 'cutter', 'edge'],
    fass: ['wood', 'woodDark'],
    default: ['steel', 'edge']
  };

  const DEFAULTS = {
    maxParticles: 280,            // hartes Budget (Pool-Größe). Mobile-Ziel 60 fps.
    adaptive: true,               // drosselt Emission auf 60 %, wenn draw()-Intervall dauerhaft > 22 ms
    pixelRatio: 1,                // = scale * dpr aus index.html resize()
    hitStopMinMs: 40, hitStopMaxMs: 60, hitStopDefaultMs: 50,   // balancing-spec attack.hitStopMs = 50
    hitStopScale: 0,              // Zeitskala während Hit-Stop (0 = Freeze)
    shakeDefaultPx: 4, shakeMaxPx: 6, shakeDecayPerS: 2.6, shakeFreqHz: 28,
    reducedMotion: 'auto',        // 'auto' = prefers-reduced-motion, sonst true/false
    reducedShakeScale: 0,         // Faktor für Screenshake bei reduced motion
    reducedFlashScale: 0.5,
    slashMs: 120,                 // = attack.activeMs
    slashTrailFrames: 4,          // 3–4 Geister-Frames
    slashFrameMs: 1000 / 60,
    slashColor: 'trail',
    crackMs: 900,                 // = beisspflanze.crackMs.start
    holeHoldMs: 900               // = beisspflanze.stayMs, falls nicht per wallClose() beendet
  };

  /* ------------------------------------------------------------------ HELPERS */
  const TAU = Math.PI * 2;
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function smooth(p) { p = clamp(p, 0, 1); return p * p * (3 - 2 * p); }
  function hash1(n) { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
  function noise1(t) { const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f); return hash1(i) * (1 - u) + hash1(i + 1) * u; } // 0..1
  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') { try { const c = new OffscreenCanvas(w, h); if (c.getContext('2d')) return c; } catch (e) {} }
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }
  function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

  // Partikelarten
  const K_DOT = 0, K_GLOW = 1, K_SPARK = 2, K_SPLINTER = 3, K_CHUNK = 4, K_RING = 5, K_DUST = 6, K_FIBER = 7;
  const B_NORMAL = 0, B_ADD = 1;

  function create(userOpts) {
    const O = Object.assign({}, DEFAULTS, userOpts || {});
    const warned = new Set();

    /* -------------------------------------------------------------- FARBEN */
    function col(c) {
      if (c == null) return PALETTE.steel;
      if (PALETTE[c]) return PALETTE[c];
      const u = String(c).toUpperCase();
      if (ALLOWED.has(u)) return u;
      if (!warned.has(u)) { warned.add(u); if (root.console) console.warn('[BNVFX] Farbe nicht in Palette, ersetzt:', c); }
      return PALETTE.steel;
    }
    // Farbtabelle: Index → Hexstring, damit der Pool nur Uint8 speichert
    const colorList = Object.values(PALETTE).filter((v, i, a) => a.indexOf(v) === i);
    const colorIdx = {}; colorList.forEach((c, i) => colorIdx[c.toUpperCase()] = i);
    const ciCache = Object.create(null);   // Name/Hex → Index, ohne String-Allocs pro Frame
    function ci(c) { let i = ciCache[c]; if (i === undefined) i = ciCache[c] = colorIdx[col(c).toUpperCase()]; return i; }

    /* -------------------------------------------------------------- SPRITES (Offscreen, DPR-scharf) */
    let pr = O.pixelRatio;
    let discs = [], glows = [], lanternSprite = null, vignetteSprite = null;
    const DISC_R = 8, GLOW_R = 24;  // logische Basisradien; gezeichnet wird skaliert
    function buildDisc(i) {
      const s = Math.max(8, Math.min(96, Math.ceil(DISC_R * 2 * pr * 1.5)));
      const c = makeCanvas(s, s), g = c.getContext('2d');
      g.fillStyle = colorList[i]; g.beginPath(); g.arc(s / 2, s / 2, s / 2 - 1, 0, TAU); g.fill();
      return c;
    }
    function buildGlow(i) {
      const s = Math.max(16, Math.min(160, Math.ceil(GLOW_R * 2 * pr)));
      const c = makeCanvas(s, s), g = c.getContext('2d'), [r, gg, b] = hexRgb(colorList[i]);
      const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      gr.addColorStop(0, `rgba(${r},${gg},${b},1)`); gr.addColorStop(0.25, `rgba(${r},${gg},${b},0.55)`);
      gr.addColorStop(0.6, `rgba(${r},${gg},${b},0.15)`); gr.addColorStop(1, `rgba(${r},${gg},${b},0)`);
      g.fillStyle = gr; g.fillRect(0, 0, s, s); return c;
    }
    function disc(i) { return discs[i] || (discs[i] = buildDisc(i)); }
    function glow(i) { return glows[i] || (glows[i] = buildGlow(i)); }
    function buildLantern() {
      const s = Math.max(64, Math.min(320, Math.ceil(140 * pr)));   // Laternen-Glow r 80–140, weich → halbe Auflösung reicht
      const c = makeCanvas(s, s), g = c.getContext('2d');
      const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      gr.addColorStop(0, 'rgba(255,226,168,0.55)');   // #FFE2A8 Kern
      gr.addColorStop(0.12, 'rgba(255,179,71,0.38)');  // #FFB347
      gr.addColorStop(0.4, 'rgba(255,179,71,0.12)');
      gr.addColorStop(1, 'rgba(255,179,71,0)');
      g.fillStyle = gr; g.fillRect(0, 0, s, s); return c;
    }
    function buildVignette() {
      const w = 128, h = 208, c = makeCanvas(w, h), g = c.getContext('2d');
      g.translate(w / 2, h / 2); g.scale(1, h / w);
      const gr = g.createRadialGradient(0, 0, w * 0.32, 0, 0, w * 0.78);
      gr.addColorStop(0, 'rgba(226,40,60,0)'); gr.addColorStop(1, 'rgba(226,40,60,1)');   // #E2283C
      g.fillStyle = gr; g.fillRect(-w, -w, w * 2, w * 2); return c;
    }
    function rebuildSprites() {
      const usedD = discs.map((d, i) => d ? i : -1).filter(i => i >= 0), usedG = glows.map((d, i) => d ? i : -1).filter(i => i >= 0);
      discs = []; glows = [];
      for (const i of usedD) disc(i); for (const i of usedG) glow(i);
      lanternSprite = buildLantern(); vignetteSprite = vignetteSprite || buildVignette();
    }
    function prewarm() {
      for (const k of ['trail', 'flash', 'steel', 'wood', 'woodDark', 'stone', 'edge', 'joint', 'rope', 'ropeShade', 'lanternCore', 'krabblerEye', 'batEye'])
        { disc(ci(k)); glow(ci(k)); }
    }

    /* -------------------------------------------------------------- PARTIKEL-POOL (SoA) */
    const MAX = O.maxParticles | 0;
    const px = new Float32Array(MAX), py = new Float32Array(MAX), pvx = new Float32Array(MAX), pvy = new Float32Array(MAX);
    const plife = new Float32Array(MAX), pmax = new Float32Array(MAX), prot = new Float32Array(MAX), pvr = new Float32Array(MAX);
    const psz = new Float32Array(MAX), psz2 = new Float32Array(MAX), pg = new Float32Array(MAX), pdrag = new Float32Array(MAX), pa = new Float32Array(MAX);
    const pkind = new Uint8Array(MAX), pcol = new Uint8Array(MAX), pblend = new Uint8Array(MAX);
    let alive = 0, cursor = 0, budgetScale = 1;

    function alloc() {
      if (alive >= Math.floor(MAX * budgetScale)) {
        // Budget voll: Partikel mit der kürzesten Restlebenszeit übernehmen (nur bei Volllast O(n))
        let best = -1, bl = 1e9;
        for (let i = 0; i < MAX; i++) if (plife[i] > 0 && plife[i] < bl) { bl = plife[i]; best = i; }
        return best;
      }
      for (let n = 0; n < MAX; n++) { const i = (cursor + n) % MAX; if (plife[i] <= 0) { cursor = (i + 1) % MAX; alive++; return i; } }
      return -1;
    }
    // Generischer Emitter. spec: { kind, color(s), life, size, size2, speed[min,max], angle, spread, g, drag, rot, vr, alpha, blend, vx, vy, jitter }
    const KIND = { dot:K_DOT, glow:K_GLOW, spark:K_SPARK, splinter:K_SPLINTER, chunk:K_CHUNK, ring:K_RING, dust:K_DUST, fiber:K_FIBER };
    function emit(x, y, n, s) {
      const kind = typeof s.kind === 'number' ? s.kind : (KIND[s.kind] ?? K_DOT);
      const cols = s.colors || [s.color || 'steel'];
      const spd = s.speed || [40, 160], life = s.life || [400, 700], sz = s.size || [1.5, 3.5];
      const ang = s.angle ?? 0, spread = s.spread ?? TAU, jit = s.jitter || 0;
      let made = 0;
      for (let k = 0; k < n; k++) {
        const i = alloc(); if (i < 0) break;
        const a = ang + (Math.random() - 0.5) * spread, v = rnd(spd[0], spd[1]);
        px[i] = x + (jit ? rnd(-jit, jit) : 0); py[i] = y + (jit ? rnd(-jit, jit) : 0);
        pvx[i] = Math.cos(a) * v + (s.vx || 0); pvy[i] = Math.sin(a) * v + (s.vy || 0);
        plife[i] = pmax[i] = rnd(life[0], life[1]);
        psz[i] = rnd(sz[0], sz[1]); psz2[i] = s.size2 ? rnd(s.size2[0], s.size2[1]) : psz[i];
        pg[i] = s.g ?? 500; pdrag[i] = s.drag ?? 0; pa[i] = s.alpha ?? 1;
        prot[i] = s.rot != null ? s.rot : rnd(0, TAU); pvr[i] = s.vr ? rnd(-s.vr, s.vr) : 0;
        pkind[i] = kind; pcol[i] = ci(cols[(Math.random() * cols.length) | 0]);
        pblend[i] = s.blend === 'add' || s.blend === 'lighter' ? B_ADD : B_NORMAL;
        made++;
      }
      if (kind === K_DOT || kind === K_DUST) for (const c of cols) disc(ci(c));
      if (kind === K_GLOW) for (const c of cols) glow(ci(c));
      return made;
    }

    /* -------------------------------------------------------------- FESTE POOLS */
    const slashes = []; for (let i = 0; i < 4; i++) slashes.push({ on:false, x:0, y:0, dir:1, t:0, r:54, col:0, track:null, oy:0, a0:0, sweep:0, dur:120, w:7 });
    const flashes = []; for (let i = 0; i < 8; i++) flashes.push({ on:false, x:0, y:0, r:26, frames:0 });
    const SEG = 4, BR = 8;
    const cracks = []; for (let i = 0; i < 6; i++) cracks.push({ on:false, gen:0, x:0, y:0, r:34, side:0, t:0, ms:900, state:0, holeT:0, holdMs:900, closeMs:300, closeT:0,
      pts:new Float32Array(BR * (SEG + 1) * 2), delay:new Float32Array(BR), progress:0, broken:false, auto:true, pebbleAcc:0 });
    const ropes = []; for (let i = 0; i < 2; i++) ropes.push({ on:false, x:0, y:0, t:0, ang:-Math.PI / 2 });

    /* -------------------------------------------------------------- ZUSTAND: Hit-Stop / Shake / Overlay */
    let hitStopLeft = 0, trauma = 0, shakePxCur = 0, shakeT = 0, shakeX = 0, shakeY = 0, seed = Math.random() * 100;
    let vignette = 0, screenFlash = 0, now = 0;
    let reduced = false;
    if (O.reducedMotion === 'auto' && root.matchMedia) {
      const mq = root.matchMedia('(prefers-reduced-motion: reduce)'); reduced = mq.matches;
      if (mq.addEventListener) mq.addEventListener('change', e => { reduced = e.matches; });
    } else reduced = O.reducedMotion === true;

    /* -------------------------------------------------------------- PUBLIC: Kern */
    function setPixelRatio(p) { p = Math.max(0.5, Math.min(6, +p || 1)); if (Math.abs(p - pr) < 0.01 && lanternSprite) return; pr = p; rebuildSprites(); }

    function hitStop(ms) {
      ms = clamp(ms == null ? O.hitStopDefaultMs : ms, O.hitStopMinMs, O.hitStopMaxMs);
      hitStopLeft = Math.max(hitStopLeft, ms);   // nicht addieren: Mehrfachtreffer verlängern nicht
    }
    function shake(pxAmt) {
      pxAmt = clamp(pxAmt == null ? O.shakeDefaultPx : pxAmt, 0, O.shakeMaxPx);
      // Amplitude = shakeMaxPx * trauma² → trauma so setzen, dass Spitze = pxAmt
      trauma = Math.min(1, Math.max(trauma, Math.sqrt(pxAmt / O.shakeMaxPx)));
    }
    function addTrauma(t) { trauma = clamp(trauma + t, 0, 1); }

    // Rückgabe: Weltzeit-dt (0 während Hit-Stop). worldScale z. B. G.slowMo.
    function update(dtMs, worldScale) {
      const real = dtMs;
      now += real;
      // Shake/Overlays laufen in Echtzeit (auch während Hit-Stop – so wirkt der Treffer)
      trauma = Math.max(0, trauma - O.shakeDecayPerS * real / 1000);
      shakeT += real / 1000;
      const amp = O.shakeMaxPx * trauma * trauma * (reduced ? O.reducedShakeScale : 1);
      const f = O.shakeFreqHz;
      shakeX = amp * (noise1(seed + shakeT * f) * 2 - 1);
      shakeY = amp * (noise1(seed + 57.3 + shakeT * f) * 2 - 1);
      shakePxCur = amp;
      vignette = Math.max(0, vignette - real / 650);
      screenFlash = Math.max(0, screenFlash - real / 400);

      let dt = real * (worldScale == null ? 1 : worldScale);
      if (hitStopLeft > 0) { hitStopLeft -= real; dt *= O.hitStopScale; }
      if (dt > 0) step(dt);
      return dt;
    }
    function step(dtMs) {
      const dt = dtMs / 1000;
      if (alive > 0) {
        let n = 0;
        for (let i = 0; i < MAX; i++) {
          if (plife[i] <= 0) continue;
          plife[i] -= dtMs;
          if (plife[i] <= 0) { alive--; continue; }
          n++;
          if (pdrag[i]) { const d = Math.max(0, 1 - pdrag[i] * dt); pvx[i] *= d; pvy[i] *= d; }
          pvy[i] += pg[i] * dt; px[i] += pvx[i] * dt; py[i] += pvy[i] * dt; prot[i] += pvr[i] * dt;
        }
        alive = n;
      }
      for (const s of slashes) if (s.on) { s.t += dtMs; if (s.t > s.dur + O.slashTrailFrames * O.slashFrameMs + 40) { s.on = false; s.track = null; } }
      for (const r of ropes) if (r.on) { r.t += dtMs; if (r.t > 520) r.on = false; }
      for (const c of cracks) if (c.on) stepCrack(c, dtMs);
    }

    /* -------------------------------------------------------------- SCHWERTBOGEN */
    // dir: -1 links, +1 rechts, 0 aufwärts. opts: { radius, color, track:{x,y} (z. B. N), offsetY, ms, width }
    function slash(x, y, dir, opts) {
      opts = opts || {};
      let s = slashes[0]; for (const c of slashes) { if (!c.on) { s = c; break; } if (c.t > s.t) s = c; }
      s.on = true; s.t = 0; s.x = x; s.y = y; s.dir = dir < 0 ? -1 : dir > 0 ? 1 : 0;
      s.r = opts.radius || 54; s.w = opts.width || 7; s.dur = opts.ms || O.slashMs;
      s.col = ci(opts.color || O.slashColor); s.track = opts.track || null; s.oy = opts.offsetY || 0;
      // seitlicher Bogen: von schräg oben (−69°) über die Waagerechte nach schräg unten
      // dir 0 = Aufwärtshieb (Seilschneider): flacher Bogen über dem Kopf von links nach rechts
      if (s.dir === 0) { s.a0 = Math.PI * 1.12; s.sweep = Math.PI * 0.76; }
      else { s.a0 = s.dir > 0 ? -1.2 : Math.PI + 1.2; s.sweep = s.dir > 0 ? 2.1 : -2.1; }
      glow(s.col); glow(ci('flash'));
      return s;
    }
    function bladeAngle(s, t) { const k = clamp(t / s.dur, 0, 1); return s.a0 + s.sweep * (1 - Math.pow(1 - k, 3)); }

    /* -------------------------------------------------------------- TREFFER / FLASH */
    function flash(x, y, r) {
      let f = flashes[0]; for (const c of flashes) if (!c.on) { f = c; break; }
      f.on = true; f.x = x; f.y = y; f.r = r || 26; f.frames = 1;   // genau 1 gerenderter Frame
    }
    // Komplettpaket Gegnertreffer: 10–16 Partikel + Funken + Flash + Hit-Stop + 4 px Shake
    function hit(x, y, opts) {
      opts = opts || {};
      const cols = opts.colors || ENEMY_COLS[opts.type] || ENEMY_COLS.default;
      const n = opts.count || (10 + ((Math.random() * 7) | 0));
      const dir = opts.dir || 0;
      emit(x, y, n, { kind:'dot', colors:cols, speed:[80, 260], life:[350, 650], size:[1.6, 3.8], g:500, vy:-40,
        angle: dir ? (dir > 0 ? 0 : Math.PI) : 0, spread: dir ? 2.4 : TAU });
      emit(x, y, 6, { kind:'spark', color:opts.spark || 'trail', speed:[220, 420], life:[120, 220], size:[1.2, 2], size2:[10, 18], g:0, drag:6, blend:'add',
        angle: dir ? (dir > 0 ? 0 : Math.PI) : 0, spread: dir ? 1.6 : TAU });
      flash(x, y, opts.flashR || 26);
      if (opts.hitStop !== false) hitStop(opts.hitStop);
      if (opts.shake !== false) shake(opts.shake ?? O.shakeDefaultPx);
    }

    /* -------------------------------------------------------------- FASS */
    function barrelHit(x, y, dir) {
      emit(x, y, 5, { kind:'splinter', colors:['wood', 'woodDark'], speed:[120, 260], angle: dir ? (dir > 0 ? -0.5 : Math.PI + 0.5) : -Math.PI / 2, spread:1.6,
        life:[500, 800], size:[3, 5], size2:[8, 14], g:900, vr:14 });
      emit(x, y, 4, { kind:'dust', colors:['woodDark', 'edge'], speed:[10, 50], life:[350, 550], size:[5, 9], g:-20, alpha:0.3 });
      shake(3);
    }
    // Fass zerplatzt: 8–12 Splitter, 2 Eisenring-Hälften, Staubwolke, roter Vignetten-Puls
    function barrelBreak(x, y, opts) {
      opts = opts || {};
      emit(x, y + 4, 8 + ((Math.random() * 5) | 0), { kind:'splinter', colors:['wood', 'woodDark', 'wood'], speed:[160, 420], angle:-Math.PI / 2, spread:Math.PI,
        life:[900, 1200], size:[5, 8], size2:[16, 26], g:900, vy:-60, vr:14, jitter:14 });
      for (let h = 0; h < 2; h++) {
        const i = alloc(); if (i < 0) break;
        px[i] = x; py[i] = y + 8; pvx[i] = (h ? 1 : -1) * rnd(140, 220); pvy[i] = -rnd(120, 220);
        plife[i] = pmax[i] = 1200; psz[i] = psz2[i] = 24; pg[i] = 900; pdrag[i] = 0; pa[i] = 1;
        prot[i] = h ? 0 : Math.PI; pvr[i] = (h ? 1 : -1) * 9; pkind[i] = K_RING; pcol[i] = ci('iron'); pblend[i] = B_NORMAL;
      }
      emit(x, y + 10, 14, { kind:'dust', colors:['edge', 'woodDark', 'stone'], speed:[30, 120], life:[550, 800], size:[6, 14], g:-20, drag:2, alpha:0.35 });
      emit(x, y, 6, { kind:'spark', color:'lanternCore', speed:[180, 360], life:[120, 220], size:[1, 1.6], size2:[8, 14], g:200, drag:5, blend:'add' });
      vignette = Math.max(vignette, opts.vignette ?? 1);
      screenFlash = Math.max(screenFlash, 0.4);
      hitStop(opts.hitStop ?? 60);
      shake(opts.shake ?? O.shakeDefaultPx);
    }

    /* -------------------------------------------------------------- MAUERRISS (Pflanzen aus der Rückwand) */
    // Riss wächst während crackMs in drei Schüben (= sichtbare Ausholbewegung), dann Bruch mit Steinbröckchen.
    // opts: { crackMs, radius, side (0 Rückwand, ±1 Seitenwand: fächert nur ins Innere), holdMs, autoBreak }
    function wallBreak(x, y, opts) {
      opts = opts || {};
      let c = null; for (const k of cracks) if (!k.on) { c = k; break; }
      if (!c) { c = cracks[0]; for (const k of cracks) if (k.t > c.t) c = k; }
      c.on = true; c.gen++; c.x = x; c.y = y; c.t = 0; c.state = 0; c.holeT = 0; c.closeT = 0; c.broken = false; c.progress = 0; c.pebbleAcc = 0;
      c.ms = opts.crackMs || O.crackMs; c.r = opts.radius || 34; c.side = opts.side || 0;
      c.holdMs = opts.holdMs ?? O.holeHoldMs; c.closeMs = opts.closeMs || 300; c.auto = opts.autoBreak !== false;
      const base = Math.random() * TAU;
      for (let b = 0; b < BR; b++) {
        let a = c.side ? (c.side > 0 ? Math.PI : 0) + (b / (BR - 1) - 0.5) * Math.PI * 0.95 : base + b / BR * TAU + rnd(-0.25, 0.25);
        const len = c.r * rnd(0.75, 1.35);
        let cx = x, cy = y, o = b * (SEG + 1) * 2;
        c.pts[o] = x; c.pts[o + 1] = y;
        for (let s = 1; s <= SEG; s++) {
          a += rnd(-0.45, 0.45); const l = len / SEG * rnd(0.7, 1.2);
          cx += Math.cos(a) * l; cy += Math.sin(a) * l * 0.85;
          c.pts[o + s * 2] = cx; c.pts[o + s * 2 + 1] = cy;
        }
        c.delay[b] = rnd(0, 0.3);
      }
      disc(ci('stone')); disc(ci('edge')); disc(ci('joint'));
      return c;
    }
    function crackProgress(p) {   // drei Schübe: wirkt wie Druck von hinten
      const s1 = smooth(p / 0.35) * 0.3, s2 = smooth((p - 0.4) / 0.25) * 0.35, s3 = smooth((p - 0.72) / 0.28) * 0.35;
      return s1 + s2 + s3;
    }
    function stepCrack(c, dtMs) {
      c.t += dtMs;
      if (c.state === 0) {
        const p = c.t / c.ms; c.progress = crackProgress(p);
        c.pebbleAcc += dtMs * (0.4 + 2.6 * p) / 120;   // Bröckeln nimmt zu
        while (c.pebbleAcc >= 1) { c.pebbleAcc -= 1;
          emit(c.x + rnd(-c.r * 0.6, c.r * 0.6) * c.progress, c.y + rnd(-c.r * 0.4, c.r * 0.4) * c.progress, 1,
            { kind:'dot', colors:['edge', 'stone', 'joint'], speed:[5, 30], angle:Math.PI / 2, spread:1.2, life:[450, 700], size:[1.2, 2.6], g:520 }); }
        if (c.auto && c.t >= c.ms) breakCrack(c);
      } else if (c.state === 1) {
        c.holeT += dtMs;
        if (c.holdMs > 0 && c.holeT >= c.holdMs) { c.state = 2; c.closeT = 0; }
      } else if (c.state === 2) {
        c.closeT += dtMs; if (c.closeT >= c.closeMs) c.on = false;
      }
    }
    function breakCrack(c) {
      if (c.state !== 0) return;
      c.state = 1; c.holeT = 0; c.progress = 1; c.broken = true;
      emit(c.x, c.y, 10 + ((Math.random() * 4) | 0), { kind:'chunk', colors:['stone', 'edge', 'stone', 'joint'], speed:[90, 260],
        angle: c.side ? (c.side > 0 ? Math.PI : 0) : -Math.PI / 2, spread: c.side ? 2.2 : TAU, life:[700, 1000], size:[2.5, 5.5], g:950, vr:12, jitter:c.r * 0.3 });
      emit(c.x, c.y, 8, { kind:'dust', colors:['edge', 'stone'], speed:[20, 90], life:[450, 750], size:[6, 12], g:-15, drag:2.5, alpha:0.3, jitter:6 });
      shake(3);
    }
    function wallBreakNow(h) { if (h && h.on) breakCrack(h); }
    function wallClose(h, ms) { if (h && h.on && h.state !== 2) { if (h.state === 0) breakCrack(h); h.state = 2; h.closeT = 0; h.closeMs = ms || h.closeMs; } }

    /* -------------------------------------------------------------- SEILRISS */
    // Seil schnappt: Fasern spritzen, beide Enden peitschen zurück (oben hoch, unten fällt), Glint, Shake.
    function ropeSnap(x, y, opts) {
      opts = opts || {};
      let r = ropes[0]; for (const k of ropes) if (!k.on) { r = k; break; }
      r.on = true; r.x = x; r.y = y; r.t = 0; r.ang = opts.angle ?? -Math.PI / 2;
      emit(x, y, 16, { kind:'fiber', colors:['rope', 'ropeShade', 'rope'], speed:[60, 220], life:[500, 900], size:[0.8, 1.3], size2:[5, 10], g:260, drag:2.2, vr:10 });
      emit(x, y, 5, { kind:'spark', color:'lanternCore', speed:[160, 300], life:[100, 180], size:[1, 1.5], size2:[8, 12], g:0, drag:6, blend:'add' });
      flash(x, y, 14);
      shake(opts.shake ?? O.shakeDefaultPx);
      return r;
    }
    // laufendes Durchschneiden: pro Frame aufrufen (intensity 0..1 = Schnittfortschritt), nur Fasern
    let frayAcc = 0;
    function ropeFray(x, y, intensity, dtMs) {
      frayAcc += (dtMs || 16.7) * (0.2 + 0.8 * clamp(intensity, 0, 1)) / 90;
      while (frayAcc >= 1) { frayAcc -= 1;
        emit(x, y, 1, { kind:'fiber', colors:['rope', 'ropeShade'], speed:[20, 70], life:[350, 600], size:[0.7, 1.1], size2:[3, 6], g:160, drag:2, vr:8 }); }
    }

    /* -------------------------------------------------------------- LATERNE (sofort zeichnen) */
    // vfx.lantern(ctx, x, y, radius=110, seed) – additiver Glow, Alpha ±8 % per Noise. Gibt Flackerwert zurück.
    function lantern(ctx, x, y, radius, seedL) {
      if (!lanternSprite) rebuildSprites();
      const s = seedL || 0, t = now / 1000;
      const fl = 1 + 0.08 * (noise1(s * 13.7 + t * 7) * 2 - 1) + 0.03 * (noise1(s * 3.1 + t * 19) * 2 - 1);
      const r = (radius || 110) * (0.97 + 0.03 * fl);
      const ga = ctx.globalAlpha, gco = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = clamp(0.9 * fl, 0, 1);
      ctx.drawImage(lanternSprite, x - r, y - r, r * 2, r * 2);
      ctx.globalAlpha = ga; ctx.globalCompositeOperation = gco;
      return fl;
    }

    // vfx.glow(ctx, x, y, r, farbe, alpha) – additiver, vorgerenderter Glow (Ersatz für shadowBlur: Augen, Münzen, Glanzlichter)
    function glowAt(ctx, x, y, radius, c, alpha) {
      const spr = glow(ci(c)), r = radius || 8;
      const ga = ctx.globalAlpha, gco = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = ga * clamp(alpha ?? 1, 0, 1);
      ctx.drawImage(spr, x - r, y - r, r * 2, r * 2);
      ctx.globalAlpha = ga; ctx.globalCompositeOperation = gco;
    }

    /* -------------------------------------------------------------- ZEICHNEN */
    function applyShake(ctx) { if (shakeX || shakeY) ctx.translate(shakeX, shakeY); }

    // Wand-Ebene (Risse/Löcher): nach Hintergrund/Seitenwänden, vor drawEnts()
    function drawWall(ctx) {
      let any = false; for (const c of cracks) if (c.on) { any = true; break; } if (!any) return;
      ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const c of cracks) {
        if (!c.on) continue;
        const close = c.state === 2 ? 1 - c.closeT / c.closeMs : 1;
        const k = c.progress;
        // wenige Pixel Beben kurz vor dem Bruch (Teil der Ausholbewegung, kein Marker)
        const jig = c.state === 0 && c.t / c.ms > 0.75 ? Math.sin(now * 0.09) * 0.8 : 0;
        // Bruchloch
        if (c.state >= 1) {
          const hk = Math.min(1, c.holeT / 90) * close, hr = c.r * 0.55 * hk;
          if (hr > 0.5) {
            ctx.fillStyle = PALETTE.abyss; ctx.beginPath(); ctx.ellipse(c.x, c.y, hr, hr * 0.8, 0, 0, TAU); ctx.fill();
            ctx.strokeStyle = PALETTE.edge; ctx.globalAlpha = 0.7 * close; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.ellipse(c.x, c.y + 1, hr + 1.5, hr * 0.8 + 1.5, 0, Math.PI * 0.1, Math.PI * 0.9); ctx.stroke(); ctx.globalAlpha = 1;
          }
        }
        // Risslinien: Highlight-Kante 1 px versetzt, darüber dunkle Fuge
        for (let pass = 0; pass < 2; pass++) {
          ctx.strokeStyle = pass ? PALETTE.abyss : PALETTE.edge;
          ctx.globalAlpha = (pass ? 0.95 : 0.55) * close;
          ctx.beginPath();
          for (let b = 0; b < BR; b++) {
            const bk = clamp((k - c.delay[b] * (1 - k)) , 0, 1) * (b % 3 === 2 ? 0.7 : 1);
            if (bk <= 0) continue;
            const o = b * (SEG + 1) * 2, total = bk * SEG;
            const ox = pass ? 0 : 0.8, oy = pass ? 0 : 1;
            ctx.moveTo(c.pts[o] + ox + jig, c.pts[o + 1] + oy);
            for (let s = 1; s <= SEG; s++) {
              const f = clamp(total - (s - 1), 0, 1); if (f <= 0) break;
              const x0 = c.pts[o + (s - 1) * 2], y0 = c.pts[o + (s - 1) * 2 + 1], x1 = c.pts[o + s * 2], y1 = c.pts[o + s * 2 + 1];
              ctx.lineTo(x0 + (x1 - x0) * f + ox + jig, y0 + (y1 - y0) * f + oy);
            }
          }
          ctx.lineWidth = pass ? 2.2 : 1.2; ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    }

    // Welt-Ebene: Hiebe, Partikel, Flash. Nach drawNinja(), vor drawFog().
    let lastDraw = 0, emaFrame = 16.7;
    function draw(ctx) {
      // adaptive Qualität: misst echte Frameabstände
      if (O.adaptive && root.performance) {
        const tn = performance.now(); if (lastDraw) { const d = Math.min(100, tn - lastDraw); emaFrame += (d - emaFrame) * 0.05; } lastDraw = tn;
        budgetScale = emaFrame > 22 ? 0.6 : emaFrame < 18 ? 1 : budgetScale;
      }
      const ga = ctx.globalAlpha, gco = ctx.globalCompositeOperation;
      // 1) normale Partikel
      drawParticles(ctx, B_NORMAL);
      // 2) additiv: Hiebe, Funken, Glows, Flash
      ctx.globalCompositeOperation = 'lighter';
      for (const s of slashes) if (s.on) drawSlash(ctx, s);
      drawParticles(ctx, B_ADD);
      for (const f of flashes) if (f.on) {
        const fs = reduced ? O.reducedFlashScale : 1;
        ctx.globalAlpha = fs; const r = f.r * 1.6;
        ctx.drawImage(glow(ci('flash')), f.x - r, f.y - r, r * 2, r * 2);
        if (--f.frames <= 0) f.on = false;
      }
      ctx.globalCompositeOperation = gco;
      for (const r of ropes) if (r.on) drawRopeEnds(ctx, r);
      ctx.globalAlpha = ga;
    }
    function drawSlash(ctx, s) {
      const cx = s.track ? s.track.x : s.x, cy = (s.track ? s.track.y : s.y) + s.oy;
      const fm = O.slashFrameMs, frames = O.slashTrailFrames;
      const fadeOut = clamp(1 - (s.t - s.dur) / (frames * fm + 40), 0, 1);
      ctx.strokeStyle = colorList[s.col]; ctx.lineCap = 'round';
      for (let i = 0; i < frames; i++) {   // Geister-Frames: je 1 Frame älter, Alpha nimmt ab
        const tHead = s.t - i * fm, tTail = tHead - fm * 2;
        if (tHead <= 0) continue;
        const aH = bladeAngle(s, tHead), aT = bladeAngle(s, Math.max(0, tTail));
        if (Math.abs(aH - aT) < 0.01) continue;
        const alpha = (1 - i / frames) * 0.9 * fadeOut; if (alpha <= 0.01) continue;
        const lo = Math.min(aH, aT), hi = Math.max(aH, aT), R = s.r + i * 1.2;
        ctx.globalAlpha = alpha * 0.35; ctx.lineWidth = s.w * 2.6 * (1 - i * 0.15);   // weicher Außenschein
        ctx.beginPath(); ctx.arc(cx, cy, R, lo, hi); ctx.stroke();
        ctx.globalAlpha = alpha; ctx.lineWidth = s.w * (1 - i * 0.2);                   // heller Kern
        ctx.beginPath(); ctx.arc(cx, cy, R, lo, hi); ctx.stroke();
      }
      // Glow an der Klingenspitze, solange der Hieb aktiv ist
      if (s.t <= s.dur) {
        const a = bladeAngle(s, s.t), tx = cx + Math.cos(a) * s.r, ty = cy + Math.sin(a) * s.r, gr = 14;
        ctx.globalAlpha = 0.8 * fadeOut; ctx.drawImage(glow(s.col), tx - gr, ty - gr, gr * 2, gr * 2);
      }
    }
    function drawParticles(ctx, blend) {
      if (alive <= 0) return;
      let lastFill = -1, lastStroke = -1;
      for (let i = 0; i < MAX; i++) {
        if (plife[i] <= 0 || pblend[i] !== blend) continue;
        const life = plife[i] / pmax[i], k = pkind[i], x = px[i], y = py[i], c = pcol[i];
        let a = pa[i] * (k === K_DUST ? life : Math.min(1, life * 2.2));
        ctx.globalAlpha = a;
        switch (k) {
          case K_DOT: { const r = psz[i]; ctx.drawImage(disc(c), x - r, y - r, r * 2, r * 2); break; }
          case K_DUST: { const r = psz[i] * (1.5 - life * 0.5); ctx.drawImage(disc(c), x - r, y - r, r * 2, r * 2); break; }
          case K_GLOW: { const r = psz[i] * 3; ctx.drawImage(glow(c), x - r, y - r, r * 2, r * 2); break; }
          case K_SPARK: case K_FIBER: {
            if (c !== lastStroke) { ctx.strokeStyle = colorList[c]; lastStroke = c; }
            let dx, dy;
            if (k === K_SPARK) { const v = Math.hypot(pvx[i], pvy[i]) || 1, l = psz2[i] * Math.min(1, v / 200); dx = pvx[i] / v * l; dy = pvy[i] / v * l; }
            else { dx = Math.cos(prot[i]) * psz2[i]; dy = Math.sin(prot[i]) * psz2[i]; }
            ctx.lineWidth = psz[i]; ctx.beginPath(); ctx.moveTo(x - dx * 0.5, y - dy * 0.5); ctx.lineTo(x + dx * 0.5, y + dy * 0.5); ctx.stroke();
            break;
          }
          case K_SPLINTER: case K_CHUNK: {
            if (c !== lastFill) { ctx.fillStyle = colorList[c]; lastFill = c; }
            const cs = Math.cos(prot[i]), sn = Math.sin(prot[i]);
            if (k === K_SPLINTER) {   // gedrehtes Brett-Stück mit spitzem Ende
              const hw = psz[i] * 0.5, hh = psz2[i] * 0.5;
              ctx.beginPath();
              ctx.moveTo(x + (-hw) * cs - (-hh) * sn, y + (-hw) * sn + (-hh) * cs);
              ctx.lineTo(x + hw * cs - (-hh * 0.8) * sn, y + hw * sn + (-hh * 0.8) * cs);
              ctx.lineTo(x + hw * cs - hh * sn, y + hw * sn + hh * cs);
              ctx.lineTo(x + (-hw * 0.2) * cs - (hh * 1.15) * sn, y + (-hw * 0.2) * sn + (hh * 1.15) * cs);
              ctx.lineTo(x + (-hw) * cs - hh * sn, y + (-hw) * sn + hh * cs);
              ctx.closePath(); ctx.fill();
            } else {                  // unregelmäßiges Steinbröckchen (5-Eck)
              const r = psz[i];
              ctx.beginPath();
              ctx.moveTo(x + cs * r, y + sn * r);
              ctx.lineTo(x + (cs * 0.3 - sn * 0.95) * r, y + (sn * 0.3 + cs * 0.95) * r);
              ctx.lineTo(x + (-cs * 0.9 - sn * 0.5) * r, y + (-sn * 0.9 + cs * 0.5) * r);
              ctx.lineTo(x + (-cs * 0.6 + sn * 0.8) * r, y + (-sn * 0.6 - cs * 0.8) * r);
              ctx.lineTo(x + (cs * 0.5 + sn * 0.7) * r, y + (sn * 0.5 - cs * 0.7) * r);
              ctx.closePath(); ctx.fill();
            }
            break;
          }
          case K_RING: {   // Eisenring-Hälfte + Bandglanz
            const r = psz[i], a0 = prot[i];
            ctx.lineWidth = 4; ctx.strokeStyle = PALETTE.iron; ctx.beginPath(); ctx.arc(x, y, r, a0, a0 + Math.PI); ctx.stroke();
            ctx.lineWidth = 1.2; ctx.strokeStyle = PALETTE.ironGlint; ctx.beginPath(); ctx.arc(x, y, r - 1, a0 + 0.3, a0 + 1.4); ctx.stroke();
            lastStroke = -1; break;
          }
        }
      }
    }
    function drawRopeEnds(ctx, r) {
      const k = r.t / 520, a = 1 - k;
      ctx.save(); ctx.lineCap = 'round'; ctx.globalAlpha = a;
      // oberes Ende peitscht nach oben und schwingt gedämpft
      const up = 34 * Math.min(1, r.t / 120), wob = Math.sin(r.t * 0.04) * 10 * a;
      const lo = 28 * Math.min(1, r.t / 200) + r.t * 0.04;
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass ? PALETTE.rope : PALETTE.ropeShade; ctx.lineWidth = pass ? 2 : 4;
        ctx.beginPath(); ctx.moveTo(r.x, r.y - up); ctx.quadraticCurveTo(r.x + wob, r.y - up * 0.5, r.x + wob * 0.6, r.y - 4); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(r.x, r.y + lo); ctx.quadraticCurveTo(r.x - wob * 0.7, r.y + lo * 0.5 + 4, r.x - wob * 0.4, r.y + 6); ctx.stroke();
      }
      // ausgefranste Enden
      ctx.strokeStyle = PALETTE.rope; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const fa = -Math.PI / 2 + (i - 2) * 0.45 + wob * 0.02, fl = 6 + (i % 2) * 3;
        ctx.moveTo(r.x + wob * 0.6, r.y - 4); ctx.lineTo(r.x + wob * 0.6 + Math.cos(fa + Math.PI) * fl * 0.6, r.y - 4 - Math.sin(fa + Math.PI) * fl);
        ctx.moveTo(r.x - wob * 0.4, r.y + 6); ctx.lineTo(r.x - wob * 0.4 + Math.cos(fa) * fl * 0.6, r.y + 6 - Math.sin(fa) * fl);
      }
      ctx.stroke(); ctx.restore();
    }
    // Bildschirm-Ebene (nicht gewackelt): Vignetten-Puls + Vollbild-Flash. Nach ctx.restore() in render().
    function drawScreen(ctx, w, h) {
      if (vignette > 0) {
        if (!vignetteSprite) vignetteSprite = buildVignette();
        const ga = ctx.globalAlpha; ctx.globalAlpha = 0.5 * vignette; ctx.drawImage(vignetteSprite, 0, 0, w, h); ctx.globalAlpha = ga;
      }
      if (screenFlash > 0) {
        const ga = ctx.globalAlpha; ctx.globalAlpha = screenFlash * 0.5 * (reduced ? O.reducedFlashScale : 1);
        ctx.fillStyle = PALETTE.flash; ctx.fillRect(0, 0, w, h); ctx.globalAlpha = ga;
      }
    }

    function clear() {
      plife.fill(0); alive = 0; trauma = 0; hitStopLeft = 0; vignette = 0; screenFlash = 0; shakeX = shakeY = 0;
      for (const s of slashes) { s.on = false; s.track = null; } for (const f of flashes) f.on = false;
      for (const c of cracks) c.on = false; for (const r of ropes) r.on = false;
    }

    setPixelRatio(O.pixelRatio); lanternSprite || rebuildSprites(); prewarm();

    return {
      // Kern
      update, draw, drawWall, drawScreen, applyShake, setPixelRatio, clear,
      // Effekte
      slash, hit, flash, hitStop, shake, addTrauma, barrelHit, barrelBreak,
      wallBreak, wallBreakNow, wallClose, ropeSnap, ropeFray, lantern, emit, glow: glowAt,
      vignette(v) { vignette = Math.max(vignette, v ?? 1); },
      screenFlash(v) { screenFlash = Math.max(screenFlash, v ?? 0.4); },
      setReducedMotion(v) { reduced = !!v; },
      // Abfragen
      get frozen() { return hitStopLeft > 0; },
      get timeScale() { return hitStopLeft > 0 ? O.hitStopScale : 1; },
      get shakeX() { return shakeX; }, get shakeY() { return shakeY; }, get shakePx() { return shakePxCur; },
      get particleCount() { return alive; }, get particleBudget() { return Math.floor(MAX * budgetScale); },
      get reducedMotion() { return reduced; },
      options: O
    };
  }

  root.BNVFX = { create, PALETTE, ENEMY_COLS, version:'0.2.0' };
})(typeof window !== 'undefined' ? window : globalThis);
