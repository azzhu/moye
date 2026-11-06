import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { SharedHistoryStore, HISTORY_STORAGE_PREFIX, PAGE_DRAFT_STORAGE_KEY, restorePageDrafts } from './history-sync.js';
import { recentDocuments } from './history.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
const entry = (id, updated = 1) => ({ id, title: id, markdown: '# ' + id, updated });
const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const functionSource = name => main.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0];

function page(storage, seed = []) {
  const historyStore = new SharedHistoryStore(storage);
  const documents = historyStore.initialize(seed);
  const view = { history: [], renderCount: 0 };
  const context = {
    localStorage: storage, sessionStorage: new MemoryStorage(), historyStore, documents,
    sharedHistoryRecords: documents, activeId: null, openingHistoryId: null, authorizingImageDirectories: new Set(),
    fileWriteCounts: new Map(), STORAGE_KEY: 'inkwell.workspace.v1', PAGE_DRAFT_STORAGE_KEY,
    mode: 'visual', dark: false, contentWidth: 1080, fontSize: 16, storageAvailable: true,
    saveTimer: null, clearTimeout() {}, setTimeout: callback => callback(),
    restoreSharedHistoryHandles() {}, renderFileSaveState() {},
    renderDocumentList() { view.history = context.sharedHistoryRecords.map(doc => ({ ...doc })); view.renderCount++; },
  };
  const api = runInNewContext(['save', 'applySharedHistory', 'syncSharedHistory'].map(functionSource).join('\n') + '\n({save, syncSharedHistory});', context);
  return { context, api, view, store: historyStore };
}

test('independent pages merge additions and stale refresh/unload snapshots cannot erase them', () => {
  const storage = new MemoryStorage();
  const first = page(storage), second = page(storage);
  first.context.documents.push(entry('first', 10));
  second.context.documents.push(entry('second', 20));
  first.api.save(true); second.api.save(true);
  first.api.syncSharedHistory();
  assert.deepEqual(first.view.history.map(doc => doc.id), ['second', 'first']);
  assert.deepEqual(second.view.history.map(doc => doc.id), ['second', 'first']);
  first.api.save(true); second.api.save(true);
  assert.deepEqual(new SharedHistoryStore(storage).initialize([]).map(doc => doc.id), ['second', 'first']);
  assert.deepEqual(JSON.parse(storage.getItem('inkwell.workspace.v1')).documents, []);
});

test('missing-file status syncs and survives reload without altering saved Markdown or resurrecting history', () => {
  const storage = new MemoryStorage();
  const first = page(storage, [entry('one')]), second = page(storage);
  first.context.documents[0].fileMissing = true; first.api.save(true);
  second.api.syncSharedHistory();
  assert.equal(second.view.history[0].fileMissing, true);
  assert.equal(second.context.documents[0].markdown, '# one');
  assert.equal(new SharedHistoryStore(storage).initialize([])[0].fileMissing, true);
  second.context.documents[0].fileMissing = false; second.api.save(true);
  first.api.syncSharedHistory();
  assert.equal(first.view.history[0].fileMissing, false);
  first.store.delete('one');
  second.context.documents[0].fileMissing = true; second.api.save(true);
  assert.equal(second.store.read().length, 0);
});

test('a deletion removes the sidebar entry everywhere while preserving another page’s live dirty editor', () => {
  const storage = new MemoryStorage();
  const first = page(storage, [entry('one')]), second = page(storage);
  const active = second.context.documents[0];
  second.context.activeId = active.id; active.fileDirty = true; active.markdown = '正在编辑且未写回的草稿';
  first.store.delete(active.id); first.context.documents = []; first.api.save(true);
  second.api.syncSharedHistory();
  assert.equal(second.view.history.length, 0);
  assert.equal(second.context.documents[0], active);
  assert.equal(active.markdown, '正在编辑且未写回的草稿');
  second.api.save(true);
  assert.equal(second.store.read().length, 0);
  assert.equal(JSON.parse(second.context.sessionStorage.getItem(PAGE_DRAFT_STORAGE_KEY))[0].markdown, active.markdown);
  assert.equal(new SharedHistoryStore(storage).initialize([entry('one', 999999)]).length, 0);
});

test('reading history does not switch the current document or overwrite its draft', () => {
  const storage = new MemoryStorage();
  const first = page(storage, [entry('one')]), second = page(storage);
  const active = second.context.documents[0]; second.context.activeId = active.id;
  active.markdown = '本页内容'; active.fileDirty = true;
  first.context.documents[0].markdown = '其他页面的内容'; first.context.documents[0].updated = 5;
  first.api.save(true); second.api.syncSharedHistory();
  assert.equal(second.context.activeId, 'one');
  assert.equal(second.context.documents[0], active);
  assert.equal(active.markdown, '本页内容');
  const count = second.view.renderCount; second.api.syncSharedHistory();
  assert.equal(second.view.renderCount, count, 'unchanged fallback polls do not rerender');
});

test('receiving a remote addition while a new local file handle is being stored keeps both records', () => {
  const storage = new MemoryStorage();
  const first = page(storage), second = page(storage);
  const pending = entry('local-file-opening', 10);
  second.context.documents.push(pending);
  first.context.documents.push(entry('remote-file', 20)); first.api.save(true);
  second.api.syncSharedHistory();
  assert.equal(second.context.documents.includes(pending), true);
  second.api.save(true);
  assert.deepEqual(second.store.read().map(doc => doc.id), ['remote-file', 'local-file-opening']);
});

test('reopening a stale cached record merges last-opened time without replacing newer content or title', () => {
  const storage = new MemoryStorage();
  const first = page(storage, [entry('one')]), second = page(storage);
  Object.assign(first.context.documents[0], { title: '最新名称', markdown: '最新内容', fileDirty: true, updated: 10 });
  first.api.save(true);
  second.context.activeId = 'one'; second.context.documents[0].lastOpened = 20;
  second.api.save(true);
  const shared = second.store.read()[0];
  assert.equal(shared.title, '最新名称'); assert.equal(shared.markdown, '最新内容');
  assert.equal(shared.fileDirty, true); assert.equal(shared.lastOpened, 20);
});

test('independent record keys survive interleaved writes, and deletion markers win a write/delete race', () => {
  const storage = new MemoryStorage();
  const first = new SharedHistoryStore(storage), second = new SharedHistoryStore(storage);
  first.initialize([]); second.initialize([]);
  const originalSet = storage.setItem.bind(storage);
  let injected = false;
  storage.setItem = (key, value) => {
    if (!injected && key === first.key('record', 'a')) { injected = true; second.publish([entry('b', 2)]); }
    originalSet(key, value);
  };
  first.publish([entry('a', 3)]);
  assert.deepEqual(first.read().map(doc => doc.id), ['a', 'b']);
  injected = false;
  storage.setItem = (key, value) => {
    if (!injected && key === first.key('record', 'a')) { injected = true; second.delete('a'); }
    originalSet(key, value);
  };
  first.publish([entry('a', 4)]);
  assert.deepEqual(first.read().map(doc => doc.id), ['b']);
  assert.equal(first.isDeleted('a'), true);
});

test('history stays at 20 entries and idle pages cannot reintroduce evicted records', () => {
  const storage = new MemoryStorage(); const store = new SharedHistoryStore(storage);
  store.initialize([]);
  store.publish(Array.from({ length: 25 }, (_, index) => entry(String(index), index)));
  assert.equal(store.read().length, 20);
  const stale = new SharedHistoryStore(storage); stale.initialize([]);
  stale.publish([entry('0', 10000)]);
  assert.equal(store.read().length, 20);
  assert.equal(store.read().some(doc => doc.id === '0'), false);
  const dirty = { ...entry('0'), fileDirty: true };
  assert.equal(recentDocuments([dirty, ...store.read()], doc => doc.fileDirty).includes(dirty), true);
});

test('legacy pages import missing records safely, corruption is isolated, and failed writes remain retryable', () => {
  const storage = new MemoryStorage(); const store = new SharedHistoryStore(storage);
  store.initialize([entry('legacy')]);
  assert.deepEqual(new SharedHistoryStore(storage).initialize([entry('another-legacy')]).map(doc => doc.id), ['another-legacy', 'legacy']);
  storage.setItem(HISTORY_STORAGE_PREFIX + 'record:corrupt', '{');
  assert.equal(store.read().length, 2);
  const write = storage.setItem.bind(storage); let fail = true;
  storage.setItem = (key, value) => { if (fail && key === store.key('record', 'new')) throw new Error('quota'); write(key, value); };
  assert.throws(() => store.publish([entry('new')]), /quota/);
  fail = false; store.publish([entry('new')]);
  assert.equal(store.read().some(doc => doc.id === 'new'), true);
});

test('per-page draft backups survive a newer clean snapshot from another page', () => {
  const storage = new MemoryStorage();
  storage.setItem(PAGE_DRAFT_STORAGE_KEY, JSON.stringify([{ ...entry('one'), markdown: '本页未写回草稿', fileDirty: true }]));
  const restored = restorePageDrafts(storage, [{ ...entry('one'), markdown: '其他页面已保存的内容', fileDirty: false }]);
  assert.equal(restored[0].markdown, '本页未写回草稿');
  assert.equal(restored[0].fileDirty, true);
});

test('a shared in-flight draft is not promoted into this page’s session backup and accepts a clean update', () => {
  const storage = new MemoryStorage();
  const first = page(storage, [{ ...entry('one'), markdown: '正在保存的内容', fileDirty: true, fileDiskContent: '原文' }]);
  const second = page(storage);
  second.api.save(true);
  assert.deepEqual(JSON.parse(second.context.sessionStorage.getItem(PAGE_DRAFT_STORAGE_KEY)), []);
  Object.assign(first.context.documents[0], { fileDirty: false, fileDiskContent: '正在保存的内容' });
  first.api.save(true); second.api.syncSharedHistory();
  assert.equal(second.context.documents[0].fileDirty, false);
  assert.equal(second.context.documents[0].fileDiskContent, '正在保存的内容');
});

test('a clean shared snapshot never clears a live draft before the disk itself is checked', () => {
  const storage = new MemoryStorage();
  const first = page(storage, [entry('one')]), second = page(storage);
  const active = second.context.documents[0];
  second.context.activeId = 'one';
  Object.assign(active, { markdown: '双方相同的内容', fileDirty: true }); second.api.save(true);
  Object.assign(first.context.documents[0], { markdown: '双方相同的内容', fileDirty: false, fileDiskContent: '双方相同的内容' });
  first.api.save(true); second.api.syncSharedHistory();
  assert.equal(second.context.documents[0], active);
  assert.equal(active.fileDirty, true);
  assert.equal(second.store.localDrafts.has('one'), true);
});

test('session restoration discards already-saved or baseline-identical dirty snapshots and preserves distinct edits', () => {
  const storage = new MemoryStorage();
  const saved = { ...entry('saved'), markdown: '已保存内容', fileDiskContent: '已保存内容', fileDirty: false };
  const external = { ...entry('external'), markdown: '磁盘新内容', fileDirty: false };
  storage.setItem(PAGE_DRAFT_STORAGE_KEY, JSON.stringify([
    { ...saved, fileDirty: true, fileDiskContent: '旧基线' },
    { ...external, fileDirty: true, markdown: '原文', fileDiskContent: '\uFEFF原文' },
    { ...entry('real-draft'), fileDirty: true, markdown: '实际未保存的修改', fileDiskContent: '原文' },
  ]));
  const restored = restorePageDrafts(storage, [saved, external]);
  assert.equal(restored.find(doc => doc.id === 'saved'), saved);
  assert.equal(restored.find(doc => doc.id === 'external'), external);
  assert.equal(restored.find(doc => doc.id === 'real-draft').fileDirty, true);
});
