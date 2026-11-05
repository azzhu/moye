import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import { initialDocuments, welcome } from './samples.js';
import { renderMarkdown } from './markdown.js';

test('sample documents load and their fenced code renders correctly', () => {
  const docs = initialDocuments();
  assert.equal(docs.length, 3);
  assert.ok(welcome.includes('```javascript'));
  assert.match(renderMarkdown(welcome), /<pre data-language="javascript">/);
  for (const doc of docs) assert.ok(renderMarkdown(doc.markdown).includes('<h1>'));
});

test('standalone deliverable has valid executable JavaScript and no external dependencies', async () => {
  const html = await readFile(new URL('../墨页.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1);
  assert.ok(scripts[0][1].includes("$('#app').innerHTML"));
  assert.doesNotThrow(() => new Script(scripts[0][1], { filename: '墨页.html' }));
  assert.ok(!/<script[^>]+src=/.test(html));
  assert.ok(!/<link[^>]+rel="stylesheet"[^>]+href=/.test(html));
  assert.ok(!/^import\s/m.test(scripts[0][1]));
  assert.ok(!/<script[^>]+type="module"/.test(html));
  assert.ok(html.includes('墨页未能启动'));
});
