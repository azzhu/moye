import test from 'node:test';
import assert from 'node:assert/strict';
import { relativeImagePath, localImageURL } from './image-path.js';
import { refreshLocalImages, localImageErrorMessage } from './local-images.js';

test('local image URLs encode filenames and keep the original document path separate', () => {
  assert.equal(relativeImagePath('./images/图%20表.png'), 'images/图 表.png');
  assert.equal(relativeImagePath('images/图(1).PNG'), 'images/图(1).PNG');
  const token = 'a'.repeat(64);
  const url = new URL(localImageURL(token, './images/图 表.png'), 'http://127.0.0.1:5174');
  assert.equal(url.pathname, '/__moye/image');
  assert.equal(url.searchParams.get('token'), token);
  assert.equal(url.searchParams.get('path'), './images/图 表.png');
  for (const path of ['../a.png', '%2e%2e/a.png', 'images/%2e%2e/a.png', '/a.png', '%2fa.png', '\\a.png', 'images/%5ca.png', 'a.png%00', 'https://a.png', 'file:a.png', 'a.svg', 'a.txt', '%zz.png', '', null]) {
    assert.equal(relativeImagePath(path), '', String(path));
    assert.equal(localImageURL(token, path), '', String(path));
  }
  assert.equal(localImageURL('bad', 'a.png'), '');
});

function imageFixture() {
  const attributes = { 'data-image-path': './图.png', 'data-image-alt': '原始说明' };
  const classes = new Set(); const sources = [];
  const image = {
    getAttribute: name => attributes[name] ?? null,
    setAttribute(name, value) { attributes[name] = value; if (name === 'src') sources.push(value); },
    removeAttribute: name => delete attributes[name],
    classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
  };
  return { image, attributes, classes, sources, editor: { querySelectorAll: () => [image] } };
}

test('local image hydration uses the active file token and exposes useful failure hints without losing original metadata', async () => {
  const setup = imageFixture(); const handle = { type: 'moye-local-file', token: 'b'.repeat(64) };
  refreshLocalImages(setup.editor, handle, async () => ({ status: 404, ok: false, json: async () => ({ error: 'file missing' }) }));
  assert.equal(setup.image.alt, '原始说明');
  assert.equal(setup.sources.length, 1);
  refreshLocalImages(setup.editor, handle); assert.equal(setup.sources.length, 1);
  await setup.image.onerror();
  assert.ok(setup.image.alt.includes('图片文件不存在'));
  assert.equal(setup.attributes['data-image-alt'], '原始说明');
  assert.equal(setup.attributes['data-image-path'], './图.png');
  setup.image.onload(); assert.equal(setup.image.alt, '原始说明'); assert.equal(setup.classes.size, 0);
  refreshLocalImages(setup.editor, { ...handle, token: 'c'.repeat(64) }); assert.equal(setup.sources.length, 2);
});

test('image failures distinguish old servers from missing files and format errors', async () => {
  assert.ok(localImageErrorMessage(403, '无效的服务凭据').includes('moye --stop'));
  assert.ok(localImageErrorMessage(404, 'not found').includes('不存在'));
  assert.equal(localImageErrorMessage(415, '图片格式无效'), '图片格式无效');
  const setup = imageFixture();
  refreshLocalImages(setup.editor, { type: 'moye-local-file', token: 'd'.repeat(64) }, async () => ({ status: 403, ok: false, json: async () => ({ error: '无效的服务凭据' }) }));
  await setup.image.onerror();
  assert.ok(setup.image.alt.includes('后台服务版本较旧'));
  assert.equal(setup.attributes['data-image-alt'], '原始说明');
});

test('late error diagnostics do not replace a successfully loaded image', async () => {
  const setup = imageFixture(); let resolveResponse;
  refreshLocalImages(setup.editor, { type: 'moye-local-file', token: 'e'.repeat(64) }, () => new Promise(resolve => { resolveResponse = resolve; }));
  const pending = setup.image.onerror();
  setup.image.onload();
  resolveResponse({ status: 404, ok: false, json: async () => ({ error: 'not found' }) });
  await pending;
  assert.equal(setup.image.alt, '原始说明'); assert.equal(setup.classes.size, 0);
});

test('browser picker documents retain image references but explicitly require moye for loading them', () => {
  const setup = imageFixture();
  refreshLocalImages(setup.editor, null);
  assert.equal(setup.attributes.src, undefined);
  assert.ok(setup.image.alt.includes('moye'));
  assert.equal(setup.attributes['data-image-path'], './图.png');
  assert.ok(setup.classes.has('local-image-error'));
});
