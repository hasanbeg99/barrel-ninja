# Barrel Ninja – Audio (Soundeffekte, Atmo, Musik)

Alle Klänge wurden **komplett per Code synthetisiert** (`generate.py`, fester Seed `20261022`).
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
| `swipe` | 0.24 s | – | Wischgeste: kurzes, aufsteigendes Luftrauschen | -16.1 (M) | -1.67 | **0.55** | 6 KB / 4 KB / 3 KB |
| `rope_retract` | 0.42 s | – | Seil einziehen: Reibung/Fasern steigend, kleiner Holz-Stopp | -16.0 (M) | -2.08 | **0.5** | 7 KB / 6 KB / 5 KB |
| `rope_extend` | 0.50 s | – | Seil verlängern: Reibung fallend, kurze Spannungs-Knarz am Ende | -16.4 (M) | -1.59 | **0.5** | 9 KB / 7 KB / 6 KB |
| `rope_creak` | 0.75 s | – | Seil knarzt/spannt sich (Stick-Slip-Reibung) | -17.0 (M) | -4.89 | **0.4** | 13 KB / 10 KB / 8 KB |
| `sword_slash` | 0.48 s | – | Katana-Hieb: Whoosh + metallisches 'Shing' | -14.7 (M) | -1.5 | **0.9** | 7 KB / 8 KB / 5 KB |
| `enemy_hit` | 0.32 s | – | Treffer am Gegner: dumpfer Schlag + Knack | -15.1 (M) | -1.79 | **0.85** | 6 KB / 6 KB / 4 KB |
| `enemy_death` | 0.75 s | – | Gegner besiegt: Treffer + absteigendes Zerfallen/Krümel | -15.0 (M) | -3.08 | **0.8** | 10 KB / 10 KB / 8 KB |
| `player_hit` | 0.50 s | – | Spieler/Fass getroffen: Holz-Wumms + dissonanter Stich | -15.3 (M) | -1.78 | **0.9** | 7 KB / 10 KB / 6 KB |
| `barrel_break` | 0.90 s | – | Holzfass zerplatzt: Krachen, Splitter, Eisenreifen | -16.4 (M) | -1.5 | **0.85** | 11 KB / 16 KB / 9 KB |
| `barrel_pickup` | 0.55 s | – | Fass wieder aufgenommen: Holz-'Tonk' + aufsteigende Marimba | -16.0 (M) | -3.56 | **0.7** | 7 KB / 7 KB / 6 KB |
| `warning` | 0.75 s | – | Telegraph/Gefahr: Taiko 'ka-DON' + leiser Gong-Glanz | -15.2 (M) | -3.6 | **0.75** | 6 KB / 9 KB / 8 KB |
| `rope_cutting_loop` | 1.50 s | ja | Seilschneider schneidet (nahtloser Loop, 1,5 s) | -18.0 (I) | -2.99 | **0.55** | 14 KB / 19 KB / 15 KB |
| `rope_snap` | 0.80 s | – | Seil reißt: Knall, Fasern, Rückschnell-Twang, Whoosh | -15.6 (M) | -1.79 | **0.85** | 11 KB / 11 KB / 8 KB |
| `ui_click` | 0.07 s | – | UI-Klick: kurzer Holzblock | -18.9 (M) | -1.79 | **0.5** | 4 KB / 2 KB / 1 KB |
| `ui_confirm` | 0.40 s | – | UI-Bestätigung: zwei Töne aufwärts (E5-A5) | -16.0 (M) | -4.59 | **0.6** | 5 KB / 6 KB / 5 KB |
| `score_pickup` | 0.42 s | – | Punkte/Pickup: glockiges 'Ting-ting' (E6-B6) | -16.0 (M) | -5.14 | **0.45** | 6 KB / 6 KB / 5 KB |
| `game_over` | 2.60 s | – | Game Over: absteigende In-Skala, Koto + Shakuhachi | -15.2 (M) | -5.0 | **0.8** | 28 KB / 32 KB / 26 KB |
| `new_highscore` | 1.90 s | – | Neuer Highscore: aufsteigende Yo-Skala, Taiko, Glocken | -15.2 (M) | -2.29 | **0.8** | 20 KB / 24 KB / 19 KB |
| `ambience_well_loop` | 24.00 s | ja | Brunnen-Atmo: Wind, Tropfen, tiefer Hall (24 s Loop, stereo) | -24.0 (I) | -10.31 | **0.6** | 178 KB / 289 KB / 282 KB |
| `music_calm_loop` | 76.80 s | ja | Musik Stufe 1 (ruhig): 75 BPM, Koto + Shakuhachi, kaum Percussion (76,8 s Loop, stereo) | -18.0 (I) | -6.18 | **0.5** | 815 KB / 1.21 MB / 901 KB |
| `music_mid_loop` | 76.80 s | ja | Musik Stufe 2 (mittel): 100 BPM, Shamisen-Puls, leichte Taiko (76,8 s Loop, stereo) | -18.0 (I) | -3.44 | **0.5** | 823 KB / 925 KB / 901 KB |
| `music_fast_loop` | 71.11 s | ja | Musik Stufe 3 (schnell): 135 BPM, treibende Taiko, Shamisen, Motiv (71,1 s Loop, stereo) | -18.0 (I) | -3.46 | **0.5** | 772 KB / 862 KB / 834 KB |

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
| `swipe` | `swipe` |
| `slash` | `sword_slash` |
| `kill` | `enemy_death` |
| `warn` | `warning` |
| `barrelBreak` | `barrel_break` |
| `pickup` | `score_pickup` |
| `ropeSnap` | `rope_snap` |
| `gameOver` | `game_over` |
| `uiClick` | `ui_click` |
| `music` | `music_calm_loop` |

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
  rope_cutting_loop: 1.5,
  ambience_well_loop: 24.0,
  music_calm_loop: 76.8,
  music_mid_loop: 76.8,
  music_fast_loop: 71.111
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

---

## Stand der Integration im Spiel (index.html → `AudioMgr`)

- **Aktiv über `manifest.json`** (bewusst neu geschrieben, Schlüssel = Dateiname ohne Endung). Das Spiel wählt pro Browser
  `.ogg` → `.m4a` → `.mp3` (per `canPlayType`; schlägt das Dekodieren fehl, wird automatisch das nächste Format geladen).
  Fehlt eine Datei, spielt der eingebaute WebAudio-Synth. `manifest.suggested.json` bleibt als Referenz liegen.
- Alles läuft über WebAudio-Buffer (keine `<audio>`-Elemente). Loops mit `loopEnd` aus der Tabelle oben (m4a-Padding).
- **Musik:** 3 Stufen nach Tiefe (`BALANCE.audio.musicTiersM`: mid ab 120 m, fast ab 300 m), Equal-Power-Crossfade 1,8 s,
  nur Hochschalten; jeder neue Lauf (und das Menü) beginnt mit `calm`. Game Over: Musik in 1 s aus. Pause: Musik geduckt (×0,35).
- **Atmo** `ambience_well_loop` läuft durchgehend ab der ersten Berührung.
- **Hooks:** `swipe` (jede Wischgeste), `rope_retract`/`rope_extend` (hoch/runter), `rope_creak` (Zurückpendeln, max. alle 1,4 s),
  `sword_slash` (Seitenhieb), `enemy_hit` + `enemy_death` (Kill), `player_hit` + `barrel_break` (erster Treffer),
  `barrel_pickup`, `score_pickup` (Münzen), `warning` (nur akustisch, wenn der Seilschneider erscheint – kein visueller Marker),
  `rope_cutting_loop` (läuft, solange geschnitten wird; ersetzt `cutTick`), `rope_snap`, `game_over`, `new_highscore`,
  `ui_click` (Buttons), `ui_confirm` (Spielen/Nochmal/Weiter/Neustart, Meilensteine).
- `playbackRate` 0,94–1,06 zufällig für `swipe`, `sword_slash`, `score_pickup`.
- Mute-Taste schaltet den Master-Gain (Loops laufen stumm weiter); iOS-Unlock beim ersten Touch/Klick/Tastendruck,
  Kontext wird beim Verlassen der App angehalten und beim Zurückkehren fortgesetzt.
- Service Worker: Nach dem Laden meldet die Seite dem Worker die passende Format-Variante; der Worker legt genau diese
  Dateien (inkl. aller drei Musikstufen) in den Offline-Cache.
