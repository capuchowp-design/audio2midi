/* app.js — Áudio → MIDI
 *
 * DSP 100% tradicional (nenhuma IA / machine learning):
 *   1. Decimação por média de blocos (~22 kHz) para reduzir o custo do cálculo
 *   2. RMS por quadro  -> envelope de amplitude (noise gate, onset, release, velocity)
 *   3. Algoritmo YIN   -> frequência fundamental (f0) com interpolação parabólica
 *   4. nota = 69 + 12 * log2(f / 440)
 *   5. Máquina de estados de notas: onset (por envelope e por troca de pitch), release, velocity
 *   6. Gravador de arquivo MIDI (SMF formato 0) escrito à mão, sem dependências
 *
 * Tudo roda no navegador. As seções "DSP" e "MIDI" não tocam no DOM (testáveis em Node).
 */
(function (global) {
  'use strict';

  /* =====================================================================
   *  UTILIDADES
   * ===================================================================== */
  const PPQ = 480;                       // ticks por semínima no arquivo MIDI
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

  /** Frequência (Hz) -> nota MIDI (fracionária). Fórmula exata: 69 + 12*log2(f/440). */
  function freqToMidi(f) { return 69 + 12 * Math.log2(f / 440); }
  /** Nota MIDI -> frequência (Hz). */
  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  /** Nome da nota (ex.: 60 -> "C4"). */
  function midiName(m) {
    const r = Math.round(m);
    return NOTE_NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
  }
  /** RMS linear -> velocity MIDI 1..127 (faixa -54 dBFS .. -6 dBFS). */
  function rmsToVelocity(rms) {
    const db = rms > 1e-9 ? 20 * Math.log10(rms) : -120;
    return clamp(Math.round(1 + 126 * clamp((db + 54) / 48, 0, 1)), 1, 127);
  }
  function median(arr) {
    if (!arr.length) return NaN;
    const a = Float64Array.from(arr).sort();
    const h = a.length >> 1;
    return a.length & 1 ? a[h] : (a[h - 1] + a[h]) / 2;
  }

  /* =====================================================================
   *  DSP — MOTOR DE DETECÇÃO DE NOTAS (streaming)
   * ===================================================================== */
  const DEFAULTS = {
    gateDb: -45,          // noise gate (dBFS RMS) para iniciar uma nota
    frameSize: 1024,      // janela do YIN (amostras decimadas, ~46 ms)
    hopSize: 256,         // passo entre quadros (amostras decimadas, ~11,6 ms)
    rmsSize: 512,         // janela do RMS (amostras decimadas, ~23 ms)
    yinThreshold: 0.15,   // limiar absoluto do YIN (menor = mais rígido)
    minFreq: 45,          // Hz
    maxFreq: 2100,        // Hz
    confirmFrames: 3,     // quadros consecutivos estáveis para confirmar nota
    minNoteSec: 0.05,     // notas mais curtas que isso são descartadas
    onsetRiseDb: 6,       // subida de envelope (dB em ~35 ms) que caracteriza novo ataque
    releaseRatio: 0.06,   // fim da nota quando RMS < pico * 0,06 (≈ -24 dB)
    refractorySec: 0.12,  // intervalo mínimo entre ataques
    attackSec: 0.07,      // janela após o onset para medir o pico (velocity)
    unvoicedFrames: 6,    // quadros sem pitch para encerrar a nota
    bendSemitones: 0.75   // desvio que conta como "outra nota"
  };

  class NoteEngine {
    /**
     * @param {number} sampleRate taxa de amostragem do sinal de entrada
     * @param {object} [options]  sobrescreve DEFAULTS (gateDb pode ser mudado em tempo real: engine.opt.gateDb)
     */
    constructor(sampleRate, options) {
      this.opt = Object.assign({}, DEFAULTS, options || {});
      this.sr = sampleRate;
      this.D = Math.max(1, Math.round(sampleRate / 22050));   // fator de decimação
      this.srD = sampleRate / this.D;                           // taxa após decimação
      this.W = this.opt.frameSize;
      this.Wd = this.W >> 1;                                    // janela de integração do YIN
      this.H = this.opt.hopSize;
      this.Wr = this.opt.rmsSize;
      this.tauMax = this.Wd;
      this.tauMin = Math.max(2, Math.floor(this.srD / this.opt.maxFreq));
      this.hopSec = this.H / this.srD;
      this.ring = new Float32Array(this.W);
      this.frame = new Float32Array(this.W);
      this.dp = new Float32Array(this.tauMax + 2);
      this.onNote = null;                                       // callback(note) ao finalizar cada nota
      this.reset();
    }

    reset() {
      this.ring.fill(0);
      this.w = 0; this.filled = 0; this.sinceHop = 0;
      this.acc = 0; this.accN = 0;
      this.nDec = 0; this.nNative = 0;
      this.notes = [];
      this.note = null;            // nota ativa (em andamento)
      this.state = 0;              // 0 = silêncio/aguardando, 1 = nota ativa
      this.armed = true;
      this.riseStart = null;
      this.candNote = -1; this.candCount = 0; this.candStart = 0;
      this.unvStreak = 0;
      this.lowCount = 0; this.lowStart = 0;
      this.unvCount = 0; this.unvStart = 0;
      this.lastOnsetT = -1e9;
      this.dbHist = [];
      this.rmsHist = [];
      this.frameInfo = { t: 0, rms: 0, db: -120, f0: 0, midiF: 0, clarity: 0, voiced: false };
    }

    /** Tempo (s) da última amostra recebida. */
    get time() { return this.nNative / this.sr; }

    /** Alimenta o motor com amostras mono (Float32Array) na taxa original. */
    push(chunk) {
      const D = this.D;
      for (let i = 0; i < chunk.length; i++) {
        this.acc += chunk[i];
        if (++this.accN === D) {
          this._pushDec(this.acc / D);
          this.acc = 0; this.accN = 0;
        }
      }
      this.nNative += chunk.length;
    }

    /** Encerra a nota em andamento (chamar ao fim da gravação / arquivo). */
    flush() {
      if (this.state === 1) this._endNote(this.frameInfo.t + this.hopSec, true);
    }

    /* ---------------- interno ---------------- */
    _pushDec(x) {
      this.ring[this.w] = x;
      if (++this.w === this.W) this.w = 0;
      this.nDec++;
      if (this.filled < this.W) this.filled++;
      if (++this.sinceHop >= this.H) {
        this.sinceHop = 0;
        if (this.filled >= this.W) this._frame();
      }
    }

    _frame() {
      const W = this.W, Wr = this.Wr, ring = this.ring, fr = this.frame;
      let idx = this.w;                                   // posição mais antiga
      for (let i = 0; i < W; i++) { fr[i] = ring[idx]; if (++idx === W) idx = 0; }

      // RMS (sem DC) dos últimos Wr samples -> envelope de amplitude
      let s = 0, s2 = 0;
      for (let i = W - Wr; i < W; i++) { const v = fr[i]; s += v; s2 += v * v; }
      const mean = s / Wr;
      const rms = Math.sqrt(Math.max(0, s2 / Wr - mean * mean));
      const t = (this.nDec - Wr / 2) / this.srD;         // instante central da janela de RMS
      const gateOn = Math.pow(10, this.opt.gateDb / 20);

      let f0 = 0, clarity = 0, voiced = false, midiF = 0;
      if (rms >= gateOn * 0.5) {                          // não gasta CPU com silêncio
        const r = this._yin(fr);
        if (r && r.freq >= this.opt.minFreq && r.freq <= this.opt.maxFreq) {
          f0 = r.freq; clarity = r.clarity; voiced = true; midiF = freqToMidi(f0);
        }
      }
      const db = rms > 1e-9 ? 20 * Math.log10(rms) : -120;
      this.frameInfo = { t, rms, db, f0, midiF, clarity, voiced };
      this._step(t, rms, db, voiced, midiF);
    }

    /** YIN (de Cheveigné & Kawahara, 2002): diferença, normalização cumulativa, limiar absoluto, parábola. */
    _yin(x) {
      const Wd = this.Wd, tauMax = this.tauMax, tauMin = this.tauMin;
      const thr = this.opt.yinThreshold, dp = this.dp;
      let run = 0, best = -1;
      dp[0] = 1;
      for (let tau = 1; tau <= tauMax; tau++) {
        let sum = 0;
        for (let j = 0; j < Wd; j++) { const d = x[j] - x[j + tau]; sum += d * d; }
        run += sum;
        dp[tau] = run > 0 ? (sum * tau) / run : 1;         // d'(tau): diferença normalizada
        const k = tau - 1;                                  // primeiro mínimo local abaixo do limiar
        if (k >= tauMin && k >= 2 && dp[k] < thr && dp[k] <= dp[k - 1] && dp[k] < dp[tau]) { best = k; break; }
      }
      if (best < 0) return null;
      const a = dp[best - 1], b = dp[best], c = dp[best + 1];
      const den = a - 2 * b + c;
      let tauF = best;
      if (den > 1e-12) tauF += 0.5 * (a - c) / den;        // interpolação parabólica
      return { freq: this.srD / tauF, clarity: 1 - b };
    }

    _step(t, rms, db, voiced, midiF) {
      const o = this.opt;
      const gateOn = Math.pow(10, o.gateDb / 20);
      const gateOff = gateOn * 0.6;

      const dh = this.dbHist; dh.push(db); if (dh.length > 6) dh.shift();
      const rh = this.rmsHist; rh.push({ t, rms }); if (rh.length > 10) rh.shift();
      const rise = dh.length >= 4 ? db - dh[dh.length - 4] : 0;   // subida de envelope em ~3 quadros

      /* ---------- estado 0: aguardando início de nota ---------- */
      if (this.state === 0) {
        if (!this.armed) {
          // após um release "relativo", só rearma com silêncio ou com um novo ataque
          if (rms < gateOff) this.armed = true;
          else if (rise > o.onsetRiseDb && rms >= gateOn) {
            this.armed = true; this.riseStart = t - 2 * this.hopSec; this.candCount = 0; this.candNote = -1;
          } else return;
        }
        if (rms >= gateOn) {
          if (this.riseStart === null) this.riseStart = t;
          if (voiced) {
            this.unvStreak = 0;
            if (this.candNote >= 0 && Math.abs(midiF - this.candNote) < 0.65) this.candCount++;
            else { this.candNote = Math.round(midiF); this.candCount = 1; }
            if (this.candCount >= o.confirmFrames) this._startNote(this.candNote, this.riseStart, t);
          } else {
            this.candCount = 0; this.candNote = -1;
            if (++this.unvStreak > 8) this.riseStart = t;       // ruído longo: reinicia a referência de onset
          }
        } else {
          this.riseStart = null; this.candCount = 0; this.candNote = -1; this.unvStreak = 0;
        }
        return;
      }

      /* ---------- estado 1: nota ativa ---------- */
      const n = this.note;
      if (t <= n.start + o.attackSec && rms > n.velRms) n.velRms = rms;
      if (rms > n.peak) n.peak = rms;

      // 1) fim por silêncio ou por queda relativa (release)
      const belowGate = rms < gateOff;
      const belowRel = rms < n.peak * o.releaseRatio;
      if (belowGate || belowRel) {
        if (this.lowCount === 0) this.lowStart = t;
        if (++this.lowCount >= 2) { this._endNote(this.lowStart, belowGate); return; }
      } else this.lowCount = 0;

      // 2) novo ataque por envelope (mesma nota repetida) — encerra e reavalia o pitch
      if (rise > o.onsetRiseDb && t - this.lastOnsetT > o.refractorySec) {
        const tOn = t - 2 * this.hopSec;
        this._endNote(tOn, true);
        this.riseStart = tOn; this.candCount = 0; this.candNote = -1; this.unvStreak = 0;
        return;
      }

      // 3) pitch: troca de nota sem silêncio (legato) e fim por perda de pitch
      if (voiced) {
        this.unvCount = 0;
        if (Math.abs(midiF - n.curMidi) > o.bendSemitones) {
          if (this.candNote >= 0 && Math.abs(midiF - this.candNote) < 0.65) this.candCount++;
          else { this.candNote = Math.round(midiF); this.candCount = 1; this.candStart = t; }
          if (this.candCount >= o.confirmFrames) {
            const m = this.candNote, t0 = this.candStart;
            this._endNote(t0, true);
            this._startNote(m, t0, t, true);
          }
        } else {
          this.candCount = 0; this.candNote = -1;
          n.pitches.push(midiF);
        }
      } else {
        if (this.unvCount === 0) this.unvStart = t;
        if (++this.unvCount >= o.unvoicedFrames) this._endNote(this.unvStart, false);
      }
    }

    _startNote(midi, t0, tNow, keepArmed) {
      let vel = 0;
      for (const h of this.rmsHist) if (h.t >= t0 - 1e-6 && h.rms > vel) vel = h.rms;
      this.note = { midi, curMidi: midi, start: t0, end: t0, velRms: vel, peak: vel, pitches: [] };
      this.state = 1;
      this.armed = true;
      this.lastOnsetT = tNow;
      this.lowCount = 0; this.unvCount = 0;
      this.candNote = -1; this.candCount = 0; this.riseStart = null;
    }

    _endNote(tEnd, armedAfter) {
      const n = this.note;
      this.note = null; this.state = 0;
      this.armed = armedAfter !== false;
      this.candNote = -1; this.candCount = 0; this.riseStart = null; this.unvStreak = 0;
      this.lowCount = 0; this.unvCount = 0;
      if (!n) return;
      n.end = Math.max(tEnd, n.start + 0.001);
      if (n.end - n.start < this.opt.minNoteSec) return;
      const med = median(n.pitches);
      n.midi = clamp(Number.isFinite(med) ? Math.round(med) : n.curMidi, 0, 127);
      n.velocity = rmsToVelocity(n.velRms);
      delete n.curMidi; delete n.pitches; delete n.peak;
      this.notes.push(n);
      if (this.onNote) this.onNote(n);
    }
  }

  /** Analisa um buffer inteiro (offline) em pedaços, cedendo o thread para a UI. */
  async function analyzeBuffer(data, sampleRate, options, onProgress) {
    const eng = new NoteEngine(sampleRate, options);
    const CH = 8192;
    let last = (typeof performance !== 'undefined' ? performance.now() : 0);
    for (let i = 0; i < data.length; i += CH) {
      eng.push(data.subarray(i, Math.min(i + CH, data.length)));
      if (typeof performance !== 'undefined' && performance.now() - last > 30) {
        if (onProgress) onProgress(i / data.length);
        await new Promise((r) => setTimeout(r, 0));
        last = performance.now();
      }
    }
    eng.flush();
    if (onProgress) onProgress(1);
    return eng.notes;
  }

  /* =====================================================================
   *  MIDI — gravador SMF (formato 0) escrito à mão
   * ===================================================================== */
  function vlq(n) {
    const out = [n & 0x7f];
    while ((n >>= 7) > 0) out.unshift((n & 0x7f) | 0x80);
    return out;
  }
  function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }

  /**
   * @param {Array<{start:number,end:number,midi:number,velocity:number}>} notes tempos em segundos
   * @param {{bpm?:number}} [opt]
   * @returns {Uint8Array} bytes de um arquivo .mid
   */
  function buildMidi(notes, opt) {
    const bpm = clamp((opt && opt.bpm) || 120, 20, 300);
    const ticksPerSec = PPQ * bpm / 60;
    const ev = [];
    for (const n of notes) {
      const s = Math.round(n.start * ticksPerSec);
      let e = Math.round(n.end * ticksPerSec);
      if (e <= s) e = s + 1;
      const m = clamp(Math.round(n.midi), 0, 127);
      const v = clamp(Math.round(n.velocity), 1, 127);
      ev.push({ t: s, o: 1, d: [0x90, m, v] });          // note on
      ev.push({ t: e, o: 0, d: [0x80, m, 0] });          // note off (antes de note on no mesmo tick)
    }
    ev.sort((a, b) => a.t - b.t || a.o - b.o);

    const tr = [];
    const usPerQ = Math.round(60000000 / bpm);
    tr.push(0x00, 0xff, 0x51, 0x03, (usPerQ >> 16) & 255, (usPerQ >> 8) & 255, usPerQ & 255); // tempo
    tr.push(0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08);                                   // 4/4
    const name = 'Audio to MIDI';
    tr.push(0x00, 0xff, 0x03, name.length);
    for (let i = 0; i < name.length; i++) tr.push(name.charCodeAt(i));
    tr.push(0x00, 0xc0, 0x00);                                                                 // programa 0 (piano)
    let prev = 0;
    for (const e of ev) { tr.push(...vlq(e.t - prev), ...e.d); prev = e.t; }
    tr.push(0x00, 0xff, 0x2f, 0x00);                                                           // fim da trilha

    const head = [0x4d, 0x54, 0x68, 0x64, ...u32(6), 0x00, 0x00, 0x00, 0x01, (PPQ >> 8) & 255, PPQ & 255];
    const trk = [0x4d, 0x54, 0x72, 0x6b, ...u32(tr.length)];
    return Uint8Array.from([...head, ...trk, ...tr]);
  }

  /* =====================================================================
   *  API pública (Node/testes e console)
   * ===================================================================== */
  const api = { NoteEngine, analyzeBuffer, buildMidi, freqToMidi, midiToFreq, midiName, rmsToVelocity, DEFAULTS, PPQ };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Audio2Midi = api;

  if (typeof document === 'undefined') return;      // abaixo: somente navegador

  /* =====================================================================
   *  INTERFACE (DOM, Web Audio, piano roll, PWA)
   * ===================================================================== */
  const WORKLET_SRC = `
    class A2MCapture extends AudioWorkletProcessor {
      constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch) {
          for (let i = 0; i < ch.length; i++) {
            this.buf[this.n++] = ch[i];
            if (this.n === 1024) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
          }
        }
        return true;
      }
    }
    registerProcessor('a2m-capture', A2MCapture);`;

  function initUI() {
    const $ = (id) => document.getElementById(id);
    const el = {
      btnMic: $('btnMic'), btnMicLabel: $('btnMicLabel'), btnFile: $('btnFile'), fileInput: $('fileInput'),
      btnDownload: $('btnDownload'), btnPreview: $('btnPreview'), btnClear: $('btnClear'),
      status: $('status'), progress: $('progress'), progressBar: $('progressBar'),
      noteName: $('noteName'), hz: $('hzInfo'), cents: $('centsInfo'), vel: $('velInfo'), midi: $('midiInfo'),
      meter: $('meterFill'), gateMark: $('gateMark'),
      canvas: $('roll'), scroll: $('scroll'), stats: $('stats'), viewInfo: $('viewInfo'),
      gate: $('gate'), gateVal: $('gateVal'), bpm: $('bpm'), norm: $('norm'),
      net: $('net'), install: $('install'), iosHint: $('iosHint')
    };

    const S = {
      mode: 'idle',          // idle | live | busy | review
      notes: [], duration: 0,
      engine: null, stream: null, ctx: null, workletReady: false,
      srcNode: null, procNode: null, sink: null,
      view: { start: 0, span: 8 },
      pitchLo: 48, pitchHi: 84,
      raf: 0, lastBuffer: null, baseName: 'gravacao',
      preview: null
    };
    global.Audio2Midi.state = S; // depuração/testes

    /* ---------- helpers de UI ---------- */
    function setStatus(msg, cls) { el.status.textContent = msg; el.status.className = 'status' + (cls ? ' ' + cls : ''); }
    function fmtTime(s) { s = Math.max(0, s); const m = Math.floor(s / 60); return m + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }
    function getCtx() {
      if (!S.ctx) { const AC = global.AudioContext || global.webkitAudioContext; S.ctx = new AC(); }
      return S.ctx;
    }
    function updateButtons() {
      const busy = S.mode === 'busy', live = S.mode === 'live';
      el.btnFile.disabled = busy || live;
      el.btnMic.disabled = busy;
      el.btnDownload.disabled = busy || live || S.notes.length === 0;
      el.btnPreview.disabled = busy || live || S.notes.length === 0;
      el.btnClear.disabled = busy || live || (S.notes.length === 0 && !S.lastBuffer);
      el.btnMic.classList.toggle('recording', live);
      el.btnMicLabel.textContent = live ? 'Parar gravação' : 'Gravar do microfone';
    }
    function updateStats() {
      const n = S.notes.length + (S.mode === 'live' && S.engine && S.engine.note ? 1 : 0);
      el.stats.textContent = n + (n === 1 ? ' nota' : ' notas') + ' · ' + fmtTime(S.duration) + ' de áudio';
    }
    function updateGateMark() {
      const g = +el.gate.value;
      el.gateVal.textContent = g + ' dB';
      el.gateMark.style.left = clamp((g + 60) / 60, 0, 1) * 100 + '%';
      if (S.engine) S.engine.opt.gateDb = g;
    }

    /* ---------- faixa de pitch do piano roll ---------- */
    function fitPitch(expandOnly) {
      let lo = 127, hi = 0;
      for (const n of S.notes) { if (n.midi < lo) lo = n.midi; if (n.midi > hi) hi = n.midi; }
      const a = S.engine && S.mode === 'live' ? S.engine.note : null;
      if (a) { lo = Math.min(lo, a.midi); hi = Math.max(hi, a.midi); }
      if (lo > hi) { lo = 60; hi = 60; }
      lo -= 3; hi += 3;
      if (hi - lo < 23) { const c = (hi + lo) / 2; lo = Math.floor(c - 11.5); hi = lo + 23; }
      lo = Math.max(0, lo); hi = Math.min(127, hi);
      if (expandOnly) { S.pitchLo = Math.min(S.pitchLo, lo); S.pitchHi = Math.max(S.pitchHi, hi); }
      else { S.pitchLo = lo; S.pitchHi = hi; }
    }
    function resetView() { S.pitchLo = 48; S.pitchHi = 84; S.view = { start: 0, span: 8 }; el.scroll.hidden = true; }

    /* ---------- desenho do piano roll ---------- */
    const BLACK = [1, 3, 6, 8, 10];
    function draw() {
      const c = el.canvas, g = c.getContext('2d');
      const dpr = global.devicePixelRatio || 1;
      const w = c.clientWidth, h = c.clientHeight;
      if (!w || !h) return;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);

      const keyW = w < 520 ? 36 : 48, top = 16;
      const px0 = keyW, pw = w - keyW, ph = h - top;
      const lo = S.pitchLo, hi = S.pitchHi, rows = hi - lo + 1, rowH = ph / rows;
      const yRow = (m) => top + (hi - m) * rowH;
      const { start, span } = S.view;
      const xOf = (t) => px0 + ((t - start) / span) * pw;

      // fundo das linhas + teclado
      g.font = '10px system-ui, sans-serif'; g.textBaseline = 'middle';
      for (let m = lo; m <= hi; m++) {
        const y = yRow(m), pc = ((m % 12) + 12) % 12, black = BLACK.includes(pc);
        g.fillStyle = black ? '#0a0d14' : '#111623';
        g.fillRect(px0, y, pw, rowH);
        g.fillStyle = black ? '#2a3146' : '#d9deec';
        g.fillRect(0, y + 0.5, black ? keyW * 0.62 : keyW - 1, Math.max(1, rowH - 1));
        if (pc === 0) {
          g.fillStyle = '#242c40'; g.fillRect(px0, y + rowH - 0.5, pw, 1);
          g.fillStyle = '#3a4260'; g.fillText('C' + (Math.floor(m / 12) - 1), keyW - 22, y + rowH / 2);
        }
      }
      // grade de tempo
      const steps = [0.25, 0.5, 1, 2, 5, 10, 30, 60];
      const step = steps.find((s) => span / s <= 12) || 60;
      g.fillStyle = '#7e87a1'; g.textBaseline = 'top';
      for (let t = Math.max(0, Math.ceil(start / step) * step); t <= start + span; t += step) {
        const x = xOf(t);
        if (x < px0) continue;
        g.fillStyle = '#1d2436'; g.fillRect(x, top, 1, ph);
        g.fillStyle = '#7e87a1'; g.fillText(fmtTime(t) + (step < 1 ? '.' + String(Math.round((t % 1) * 100)).padStart(2, '0') : ''), x + 3, 3);
      }

      // notas
      g.save();
      g.beginPath(); g.rect(px0, top, pw, ph); g.clip();
      const noteRect = (n, active) => {
        const x1 = xOf(n.start), x2 = xOf(n.end);
        if (x2 < px0 || x1 > w) return;
        const y = yRow(n.midi), v = n.velocity || rmsToVelocity(n.velRms || 0.05);
        const hue = 195 + 125 * (v / 127);
        g.fillStyle = `hsl(${hue} 85% ${active ? 68 : 58}%)`;
        const rw = Math.max(2, x2 - x1), rh = Math.max(2, rowH - 2);
        g.beginPath();
        if (g.roundRect) g.roundRect(x1, y + 1, rw, rh, Math.min(4, rh / 2)); else g.rect(x1, y + 1, rw, rh);
        g.fill();
        if (active) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); }
      };
      for (const n of S.notes) noteRect(n, false);
      if (S.mode === 'live' && S.engine && S.engine.note) {
        const a = S.engine.note;
        noteRect({ midi: a.midi, start: a.start, end: S.engine.frameInfo.t, velocity: rmsToVelocity(a.velRms) }, true);
      }
      // cursor "agora"
      if (S.mode === 'live' && S.engine) {
        const x = xOf(S.engine.time);
        g.fillStyle = 'rgba(255,77,109,.8)'; g.fillRect(x, top, 1.5, ph);
      }
      g.restore();
    }

    function updateView() {
      if (S.mode === 'live' && S.engine) {
        S.view.span = 8;
        S.view.start = S.engine.time - S.view.span * 0.92;
      } else if (S.mode === 'review') {
        const span = clamp(S.duration * 1.02, 4, 30);
        S.view.span = span;
        const maxStart = Math.max(0, S.duration - span);
        S.view.start = clamp(S.view.start, 0, maxStart);
        el.scroll.hidden = maxStart <= 0.01;
        el.scroll.max = String(maxStart);
        el.scroll.value = String(S.view.start);
      }
      el.viewInfo.textContent = S.mode === 'live' ? 'ao vivo · janela de 8 s'
        : (S.mode === 'review' && S.notes.length ? fmtTime(S.view.start) + ' – ' + fmtTime(S.view.start + S.view.span) : '');
    }

    function updateReadout() {
      const fi = S.engine && S.mode === 'live' ? S.engine.frameInfo : null;
      const a = S.engine && S.mode === 'live' ? S.engine.note : null;
      if (fi) {
        el.meter.style.width = clamp((fi.db + 60) / 60, 0, 1) * 100 + '%';
        if (fi.voiced && (a || fi.rms >= Math.pow(10, +el.gate.value / 20))) {
          const m = fi.midiF, r = Math.round(m), cents = Math.round((m - r) * 100);
          el.noteName.classList.remove('idle');
          el.noteName.textContent = midiName(r);
          el.hz.textContent = fi.f0.toFixed(1) + ' Hz';
          el.cents.textContent = (cents > 0 ? '+' : '') + cents + ' cents';
          el.midi.textContent = String(r);
          el.vel.textContent = String(rmsToVelocity(a ? a.velRms : fi.rms));
          return;
        }
      } else el.meter.style.width = '0%';
      if (!a) { el.noteName.classList.add('idle'); el.noteName.textContent = '—'; el.hz.textContent = '— Hz'; el.cents.textContent = '—'; el.midi.textContent = '—'; el.vel.textContent = '—'; }
    }

    function frameLoop() {
      if (S.mode !== 'live') { S.raf = 0; return; }
      S.duration = S.engine.time;
      fitPitch(true); updateView(); updateReadout(); updateStats(); draw();
      S.raf = requestAnimationFrame(frameLoop);
    }
    function redraw() { fitPitch(S.mode === 'live'); updateView(); updateStats(); draw(); }

    /* ---------- microfone (Web Audio: AudioWorklet com fallback ScriptProcessor) ---------- */
    async function startMic() {
      stopPreview();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setStatus('Microfone indisponível. Abra o app por HTTPS (ex.: GitHub Pages) em um navegador moderno.', 'err'); return;
      }
      const ctx = getCtx();
      try { await ctx.resume(); } catch (e) { /* ignora */ }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
        });
      } catch (e) {
        setStatus(e && e.name === 'NotAllowedError' ? 'Permissão do microfone negada. Libere o acesso nas configurações do navegador.'
          : 'Não foi possível abrir o microfone: ' + (e && e.message ? e.message : e), 'err');
        return;
      }
      clearSession(true);
      S.stream = stream;
      S.engine = new NoteEngine(ctx.sampleRate, { gateDb: +el.gate.value });
      S.notes = S.engine.notes;

      S.srcNode = ctx.createMediaStreamSource(stream);
      S.sink = ctx.createGain(); S.sink.gain.value = 0; S.sink.connect(ctx.destination);   // sem eco no alto-falante
      const feed = (buf) => { if (S.engine) S.engine.push(buf); };
      let ok = false;
      if (ctx.audioWorklet && global.AudioWorkletNode) {
        try {
          if (!S.workletReady) {
            const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
            await ctx.audioWorklet.addModule(url);
            URL.revokeObjectURL(url);
            S.workletReady = true;
          }
          S.procNode = new AudioWorkletNode(ctx, 'a2m-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
          S.procNode.port.onmessage = (e) => feed(e.data);
          ok = true;
        } catch (e) { ok = false; }
      }
      if (!ok) {                                                  // fallback (navegadores antigos)
        S.procNode = ctx.createScriptProcessor(2048, 1, 1);
        S.procNode.onaudioprocess = (e) => feed(new Float32Array(e.inputBuffer.getChannelData(0)));
      }
      S.srcNode.connect(S.procNode);
      S.procNode.connect(S.sink);

      S.mode = 'live';
      resetView(); updateGateMark(); updateButtons();
      setStatus('Gravando… toque ou cante uma nota de cada vez.');
      S.raf = requestAnimationFrame(frameLoop);
    }

    function stopMic() {
      if (S.mode !== 'live') return;
      try { S.srcNode && S.srcNode.disconnect(); S.procNode && S.procNode.disconnect(); S.sink && S.sink.disconnect(); } catch (e) { /* ignora */ }
      if (S.procNode && S.procNode.port) S.procNode.port.onmessage = null;
      if (S.procNode && 'onaudioprocess' in S.procNode) S.procNode.onaudioprocess = null;
      if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
      S.srcNode = S.procNode = S.sink = S.stream = null;
      S.engine.flush();
      S.duration = S.engine.time;
      S.notes = S.engine.notes.slice();
      S.engine = null;
      S.mode = 'review';
      S.view.start = 0;
      fitPitch(false); updateView(); updateStats(); draw(); updateButtons(); updateReadout();
      setStatus(S.notes.length ? 'Gravação concluída: ' + S.notes.length + ' nota(s) detectada(s). Você já pode baixar o MIDI.' : 'Nenhuma nota detectada. Tente aumentar a sensibilidade (mover o controle para a esquerda).', S.notes.length ? 'ok' : 'err');
    }

    /* ---------- arquivo de áudio ---------- */
    function decode(ctx, ab) {
      return new Promise((res, rej) => { const p = ctx.decodeAudioData(ab, res, rej); if (p && p.catch) p.catch(rej); });
    }
    function toMono(audio, normalize) {
      const n = audio.length, ch = audio.numberOfChannels, out = new Float32Array(n);
      for (let c = 0; c < ch; c++) { const d = audio.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / ch; }
      if (normalize) {
        let pk = 0; for (let i = 0; i < n; i++) { const a = Math.abs(out[i]); if (a > pk) pk = a; }
        if (pk > 1e-4) { const gain = Math.min(0.89 / pk, 100); for (let i = 0; i < n; i++) out[i] *= gain; }
      }
      return out;
    }
    async function analyzeLoaded() {
      const { audio } = S.lastBuffer;
      S.mode = 'busy'; updateButtons();
      el.progress.hidden = false; el.progressBar.style.width = '0%';
      setStatus('Analisando áudio…');
      const mono = toMono(audio, el.norm.checked);
      const notes = await analyzeBuffer(mono, audio.sampleRate, { gateDb: +el.gate.value },
        (p) => { el.progressBar.style.width = Math.round(p * 100) + '%'; });
      el.progress.hidden = true;
      S.notes = notes; S.duration = audio.duration; S.mode = 'review';
      S.view.start = 0; fitPitch(false); updateView(); updateStats(); draw(); updateButtons();
      setStatus(notes.length ? notes.length + ' nota(s) detectada(s) em ' + fmtTime(audio.duration) + '. Pronto para baixar o MIDI.' : 'Nenhuma nota detectada. Aumente a sensibilidade ou use uma gravação mais limpa/monofônica.', notes.length ? 'ok' : 'err');
    }
    async function handleFile(file) {
      if (!file) return;
      stopPreview();
      if (S.mode === 'live') stopMic();
      S.mode = 'busy'; updateButtons();
      setStatus('Decodificando "' + file.name + '"…');
      try {
        const ctx = getCtx();
        const ab = await file.arrayBuffer();
        const audio = await decode(ctx, ab);
        S.lastBuffer = { audio };
        S.baseName = file.name.replace(/\.[^.]+$/, '') || 'audio';
        resetView();
        await analyzeLoaded();
      } catch (e) {
        el.progress.hidden = true;
        S.mode = S.notes.length ? 'review' : 'idle'; updateButtons();
        setStatus('Não foi possível ler este arquivo de áudio (' + (e && e.message ? e.message : 'formato não suportado') + '). Tente WAV ou MP3.', 'err');
      }
    }

    /* ---------- download e prévia ---------- */
    function downloadMidi() {
      if (!S.notes.length) return;
      const bytes = buildMidi(S.notes, { bpm: +el.bpm.value || 120 });
      const blob = new Blob([bytes], { type: 'audio/midi' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const d = new Date(), p = (x) => String(x).padStart(2, '0');
      a.href = url;
      a.download = S.baseName + '-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.mid';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      setStatus('Arquivo MIDI gerado: ' + a.download, 'ok');
    }

    function stopPreview() {
      if (!S.preview) return;
      S.preview.oscs.forEach((o) => { try { o.stop(); } catch (e) { /* ignora */ } });
      clearTimeout(S.preview.timer);
      S.preview = null;
      el.btnPreview.textContent = '▶ Ouvir prévia';
    }
    async function togglePreview() {
      if (S.preview) { stopPreview(); return; }
      if (!S.notes.length) return;
      const ctx = getCtx();
      try { await ctx.resume(); } catch (e) { /* ignora */ }
      const t0 = ctx.currentTime + 0.1, oscs = [];
      for (const n of S.notes) {
        const osc = ctx.createOscillator(), g = ctx.createGain();
        osc.type = 'triangle'; osc.frequency.value = midiToFreq(n.midi);
        const amp = 0.05 + 0.2 * (n.velocity / 127), s = t0 + n.start, e = t0 + n.end;
        g.gain.setValueAtTime(0, s);
        g.gain.linearRampToValueAtTime(amp, s + 0.01);
        g.gain.setValueAtTime(amp, Math.max(s + 0.01, e - 0.03));
        g.gain.linearRampToValueAtTime(0, e);
        osc.connect(g); g.connect(ctx.destination);
        osc.start(s); osc.stop(e + 0.02);
        oscs.push(osc);
      }
      const total = S.notes[S.notes.length - 1].end;
      S.preview = { oscs, timer: setTimeout(stopPreview, (total + 0.3) * 1000) };
      el.btnPreview.textContent = '■ Parar prévia';
    }

    function clearSession(keepStatus) {
      stopPreview();
      S.notes = []; S.duration = 0; S.lastBuffer = null; S.engine = null;
      if (S.mode !== 'live') S.mode = 'idle';
      resetView(); updateButtons(); updateStats(); draw(); updateReadout();
      if (!keepStatus) setStatus('Pronto. Grave pelo microfone ou envie um arquivo de áudio.');
    }

    /* ---------- eventos ---------- */
    el.btnMic.addEventListener('click', () => { if (S.mode === 'live') stopMic(); else startMic(); });
    el.btnFile.addEventListener('click', () => el.fileInput.click());
    el.fileInput.addEventListener('change', () => { const f = el.fileInput.files[0]; el.fileInput.value = ''; handleFile(f); });
    el.btnDownload.addEventListener('click', downloadMidi);
    el.btnPreview.addEventListener('click', togglePreview);
    el.btnClear.addEventListener('click', () => clearSession(false));
    el.scroll.addEventListener('input', () => { S.view.start = +el.scroll.value; updateView(); draw(); });
    el.gate.addEventListener('input', updateGateMark);
    el.gate.addEventListener('change', () => { if (S.mode === 'review' && S.lastBuffer) analyzeLoaded(); });   // reanalisa o arquivo com a nova sensibilidade
    el.norm.addEventListener('change', () => { if (S.mode === 'review' && S.lastBuffer) analyzeLoaded(); });
    global.addEventListener('resize', draw);
    if (global.ResizeObserver) new ResizeObserver(draw).observe(el.canvas);

    ['dragover', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === 'drop' && e.dataTransfer && e.dataTransfer.files.length && S.mode !== 'busy' && S.mode !== 'live') handleFile(e.dataTransfer.files[0]);
    }));

    /* ---------- PWA: service worker, instalação, estado de rede ---------- */
    function updateNet() {
      const on = navigator.onLine;
      el.net.textContent = on ? (S.offlineReady ? 'online · pronto offline' : 'online') : 'offline';
      el.net.className = 'badge ' + (on ? (S.offlineReady ? 'ok' : '') : 'off');
    }
    global.addEventListener('online', updateNet);
    global.addEventListener('offline', updateNet);

    if ('serviceWorker' in navigator) {
      global.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
          .then(() => navigator.serviceWorker.ready)
          .then(() => { S.offlineReady = true; updateNet(); })
          .catch(() => { /* sem SW: o app segue funcionando online */ });
      });
    }
    let deferredPrompt = null;
    global.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; el.install.hidden = false; });
    el.install.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch (e) { /* ignora */ }
      deferredPrompt = null; el.install.hidden = true;
    });
    global.addEventListener('appinstalled', () => { el.install.hidden = true; });
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const standalone = global.matchMedia && global.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (isIOS && !standalone) el.iosHint.hidden = false;

    /* ---------- início ---------- */
    updateGateMark(); updateNet(); updateButtons(); updateStats(); resetView(); draw();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI);
  else initUI();
})(typeof globalThis !== 'undefined' ? globalThis : self);
