import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { APPEARANCE_STORAGE_KEY, resolveReadingStyle } from './appearance.js';

const main = await readFile(new URL('./main.js', import.meta.url), 'utf8');
const functionSource = name => main.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0];

test('startup keeps source preferences and migrates old split settings to visual mode', () => {
  const startup = main.slice(main.indexOf('const STORAGE_KEY'), main.indexOf('const current ='));
  for (const [savedMode, expected] of [[undefined, 'visual'], ['split', 'visual'], ['source', 'source'], ['visual', 'visual'], ['unknown', 'visual']]) {
    const context = vm.createContext({
      localStorage: { getItem: () => savedMode === undefined ? null : JSON.stringify({ documents: [], mode: savedMode }) },
      migrateHistory: documents => documents, APPEARANCE_STORAGE_KEY, resolveReadingStyle,
    });
    vm.runInContext(`${startup}\nglobalThis.restoredMode = mode; globalThis.restoredEditing = editingEnabled;`, context);
    assert.equal(context.restoredMode, expected);
    assert.equal(context.restoredEditing, false);
  }
});

test('switching modes preserves Markdown exactly and updates the button hint and saved preference', () => {
  const original = '# 文档\n\n-   保留原有格式\n\n';
  const source = { value: original };
  const visual = { innerHTML: '<h1>文档</h1>' };
  const area = { dataset: {} };
  const selector = {};
  const calls = { resets: 0, saved: [] };
  const context = vm.createContext({
    source, visual, mode: 'visual',
    $: selector => selector === '.editing-area' ? area : context.selector,
    selector,
    tableTools: { reset: () => calls.resets++ },
    save: () => calls.saved.push(context.mode),
  });
  vm.runInContext(functionSource('setMode'), context);
  const toggleAction = main.match(/'display-mode': (\(\) => setMode\([^\n]+\)),/)[1];
  const toggle = vm.runInContext(toggleAction, context);
  for (const expected of ['source', 'visual', 'source', 'visual']) {
    toggle();
    assert.equal(area.dataset.mode, expected);
    assert.equal(selector.title, `当前：${expected === 'source' ? '源码' : '可视化'}；点击切换为${expected === 'source' ? '可视化' : '源码'}`);
    assert.equal(calls.saved.at(-1), area.dataset.mode);
    assert.equal(source.value, original);
    assert.equal(visual.innerHTML, '<h1>文档</h1>');
  }
  assert.equal(calls.resets, 4);
});

test('visual editing can switch out of source mode both before and during fullscreen', () => {
  for (const fullscreen of [false, true]) {
    const calls = [];
    const range = { selectNodeContents() {}, collapse() {} };
    const context = vm.createContext({
      editingEnabled: true, mode: 'source', activeId: 'one', openingHistoryId: null, savedRange: null,
      current: () => ({ id: 'one' }), fileWriters: new Map([['one', {}]]),
      document: { body: { classList: { contains: () => fullscreen } }, createRange: () => range },
      window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
      visual: { focus: () => calls.push('focus') },
      setMode: value => calls.push(value),
    });
    vm.runInContext(functionSource('canEditDocument') + functionSource('focusVisual'), context);
    assert.equal(context.focusVisual(), true);
    assert.deepEqual(calls, ['visual', 'focus']);
  }
});

function editablePage() {
  const element = () => ({ setAttribute(key, value) { this[key] = value; }, querySelector() { return this.label ||= {}; } });
  const elements = new Map();
  const get = selector => {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  };
  const checkbox = {};
  const visual = { ...element(), querySelectorAll: () => [checkbox] };
  const doc = { id: 'one', markdown: '# 保留原文', fileDirty: true };
  const calls = { reset: 0, authorized: 0, saves: 0 };
  const context = vm.createContext({
    editingEnabled: false, activeId: 'one', openingHistoryId: null,
    current: () => doc, fileWriters: new Map([['one', {}]]),
    source: element(), visual, resizingTable: false,
    $: get, $$: selector => [get(selector)],
    historyForDoc: () => ({ index: 1, entries: ['old', doc.markdown, 'future'] }),
    tableTools: { reset() { calls.reset++; } }, closePopovers() {},
    authorizeOriginalFile: async () => { calls.authorized++; },
    scheduleOriginalSave() { calls.saves++; },
    fileSaveTimers: new Map([['one', 123]]),
  });
  vm.runInContext(['canEditDocument', 'toggleEditingMode', 'updateFileEditability', 'updateHistoryButtons']
    .map(functionSource).join('\n'), context);
  return { context, doc, calls, checkbox, get };
}

test('read-only/edit toggle controls both editors, tasks and toolbar without changing drafts or pending saves', async () => {
  const { context, doc, calls, checkbox, get } = editablePage();
  for (const editable of [false, true, false]) {
    if (editable !== context.editingEnabled) await context.toggleEditingMode();
    else { context.updateFileEditability(); context.updateHistoryButtons(); }
    assert.equal(context.source.readOnly, !editable);
    assert.equal(context.visual.contentEditable, String(editable));
    assert.equal(context.visual['aria-readonly'], String(!editable));
    assert.equal(checkbox.disabled, !editable);
    assert.equal(get('[data-action="edit-mode"]').querySelector('span').textContent, editable ? '编辑模式' : '只读模式');
    for (const action of ['bold', 'insert', 'table', 'undo', 'redo']) assert.equal(get(`[data-action="${action}"]`).disabled, !editable);
    assert.equal(doc.markdown, '# 保留原文');
    assert.equal(doc.fileDirty, true);
    assert.equal(context.fileSaveTimers.get('one'), 123);
  }
  assert.equal(calls.authorized, 0);
  assert.equal(calls.saves, 0, 'toggling does not create additional document writes');
});

test('read-only blocks mutation entry points even when the original file is writable', () => {
  const { context, doc } = editablePage();
  for (const name of ['changed', 'format', 'insertBlock', 'showLink', 'focusVisual', 'applyHistory']) {
    vm.runInContext(functionSource(name), context);
    assert.doesNotThrow(() => context[name]());
    assert.equal(doc.markdown, '# 保留原文');
  }
  context.editingEnabled = true;
  context.fileWriters.clear();
  assert.equal(context.canEditDocument(), false);
  context.fileWriters.set('one', {});
  context.openingHistoryId = 'one';
  assert.equal(context.canEditDocument(), false);
});

test('entering edit mode requires a writable file and cannot enable a different document after authorization', async () => {
  const { context, calls } = editablePage();
  context.fileWriters.clear();
  await context.toggleEditingMode();
  assert.equal(calls.authorized, 1);
  assert.equal(context.editingEnabled, false, 'denied permission keeps read-only mode');
  context.authorizeOriginalFile = async () => { context.fileWriters.set('one', {}); };
  await context.toggleEditingMode();
  assert.equal(context.editingEnabled, true);
  await context.toggleEditingMode();
  context.fileWriters.clear();
  context.authorizeOriginalFile = async () => {
    context.fileWriters.set('one', {});
    context.current = () => ({ id: 'two' });
    context.activeId = 'two';
  };
  await context.toggleEditingMode();
  assert.equal(context.editingEnabled, false);
});
