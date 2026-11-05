import test from 'node:test';
import assert from 'node:assert/strict';
import { copyCodeText, refreshCodeCopyButtons } from './code-copy.js';

test('clipboard copies code exactly, including indentation, Unicode and trailing blank lines', async () => {
  const text = '\t  print("你好 <tag>")\n\n';
  const copied = [];
  await copyCodeText(text, { navigator: { clipboard: { writeText: async value => copied.push(value) } } });
  assert.deepEqual(copied, [text]);
});

function fallbackEnvironment(success = true) {
  const copied = [], calls = [], nodes = [];
  const originalRange = { cloneRange: () => ({ original: true }) };
  const selection = { rangeCount: 1, getRangeAt: () => originalRange, removeAllRanges: () => calls.push('clear selection'), addRange: range => calls.push(range) };
  const active = { selectionStart: 2, selectionEnd: 5, selectionDirection: 'backward', focus: () => calls.push('restore focus'), setSelectionRange: (...range) => calls.push(range) };
  const document = {
    activeElement: active,
    createElement: () => ({ style: {}, setAttribute() {}, select() { document.activeElement = this; }, remove() { nodes.splice(nodes.indexOf(this), 1); } }),
    body: { append: node => nodes.push(node) },
    execCommand(command) { assert.equal(command, 'copy'); copied.push(nodes[0].value); return success; },
  };
  return { environment: { document, getSelection: () => selection }, copied, calls, nodes };
}

test('local HTML clipboard fallback restores focus and selection even when copying is rejected', async () => {
  for (const success of [true, false]) {
    const setup = fallbackEnvironment(success);
    setup.environment.navigator = { clipboard: { writeText: async () => { throw new Error('denied'); } } };
    if (success) await copyCodeText('  a\n  b\n', setup.environment);
    else await assert.rejects(copyCodeText('  a\n  b\n', setup.environment), /复制失败/);
    assert.deepEqual(setup.copied, ['  a\n  b\n']);
    assert.equal(setup.nodes.length, 0);
    assert.deepEqual(setup.calls, ['restore focus', [2, 5, 'backward'], 'clear selection', { original: true }]);
  }
});

test('code buttons appear once per block, copy current code only, and report success or failure', async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousTimeout = globalThis.setTimeout;
  const timers = [], messages = [], copied = [];
  try {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({
      dataset: {}, listeners: {}, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(key, listener) { this.listeners[key] = listener; },
    }) } });
    globalThis.setTimeout = callback => timers.push(callback);
    const code = { textContent: '旧内容' };
    const pre = { children: [], querySelector(selector) { return selector === 'code' ? code : this.children.find(button => 'copyCode' in button.dataset); }, prepend(button) { this.children.unshift(button); } };
    const editor = { querySelectorAll: () => [pre] };
    let fail = false;
    const copy = async text => { if (fail) throw new Error('未获授权'); copied.push(text); };
    refreshCodeCopyButtons(editor, message => messages.push(message), copy);
    refreshCodeCopyButtons(editor, message => messages.push(message), copy);
    assert.equal(pre.children.length, 1);
    const button = pre.children[0];
    assert.equal(button.contentEditable, 'false');
    let prevented = false;
    button.listeners.pointerdown({ preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    code.textContent = '  编辑后的代码\n\n';
    const event = { preventDefault() {}, stopPropagation() {} };
    await button.listeners.click(event);
    assert.deepEqual(copied, ['  编辑后的代码\n\n']);
    assert.equal(button.title, '已复制'); assert.equal(button.disabled, false);
    assert.deepEqual(messages, ['代码已复制']);
    timers.shift()(); assert.equal(button.title, '复制代码');
    fail = true; await button.listeners.click(event);
    assert.equal(messages.at(-1), '未获授权'); assert.equal(button.disabled, false);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
    globalThis.setTimeout = previousTimeout;
  }
});
