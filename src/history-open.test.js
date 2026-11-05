import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { OriginalFileWriter } from './file-access.js';

const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const functionSource = name => main.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0];

function historyOpen({ dirty = false, disk = '磁盘最新内容', baseline = '旧内容', permission = 'granted', readPermission = 'granted', missing = false, readError = false } = {}) {
  const doc = { id: 'one', markdown: dirty ? '未保存草稿' : '旧内容', fileDirty: dirty, fileDiskContent: baseline };
  const calls = { permissions: 0, reads: 0, writes: 0, refreshed: 0, messages: [] };
  const handle = {
    requestPermission() { calls.permissions++; return Promise.resolve(permission); },
    async queryPermission() { return readPermission; },
    async getFile() {
      calls.reads++;
      if (readError) throw new Error('文件已移走');
      return { size: 100, lastModified: 123, async text() { return disk; } };
    },
    async createWritable() { calls.writes++; throw new Error('Opening history must never write'); },
  };
  const context = {
    documents: [doc], activeId: null, openingHistoryId: null, historyOpenVersion: 0,
    deletingRecords: new Set(), fileHandles: new Map(missing ? [] : [['one', handle]]),
    fileWriters: new Map(), fileSaveStates: new Map(), fileSaveTimers: new Map([['one', 1]]),
    handleRestore: Promise.resolve(), OriginalFileWriter, clearTimeout() {},
    recallFileHandle: async () => null,
    updateFileEditability() {}, updateHistoryButtons() {}, renderFileSaveState() {}, save() {},
    toast(message) { calls.messages.push(message); },
    loadDocument(id, readHistory) {
      context.activeId = id; context.historyOpenVersion++;
      context.openingHistoryId = readHistory ? id : null;
    },
    applyExternalContent(target, writer, content) {
      calls.refreshed++; target.markdown = content.replace(/^\uFEFF/, '');
      target.fileDiskContent = content; target.fileDirty = false;
      context.fileSaveStates.delete(target.id);
    },
  };
  const open = runInNewContext(functionSource('openHistoryDocument') + '\nopenHistoryDocument', context);
  return { doc, handle, calls, context, open };
}

test('reopening history after a page reload reads the original file and rebuilds its writer', async () => {
  const setup = historyOpen({ disk: '\uFEFF磁盘最新内容' });
  const operation = setup.open('one');
  assert.equal(setup.calls.permissions, 1, 'request permission in the click gesture before unrelated awaits');
  assert.equal(setup.context.openingHistoryId, 'one');
  await operation;
  assert.equal(setup.doc.markdown, '磁盘最新内容');
  assert.equal(setup.context.fileWriters.get('one').diskContent, '\uFEFF磁盘最新内容');
  assert.equal(setup.context.fileWriters.get('one').bom, '\uFEFF');
  assert.equal(setup.context.openingHistoryId, null);
  assert.equal(setup.context.fileSaveTimers.size, 0);
  assert.equal(setup.calls.writes, 0);
});

test('history waits for stored file handles to restore before reading', async () => {
  const setup = historyOpen({ missing: true });
  setup.context.handleRestore = Promise.resolve().then(() => setup.context.fileHandles.set('one', setup.handle));
  await setup.open('one');
  assert.equal(setup.doc.markdown, '磁盘最新内容');
  assert.equal(setup.calls.reads, 1);
});

test('missing handles, denied read access, and file errors explicitly mark the old draft readonly', async () => {
  for (const options of [{ missing: true }, { permission: 'denied', readPermission: 'denied' }, { readError: true }]) {
    const setup = historyOpen(options);
    await setup.open('one');
    assert.equal(setup.doc.markdown, '旧内容');
    assert.equal(setup.context.fileSaveStates.get('one').historyReadError, true);
    assert.equal(setup.context.fileWriters.size, 0);
    assert.equal(setup.context.openingHistoryId, null);
    assert.equal(setup.calls.writes, 0);
  }
});

test('read access without write access still shows fresh disk content and a readonly status', async () => {
  const setup = historyOpen({ permission: 'denied' });
  await setup.open('one');
  assert.equal(setup.doc.markdown, '磁盘最新内容');
  assert.equal(setup.context.fileSaveStates.get('one').historyReadOnly, true);
  assert.equal(setup.context.fileSaveStates.get('one').historyReadError, undefined);
  assert.equal(setup.context.fileWriters.size, 0);
});

test('history preserves dirty drafts and flags changed or unknown disk baselines as conflicts', async () => {
  for (const unknown of [false, true]) {
    const setup = historyOpen({ dirty: true });
    if (unknown) delete setup.doc.fileDiskContent;
    await setup.open('one');
    assert.equal(setup.doc.markdown, '未保存草稿');
    assert.equal(setup.context.fileSaveStates.get('one').conflict, true);
    assert.equal(setup.context.fileSaveStates.get('one').external, '磁盘最新内容');
    assert.equal(setup.calls.writes, 0);
  }
});

test('opening an unchanged original preserves unsaved drafts without writing automatically', async () => {
  const setup = historyOpen({ dirty: true, disk: '旧内容' });
  await setup.open('one');
  assert.equal(setup.doc.markdown, '未保存草稿');
  assert.equal(setup.doc.fileDirty, true);
  assert.equal(setup.context.fileSaveStates.get('one').conflict, undefined);
  assert.match(setup.context.fileSaveStates.get('one').error, /未保存草稿/);
  assert.equal(setup.calls.writes, 0);
});

test('switching documents or repeating an open while reading discards the obsolete result', async () => {
  for (const repeated of [false, true]) {
    const setup = historyOpen();
    setup.handle.getFile = async () => ({ size: 100, async text() {
      setup.context.historyOpenVersion++;
      if (!repeated) setup.context.activeId = 'other';
      return '过期的读取结果';
    } });
    await setup.open('one');
    assert.equal(setup.calls.refreshed, 0);
    assert.equal(setup.context.fileWriters.size, 0);
    assert.equal(setup.doc.markdown, '旧内容');
  }
});

test('history finishes an in-flight write before taking its disk snapshot', async () => {
  const setup = historyOpen();
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  setup.context.fileWriters.set('one', { pending, diskContent: '旧内容' });
  const operation = setup.open('one');
  await Promise.resolve();
  assert.equal(setup.calls.reads, 0);
  complete();
  await operation;
  assert.equal(setup.calls.reads, 1);
  assert.equal(setup.doc.markdown, '磁盘最新内容');
});

test('source and toolbar changes are blocked while original contents are loading', () => {
  const context = { openingHistoryId: 'one', activeId: 'one', current: () => ({ id: 'one' }), fileWriters: new Map([['one', {}]]) };
  for (const name of ['changed', 'format', 'insertBlock', 'showLink', 'focusVisual', 'applyHistory']) {
    assert.doesNotThrow(() => runInNewContext(functionSource(name) + `\n${name}();`, context));
  }
});
