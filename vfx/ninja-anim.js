/* Barrel Ninja – Ninja-Animation (ninja-anim.js) · Phase 2
   Abhängigkeitsfrei, plain script. Stellt global `BNNinjaAnim` bereit:
     const scarf = BNNinjaAnim.createScarf();        // Verlet-Feder-Kette, ersetzt drawScarf() in index.html
     const speed = BNNinjaAnim.createSpeedlines();   // dezente additive Speedlines (nur ohne Fass)
   Einheiten: Welt-Einheiten von index.html (WORLD_H = 800), Zeiten in ms.
   Regeln: nur Palettenfarben (concepts/art-direction.md), kein shadowBlur, keine Gradienten, feste
   Float32Array-Puffer – keine Allokationen pro Frame. Vektorpfade → automatisch DPR-scharf. */
(function (root) {
  'use strict';
  const PAL = (root.BNVFX && root.BNVFX.PALETTE) || { scarf:'#E2283C', moon:'#9FD8FF', abyss:'#05070F' };
  const TAU = Math.PI * 2;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function hash1(n) { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
  function noise1(t) { const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f); return hash1(i) * (1 - u) + hash1(i + 1) * u; }
  function reducedMQ() { try { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } }

  /* ================================================================== SCHAL (Verlet) */
  const SCARF_DEFAULTS = {
    segments: 9,          // Kettenglieder (10 Punkte)
    length: 30,           // Gesamtlänge in Welt-px (Fass-Form ~26, pure Form ~34 → per draw-Option)
    width: 7, tipWidth: 1.4,
    gravity: 320,         // px/s²
    drag: 2.6,            // Luftwiderstand 1/s
    windK: 0.55,          // Fahrtwind: Gegenkraft zur Anker-Geschwindigkeit (px/s → px/s²)
    fallK: 1.3,           // Fallwind (G.scrollPx) bläst nach oben
    trail: 240,           // Grundströmung entgegen der letzten Bewegungsrichtung (px/s²) – Schal weht wie im Konzept
    flutter: 520,         // Flatter-Amplitude (px/s²), quer zur Kette, Noise
    flutterHz: 7,
    stepMs: 1000 / 120, maxSubsteps: 8,
    iterations: 4,
    bend: 0.35,           // Biegesteifigkeit (Abstand i↔i+2)
    snapDist: 60,         // Anker springt weiter (Formwechsel) → Kette neu auslegen
    color: 'scarf'
  };
  function createScarf(opts) {
    const O = Object.assign({}, SCARF_DEFAULTS, opts || {});
    const S = O.segments | 0, N = S + 1;
    const X = new Float32Array(N), Y = new Float32Array(N), PX = new Float32Array(N), PY = new Float32Array(N);
    const LX = new Float32Array(N), LY = new Float32Array(N), EL = new Float32Array(N * 2), ER = new Float32Array(N * 2);
    let inited = false, acc = 0, lastTime = -1, simT = 0;
    let ax = 0, ay = 0, pax = 0, pay = 0, avx = 0, avy = 0, trailDir = -1;
    let segLen = O.length / S, boost = 1, fall = 0, kickX = 0, kickY = 0;

    function lay(x, y) {
      for (let i = 0; i < N; i++) { X[i] = PX[i] = x + trailDir * i * segLen * 0.75; Y[i] = PY[i] = y + i * segLen * 0.6; }
      ax = pax = x; ay = pay = y; avx = avy = 0; inited = true;
    }
    // Impuls (px/s), z. B. bei Hieben: impulse(dir*260, -120). Wirkt zum Ende hin stärker.
    function impulse(vx, vy) { kickX += vx; kickY += vy; }
    function substep(h, k0, k1) {
      // Anker innerhalb des Frames interpolieren (glatte Kette auch bei großen Sprüngen)
      const kx = pax + (ax - pax) * k1, ky = pay + (ay - pay) * k1;
      const damp = Math.max(0, 1 - O.drag * h), h2 = h * h;
      const spd = Math.hypot(avx, avy);
      const fl = O.flutter * boost * (0.35 + Math.min(1.4, spd / 500) + Math.min(0.6, fall / 200));
      const tx = O.trail * trailDir * boost;
      for (let i = 1; i < N; i++) {
        const k = i / S;
        const vx = (X[i] - PX[i]) * damp + kickX * h * k, vy = (Y[i] - PY[i]) * damp + kickY * h * k;
        // Querachse der Kette am Punkt i für das Flattern
        const dx = X[i] - X[i - 1], dy = Y[i] - Y[i - 1], dl = Math.hypot(dx, dy) || 1;
        const n = (noise1(simT * O.flutterHz + i * 0.73) * 2 - 1) * fl * k;
        const fx = -avx * O.windK * k + tx * k + (-dy / dl) * n;
        const fy = O.gravity - avy * O.windK * k - fall * O.fallK * k + (dx / dl) * n;
        PX[i] = X[i]; PY[i] = Y[i];
        X[i] += vx + fx * h2; Y[i] += vy + fy * h2;
      }
      kickX = kickY = 0;   // Impuls nur im ersten Substep
      X[0] = PX[0] = kx; Y[0] = PY[0] = ky;
      for (let it = 0; it < O.iterations; it++) {
        for (let i = 0; i < S; i++) {
          const dx = X[i + 1] - X[i], dy = Y[i + 1] - Y[i], d = Math.hypot(dx, dy) || 1e-4, diff = (d - segLen) / d;
          if (i === 0) { X[1] -= dx * diff; Y[1] -= dy * diff; }
          else { X[i] += dx * diff * 0.5; Y[i] += dy * diff * 0.5; X[i + 1] -= dx * diff * 0.5; Y[i + 1] -= dy * diff * 0.5; }
        }
        if (O.bend > 0) for (let i = 0; i < S - 1; i++) {   // nur Auseinanderdrücken → kein Zusammenfalten
          const dx = X[i + 2] - X[i], dy = Y[i + 2] - Y[i], d = Math.hypot(dx, dy) || 1e-4, min = segLen * 1.75;
          if (d >= min) continue;
          const diff = (d - min) / d * O.bend * 0.5;
          if (i > 0) { X[i] += dx * diff; Y[i] += dy * diff; }
          X[i + 2] -= dx * diff; Y[i + 2] -= dy * diff;
        }
        X[0] = kx; Y[0] = ky;
      }
      void k0;
    }
    // Simulation bis timeMs (Spielzeit, steht bei Pause/Hit-Stop). Anker in Weltkoordinaten.
    function step(timeMs, wx, wy, o) {
      if (o) { if (o.boost != null) boost = o.boost; if (o.fall != null) fall = o.fall; if (o.length) segLen += (o.length / S - segLen) * 0.2; }
      if (!inited || Math.hypot(wx - ax, wy - ay) > O.snapDist || lastTime < 0 || timeMs < lastTime) { lay(wx, wy); lastTime = timeMs; return; }
      let dt = clamp(timeMs - lastTime, 0, 100); lastTime = timeMs;
      pax = ax; pay = ay; ax = wx; ay = wy;
      if (dt <= 0) return;
      const nvx = (ax - pax) / (dt / 1000), nvy = (ay - pay) / (dt / 1000);
      avx += (nvx - avx) * 0.5; avy += (nvy - avy) * 0.5;
      if (Math.abs(avx) > 40) trailDir = avx > 0 ? -1 : 1;
      acc += dt; let n = 0; const total = Math.min(O.maxSubsteps, Math.floor(acc / O.stepMs));
      while (acc >= O.stepMs && n < O.maxSubsteps) { acc -= O.stepMs; n++; simT += O.stepMs / 1000; substep(O.stepMs / 1000, (n - 1) / total, n / total); }
      if (n >= O.maxSubsteps) acc = 0;
    }
    // Zeichnen im lokalen Koordinatensystem des Ninjas (dort, wo index.html drawScarf aufruft):
    // c ist bereits translate(x,y)+rotate(rot); (lx,ly) = lokaler Ankerpunkt (z. B. 4,-32).
    // o: { time (G.time), color, width, length, boost, fall }
    function drawLocal(c, lx, ly, x, y, rot, o) {
      o = o || {};
      const cs = Math.cos(rot), sn = Math.sin(rot);
      const wx = x + lx * cs - ly * sn, wy = y + lx * sn + ly * cs;
      step(o.time ?? 0, wx, wy, o);
      for (let i = 0; i < N; i++) { const dx = X[i] - x, dy = Y[i] - y; LX[i] = dx * cs + dy * sn; LY[i] = -dx * sn + dy * cs; }
      LX[0] = lx; LY[0] = ly;
      ribbon(c, o.color || PAL[O.color] || O.color, o.width || O.width);
    }
    // Zeichnen in Weltkoordinaten (Demo / eigener Aufrufer)
    function drawWorld(c, wx, wy, o) {
      o = o || {};
      step(o.time ?? 0, wx, wy, o);
      for (let i = 0; i < N; i++) { LX[i] = X[i]; LY[i] = Y[i]; }
      ribbon(c, o.color || PAL[O.color] || O.color, o.width || O.width);
    }
    function ribbon(c, color, w0) {
      for (let i = 0; i < N; i++) {
        const a = i > 0 ? i - 1 : 0, b = i < S ? i + 1 : S;
        let tx = LX[b] - LX[a], ty = LY[b] - LY[a]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
        const k = i / S, w = (w0 + (O.tipWidth - w0) * Math.pow(k, 0.8)) * 0.5;
        EL[i * 2] = LX[i] - ty * w; EL[i * 2 + 1] = LY[i] + tx * w;
        ER[i * 2] = LX[i] + ty * w; ER[i * 2 + 1] = LY[i] - tx * w;
      }
      c.fillStyle = color;
      c.beginPath(); c.moveTo(EL[0], EL[1]);
      for (let i = 1; i < N; i++) c.lineTo(EL[i * 2], EL[i * 2 + 1]);
      // Spitze leicht verlängert
      const ex = LX[S] + (LX[S] - LX[S - 1]) * 0.6, ey = LY[S] + (LY[S] - LY[S - 1]) * 0.6;
      c.lineTo(ex, ey);
      for (let i = S; i >= 0; i--) c.lineTo(ER[i * 2], ER[i * 2 + 1]);
      c.closePath(); c.fill();
      // Volumen: Unterseite (Mittellinie → rechte Kante) mit Abgrund-Alpha abdunkeln
      c.fillStyle = 'rgba(5,7,15,.28)';
      c.beginPath(); c.moveTo(LX[0], LY[0]);
      for (let i = 1; i < N; i++) c.lineTo(LX[i], LY[i]);
      c.lineTo(ex, ey);
      for (let i = S; i >= 0; i--) c.lineTo(ER[i * 2], ER[i * 2 + 1]);
      c.closePath(); c.fill();
      // Knoten am Anker
      c.fillStyle = color; c.beginPath(); c.arc(LX[0], LY[0], w0 * 0.45, 0, TAU); c.fill();
    }
    function reset() { inited = false; lastTime = -1; acc = 0; kickX = kickY = 0; }
    return { step, drawLocal, drawWorld, impulse, reset, options: O,
      get points() { return N; }, tipX() { return X[S]; }, tipY() { return Y[S]; } };
  }

  /* ================================================================== SPEEDLINES */
  const SL_DEFAULTS = {
    max: 28,               // Pool-Größe
    minSpeed: 90,          // px/s ab der Linien entstehen (Fallen allein: G.scrollPx ≈ 64–176)
    maxSpeed: 1100,        // px/s volle Intensität (seitlicher Tween ≈ 1000–1300 px/s Spitze)
    rate: 70,              // Linien/s bei voller Intensität
    alpha: 0.3,            // dezent
    width: 1.2,
    color: 'moon',         // #9FD8FF Mondlicht
    radius: 34,            // Streuung um den Ninja
    fadeMs: 160,
    reducedScale: 0.4      // prefers-reduced-motion: weniger Linien
  };
  function createSpeedlines(opts) {
    const O = Object.assign({}, SL_DEFAULTS, opts || {});
    const M = O.max | 0;
    const lx = new Float32Array(M), ly = new Float32Array(M), ldx = new Float32Array(M), ldy = new Float32Array(M);
    const llen = new Float32Array(M), llife = new Float32Array(M), lmax = new Float32Array(M), lv = new Float32Array(M), lint = new Float32Array(M);
    let inten = 0, spawnAcc = 0, alive = 0;
    const reduced = O.reducedMotion === 'auto' || O.reducedMotion == null ? reducedMQ() : !!O.reducedMotion;
    // x,y = Ninja (Welt); vx,vy = Geschwindigkeit relativ zur Wand (vy inkl. Fall: N.vy + G.scrollPx); active = !N.barrel
    function update(dtMs, x, y, vx, vy, active) {
      const sp = Math.hypot(vx, vy);
      const target = active ? clamp((sp - O.minSpeed) / (O.maxSpeed - O.minSpeed), 0, 1) : 0;
      const k = Math.min(1, dtMs / O.fadeMs); inten += (Math.max(target, active ? 0.08 * (sp > O.minSpeed ? 1 : 0) : 0) - inten) * k;
      const dt = dtMs / 1000;
      let n = 0;
      for (let i = 0; i < M; i++) {
        if (llife[i] <= 0) continue;
        llife[i] -= dtMs; if (llife[i] <= 0) continue; n++;
        lx[i] -= ldx[i] * lv[i] * dt; ly[i] -= ldy[i] * lv[i] * dt;   // strömen entgegen der Bewegung am Ninja vorbei
      }
      alive = n;
      if (inten < 0.02 || sp < 1) return;
      spawnAcc += dt * O.rate * inten * (reduced ? O.reducedScale : 1);
      const dx = vx / sp, dy = vy / sp;
      while (spawnAcc >= 1) {
        spawnAcc -= 1;
        let s = -1; for (let i = 0; i < M; i++) if (llife[i] <= 0) { s = i; break; }
        if (s < 0) { spawnAcc = 0; break; }
        const side = (Math.random() * 2 - 1) * O.radius, ahead = (Math.random() * 1.4 - 0.2) * O.radius;
        lx[s] = x - dy * side + dx * ahead; ly[s] = y + dx * side + dy * ahead;
        ldx[s] = dx; ldy[s] = dy; lv[s] = 260 + sp * 0.7;
        llen[s] = 10 + 30 * inten * (0.6 + Math.random() * 0.4);
        llife[s] = lmax[s] = 140 + Math.random() * 120; lint[s] = inten;
        alive++;
      }
    }
    // additiv, 3 Alpha-Stufen → max. 3 stroke()-Aufrufe pro Frame
    function draw(c) {
      if (alive <= 0) return;
      const ga = c.globalAlpha, gco = c.globalCompositeOperation;
      c.globalCompositeOperation = 'lighter'; c.strokeStyle = PAL[O.color] || O.color; c.lineWidth = O.width; c.lineCap = 'round';
      for (let b = 0; b < 3; b++) {
        c.beginPath(); let any = false;
        for (let i = 0; i < M; i++) {
          if (llife[i] <= 0) continue;
          const life = llife[i] / lmax[i], a = Math.min(1, life * 2.5) * Math.min(1, (1 - life) * 6) * lint[i];
          if (Math.min(2, (a * 3) | 0) !== b) continue;
          const L = llen[i] * (0.5 + 0.5 * life);
          c.moveTo(lx[i], ly[i]); c.lineTo(lx[i] - ldx[i] * L, ly[i] - ldy[i] * L); any = true;
        }
        if (any) { c.globalAlpha = ga * O.alpha * (b + 1) / 3; c.stroke(); }
      }
      c.globalAlpha = ga; c.globalCompositeOperation = gco;
    }
    function clear() { llife.fill(0); alive = 0; inten = 0; spawnAcc = 0; }
    return { update, draw, clear, options: O, get intensity() { return inten; }, get count() { return alive; } };
  }

  root.BNNinjaAnim = { createScarf, createSpeedlines, version: '0.1.0' };
})(typeof window !== 'undefined' ? window : globalThis);
