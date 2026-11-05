import test from 'node:test';
import assert from 'node:assert/strict';
import { recentDocuments, migrateHistory, HISTORY_LIMIT } from './history.js';
import { initialDocuments } from './samples.js';

const entry = (id, updated = 0) => ({ id, title: id, markdown: '# ' + id, updated });

test('history retains the 20 most recently opened or edited documents', () => {
  const records = Array.from({ length: 25 }, (_, index) => entry(`doc-${index}`, index));
  const retained = recentDocuments(records);
  assert.equal(retained.length, HISTORY_LIMIT);
  assert.equal(retained[0].id, 'doc-24');
  assert.equal(retained.at(-1).id, 'doc-5');
  assert.equal(records.length, 25);
  records[0].lastOpened = 100;
  const reopened = recentDocuments(records);
  assert.equal(reopened[0].id, 'doc-0');
  assert.equal(reopened.at(-1).id, 'doc-6');
  records[1].updated = 200;
  assert.equal(recentDocuments(records)[0].id, 'doc-1');
});

test('migration removes untouched built-in examples and old trash, preserving actual content', () => {
  const [welcome, ideas, weekly] = initialDocuments();
  const modified = { ...ideas, markdown: ideas.markdown + '\n这是用户写下的内容。' };
  const renamed = { ...weekly, title: '我的计划' };
  const ownDocument = entry('user-document', 100);
  const deleted = { ...entry('deleted'), trashed: true };
  const migrated = migrateHistory([welcome, modified, renamed, ownDocument, deleted]);
  assert.equal(migrated.length, 3);
  assert.ok(migrated.some(doc => doc.id === modified.id && doc.markdown.endsWith('这是用户写下的内容。')));
  assert.ok(migrated.some(doc => doc.id === renamed.id && doc.title === '我的计划'));
  assert.ok(migrated.includes(ownDocument));
  assert.ok(!migrated.some(doc => doc.id === 'welcome' || doc.id === 'deleted'));
  assert.deepEqual(migrateHistory(initialDocuments()), []);
});

test('migration is repeatable, deduplicates and enforces the limit', () => {
  const ownDocument = entry('same-name-as-example');
  ownDocument.title = '欢迎使用墨页';
  const input = [...initialDocuments(), ownDocument, ownDocument, ...Array.from({ length: 30 }, (_, index) => entry(`real-${index}`, index + 10))];
  const migrated = migrateHistory(input);
  assert.equal(migrated.length, 20);
  assert.deepEqual(migrateHistory(migrated), migrated);
  assert.equal(recentDocuments([ownDocument, ownDocument]).length, 1);
  assert.equal(migrateHistory([ownDocument]).length, 1);
  assert.deepEqual(recentDocuments([null, {}, { id: 'bad', title: 1, markdown: '' }]), []);
});
