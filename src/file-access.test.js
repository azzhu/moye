import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OriginalFileWriter } from './file-access.js';

async function fixture(t, content = '# 原始文件\n') {
  const directory = await mkdtemp(join(tmpdir(), 'inkwell-original-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, '原始笔记.md');
  await writeFile(path, content);
  const state = { permission: 'granted', opened: 0, closed: 0, aborted: 0, failClose: false };
  const handle = {
    async queryPermission() { return state.permission; },
    async getFile() { return { text: () => readFile(path, 'utf8') }; },
    async createWritable() {
      state.opened++;
      let next;
      return {
        async write(text) { next = text; },
        async close() {
          if (state.failClose) throw new Error('磁盘写入失败');
          await writeFile(path, next); state.closed++;
        },
        async abort() { state.aborted++; },
      };
    },
  };
  return { path, state, writer: new OriginalFileWriter(handle, content) };
}

test('writes edited Markdown back to the same original disk file', async t => {
  const { path, state, writer } = await fixture(t);
  await writer.save('# 修改后的原始文件\n\n<span style="color: #d32f2f;">+1</span>\n');
  assert.equal(await readFile(path, 'utf8'), '# 修改后的原始文件\n\n<span style="color: #d32f2f;">+1</span>\n');
  assert.equal(state.closed, 1);
  assert.equal(writer.diskContent, await readFile(path, 'utf8'));
});

test('serializes rapid saves so the latest edit remains on disk', async t => {
  const { path, state, writer } = await fixture(t);
  await Promise.all([writer.save('first'), writer.save('second'), writer.save('latest')]);
  assert.equal(await readFile(path, 'utf8'), 'latest');
  assert.equal(state.closed, 3);
});

test('permission rejection never writes to the original file', async t => {
  const { path, state, writer } = await fixture(t);
  state.permission = 'denied';
  await assert.rejects(writer.save('不得写入'), /授权/);
  assert.equal(state.opened, 0);
  assert.equal(await readFile(path, 'utf8'), '# 原始文件\n');
  state.permission = 'granted';
  await writer.save('重新授权后的修改');
  assert.equal(await readFile(path, 'utf8'), '重新授权后的修改');
});

test('external file changes stop automatic overwrites', async t => {
  const { path, state, writer } = await fixture(t);
  await writeFile(path, '其他程序的新内容');
  await assert.rejects(writer.save('浏览器草稿'), /其他程序修改/);
  assert.equal(await readFile(path, 'utf8'), '其他程序的新内容');
  assert.equal(state.opened, 0);
});

test('failed commits report an error and do not advance saved content', async t => {
  const { path, state, writer } = await fixture(t);
  state.failClose = true;
  await assert.rejects(writer.save('修改'), /磁盘写入失败/);
  assert.equal(state.aborted, 1);
  assert.equal(writer.diskContent, '# 原始文件\n');
  assert.equal(await readFile(path, 'utf8'), '# 原始文件\n');
  state.failClose = false;
  await writer.save('重试成功');
  assert.equal(await readFile(path, 'utf8'), '重试成功');
});

test('preserves UTF-8 BOM when updating an original file', async t => {
  const { path, writer } = await fixture(t, '\uFEFF原始内容');
  await writer.save('新内容');
  assert.equal(await readFile(path, 'utf8'), '\uFEFF新内容');
});

test('detects real external disk changes without writing or advancing the baseline', async t => {
  const { path, state, writer } = await fixture(t);
  await writeFile(path, '# 外部编辑器的新内容\n');
  const external = await writer.inspectExternal();
  assert.equal(external.content, '# 外部编辑器的新内容\n');
  assert.equal(writer.diskContent, '# 原始文件\n');
  assert.equal(state.opened, 0);
  await assert.rejects(writer.save('网页草稿'), error => {
    assert.equal(error.code, 'EXTERNAL_MODIFICATION');
    assert.equal(error.externalContent, external.content);
    return true;
  });
});

test('own writes match the observed baseline and require no refresh', async t => {
  const { writer } = await fixture(t);
  await writer.save('网页自己的修改');
  assert.equal((await writer.inspectExternal()).content, writer.diskContent);
});

test('external checks report missing files and lost permissions without writing', async t => {
  const { path, state, writer } = await fixture(t);
  state.permission = 'denied';
  await assert.rejects(writer.inspectExternal(), /授权已失效/);
  state.permission = 'granted';
  await rm(path);
  await assert.rejects(writer.inspectExternal(), /ENOENT/);
  assert.equal(state.opened, 0);
});
