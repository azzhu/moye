import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceIndentation, installIndentationShortcuts } from './indentation.js';

function apply(value, start, end, outdent = false) {
  const edit = sourceIndentation(value, start, end, outdent);
  return { value: value.slice(0, edit.start) + edit.text + value.slice(edit.end), start: edit.selectionStart, end: edit.selectionEnd };
}

test('source Tab inserts two spaces at caret and Shift+Tab removes only current line indentation', () => {
  assert.deepEqual(apply('- one', 2, 2), { value: '-   one', start: 4, end: 4 });
  assert.deepEqual(apply('  - one', 4, 4, true), { value: '- one', start: 2, end: 2 });
  assert.deepEqual(apply('\t- one', 1, 1, true), { value: '- one', start: 0, end: 0 });
  assert.deepEqual(apply(' - one', 1, 1, true), { value: '- one', start: 0, end: 0 });
  assert.deepEqual(apply('  - one', 0, 0, true), { value: '- one', start: 0, end: 0 });
  assert.deepEqual(apply('- one', 3, 3, true), { value: '- one', start: 3, end: 3 });
  assert.deepEqual(apply('\ntext', 0, 0), { value: '  \ntext', start: 2, end: 2 });
});

test('selected source lines indent together, retain selection, and exclude an unselected next line', () => {
  const original = '- first\n- second\n- third';
  const end = original.indexOf('- third');
  const indented = apply(original, 0, end);
  assert.deepEqual(indented, { value: '  - first\n  - second\n- third', start: 2, end: end + 4 });
  const restored = apply(indented.value, indented.start, indented.end, true);
  assert.equal(restored.value, original);
  assert.equal(restored.start, 0); assert.equal(restored.end, end);
  const mid = apply(original, 2, 12);
  assert.equal(mid.value.slice(mid.start, mid.end), 'first\n  - se');
  assert.equal(apply(original, 0, original.length).value, '  - first\n  - second\n  - third');
});

test('read-only, composition, non-Tab and modified key presses never inspect or change the editor', () => {
  let handler;
  const editor = { addEventListener(type, fn) { assert.equal(type, 'keydown'); handler = fn; } };
  let enabled = false;
  installIndentationShortcuts({ editor, enabled: () => enabled, before() { assert.fail(); }, commit() { assert.fail(); } });
  handler({ key: 'Tab', preventDefault() { assert.fail(); } });
  enabled = true;
  for (const event of [{ key: 'Enter' }, { key: 'Tab', ctrlKey: true }, { key: 'Tab', metaKey: true }, { key: 'Tab', altKey: true }, { key: 'Tab', isComposing: true }]) handler(event);
});
