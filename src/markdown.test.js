import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, inline, safeURL, safeTextColor, serializeMarkdown } from './markdown.js';

test('renders editable headings, lists, quotes, code, tasks and tables', () => {
  const result = renderMarkdown('# 标题\n\n**重点**和*斜体*\n\n- 项目\n  - 子项目\n\n> 引用\n\n- [x] 完成\n- [ ] 待办\n\n```js\nconst x = "<tag>";\n```\n\n| 左 | 右 |\n| --- | ---: |\n| 一 | 二 |');
  assert.match(result, /<h1>标题<\/h1>/);
  assert.match(result, /<strong>重点<\/strong>/);
  assert.match(result, /<em>斜体<\/em>/);
  assert.match(result, /<li>项目<ul><li>子项目/);
  assert.match(result, /<blockquote><p>引用/);
  assert.equal((result.match(/type="checkbox"/g) || []).length, 2);
  assert.match(result, /aria-label="任务状态" checked/);
  assert.match(result, /data-language="js"/);
  assert.match(result, /&lt;tag&gt;/);
  assert.match(result, /<th style="text-align:right">右/);
});
test('does not execute raw HTML or unsafe links', () => {
  const result = renderMarkdown('<script>alert(1)</script>\n\n[bad](javascript:alert)\n\n![bad](data:text/html,evil)');
  assert.ok(!result.includes('<script>'));
  assert.ok(!result.includes('href='));
  assert.ok(!result.includes('<img'));
  assert.equal(safeURL('javascript:alert(1)'), '');
  assert.equal(safeURL('https://example.com'), 'https://example.com');
  assert.equal(safeURL('  JaVaScRiPt:alert(1)'), '');
});
test('keeps code contents literal and escapes attributes', () => {
  assert.equal(inline('`**not bold**`'), '<code>**not bold**</code>');
  assert.equal(inline('`\\*literal*`'), '<code>\\*literal*</code>');
  assert.equal(inline('[`code`](https://example.com)'), '<a href="https://example.com" rel="noopener noreferrer"><code>code</code></a>');
  assert.ok(!renderMarkdown('```"onmouseover="evil\ncode\n```').includes('data-language=""onmouseover='));
  assert.match(inline('[site](https://example.com?a=1&b=2)'), /a=1&amp;b=2/);
});
test('handles empty documents, ordered list starts and fenced code', () => {
  assert.equal(renderMarkdown(''), '<p><br></p>');
  assert.match(renderMarkdown('3. three\n4. four'), /<ol start="3">/);
  assert.match(renderMarkdown('~~~~text\n```\n~~~~'), /<code>```<\/code>/);
});

function text(value) { return { nodeType: 3, textContent: value }; }
function element(tag, children = [], attributes = {}) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: children,
    children: children.filter(n => n.nodeType === 1),
    dataset: attributes.dataset || {},
    style: attributes.style || {},
    checked: !!attributes.checked,
    getAttribute: key => attributes[key] || null,
    querySelector(selector) { return selector.startsWith(':scope') ? this.children.find(n => n.tagName === 'INPUT') || null : this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.tagName.toLowerCase() === selector ? [child] : []), ...child.querySelectorAll(selector)]); },
    get textContent() { return this.childNodes.map(child => child.textContent).join(''); },
  };
  return node;
}

test('visual content serializes headings, inline formatting and literal markdown safely', () => {
  const root = element('article', [
    element('h2', [text('我的标题')]),
    element('p', [text('这是 '), element('strong', [text('重点')]), text(' 与 *普通星号*')]),
    element('p', [text('# 不应变成标题')]),
    element('p', [element('code', [text('a`b')])]),
  ]);
  const markdown = serializeMarkdown(root);
  assert.match(markdown, /^## 我的标题/);
  assert.match(markdown, /\*\*重点\*\*/);
  assert.ok(markdown.includes('\\*普通星号\\*'));
  const rendered = renderMarkdown(markdown);
  assert.match(rendered, /<strong>重点<\/strong>/);
  assert.ok(!rendered.includes('<em>普通星号</em>'));
  assert.match(rendered, /<p># 不应变成标题<\/p>/);
  assert.match(rendered, /<code>a`b<\/code>/);
});

test('visual task changes, nested lists and tables retain their structure', () => {
  const table = element('table', [element('thead', [element('tr', [element('th', [text('事项')]), element('th', [text('状态')], { style: { textAlign: 'right' } })])]), element('tbody', [element('tr', [element('td', [text('写作')]), element('td', [text('进行中')])])])]);
  const root = element('article', [element('ul', [element('li', [element('input', [], { checked: true }), element('span', [text('已编辑的任务')])]), element('li', [text('父项目'), element('ul', [element('li', [text('子项目')])])])]), table]);
  const markdown = serializeMarkdown(root);
  assert.ok(markdown.includes('- [x] 已编辑的任务'));
  assert.ok(markdown.includes('- 父项目\n  - 子项目'));
  assert.ok(markdown.includes('| --- | ---: |'));
  const rendered = renderMarkdown(markdown);
  assert.match(rendered, /<li>父项目<ul><li>子项目/);
  assert.match(rendered, /<td style="text-align:right">进行中/);
});

test('table layout survives visual serialization and reloading without changing cell contents or alignment', () => {
  const layout = { width: 80, columns: [25, 75] };
  const table = element('table', [
    element('colgroup', [element('col'), element('col')]),
    element('thead', [element('tr', [element('th', [text('项目')]), element('th', [text('说明')], { style: { textAlign: 'right' } })])]),
    element('tbody', [element('tr', [element('td', [text('A|B')]), element('td', [element('strong', [text('重点')])])])]),
  ], { dataset: { tableLayout: JSON.stringify(layout) } });
  const markdown = serializeMarkdown(element('article', [table]));
  assert.ok(markdown.startsWith('<!-- moye-table: {"width":80,"columns":[25,75]} -->\n| 项目 | 说明 |'));
  assert.ok(markdown.includes('| --- | ---: |'));
  assert.ok(markdown.includes('A\\|B'));
  const rendered = renderMarkdown(markdown);
  assert.ok(rendered.includes('style="width:80%;table-layout:fixed;"'));
  assert.ok(rendered.includes('<colgroup><col style="width:25%"><col style="width:75%"></colgroup>'));
  assert.ok(rendered.includes('<strong>重点</strong>'));
  assert.ok(!rendered.includes('<!--'));
  assert.ok(rendered.includes('data-table-layout='));
  delete table.dataset.tableLayout;
  assert.ok(!serializeMarkdown(element('article', [table])).includes('moye-table'));
});

test('table metadata attaches only to the immediately following table and is literal in code', () => {
  const marker = '<!-- moye-table: {"width":60,"columns":[30,70]} -->';
  const table = '| A | B |\n| --- | --- |\n| a | b |';
  const html = renderMarkdown('前文\n' + marker + '\n' + table + '\n\n' + table);
  assert.ok(html.startsWith('<p>前文</p>\n<table data-table-layout='));
  assert.equal((html.match(/data-table-layout=/g) || []).length, 1);
  for (const source of [marker, marker + '\n\n' + table, '```\n' + marker + '\n' + table + '\n```', '`' + marker + '`']) {
    assert.ok(!renderMarkdown(source).includes('data-table-layout='));
    assert.ok(renderMarkdown(source).includes('&lt;!--'));
  }
  const quoted = renderMarkdown('> ' + (marker + '\n' + table).replace(/\n/g, '\n> '));
  assert.ok(quoted.includes('<blockquote><table data-table-layout='));
});

test('invalid or unsafe table metadata stays literal and never enters CSS', () => {
  const table = '\n| A | B |\n| --- | --- |';
  for (const data of ['{"width":"80%;position:fixed"}', '{"width":101}', '{"width":0}', '{"columns":[30]}', '{"columns":[-1,101]}', '{"columns":[0,100]}', 'null', 'not-json']) {
    const rendered = renderMarkdown('<!-- moye-table: ' + data + ' -->' + table);
    assert.ok(!rendered.includes('data-table-layout='));
    assert.ok(rendered.includes('&lt;!--'));
  }
});

test('visual quotes and code blocks survive serialization without interpreting HTML', () => {
  const root = element('article', [element('blockquote', [element('p', [text('一段引用')])]), element('pre', [element('code', [text('<script>\n```\n</script>')])], { dataset: { language: 'html' } })]);
  const markdown = serializeMarkdown(root);
  assert.ok(markdown.includes('> 一段引用\n\n````html'));
  const rendered = renderMarkdown(markdown);
  assert.match(rendered, /&lt;script&gt;/);
  assert.ok(!rendered.includes('<script>'));
  assert.match(rendered, /```/);
});

test('code block controls never enter saved Markdown', () => {
  const root = element('article', [element('pre', [
    element('button', [text('已复制')]), element('code', [text('  const value = "<tag>";\n\nreturn value;')]),
  ], { dataset: { language: 'js' } })]);
  assert.equal(serializeMarkdown(root), '```js\n  const value = "<tag>";\n\nreturn value;\n```\n');
});

test('renders the supplied HTML span color inside paragraphs, headings and tables', () => {
  const colored = '<span style="color: #d32f2f;">+1</span>';
  assert.equal(renderMarkdown(colored), '<p>' + colored + '</p>');
  assert.equal(renderMarkdown('# ' + colored), '<h1>' + colored + '</h1>');
  const table = renderMarkdown('| 变动 | 说明 |\n| --- | --- |\n| ' + colored + ' | 增加 |');
  assert.ok(table.includes('<table>'));
  assert.ok(table.includes(colored));
  assert.equal(safeTextColor('#d32f2f'), '#d32f2f');
  assert.equal(safeTextColor('rgb(211, 47, 47)'), 'rgb(211, 47, 47)');
  assert.equal(safeTextColor('rgba(211, 47, 47, 0.5)'), 'rgba(211, 47, 47, 0.5)');
  assert.equal(safeTextColor('hsl(0, 100%, 50%)'), 'hsl(0, 100%, 50%)');
});

test('color spans preserve nested spans and Markdown formatting', () => {
  const html = inline('<span style="color: red;">**红色粗体** <span style="color: blue">蓝色</span> 红色</span>');
  assert.equal(html, '<span style="color: red;"><strong>红色粗体</strong> <span style="color: blue;">蓝色</span> 红色</span>');
  assert.equal(inline("<SPAN style='color: #ABC'>+1</SPAN>"), '<span style="color: #abc;">+1</span>');
});

test('only text color is allowed through HTML spans', () => {
  const html = inline('<span onclick="alert(1)" style="position:fixed; background:url(evil); color: #d32f2f;" data-x="evil">+1</span>');
  assert.equal(html, '<span style="color: #d32f2f;">+1</span>');
  for (const color of ['red; position:fixed', 'url(evil)', 'expression(alert(1))', '#fff" onmouseover="evil', 'rgb(999, 0, 0)']) {
    assert.equal(safeTextColor(color), '');
  }
  assert.equal(inline('<span style="color: expression(alert(1))">+1</span>'), '<span>+1</span>');
  assert.ok(!inline('<span style="color:red"><script>alert(1)</script></span>').includes('<script>'));
  assert.equal(inline('![<span style="color:red">说明</span>](https://example.com/image.png)'), '<img src="https://example.com/image.png" alt="说明" loading="lazy" />');
  assert.ok(!inline('[链接](https://example.com/<span style="color:red">x</span>)').includes('href='));
});

test('HTML color examples stay literal in code and escaped text', () => {
  const colored = '<span style="color: #d32f2f;">+1</span>';
  const code = renderMarkdown('`' + colored + '`');
  assert.ok(!code.includes('<span'));
  assert.ok(code.includes('&lt;span'));
  assert.ok(!renderMarkdown('```html\n' + colored + '\n```').includes('<span'));
  assert.equal(inline('\\<span style="color: red;">+1\\</span>'), '&lt;span style=&quot;color: red;&quot;&gt;+1&lt;/span&gt;');
  assert.equal(inline('<span style="color:red">未闭合'), '&lt;span style=&quot;color:red&quot;&gt;未闭合');
});

test('visual edits and export keep browser-normalized text colors', () => {
  const root = element('article', [element('p', [element('span', [text('+2'), element('strong', [text('新增')])], { style: { color: 'rgb(211, 47, 47)' } })])]);
  const markdown = serializeMarkdown(root);
  assert.equal(markdown, '<span style="color: rgb(211, 47, 47);">+2**新增**</span>\n');
  assert.equal(renderMarkdown(markdown), '<p><span style="color: rgb(211, 47, 47);">+2<strong>新增</strong></span></p>');
  const literal = serializeMarkdown(element('article', [element('p', [text('<span style="color:red">普通文字</span>')])]));
  assert.ok(!renderMarkdown(literal).includes('<span'));
});

test('relative images render as placeholders, supporting Chinese, subdirectories and angle-bracket space paths', () => {
  for (const path of ['单台压测_用户数_RT_RPS.png', './images/图片.webp', 'images/中文%20文件.png', '<images/图 表(1).png>', 'images/a&b.png']) {
    const result = renderMarkdown(`![用户数与平均 RT、RPS 的关系](${path})`);
    assert.ok(result.includes('<img data-image-path='), path);
    assert.ok(!result.includes(' src='), 'local files are resolved only after a command-line handle is connected');
    assert.ok(result.includes('data-image-alt="用户数与平均 RT、RPS 的关系"'));
  }
  const normal = '![说明](图片.png)';
  assert.ok(!renderMarkdown('`' + normal + '`').includes('<img'));
  assert.ok(!renderMarkdown('```\n' + normal + '\n```').includes('<img'));
  assert.ok(!renderMarkdown('![说明]\\(图片.png)').includes('<img'));
  for (const path of ['../图片.png', '/tmp/图片.png', 'file:///tmp/图片.png', 'javascript:evil.png', 'data:image/png,evil', '//example.com/a.png']) {
    assert.ok(!renderMarkdown(`![说明](${path})`).includes('<img'), path);
  }
});

test('visual edits preserve relative image paths and original alt text instead of service URLs or error messages', () => {
  for (const path of ['单台压测_用户数_RT_RPS.png', './images/图.png', 'images/图 表(1).png', 'images/中文%20文件.png', 'images/a&b.png']) {
    const image = element('img', [], {
      src: '/__moye/image?token=secret&path=internal',
      alt: '图片加载失败：' + path,
      'data-image-path': path,
      'data-image-alt': '原始说明',
    });
    const markdown = serializeMarkdown(element('article', [element('p', [text('编辑后的内容'), image])]));
    assert.ok(markdown.includes('![原始说明]('));
    assert.ok(markdown.includes(path));
    assert.ok(!markdown.includes('secret') && !markdown.includes('加载失败'));
    assert.ok(renderMarkdown(markdown).includes('<img data-image-path='));
  }
});

test('browser directory Blob URLs never enter the saved Markdown', () => {
  const root = element('article', [element('p', [element('img', [], {
    src: 'blob:http://localhost/temporary-image', alt: '图片读取失败',
    'data-image-path': './images/图.png', 'data-image-alt': '说明',
  })])]);
  assert.equal(serializeMarkdown(root), '![说明](./images/图.png)\n');
});
