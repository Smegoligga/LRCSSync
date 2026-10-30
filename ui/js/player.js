// Audio playback. Uses an <audio> element (keeps pitch at slow speeds); if that can't play the file
// or its clock doesn't move (happens with some Linux webviews), switches to Web Audio.

export class Player extends EventTarget {
  constructor(el) {
    super();
    this.el = el;
    this.engine = 'media';
    this.rate = 1;
    this.bytes = null;
    this.buffer = null;
    this.ctx = null;
    this.src = null;
    this.offset = 0;
    this.anchor = 0;
    this._paused = true;
    for (const ev of ['play', 'pause', 'ended']) {
      el.addEventListener(ev, () => { if (this.engine === 'media') this.dispatchEvent(new Event(ev)); });
    }
  }

  load(bytes) {
    this.stopWeb();
    this.el.pause();
    if (this.url) URL.revokeObjectURL(this.url);
    this.bytes = bytes;
    this.buffer = null;
    this.engine = 'media';
    this.offset = 0;
    this._paused = true;
    this.url = URL.createObjectURL(new Blob([bytes]));
    this.el.src = this.url;
    this.el.preservesPitch = true;
    this.el.webkitPreservesPitch = true;
    this.el.playbackRate = this.rate;
  }

  get paused() { return this.engine === 'media' ? this.el.paused : this._paused; }

  get currentTime() {
    if (this.engine === 'media') return this.el.currentTime || 0;
    if (this._paused || !this.ctx) return this.offset;
    return this.offset + (this.ctx.currentTime - this.anchor) * this.rate;
  }

  set currentTime(t) {
    if (this.engine === 'media') { try { this.el.currentTime = t; } catch { /* not loaded */ } return; }
    const playing = !this._paused;
    if (playing) this.stopWeb();
    this.offset = Math.max(0, t);
    if (playing) this.startWeb();
  }

  get playbackRate() { return this.rate; }
  set playbackRate(r) {
    const t = this.currentTime;
    this.rate = r;
    this.el.playbackRate = r;
    if (this.engine === 'web' && !this._paused) { this.stopWeb(); this.offset = t; this.startWeb(); }
  }

  async play() {
    if (!this.bytes) return;
    if (this.engine === 'web') return this.playWeb();
    const start = this.el.currentTime;
    try {
      await this.el.play();
    } catch (e) {
      console.warn('media element failed, using Web Audio', e);
      return this.switchToWeb(start);
    }
    clearTimeout(this.watch);
    this.watch = setTimeout(() => {
      if (this.engine === 'media' && !this.el.paused && Math.abs(this.el.currentTime - start) < 0.05) {
        console.warn('media clock not moving, using Web Audio');
        this.switchToWeb(start);
      }
    }, 900);
  }

  pause() {
    if (this.engine === 'media') { this.el.pause(); return; }
    if (this._paused) return;
    this.offset = this.currentTime;
    this.stopWeb();
    this._paused = true;
    this.dispatchEvent(new Event('pause'));
  }

  async switchToWeb(at) {
    this.el.pause();
    this.engine = 'web';
    this.offset = at;
    this.dispatchEvent(new Event('engine'));
    return this.playWeb();
  }

  async playWeb() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (!this.buffer) {
      const copy = this.bytes.slice().buffer;
      this.buffer = await new Promise((res, rej) => {
        const p = this.ctx.decodeAudioData(copy, res, rej);
        if (p && p.then) p.then(res, rej);
      });
    }
    if (this.offset >= this.buffer.duration) this.offset = 0;
    this._paused = false;
    this.startWeb();
    this.dispatchEvent(new Event('play'));
  }

  startWeb() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.rate;
    src.connect(this.ctx.destination);
    src.onended = () => {
      if (this.src !== src) return;
      this.src = null;
      this.offset = this.buffer.duration;
      this._paused = true;
      this.dispatchEvent(new Event('ended'));
    };
    this.anchor = this.ctx.currentTime;
    src.start(0, Math.min(this.offset, this.buffer.duration));
    this.src = src;
  }

  stopWeb() {
    const s = this.src;
    this.src = null;
    if (s) { try { s.stop(); } catch { /* already stopped */ } s.disconnect(); }
  }
}
