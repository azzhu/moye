import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { hasUnsavedFileChanges, isMissingOriginalFile } from './file-access.js';

const mainSource = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const functionSource = name => mainSource.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0];

function watcher({ dirty = false, disk = '外部内容', error, pending = false, active = 'one' } = {}) {
  const doc = { id: 'one', markdown: '网页内容', fileDirty: dirty };
  const calls = { refreshed: 0, messages: [], reads: 0, cleared: 0, rendered: 0 };
  const writer = { diskContent: '原始内容', async inspectExternal() {
    calls.reads++;
    if (error) throw error;
    return { content: disk, modified: 123 };
  } };
  const context = {
    current: () => doc, documents: [doc], activeId: active, document: { hidden: false },
    composingDocument: false, resizingTable: false, openingHistoryId: null, deletingRecords: new Set(), externalChecks: new Set(),
    fileWriteCounts: new Map(), fileWriters: new Map([[doc.id, writer]]),
    fileSaveStates: new Map(), fileSaveTimers: new Map(pending ? [[doc.id, 1]] : []),
    hasUnsavedFileChanges, isMissingOriginalFile, setOriginalFileMissing(doc, missing) { doc.fileMissing = missing; },
    clearTimeout() { calls.cleared++; }, renderFileSaveState() { calls.rendered++; }, save() {},
    toast(message) { calls.messages.push(message); },
    applyExternalContent(target, targetWriter, content) {
      calls.refreshed++; target.markdown = content; target.fileDirty = false; target.fileDiskContent = content; targetWriter.diskContent = content;
      context.fileSaveStates.delete(target.id);
    },
  };
  const check = runInNewContext(functionSource('checkExternalModification') + '\ncheckExternalModification', context);
  return { doc, writer, calls, context, check };
}

test('clean documents automatically refresh when external contents change', async () => {
  const setup = watcher();
  await setup.check();
  assert.equal(setup.doc.markdown, '外部内容');
  assert.equal(setup.calls.refreshed, 1);
  await setup.check();
  assert.equal(setup.calls.refreshed, 1);
  assert.equal(setup.calls.messages.length, 1);
});

test('a stale dirty flag or reverted edit does not prevent external refresh, even after a conflict', async () => {
  const setup = watcher({ dirty: true, pending: true });
  setup.doc.markdown = '原始内容';
  setup.context.fileSaveStates.set('one', { conflict: true, external: '之前的磁盘版本' });
  await setup.check();
  assert.equal(setup.doc.markdown, '外部内容');
  assert.equal(setup.doc.fileDirty, false);
  assert.equal(setup.context.fileSaveStates.has('one'), false);
  assert.equal(setup.context.fileSaveTimers.size, 0);
  assert.equal(setup.writer.diskContent, '外部内容');
});

test('a draft matching the current disk is acknowledged as saved instead of treated as an external conflict', async () => {
  const setup = watcher({ dirty: true, disk: '\uFEFF网页内容' });
  setup.context.fileSaveStates.set('one', { conflict: true, external: '旧磁盘版本' });
  await setup.check();
  assert.equal(setup.doc.markdown, '\uFEFF网页内容');
  assert.equal(setup.doc.fileDirty, false);
  assert.equal(setup.context.fileSaveStates.has('one'), false);
  await setup.check();
  assert.equal(setup.calls.refreshed, 1);
});

test('unsaved browser edits are preserved and the scheduled save is cancelled on conflict', async () => {
  const setup = watcher({ dirty: true, pending: true });
  await setup.check();
  assert.equal(setup.doc.markdown, '网页内容');
  assert.equal(setup.calls.refreshed, 0);
  assert.equal(setup.context.fileSaveTimers.size, 0);
  assert.equal(setup.context.fileSaveStates.get('one').conflict, true);
  assert.equal(setup.context.fileSaveStates.get('one').external, '外部内容');
  await setup.check();
  assert.equal(setup.calls.messages.length, 1);
});

test('own saves, inactive pages, composing and in-flight writes do not refresh the editor', async () => {
  const own = watcher({ disk: '原始内容' }); await own.check();
  assert.equal(own.calls.refreshed, 0);
  for (const skip of ['hidden', 'composition', 'write', 'deleting', 'history', 'table-resize']) {
    const setup = watcher();
    if (skip === 'hidden') setup.context.document.hidden = true;
    if (skip === 'composition') setup.context.composingDocument = true;
    if (skip === 'write') setup.context.fileWriteCounts.set('one', 1);
    if (skip === 'deleting') setup.context.deletingRecords.add('one');
    if (skip === 'history') setup.context.openingHistoryId = 'one';
    if (skip === 'table-resize') setup.context.resizingTable = true;
    await setup.check();
    assert.equal(setup.calls.reads, 0);
  }
});

test('rechecks edits, active document and write baseline after asynchronous file reads', async () => {
  for (const change of ['edit', 'switch', 'write', 'table-resize']) {
    const setup = watcher();
    setup.writer.inspectExternal = async () => {
      if (change === 'edit') setup.doc.fileDirty = true;
      if (change === 'switch') setup.context.activeId = 'other';
      if (change === 'write') setup.writer.diskContent = '新写入的基线';
      if (change === 'table-resize') setup.context.resizingTable = true;
      return { content: '外部内容', modified: 123 };
    };
    await setup.check();
    assert.equal(setup.calls.refreshed, 0);
    if (change === 'edit') assert.equal(setup.context.fileSaveStates.get('one').conflict, true);
  }
});

test('read failures preserve current content and do not clear an existing conflict', async () => {
  const setup = watcher({ error: new Error('读取失败') });
  await setup.check();
  assert.equal(setup.doc.markdown, '网页内容');
  assert.equal(setup.context.fileSaveStates.get('one').watchError, true);
  setup.context.fileSaveStates.set('one', { conflict: true, external: '磁盘内容' });
  await setup.check();
  assert.equal(setup.context.fileSaveStates.get('one').conflict, true);
});

test('conflicts pause further autosaves even if the user continues editing', () => {
  const setup = watcher();
  setup.context.fileSaveStates.set('one', { conflict: true });
  setup.context.setTimeout = () => { throw new Error('Conflict must not schedule a write'); };
  runInNewContext(functionSource('scheduleOriginalSave') + '\nscheduleOriginalSave(current());', setup.context);
  assert.equal(setup.doc.fileDirty, true);
  assert.equal(setup.context.fileSaveStates.get('one').conflict, true);
});

test('refresh updates both editors and save baseline while preserving scroll and source selection', () => {
  const doc = { id: 'one', markdown: '旧内容', fileDirty: false };
  const writer = { diskContent: '旧内容', bom: '' };
  const source = { value: '旧内容', scrollTop: 120, scrollLeft: 30, selectionStart: 1, selectionEnd: 2, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } };
  const previewScroll = { scrollTop: 240, scrollLeft: 5 };
  const lineNumbers = { style: {} };
  const visual = { innerHTML: '' };
  const history = new Map([['one', { entries: ['旧内容'] }]]);
  let updates = 0;
  const context = {
    activeId: 'one', source, visual, savedRange: {}, lastEditKind: 'visual', histories: history, tableTools: { reset() {} },
    fileSaveStates: new Map([['one', { error: '先前错误' }]]),
    window: { getSelection: () => ({ rangeCount: 0 }) },
    $: selector => selector === '.preview-scroll' ? previewScroll : lineNumbers,
    renderMarkdown: value => '<p>' + value + '</p>',
    updateStats() { updates++; }, updateHistoryButtons() {}, updateFileEditability() {}, renderDocumentList() {}, save() {},
  };
  context.testDoc = doc; context.testWriter = writer;
  runInNewContext(functionSource('applyExternalContent') + '\napplyExternalContent(testDoc,testWriter,"\\uFEFF外部修改内容",321);', context);
  assert.equal(doc.markdown, '外部修改内容');
  assert.equal(source.value, '外部修改内容');
  assert.equal(visual.innerHTML, '<p>外部修改内容</p>');
  assert.equal(writer.diskContent, '\uFEFF外部修改内容');
  assert.equal(writer.bom, '\uFEFF');
  assert.equal(doc.fileDirty, false);
  assert.equal(source.scrollTop, 120);
  assert.equal(previewScroll.scrollTop, 240);
  assert.equal(source.selectionStart, 1);
  assert.equal(source.selectionEnd, 2);
  assert.equal(history.has('one'), false);
  assert.equal(context.fileSaveStates.has('one'), false);
  assert.equal(updates, 1);
});

test('adopting disk content rereads the file and does not proceed after switching documents', async () => {
  for (const switched of [false, true]) {
    const doc = { id: 'one', markdown: '网页草稿' };
    const calls = [];
    const writer = { async inspectExternal() {
      if (switched) context.activeId = 'other';
      return { content: '刚刚更新的原文件', modified: 123 };
    } };
    const context = {
      activeId: 'one', current: () => doc, documents: [doc],
      conflictReview: { id: 'one', draft: doc.markdown, writer },
      fileWriters: new Map([['one', writer]]), fileWriteCounts: new Map(), fileSaveTimers: new Map(),
      clearTimeout() {}, showFileConflict() { throw new Error('unexpected'); }, toast() {},
      applyExternalContent(target, targetWriter, content) { calls.push(content); },
      $: () => ({ close() {} }),
    };
    await runInNewContext(functionSource('useDiskVersion') + '\nuseDiskVersion();', context);
    assert.deepEqual(calls, switched ? [] : ['刚刚更新的原文件']);
  }
});
