import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, stat, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { LocalDocumentStore, createLocalService, MAX_DOCUMENT_BYTES, MAX_IMAGE_BYTES } from '../local-service.mjs';
import { localImageURL } from './image-path.js';
import { renderMarkdown, serializeMarkdown } from './markdown.js';
import { LocalFileHandle, localFileFromHash } from './local-file-handle.js';
import { OriginalFileWriter } from './file-access.js';

async function localFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'moye-cli-'));
  const path = join(directory, '测试 文档.md');
  await writeFile(path, '\uFEFF# 原文件\n', { mode: 0o640 });
  const service = createLocalService({ secret: 'admin-test' });
  service.server.address = () => ({ port: 5174 });
  const request = async (url, options = {}, extraHeaders = {}) => {
    const chunks = options.body ? [Buffer.from(options.body)] : [];
    const incoming = Readable.from(chunks);
    Object.assign(incoming, { url, method: options.method || 'GET', headers: { host: '127.0.0.1:5174', ...Object.fromEntries(Object.entries(options.headers || {}).map(([k, v]) => [k.toLowerCase(), v])), ...extraHeaders } });
    let status, data, headers, bytes;
    await service.handler(incoming, {
      writeHead(code, values) { status = code; headers = values; },
      end(body) { bytes = body; data = body?.toString() || ''; },
    });
    return { ok: status >= 200 && status < 300, status, headers, bytes, json: async () => JSON.parse(data), text: async () => data };
  };
  try { await run({ directory, path, store: service.store, request }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('local file adapter writes the original disk file, preserves BOM and detects external conflicts', async () => localFixture(async ({ path, store, request, directory }) => {
  const descriptor = await store.register(path);
  const handle = new LocalFileHandle(descriptor, request);
  const original = await (await handle.getFile()).text();
  assert.equal(original, '\uFEFF# 原文件\n');
  const writer = new OriginalFileWriter(handle, original);
  await Promise.all([writer.save('# 第一次\n'), writer.save('# 第二次\n')]);
  assert.equal(await readFile(path, 'utf8'), '\uFEFF# 第二次\n');
  assert.equal((await stat(path)).mode & 0o777, 0o640);
  assert.deepEqual(await readdir(directory), ['测试 文档.md']);
  await writeFile(path, '# 外部修改\n');
  const external = await writer.inspectExternal();
  assert.equal(external.content, '# 外部修改\n');
  await assert.rejects(writer.save('# 网页修改\n'), error => error.code === 'EXTERNAL_MODIFICATION' && error.externalContent === '# 外部修改\n');
  assert.equal(await readFile(path, 'utf8'), '# 外部修改\n');
}));

test('local service only exposes registered files and requires exact Host, Origin and capability', async () => localFixture(async ({ path, request, store }) => {
  const descriptor = await store.register(path);
  assert.equal((await request('/__moye/file')).status, 403);
  assert.equal((await request('/__moye/file', { headers: { 'X-Moye-File': 'wrong' } })).status, 403);
  const headers = { 'X-Moye-File': descriptor.token };
  assert.equal((await request('/__moye/file', { headers }, { origin: 'https://example.com' })).status, 403);
  assert.equal((await request('/__moye/file', { headers }, { host: 'evil.test:5174' })).status, 403);
  assert.equal((await request('/__moye/file', { headers }, { origin: 'http://127.0.0.1:5174' })).status, 200);
  assert.equal((await request('/__moye/open', { method: 'POST', body: JSON.stringify({ path }) })).status, 403);
  assert.equal((await request('/__moye/open', { method: 'POST', headers: { 'X-Moye-Admin': 'admin-test' }, body: JSON.stringify({ path }) })).status, 200);
  for (const url of ['/.moye-runtime.json', '/package.json', '/local-service.mjs', '/src/file-access.test.js', '/src/../../.git/config']) {
    assert.equal((await request(url)).status, 404);
  }
  const response = await request('/');
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes('localFileFromHash'));
  assert.equal(response.headers['Referrer-Policy'], 'no-referrer');
}));

test('disk conflict is checked again after staging and simultaneous writers cannot overwrite each other', async () => localFixture(async ({ path, store }) => {
  const descriptor = await store.register(path); const record = store.authorized(descriptor.token);
  const originalRead = store.read.bind(store); let reads = 0;
  store.read = async target => {
    if (++reads === 2) await writeFile(path, '外部变化');
    return originalRead(target);
  };
  await assert.rejects(store.write(record, '\uFEFF# 原文件\n', '网页变化'), error => error.status === 409);
  assert.equal(await readFile(path, 'utf8'), '外部变化');
  store.read = originalRead;
  const results = await Promise.allSettled([store.write(record, '外部变化', '网页1'), store.write(record, '外部变化', '网页2')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(await readFile(path, 'utf8'), '网页1');
}));

test('registration rejects missing, oversized and invalid UTF-8 documents; symlinks resolve to original file', async () => localFixture(async ({ path, store, directory }) => {
  await assert.rejects(store.register(join(directory, 'missing.md')));
  const bad = join(directory, 'bad.md'); await writeFile(bad, Buffer.from([0xff, 0xfe]));
  await assert.rejects(store.register(bad), /UTF-8/);
  const large = join(directory, 'large.md'); await writeFile(large, Buffer.alloc(MAX_DOCUMENT_BYTES + 1));
  await assert.rejects(store.register(large), /2 MB/);
  const link = join(directory, '链接.md'); await symlink(path, link);
  assert.deepEqual(await store.register(link), await store.register(path));
  const record = store.authorized((await store.register(path)).token);
  await rm(path); await symlink(bad, path);
  await assert.rejects(store.read(record), /路径已改变/);
}));

test('local handles can be persisted and restored, and startup only accepts a well-formed file token', async () => {
  const descriptor = { id: 'id', path: '/tmp/a.md', name: 'a.md', token: 'a'.repeat(64) };
  const stored = new LocalFileHandle(descriptor).toStoredHandle();
  assert.deepEqual(structuredClone(stored), { type: 'moye-local-file', ...descriptor });
  assert.equal(await new LocalFileHandle(stored).isSameEntry(new LocalFileHandle(descriptor)), true);
  assert.equal(await localFileFromHash(''), null);
  await assert.rejects(localFileFromHash('#moye=bad'), /无效/);
  const handle = new LocalFileHandle(descriptor, async () => { throw new Error('offline'); });
  await assert.rejects(handle.getFile(), /重新运行 moye/);
});

const examplePNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTcQAAAAASUVORK5CYII=', 'base64');

test('image endpoint returns exact image bytes for same-directory and nested Unicode filenames', async () => localFixture(async ({ path, directory, store, request }) => {
  const file = await store.register(path);
  await mkdir(join(directory, 'images'));
  for (const imagePath of ['单台压测_用户数_RT_RPS.png', 'images/图 表(1).png', 'images/a&b.png']) {
    await writeFile(join(directory, imagePath), examplePNG);
    const url = localImageURL(file.token, imagePath);
    const result = await request(url);
    assert.equal(result.status, 200);
    assert.equal(result.headers['Content-Type'], 'image/png');
    assert.equal(result.headers['Cache-Control'], 'no-store');
    assert.deepEqual(result.bytes, examplePNG);
    const head = await request(url, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.bytes, undefined);
  }
  const encoded = await request(localImageURL(file.token, './images/图%20表(1).png'));
  assert.equal(encoded.status, 200);
  // Image reads reflect disk changes instead of a cached copy.
  const modified = Buffer.concat([examplePNG, Buffer.from('new')]);
  await writeFile(join(directory, '单台压测_用户数_RT_RPS.png'), modified);
  assert.deepEqual((await request(localImageURL(file.token, '单台压测_用户数_RT_RPS.png'))).bytes, modified);
}));

test('editing and saving a document keeps a usable relative image path rather than its local endpoint', async () => localFixture(async ({ path, directory, store, request }) => {
  const imagePath = '单台压测_用户数_RT_RPS.png';
  const markdown = `![用户数与平均 RT、RPS 的关系](${imagePath})\n`;
  await writeFile(path, markdown); await writeFile(join(directory, imagePath), examplePNG);
  const descriptor = await store.register(path);
  const writer = new OriginalFileWriter(new LocalFileHandle(descriptor, request), markdown);
  const text = { nodeType: 3, textContent: '修改后的内容' };
  const attributes = { 'data-image-path': imagePath, 'data-image-alt': '用户数与平均 RT、RPS 的关系', src: localImageURL(descriptor.token, imagePath), alt: '加载失败提示' };
  const image = { nodeType: 1, tagName: 'IMG', childNodes: [], style: {}, getAttribute: name => attributes[name] ?? null };
  const paragraph = { nodeType: 1, tagName: 'P', childNodes: [text, image], style: {} };
  const edited = serializeMarkdown({ childNodes: [paragraph] });
  await writer.save(edited);
  const saved = await readFile(path, 'utf8');
  assert.ok(saved.includes(markdown.trim()));
  assert.ok(!saved.includes(descriptor.token));
  assert.ok(!saved.includes('加载失败提示'));
  assert.ok(renderMarkdown(saved).includes('data-image-path="' + imagePath + '"'));
  assert.equal((await request(localImageURL(descriptor.token, imagePath))).status, 200);
}));

test('image endpoint rejects unauthorized, outside-directory, non-image and oversized file requests', async () => localFixture(async ({ path, directory, store, request }) => {
  const file = await store.register(path);
  const endpoint = imagePath => '/__moye/image?' + new URLSearchParams({ token: file.token, path: imagePath });
  assert.equal((await request('/__moye/image?path=a.png')).status, 403);
  assert.equal((await request(endpoint('a.png'), {}, { origin: 'https://example.com' })).status, 403);
  assert.equal((await request(endpoint('a.png'), { method: 'PUT' })).status, 405);
  assert.equal((await request(endpoint('missing.png'))).status, 404);
  for (const imagePath of ['../a.png', '%2e%2e/a.png', '/tmp/a.png', path, 'images/../a.png', 'a.svg', 'file:///a.png', 'a.png%00']) {
    assert.equal((await request(endpoint(imagePath))).status, 403, imagePath);
  }
  await writeFile(join(directory, 'fake.png'), 'not an image');
  assert.equal((await request(endpoint('fake.png'))).status, 415);
  await writeFile(join(directory, 'huge.png'), examplePNG); await truncate(join(directory, 'huge.png'), MAX_IMAGE_BYTES + 1);
  assert.equal((await request(endpoint('huge.png'))).status, 413);
  const outside = await mkdtemp(join(tmpdir(), 'moye-outside-'));
  try {
    await writeFile(join(outside, 'secret.png'), examplePNG);
    await symlink(join(outside, 'secret.png'), join(directory, 'escape.png'));
    await symlink(outside, join(directory, 'escape-directory'));
    assert.equal((await request(endpoint('escape.png'))).status, 403);
    assert.equal((await request(endpoint('escape-directory/secret.png'))).status, 403);
  } finally { await rm(outside, { recursive: true, force: true }); }
}));
