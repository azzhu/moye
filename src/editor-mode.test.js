import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const main = await readFile(new URL('./main.js', import.meta.url), 'utf8');
const functionSource = name => main.slice(main.indexOf(`function ${name}(`), main.indexOf('\n}\n', main.indexOf(`function ${name}(`)) + 3);

test('startup keeps source preferences and migrates old split settings to visual mode', () => {
  const startup = main.slice(main.indexOf('const STORAGE_KEY'), main.indexOf('const current ='));
  for (const [savedMode, expected] of [[undefined, 'visual'], ['split', 'visual'], ['source', 'source'], ['visual', 'visual'], ['unknown', 'visual']]) {
    const context = vm.createContext({
      localStorage: { getItem: () => savedMode === undefined ? null : JSON.stringify({ documents: [], mode: savedMode }) },
      migrateHistory: documents => documents,
    });
    vm.runInContext(`${startup}\nglobalThis.restoredMode = mode;`, context);
    assert.equal(context.restoredMode, expected);
  }
});

test('switching modes preserves Markdown exactly and keeps the selector and saved preference in sync', () => {
  const original = '# 文档\n\n-   保留原有格式\n\n';
  const source = { value: original };
  const visual = { innerHTML: '<h1>文档</h1>' };
  const area = { dataset: {} };
  const selector = {};
  const buttons = ['source', 'visual'].map(mode => ({
    dataset: { displayMode: mode }, selected: false, pressed: null,
    classList: { toggle(name, selected) { buttons.find(button => button.dataset.displayMode === mode).selected = selected; } },
    setAttribute(name, value) { this.pressed = value; },
  }));
  const calls = { resets: 0, saved: [] };
  const context = vm.createContext({
    source, visual, mode: 'visual',
    $: selector => selector === '.editing-area' ? area : context.selector,
    $$: () => buttons,
    selector,
    tableTools: { reset: () => calls.resets++ },
    save: () => calls.saved.push(context.mode),
  });
  vm.runInContext(functionSource('setMode'), context);
  for (const value of ['source', 'visual', 'split']) {
    context.setMode(value);
    assert.equal(area.dataset.mode, value === 'source' ? 'source' : 'visual');
    assert.equal(buttons.find(button => button.selected).dataset.displayMode, area.dataset.mode);
    assert.equal(buttons.find(button => button.selected).pressed, 'true');
    assert.equal(selector.title, `显示模式：${area.dataset.mode === 'source' ? '源码' : '可视化'}`);
    assert.equal(calls.saved.at(-1), area.dataset.mode);
    assert.equal(source.value, original);
    assert.equal(visual.innerHTML, '<h1>文档</h1>');
  }
  assert.equal(calls.resets, 3);
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
