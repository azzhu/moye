import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownInputRule, installMarkdownInputRules } from './input-rules.js';
import { inline } from './markdown.js';

test('paragraph shortcuts recognize only complete markers followed by an ASCII space', () => {
  for (const [marker, tag] of [['#', 'h1'], ['##', 'h2'], ['###', 'h3'], ['-', 'ul'], ['*', 'ul'], ['1.', 'ol'], ['>', 'blockquote']]) {
    assert.deepEqual(markdownInputRule(marker + ' '), { type: 'block', tag, length: marker.length + 1 });
  }
  for (const text of ['#', '##标题', '文字 # ', ' # ', '#\t', '#### ', '2. ', '-项目', '** ', '>引用', 'hello\n# ']) {
    assert.equal(markdownInputRule(text), null, text);
  }
});

test('inline shortcuts match at the caret and preserve delimiters elsewhere and escaped literals', () => {
  assert.deepEqual(markdownInputRule('前面 **重点**'), { type: 'inline', tag: 'strong', start: 3, end: 9, delimiter: 2 });
  assert.deepEqual(markdownInputRule('`a < b`'), { type: 'inline', tag: 'code', start: 0, end: 7, delimiter: 1 });
  for (const text of ['****', '** **', '** leading**', '**trailing **', '``', '``code``', '**a\nb**', '\\**literal**', '\\`literal`', '`**literal**', '***bold***', '**done** next']) {
    assert.equal(markdownInputRule(text), null, text);
  }
  assert.equal(markdownInputRule('\\\\**重点**').tag, 'strong');
  assert.equal(inline('\\`代码\\`'), '`代码`', 'undo restores literal code delimiters without reformatting');
  assert.equal(inline('\\*\\*重点\\*\\*'), '**重点**');
});

test('IME updates wait until composition ends and paste does not try a conversion', async () => {
  const listeners = new Map();
  const editor = { addEventListener(type, handler) { listeners.set(type, handler); } };
  let plain = 0;
  // A disabled editor must never attempt to inspect or alter the DOM selection.
  installMarkdownInputRules({ editor, enabled: () => false, before() { assert.fail(); }, commit() { assert.fail(); }, plain() { plain++; } });
  listeners.get('compositionstart')();
  listeners.get('input')({ isComposing: true, inputType: 'insertCompositionText' });
  assert.equal(plain, 0);
  listeners.get('compositionend')();
  listeners.get('input')({ inputType: 'insertText' });
  await Promise.resolve();
  assert.equal(plain, 1, 'IME completion is committed exactly once');
  listeners.get('paste')();
  listeners.get('input')({ inputType: 'insertText' });
  await Promise.resolve();
  assert.equal(plain, 2);
  listeners.get('input')({ inputType: 'deleteContentBackward' });
  assert.equal(plain, 3);
});
