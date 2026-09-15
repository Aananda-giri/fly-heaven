import test from 'node:test';
import assert from 'node:assert/strict';
import { ForestNavigation } from '../navigation.js';

test('body clearance stays inside the simulated clearing', () => {
  const nav = new ForestNavigation();
  assert.deepEqual(nav.constrain(20, -20, 0.012), [0.588, -0.388]);
});

test('interpolated motion cannot tunnel through a rock', () => {
  const nav = new ForestNavigation();
  nav.addCircle(0, 0, 0.025, 0.04);
  const [x, z] = nav.move(-0.1, 0.006, 0.1, 0.006, 0.012, 0);
  assert.ok(Math.hypot(x, z) >= 0.037);
  // A frame crossing the entire obstacle must slide around it.
  assert.ok(z > 0.006);
});

test('twigs protect their length and both ends', () => {
  const nav = new ForestNavigation();
  nav.addCapsule(-0.08, 0, 0.08, 0, 0.004, 0.01);
  for (const startX of [-0.085, 0, 0.085]) {
    const [x, z] = nav.move(startX, -0.05, startX, 0.05, 0.012, 0);
    const cx = Math.max(-0.08, Math.min(0.08, x));
    assert.ok(Math.hypot(x - cx, z) >= 0.016);
  }
});

test('airborne flies clear props only above the prop height', () => {
  const nav = new ForestNavigation();
  nav.addCircle(0, 0, 0.025, 0.04);
  assert.ok(Math.hypot(...nav.constrain(0, 0, 0.012, 0.02)) >= 0.037);
  assert.deepEqual(nav.constrain(0, 0, 0.012, 0.05), [0, 0]);
});

test('feeding targets inside fruit are moved to its surface clearance', () => {
  const nav = new ForestNavigation();
  nav.addCircle(-0.18, 0.11, 0.031, 0.034);
  const [x, z] = nav.constrain(-0.18, 0.11, 0.012);
  assert.ok(Math.hypot(x + 0.18, z - 0.11) >= 0.043);
});

test('a rock near an edge pushes the body back into the clearing', () => {
  const nav = new ForestNavigation();
  nav.addCircle(0.59, 0, 0.03, 0.04);
  const [x, z] = nav.constrain(0.6, 0, 0.012);
  assert.ok(Math.abs(x) <= 0.588 && Math.abs(z) <= 0.388);
  assert.ok(Math.hypot(x - 0.59, z) >= 0.042);
});

test('a feeding fly may reach into only the food it is eating', () => {
  const nav = new ForestNavigation();
  nav.addCircle(0, 0, 0.03, 0.04, 'apple');
  nav.addCircle(0.2, 0, 0.03, 0.04, 'orange');
  assert.deepEqual(nav.constrain(0.035, 0, 0.012, 0, 'apple'), [0.035, 0]);
  assert.ok(Math.hypot(...nav.constrain(0.035, 0, 0.012)) >= 0.042);
  assert.ok(0.2 - nav.constrain(0.19, 0, 0.012, 0, 'apple')[0] >= 0.042);
});

test('a fed fly keeps its allowance only while it still overlaps that food', () => {
  const nav = new ForestNavigation();
  nav.addCircle(0, 0, 0.03, 0.04, 'apple');
  assert.ok(nav.overlaps(0.035, 0, 0.012, 0, 'apple'));
  assert.ok(!nav.overlaps(0.043, 0, 0.012, 0, 'apple'));
  assert.ok(!nav.overlaps(0.035, 0, 0.012, 0, null));
});

test('a direct approach to a rock slides instead of freezing', () => {
  const nav = new ForestNavigation();
  nav.addCircle(0, 0, 0.025, 0.04);
  const [x, z] = nav.move(-0.1, 0, 0.1, 0, 0.012, 0);
  assert.ok(x > 0, 'the fly should make progress around the rock');
  assert.ok(Math.hypot(x, z) >= 0.037);
});
