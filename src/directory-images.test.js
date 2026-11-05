import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectoryImageLoader, readDirectoryImage, validateImageDirectory, imageDirectoryKey } from './directory-images.js';

function directoryFixture() {
  const calls = { reads: [], queries: [], created: [], revoked: [], requested: 0 };
  const original = { name: '报告.md' };
  const root = {
    name: '报告目录', permission: 'granted',
    async queryPermission(options) { calls.queries.push(options); return this.permission; },
    async requestPermission() { calls.requested++; return 'granted'; },
    async getFileHandle(name) {
      calls.reads.push(name);
      if (name === '报告.md') return { isSameEntry: async candidate => candidate === original };
      if (name === '图.png' || name === '图 表(1).png') return { getFile: async () => new Blob(['test-image'], { type: 'image/png' }) };
      if (name === '大图.png') return { getFile: async () => ({ size: 21 * 1024 * 1024 }) };
      throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
    },
    async getDirectoryHandle(name) {
      calls.reads.push(name + '/');
      if (name === 'images') return root;
      throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
    },
  };
  const loader = new DirectoryImageLoader({
    createURL: file => { const url = `blob:test-${calls.created.length}`; calls.created.push({ url, file }); return url; },
    revokeURL: url => calls.revoked.push(url),
  });
  return { calls, original, root, loader };
}

function imageNode(path = '图.png') {
  const attributes = { 'data-image-path': path, 'data-image-alt': '原始说明' };
  const classes = new Set();
  return {
    attributes, classes,
    getAttribute: name => attributes[name] ?? null,
    setAttribute: (name, value) => { attributes[name] = value; },
    removeAttribute: name => delete attributes[name],
    classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
  };
}

test('directory selection checks the actual Markdown file, not just its filename', async () => {
  const setup = directoryFixture();
  await validateImageDirectory(setup.root, setup.original);
  await assert.rejects(validateImageDirectory(setup.root, { name: '报告.md' }), /同名文件不是当前文档/);
  await assert.rejects(validateImageDirectory(setup.root, { name: '其他.md' }), /所在的文件夹/);
  await assert.rejects(validateImageDirectory(setup.root, null), /选择原始/);
  assert.equal(imageDirectoryKey('doc-id'), '@image-directory:doc-id');
});

test('directory reads support Chinese and encoded paths, never request write access, and reject traversal and oversized files', async () => {
  const setup = directoryFixture();
  assert.equal((await readDirectoryImage(setup.root, './images/图%20表(1).png')).type, 'image/png');
  for (const path of ['../图.png', '/tmp/图.png', 'file:a.png', 'images/%2e%2e/a.png']) {
    await assert.rejects(readDirectoryImage(setup.root, path), /路径无效/);
  }
  await assert.rejects(readDirectoryImage(setup.root, '大图.png'), /20 MB/);
  assert.equal(setup.calls.requested, 0);
});

test('granted directories load images through Blob URLs and reuse resources across visual rerenders', async () => {
  const setup = directoryFixture();
  const image = imageNode('images/图.png'); const editor = { nodes: [image], querySelectorAll() { return this.nodes; } };
  const status = await setup.loader.refresh(editor, 'one', setup.original, setup.root);
  assert.equal(status.permission, 'granted');
  assert.equal(image.attributes.src, 'blob:test-0');
  assert.equal(image.alt, '原始说明');
  const replacement = imageNode('images/图.png'); editor.nodes = [replacement];
  await setup.loader.refresh(editor, 'one', setup.original, setup.root);
  assert.equal(replacement.attributes.src, 'blob:test-0'); assert.equal(setup.calls.created.length, 1);
  assert.equal(setup.calls.reads.filter(path => path === '图.png').length, 1);
  assert.ok(setup.calls.queries.every(options => options.mode === 'read'));
  assert.equal(setup.calls.requested, 0);
});

test('unselected or expired directories show authorization hints without requesting permission in the background', async () => {
  const setup = directoryFixture(); const image = imageNode(); const editor = { querySelectorAll: () => [image] };
  await setup.loader.refresh(editor, 'one', setup.original, null);
  assert.ok(image.alt.includes('图片目录')); assert.equal(setup.calls.created.length, 0);
  await setup.loader.refresh(editor, 'one', setup.original, setup.root);
  setup.root.permission = 'prompt';
  const status = await setup.loader.refresh(editor, 'one', setup.original, setup.root);
  assert.equal(status.permission, 'prompt'); assert.equal(image.attributes.src, undefined);
  assert.ok(image.alt.includes('权限已失效')); assert.equal(setup.calls.requested, 0);
  assert.deepEqual(setup.calls.revoked, ['blob:test-0']);
  setup.root.permission = 'granted';
  await setup.loader.refresh(editor, 'one', setup.original, setup.root);
  assert.equal(image.attributes.src, 'blob:test-1');
});

test('missing and undecodable images show an error but preserve original Markdown metadata', async () => {
  const setup = directoryFixture(); const missing = imageNode('不存在.png'); const image = imageNode();
  const editor = { querySelectorAll: () => [missing, image] };
  await setup.loader.refresh(editor, 'one', setup.original, setup.root);
  assert.ok(missing.alt.includes('不存在')); assert.equal(missing.attributes['data-image-alt'], '原始说明');
  image.onerror(); assert.ok(image.alt.includes('无法解码'));
  assert.equal(image.attributes['data-image-path'], '图.png'); assert.equal(image.attributes['data-image-alt'], '原始说明');
});

test('switching documents, removing images and clearing the loader revoke Blob URLs', async () => {
  const setup = directoryFixture(); const editor = { nodes: [imageNode()], querySelectorAll() { return this.nodes; } };
  await setup.loader.refresh(editor, 'one', setup.original, setup.root);
  editor.nodes = [];
  await setup.loader.refresh(editor, 'one', setup.original, setup.root);
  assert.deepEqual(setup.calls.revoked, ['blob:test-0']);
  editor.nodes = [imageNode()];
  await setup.loader.refresh(editor, 'one', setup.original, setup.root);
  await setup.loader.refresh(editor, 'two', setup.original, setup.root);
  setup.loader.clear();
  assert.deepEqual(setup.calls.revoked, ['blob:test-0', 'blob:test-1', 'blob:test-2']);
});

test('an asynchronous image read cannot leak a Blob URL or update a document after switching away', async () => {
  const setup = directoryFixture(); let finishRead; let entered;
  const reachedFile = new Promise(resolve => { entered = resolve; });
  const normalGet = setup.root.getFileHandle;
  setup.root.getFileHandle = async name => name === '图.png'
    ? { getFile: () => { entered(); return new Promise(resolve => { finishRead = resolve; }); } }
    : normalGet(name);
  const image = imageNode(); const editor = { querySelectorAll: () => [image] };
  const pending = setup.loader.refresh(editor, 'one', setup.original, setup.root);
  await reachedFile;
  setup.loader.clear(); finishRead(new Blob(['late-image']));
  await pending;
  assert.equal(setup.calls.created.length, 0); assert.equal(image.attributes.src, undefined);
});

test('concurrent refreshes share one file read and update the latest image nodes only', async () => {
  const setup = directoryFixture(); let finishRead; let entered;
  const reachedFile = new Promise(resolve => { entered = resolve; });
  const normalGet = setup.root.getFileHandle;
  setup.root.getFileHandle = async name => name === '图.png'
    ? { getFile: () => { entered(); return new Promise(resolve => { finishRead = resolve; }); } }
    : normalGet(name);
  const first = imageNode(); const editor = { nodes: [first], querySelectorAll() { return this.nodes; } };
  const pending = setup.loader.refresh(editor, 'one', setup.original, setup.root);
  await reachedFile;
  const second = imageNode(); editor.nodes = [second];
  const other = setup.loader.refresh(editor, 'one', setup.original, setup.root);
  finishRead(new Blob(['image'])); await Promise.all([pending, other]);
  assert.equal(setup.calls.created.length, 1);
  assert.equal(first.attributes.src, undefined); assert.equal(second.attributes.src, 'blob:test-0');
});
