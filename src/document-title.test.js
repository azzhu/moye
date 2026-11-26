import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { extractDocumentTitle } from './document-title.js';

test('extracts only the first effective H1 after BOM, blank lines, comments and YAML metadata', () => {
  const cases = [
    ['# 标题\n正文', '标题'],
    ['\uFEFF\r\n\r\n# 中文 title ###\r\n', '中文 title'],
    ['<!-- 注释\n# 不采用\n-->\n# 正确标题', '正确标题'],
    ['<!-- A --><!-- B --># 同行标题', '同行标题'],
    ['---\ntitle: 元数据\n---\n\n<!-- 注释 -->\n# 文档标题', '文档标题'],
    ['\n---\na: b\n...\n# 标题', '标题'],
    ['# **粗体** 与 `代码`', '**粗体** 与 `代码`'],
  ];
  for (const [source, expected] of cases) assert.equal(extractDocumentTitle(source), expected);
});

test('does not search later headings or accept empty, nested or incomplete headers', () => {
  for (const source of [
    '', '\n\n', '# ', '# ###', '## 二级\n# 后面', '正文\n# 后面',
    '```md\n# 代码\n```', '> # 引用', '    # 缩进代码', '#没有空格',
    '---\ntitle: 未结束\n# 后面', '<!-- 未结束\n# 后面',
    '标题\n===', '<!-- 注释 -->正文\n# 后面',
  ]) assert.equal(extractDocumentTitle(source), '', source);
});

test('status title updates and hides on edits, document switches and empty state without changing filename', async () => {
  const main = await readFile(new URL('./main.js', import.meta.url), 'utf8');
  const source = /function updateDocumentTitle\(\) \{[\s\S]*?\n\}/.exec(main)[0];
  let doc = { markdown: '# 标题' };
  const label = {};
  const update = runInNewContext(`(${source})`, {
    extractDocumentTitle, current: () => doc,
    inline: value => value,
    document: { createElement: () => ({ content: {}, set innerHTML(value) { this.content.textContent = value; } }) },
    $: selector => { assert.equal(selector, '#status-document-title'); return label; },
  });
  update(); assert.equal(label.textContent, '标题'); assert.equal(label.title, '标题'); assert.equal(label.hidden, false);
  doc.markdown = '# 新标题'; update(); assert.equal(label.textContent, '新标题');
  doc = { markdown: '正文\n# 不是大 title' }; update(); assert.equal(label.hidden, true); assert.equal(label.textContent, '');
  doc = null; update(); assert.equal(label.hidden, true);
  assert.match(main, /function updateStats\(\) \{\s+updateDocumentTitle\(\);/);
  assert.match(main, /id="status-document-title"[^>]*hidden/);
  assert.ok(main.includes("void copyFilename($('#status-filename').textContent, toast)"));
});
