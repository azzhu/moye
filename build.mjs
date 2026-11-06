import { readFile, writeFile } from 'node:fs/promises';
import { Script } from 'node:vm';

const root = new URL('.', import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');
const html = await read('index.html');
const css = await read('src/style.css');
const modules = await Promise.all(['src/table-layout.js', 'src/image-path.js', 'src/markdown.js', 'src/icons.js', 'src/samples.js', 'src/history.js', 'src/history-sync.js', 'src/code-copy.js', 'src/outline-tracking.js', 'src/local-file-handle.js', 'src/file-access.js', 'src/table-tools.js', 'src/local-images.js', 'src/directory-images.js', 'src/main.js'].map(read));
const js = modules.map(code => code.replace(/^import .+;\n/gm, '').replace(/^export /gm, '')).join('\n');
const entry = `(() => { 'use strict'; try {\n${js}\n} catch (error) {\nconsole.error(error);\nconst app = document.getElementById('app');\napp.innerHTML = '<section class="startup-message"><h1>墨页未能启动</h1><p>请刷新页面，或使用当前版本 Chrome、Edge、Safari 打开此文件。</p><details><summary>查看错误信息</summary><pre></pre></details></section>';\napp.querySelector('pre').textContent = String(error.message || error);\n} })();`;
// Validate the actual bundled entry point, including sample documents, before shipping.
new Script(entry, { filename: '墨页.html' });
const output = html.replace('<link rel="stylesheet" href="/src/style.css" />', () => `<style>${css}</style>`).replace('<script type="module" src="/src/main.js"></script>', () => `<script>${entry.replace(/<\/script/gi, '<\\/script')}</script>`);
await writeFile(new URL('墨页.html', root), output);
console.log('已生成独立文件：墨页.html（可直接用浏览器打开）');
