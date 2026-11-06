import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { APPEARANCE_STORAGE_KEY, READING_STYLES, resolveReadingStyle, applyReadingStyle } from './appearance.js';

const main = await readFile(new URL('./main.js', import.meta.url), 'utf8');
const startup = main.slice(main.indexOf('const STORAGE_KEY'), main.indexOf('const current ='));
const functionSource = name => main.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0];
function page(storage = new Map()) {
  const root = { dataset: {}, style: { values: new Map([['--document-font-size', '19px'], ['--content-width', '960px']]),
    setProperty(key, value) { this.values.set(key, value); } } };
  const elements = { '#settings-current': {}, '#appearance-feedback': {}, '#modal': { open: true, close() { this.open = false; } } };
  const options = READING_STYLES.map(style => ({ dataset: { readingStyle: style.id }, setAttribute(key, value) { this[key] = value; } }));
  const context = vm.createContext({
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    migrateHistory: documents => documents, APPEARANCE_STORAGE_KEY, resolveReadingStyle, applyReadingStyle,
    document: { documentElement: root }, outlineTracking: { refresh() {} },
    $: selector => elements[selector], $$: () => options, toast() {},
  });
  vm.runInContext(startup + '\n' + ['applyTheme', 'selectReadingStyle'].map(functionSource).join('\n'), context);
  return { context, root, elements, options, storage };
}

test('style selection survives reload separately from documents and preserves reading preferences', () => {
  const markdown = '# 原文\n\n<span style="color: red">保留颜色</span>\n';
  const saved = JSON.stringify({ documents: [{ id: 'one', title: '原文', markdown }], fontSize: 19, contentWidth: 960 });
  const storage = new Map([['inkwell.workspace.v1', saved]]);
  const first = page(storage);
  for (const style of READING_STYLES) {
    first.elements['#modal'].open = true;
    first.context.selectReadingStyle(style.id);
    assert.equal(first.elements['#modal'].open, false, 'selecting a style closes settings immediately');
    assert.equal(first.root.dataset.style, style.id);
    assert.equal(first.options.filter(option => option['aria-pressed'] === 'true').length, 1);
    assert.equal(storage.get('inkwell.workspace.v1'), saved, 'changing appearance must not save or alter documents');
    assert.equal(first.root.style.values.get('--document-font-size'), '19px');
    assert.equal(first.root.style.values.get('--content-width'), '960px');
    assert.equal(vm.runInContext('fontSize', first.context), 19);
    assert.equal(vm.runInContext('contentWidth', first.context), 960);
    const restored = page(storage);
    restored.context.applyTheme();
    assert.equal(restored.root.dataset.style, style.id);
  }
  first.context.selectReadingStyle('default');
  for (const [token, value] of Object.entries(READING_STYLES[0].tokens)) {
    assert.equal(first.root.style.values.get(`--${token}`), value, 'returning to default resets all visual tokens');
  }
});

test('legacy dark preference migrates once and explicit appearance wins; unavailable storage still permits switching', () => {
  const storage = new Map([['inkwell.workspace.v1', JSON.stringify({ documents: [], dark: true })]]);
  const legacy = page(storage); legacy.context.applyTheme();
  assert.equal(legacy.root.dataset.style, 'midnight');
  legacy.context.selectReadingStyle('light');
  const restored = page(storage); restored.context.applyTheme();
  assert.equal(restored.root.dataset.style, 'light');
  assert.equal(restored.root.dataset.theme, 'light');
  restored.context.localStorage.setItem = () => { throw new Error('Storage disabled'); };
  assert.doesNotThrow(() => restored.context.selectReadingStyle('sage'));
  assert.equal(restored.root.dataset.style, 'sage');
  assert.match(restored.elements['#appearance-feedback'].textContent, /未记住/);
  assert.equal(resolveReadingStyle('unknown').id, 'default');
});

const luminance = hex => hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
  .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  .reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
test('all reading palettes maintain legible body, heading, quote and code text', () => {
  assert.equal(new Set(READING_STYLES.map(style => style.id)).size, 10);
  for (const { name, tokens } of READING_STYLES) {
    for (const [foreground, background] of [['reading-text', 'paper'], ['text', 'paper'], ['quote-text', 'quote-bg'], ['code-text', 'code-bg']]) {
      assert.ok(contrast(tokens[foreground], tokens[background]) >= 4.5, `${name}: ${foreground} contrast must be at least 4.5:1`);
    }
  }
});
