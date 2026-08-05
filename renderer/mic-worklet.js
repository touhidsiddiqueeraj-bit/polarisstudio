// mic capture worklet: accumulates PCM, posts a 3s Float32Array per chunk.
// Served same-origin (STATIC map) so the strict CSP ('self') allows loading it.
class PolarMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = [];
    this.bytes = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) { this.buf.push(new Float32Array(ch)); this.bytes += ch.length * 4; }
    if (this.bytes >= sampleRate * 3 * 4) this.emit();
    return true;
  }
  emit() {
    const len = this.buf.reduce((n, b) => n + b.length, 0);
    const all = new Float32Array(len);
    let o = 0;
    for (const b of this.buf) { all.set(b, o); o += b.length; }
    this.buf = [];
    this.bytes = 0;
    this.port.postMessage(all.buffer, [all.buffer]);
  }
}
registerProcessor('polaris-mic', PolarMic);
