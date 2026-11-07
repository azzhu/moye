import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const mainText = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const historyFunction = name => mainText.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0];

test('successive table layout changes undo individually and schedule the restored content for the original file', () => {
  const original = '| A | B |\n| --- | --- |\n';
  const narrow = '<!-- moye-table: {"width":60,"columns":[]} -->\n' + original;
  const columns = '<!-- moye-table: {"width":60,"columns":[25,75]} -->\n' + original;
  const doc = { id: 'one', markdown: original };
  const saved = [];
  const context = {
    editingEnabled: true, activeId: 'one', documents: [doc], current: () => doc, histories: new Map(),
    lastEditKind: null, lastEditTime: 0, savedRange: null, openingHistoryId: null, resizingTable: false,
    fileWriters: new Map([['one', {}]]), source: { value: original }, visual: { innerHTML: '' },
    tableTools: { reset() {} }, updateHistoryButtons() {}, updateStats() {}, renderDocumentList() {}, save() {},
    renderMarkdown: markdown => markdown, recentDocuments: documents => documents,
    serializeMarkdown: visual => visual.innerHTML,
    scheduleOriginalSave: doc => saved.push(doc.markdown),
  };
  const api = runInNewContext(['canEditDocument', 'historyForDoc', 'recordHistory', 'changed', 'applyHistory'].map(historyFunction).join('\n') + `
    ({ change(markdown) { historyForDoc(); lastEditKind = null; visual.innerHTML = markdown; changed('table-layout'); lastEditKind = null; }, undo() { applyHistory(-1); }, redo() { applyHistory(1); } });`, context);
  api.change(narrow); api.change(columns);
  assert.equal(doc.markdown, columns);
  assert.equal(context.source.value, columns);
  api.undo(); assert.equal(doc.markdown, narrow);
  api.undo(); assert.equal(doc.markdown, original);
  api.redo(); assert.equal(doc.markdown, narrow);
  assert.deepEqual(saved, [narrow, columns, narrow, original, narrow]);
});
