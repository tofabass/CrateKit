/* DJ Brain — Web Audio transition preview engine.
 * Plays real 30-second track previews (fetched from the project root) when a
 * track has an audioFile; otherwise falls back to a synthesized four-on-the-floor
 * beat. Primary plays full EQ; the incoming track is routed through a
 * low-frequency cut. */
export class BrainAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    this.channels = [];
    this.timer = null;
    this.stopTimer = null;
    this._cache = new Map(); // url -> decoded AudioBuffer
    this._session = 0;      // bumped on every (re)start; discards stale async loads
    this.pathActive = false;
    this.analyser = null;
    this._lvl = 0;
    this._lvlBuf = null;
  }

  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.7;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this._lvlBuf = new Uint8Array(this.analyser.fftSize);
      this.master.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      const len = Math.floor(this.ctx.sampleRate * 0.1);
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  /* overall output level 0..1 (fast attack, slow release) — drives the
     beat-synced synapse glow pulse and pulse speed; ~0 when nothing is playing */
  level() {
    if (!this.analyser || !this._lvlBuf || this.ctx.state !== 'running') return 0;
    this.analyser.getByteTimeDomainData(this._lvlBuf);
    let sum = 0;
    for (let i = 0; i < this._lvlBuf.length; i++) {
      const v = (this._lvlBuf[i] - 128) / 128;
      sum += v * v;
    }
    const raw = Math.min(1, Math.sqrt(sum / this._lvlBuf.length) * 3.2);
    this._lvl = raw > this._lvl ? this._lvl * 0.4 + raw * 0.6 : this._lvl * 0.93 + raw * 0.07;
    return this._lvl;
  }

  /* When two tracks play together at different tempos they "meet in the
     middle": both are rate-adjusted to the average BPM. Returns 0 when they
     already share a tempo (or tempo data is missing). */
  static meetBpm(a, b) {
    const x = Number(a) || 0, y = Number(b) || 0;
    if (!x || !y || x === y) return 0;
    return (x + y) / 2;
  }

  /* Playback rate that makes a track with `bpm` sound at `targetBpm`. */
  static rateFor(bpm, targetBpm) {
    const r = (Number(targetBpm) || 120) / (Number(bpm) || 120);
    return Math.max(0.5, Math.min(2, r));
  }

  /* ---------- real preview files ---------- */

  async loadFile(url) {
    if (this._cache.has(url)) return this._cache.get(url);
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    const ab = await res.arrayBuffer();
    const buf = await this.ctx.decodeAudioData(ab);
    this._cache.set(url, buf);
    return buf;
  }

  makeFileChannel(buffer, cutoffHz, initialGain, startAt) {
    const input = this.ctx.createGain();
    input.gain.value = 1;
    let node = input;
    if (cutoffHz) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = cutoffHz;
      f.Q.value = 0.8;
      node.connect(f);
      node = f;
    }
    const out = this.ctx.createGain();
    out.gain.value = initialGain;
    node.connect(out);
    out.connect(this.master);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(input);
    src.start(startAt);
    return { input, out, src, file: true };
  }

  /* ---------- synthesized fallback ---------- */

  rootFreq(track) {
    let h = 0;
    for (const c of track.id) h = (h * 31 + c.charCodeAt(0)) | 0;
    const semi = Math.abs(h) % 12;
    return 55 * Math.pow(2, semi / 12); // A1-based, distinct per track
  }

  makeChannelSynth(track, cutoffHz, initialGain) {
    const input = this.ctx.createGain();
    input.gain.value = 1;
    let node = input;
    if (cutoffHz) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = cutoffHz;
      f.Q.value = 0.8;
      node.connect(f);
      node = f;
    }
    const out = this.ctx.createGain();
    out.gain.value = initialGain;
    node.connect(out);
    out.connect(this.master);
    return { input, out, bpm: track.bpm, root: this.rootFreq(track), step: 0, nextTime: 0 };
  }

  kick(t, ch) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.connect(g); g.connect(ch.input);
    o.start(t); o.stop(t + 0.3);
  }

  hat(t, ch) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    src.connect(f); f.connect(g); g.connect(ch.input);
    src.start(t);
  }

  bass(t, ch) {
    const o = this.ctx.createOscillator();
    const f = this.ctx.createBiquadFilter();
    const g = this.ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.value = ch.root;
    f.type = 'lowpass';
    f.frequency.value = 420;
    g.gain.setValueAtTime(0.16, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(f); f.connect(g); g.connect(ch.input);
    o.start(t); o.stop(t + 0.25);
  }

  scheduleStep(ch, t, step) {
    if (step % 4 === 0) this.kick(t, ch);
    if (step % 4 === 2) this.hat(t, ch);
    if (step === 0 || step === 8) this.bass(t, ch);
  }

  startScheduler() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (!this.ctx) return;
      const horizon = this.ctx.currentTime + 0.15;
      for (const ch of this.channels) {
        if (ch.file) continue;
        if (ch.tempoPlan) {
          while (ch.tempoIdx < ch.tempoPlan.length && this.ctx.currentTime >= ch.tempoPlan[ch.tempoIdx].at) {
            ch.bpm = ch.tempoPlan[ch.tempoIdx].bpm;
            ch.tempoIdx++;
          }
        }
        while (ch.nextTime < horizon) {
          this.scheduleStep(ch, ch.nextTime, ch.step);
          ch.nextTime += 60 / ch.bpm / 4;
          ch.step = (ch.step + 1) % 16;
        }
      }
    }, 30);
  }

  /* Play a transition: primary full EQ, incoming mixed in concurrently.
   * fade>0 -> incoming ramps to full level over `fade` seconds with no low cut.
   * Otherwise incoming ramps over mixBeats with an optional low-frequency cut.
   * Uses real previews when available; per-side synth fallback if a file is missing. */
  async playTransition(primary, incoming, opts = {}) {
    const { seconds = 14, mixBeats = 8, cutoff = 200, fade = 0, loop = false } = opts;
    this.ensure();
    this._kill();
    const session = this._session;

    let pBuf = null, iBuf = null;
    try {
      if (primary.audioFile) pBuf = await this.loadFile(primary.audioFile);
      if (incoming.audioFile) iBuf = await this.loadFile(incoming.audioFile);
    } catch (e) {
      pBuf = null; iBuf = null; // offline or decode error -> synth fallback
    }
    if (session !== this._session) return; // superseded by a newer play/stop

    const t0 = this.ctx.currentTime + 0.08;
    const p = pBuf
      ? this.makeFileChannel(pBuf, null, 1, t0)
      : this.makeChannelSynth(primary, null, 1);
    const i = iBuf
      ? this.makeFileChannel(iBuf, cutoff, 0.0001, t0)
      : this.makeChannelSynth(incoming, cutoff, 0.0001);

    // different tempos -> both meet in the middle and play at the same BPM
    const meet = BrainAudio.meetBpm(primary.bpm, incoming.bpm);
    if (meet) {
      if (p.file) p.src.playbackRate.value = BrainAudio.rateFor(primary.bpm, meet);
      else p.bpm = meet;
      if (i.file) i.src.playbackRate.value = BrainAudio.rateFor(incoming.bpm, meet);
      else i.bpm = meet;
    }

    const ramp = fade > 0 ? fade : (60 / (meet || incoming.bpm)) * mixBeats;
    i.out.gain.setValueAtTime(0.0001, this.ctx.currentTime);
    i.out.gain.exponentialRampToValueAtTime(1, this.ctx.currentTime + ramp);

    for (const ch of [p, i]) {
      if (ch.file) { if (loop) ch.src.loop = true; }
      else ch.nextTime = this.ctx.currentTime;
    }
    this.channels = [p, i];
    this.startScheduler();
    if (!loop) this.stopTimer = setTimeout(() => this._kill(), seconds * 1000);
  }

  /* Play a single track with full EQ (e.g. when a node is clicked). */
  async playTrack(track, opts = {}) {
    const { seconds = 24, loop = false } = opts;
    this.ensure();
    this._kill();
    const session = this._session;

    let buf = null;
    try {
      if (track.audioFile) buf = await this.loadFile(track.audioFile);
    } catch (e) {
      buf = null; // synth fallback
    }
    if (session !== this._session) return;

    const t0 = this.ctx.currentTime + 0.08;
    const p = buf
      ? this.makeFileChannel(buf, null, 1, t0)
      : this.makeChannelSynth(track, null, 1);
    if (p.file) { if (loop) p.src.loop = true; }
    if (!p.file) p.nextTime = this.ctx.currentTime;
    this.channels = [p];
    this.startScheduler();
    if (!loop) {
      const dur = buf ? Math.min(seconds, buf.duration) : seconds;
      this.stopTimer = setTimeout(() => this._kill(), dur * 1000);
    }
  }

  /* ---------- path preview (Pathfinder) ----------
   * 4-bar segments keyed to each OUTGOING track's BPM:
   * solo 4 bars -> incoming fades in over 4 bars -> both play 4 bars
   * -> outgoing fades out over 4 bars -> repeat until end of path.
   * Returns { t0, total, kf } or null if superseded while loading. */
  buildTimeline(bpmList) {
    const n = bpmList.length;
    const kf = bpmList.map(() => []);
    const win = []; // win[i] = overlap window of tracks i and i+1 (t0-relative)
    let t = 0;
    for (let i = 0; i < n - 1; i++) {
      const s = 960 / (bpmList[i] || 120);
      const soloEnd = t + s;
      const inEnd = soloEnd + s;
      const bothEnd = inEnd + s;
      const outEnd = bothEnd + s;
      if (kf[i].length === 0) kf[i].push({ t: 0, v: 1 });
      kf[i].push({ t: bothEnd, v: 1 }, { t: outEnd, v: 0 });
      kf[i + 1].push({ t: soloEnd, v: 0 }, { t: inEnd, v: 1 });
      win.push({ s: soloEnd, e: outEnd });
      t = outEnd;
    }
    if (n >= 1) {
      const last = n - 1;
      const s = 960 / (bpmList[last] || 120);
      const soloEnd = t + s;
      const end = soloEnd + s;
      if (kf[last].length === 0) kf[last].push({ t: 0, v: 1 });
      kf[last].push({ t: soloEnd, v: 1 }, { t: end, v: 0 });
      t = end;
    }
    return { kf, total: t, win };
  }

  async playPath(tracks) {
    this.ensure();
    this._kill();
    const session = this._session;

    let bufs;
    try {
      bufs = await Promise.all(tracks.map(t => (t.audioFile ? this.loadFile(t.audioFile) : null)));
    } catch (e) {
      bufs = tracks.map(() => null); // offline / decode error -> synth fallback
    }
    if (session !== this._session) return null; // superseded while loading

    const tl = this.buildTimeline(tracks.map(t => t.bpm));
    const t0 = this.ctx.currentTime + 0.08;
    const now = this.ctx.currentTime;

    // tempo plans: own BPM while solo, the "meet in the middle" BPM while
    // overlapping a neighbour — so simultaneous tracks always share a tempo
    const n = tracks.length;
    const b = tracks.map(t => Number(t.bpm) || 120);
    const meet = (x, y) => BrainAudio.meetBpm(b[x], b[y]);

    const chans = tracks.map((tr, i) => {
      const buf = bufs[i];
      const ch = buf
        ? this.makeFileChannel(buf, null, 0, t0)
        : this.makeChannelSynth(tr, null, 0);
      if (ch.file) ch.src.loop = true; // keep 30s preview clips looping through the path

      const plan = [{ t: 0, bpm: i > 0 ? (meet(i - 1, i) || b[i]) : b[i] }];
      if (i > 0 && tl.win[i - 1]) plan.push({ t: tl.win[i - 1].e, bpm: b[i] });
      if (i < n - 1 && tl.win[i]) {
        plan.push({ t: tl.win[i].s, bpm: meet(i, i + 1) || b[i] });
        plan.push({ t: tl.win[i].e, bpm: b[i] });
      }
      if (ch.file) {
        const pr = ch.src.playbackRate;
        pr.setValueAtTime(BrainAudio.rateFor(b[i], plan[0].bpm), now);
        for (let k = 1; k < plan.length; k++) {
          const tt = t0 + plan[k].t;
          const rs = Math.max(now + 0.01, tt - 0.25);
          pr.linearRampToValueAtTime(BrainAudio.rateFor(b[i], plan[k - 1].bpm), rs);
          pr.linearRampToValueAtTime(BrainAudio.rateFor(b[i], plan[k].bpm), tt);
        }
      } else {
        ch.bpm = plan[0].bpm;
        ch.tempoPlan = plan.slice(1).map(k => ({ at: t0 + k.t, bpm: k.bpm }));
        ch.tempoIdx = 0;
      }

      const kf = tl.kf[i];
      ch.out.gain.setValueAtTime(kf[0].v, now);
      for (const k of kf) ch.out.gain.linearRampToValueAtTime(k.v, t0 + k.t);
      if (ch.src && ch.src.stop) { try { ch.src.stop(t0 + tl.total + 0.5); } catch (e) { /* noop */ } }
      return ch;
    });

    this.pathActive = true;
    for (const ch of chans) if (!ch.file) ch.nextTime = now;
    this.channels = chans;
    this.startScheduler();
    this.stopTimer = setTimeout(() => this._kill(), (tl.total + 0.6) * 1000);
    return { t0, total: tl.total, kf: tl.kf };
  }

  stop() { this._kill(); }

  _kill() {
    this._session++;
    this.pathActive = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; }
    if (!this.ctx) { this.channels = []; return; }
    const now = this.ctx.currentTime;
    for (const ch of this.channels) {
      try {
        ch.out.gain.cancelScheduledValues(now);
        ch.out.gain.setValueAtTime(Math.max(ch.out.gain.value, 0.0001), now);
        ch.out.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
      } catch (e) { /* noop */ }
      if (ch.src) { try { ch.src.stop(now + 0.15); } catch (e) { /* noop */ } }
      setTimeout(() => { try { ch.out.disconnect(); } catch (e) { /* noop */ } }, 250);
    }
    this.channels = [];
  }
}
