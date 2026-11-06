import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { OriginalFileWriter, hasUnsavedFileChanges, isMissingOriginalFile } from './file-access.js';
import { SharedHistoryStore, PAGE_DRAFT_STORAGE_KEY, restorePageDrafts } from './history-sync.js';

const main = await readFile(new URL('./main.js', import.meta.url), 'utf8');
const functionSource = name => main.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0];
class TestStorage {
  values = new Map();
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function editorPage(storage, session, handle) {
  const store = new SharedHistoryStore(storage);
  let documents = store.initialize([]);
  const sharedRecords = documents;
  const shared = new Set(documents);
  documents = restorePageDrafts(session, documents);
  for (const doc of documents) if (doc.fileDirty && !shared.has(doc)) { store.localDrafts.add(doc.id); store.remember(doc); }
  const source = { value: '', selectionStart: 0, selectionEnd: 0, scrollTop: 30, scrollLeft: 0, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } };
  const visual = { innerHTML: '', contains: () => false };
  const elements = { '.preview-scroll': { scrollTop: 40, scrollLeft: 0 }, '.line-numbers': { style: {} } };
  const context = {
    documents, sharedHistoryRecords: sharedRecords, historyStore: store,
    localStorage: storage, sessionStorage: session, PAGE_DRAFT_STORAGE_KEY, STORAGE_KEY: 'workspace',
    mode: 'visual', dark: false, contentWidth: 1080, fontSize: 16, saveTimer: null,
    storageAvailable: true, source, visual, savedRange: null, lastEditKind: null,
    activeId: null, openingHistoryId: null, historyOpenVersion: 0, composingDocument: false, resizingTable: false,
    fileWriters: new Map(), fileHandles: new Map([['one', handle]]),
    fileWriteCounts: new Map(), fileSaveTimers: new Map(), fileSaveStates: new Map(),
    deletingRecords: new Set(), externalChecks: new Set(), authorizingImageDirectories: new Set(), histories: new Map(),
    handleRestore: Promise.resolve(), OriginalFileWriter, hasUnsavedFileChanges, isMissingOriginalFile,
    tableTools: { reset() {} }, document: { hidden: false }, window: { getSelection: () => ({ rangeCount: 0 }) },
    $: selector => elements[selector], renderMarkdown: value => `<p>${value}</p>`,
    clearTimeout() {}, setTimeout: callback => { callback(); return 1; },
    renderDocumentList() {}, renderFileSaveState() {}, updateStats() {}, updateHistoryButtons() {}, updateFileEditability() {},
    toast() {}, restoreSharedHistoryHandles() {},
    current: () => context.documents.find(doc => doc.id === context.activeId),
    loadDocument(id) {
      context.activeId = id; context.openingHistoryId = id; context.historyOpenVersion++;
      const doc = context.current(); source.value = doc.markdown; visual.innerHTML = `<p>${doc.markdown}</p>`;
    },
  };
  const api = runInNewContext(['save', 'setOriginalFileMissing', 'applySharedHistory', 'applyExternalContent', 'checkExternalModification', 'openHistoryDocument']
    .map(functionSource).join('\n') + '\n({save, checkExternalModification, openHistoryDocument});', context);
  return { context, api, store, source, visual };
}

test('real disk changes refresh both editors and persist the new snapshot across page reloads', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'moye-refresh-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, '文档.md');
  await writeFile(path, '原始内容');
  let writes = 0;
  const handle = {
    async requestPermission() { return 'granted'; }, async queryPermission() { return 'granted'; },
    async getFile() { const content = await readFile(path, 'utf8'); const info = await stat(path); return { size: info.size, lastModified: info.mtimeMs, text: async () => content }; },
    async createWritable() { writes++; throw new Error('Refresh must never write the source file'); },
  };
  const storage = new TestStorage(), session = new TestStorage();
  new SharedHistoryStore(storage).initialize([{ id: 'one', title: '文档', markdown: '原始内容', fileDiskContent: '原始内容', fileDirty: true, updated: 1 }]);
  const first = editorPage(storage, session, handle);
  first.context.activeId = 'one';
  first.context.fileWriters.set('one', new OriginalFileWriter(handle, '原始内容'));
  first.context.fileSaveStates.set('one', { conflict: true });
  await writeFile(path, '外部版本一');
  await first.api.checkExternalModification();
  assert.equal(first.source.value, '外部版本一');
  assert.equal(first.visual.innerHTML, '<p>外部版本一</p>');
  assert.equal(first.context.current().fileDirty, false);
  assert.equal(first.store.read()[0].markdown, '外部版本一');
  assert.deepEqual(JSON.parse(session.getItem(PAGE_DRAFT_STORAGE_KEY)), []);

  // A real reload starts from persisted storage, then reads the original
  // file again instead of treating the previous cache as authoritative.
  await writeFile(path, '刷新前的外部版本二');
  const reloaded = editorPage(storage, session, handle);
  await reloaded.api.openHistoryDocument('one');
  assert.equal(reloaded.source.value, '刷新前的外部版本二');
  assert.equal(reloaded.visual.innerHTML, '<p>刷新前的外部版本二</p>');
  assert.equal(reloaded.context.fileSaveStates.has('one'), false);
  assert.equal(reloaded.store.read()[0].markdown, '刷新前的外部版本二');

  // Matching text already on disk clears an old dirty marker, but real
  // divergent edits continue to preserve both copies without writing.
  const doc = reloaded.context.current();
  doc.fileDirty = true; doc.markdown = '其他页面已保存的版本';
  await writeFile(path, doc.markdown);
  await reloaded.api.checkExternalModification();
  assert.equal(doc.fileDirty, false);
  doc.fileDirty = true; doc.markdown = '本页真正未写回的修改'; reloaded.api.save(true);
  await writeFile(path, '磁盘上的另一个版本');
  await reloaded.api.checkExternalModification();
  assert.equal(doc.markdown, '本页真正未写回的修改');
  assert.equal(reloaded.context.fileSaveStates.get('one').conflict, true);
  assert.equal(await readFile(path, 'utf8'), '磁盘上的另一个版本');
  const conflictedReload = editorPage(storage, session, handle);
  await conflictedReload.api.openHistoryDocument('one');
  assert.equal(conflictedReload.context.current().markdown, '本页真正未写回的修改');
  assert.equal(conflictedReload.context.fileSaveStates.get('one').conflict, true);
  assert.equal(writes, 0);
});
