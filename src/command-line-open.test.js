import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parseMoyeArgs, requireCurrentMoyeService } from '../moye-cli.mjs';

const entryText = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const openFunction = entryText.match(/async function openCommandLineDocument\([^]*?\n\}/)[0];

test('terminal arguments preserve Unicode, spaces and leading dashes with --', () => {
  assert.deepEqual(parseMoyeArgs(['--no-browser', './我的 文档.md']), { path: './我的 文档.md', noBrowser: true });
  assert.deepEqual(parseMoyeArgs(['--', '-文件.md']), { path: '-文件.md', noBrowser: false });
  assert.deepEqual(parseMoyeArgs(['--help']), { help: true });
  assert.deepEqual(parseMoyeArgs(['--stop']), { stop: true });
  assert.throws(() => parseMoyeArgs([]), /指定一个/);
  assert.throws(() => parseMoyeArgs(['a.md', 'b.md']), /指定一个/);
  assert.throws(() => parseMoyeArgs(['--other']), /未知选项/);
});

test('opening a file explicitly reports stale background services while allowing current services', () => {
  assert.throws(() => requireCurrentMoyeService({ version: 1 }), /moye --stop/);
  assert.throws(() => requireCurrentMoyeService({ capabilities: [] }), /先确认所有网页修改已保存/);
  assert.doesNotThrow(() => requireCurrentMoyeService({ version: 2, capabilities: ['local-images-v1'] }));
});

function startupFixture(existing = []) {
  const handle = { id: 'one', name: '文档.md', path: '/tmp/文档.md' };
  const calls = { opened: [], stored: [], messages: [], focused: 0 };
  const context = {
    historyOpenVersion: 1, window: { location: { hash: '#moye=token' } }, documents: existing,
    historyStore: null,
    handleRestore: Promise.resolve(), fileHandles: new Map(),
    localFileFromHash: async () => handle,
    rememberFileHandle: async (id, handle) => calls.stored.push({ id, handle }),
    openHistoryDocument: async id => calls.opened.push(id),
    toast: message => calls.messages.push(message),
    document: { body: { classList: { contains: () => calls.focused > 0 } } },
    actions: { focus: () => calls.focused++ },
  };
  const start = runInNewContext(openFunction + '\nopenCommandLineDocument', context);
  return { context, calls, handle, start };
}

test('explicit command-line startup creates an absolute-path document and uses the existing history read flow', async () => {
  const setup = startupFixture(); await setup.start();
  const doc = setup.context.documents[0];
  assert.equal(doc.id, 'local-one'); assert.equal(doc.title, '文档');
  assert.equal(doc.sourcePath, '/tmp/文档.md'); assert.equal(doc.localFilePath, '/tmp/文档.md');
  assert.equal(setup.context.fileHandles.get(doc.id), setup.handle);
  assert.deepEqual(setup.calls.opened, ['local-one']);
  assert.equal(setup.calls.focused, 1);
});

test('command-line startup reconnects a retained draft without replacing or automatically writing it', async () => {
  const doc = { id: 'old', localFilePath: '/tmp/文档.md', markdown: '未保存草稿', fileDirty: true, fileDiskContent: '旧磁盘内容' };
  const setup = startupFixture([doc]); await setup.start();
  assert.equal(setup.context.documents.length, 1);
  assert.equal(doc.markdown, '未保存草稿'); assert.equal(doc.fileDiskContent, '旧磁盘内容');
  assert.equal(doc.fileDirty, true); assert.deepEqual(setup.calls.opened, ['old']);
});

test('normal page startup stays empty, while slow command-line reads never override a user selection', async () => {
  const empty = startupFixture(); empty.context.localFileFromHash = async () => null;
  await empty.start(); assert.equal(empty.calls.opened.length, 0); assert.equal(empty.context.documents.length, 0);
  assert.equal(empty.calls.focused, 0);
  const switched = startupFixture(); switched.context.localFileFromHash = async () => { switched.context.historyOpenVersion++; return switched.handle; };
  await switched.start(); assert.equal(switched.calls.opened.length, 0); assert.equal(switched.context.documents.length, 0);
  assert.equal(switched.calls.focused, 0);
});

test('command-line startup keeps an already fullscreen document fullscreen', async () => {
  const setup = startupFixture(); setup.calls.focused = 1;
  await setup.start(); assert.equal(setup.calls.focused, 1);
  assert.deepEqual(setup.calls.opened, ['local-one']);
});

test('unavailable command-line connections give a clear error without silently opening a cached file', async () => {
  const setup = startupFixture(); setup.context.localFileFromHash = async () => { throw new Error('本地服务未连接'); };
  await setup.start(); assert.equal(setup.calls.opened.length, 0); assert.deepEqual(setup.calls.messages, ['本地服务未连接']);
});
