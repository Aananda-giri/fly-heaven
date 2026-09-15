// Full activity uses the same ordered neurons as the exported soma atlas.
export function decodeActivity(buffer, expectedNeurons) {
  if (buffer.byteLength < 16) throw new Error('Incomplete brain activity');
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x31424846) throw new Error('Unknown brain activity format');
  const tick = view.getUint32(4, true), neurons = view.getUint32(8, true), durationMs = view.getFloat32(12, true);
  if (neurons !== expectedNeurons || buffer.byteLength !== 16 + neurons * 2 || !Number.isFinite(durationMs) || durationMs <= 0) throw new Error('Brain activity does not match atlas');
  return { tick, durationMs, counts: new Uint16Array(buffer, 16, neurons) };
}

export function regionRates(counts, regions, regionCount, durationMs) {
  const sums = new Float64Array(regionCount), totals = new Uint32Array(regionCount);
  for (let i = 0; i < counts.length; i++) { sums[regions[i]] += counts[i]; totals[regions[i]]++; }
  return Array.from(sums, (sum, i) => totals[i] ? sum / totals[i] * 1000 / durationMs : 0);
}
