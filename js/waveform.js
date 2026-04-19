/**
 * MixMind Waveform Renderer
 * Draws audio waveforms on canvas with animated playback cursor and transition zone highlights.
 */

class WaveformRenderer {
  constructor(canvas, color = '#7C3AED') {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.color = color;
    this.accentColor = '#06B6D4';
    this.audioBuffer = null;
    this.peaks = null;
    this.animFrame = null;
    this.getTime = null;       // function() → current playback seconds
    this.duration = 0;
    this.outPoint = null;
    this.inPoint = null;
    this._resize();
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
    this.W = rect.width;
    this.H = rect.height;
  }

  load(audioBuffer, outPoint = null, inPoint = null) {
    this.audioBuffer = audioBuffer;
    this.duration = audioBuffer.duration;
    this.outPoint = outPoint;
    this.inPoint = inPoint;
    this.peaks = this._computePeaks(audioBuffer, Math.floor(this.W));
    this._drawStatic();
  }

  _computePeaks(buffer, numBars) {
    const ch = buffer.getChannelData(0);
    const blockSize = Math.floor(ch.length / numBars);
    const peaks = [];
    for (let i = 0; i < numBars; i++) {
      let max = 0;
      const start = i * blockSize;
      for (let j = 0; j < blockSize; j++) {
        const abs = Math.abs(ch[start + j]);
        if (abs > max) max = abs;
      }
      peaks.push(max);
    }
    return peaks;
  }

  _drawStatic() {
    const { ctx: c, W, H, peaks, color } = this;
    c.clearRect(0, 0, W, H);

    // Background
    c.fillStyle = '#0F0F1A';
    c.fillRect(0, 0, W, H);

    if (!peaks) return;

    // Transition zones
    if (this.inPoint != null && this.duration > 0) {
      const x = (this.inPoint / this.duration) * W;
      const grad = c.createLinearGradient(x, 0, x + 40, 0);
      grad.addColorStop(0, 'rgba(16,185,129,0.25)');
      grad.addColorStop(1, 'rgba(16,185,129,0)');
      c.fillStyle = grad;
      c.fillRect(x, 0, 40, H);
    }
    if (this.outPoint != null && this.duration > 0) {
      const x = (this.outPoint / this.duration) * W;
      const grad = c.createLinearGradient(x - 40, 0, x, 0);
      grad.addColorStop(0, 'rgba(239,68,68,0)');
      grad.addColorStop(1, 'rgba(239,68,68,0.25)');
      c.fillStyle = grad;
      c.fillRect(x - 40, 0, 40, H);
    }

    // Waveform bars
    const midY = H / 2;
    const barW = Math.max(1, W / peaks.length - 0.5);

    peaks.forEach((peak, i) => {
      const x = (i / peaks.length) * W;
      const barH = peak * (H * 0.88);
      const barColor = this._barColor(i, peaks.length);
      c.fillStyle = barColor;
      c.fillRect(x, midY - barH, barW, barH * 2);
    });

    // Center line
    c.strokeStyle = 'rgba(255,255,255,0.05)';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(0, midY);
    c.lineTo(W, midY);
    c.stroke();

    // OUT marker
    if (this.outPoint != null && this.duration > 0) {
      const x = Math.round((this.outPoint / this.duration) * W);
      c.strokeStyle = '#EF4444';
      c.lineWidth = 2;
      c.setLineDash([4, 2]);
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
      c.setLineDash([]);
      c.fillStyle = '#EF4444';
      c.font = 'bold 9px Inter, sans-serif';
      c.fillText('OUT', x + 3, 12);
    }

    // IN marker
    if (this.inPoint != null && this.duration > 0) {
      const x = Math.round((this.inPoint / this.duration) * W);
      c.strokeStyle = '#10B981';
      c.lineWidth = 2;
      c.setLineDash([4, 2]);
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
      c.setLineDash([]);
      c.fillStyle = '#10B981';
      c.font = 'bold 9px Inter, sans-serif';
      c.fillText('IN', x + 3, H - 4);
    }
  }

  _barColor(i, total) {
    // Gradient from left (purple) to right (cyan)
    const t = i / total;
    const r1 = 124, g1 = 58, b1 = 237;   // #7C3AED purple
    const r2 = 6, g2 = 182, b2 = 212;    // #06B6D4 cyan
    const r = Math.round(r1 + (r2 - r1) * t);
    const g = Math.round(g1 + (g2 - g1) * t);
    const b = Math.round(b1 + (b2 - b1) * t);
    return `rgba(${r},${g},${b},0.85)`;
  }

  startAnimation(getTimeFn) {
    this.getTime = getTimeFn;
    this._tick();
  }

  stopAnimation() {
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
    this.animFrame = null;
    this.getTime = null;
  }

  _tick() {
    this._drawStatic();

    if (this.getTime && this.duration > 0) {
      const t = this.getTime();
      const x = (t / this.duration) * this.W;

      // Playhead
      const { ctx: c, H } = this;
      c.strokeStyle = '#FFFFFF';
      c.lineWidth = 2;
      c.shadowColor = '#7C3AED';
      c.shadowBlur = 8;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
      c.shadowBlur = 0;

      // Playhead triangle
      c.fillStyle = '#FFFFFF';
      c.beginPath();
      c.moveTo(x - 5, 0);
      c.lineTo(x + 5, 0);
      c.lineTo(x, 8);
      c.closePath();
      c.fill();
    }

    this.animFrame = requestAnimationFrame(() => this._tick());
  }

  clear() {
    this.stopAnimation();
    this.audioBuffer = null;
    this.peaks = null;
    this.outPoint = null;
    this.inPoint = null;
    const { ctx: c, W, H } = this;
    c.fillStyle = '#0F0F1A';
    c.fillRect(0, 0, W, H);
    c.fillStyle = 'rgba(255,255,255,0.06)';
    c.font = '13px Inter, sans-serif';
    c.textAlign = 'center';
    c.fillText('Drop audio file here', W / 2, H / 2);
    c.textAlign = 'left';
  }
}

window.WaveformRenderer = WaveformRenderer;
