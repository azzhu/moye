import test from 'node:test';
import assert from 'node:assert/strict';
import { installTableTools } from './table-tools.js';

// Small DOM fixture for exercising pointer and form events without a browser.
class TableTestElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.nodeType = 1; this.children = []; this.dataset = {};
    this.style = { removeProperty(key) { delete this[key === 'table-layout' ? 'tableLayout' : key]; } };
    this.listeners = new Map(); this.hidden = false; this.offsetWidth = 290; this.offsetHeight = 35;
    this.classList = { add() {}, remove() {} };
  }
  append(...nodes) { nodes.forEach(n => { n.parentElement = this; this.children.push(n); }); }
  prepend(node) { node.parentElement = this; this.children.unshift(node); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n => n !== this); this.parentElement = null; }
  contains(node) { return this === node || this.children.some(n => n.contains(node)); }
  closest(selector) { return (selector === '.preview-scroll' ? this.className === 'preview-scroll' : this.tagName.toLowerCase() === selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelector(selector) {
    if (selector === ':scope > colgroup') return this.children.find(n => n.tagName === 'COLGROUP') || null;
    return this.children.find(n => n.tagName.toLowerCase() === selector) || this.children.map(n => n.querySelector(selector)).find(Boolean) || null;
  }
  setAttribute() {}
  hasAttribute(name) { return name === 'data-table-reset' && !!this.resetButton; }
  addEventListener(name, listener) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(listener); }
  fire(name, properties = {}) {
    const event = { target: this, button: 0, buttons: 0, pointerId: 1, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...properties };
    for (const listener of this.listeners.get(name) || []) listener(event);
    return event;
  }
  setPointerCapture(id) { this.captured = id; }
  hasPointerCapture(id) { return this.captured === id; }
  releasePointerCapture() { this.captured = null; }
  blur() { globalThis.document.activeElement = null; this.fire('change'); }
  focus() { globalThis.document.activeElement = this; }
  set innerHTML(value) {
    if (!value.includes('data-table-width')) return;
    this.append(new TableTestElement('input'));
    for (const width of [60, 80, 100]) { const button = new TableTestElement('button'); button.dataset.tableWidth = String(width); this.append(button); }
    const reset = new TableTestElement('button'); reset.resetButton = true; this.append(reset);
  }
  get rows() {
    const collect = node => node.children.flatMap(n => n.tagName === 'TR' ? [n] : collect(n));
    return collect(this);
  }
  get cells() { return this.children; }
  getBoundingClientRect() {
    if (this.tagName === 'TABLE') {
      const width = 600 * (parseFloat(this.style.width) || 100) / 100;
      return { left: 100, right: 100 + width, top: 240, bottom: 360, width, height: 120 };
    }
    if (this.tagName === 'TH') {
      const table = this.closest('table'); const rect = table.getBoundingClientRect();
      const columns = table.querySelector(':scope > colgroup')?.children.map(n => parseFloat(n.style.width)) || [50, 50];
      const index = this.parentElement.children.indexOf(this);
      const left = rect.left + columns.slice(0, index).reduce((a, b) => a + b, 0) / 100 * rect.width;
      const width = columns[index] / 100 * rect.width;
      return { left, right: left + width, width, top: 240, bottom: 270 };
    }
    return { left: 80, right: 900, top: 150, bottom: 650, width: 820, height: 500 };
  }
}

function tableToolFixture(run) {
  const names = ['document', 'window', 'ResizeObserver', 'MutationObserver', 'requestAnimationFrame'];
  const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  try {
    const document = new TableTestElement(); document.body = new TableTestElement('body'); document.activeElement = null;
    document.createElement = tag => new TableTestElement(tag);
    const window = new TableTestElement(); window.innerWidth = 1000;
    let selection = { rangeCount: 0, anchorNode: null, focusNode: null };
    window.getSelection = () => selection;
    Object.assign(globalThis, { document, window, ResizeObserver: class { observe() {} }, MutationObserver: class { observe() {} }, requestAnimationFrame: () => 1 });
    const scroll = new TableTestElement(); scroll.className = 'preview-scroll';
    const editor = new TableTestElement('article'); scroll.append(editor);
    const table = new TableTestElement('table'); const row = new TableTestElement('tr'); row.append(new TableTestElement('th'), new TableTestElement('th')); table.append(row); editor.append(table);
    let editable = true;
    const calls = { begins: 0, commits: [], busy: [] };
    const controller = installTableTools({ editor, canEdit: () => editable, begin: () => calls.begins++, commit: () => calls.commits.push(table.dataset.tableLayout || ''), busy: value => calls.busy.push(value) });
    const [panel, handle] = document.body.children;
    const select = (anchorNode, focusNode = anchorNode) => {
      editor.focus(); selection = { rangeCount: 1, anchorNode, focusNode }; document.fire('selectionchange');
    };
    const start = () => { editor.fire('pointermove', { target: row.children[0], clientX: row.children[0].getBoundingClientRect().right }); handle.fire('pointerdown', { clientX: row.children[0].getBoundingClientRect().right }); };
    run({ document, editor, table, panel, handle, controller, calls, start, select, readonly: () => { editable = false; } });
  } finally {
    names.forEach((name, index) => previous[index] ? Object.defineProperty(globalThis, name, previous[index]) : delete globalThis[name]);
  }
}

test('table width presets, manual input and reset affect only the selected table', () => tableToolFixture(({ editor, table, panel, calls, select }) => {
  select(table.rows[0].cells[0]);
  editor.fire('click', { target: table.rows[0].cells[0] });
  assert.equal(panel.hidden, false);
  panel.fire('click', { target: panel.children.find(n => n.dataset.tableWidth === '80') });
  assert.equal(table.style.width, '80%'); assert.equal(calls.commits.length, 1);
  const input = panel.querySelector('input'); input.value = '55'; input.fire('change');
  assert.equal(table.style.width, '55%'); assert.equal(calls.commits.length, 2);
  input.value = '5'; input.fire('change');
  assert.equal(table.style.width, '55%'); assert.equal(calls.commits.length, 2);
  panel.fire('click', { target: panel.children.find(n => n.resetButton) });
  assert.equal(table.dataset.tableLayout, undefined); assert.equal(table.style.width, undefined);
  assert.equal(calls.commits.length, 3);
}));

test('table width panel follows the caret into and out of the first row', () => tableToolFixture(({ editor, table, panel, select }) => {
  const bodyRow = new TableTestElement('tr');
  bodyRow.append(new TableTestElement('td'), new TableTestElement('td')); table.append(bodyRow);
  const paragraph = new TableTestElement('p'); editor.append(paragraph);
  select(bodyRow.cells[0]);
  editor.fire('click', { target: bodyRow.cells[0] });
  assert.equal(panel.hidden, true);
  const headerText = { nodeType: 3, parentElement: table.rows[0].cells[0] };
  select(headerText);
  assert.equal(panel.hidden, false);
  select(table.rows[0].cells[1]);
  assert.equal(panel.hidden, false);
  select(bodyRow.cells[1]);
  assert.equal(panel.hidden, true);
  select(headerText, bodyRow.cells[0]);
  assert.equal(panel.hidden, true);
  select(headerText);
  select(paragraph);
  assert.equal(panel.hidden, true);
}));

test('hovering column boundaries does not show the table width panel or change its target', () => tableToolFixture(({ editor, table, panel, handle, select, calls }) => {
  const otherTable = new TableTestElement('table'); const row = new TableTestElement('tr');
  row.append(new TableTestElement('th'), new TableTestElement('th')); otherTable.append(row); editor.append(otherTable);
  const hover = () => editor.fire('pointermove', { target: row.cells[0], clientX: row.cells[0].getBoundingClientRect().right });
  hover();
  assert.equal(panel.hidden, true); assert.equal(handle.hidden, false);
  select(table.rows[0].cells[0]); hover();
  assert.equal(panel.hidden, false);
  panel.fire('click', { target: panel.children.find(n => n.dataset.tableWidth === '80') });
  assert.equal(table.style.width, '80%'); assert.equal(otherTable.style.width, undefined);
  assert.equal(calls.commits.length, 1);
}));

test('editing the panel input keeps it visible and moving focus away hides it', () => tableToolFixture(({ document, editor, table, panel, select }) => {
  select(table.rows[0].cells[0]);
  const input = panel.querySelector('input'); input.focus();
  document.fire('selectionchange');
  assert.equal(panel.hidden, false);
  input.value = '65'; input.fire('change');
  assert.equal(table.style.width, '65%');
  new TableTestElement('textarea').focus(); document.fire('focusin');
  assert.equal(panel.hidden, true);
  editor.fire('click', { target: table });
  assert.equal(panel.hidden, true);
}));

test('pointer movement previews column widths and commits exactly once on release', () => tableToolFixture(({ start, handle, table, calls }) => {
  start();
  handle.fire('pointermove', { clientX: 460 });
  handle.fire('pointermove', { clientX: 520 });
  assert.deepEqual(JSON.parse(table.dataset.tableLayout).columns, [70, 30]);
  assert.equal(calls.commits.length, 0);
  handle.fire('pointerup'); handle.fire('lostpointercapture');
  assert.equal(calls.commits.length, 1);
  assert.deepEqual(calls.busy, [true, false]);
  assert.equal(table.querySelector(':scope > colgroup').children.length, 2);
}));

test('Escape, pointer cancellation and switching documents restore original layout without saving', () => {
  for (const cancel of ['escape', 'pointercancel', 'switch']) tableToolFixture(({ start, handle, table, calls, document, controller }) => {
    start(); handle.fire('pointermove', { clientX: 490 });
    if (cancel === 'escape') document.fire('keydown', { key: 'Escape' });
    if (cancel === 'pointercancel') handle.fire('pointercancel');
    if (cancel === 'switch') controller.reset();
    assert.equal(table.dataset.tableLayout, undefined);
    assert.equal(table.querySelector(':scope > colgroup'), null);
    assert.equal(calls.commits.length, 0);
    assert.deepEqual(calls.busy, [true, false]);
  });
});

test('readonly documents never show editing controls or accept resize changes', () => tableToolFixture(({ readonly, editor, table, panel, start, handle, calls }) => {
  readonly(); editor.fire('click', { target: table.rows[0].cells[0] });
  start(); handle.fire('pointermove', { clientX: 490 }); handle.fire('pointerup');
  assert.equal(panel.hidden, true); assert.equal(calls.begins, 0); assert.equal(calls.commits.length, 0);
}));
