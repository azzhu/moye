import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { copyFilename } from './filename-copy.js';

test('copies the full filename including extension, preserving dots, case, spaces and Unicode', async () => {
  for (const filename of [
    '会议记录.md', '报告.v2.MARKDOWN', ' 我的 文档 .txt', 'README',
    'notes.md.txt', '.笔记.md', '.md',
  ]) {
    const copied = [], messages = [];
    assert.equal(await copyFilename(filename, message => messages.push(message), async value => copied.push(value)), true);
    assert.deepEqual(copied, [filename]);
    assert.deepEqual(messages, ['文件名已复制']);
  }
});

test('does not copy or report success without a usable filename', async () => {
  for (const filename of ['', null, undefined]) {
    assert.equal(await copyFilename(filename, () => assert.fail('unexpected notification'), () => assert.fail('unexpected copy')), false);
  }
});

test('reports failure without success and permits retry', async () => {
  const messages = [];
  const notify = message => messages.push(message);
  assert.equal(await copyFilename('笔记.md', notify, async () => { throw new Error('denied'); }), false);
  assert.deepEqual(messages, ['文件名复制失败，请允许浏览器访问剪贴板后重试']);
  assert.equal(await copyFilename('笔记.md', notify, async () => {}), true);
  assert.equal(messages.at(-1), '文件名已复制');
});

test('status filename is an accessible copy action, disabled when empty, and included in the bundle', async () => {
  const main = await readFile(new URL('./main.js', import.meta.url), 'utf8');
  assert.match(main, /<button type="button" class="status-filename"[^>]*data-action="copy-filename"[^>]*aria-label="复制文件名（含扩展名）"[^>]*disabled>/);
  assert.ok(main.includes("'copy-filename': () => { void copyFilename($('#status-filename').textContent, toast); }"));
  assert.ok(main.includes("$('#status-filename').disabled = !filename;"));
  const build = await readFile(new URL('../build.mjs', import.meta.url), 'utf8');
  assert.ok(build.includes("'src/filename-copy.js'"));
});
