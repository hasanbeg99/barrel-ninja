#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Barrel Ninja – prozeduraler Sound-Generator (SFX, Ambience, Musik).

Alles wird hier per Code synthetisiert (Rauschen, Sinus/Modal-Synthese, Karplus-Strong,
additive Flöte, Faltungshall aus synthetischer Impulsantwort). Es werden KEINE Samples
oder fremden Aufnahmen verwendet. Urheber: Oruci Sabahudin.

Reproduzierbar: fester Seed pro Sound (SEED + Index).
Benötigt: Python 3.10+, numpy, scipy, soundfile, pyloudnorm, matplotlib, ffmpeg
(mit libvorbis, aac, libmp3lame).

Aufruf:  python generate.py [--audio-dir DIR] [--work-dir DIR] [--no-plots]
"""
import argparse, json, os, shutil, subprocess, sys, zlib
import numpy as np
from scipy import signal
from scipy.ndimage import minimum_filter1d, uniform_filter1d
import soundfile as sf
import pyloudnorm as pyln

SR = 44100
SEED = 20261022
TP_CEIL_DB = -1.5          # Ziel-True-Peak des Masters (Codec-Reserve bis -1 dBFS)
MAX_GR_DB = 6.0            # max. Limiter-Absenkung, sonst wird leiser normalisiert
SFX_HPF = 80.0             # kein Inhalt unter ~80 Hz (Handylautsprecher)
LOOP_HPF = 75.0

rng = np.random.default_rng(SEED)   # wird pro Sound neu gesetzt (siehe build)

# ----------------------------------------------------------------- Grundbausteine
def tt(d):
    return np.arange(int(round(d * SR))) / SR

def N(d):
    return int(round(d * SR))

def noise(n):
    return rng.standard_normal(n)

def sos_filter(x, kind, f, order=2):
    sos = signal.butter(order, f, btype=kind, fs=SR, output='sos')
    return signal.sosfilt(sos, x, axis=0)

def hp(x, f, order=2): return sos_filter(x, 'highpass', f, order)
def lp(x, f, order=2): return sos_filter(x, 'lowpass', f, order)
def bp(x, lo, hi, order=2): return sos_filter(x, 'bandpass', [lo, hi], order)

def peak_filt(x, f, q):
    b, a = signal.iirpeak(min(f, SR / 2 * 0.95), q, fs=SR)
    return signal.lfilter(b, a, x)

def svf(x, fc, q, mode='bp'):
    """Zeitvariabler TPT-State-Variable-Filter (fc als Array). Für kurze Sounds."""
    fc = np.broadcast_to(np.asarray(fc, float), x.shape)
    g = np.tan(np.pi * np.clip(fc, 20, SR * 0.45) / SR)
    k = 1.0 / q
    a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2
    ic1 = ic2 = 0.0
    out = np.empty_like(x)
    xs = x.tolist(); A1 = a1.tolist(); A2 = a2.tolist(); A3 = a3.tolist()
    for i in range(len(xs)):
        v3 = xs[i] - ic2
        v1 = A1[i] * ic1 + A2[i] * v3
        v2 = ic2 + A2[i] * ic1 + A3[i] * v3
        ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2
        out[i] = v1 if mode == 'bp' else (v2 if mode == 'lp' else xs[i] - k * v1 - v2)
    return out

def exp_sweep(f0, f1, n, curve=1.0):
    u = np.linspace(0, 1, n) ** curve
    return f0 * (f1 / f0) ** u

def env_exp(t, tau, attack=0.001):
    e = np.exp(-t / tau)
    if attack > 0:
        e *= np.clip(t / attack, 0, 1)
    return e

def env_hump(t, tpeak, a=2.0):
    """Glatte Hüllkurve mit Maximum bei tpeak (Gamma-Form)."""
    u = np.maximum(t, 1e-9) / tpeak
    return u ** a * np.exp(a * (1 - u))

def fades(x, fin=0.002, fout=0.015):
    x = x.copy()
    ni, no = max(1, N(fin)), max(1, N(fout))
    w_in = np.sin(np.linspace(0, np.pi / 2, ni)) ** 2
    w_out = np.cos(np.linspace(0, np.pi / 2, no)) ** 2
    x[:ni] = (x[:ni].T * w_in).T
    x[-no:] = (x[-no:].T * w_out).T
    return x

def place(buf, x, t0, gain=1.0):
    i = N(t0)
    if i < 0:
        x = x[-i:]; i = 0
    if i >= len(buf): return
    j = min(len(buf), i + len(x))
    buf[i:j] += gain * x[:j - i]

def sat(x, drive):
    return np.tanh(drive * x) / np.tanh(drive)

def pan(x, p):
    """Equal-power-Panning, p in [-1, 1]."""
    a = (p + 1) * np.pi / 4
    return np.stack([x * np.cos(a), x * np.sin(a)], axis=1)

def midi_hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)

# ----------------------------------------------------------------- Klangmodelle
def endfade(x, d=0.012):
    n = min(len(x), N(d))
    x[-n:] *= np.cos(np.linspace(0, np.pi / 2, n)) ** 2
    return x

def modal(dur, freqs, amps, taus, attack=0.0015, glide=0.0, glide_tau=0.02, detune=0.0):
    """Modal-/Additivsynthese für Metall, Holz, Glocken (gedämpfte Sinusmoden)."""
    t = tt(dur); out = np.zeros_like(t)
    gl = 1 + glide * np.exp(-t / glide_tau)
    for f, a, tau in zip(freqs, amps, taus):
        for dt_ in ([0.0] if detune == 0 else [-detune, detune]):
            ph = 2 * np.pi * np.cumsum(f * (1 + dt_) * gl) / SR + rng.uniform(0, 2 * np.pi)
            out += a * np.sin(ph) * np.exp(-t / tau) / (1 if detune == 0 else 2)
    return endfade(out * np.clip(t / attack, 0, 1))

def fm_bell(dur, fc, ratio=1.4, index=2.0, idx_tau=0.08, tau=0.25, attack=0.002):
    t = tt(dur)
    m = index * np.exp(-t / idx_tau) * np.sin(2 * np.pi * fc * ratio * t)
    return endfade(np.sin(2 * np.pi * fc * t + m) * env_exp(t, tau, attack))

def taiko(dur=0.6, f0=130.0, drive=2.5, stick=0.35, tau=0.28):
    """Membran-Moden (Bessel-Verhältnisse) + Pitch-Drop + Sättigung -> Obertöne."""
    t = tt(dur)
    fr = f0 * (1 + 0.35 * np.exp(-t / 0.025))
    ph = 2 * np.pi * np.cumsum(fr) / SR
    ratios = [1, 1.59, 2.14, 2.30, 2.65, 2.92]
    amps = [1, 0.55, 0.35, 0.25, 0.15, 0.1]
    taus = [tau, tau * 0.45, tau * 0.33, tau * 0.28, tau * 0.22, tau * 0.18]
    x = sum(a * np.sin(r * ph) * np.exp(-t / tt_) for r, a, tt_ in zip(ratios, amps, taus))
    x += stick * bp(noise(len(t)), 300, 2500) * np.exp(-t / 0.008)
    x *= np.clip(t / 0.001, 0, 1)
    return endfade(sat(x / np.max(np.abs(x)), drive), 0.03)

def ks_pluck(f, dur, t60=2.0, bright=0.6, pos=0.18, amp=1.0):
    """Karplus-Strong mit Allpass-Feinstimmung, als IIR via lfilter (schnell)."""
    P = SR / f
    Nd = int(np.floor(P - 0.6))
    d = P - 0.5 - Nd
    c = (1 - d) / (1 + d)
    g = 10 ** (-3 / (f * t60))
    a = np.zeros(Nd + 3); a[0] = 1; a[1] = c
    a[Nd] -= g * 0.5 * c; a[Nd + 1] -= g * 0.5 * (1 + c); a[Nd + 2] -= g * 0.5
    b = np.array([1.0, c])
    L = int(round(P))
    exc = noise(L)
    k = 1 - bright
    exc = signal.lfilter([1 - k], [1, -k], exc)               # Helligkeit
    sh = max(1, int(pos * P)); exc = exc - np.roll(exc, sh)  # Zupfposition (Kammfilter)
    exc -= exc.mean(); exc /= (np.std(exc) + 1e-12)
    x = np.zeros(N(dur)); x[:L] = exc
    y = signal.lfilter(b, a, x)
    y = y * np.clip(tt(dur) / 0.0008, 0, 1)
    return endfade(amp * y / (np.max(np.abs(y[:L * 4])) + 1e-12), 0.04)

def flute(f, dur, bend=0.0, bend_tau=0.09, vib=0.006, vib_rate=5.2, breath=0.18,
          attack=0.1, release=0.3, amp=1.0, chiff=0.5):
    """Shakuhachi-artige Flöte: additive Töne + Atemrauschen, Pitch-Bend (meri/kari)."""
    t = tt(dur)
    vib_env = np.clip((t - 0.3) / 0.6, 0, 1)
    fi = f * 2 ** ((bend * np.exp(-t / bend_tau)) / 12) * \
        (1 + vib * vib_env * np.sin(2 * np.pi * vib_rate * t))
    ph = 2 * np.pi * np.cumsum(fi) / SR
    tone = np.sin(ph) + 0.30 * np.sin(2 * ph + 0.4) + 0.12 * np.sin(3 * ph + 1.1) + 0.05 * np.sin(4 * ph)
    a_env = np.clip(t / attack, 0, 1) ** 1.5
    r_env = np.clip((dur - t) / release, 0, 1) ** 1.2
    swell = 1 + 0.12 * np.sin(np.pi * np.clip(t / dur, 0, 1))
    env = a_env * r_env * swell
    nz = noise(len(t))
    br = lp(bp(nz, 1200, 4500), 5000, 4) * 0.4 + peak_filt(nz, f, 4) * 1.5 + peak_filt(nz, 2 * f, 6) * 0.6
    br = br / (np.std(br) + 1e-12)
    ch = lp(bp(noise(len(t)), 1800, 6000), 7000, 4) * np.exp(-t / 0.035) * chiff
    x = tone * env * 0.8 + br * breath * env * 0.35 + ch * np.clip(t / 0.004, 0, 1)
    return amp * x

def grains(dur, times, freqs, qs, amps, glen=0.004):
    """Kurze Rausch-Impulse durch resonante Bandpässe (Splitter, Fasern, Krümel)."""
    out = np.zeros(N(dur) + N(0.08))
    for t0, f, q, a in zip(times, freqs, qs, amps):
        n = max(8, N(glen)); g = noise(n) * np.hanning(n)
        g = np.concatenate([g, np.zeros(N(0.06))])
        g = peak_filt(g, f, q)
        g /= (np.max(np.abs(g)) + 1e-12)
        place(out, g, t0, a)
    return out[:N(dur)]

def creak(dur, rate, res=((600, 9, 1.0), (1100, 10, 0.8), (1900, 12, 0.6), (3200, 10, 0.35)),
          jitter=0.12):
    """Stick-Slip-Reibung: unregelmäßiger Impulszug -> resonante Filterbank."""
    n = N(dur); rate = np.broadcast_to(np.asarray(rate, float), (n,))
    x = np.zeros(n); ph = 0.0; i = 0
    while i < n:
        per = SR / rate[i] * (1 + jitter * rng.standard_normal())
        i += max(2, int(per))
        if i < n:
            x[i] = rng.uniform(0.5, 1.0)
            if i + 1 < n: x[i + 1] = -0.5 * x[i]
    y = sum(a * peak_filt(x, f, q) for f, q, a in res)
    return y

def make_ir(dur, tau_lo, tau_hi, xover=2500, seed_off=0, stereo=True, early=(), predelay=0.012):
    """Synthetische Hall-Impulsantwort (Stein/Brunnen): exponentiell abklingendes Rauschen,
    Höhen klingen schneller ab, plus diskrete frühe Reflexionen."""
    r = np.random.default_rng(SEED + 999 + seed_off)
    t = tt(dur); ch = 2 if stereo else 1
    irs = []
    for c in range(ch):
        nz = r.standard_normal(len(t))
        lo = lp(nz, xover, 2); hi = nz - lo
        ir = lo * np.exp(-t / tau_lo) + hi * np.exp(-t / tau_hi)
        ir *= np.clip((t - predelay) / 0.01, 0, 1)
        for et, eg in early:
            k = N(et + r.uniform(-0.003, 0.003))
            if k < len(ir): ir[k] += eg * (1 if r.random() > 0.3 else -1) * 3
        nf = int(len(ir) * 0.4)
        ir[-nf:] *= np.cos(np.linspace(0, np.pi / 2, nf)) ** 2     # sauberes Ende der Hallfahne
        ir /= np.sqrt(np.sum(ir ** 2))
        irs.append(ir)
    return np.stack(irs, axis=1) if stereo else irs[0]

def reverb(x, ir, wet=0.3, dry=1.0):
    """Lineare Faltung (mono->mono oder mono/stereo->stereo)."""
    if ir.ndim == 1:
        y = signal.fftconvolve(x, ir)
        out = np.zeros(len(y)); out[:len(x)] += dry * x
        return out + wet * y
    xs = x if x.ndim == 2 else np.stack([x, x], 1)
    y = np.stack([signal.fftconvolve(xs[:, c], ir[:, c]) for c in range(2)], 1)
    out = np.zeros_like(y); out[:len(xs)] += dry * xs
    return out + wet * y

def circ_conv(x, ir):
    """Zirkuläre Faltung -> Hallfahne wickelt sich an den Loop-Anfang (nahtlos)."""
    L = len(x)
    X = np.fft.rfft(x, axis=0)
    H = np.fft.rfft(ir if len(ir) <= L else ir[:L], n=L, axis=0)
    if x.ndim == 2 and H.ndim == 1: H = H[:, None]
    return np.fft.irfft(X * H, n=L, axis=0)

def circ_noise(L, lo, hi, slope_db_oct=0.0, ch=1):
    """Periodisches (loopbares) gefiltertes Rauschen über FFT-Formung."""
    f = np.fft.rfftfreq(L, 1 / SR)
    spec = (rng.standard_normal((len(f), ch)) + 1j * rng.standard_normal((len(f), ch)))
    w = ((f >= lo) & (f <= hi)).astype(float)
    edge = 0.25
    w = np.where(f < lo, np.exp(-((np.log2(np.maximum(f, 1) / lo)) / edge) ** 2), w)
    w = np.where(f > hi, np.exp(-((np.log2(np.maximum(f, 1) / hi)) / edge) ** 2), w)
    w *= (np.maximum(f, 1) / max(lo, 1)) ** (slope_db_oct / 6.02)
    y = np.fft.irfft(spec * w[:, None], n=L, axis=0)
    y /= np.std(y)
    return y[:, 0] if ch == 1 else y

def circ_place(buf, x, t0, gain=1.0):
    L = len(buf); i = N(t0) % L
    idx = (i + np.arange(len(x))) % L
    np.add.at(buf, idx, gain * x)

def loop_safe(fn, x):
    """Filter/Limiter nahtlos auf Loops anwenden (3x kacheln, Mitte nehmen)."""
    L = len(x)
    y = fn(np.concatenate([x, x, x], axis=0))
    return y[L:2 * L]

# ----------------------------------------------------------------- SFX
def s_swipe():
    d = 0.24; t = tt(d); n = len(t)
    fc = exp_sweep(900, 4200, n, 0.8)
    body = svf(noise(n), fc, 1.3) * env_hump(t, 0.065, 2.2)
    air = hp(noise(n), 5000, 2) * env_hump(t, 0.08, 2.5) * 0.25
    return body + air

def s_rope_retract():
    d = 0.42; t = tt(d); n = len(t)
    fc = exp_sweep(700, 1900, n)
    env = np.clip(t / 0.04, 0, 1) * np.clip((d - 0.03 - t) / 0.03, 0, 1) ** 0.5 * (0.6 + 0.4 * t / d)
    fric = svf(noise(n), fc, 2.0) * env
    rate = np.linspace(25, 75, n)
    times = np.cumsum(1 / rate[::400][:30]) * 0.7
    times = times[times < d - 0.04]
    gr = grains(d, times, rng.uniform(1200, 3400, len(times)), rng.uniform(4, 9, len(times)),
                rng.uniform(0.3, 0.7, len(times)) * (0.5 + times / d), 0.003)
    stop = modal(0.12, [880, 1960, 3100], [1, 0.4, 0.2], [0.03, 0.015, 0.008])
    out = fric * 0.8 + gr * 0.35
    place(out, stop, d - 0.12, 0.45)
    return out

def s_rope_extend():
    d = 0.5; t = tt(d); n = len(t)
    fc = exp_sweep(1700, 600, n)
    env = env_hump(t, 0.05, 1.5) * (1 - t / d) ** 0.8
    fric = svf(noise(n), fc, 1.8) * env
    rate = np.linspace(65, 18, 40)
    times = np.cumsum(1 / rate)
    times = times[times < d - 0.08]
    gr = grains(d, times, rng.uniform(900, 2600, len(times)), rng.uniform(4, 9, len(times)),
                rng.uniform(0.3, 0.7, len(times)) * (1 - times / d), 0.004)
    tension = creak(0.14, 45, jitter=0.15) * env_hump(tt(0.14), 0.05)
    out = fric * 0.85 + gr * 0.35
    place(out, tension / (np.max(np.abs(tension)) + 1e-9), d - 0.16, 0.25)
    return out

def s_rope_creak():
    d = 0.75; t = tt(d); n = len(t)
    rate = 28 + 30 * np.sin(np.pi * np.clip(t / 0.55, 0, 1)) ** 1.5
    c = creak(d, rate, jitter=0.1)
    c = sat(c / np.percentile(np.abs(c), 99.5), 2.0)
    env = np.clip(t / 0.12, 0, 1) ** 1.5 * np.clip((d - t) / 0.22, 0, 1)
    fib = bp(noise(n), 1500, 4500) * 0.08
    return (c + fib) * env

def s_sword_slash():
    d = 0.48; t = tt(d); n = len(t)
    fc = exp_sweep(1200, 5500, n, 0.35)
    whoosh = svf(lp(noise(n), 9000, 2), fc, 3.0) * env_hump(t, 0.05, 2.0)
    blade = modal(d - 0.025, [2350, 3455, 4912, 6486, 8225], [1, 0.75, 0.5, 0.35, 0.22],
                  [0.20, 0.15, 0.10, 0.07, 0.05], attack=0.004, glide=-0.03, glide_tau=0.03, detune=0.0025)
    scrape = hp(noise(n), 4000, 2) * env_hump(t, 0.03, 1.5) * (0.6 + 0.4 * np.sin(2 * np.pi * 180 * t))
    out = whoosh * 0.7 + scrape * 0.25
    place(out, blade, 0.025, 0.4)
    return out

def _hit_core(f_hi=220, f_lo=110, tau=0.06, drive=3.0, crack=1.0, d=0.32):
    t = tt(d); n = len(t)
    f = f_lo + (f_hi - f_lo) * np.exp(-t / 0.02)
    thump = sat(np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(t, tau, 0.0008), drive)
    cr = bp(noise(n), 2000, 6500, 2) * env_exp(t, 0.006, 0.0003) * crack
    body = bp(noise(n), 300, 1300) * env_exp(t, 0.04, 0.0005)
    return thump * 0.8 + cr * 0.9 + body * 0.6

def s_enemy_hit():
    d = 0.32
    x = _hit_core(d=d)
    tick = modal(0.08, [1850, 2930], [1, 0.6], [0.03, 0.02])
    place(x, tick, 0.0, 0.2)
    return x

def s_enemy_death():
    d = 0.75; t = tt(d); n = len(t)
    out = np.zeros(n)
    place(out, _hit_core(240, 120, 0.05, 2.5, 0.8, 0.3), 0, 0.7)
    f = exp_sweep(900, 230, n, 0.6)
    trem = 0.6 + 0.4 * np.sin(2 * np.pi * 28 * t)
    ph = 2 * np.pi * np.cumsum(f) / SR
    tone = (np.sin(ph) + 0.4 * np.sin(2 * ph) + 0.2 * np.sin(3.01 * ph)) * env_hump(t, 0.12, 1.2) * trem
    sw = svf(noise(n), exp_sweep(3200, 600, n), 2.5) * env_hump(t, 0.1, 1.5)
    k = 26; times = 0.03 + rng.exponential(0.12, k); times = times[times < d - 0.05]
    gr = grains(d, times, rng.uniform(1000, 4200, len(times)), rng.uniform(5, 12, len(times)),
                rng.uniform(0.2, 0.6, len(times)) * np.exp(-times / 0.25), 0.003)
    puff = bp(noise(n), 400, 1600) * env_hump(t, 0.2, 2.0) * 0.25
    return out + tone * 0.22 + sw * 0.45 + gr * 0.3 + puff

def s_player_hit():
    d = 0.5; t = tt(d); n = len(t)
    f = 85 + 85 * np.exp(-t / 0.025)
    thud = sat(np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(t, 0.09, 0.001), 4.0)
    body = lp(noise(n), 1200) * env_exp(t, 0.06, 0.0005)
    wood = modal(d, [240, 515, 830, 1340], [1, 0.7, 0.45, 0.25], [0.12, 0.08, 0.05, 0.03])
    cr = bp(noise(n), 1500, 4500) * env_exp(t, 0.01, 0.0003)
    fb = 1 - 0.08 * np.clip(t / 0.25, 0, 1)
    ph1 = 2 * np.pi * np.cumsum(440 * fb) / SR; ph2 = 2 * np.pi * np.cumsum(466.2 * fb) / SR
    sting = lp(sat(np.sin(ph1), 3) + sat(np.sin(ph2), 3), 2800, 2) * env_hump(t, 0.06, 1.3) * \
        np.clip((0.32 - t) / 0.1, 0, 1)
    x = thud * 0.7 + body * 0.5 + wood * 0.6 + cr * 0.6 + sting * 0.14
    return sat(x / np.max(np.abs(x)), 3.0)

def s_barrel_break():
    d = 0.9; t = tt(d); n = len(t)
    crack = hp(noise(n), 500) * env_exp(t, 0.008, 0.0002) + bp(noise(n), 1500, 5000) * env_exp(t, 0.015, 0.0002)
    body = sat(modal(d, [190, 410, 680, 1050, 1620], [1, 0.8, 0.55, 0.4, 0.25],
                     [0.08, 0.06, 0.045, 0.035, 0.025]), 1.8)
    k = 55; times = 0.004 + rng.exponential(0.11, k); times = times[times < d - 0.1]
    freqs = np.exp(rng.normal(np.log(1900), 0.5, len(times))).clip(700, 6000)
    spl = grains(d, times, freqs, rng.uniform(5, 15, len(times)),
                 rng.uniform(0.3, 1.0, len(times)) * np.exp(-times / 0.18), rng.choice([0.002, 0.004, 0.008]))
    hoop = modal(0.8, [620, 1711, 3348, 5518], [1, 0.6, 0.35, 0.2], [0.35, 0.22, 0.14, 0.09], detune=0.004)
    hoop2 = modal(0.7, [705, 1946, 3807], [1, 0.5, 0.3], [0.3, 0.2, 0.12], detune=0.004)
    deb_t = 0.25 + rng.uniform(0, 0.5, 10)
    deb = grains(d, deb_t, rng.uniform(600, 2500, 10), rng.uniform(4, 8, 10), rng.uniform(0.1, 0.25, 10), 0.006)
    out = crack * 0.9 + body * 0.6 + sat(spl, 2.5) * 0.55 + deb * 0.5
    out = sat(out / np.max(np.abs(out)), 3.0)
    place(out, hoop, 0.01, 0.12); place(out, hoop2, 0.14, 0.08)
    return out

def s_barrel_pickup():
    d = 0.55; t = tt(d); n = len(t)
    out = np.zeros(n)
    tonk = modal(0.2, [260, 590, 1020], [1, 0.6, 0.3], [0.05, 0.035, 0.02]) + \
        bp(noise(N(0.2)), 1500, 5000) * env_exp(tt(0.2), 0.004, 0.0002) * 0.5
    place(out, sat(tonk, 1.5), 0, 0.8)
    for i, m in enumerate([81, 86, 88]):           # A5, D6, E6 (Yo-Skala)
        f = midi_hz(m)
        mar = modal(0.35, [f, 4 * f, 9.9 * f], [1, 0.25, 0.06], [0.16, 0.05, 0.015], attack=0.001)
        place(out, mar, 0.06 + 0.07 * i, 0.35 + 0.08 * i)
    place(out, fm_bell(0.3, midi_hz(93), 1.41, 1.2, 0.05, 0.12), 0.22, 0.12)
    return out

def s_warning():
    d = 0.75; out = np.zeros(N(d))
    ka = modal(0.06, [1250, 2300, 3600], [1, 0.6, 0.3], [0.012, 0.008, 0.005]) + \
        bp(noise(N(0.06)), 2000, 6000) * env_exp(tt(0.06), 0.003, 0.0002) * 0.6
    don = taiko(0.6, 150, drive=4.0, stick=0.7, tau=0.2)
    chin = modal(0.5, [1760, 2740, 4410], [1, 0.5, 0.25], [0.16, 0.1, 0.06], detune=0.003)
    place(out, ka, 0.0, 0.35)
    place(out, don, 0.10, 0.9)
    place(out, chin, 0.10, 0.12)
    return out

def s_rope_snap():
    d = 0.8; t = tt(d); n = len(t)
    out = np.zeros(n)
    click = hp(noise(N(0.004)), 1000, 2) * np.hanning(N(0.004))
    place(out, click, 0.0, 1.0)
    k = 40; times = rng.uniform(0, 0.06, k)
    out += grains(d, times, rng.uniform(1000, 5000, k), rng.uniform(3, 8, k), rng.uniform(0.3, 0.8, k), 0.003) * 0.5
    f = 180 + 80 * np.exp(-t / 0.1)
    ph = 2 * np.pi * np.cumsum(f) / SR
    tw = sum(np.sin(k_ * ph) / k_ for k_ in range(1, 9)) * env_exp(t, 0.22, 0.002)
    out += sat(tw, 1.5) * 0.35
    out += svf(noise(n), exp_sweep(3000, 500, n, 0.7), 1.5) * env_hump(t, 0.12, 1.5) * 0.4
    return out

def s_ui_click():
    d = 0.07; t = tt(d)
    x = np.sin(2 * np.pi * 1650 * t) * env_exp(t, 0.012, 0.0005) + \
        0.4 * np.sin(2 * np.pi * 4300 * t) * env_exp(t, 0.005, 0.0003)
    x += hp(noise(len(t)), 3000) * env_exp(t, 0.0012, 0.0001) * 0.4
    return sat(x / np.max(np.abs(x)), 2.0)

def s_ui_confirm():
    d = 0.4; out = np.zeros(N(d))
    for i, m in enumerate([76, 81]):  # E5 -> A5 (Quarte aufwärts)
        f = midi_hz(m)
        tone = modal(0.33, [f, 3 * f, 4.2 * f], [1, 0.18, 0.08], [0.17, 0.06, 0.04], attack=0.002)
        place(out, tone, 0.07 * i, 0.7 + 0.15 * i)
    return out

def s_score_pickup():
    d = 0.42; out = np.zeros(N(d))
    place(out, fm_bell(0.4, midi_hz(88), 1.4, 1.8, 0.05, 0.16), 0, 0.8)        # E6
    place(out, fm_bell(0.36, midi_hz(95), 1.4, 1.2, 0.04, 0.14), 0.045, 0.45)  # B6
    return out

IR_SHORT = None
def ir_short():
    global IR_SHORT
    if IR_SHORT is None:
        IR_SHORT = make_ir(1.6, 0.35, 0.18, stereo=False, seed_off=1,
                           early=[(0.031, 0.5), (0.057, 0.35), (0.083, 0.25)])
    return IR_SHORT

def s_game_over():
    d = 2.6; out = np.zeros(N(d))
    # In-Skala auf E (E F A B C), absteigend: C5 B4 A4 F4 -> E4/E3
    notes = [(0.00, 72), (0.24, 71), (0.48, 69), (0.76, 65)]
    for t0, m in notes:
        place(out, ks_pluck(midi_hz(m), 1.4, t60=1.3, bright=0.32), t0, 0.6)
    place(out, ks_pluck(midi_hz(64), 1.6, t60=1.6, bright=0.3), 1.1, 0.55)
    place(out, ks_pluck(midi_hz(52), 1.5, t60=1.4, bright=0.4, pos=0.25), 1.1, 0.45)
    fl = flute(midi_hz(64), 1.45, bend=1.0, bend_tau=0.12, vib=0.007, breath=0.15, attack=0.12, release=0.5)
    place(out, fl, 1.1, 0.4)
    place(out, taiko(0.6, 115, drive=2.0, stick=0.2, tau=0.25), 1.1, 0.35)
    y = reverb(out, ir_short(), wet=0.28)[:N(d)]
    return y

def s_new_highscore():
    d = 1.9; out = np.zeros(N(d))
    # Yo-Skala auf D (D E G A B), aufsteigend
    for i, m in enumerate([74, 76, 79, 81, 83, 86]):
        place(out, ks_pluck(midi_hz(m), 1.0, t60=1.0, bright=0.45), 0.065 * i, 0.4 + 0.04 * i)
    place(out, taiko(0.5, 135, drive=2.5, stick=0.4, tau=0.2), 0.39, 0.5)
    place(out, fm_bell(1.2, midi_hz(86), 1.41, 1.5, 0.08, 0.4), 0.39, 0.35)
    place(out, fm_bell(1.0, midi_hz(93), 1.41, 1.0, 0.06, 0.3), 0.45, 0.22)
    for k in range(6):
        m = rng.choice([86, 88, 91, 93, 95, 98])
        place(out, fm_bell(0.5, midi_hz(m), 1.4, 0.8, 0.03, 0.12), 0.55 + 0.11 * k, 0.12 * (1 - k / 7))
    y = reverb(out, ir_short(), wet=0.3)[:N(d)]
    return y

# ----------------------------------------------------------------- Loops
def s_rope_cutting_loop():
    L = N(1.5); buf = np.zeros(L)
    fric = circ_noise(L, 1200, 4000) * 0.05
    period = 0.25
    for k in range(6):
        t0 = k * period + rng.uniform(-0.012, 0.012)
        snip = modal(0.06, [3200, 4700, 6100], [1, 0.6, 0.3], [0.015, 0.01, 0.006], attack=0.0005)
        circ_place(buf, snip, t0, 0.35)
        tn = tt(0.07)
        tear = bp(noise(len(tn)), 1500, 4200) * env_hump(tn, 0.02, 1.5) * \
            (0.5 + 0.5 * (rng.random(len(tn)) > 0.6))
        circ_place(buf, tear, t0 + 0.005, 0.5)
        nf = 4; tf = t0 + 0.01 + rng.uniform(0, 0.05, nf)
        for tq in tf:
            gr = grains(0.03, [0], [rng.uniform(1800, 4500)], [8], [1], 0.002)
            circ_place(buf, gr, tq, rng.uniform(0.15, 0.3))
    return buf + fric

def s_ambience_well_loop():
    Ls = 24.0; L = N(Ls); t = np.arange(L) / SR
    def lfo(k, ph): return 0.5 + 0.5 * np.sin(2 * np.pi * k * t / Ls + ph)
    w = circ_noise(L, 120, 900, slope_db_oct=-3, ch=2)
    w = 0.75 * w + 0.25 * w[:, ::-1]                       # Korrelation L/R
    gust = (0.35 + 0.65 * lfo(2, 0.3) * (0.6 + 0.4 * lfo(5, 1.7)))[:, None]
    wind = w * gust * 0.5
    wh = circ_noise(L, 480, 560, ch=2) * 0.08 * lfo(3, 2.2)[:, None] ** 2 + \
        circ_noise(L, 760, 820, ch=2) * 0.05 * lfo(4, 0.5)[:, None] ** 2
    hum = circ_noise(L, 130, 300, ch=2) * 0.12
    drops = np.zeros((L, 2))
    tpos = np.sort(rng.uniform(0, Ls, 7))
    for t0 in tpos:
        f0 = rng.uniform(1100, 2300); td = tt(0.09)
        f = f0 * (1 + 0.5 * (1 - np.exp(-td / 0.012)))
        dr = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(td, 0.025, 0.0008)
        dr += bp(noise(len(td)), 2000, 7000) * env_exp(td, 0.002, 0.0001) * 0.3
        st = pan(dr, rng.uniform(-0.7, 0.7)) * rng.uniform(0.5, 1.0)
        for c in range(2): circ_place(drops[:, c], st[:, c], t0)
    ir = make_ir(4.5, 1.2, 0.45, xover=1800, seed_off=2,
                 early=[(0.11, 0.6), (0.22, 0.4), (0.33, 0.25), (0.44, 0.15)], predelay=0.02)
    wet = circ_conv(drops, ir)
    wind_wet = circ_conv(wind + wh, ir)
    return wind * 0.6 + wind_wet * 0.5 + wh * 0.7 + hum * 0.6 + drops * 0.5 + wet * 0.9

# Gemeinsames Material aller drei Musik-Stufen: In-Skala auf D (D Eb G A Bb),
# Bass-Zyklus D D Bb A, Kernmotiv "A-Bb-A-G-D" (m1) und Antwort (m2).
OST = {
    'D1': [(0, 62), (2, 69), (3, 74), (5, 69), (6, 67)],
    'D2': [(0, 62), (2, 69), (3, 70), (5, 69), (7, 67)],
    'Bb': [(0, 58), (2, 67), (3, 74), (5, 69), (6, 67)],
    'A':  [(0, 57), (2, 62), (3, 67), (5, 69), (6, 75), (7, 74)],
}
CYC = ['D1', 'D2', 'Bb', 'A']
ROOT = {'D1': 50, 'D2': 50, 'Bb': 46, 'A': 45}
FIFTH = {'D1': 57, 'D2': 57, 'Bb': 50, 'A': 50}
M1 = [(0, 69, 3), (3, 70, 1), (4, 69, 2), (6, 67, 2), (8, 62, 4), (12, 63, 1), (13, 62, 3),
      (16, 67, 2), (18, 69, 2), (20, 74, 3), (23, 75, 1), (24, 74, 2), (26, 70, 2), (28, 69, 3.5)]
M2 = [(0, 74, 2), (2, 75, 1), (3, 74, 1), (4, 70, 4), (8, 69, 2), (10, 67, 2), (12, 69, 4),
      (16, 62, 2), (18, 63, 1), (19, 62, 1), (20, 67, 3), (23, 69, 1), (24, 62, 6)]

class Band:
    """Hilfsklasse: legt Noten in Stereo-Spuren ab, faltet Nachklang an den Loop-Anfang."""
    def __init__(self, bpm, bars):
        self.beat = 60 / bpm; self.bar = 4 * self.beat; self.bars = bars
        self.Ls = bars * self.bar; self.L = N(self.Ls); self.TAIL = N(4.0)
        self.lanes = {k: np.zeros((self.L + self.TAIL, 2)) for k in ('koto', 'sham', 'bass', 'fl', 'perc', 'bell')}
    def h(self): return rng.uniform(-0.007, 0.007)
    def put(self, lane, x, t, g, p):
        t = t % self.Ls
        place(self.lanes[lane], pan(x, p), t, g)
    def koto(self, m, t, v, t60=2.2, bright=0.35, dur=2.4):
        self.put('koto', ks_pluck(midi_hz(m), dur, t60=t60, bright=bright, pos=rng.uniform(0.12, 0.25)), t + self.h(), v, -0.3)
    def sham(self, m, t, v):
        x = ks_pluck(midi_hz(m), 0.6, t60=0.35, bright=0.65, pos=0.08)
        x = lp(sat(x * 1.3, 2.0), 5500, 2)                       # "Sawari"-Schnarren, Höhen gezähmt
        x += bp(noise(len(x)), 1500, 4000) * env_exp(tt(0.6), 0.004, 0.0002) * 0.25   # Plektrum (Bachi)
        self.put('sham', endfade(x, 0.03), t + self.h(), v, 0.25)
    def bass(self, m, t, v, t60=1.2):
        self.put('bass', ks_pluck(midi_hz(m), 1.6, t60=t60, bright=0.6, pos=0.1), t + self.h(), v, 0.1)
    def don(self, t, v, f0=110):
        self.put('perc', taiko(0.7, f0, drive=2.2, stick=0.25, tau=0.28), t + self.h(), v, 0.0)
    def shime(self, t, v):
        self.put('perc', taiko(0.25, 185, drive=1.8, stick=0.6, tau=0.07), t + self.h(), v, -0.15)
    def ka(self, t, v):
        x = modal(0.05, [1250, 2300], [1, 0.5], [0.012, 0.007])
        self.put('perc', x, t + self.h(), v, 0.35)
    def bell(self, t, m, v):
        self.put('bell', fm_bell(3.0, midi_hz(m), 1.41, 1.2, 0.1, 1.0), t, v, rng.uniform(-0.4, 0.4))
    def flute(self, mel, bar0, v, staccato=0.95, koto_double=False):
        for sb, m, dur_b in mel:
            dur = dur_b * self.beat * staccato
            t0 = bar0 * self.bar + sb * self.beat + self.h()
            if koto_double:
                self.koto(m + 12 if m < 70 else m, t0, v * 1.2, t60=1.6, bright=0.3)
                continue
            bend = rng.choice([-1.0, -0.6, 0.0]) if dur_b >= 2 else 0.0
            x = flute(midi_hz(m), dur + 0.25, bend=bend, bend_tau=0.1, vib=0.006, breath=0.14,
                      attack=min(0.12, 0.09 + 0.03 * (dur_b > 2)), release=min(0.4, dur * 0.4), chiff=0.35)
            self.put('fl', x, t0, v, 0.05)
    def mix(self, levels, sends, ir_dur=3.0, drone=0.035):
        L = self.L; t = np.arange(L) / SR
        out = {}
        for k, x in self.lanes.items():
            y = x[:L].copy(); y[:self.TAIL] += x[L:L + self.TAIL]; out[k] = y
        dr = np.zeros(L)
        for f, a in ((midi_hz(50), 1.0), (midi_hz(57), 0.7), (midi_hz(62), 0.35)):
            f = round(f * self.Ls) / self.Ls          # ganzzahlige Perioden pro Loop -> nahtlos
            ph = rng.uniform(0, 2 * np.pi)
            dr += a * (np.sin(2 * np.pi * f * t + ph) + 0.3 * np.sin(4 * np.pi * f * t + ph) + 0.12 * np.sin(6 * np.pi * f * t))
        dr *= (0.6 + 0.4 * np.sin(2 * np.pi * 3 * t / self.Ls))
        out['drone'] = np.stack([dr, dr], 1) * drone
        ir = make_ir(ir_dur, 0.8, 0.35, seed_off=3, early=[(0.023, 0.4), (0.041, 0.3), (0.067, 0.2)])
        dry = sum(levels.get(k, 1.0) * v for k, v in out.items())
        send = sum(sends.get(k, 0.0) * v for k, v in out.items())
        return dry + circ_conv(send, ir)

def s_music_calm_loop():
    """75 BPM, 24 Takte (76,8 s): spärlich, Koto + Flöte, kaum Percussion."""
    B = Band(75, 24)
    for b in range(B.bars):
        sec = b // 8; key = CYC[b % 4]; tb = b * B.bar
        for e, m in OST[key]:
            if sec != 1 and e not in (0, 2, 3, 5): continue
            if sec == 2 and b % 2 == 1 and e == 3: continue
            B.koto(m, tb + e * B.beat / 2, 0.45 + 0.12 * (e == 0) + rng.uniform(-0.05, 0.05))
        B.bass(ROOT[key], tb, 0.45, t60=1.6)
        if b % 4 == 0: B.don(tb, 0.16)
        if b % 8 == 0: B.bell(tb, 79, 0.12)
    B.flute(M1, 8, 0.32)
    B.flute(M2, 16, 0.3)
    return B.mix(dict(koto=0.9, bass=0.8, fl=1.0, perc=0.8, bell=1.0),
                 dict(koto=0.4, bass=0.15, fl=0.5, perc=0.3, bell=0.6, drone=0.3), drone=0.04)

def s_music_mid_loop():
    """100 BPM, 32 Takte (76,8 s): Shamisen-Puls, leichte Taiko, Motiv auf Flöte/Koto."""
    B = Band(100, 32)
    for b in range(B.bars):
        sec = b // 8; key = CYC[b % 4]; tb = b * B.bar
        r, fi = ROOT[key], FIFTH[key]
        pat = [r + 12, r + 12, fi + 12 if fi < 55 else fi, r + 12, r + 12, fi + 12 if fi < 55 else fi, r + 24, r + 12]
        for e, m in enumerate(pat):
            acc = 0.55 if e in (0, 4) else (0.3 if e % 2 == 0 else 0.22)
            B.sham(m, tb + e * B.beat / 2, acc)
        if sec >= 1:
            for e, m in OST[key]:
                if sec == 3 and e in (3, 7): continue
                B.koto(m, tb + e * B.beat / 2, 0.32 + 0.08 * (e == 0), t60=1.6)
        B.bass(r, tb, 0.5, t60=1.0)
        B.don(tb, 0.38)
        if sec >= 1: B.don(tb + 2 * B.beat, 0.26, 116)
        for e in (3, 7):
            B.ka(tb + e * B.beat / 2, 0.05 if sec else 0.03)
        if b % 8 == 0: B.bell(tb, 79, 0.1)
    B.flute(M1, 8, 0.3)
    B.flute(M1, 16, 0.28, koto_double=True)
    B.flute(M2, 24, 0.3)
    return B.mix(dict(koto=0.85, sham=0.75, bass=0.75, fl=1.0, perc=0.85, bell=1.0),
                 dict(koto=0.3, sham=0.12, bass=0.1, fl=0.42, perc=0.22, bell=0.6, drone=0.3), ir_dur=2.5, drone=0.03)

def s_music_fast_loop():
    """135 BPM, 40 Takte (~71,1 s): treibende Taiko, Shamisen-Achtel, Motiv – aber nicht schrill."""
    B = Band(135, 40)
    for b in range(B.bars):
        sec = b // 8; key = CYC[b % 4]; tb = b * B.bar
        r, fi = ROOT[key], FIFTH[key]
        pat = [r + 12, r + 24, fi + 12 if fi < 55 else fi, r + 24, r + 12, fi + 12 if fi < 55 else fi, r + 24, fi + 12 if fi < 55 else fi]
        for e, m in enumerate(pat):
            acc = 0.5 if e in (0, 3, 6) else 0.26
            B.sham(m, tb + e * B.beat / 2, acc)
        B.bass(r, tb, 0.5, t60=0.8)
        B.bass(r, tb + 2 * B.beat, 0.35, t60=0.6)
        # Taiko: Don auf 1, 2+, 3, (4 in Teilen B/D); Shime-Daiko Achtel; Ka auf Offbeats
        B.don(tb, 0.48)
        B.don(tb + 2 * B.beat, 0.4, 116)
        if sec >= 1: B.don(tb + 1.5 * B.beat, 0.3, 120)
        if sec in (1, 3) and b % 2 == 1: B.don(tb + 3.5 * B.beat, 0.3, 124)
        for e in range(8):
            B.shime(tb + e * B.beat / 2, (0.12 if e % 2 == 0 else 0.07) * (1.0 if sec else 0.7))
        for e in (3, 7): B.ka(tb + e * B.beat / 2, 0.05)
        if sec in (1, 2, 3):
            for e, m in OST[key]:
                B.koto(m, tb + e * B.beat / 2, 0.28, t60=1.1, bright=0.3, dur=1.4)
        if b % 8 == 0: B.bell(tb, 79, 0.09)
    B.flute(M1, 8, 0.3, staccato=0.9)
    B.flute(M1, 16, 0.26, koto_double=True)
    B.flute(M2, 24, 0.3, staccato=0.9)
    B.flute(M2, 32, 0.24, koto_double=True)
    return B.mix(dict(koto=0.8, sham=0.7, bass=0.8, fl=1.0, perc=0.9, bell=1.0),
                 dict(koto=0.25, sham=0.1, bass=0.08, fl=0.38, perc=0.18, bell=0.5, drone=0.25), ir_dur=2.0, drone=0.025)

# ----------------------------------------------------------------- Mastering / Messung
METER = pyln.Meter(SR)

def lufs_integrated(x):
    if len(x) < N(0.4):
        x = np.concatenate([x, np.zeros((N(0.4) - len(x),) + x.shape[1:])])
    v = METER.integrated_loudness(x)
    return float(v)

def lufs_momentary_max(x):
    w = N(0.4); hop = N(0.05)
    if len(x) < w:
        x = np.concatenate([x, np.zeros((w - len(x),) + x.shape[1:])])
    best = -np.inf
    for i in range(0, len(x) - w + 1, hop):
        v = METER.integrated_loudness(x[i:i + w])
        best = max(best, v)
    return float(best)

def true_peak_db(x):
    xs = x if x.ndim == 2 else x[:, None]
    up = signal.resample_poly(xs, 4, 1, axis=0)
    return 20 * np.log10(np.max(np.abs(up)) + 1e-12)

def limiter(x, ceil_db):
    c = 10 ** (ceil_db / 20)
    a = np.max(np.abs(x), axis=1) if x.ndim == 2 else np.abs(x)
    req = np.minimum(1.0, c / np.maximum(a, 1e-12))
    w = N(0.003)
    g = minimum_filter1d(req, 2 * w + 1)
    g = uniform_filter1d(g, w)
    g = np.minimum(g, req)
    gr = -20 * np.log10(np.min(g))
    return (x.T * g).T if x.ndim == 2 else x * g, gr

def master(x, target, mode, loop):
    hpf = LOOP_HPF if loop else SFX_HPF
    filt = (lambda z: hp(z, hpf, 4))
    x = loop_safe(filt, x) if loop else filt(x)
    if not loop:
        x = fades(x, 0.002, min(0.08, 0.12 * len(x) / SR))
    meas = lufs_integrated if mode == 'int' else lufs_momentary_max
    gain_db = target - meas(x)
    lim = (lambda z: limiter(z, TP_CEIL_DB - 0.3)[0])
    for _ in range(8):
        _, gr = limiter(x * 10 ** (gain_db / 20), TP_CEIL_DB - 0.3)
        if gr <= MAX_GR_DB + 0.05: break
        gain_db -= (gr - MAX_GR_DB)
    y = x * 10 ** (gain_db / 20)
    y = loop_safe(lim, y) if loop else lim(y)
    tp = true_peak_db(y)
    if tp > TP_CEIL_DB:
        y = y * 10 ** ((TP_CEIL_DB - tp) / 20)
    return y, gr

def analyze(x, loop):
    mono = x.mean(axis=1) if x.ndim == 2 else x
    spec = np.abs(np.fft.rfft(mono * np.hanning(len(mono)))) ** 2
    f = np.fft.rfftfreq(len(mono), 1 / SR)
    low = spec[f < 80].sum() / spec.sum()
    cent = (f * spec).sum() / spec.sum()
    res = dict(
        duration_s=round(len(x) / SR, 3),
        channels=1 if x.ndim == 1 else 2,
        sample_peak_dbfs=round(float(20 * np.log10(np.max(np.abs(x)) + 1e-12)), 2),
        true_peak_dbtp=round(float(true_peak_db(x)), 2),
        lufs_integrated=round(lufs_integrated(x), 1),
        lufs_momentary_max=round(lufs_momentary_max(x), 1),
        rms_dbfs=round(float(20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-12)), 1),
        energy_below_80hz_pct=round(float(100 * low), 3),
        spectral_centroid_hz=int(cent),
        nan_or_inf=bool(~np.all(np.isfinite(x))),
        clipped_samples=int(np.sum(np.abs(x) >= 0.999)),
    )
    if loop:
        d = np.abs(np.diff(mono))
        seam = abs(mono[0] - mono[-1])
        res['loop_seam_jump_vs_p99_diff'] = round(float(seam / (np.percentile(d, 99) + 1e-12)), 3)
    else:
        res['start_abs'] = round(float(np.max(np.abs(x[:2]))), 6)
        res['end_abs'] = round(float(np.max(np.abs(x[-2:]))), 6)
    return res

def plot(name, x, info, path):
    import matplotlib; matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    mono = x.mean(axis=1) if x.ndim == 2 else x
    t = np.arange(len(mono)) / SR
    fig, ax = plt.subplots(2, 1, figsize=(9, 5.2), gridspec_kw=dict(height_ratios=[1, 2.2]))
    ax[0].plot(t, mono, lw=0.5, color='#12304A'); ax[0].set_xlim(0, t[-1]); ax[0].set_ylim(-1, 1)
    ax[0].set_title(f"{name}  |  {info['duration_s']} s  |  TP {info['true_peak_dbtp']} dBTP  |  "
                    f"M-max {info['lufs_momentary_max']} LUFS  |  I {info['lufs_integrated']} LUFS", fontsize=9)
    nfft = 2048 if len(mono) > 20000 else 512
    ax[1].specgram(mono + 1e-9, NFFT=nfft, Fs=SR, noverlap=nfft * 3 // 4, cmap='magma', vmin=-130, vmax=-20)
    ax[1].set_ylim(0, 16000); ax[1].set_ylabel('Hz'); ax[1].set_xlabel('s')
    ax[1].axhline(80, color='cyan', lw=0.6, ls='--')
    fig.tight_layout(); fig.savefig(path, dpi=80); plt.close(fig)

# ----------------------------------------------------------------- Katalog
# name, fn, loop, mode(int/mom), target LUFS, empf. Lautstärke, Beschreibung
SOUNDS = [
    ("swipe", s_swipe, False, 'mom', -16, 0.55, "Wischgeste: kurzes, aufsteigendes Luftrauschen"),
    ("rope_retract", s_rope_retract, False, 'mom', -16, 0.5, "Seil einziehen: Reibung/Fasern steigend, kleiner Holz-Stopp"),
    ("rope_extend", s_rope_extend, False, 'mom', -16, 0.5, "Seil verlängern: Reibung fallend, kurze Spannungs-Knarz am Ende"),
    ("rope_creak", s_rope_creak, False, 'mom', -17, 0.4, "Seil knarzt/spannt sich (Stick-Slip-Reibung)"),
    ("sword_slash", s_sword_slash, False, 'mom', -14, 0.9, "Katana-Hieb: Whoosh + metallisches 'Shing'"),
    ("enemy_hit", s_enemy_hit, False, 'mom', -14, 0.85, "Treffer am Gegner: dumpfer Schlag + Knack"),
    ("enemy_death", s_enemy_death, False, 'mom', -15, 0.8, "Gegner besiegt: Treffer + absteigendes Zerfallen/Krümel"),
    ("player_hit", s_player_hit, False, 'mom', -14, 0.9, "Spieler/Fass getroffen: Holz-Wumms + dissonanter Stich"),
    ("barrel_break", s_barrel_break, False, 'mom', -14, 0.85, "Holzfass zerplatzt: Krachen, Splitter, Eisenreifen"),
    ("barrel_pickup", s_barrel_pickup, False, 'mom', -16, 0.7, "Fass wieder aufgenommen: Holz-'Tonk' + aufsteigende Marimba"),
    ("warning", s_warning, False, 'mom', -15, 0.75, "Telegraph/Gefahr: Taiko 'ka-DON' + leiser Gong-Glanz"),
    ("rope_cutting_loop", s_rope_cutting_loop, True, 'int', -18, 0.55, "Seilschneider schneidet (nahtloser Loop, 1,5 s)"),
    ("rope_snap", s_rope_snap, False, 'mom', -15, 0.85, "Seil reißt: Knall, Fasern, Rückschnell-Twang, Whoosh"),
    ("ui_click", s_ui_click, False, 'mom', -17, 0.5, "UI-Klick: kurzer Holzblock"),
    ("ui_confirm", s_ui_confirm, False, 'mom', -16, 0.6, "UI-Bestätigung: zwei Töne aufwärts (E5-A5)"),
    ("score_pickup", s_score_pickup, False, 'mom', -16, 0.45, "Punkte/Pickup: glockiges 'Ting-ting' (E6-B6)"),
    ("game_over", s_game_over, False, 'mom', -15, 0.8, "Game Over: absteigende In-Skala, Koto + Shakuhachi"),
    ("new_highscore", s_new_highscore, False, 'mom', -15, 0.8, "Neuer Highscore: aufsteigende Yo-Skala, Taiko, Glocken"),
    ("ambience_well_loop", s_ambience_well_loop, True, 'int', -24, 0.6, "Brunnen-Atmo: Wind, Tropfen, tiefer Hall (24 s Loop, stereo)"),
    ("music_calm_loop", s_music_calm_loop, True, 'int', -18, 0.5, "Musik Stufe 1 (ruhig): 75 BPM, Koto + Shakuhachi, kaum Percussion (76,8 s Loop, stereo)"),
    ("music_mid_loop", s_music_mid_loop, True, 'int', -18, 0.5, "Musik Stufe 2 (mittel): 100 BPM, Shamisen-Puls, leichte Taiko (76,8 s Loop, stereo)"),
    ("music_fast_loop", s_music_fast_loop, True, 'int', -18, 0.5, "Musik Stufe 3 (schnell): 135 BPM, treibende Taiko, Shamisen, Motiv (71,1 s Loop, stereo)"),
]

CAP_TO_SLASH = ('warning', 'game_over', 'new_highscore', 'player_hit', 'rope_snap')

ENC = {
    'sfx':   dict(ogg=['-q:a', '4'], m4a=['-b:a', '96k'], mp3=['-b:a', '80k']),
    'amb':   dict(ogg=['-q:a', '2'], m4a=['-b:a', '96k'], mp3=['-b:a', '96k']),
    'music': dict(ogg=['-q:a', '2'], m4a=['-b:a', '96k'], mp3=['-b:a', '96k']),
}
CODEC = dict(ogg=['-c:a', 'libvorbis'], m4a=['-c:a', 'aac', '-movflags', '+faststart'], mp3=['-c:a', 'libmp3lame'])

def encode(wav, out, fmt, prof, override=None):
    cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-map_metadata', '-1'] + CODEC[fmt] + (override or ENC[prof][fmt])
    if fmt == 'mp3': cmd += ['-write_xing', '1']
    subprocess.run(cmd + [out], check=True)

def decoded_peak(path):
    r = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', path, '-f', 'f32le', '-acodec', 'pcm_f32le', '-'],
                       capture_output=True, check=True)
    a = np.frombuffer(r.stdout, dtype=np.float32)
    return float(round(20 * np.log10(np.max(np.abs(a)) + 1e-12), 2)), round(len(a) / SR, 3)

def main():
    global rng
    ap = argparse.ArgumentParser()
    ap.add_argument('--audio-dir', default='/workspace/barrel-ninja/audio')
    ap.add_argument('--work-dir', default='/workspace/barrel-ninja-sfx')
    ap.add_argument('--no-plots', action='store_true')
    ap.add_argument('--only', nargs='*')
    a = ap.parse_args()
    for sub in ('wav', 'ogg', 'analysis'): os.makedirs(os.path.join(a.work_dir, sub), exist_ok=True)
    os.makedirs(a.audio_dir, exist_ok=True)
    report = {}
    mpath = os.path.join(a.work_dir, 'analysis', 'measurements.json')
    if a.only and os.path.exists(mpath):
        report = json.load(open(mpath))
    for idx, (name, fn, loop, mode, target, vol, desc) in enumerate(SOUNDS):
        if a.only and name not in a.only: continue
        rng = np.random.default_rng(SEED + zlib.crc32(name.encode()) % 100000)
        if name in CAP_TO_SLASH and 'sword_slash' in report:
            target = min(target, report['sword_slash']['lufs_momentary_max'] - 0.5)
        x = fn().astype(np.float64)
        y, gr = master(x, target, mode, loop)
        info = analyze(y, loop)
        info.update(target_lufs=target, measure='integrated' if mode == 'int' else 'momentary_max',
                    limiter_gr_db=round(float(gr), 2), loop=loop, volume=vol, desc=desc)
        wav = os.path.join(a.work_dir, 'wav', name + '.wav')
        prof = 'music' if name.startswith('music') else ('amb' if name.startswith('ambience') else 'sfx')
        info['codec_trim_db'] = 0.0
        for attempt in range(5):
            sf.write(wav, y.astype(np.float32), SR, subtype='PCM_24')
            info['files'] = {}
            worst = -99
            src_pk = 20 * np.log10(np.max(np.abs(y)) + 1e-12)
            for fmt in ('ogg', 'm4a', 'mp3'):
                out = os.path.join(a.audio_dir, f'{name}.{fmt}')
                encode(wav, out, fmt, prof)
                pk, dur = decoded_peak(out)
                if fmt == 'm4a':
                    # nativer AAC-Encoder schwingt bei manchen Transienten über -> Bitrate anheben
                    for br in ('128k', '160k'):
                        if pk - src_pk <= 0.8: break
                        encode(wav, out, fmt, prof, override=['-b:a', br])
                        pk, dur = decoded_peak(out)
                worst = max(worst, pk)
                info['files'][fmt] = dict(bytes=os.path.getsize(out), decoded_peak_dbfs=pk, decoded_len_s=dur)
            if worst <= -1.0: break
            trim = -1.1 - worst
            y = y * 10 ** (trim / 20); info['codec_trim_db'] = round(info['codec_trim_db'] + trim, 2)
        info.update(analyze(y, loop))
        shutil.copy2(os.path.join(a.audio_dir, name + '.ogg'), os.path.join(a.work_dir, 'ogg', name + '.ogg'))
        if not a.no_plots:
            plot(name, y, info, os.path.join(a.work_dir, 'analysis', name + '.png'))
        report[name] = info
        print(f"{name:20s} {info['duration_s']:6.2f}s  TP {info['true_peak_dbtp']:6.2f}  "
              f"M {info['lufs_momentary_max']:6.1f}  I {info['lufs_integrated']:6.1f}  GR {gr:4.1f}  "
              f"<80Hz {info['energy_below_80hz_pct']:.3f}% trim {info['codec_trim_db']}  "
              + ' '.join(f"{k}:{v['bytes'] // 1024}k/{v['decoded_peak_dbfs']}" for k, v in info['files'].items()))
        sys.stdout.flush()
    json.dump(report, open(mpath, 'w'), indent=1, ensure_ascii=False)
    write_docs(report, a.audio_dir, a.work_dir)
    shutil.copy2(os.path.abspath(__file__), os.path.join(a.work_dir, 'generate.py'))

# ----------------------------------------------------------------- Doku, Vorschau, Lizenz
GAME_MAP = [  # bisherige Namen im Audio-Manager (index.html) -> neue Datei
    ('swipe', 'swipe'), ('slash', 'sword_slash'), ('kill', 'enemy_death'), ('warn', 'warning'),
    ('barrelBreak', 'barrel_break'), ('pickup', 'score_pickup'), ('ropeSnap', 'rope_snap'),
    ('gameOver', 'game_over'), ('uiClick', 'ui_click'), ('music', 'music_calm_loop'),
]

def fmt_kb(b): return f"{b / 1024:.0f} KB" if b < 1024 * 1024 else f"{b / 1048576:.2f} MB"

def write_docs(report, audio_dir, work_dir):
    names = [n for n, *_ in SOUNDS if n in report]
    # --- Vorschlag manifest
    files = {g: dict(src=f"{n}.m4a", volume=report[n]['volume']) for g, n in GAME_MAP if n in report}
    sugg = {"_info": "VORSCHLAG (nicht aktiv). Zum Aktivieren den Block 'files' nach manifest.json übernehmen. "
                     "m4a läuft auf iOS, Android und Desktop; .ogg/.mp3 liegen als Alternativen daneben. "
                     "cutTick bleibt beim Synth-Fallback (rope_cutting_loop ist ein Loop, kein Einzel-Tick).",
            "files": files,
            "extra_sounds_need_code_hooks": {n: dict(src=f"{n}.m4a", volume=report[n]['volume'],
                                                      loop=report[n]['loop'],
                                                      loopEnd_s=report[n]['duration_s'] if report[n]['loop'] else None)
                                             for n in names if n not in dict((v, k) for k, v in GAME_MAP)}}
    json.dump(sugg, open(os.path.join(audio_dir, 'manifest.suggested.json'), 'w'), indent=1, ensure_ascii=False)
    # --- sounds.json (Metadaten für Code)
    meta = {n: dict(duration_s=report[n]['duration_s'], loop=report[n]['loop'], volume=report[n]['volume'],
                    lufs=report[n]['lufs_integrated'] if report[n]['loop'] else report[n]['lufs_momentary_max'],
                    true_peak_dbtp=report[n]['true_peak_dbtp'], desc=report[n]['desc']) for n in names}
    json.dump(meta, open(os.path.join(audio_dir, 'sounds.json'), 'w'), indent=1, ensure_ascii=False)
    # --- Tabelle
    rows = []
    for n in names:
        r = report[n]; f = r['files']
        lu = f"{r['lufs_integrated']} (I)" if r['loop'] else f"{r['lufs_momentary_max']} (M)"
        rows.append(f"| `{n}` | {r['duration_s']:.2f} s | {'ja' if r['loop'] else '–'} | {r['desc']} | {lu} | "
                    f"{r['true_peak_dbtp']} | **{r['volume']}** | {fmt_kb(f['ogg']['bytes'])} / {fmt_kb(f['m4a']['bytes'])} / {fmt_kb(f['mp3']['bytes'])} |")
    table = "\n".join(rows)
    loop_ends = ",\n".join(f"  {n}: {report[n]['duration_s']}" for n in names if report[n]['loop'])
    readme = README_TPL.replace('@@TABLE@@', table).replace('@@LOOPENDS@@', loop_ends) \
        .replace('@@MAP@@', "\n".join(f"| `{g}` | `{n}` |" for g, n in GAME_MAP)) \
        .replace('@@SEED@@', str(SEED))
    open(os.path.join(audio_dir, 'README.md'), 'w').write(readme)
    open(os.path.join(audio_dir, 'LICENSES.md'), 'w').write(LICENSE_TXT)
    html = PREVIEW_TPL.replace('@@DATA@@', json.dumps(meta, ensure_ascii=False))
    open(os.path.join(audio_dir, 'preview.html'), 'w').write(html)
    # Arbeitsordner: Messwerttabelle
    mrows = ["| Name | Dauer s | Kanäle | Sample-Peak dBFS | True-Peak dBTP | LUFS M-max | LUFS I | Limiter GR dB | <80 Hz % | Centroid Hz | NaN | Clip | Loop-Naht | Peak dekodiert ogg/m4a/mp3 |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for n in names:
        r = report[n]; f = r['files']
        mrows.append(f"| {n} | {r['duration_s']} | {r['channels']} | {r['sample_peak_dbfs']} | {r['true_peak_dbtp']} | "
                     f"{r['lufs_momentary_max']} | {r['lufs_integrated']} | {r['limiter_gr_db']} | {r['energy_below_80hz_pct']} | "
                     f"{r['spectral_centroid_hz']} | {r['nan_or_inf']} | {r['clipped_samples']} | "
                     f"{r.get('loop_seam_jump_vs_p99_diff', '–')} | {f['ogg']['decoded_peak_dbfs']} / {f['m4a']['decoded_peak_dbfs']} / {f['mp3']['decoded_peak_dbfs']} |")
    open(os.path.join(work_dir, 'analysis', 'measurements.md'), 'w').write(
        "# Messwerte (automatisch erzeugt)\n\nM-max = max. Momentary-Loudness (400 ms), I = Integrated (EBU R128 / BS.1770). "
        "Loop-Naht = Sprung am Loop-Punkt relativ zum 99. Perzentil der Sample-Differenzen (<1 = unauffällig).\n\n"
        + "\n".join(mrows) + "\n")

README_TPL = r'''# Barrel Ninja – Audio (Soundeffekte, Atmo, Musik)

Alle Klänge wurden **komplett per Code synthetisiert** (`generate.py`, fester Seed `@@SEED@@`).
Keine Samples, keine fremden Aufnahmen, keine Anlehnung an Battletoads oder andere Spiele.
Urheber: **Oruci Sabahudin**, frei verwendbar (siehe `LICENSES.md`).

Stimmung nach `concepts/art-direction.md`: nächtlicher, uralter Steinbrunnen, Mondlicht, Laternen –
ruhig-mystisch, Action knackig. Japanische Färbung über In-/Yo-Pentatonik, Koto/Shamisen (Karplus-Strong),
Shakuhachi-artige Flöte (additiv + Atemrauschen, Pitch-Bends), Taiko/Shime-Daiko (Membran-Moden) und Glocken (FM/Modal).

## Formate

| Format | Wofür | Encoding |
|---|---|---|
| `.m4a` (AAC-LC) | iOS/Safari, funktioniert auch auf Android/Desktop | SFX 96 kbps mono (bei Transienten-Überschwingern automatisch 128/160 kbps), Atmo/Musik 96 kbps stereo |
| `.ogg` (Vorbis) | Android/Chrome/Firefox, Web – bestes Loop-Verhalten | SFX q4 mono, Atmo/Musik q2 stereo |
| `.mp3` | Fallback | SFX 80 kbps mono, Atmo/Musik 96 kbps stereo |

44,1 kHz, SFX mono, Atmo und Musik stereo. Master-True-Peak ≤ −1,5 dBTP, alle dekodierten Dateien ≤ −1 dBFS.
Hochpass 80 Hz bei SFX (75 Hz bei Loops): kein Bass, der auf Handylautsprechern verloren geht – Wucht kommt über Sättigung/Obertöne.
WAV-Master (24 bit) liegen nur im Arbeitsordner `/workspace/barrel-ninja-sfx/wav/`.

Formatwahl im Code, z. B.:
```js
const a = document.createElement('audio');
const EXT = a.canPlayType('audio/ogg; codecs="vorbis"') ? 'ogg' : 'm4a';
```

## Dateiliste

Lautheit: SFX als maximale Momentary-Loudness (M, 400 ms), Loops als Integrated (I), in LUFS.
**Empf.** = empfohlene Lautstärke im Spiel (0–1, als Gain/`volume`) bei Master = 1.

| Datei | Dauer | Loop | Einsatz | LUFS | True Peak dBTP | Empf. | Größe ogg / m4a / mp3 |
|---|---|---|---|---|---|---|---|
@@TABLE@@

Hinweise zur Mischung: Warnung, Game Over und Highscore sind bewusst nicht lauter als der Schwerthieb.
Atmo liegt bei −24 LUFS, Musik bei −18 LUFS – mit den empfohlenen Werten bleiben SFX klar vorne.
`score_pickup` ist leiser empfohlen (0.45), weil er sehr oft kommt. Für schnelle Wiederholungen
(Slash, Hit, Pickup) die Tonhöhe pro Abspielen leicht variieren (`playbackRate` 0.94–1.06) – das verhindert Ermüdung.

## Einbau in das Spiel (Audio-Manager in index.html)

Dateien liegen flach in diesem Ordner und werden in `manifest.json` unter `files` eingetragen:

```json
{ "files": { "slash": { "src": "sword_slash.m4a", "volume": 0.9 } } }
```

Ist ein Name nicht eingetragen oder kann die Datei nicht geladen werden, spielt der eingebaute Synth-Fallback.
Ein fertiger Vorschlag liegt in **`manifest.suggested.json`** (noch nicht aktiv – `manifest.json` ist unverändert).

Zuordnung bisheriger Sound-Namen → neue Dateien:

| Name im Spiel | Datei |
|---|---|
@@MAP@@

`cutTick` hat kein 1:1-Gegenstück: entweder Synth-Fallback behalten oder `rope_cutting_loop` als Loop starten,
solange der Seilschneider schneidet. Diese Sounds brauchen neue Hooks im Code:
`rope_retract`, `rope_extend`, `rope_creak`, `enemy_hit`, `player_hit`, `barrel_pickup`, `ui_confirm`,
`new_highscore`, `rope_cutting_loop`, `ambience_well_loop`, `music_mid_loop`, `music_fast_loop`.
Metadaten aller Dateien (Dauer, Loop, Lautstärke) stehen maschinenlesbar in `sounds.json`.

## Loops nahtlos abspielen

Alle Loops sind zirkulär gebaut (Nachklang und Hall wickeln sich an den Anfang), der Loop-Punkt ist sample-genau.
`<audio loop>` erzeugt in vielen Browsern eine kleine Lücke – besser WebAudio (`AudioBufferSourceNode.loop = true`).
AAC (`.m4a`) hängt am Ende ca. 512 Samples (≈ 12 ms) Padding an: daher **`loopEnd` explizit setzen**:

```js
const LOOP_END = {
@@LOOPENDS@@
};
src.loop = true; src.loopStart = 0; src.loopEnd = LOOP_END[name];
```

## Musik: drei Intensitätsstufen mit Crossfade

`music_calm_loop` (75 BPM) → `music_mid_loop` (100 BPM) → `music_fast_loop` (135 BPM).
Alle drei stehen in derselben Skala (In-Skala auf D: D–Eb–G–A–Bb), mit demselben Bass-Zyklus (D–D–Bb–A)
und demselben Kernmotiv (A–Bb–A–G–D, Flöte bzw. Koto). Deshalb klingen Überblendungen an beliebiger Stelle
harmonisch; ein Beat-Sync ist wegen der unterschiedlichen Tempi nicht nötig.

Empfehlung: Wechsel per **Crossfade von ca. 1,5–2 s** an Score-Schwellen. Nur hochschalten während eines Laufs
(kein Hin- und Herspringen), bei neuem Lauf wieder bei `calm` starten; bei Game Over die Musik in ~1 s ausblenden.
Die Schwellen sind Vorschläge und gehören zum Balancing (z. B. in `balance.json`):

```js
// --- Musik-Intensität (anpassbar) ---
const MUSIC_MID_SCORE  = 500;   // ab diesem Score: music_mid_loop
const MUSIC_FAST_SCORE = 1500;  // ab diesem Score: music_fast_loop
const MUSIC_XFADE_S    = 1.8;   // Crossfade-Dauer in Sekunden
const MUSIC_VOLUME     = 0.5;   // empfohlene Musik-Lautstärke
const EXT = document.createElement('audio').canPlayType('audio/ogg; codecs="vorbis"') ? 'ogg' : 'm4a';

class MusicLayers {
  constructor(ctx, destination) {
    this.ctx = ctx; this.dest = destination; this.buffers = {}; this.cur = null; this.level = 0;
  }
  async load() {
    for (const n of ['music_calm_loop', 'music_mid_loop', 'music_fast_loop']) {
      const res = await fetch(`audio/${n}.${EXT}`);
      this.buffers[n] = await this.ctx.decodeAudioData(await res.arrayBuffer());
    }
  }
  // Startet `name` mit eigenem GainNode und blendet den bisherigen Loop aus (zwei GainNodes, Equal-Power-Kurve).
  play(name, fade = MUSIC_XFADE_S) {
    if (this.cur && this.cur.name === name) return;
    const ctx = this.ctx, now = ctx.currentTime, steps = 64;
    const src = ctx.createBufferSource();
    src.buffer = this.buffers[name];
    src.loop = true; src.loopStart = 0; src.loopEnd = LOOP_END[name];
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    src.connect(gain).connect(this.dest);
    src.start(now);
    const up = new Float32Array(steps);
    for (let i = 0; i < steps; i++) up[i] = Math.sin((i / (steps - 1)) * Math.PI / 2) * MUSIC_VOLUME;
    gain.gain.setValueCurveAtTime(up, now, fade);
    if (this.cur) {
      const old = this.cur, g = old.gain.gain, v = g.value;
      g.cancelScheduledValues(now);
      const down = new Float32Array(steps);
      for (let i = 0; i < steps; i++) down[i] = Math.cos((i / (steps - 1)) * Math.PI / 2) * v;
      g.setValueCurveAtTime(down, now, fade);
      old.src.stop(now + fade + 0.05);
    }
    this.cur = { name, src, gain };
  }
  // Pro Frame/Score-Update aufrufen: schaltet nur hoch.
  update(score) {
    const lvl = score >= MUSIC_FAST_SCORE ? 2 : score >= MUSIC_MID_SCORE ? 1 : 0;
    if (lvl > this.level || !this.cur) {
      this.level = Math.max(lvl, this.level);
      this.play(['music_calm_loop', 'music_mid_loop', 'music_fast_loop'][this.level]);
    }
  }
  reset() { this.level = 0; this.play('music_calm_loop', 1.0); }   // neuer Lauf
  stop(fade = 1.0) {
    if (!this.cur) return;
    const now = this.ctx.currentTime, g = this.cur.gain.gain;
    g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(0, now + fade);
    this.cur.src.stop(now + fade + 0.05); this.cur = null;
  }
}
// Nutzung: const music = new MusicLayers(audioCtx, musicBus); await music.load(); music.update(score);
// iOS: AudioContext erst nach der ersten Touch-Geste mit audioCtx.resume() starten.
```

## Vorschau & Neuerzeugung

- `preview.html` im Browser öffnen: jeder Sound per Button, Formatwahl, Loops an/aus, Musik-Stufen mit Crossfade.
- Neu erzeugen: `python generate.py` (benötigt numpy, scipy, soundfile, pyloudnorm, matplotlib und ffmpeg mit
  libvorbis/aac/libmp3lame). Einzelne Sounds: `python generate.py --only sword_slash warning`.
  Spektrogramme und Messwerte landen in `/workspace/barrel-ninja-sfx/analysis/`.

## Lizenz

Selbst synthetisiert, keine Fremdmaterialien. Urheber Oruci Sabahudin, frei verwendbar – Details in `LICENSES.md`.
'''

LICENSE_TXT = '''# Lizenz / Herkunft der Audio-Dateien

**Urheber:** Oruci Sabahudin
**Projekt:** Barrel Ninja
**Umfang:** alle Dateien in diesem Ordner (`*.ogg`, `*.m4a`, `*.mp3`), die WAV-Master in
`/workspace/barrel-ninja-sfx/wav/` sowie das Generator-Skript `generate.py`.

## Herkunft

- Sämtliche Klänge wurden vollständig prozedural per Code erzeugt (`generate.py`, Python mit numpy/scipy):
  Rauschgeneratoren, Filter, Sinus-/Modal-/FM-Synthese, Karplus-Strong-Saitensynthese, additive Flötensynthese
  und Faltungshall mit synthetisch berechneten Impulsantworten.
- Es wurden **keine Samples, Loops, Aufnahmen oder Impulsantworten Dritter** verwendet.
- Keine Übernahme von Melodien, Klängen oder Motiven aus anderen Spielen (insbesondere nicht aus Battletoads).
  Die verwendeten pentatonischen Skalen (In, Yo) sind traditionelle, gemeinfreie Tonleitern.
- Werkzeuge (numpy, scipy, soundfile, pyloudnorm, matplotlib, ffmpeg) wurden nur zur Berechnung und Kodierung
  genutzt; sie übertragen keine Rechte oder Lizenzpflichten auf die erzeugten Audiodateien.

## Nutzung

Die Dateien sind Eigentum von Oruci Sabahudin und dürfen frei verwendet, verändert, weitergegeben und
kommerziell genutzt werden – in Barrel Ninja und in jedem anderen Projekt. Keine Namensnennung erforderlich.
'''

PREVIEW_TPL = r'''<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Barrel Ninja – Sound-Vorschau</title>
<style>
 body{margin:0;background:#05070F;color:#F4F1EA;font:15px/1.4 system-ui,Rubik,sans-serif}
 header{padding:16px 18px;background:linear-gradient(#12304A,#0B1426);border-bottom:2px solid #E2283C}
 h1{margin:0;font-size:20px} .bar{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-top:8px;font-size:13px}
 main{padding:14px;display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:10px}
 .card{background:rgba(11,20,38,.75);border:1px solid #1C2A3A;border-radius:10px;padding:10px 12px}
 .card b{color:#9FD8FF} .meta{font-size:12px;opacity:.75;margin:4px 0 8px}
 button{background:#1F2A5C;color:#F4F1EA;border:1px solid #3A5670;border-radius:8px;padding:8px 12px;font-weight:600;cursor:pointer}
 button.on{background:#E2283C;border-color:#E2283C} button:active{transform:scale(.97)}
 section.music{grid-column:1/-1;border-color:#4FF0FF}
</style></head><body>
<header><h1>Barrel Ninja – Sound-Vorschau</h1>
<div class="bar">
 <label>Format <select id="fmt"><option>ogg</option><option>m4a</option><option>mp3</option></select></label>
 <label><input type="checkbox" id="rec" checked> empfohlene Lautstärke anwenden</label>
 <label>Master <input type="range" id="master" min="0" max="1" step="0.05" value="1"></label>
 <button id="stopall">Alles stoppen</button>
</div></header>
<main id="list"></main>
<script>
const DATA = @@DATA@@;
const $ = s => document.querySelector(s);
const looping = {};
const gainOf = n => ($('#rec').checked ? DATA[n].volume : 1) * parseFloat($('#master').value);
function src(n){ return n + '.' + $('#fmt').value; }
function playOnce(n){ const a = new Audio(src(n)); a.volume = gainOf(n); a.play(); }
function toggleLoop(n, btn){
  if (looping[n]) { looping[n].pause(); delete looping[n]; btn.classList.remove('on'); btn.textContent='▶ Loop'; return; }
  const a = new Audio(src(n)); a.loop = true; a.volume = gainOf(n); a.play(); looping[n] = a;
  btn.classList.add('on'); btn.textContent='■ Stop';
}
// Musik-Stufen mit Crossfade (Vorschau über <audio>; im Spiel WebAudio, siehe README)
const MUSIC = ['music_calm_loop','music_mid_loop','music_fast_loop']; let cur = null;
function fadeTo(a, target, ms, done){
  const start = a.volume, t0 = performance.now();
  (function step(t){ const x = Math.min(1,(t-t0)/ms); a.volume = start + (target-start)*Math.sin(x*Math.PI/2);
    if (x<1) requestAnimationFrame(step); else done && done(); })(t0);
}
function musicStage(n){
  document.querySelectorAll('.mbtn').forEach(b=>b.classList.toggle('on', b.dataset.n===n));
  if (cur && cur.n === n) return;
  const a = new Audio(src(n)); a.loop = true; a.volume = 0; a.play();
  fadeTo(a, gainOf(n), 1800);
  if (cur) { const old = cur.a; fadeTo(old, 0, 1800, ()=>old.pause()); }
  cur = {n, a};
}
const list = $('#list');
const ms = document.createElement('section'); ms.className = 'card music';
ms.innerHTML = '<b>Musik-Stufen (Crossfade 1,8 s)</b><div class="meta">ruhig → mittel → schnell, gleiche Skala und gleiches Motiv</div>';
MUSIC.forEach((n,i)=>{ const b=document.createElement('button'); b.className='mbtn'; b.dataset.n=n;
  b.textContent=['Ruhig 75','Mittel 100','Schnell 135'][i]+' BPM'; b.onclick=()=>musicStage(n); ms.appendChild(b); ms.append(' '); });
const sb=document.createElement('button'); sb.textContent='Musik aus'; sb.onclick=()=>{ if(cur){const o=cur.a; fadeTo(o,0,1000,()=>o.pause()); cur=null;}
  document.querySelectorAll('.mbtn').forEach(b=>b.classList.remove('on')); }; ms.appendChild(sb);
list.appendChild(ms);
for (const [n, d] of Object.entries(DATA)) {
  const c = document.createElement('div'); c.className = 'card';
  c.innerHTML = `<b>${n}</b><div class="meta">${d.desc}<br>${d.duration_s.toFixed(2)} s · ${d.lufs} LUFS · empf. ${d.volume}</div>`;
  const b = document.createElement('button');
  if (d.loop) { b.textContent='▶ Loop'; b.onclick=()=>toggleLoop(n,b); } else { b.textContent='▶ Abspielen'; b.onclick=()=>playOnce(n); }
  c.appendChild(b); list.appendChild(c);
}
$('#stopall').onclick = ()=>{ for (const k in looping){ looping[k].pause(); delete looping[k]; }
  document.querySelectorAll('button.on').forEach(b=>{ b.classList.remove('on'); if(b.textContent.startsWith('■')) b.textContent='▶ Loop'; });
  if (cur){ cur.a.pause(); cur=null; } };
</script></body></html>
'''


if __name__ == '__main__':
    main()
