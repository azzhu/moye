import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { APPEARANCE_STORAGE_KEY, resolveReadingStyle } from './appearance.js';

const main = await readFile(new URL('./main.js', import.meta.url), 'utf8');
const functionSource = name => main.slice(main.indexOf(`function ${name}(`), main.indexOf('\n}\n', main.indexOf(`function ${name}(`)) + 3);

test('startup keeps source preferences and migrates old split settings to visual mode', () => {
  const startup = main.slice(main.indexOf('const STORAGE_KEY'), main.indexOf('const current ='));
  for (const [savedMode, expected] of [[undefined, 'visual'], ['split', 'visual'], ['source', 'source'], ['visual', 'visual'], ['unknown', 'visual']]) {
    const context = vm.createContext({
      localStorage: { getItem: () => savedMode === undefined ? null : JSON.stringify({ documents: [], mode: savedMode }) },
      migrateHistory: documents => documents, APPEARANCE_STORAGE_KEY, resolveReadingStyle,
    });
    vm.runInContext(`${startup}\nglobalThis.restoredMode = mode;`, context);
    assert.equal(context.restoredMode, expected);
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
      mode: 'source', activeId: 'one', openingHistoryId: null, savedRange: null,
      current: () => ({ id: 'one' }), fileWriters: new Map([['one', {}]]),
      document: { body: { classList: { contains: () => fullscreen } }, createRange: () => range },
      window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
      visual: { focus: () => calls.push('focus') },
      setMode: value => calls.push(value),
    });
    vm.runInContext(functionSource('focusVisual'), context);
    assert.equal(context.focusVisual(), true);
    assert.deepEqual(calls, ['visual', 'focus']);
  }
});
