import assert from 'node:assert/strict';
import { test } from '@omochi-ui/core/testing';
import { placePanel } from '../src/layout.js';
import { overlaps, type Panel } from '../src/contracts.js';
const panel = (id: string, x: number, y: number): Panel => ({ id, title: id, x, y, w: 6, h: 6,
  reference: { nodeId: 'aaaaaaaaaaaaaaaa', serviceId: id, surfaceId: 'main' } });
test('moving a panel pushes collisions down without moving adjacent columns', () => {
  const a = panel('a', 0, 0), b = panel('b', 0, 6), c = panel('c', 6, 0);
  const result = placePanel([a, b, c], { ...b, y: 0 });
  assert.equal(result.find(p => p.id === 'a')!.y, 6);
  assert.equal(result.find(p => p.id === 'c')!.y, 0);
  assert.equal(a.y, 0);
  for (const p of result) for (const q of result) if (p !== q) assert.equal(overlaps(p, q), false);
});
test('resizing pushes all collisions and movement stays in the twelve-column grid', () => {
  const a = panel('a', 0, 0), b = panel('b', 6, 0), c = panel('c', 6, 6);
  const result = placePanel([a, b, c], { ...a, w: 12, h: 10 });
  assert.equal(result.find(p => p.id === 'b')!.y, 10);
  assert.equal(result.find(p => p.id === 'c')!.y, 16);
  assert.equal(placePanel([a], { ...a, x: 99 })[0]!.x, 6);
  assert.equal(placePanel([a], { ...a, x: -2, y: -1 })[0]!.y, 0);
});
