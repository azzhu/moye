import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { validateImageDirectory, imageDirectoryKey } from './directory-images.js';

const mainCode = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const authorizeFunction = mainCode.match(/async function authorizeImageDirectory\([^]*?\n\}/)[0];

function authorizationFixture() {
  const doc = { id: 'one', markdown: '![图](图.png)', fileDirty: false };
  const calls = { picked: [], requested: [], stored: [], refreshed: 0, messages: [] };
  const file = { name: '文档.md' };
  const directory = {
    name: '文档目录',
    getFileHandle: async () => ({ isSameEntry: async candidate => candidate === file }),
    requestPermission(options) { calls.requested.push(options); return Promise.resolve('granted'); },
  };
  const context = {
    current: () => doc, documents: [doc], activeId: 'one', fileHandles: new Map([['one', file]]),
    imageDirectories: new Map(), imageDirectoryStates: new Map(), authorizingImageDirectories: new Set(),
    window: { showDirectoryPicker(options) { calls.picked.push(options); return Promise.resolve(directory); } },
    validateImageDirectory, imageDirectoryKey,
    directoryImageLoader: { clear() {} }, refreshDocumentImages() { calls.refreshed++; },
    $: () => ({ disabled: false }),
    rememberFileHandle: async (key, handle) => { calls.stored.push({ key, handle }); },
    toast: message => calls.messages.push(message),
  };
  const authorize = runInNewContext(authorizeFunction + '\nauthorizeImageDirectory', context);
  return { doc, file, directory, calls, context, authorize };
}

test('clicking directory authorization opens a readonly picker directly and persists the verified directory', async () => {
  const setup = authorizationFixture();
  const operation = setup.authorize();
  assert.equal(setup.calls.picked.length, 1);
  assert.equal(setup.calls.picked[0].mode, 'read');
  assert.equal(setup.calls.picked[0].startIn, setup.file);
  await operation;
  assert.equal(setup.context.imageDirectories.get('one'), setup.directory);
  assert.equal(setup.calls.stored[0].key, '@image-directory:one');
  assert.equal(setup.calls.stored[0].handle, setup.directory);
  assert.equal(setup.doc.markdown, '![图](图.png)'); assert.equal(setup.doc.fileDirty, false);
});

test('remembered directories request only read access inside the click gesture without reopening the picker', async () => {
  const setup = authorizationFixture(); setup.context.imageDirectories.set('one', setup.directory);
  setup.context.imageDirectoryStates.set('one', { permission: 'prompt' });
  const operation = setup.authorize();
  assert.equal(setup.calls.requested.length, 1); assert.equal(setup.calls.requested[0].mode, 'read');
  await operation;
  assert.equal(setup.calls.picked.length, 0);
  assert.equal(setup.context.imageDirectoryStates.get('one').permission, 'granted');
});

test('cancelled selection and denied permission retain previous associations and never dirty the document', async () => {
  const cancelled = authorizationFixture();
  cancelled.context.window.showDirectoryPicker = async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); };
  await cancelled.authorize();
  assert.equal(cancelled.calls.messages.length, 0); assert.equal(cancelled.calls.stored.length, 0);
  const denied = authorizationFixture(); denied.context.imageDirectories.set('one', denied.directory);
  denied.directory.requestPermission = async () => 'denied';
  await denied.authorize();
  assert.ok(denied.calls.messages[0].includes('未获得'));
  assert.equal(denied.context.imageDirectories.get('one'), denied.directory);
  assert.equal(denied.calls.stored.length, 0); assert.equal(denied.doc.fileDirty, false);
});

test('a wrong directory or a deleted document is never remembered', async () => {
  const wrong = authorizationFixture(); wrong.directory.getFileHandle = async () => ({ isSameEntry: async () => false });
  await wrong.authorize(); assert.equal(wrong.calls.stored.length, 0);
  assert.ok(wrong.calls.messages[0].includes('同名文件不是当前文档'));
  const deleted = authorizationFixture();
  deleted.context.window.showDirectoryPicker = async () => { deleted.context.documents = []; return deleted.directory; };
  await deleted.authorize(); assert.equal(deleted.calls.stored.length, 0);
});

test('directory selection finishes against the original document without updating another active editor', async () => {
  const setup = authorizationFixture();
  setup.context.window.showDirectoryPicker = async () => { setup.context.activeId = 'two'; return setup.directory; };
  await setup.authorize();
  assert.equal(setup.context.imageDirectories.get('one'), setup.directory);
  assert.equal(setup.calls.refreshed, 0);
});

test('unsupported browsers and unconnected history records receive actionable messages', async () => {
  const unsupported = authorizationFixture(); unsupported.context.window.showDirectoryPicker = undefined;
  await unsupported.authorize(); assert.ok(unsupported.calls.messages[0].includes('Chrome'));
  const unconnected = authorizationFixture(); unconnected.context.fileHandles.clear();
  await unconnected.authorize(); assert.ok(unconnected.calls.messages[0].includes('打开文档'));
});
