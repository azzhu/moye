import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTableLayout, parseTableLayout, resizeTableColumns } from './table-layout.js';

test('table layout normalizes column proportions and validates all numeric metadata', () => {
  assert.deepEqual(normalizeTableLayout({ width: 80, columns: [10, 30] }, 2), { width: 80, columns: [25, 75] });
  assert.deepEqual(parseTableLayout('{"width":60}', 2), { width: 60, columns: [] });
  for (const value of [null, [], { width: NaN }, { width: Infinity }, { width: '80' }, { columns: [0, 100] }, { columns: [1] }, { columns: [NaN, 50] }, { columns: [Number.MIN_VALUE, 100] }]) {
    assert.equal(normalizeTableLayout(value, 2), null);
  }
});

test('column resizing changes only the two neighbors and keeps total table width', () => {
  const original = [20, 50, 30];
  assert.deepEqual(resizeTableColumns(original, 1, 80, 800), [20, 60, 20]);
  assert.deepEqual(original, [20, 50, 30]);
  const right = resizeTableColumns(original, 0, 9999, 800);
  assert.deepEqual(right, [64, 6, 30]);
  const left = resizeTableColumns(original, 0, -9999, 800);
  assert.deepEqual(left, [6, 64, 30]);
  assert.equal(left.reduce((a, b) => a + b), 100);
});

test('narrow tables avoid negative or disappearing columns and invalid drags are ignored', () => {
  assert.deepEqual(resizeTableColumns([20, 20, 60], 0, 100, 100), [20, 20, 60]);
  assert.deepEqual(resizeTableColumns([40, 60], 0, 10, 0), [40, 60]);
  assert.deepEqual(resizeTableColumns([40, 60], 1, 10, 500), [40, 60]);
});
