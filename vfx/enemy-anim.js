/* Barrel Ninja – Gegner-Animationen (enemy-anim.js) · Phase 2
   Abhängigkeitsfrei, plain script. Stellt global `BNEnemyAnim` bereit:
     const ea = BNEnemyAnim.create({ vfx, balance: BALANCE });
   Prozedural gezeichnete Sprites (Vektorpfade → DPR-scharf) für Krabbler, Klingen-Fledermaus,
   Seilschneider-Kobold, Beißpflanze, Spuckpflanze. Je Gegner: idle · windup · attack · (recover/retract) ·
   hit · death.
   Regel: die Ausholbewegung (windup) ist der EINZIGE Telegraph – reine Körperbewegung. Keine Warnmarker,
   keine Glows/Blitze als Ankündigung, keine Ausrufezeichen. Augen leuchten konstant (Gestaltung, kein Signal).
   Performance: keine Allokationen pro Frame (feste Pose-/Leichen-Pools, Float32Array-Scratch),
   Gradienten einmal pro Canvas-Kontext in lokalen Koordinaten gecacht, kein shadowBlur, nur Palette. */
(function (root) {
  'use strict';
  const PAL = (root.BNVFX && root.BNVFX.PALETTE) || {
    abyss:'#05070F', joint:'#0E1724', edge:'#3A5670', moss:'#2F5B4A', text:'#F4F1EA', flash:'#FFFFFF', accentRed:'#E2283C',
    krabbler:'#3B3F4A', krabblerSpike:'#8C8F99', krabblerEye:'#FF5A2A', bat:'#241B3A', batBlade:'#B9C3D6', batEye:'#FFC23A',
    cutter:'#4E7A3A', cutterClaw:'#C7CED6', spike:'#6E7682', steel:'#D8E4EE'
  };
  const C = {
    abyss: PAL.abyss, joint: PAL.joint, edge: PAL.edge, moss: PAL.moss, text: PAL.text, flash: PAL.flash, red: PAL.accentRed || '#E2283C',
    krab: PAL.krabbler, krabSpike: PAL.krabblerSpike, krabEye: PAL.krabblerEye, krabHi: PAL.spike,
    bat: PAL.bat, batBlade: PAL.batBlade, batEye: PAL.batEye, batHi: PAL.steel, batLo: PAL.spike,
    gob: PAL.cutter, gobDark: PAL.moss, claw: PAL.cutterClaw, gobEye: PAL.batEye
  };
  const TAU = Math.PI, PI = Math.PI, HALF = Math.PI / 2;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(p) { p = clamp(p, 0, 1); return p * p * (3 - 2 * p); }
  function easeOutCubic(p) { p = clamp(p, 0, 1); return 1 - Math.pow(1 - p, 3); }
  function easeOutBack(p) { p = clamp(p, 0, 1); const c1 = 1.25, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); }
  function hash1(n) { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
  function rrect(c, x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  void TAU;

  // Zeiten aus design/balancing-spec.json (v0.2) – werden von opts.balance überschrieben
  const SPEC = { windupMs: 900, jabMs: 250, recoverMs: 500, biteMs: 200, aimMs: 500, stayMs: 900, retractMs: 300, crackMs: 900 };
  const HIT_MS = 90;     // Treffer-Reaktion (läuft beim Kill vor dem Tod; deckt den 50-ms-Hit-Stop ab)
  const DEATH_MS = { krabbler: 720, fledermaus: 760, seilschneider: 820, beisspflanze: 700, spuckpflanze: 700 };
  const TYPES = ['krabbler', 'fledermaus', 'seilschneider', 'beisspflanze', 'spuckpflanze'];

  function makePose() {
    return { type:'', side:-1, tA:0, anim:'idle',
      ox:0, oy:0, sx:1, sy:1, alpha:1,
      // Krabbler
      ang:-HALF, gap:8.5, spike:7, mand:0.25, legA:1.4, legT:0, legOut:0, curl:0, spin:0,
      // Fledermaus
      rot:PI, spread:0.25, flap:0, cock:0, dir:1, earA:0,
      // Kobold
      lean:0, hx:-11, hy:6, scA:PI, sn:0.12, legC:0, grip:0, ear:0,
      // Pflanzen
      s:1, open:0.35, leaf:0, bulb:13, tube:4, aim:0, peek:0 };
  }
  function copyPose(d, s) { for (const k in s) d[k] = s[k]; return d; }

  function create(userOpts) {
    const O = Object.assign({ vfx: null, balance: null, eyeGlow: true, cutterWindupMs: null }, userOpts || {});
    const T = Object.assign({}, SPEC);
    function applyBalance(B) {
      if (!B || !B.enemies) return;
      const E = B.enemies;
      try {
        T.windupMs = B.behaviour.windupMs.start;
        T.jabMs = E.krabbler.attacks.jab.durationMs; T.recoverMs = E.krabbler.attacks.jab.recoverMs;
        T.biteMs = E.beisspflanze.biteMs; T.aimMs = E.spuckpflanze.aimMs; T.stayMs = E.beisspflanze.stayMs; T.retractMs = E.beisspflanze.retractMs;
      } catch (e) { /* Spec-Abweichung: Defaults behalten */ }
    }
    applyBalance(O.balance);

    /* -------------------------------------------------------------- Gradient-Cache je Kontext */
    const caches = new WeakMap();
    let GC = null;
    function useCtx(c) { let m = caches.get(c); if (!m) { m = Object.create(null); caches.set(c, m); } GC = m; }
    let TINT = null;                       // Treffer-Überblendung: alle Füllungen in Flash-Weiß
    function F(x) { return TINT || x; }
    const glowOn = () => O.eyeGlow && O.vfx && O.vfx.glow && !TINT;

    const P = makePose();                  // Scratch-Pose für Live-Gegner
    const SX = new Float32Array(6), SY = new Float32Array(6), SA = new Float32Array(6);
    const KK = ['k0', 'k1', 'k2', 'k3', 'k4'], BK = []; for (let i = 0; i <= 20; i++) BK.push('b' + i);   // Cache-Schlüssel ohne String-Bau pro Frame

    /* ============================================================== KRABBLER */
    function krabPose(st, p) {
      const side = st.side || -1, facing = -side, faceAng = facing > 0 ? 0 : -PI, t = st.t || 0, tA = st.tA || 0;
      p.ang = -HALF; p.gap = 8.5; p.spike = 7; p.mand = 0.2 + 0.1 * Math.max(0, Math.sin(tA * 0.0031));
      p.legA = 1.4; p.legT = tA * 0.008; p.legOut = 0; p.curl = 0; p.spin = 0; p.eye = 0;
      p.ox = 0; p.oy = 0; p.sx = 1; p.sy = 1 + 0.035 * Math.sin(tA * 0.004);
      switch (st.anim) {
        case 'windup': {
          // 1) Kopf dreht zur Mitte · 2) Körper staucht sich zusammen, zieht zur Wand zurück, Stacheln stellen sich auf,
          // Mandibeln reißen auf, Beine stemmen sich ein · 3) letzte ~18 %: Zittern unter Spannung
          const q = clamp(t / (st.dur || T.windupMs), 0, 1), a1 = smooth(q / 0.25), coil = smooth((q - 0.15) / 0.55);   // (v0.3) früher + deutlicher
          p.eye = coil;
          p.ang = lerp(-HALF, faceAng, a1);
          p.gap = 8.5 - 3.3 * coil; p.spike = 7 + 5.5 * coil; p.mand = 0.25 + 0.9 * coil;
          p.legA = 1.4 + 1.8 * coil; p.legOut = coil; p.legT = tA * (0.008 + 0.02 * coil);
          p.ox = side * 14 * coil; p.sx = 1 - 0.16 * coil; p.sy = 1 + 0.16 * coil;
          if (q > 0.75) { const k = smooth((q - 0.75) / 0.12); p.ox += Math.sin(t * 0.11) * 2.4 * k; p.oy += Math.cos(t * 0.13) * 1.1 * k; }
          break;
        }
        case 'attack':
          p.ang = faceAng;
          if (st.attack === 'leap') { const k = smooth(t / 140); p.curl = k; p.spin = t * 0.016 * facing; p.spike = 11; p.mand = 0.1; p.gap = 8.5 - 2 * k; p.legA = 0.4; }
          else { const k = easeOutCubic(t / 80); p.gap = lerp(5.2, 11, k) - 1.6 * smooth((t - 150) / 150); p.spike = 12.5 - 3.5 * k;
            p.mand = t < 55 ? 1.15 : Math.max(0.05, 1.15 - (t - 55) / 35); p.sx = 1.06; p.sy = 0.92; p.legT = tA * 0.03; p.legA = 2.4; }
          break;
        case 'recover': {
          const q = clamp(t / (st.dur || T.recoverMs), 0, 1);
          p.ang = lerp(faceAng, -HALF, smooth((q - 0.2) / 0.8)); p.gap = lerp(9.6, 8.5, q); p.spike = lerp(9.5, 7, q); p.mand = 0.2; p.legT = tA * 0.02;
          break;
        }
      }
    }
    function krabSeg(c, i, sr, p, legs) {
      let sg = GC[KK[i]];
      if (!sg) { sg = GC[KK[i]] = c.createRadialGradient(-2, -3, 1, 0, 0, sr * 1.2); sg.addColorStop(0, C.krabHi); sg.addColorStop(0.55, C.krab); sg.addColorStop(1, C.joint); }
      c.fillStyle = F(sg); c.beginPath(); c.ellipse(0, 0, 6.5, sr, 0, 0, Math.PI * 2); c.fill();
      // Stachelreihe (stellt sich beim Ausholen auf)
      c.fillStyle = F(C.krabSpike); c.beginPath();
      c.moveTo(-3, sr - 2); c.lineTo(0, sr + p.spike); c.lineTo(3, sr - 2);
      c.moveTo(-3, -sr + 2); c.lineTo(0, -sr - p.spike); c.lineTo(3, -sr + 2); c.fill();
      if (legs) {
        const lw = Math.sin(p.legT + i * 1.1) * p.legA, lo = p.legOut * 2.5;
        c.strokeStyle = F(C.joint); c.lineWidth = 1.6; c.beginPath();
        c.moveTo(0, sr - 3); c.lineTo(lw - lo, sr + 3 + lo); c.moveTo(0, -sr + 3); c.lineTo(-lw - lo, -sr - 3 - lo); c.stroke();
      }
    }
    function krabHead(c, p) {
      c.fillStyle = F(C.krab); c.beginPath(); c.ellipse(8, 0, 8, 9, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = F(C.krabEye); c.beginPath(); c.arc(12, -4, 2.2, 0, Math.PI * 2); c.arc(12, 4, 2.2, 0, Math.PI * 2); c.fill();
      { const ek = p.eye || 0, er = 6.5 + 5 * ek, ea = 0.4 + 0.55 * ek;   // Augen glühen mit der Spannung auf (Teil des Körpers)
        if (glowOn()) { O.vfx.glow(c, 12, -4, er, 'krabblerEye', ea); O.vfx.glow(c, 12, 4, er, 'krabblerEye', ea); }
        else if (ek > 0.05) { c.globalAlpha = 0.5 * ek; c.fillStyle = F(C.krabEye); c.beginPath(); c.arc(12, -4, 3.4, 0, Math.PI * 2); c.arc(12, 4, 3.4, 0, Math.PI * 2); c.fill(); c.globalAlpha = 1; } }
      // Mandibeln: öffnen beim Ausholen weit, schnappen beim Stoß zu
      const m = p.mand, ex = Math.cos(m) * 7, ey = Math.sin(m) * 7;
      c.strokeStyle = F(C.krabSpike); c.lineWidth = 1.7; c.lineCap = 'round'; c.beginPath();
      c.moveTo(15, -3); c.quadraticCurveTo(15 + ex * 0.7, -3 - ey * 1.1, 15 + ex, -3 - ey + 2.5);
      c.moveTo(15, 3); c.quadraticCurveTo(15 + ex * 0.7, 3 + ey * 1.1, 15 + ex, 3 + ey - 2.5); c.stroke();
    }
    function krabBody(c, p) {   // Segmentkette: Kopf bei +x, Körper nach −x; curl rollt ein (Sprung)
      let a = PI, cx = 0, cy = 0; SX[0] = 0; SY[0] = 0; SA[0] = 0;
      for (let i = 1; i < 5; i++) { a += p.curl * 1.05; cx += Math.cos(a) * p.gap; cy += Math.sin(a) * p.gap; SX[i] = cx; SY[i] = cy; SA[i] = a - PI; }
      if (p.curl > 0) { const mx = (SX[2]) * p.curl, my = SY[2] * p.curl; for (let i = 0; i < 5; i++) { SX[i] -= mx; SY[i] -= my; } }
      for (let i = 4; i >= 0; i--) {
        const sr = 11 - Math.abs(i - 1.5) * 1.3;
        c.save(); c.translate(SX[i], SY[i]); c.rotate(SA[i]); krabSeg(c, i, sr, p, true); c.restore();
      }
      c.save(); c.translate(SX[0], SY[0]); krabHead(c, p); c.restore();
    }
    function krabDraw(c, x, y, p) {
      c.save(); c.translate(x + p.ox, y + p.oy); c.rotate(p.ang + p.spin); c.scale(p.sx, p.sy); krabBody(c, p); c.restore();
    }
    function krabDeath(c, x, y, p, t, seed, side) {
      // Panzer platzt in Segmente: jedes fliegt ballistisch (analytisch aus Seed, kein Zustand pro Teil)
      const tt = t / 1000, a = 1 - smooth((t - 380) / 340); if (a <= 0) return;
      const ga = c.globalAlpha; c.globalAlpha = ga * a;
      const cs = Math.cos(p.ang), sn = Math.sin(p.ang);
      for (let i = 4; i >= 0; i--) {
        const h1 = hash1(seed * 7.3 + i), h2 = hash1(seed * 3.1 + i * 5.7), h3 = hash1(seed + i * 11.1);
        const vx = (h1 - 0.5) * 170 - side * 70, vy = -(110 + h2 * 170), g = 1100;
        const lx = -i * 8.5, ix = lx * cs, iy = lx * sn;
        const sr = 11 - Math.abs(i - 1.5) * 1.3;
        c.save(); c.translate(x + ix + vx * tt, y + iy + vy * tt + 0.5 * g * tt * tt); c.rotate(p.ang + (h3 - 0.5) * 16 * tt);
        krabSeg(c, i, sr, p, false);
        if (i === 0) krabHead(c, p);
        c.restore();
      }
      c.globalAlpha = ga;
    }

    /* ============================================================== KLINGEN-FLEDERMAUS */
    function batPose(st, p) {
      const side = st.side || -1, t = st.t || 0, tA = st.tA || 0;
      p.rot = PI + Math.sin(tA * 0.0021) * 0.07; p.spread = 0.25 + 0.03 * Math.sin(tA * 0.003); p.flap = 0; p.cock = 0; p.dir = 1;
      p.ox = 0; p.oy = 0; p.sx = 1; p.sy = 1; p.earA = Math.max(0, Math.sin(tA * 0.0017 + 1)) * 0.25;
      switch (st.anim) {
        case 'windup': {
          // 1) Augen auf / Ohren hoch · 2) löst sich, dreht sich aus dem Kopfstand, Flügel entfalten sich ·
          // 3) Sichel-Flügel weit nach hinten gespannt, Körper duckt sich, Klingen zittern
          const q = clamp(t / (st.dur || T.windupMs), 0, 1);
          const drop = smooth((q - 0.15) / 0.35), unf = smooth((q - 0.2) / 0.4), cock = smooth((q - 0.55) / 0.3);
          p.earA = 0.35 * smooth(q / 0.15);
          p.rot = lerp(side < 0 ? PI : -PI, 0, drop) + Math.sin(tA * 0.0021) * 0.07 * (1 - drop);
          p.oy = 8 * drop; p.ox = -side * 3 * drop;
          p.spread = 0.25 + 0.95 * unf; p.cock = 0.95 * cock; p.sy = 1 - 0.14 * cock; p.sx = 1 + 0.06 * cock;
          if (q > 0.85) p.cock += Math.sin(t * 0.09) * 0.07 * smooth((q - 0.85) / 0.1);
          break;
        }
        case 'attack':
          p.rot = 0; p.spread = 1.05; p.flap = Math.sin(t * 0.03); p.dir = side < 0 ? 1 : -1; p.cock = -0.15 * Math.max(0, Math.sin(t * 0.03)); p.earA = 0.35;
          break;
      }
    }
    function batWing(c, spread) {
      const wi = Math.round(clamp(spread, 0, 1.25) * 16);
      let wg = GC[BK[wi]];
      if (!wg) { const sp = wi / 16; wg = GC[BK[wi]] = c.createLinearGradient(0, -10, 30 * sp + 1, 10); wg.addColorStop(0, C.batLo); wg.addColorStop(0.6, C.batBlade); wg.addColorStop(1, C.batHi); }
      c.fillStyle = F(wg);
      c.beginPath(); c.moveTo(4, -4); c.quadraticCurveTo(22 * spread, -22 * spread - 4, 34 * spread + 2, -4 * spread);
      c.quadraticCurveTo(22 * spread, -6, 6, 6); c.closePath(); c.fill();
    }
    function batBodyOnly(c, p) {
      c.fillStyle = F(C.bat); c.beginPath(); c.ellipse(0, 0, 8, 10, 0, 0, Math.PI * 2); c.fill();
      const e = p.earA * 6;
      c.beginPath(); c.moveTo(-6, -7); c.lineTo(-4 - e * 0.3, -15 - e); c.lineTo(-1, -8); c.moveTo(6, -7); c.lineTo(4 + e * 0.3, -15 - e); c.lineTo(1, -8); c.fill();
      c.fillStyle = F(C.batEye); c.beginPath(); c.arc(-3, -3, 1.8, 0, Math.PI * 2); c.arc(3, -3, 1.8, 0, Math.PI * 2); c.fill();
      if (glowOn()) { O.vfx.glow(c, -3, -3, 5, 'batEye', 0.45); O.vfx.glow(c, 3, -3, 5, 'batEye', 0.45); }
    }
    function batDraw(c, x, y, p) {
      c.save(); c.translate(x + p.ox, y + p.oy); c.scale(1.35, 1.35); c.rotate(p.rot); c.scale(p.dir * p.sx, p.sy);
      for (let s = -1; s <= 1; s += 2) { c.save(); c.scale(s, 1); c.rotate(-p.flap * 0.6 - p.cock); batWing(c, p.spread); c.restore(); }
      batBodyOnly(c, p);
      c.restore();
    }
    function batDeath(c, x, y, p, t, seed) {
      const tt = t / 1000, a = 1 - smooth((t - 420) / 340); if (a <= 0) return;
      const ga = c.globalAlpha; c.globalAlpha = ga * a;
      // Sichel-Flügel brechen ab und trudeln weg, Körper fällt
      for (let s = -1; s <= 1; s += 2) {
        const h = hash1(seed * 5.1 + s), vx = s * (110 + h * 80), vy = -(90 + h * 90), g = 900;
        c.save(); c.translate(x + vx * tt, y + vy * tt + 0.5 * g * tt * tt); c.scale(1.35, 1.35); c.rotate(p.rot + s * 11 * tt);
        c.scale(s * p.dir, 1); batWing(c, Math.max(0.6, p.spread)); c.restore();
      }
      const g = 1000;
      c.save(); c.translate(x, y + 0.5 * g * tt * tt - 40 * tt); c.scale(1.35, 1.35); c.rotate(p.rot + (hash1(seed) - 0.5) * 12 * tt); c.scale(1, 1 - 0.15 * smooth(t / 200));
      batBodyOnly(c, p); c.restore();
      c.globalAlpha = ga;
    }

    /* ============================================================== SEILSCHNEIDER-KOBOLD */
    function gobPose(st, p) {
      const t = st.t || 0, tA = st.tA || 0;
      const cyc = tA * 0.011;
      p.lean = 0; p.hx = -11; p.hy = 6; p.scA = PI; p.sn = 0.12; p.ox = 0; p.oy = 0; p.sx = 1; p.sy = 1;
      p.legC = Math.sin(cyc) * 3; p.grip = Math.cos(cyc) * 3; p.ear = Math.sin(tA * 0.006) * 0.1;
      if (st.anim === 'idle' || !st.anim) p.oy = Math.sin(cyc * 2) * 1.2;   // klettert Hand über Hand
      switch (st.anim) {
        case 'windup': {
          // Greift das Seil fest mit den Beinen, lehnt sich zurück, reißt die Scherenklaue hoch über den Kopf
          // und öffnet sie weit; kurz vor dem Schnitt: Zittern vor Anspannung
          const q = clamp(t / (st.dur || T.windupMs), 0, 1), k = smooth(q / 0.45), o = smooth((q - 0.2) / 0.5);
          p.legC = lerp(p.legC, -2, k); p.grip = lerp(p.grip, 2, k);
          p.hx = lerp(-11, -5, k); p.hy = lerp(6, -17, k); p.scA = lerp(PI, PI + 1.1, k); p.sn = lerp(0.12, 1.15, o);
          p.lean = 0.24 * k; p.ear = -0.4 * k;
          if (q > 0.8) { const z = smooth((q - 0.8) / 0.12); p.ox = Math.sin(t * 0.12) * 1.3 * z; p.sn += Math.sin(t * 0.07) * 0.05 * z; }
          break;
        }
        case 'attack': {
          // Schneidet: Klaue saust aufs Seil, schnippt immer schneller (prog), Körper bebt mit
          const k = smooth(t / 90), prog = st.prog || 0, rate = 0.022 + 0.03 * prog, s = Math.abs(Math.sin(t * rate));
          p.legC = -2; p.grip = 2;
          p.hx = lerp(-5, -12, k); p.hy = lerp(-17, 5, k); p.scA = lerp(PI + 1.1, PI + 0.15, k);
          p.sn = lerp(1.15, 0.1 + 0.9 * s, k); p.ox = Math.sin(t * 0.09) * (0.6 + 1.4 * prog) * k; p.lean = (0.06 - 0.09 * s) * k + 0.24 * (1 - k);
          p.ear = Math.sin(t * 0.05) * 0.2;
          break;
        }
      }
    }
    function gobScissor(c, sn) {
      c.fillStyle = F(C.claw);
      for (let s = -1; s <= 1; s += 2) { c.save(); c.rotate(s * sn * 0.5); c.beginPath(); c.moveTo(0, 0); c.lineTo(11, s * -1.5); c.lineTo(12, s * 1.5); c.lineTo(0, s * 2.5); c.closePath(); c.fill(); c.restore(); }
      c.fillStyle = F(C.joint); c.beginPath(); c.arc(0, 0, 1.4, 0, Math.PI * 2); c.fill();
    }
    function gobBody(c, p, withScissor) {
      // Beine ums Seil
      c.strokeStyle = F(C.gobDark); c.lineWidth = 3.5; c.lineCap = 'round';
      c.beginPath(); c.moveTo(-2, 13); c.lineTo(-8, 20 + p.legC); c.moveTo(4, 13); c.lineTo(-4, 22 - p.legC); c.stroke();
      // hintere Hand greift das Seil
      c.lineWidth = 3; c.beginPath(); c.moveTo(2, 1); c.lineTo(-11, -4 + p.grip); c.stroke();
      c.fillStyle = F(C.gobDark); rrect(c, -6, -2, 13, 16, 5); c.fill();
      // Kopf mit großen Ohren
      c.fillStyle = F(C.gob); c.beginPath(); c.arc(1, -10, 9, 0, Math.PI * 2); c.fill();
      c.save(); c.translate(7, -12); c.rotate(p.ear); c.beginPath(); c.moveTo(0, -1); c.lineTo(12, -7); c.lineTo(1, 5); c.fill(); c.restore();
      c.save(); c.translate(-5, -13); c.rotate(-p.ear); c.beginPath(); c.moveTo(0, -1); c.lineTo(-7, -9); c.lineTo(-2, 4); c.fill(); c.restore();
      c.fillStyle = F(C.gobEye); c.beginPath(); c.arc(-3, -11, 1.8, 0, Math.PI * 2); c.arc(3, -11, 1.8, 0, Math.PI * 2); c.fill();
      c.fillStyle = F(C.abyss); c.fillRect(-3, -6, 6, 1.5);
      // Scherenarm
      c.strokeStyle = F(C.gobDark); c.lineWidth = 3; c.beginPath(); c.moveTo(-4, 2); c.lineTo(p.hx, p.hy); c.stroke();
      if (withScissor) { c.save(); c.translate(p.hx - 1, p.hy); c.rotate(p.scA); gobScissor(c, p.sn); c.restore(); }
    }
    function gobDraw(c, x, y, p, side) {
      c.save(); c.translate(x + p.ox * side, y + p.oy); c.scale(side * p.sx, p.sy); c.rotate(p.lean); gobBody(c, p, true); c.restore();
    }
    function gobDeath(c, x, y, p, t, seed, side) {
      const tt = t / 1000, a = 1 - smooth((t - 480) / 340); if (a <= 0) return;
      const ga = c.globalAlpha; c.globalAlpha = ga * a;
      const g = 1000, vx = side * (130 + hash1(seed) * 60), vy = -150;
      // vom Seil geschleudert, überschlägt sich
      c.save(); c.translate(x + vx * tt, y + vy * tt + 0.5 * g * tt * tt); c.scale(side, 1); c.rotate(p.lean + 9 * tt); gobBody(c, p, false); c.restore();
      // Scherenblätter fliegen getrennt davon
      for (let s = -1; s <= 1; s += 2) {
        const h = hash1(seed * 3.7 + s), bvx = -side * (60 + h * 90) + s * 40, bvy = -(160 + h * 100);
        c.save(); c.translate(x - side * 12 + bvx * tt, y + 4 + bvy * tt + 0.5 * g * tt * tt); c.rotate(p.scA + s * 13 * tt);
        c.fillStyle = F(C.claw); c.beginPath(); c.moveTo(0, 0); c.lineTo(11, s * -1.5); c.lineTo(12, s * 1.5); c.lineTo(0, s * 2.5); c.closePath(); c.fill(); c.restore();
      }
      c.globalAlpha = ga;
    }

    /* ============================================================== PFLANZEN */
    function plantPose(st, p, spit) {
      const t = st.t || 0, tA = st.tA || 0;
      p.s = 1; p.rot = Math.sin(tA * 0.004) * 0.08; p.open = 0.3 + 0.12 * Math.sin(tA * 0.008); p.leaf = Math.sin(tA * 0.005) * 0.15;
      p.ox = 0; p.oy = 0; p.sx = 1; p.sy = 1; p.peek = 0; p.alpha = 1;
      p.bulb = 13 + 0.6 * Math.sin(tA * 0.005); p.tube = 4; p.aim = st.aim || 0;
      switch (st.anim) {
        case 'windup':
          if (spit && st.phase === 'aim') {
            // Spuckpflanze zielt: Kopf schiebt sich heraus, dreht sich zum Ziel, Blase bläht sich auf, Rohr zieht zurück
            const q = clamp(t / (st.dur || T.aimMs), 0, 1), e = easeOutBack(Math.min(1, q * 2.2));
            p.s = lerp(0.45, 1, e); p.bulb = lerp(13, 17, smooth(q / 0.85)); p.tube = lerp(4, -1, smooth(q / 0.85));
            p.rot = 0; p.leaf = -0.25 * q;
            if (q > 0.72) { const z = smooth((q - 0.72) / 0.15); p.ox = Math.sin(t * 0.13) * 1.2 * z; p.bulb += Math.sin(t * 0.09) * 0.5 * z; }
          } else {
            // Mauerriss (vfx.wallBreak) läuft; die Pflanze selbst drückt gegen Ende von hinten durch den Spalt
            const q = clamp(t / (st.dur || T.crackMs), 0, 1), k = smooth((q - 0.55) / 0.45);
            p.peek = k; p.s = 0.16 + 0.26 * k; p.open = 0.06 + 0.05 * Math.sin(t * 0.04); p.rot = Math.sin(t * 0.045) * 0.22 * k; p.alpha = k;
            p.bulb = 12; p.tube = 2;
          }
          break;
        case 'attack':
          if (spit) {   // Spucken: Rückstoß, Blase fällt zusammen, Rohr schnellt vor
            const k = clamp(t / 220, 0, 1), kick = Math.sin(Math.min(1, t / 140) * PI);
            p.bulb = lerp(17, 12, easeOutCubic(k * 1.6)); p.tube = -1 + 6 * kick; p.rot = 0;
            p.ox = -Math.cos(p.aim) * 4 * kick; p.oy = -Math.sin(p.aim) * 4 * kick;
          } else {      // Biss: schießt aus dem Loch, Kiefer weit auf, schnappt zu
            const q = clamp(t / (st.dur || T.biteMs), 0, 1);
            p.s = 0.4 + 0.8 * easeOutBack(q); p.open = q < 0.55 ? 1.05 : 1.05 - smooth((q - 0.55) / 0.35) * 1.0; p.rot = 0; p.leaf = 0.3 * (1 - q);
          }
          break;
        case 'retract': {
          const q = clamp(t / (st.dur || T.retractMs), 0, 1);
          p.s = 1 - smooth(q); p.rot += 0.5 * q; p.open *= 1 - q; p.bulb = lerp(p.bulb, 11, q);
          break;
        }
      }
    }
    function plantVine(c, p) {
      c.strokeStyle = F(C.moss); c.lineWidth = 6; c.lineCap = 'round'; c.beginPath(); c.moveTo(0, 8); c.quadraticCurveTo(-8, 18, 0, 26); c.stroke();
    }
    function plantLeaves(c, p) {
      c.fillStyle = F(C.gob); c.beginPath();
      c.ellipse(-14, 10, 10, 4, -0.6 - p.leaf, 0, Math.PI * 2); c.ellipse(14, 12, 10, 4, 0.6 + p.leaf, 0, Math.PI * 2); c.fill();
    }
    function biteHead(c, p) {
      let hg = GC.ph; if (!hg) { hg = GC.ph = c.createLinearGradient(0, -20, 0, 0); hg.addColorStop(0, C.gob); hg.addColorStop(1, C.moss); }
      for (let s = -1; s <= 1; s += 2) {
        c.save(); c.rotate(s * p.open * 0.7);
        c.fillStyle = F(hg); c.beginPath(); c.ellipse(0, s * -8, 20, 10, 0, s < 0 ? Math.PI : 0, s < 0 ? Math.PI * 2 : Math.PI); c.fill();
        c.fillStyle = F(C.red); c.beginPath(); c.ellipse(0, s * -3, 15, 4, 0, 0, Math.PI * 2); c.fill();
        c.fillStyle = F(C.text); c.beginPath();
        for (let i = -3; i <= 3; i++) { c.moveTo(i * 4.5 - 2, s * -2); c.lineTo(i * 4.5, s * 5); c.lineTo(i * 4.5 + 2, s * -2); }
        c.fill(); c.restore();
      }
    }
    function spitHead(c, p) {
      c.fillStyle = F(C.gob); c.beginPath(); c.arc(0, 0, p.bulb, 0, Math.PI * 2); c.fill();
      c.fillStyle = F('rgba(47,91,74,.55)'); c.beginPath(); c.arc(-p.bulb * 0.15, p.bulb * 0.25, p.bulb * 0.7, 0, Math.PI * 2); c.fill();   // Unterseite (Moos)
      c.save(); c.rotate(p.aim); c.fillStyle = F(C.moss); rrect(c, p.tube, -6, 18, 12, 5); c.fill();
      c.fillStyle = F(C.abyss); c.beginPath(); c.ellipse(p.tube + 18, 0, 3, 5, 0, 0, Math.PI * 2); c.fill(); c.restore();
      c.fillStyle = F(C.red); c.beginPath(); c.arc(-4, -4, 2.2, 0, Math.PI * 2); c.arc(3, -5, 2.2, 0, Math.PI * 2); c.fill();
    }
    function plantDraw(c, x, y, p, spit) {
      if (p.s <= 0.01 || p.alpha <= 0.01) return;
      const ga = c.globalAlpha; if (p.alpha < 1) c.globalAlpha = ga * p.alpha;
      c.save(); c.translate(x + p.ox, y + p.oy); c.scale(p.s * p.sx, p.s * p.sy);
      if (!p.peek) { plantVine(c, p); plantLeaves(c, p); }
      c.rotate(p.rot);
      if (spit) spitHead(c, p); else biteHead(c, p);
      c.restore(); c.globalAlpha = ga;
    }
    function plantDeath(c, x, y, p, t, seed, spit) {
      // welkt: Kopf sackt nach unten weg, schrumpft ins Loch, Blätter fallen ab
      const tt = t / 1000, a = 1 - smooth((t - 380) / 320); if (a <= 0) return;
      const ga = c.globalAlpha; c.globalAlpha = ga * a;
      const k = smooth(t / 500);
      c.save(); c.translate(x, y + 8 * k); const s = p.s * (1 - 0.5 * k); c.scale(s, s);
      plantVine(c, p);
      c.rotate(p.rot + 1.1 * smooth(t / 350) * (hash1(seed) < 0.5 ? -1 : 1));
      const o = p.open; p.open = lerp(o, 0.75, k); const b = p.bulb; p.bulb = lerp(b, 10, k);
      if (spit) spitHead(c, p); else biteHead(c, p);
      p.open = o; p.bulb = b;
      c.restore();
      for (let s2 = -1; s2 <= 1; s2 += 2) {
        const h = hash1(seed * 2.3 + s2), vx = s2 * (40 + h * 60), g = 380;
        c.save(); c.translate(x + s2 * 14 + vx * tt, y + 11 + 0.5 * g * tt * tt - 30 * tt); c.rotate(s2 * (0.6 + 5 * tt));
        c.fillStyle = F(C.gob); c.beginPath(); c.ellipse(0, 0, 10, 4, 0, 0, Math.PI * 2); c.fill(); c.restore();
      }
      c.globalAlpha = ga;
    }

    /* ============================================================== DISPATCH */
    function pose(type, st, p) {
      p.type = type; p.side = st.side || -1; p.tA = st.tA || 0; p.anim = st.anim || 'idle';
      switch (type) {
        case 'krabbler': krabPose(st, p); break;
        case 'fledermaus': batPose(st, p); break;
        case 'seilschneider': gobPose(st, p); break;
        case 'beisspflanze': plantPose(st, p, false); break;
        case 'spuckpflanze': plantPose(st, p, true); break;
      }
      return p;
    }
    function render(c, type, x, y, p) {
      switch (type) {
        case 'krabbler': krabDraw(c, x, y, p); break;
        case 'fledermaus': batDraw(c, x, y, p); break;
        case 'seilschneider': gobDraw(c, x, y, p, p.side); break;
        case 'beisspflanze': plantDraw(c, x, y, p, false); break;
        case 'spuckpflanze': plantDraw(c, x, y, p, true); break;
      }
    }
    // Treffer-Reaktion: Rückstoß weg vom Ninja, Stauchen, weiße Überblendung (1 Hieb = Tod → läuft vor death)
    function applyHit(p, k, side) {
      const j = Math.sin(clamp(k, 0, 1) * PI);
      switch (p.type) {
        case 'krabbler': p.ox += side * 4 * j; p.sx *= 1 - 0.18 * j; p.sy *= 1 + 0.14 * j; p.mand = 1.2; p.spike += 3 * j; break;
        case 'fledermaus': p.ox += side * 4 * j; p.spread = Math.max(0.45, p.spread - 0.45 * j); p.flap = 0.6 * j; p.sy *= 1 - 0.12 * j; break;
        case 'seilschneider': p.oy -= 4 * j; p.lean -= 0.5 * j; p.sn = 1.2; p.ear = 0.5 * j; break;
        default: p.sx *= 1 + 0.12 * j; p.sy *= 1 - 0.1 * j; p.open = Math.max(p.open, 1.1 * j); p.rot += 0.25 * j; p.bulb *= 1 - 0.1 * j; break;
      }
    }
    function drawPose(c, x, y, p, hitK) {
      useCtx(c);
      render(c, p.type, x, y, p);
      if (hitK > 0.02) {   // Überblendung: gleiche Silhouette in Flash-Weiß, Alpha klingt ab
        const ga = c.globalAlpha; c.globalAlpha = ga * hitK * 0.85; TINT = C.flash;
        render(c, p.type, x, y, p);
        TINT = null; c.globalAlpha = ga;
      }
    }
    // Öffentlich: Zeichnen mit explizitem Zustand
    // st = { anim:'idle'|'windup'|'attack'|'recover'|'retract'|'hit', t, dur, side, attack, phase, aim, prog, tA }
    function draw(c, type, x, y, st) {
      pose(type, st, P);
      let hk = 0;
      if (st.anim === 'hit') { const k = clamp((st.t || 0) / HIT_MS, 0, 1); applyHit(P, k, P.side); hk = 1 - k; }
      drawPose(c, x, y, P, hk);
    }

    /* -------------------------------------------------------------- Adapter für index.html-Entities (nur lesend) */
    const ST = { anim:'idle', t:0, dur:0, side:-1, attack:'', phase:'', aim:0, prog:0, tA:0 };
    function mapEnt(e, out) {
      const s = out || ST;
      s.side = e.side || -1; s.attack = e.attack || ''; s.aim = e.aimDir || 0; s.prog = e.prog || 0;
      s.tA = (e.anim || 0) * 1000 + (e.id || 0) * 377; s.t = e.t || 0; s.dur = 0; s.phase = ''; s.anim = 'idle';
      switch (e.type) {
        case 'krabbler': case 'fledermaus':
          if (e.state === 'windup') { s.anim = 'windup'; s.dur = e.windupMs; }
          else if (e.state === 'attack') { s.anim = 'attack'; s.dur = T.jabMs; }
          else if (e.state === 'recover') { s.anim = 'recover'; s.dur = T.recoverMs; }
          break;
        case 'seilschneider': {
          s.side = e.side || 1; s.tA = (e.t || 0) + (e.state === 'cut' ? 1e5 : 0);
          const wu = O.cutterWindupMs || Math.min(T.windupMs, (e.cutMs || 2200) * 0.4);
          if (e.state === 'cut') { if (e.t < wu) { s.anim = 'windup'; s.dur = wu; } else { s.anim = 'attack'; s.t = e.t - wu; } }
          break;
        }
        case 'beisspflanze': case 'spuckpflanze':
          s.tA = (e.t || 0) + (e.id || 0) * 377;
          if (e.state === 'pending') s.anim = 'none';
          else if (e.state === 'crack') { s.anim = 'windup'; s.phase = 'crack'; s.dur = e.crackMs; }
          else if (e.state === 'aim') { s.anim = 'windup'; s.phase = 'aim'; s.dur = T.aimMs; }
          else if (e.state === 'bite') { s.anim = 'attack'; s.dur = T.biteMs; }
          else if (e.state === 'stay') { if (e.type === 'spuckpflanze' && e.t < 220) { s.anim = 'attack'; s.phase = 'spit'; } }
          else if (e.state === 'retract') { s.anim = 'retract'; s.dur = T.retractMs; }
          break;
      }
      return s;
    }
    // drawEnt(ctx, e[, x, y]) – x/y Standard e.x / e.y + e.yOff; Pflanzen: colX(e.c)/rowY(e.r) übergeben
    function drawEnt(c, e, x, y) {
      const s = mapEnt(e, ST); if (s.anim === 'none') return;
      draw(c, e.type, x ?? e.x, y ?? (e.y + (e.yOff || 0)), s);
    }

    /* -------------------------------------------------------------- Leichen-Pool (Hit → Death) */
    const corpses = []; for (let i = 0; i < 10; i++) corpses.push({ on:false, type:'', x:0, y:0, t:0, seed:0, side:-1, pose:makePose() });
    function spawnCorpse(type, x, y, st) {
      let k = null; for (const c of corpses) if (!c.on) { k = c; break; }
      if (!k) { k = corpses[0]; for (const c of corpses) if (c.t > k.t) k = c; }
      pose(type, st, P); copyPose(k.pose, P);
      k.on = true; k.type = type; k.x = x; k.y = y; k.t = 0; k.side = st.side || -1; k.seed = (Math.random() * 1000) | 0;
      return k;
    }
    // kill(e, x, y): beim Kill in index.html (killEnt) aufrufen – friert die aktuelle Pose ein, spielt Hit (90 ms) + Tod
    function kill(e, x, y) { const s = mapEnt(e, ST); if (s.anim === 'none') s.anim = 'idle'; return spawnCorpse(e.type, x ?? e.x, y ?? (e.y + (e.yOff || 0)), s); }
    function killAt(type, x, y, st) { return spawnCorpse(type, x, y, st || ST); }
    const HP = makePose();
    function update(dtMs) { if (!(dtMs > 0)) return; for (const c of corpses) if (c.on) { c.t += dtMs; if (c.t > HIT_MS + (DEATH_MS[c.type] || 700)) c.on = false; } }
    function drawCorpses(c) {
      for (const k of corpses) {
        if (!k.on) continue;
        useCtx(c);
        if (k.t < HIT_MS) { copyPose(HP, k.pose); const q = k.t / HIT_MS; applyHit(HP, q, k.side); drawPose(c, k.x, k.y, HP, 1 - q * 0.6); continue; }
        const t = k.t - HIT_MS, p = k.pose;
        switch (k.type) {
          case 'krabbler': krabDeath(c, k.x, k.y, p, t, k.seed, k.side); break;
          case 'fledermaus': batDeath(c, k.x, k.y, p, t, k.seed); break;
          case 'seilschneider': gobDeath(c, k.x, k.y, p, t, k.seed, k.side); break;
          case 'beisspflanze': plantDeath(c, k.x, k.y, p, t, k.seed, false); break;
          case 'spuckpflanze': plantDeath(c, k.x, k.y, p, t, k.seed, true); break;
        }
      }
    }
    function clear() { for (const c of corpses) c.on = false; }
    // Vorschau/Tests: Tod eines Gegners zum Zeitpunkt tDeath (ms nach Ende der Treffer-Reaktion) direkt zeichnen
    function drawDeath(c, type, x, y, st, tDeath) {
      pose(type, st, P); useCtx(c); const sd = 7, sideD = st.side || -1, t = tDeath || 0;
      switch (type) {
        case 'krabbler': krabDeath(c, x, y, P, t, sd, sideD); break;
        case 'fledermaus': batDeath(c, x, y, P, t, sd); break;
        case 'seilschneider': gobDeath(c, x, y, P, t, sd, sideD); break;
        case 'beisspflanze': plantDeath(c, x, y, P, t, sd, false); break;
        case 'spuckpflanze': plantDeath(c, x, y, P, t, sd, true); break;
      }
    }

    return { draw, drawEnt, mapEnt, kill, killAt, update, drawCorpses, drawDeath, clear, setBalance: applyBalance,
      times: T, HIT_MS, DEATH_MS, TYPES, get corpseCount() { let n = 0; for (const c of corpses) if (c.on) n++; return n; }, options: O };
  }

  root.BNEnemyAnim = { create, version: '0.1.0', TYPES };
})(typeof window !== 'undefined' ? window : globalThis);
