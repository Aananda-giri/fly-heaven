import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeActivity, regionRates } from '../brain-data.js';

function frame(counts, tick=3, durationMs=50) {
  const buffer=new ArrayBuffer(16+counts.length*2), view=new DataView(buffer);
  view.setUint32(0,0x31424846,true);view.setUint32(4,tick,true);view.setUint32(8,counts.length,true);view.setFloat32(12,durationMs,true);
  new Uint16Array(buffer,16).set(counts);return buffer;
}
test('activity preserves neuron order, counts and simulated duration',()=>{
  const data=decodeActivity(frame([0,1,4,0]),4);
  assert.equal(data.tick,3);assert.equal(data.durationMs,50);assert.deepEqual([...data.counts],[0,1,4,0]);
});
test('an incomplete frame or an incompatible atlas is rejected',()=>{
  assert.throws(()=>decodeActivity(new ArrayBuffer(12),4));
  assert.throws(()=>decodeActivity(frame([1,2]),4));
  assert.throws(()=>decodeActivity(frame([1],0,0),1));
});
test('regional Hz uses all cells, including cells without displayable soma locations',()=>{
  assert.deepEqual(regionRates(new Uint16Array([1,0,3,0]),new Uint8Array([0,0,1,1]),3,50),[10,30,0]);
});
