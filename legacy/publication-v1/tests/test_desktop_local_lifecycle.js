const test = require('node:test');
const assert = require('node:assert/strict');
const { PreviewGeneration } = require('../desktop/core');

test('invalidated, closed, and superseded preview generations cannot commit late work', () => {
  const generation = new PreviewGeneration();
  const old = generation.begin();
  const current = generation.begin();
  assert.equal(generation.isCurrent(old), false);
  assert.equal(generation.isCurrent(current), true);
  generation.invalidate();
  assert.equal(generation.isCurrent(current), false);
  const pending = generation.begin();
  generation.close();
  assert.equal(generation.isCurrent(pending), false);
});
