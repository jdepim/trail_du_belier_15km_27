import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, createRng, createNoise2D, fbm2D, hashString, hash2, normalizeSeed } from '../../src/rng.js';

test('mulberry32 is deterministic and in [0,1)', () => {
  const a = mulberry32(123), b = mulberry32(123);
  for (let i = 0; i < 1000; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
});

test('createRng helpers stay in range and are reproducible', () => {
  const r = createRng(42), r2 = createRng(42);
  for (let i = 0; i < 500; i++) {
    const n = r.int(3, 7);
    assert.ok(n >= 3 && n <= 7 && Number.isInteger(n));
    assert.equal(n, r2.int(3, 7));
  }
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 2000; i++) counts[r.weighted({ a: 3, b: 1 })]++;
  assert.ok(counts.a > counts.b * 2, 'weights respected');
  assert.equal(createRng(7).fork('x').next(), createRng(7).fork('x').next());
  assert.notEqual(createRng(7).fork('x').next(), createRng(7).fork('y').next());
});

test('seed normalisation accepts numbers and strings', () => {
  assert.equal(normalizeSeed(12), 12);
  assert.equal(normalizeSeed('12'), 12);
  assert.equal(normalizeSeed('derive'), hashString('derive'));
  assert.equal(normalizeSeed(-1), 4294967295);
});

test('value noise is deterministic, bounded and continuous', () => {
  const n = createNoise2D(99), n2 = createNoise2D(99);
  let maxJump = 0;
  for (let i = 0; i < 400; i++) {
    const x = i * 0.037, y = i * 0.021;
    const v = n(x, y);
    assert.equal(v, n2(x, y));
    assert.ok(v >= 0 && v < 1);
    maxJump = Math.max(maxJump, Math.abs(n(x + 0.001, y) - v));
  }
  assert.ok(maxJump < 0.01, 'small input step gives small output step');
  const f = fbm2D(n, 3.3, 1.7, 4);
  assert.ok(f >= 0 && f < 1);
});

test('hash2 is a stable integer hash', () => {
  assert.equal(hash2(3, 4, 5), hash2(3, 4, 5));
  assert.notEqual(hash2(3, 4, 5), hash2(4, 3, 5));
  assert.ok(Number.isInteger(hash2(-7, 9, 1)) && hash2(-7, 9, 1) >= 0);
});
