import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { isMissingOriginalFile } from './file-access.js';

const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const fn = name => main.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0];

test('only confirmed missing-file errors identify deleted or moved originals', () => {
  for (const error of [{ name: 'NotFoundError' }, { code: 'ENOENT' }, { code: 'FILE_NOT_FOUND' }]) assert.equal(isMissingOriginalFile(error), true);
  for (const error of [null, { name: 'NotAllowedError' }, { code: 'EACCES' }, { status: 404 }, new Error('offline')]) assert.equal(isMissingOriginalFile(error), false);
});

function fixture() {
  const doc = { id: 'one', title: '文档', markdown: '历史内容' };
  const calls = { reads: 0, saved: 0 };
  let error = Object.assign(new Error('missing'), { name: 'NotFoundError' });
  let permission = 'granted';
  const handle = {
    queryPermission: async options => { assert.equal(options.mode, 'read'); return permission; },
    getFile: async () => { calls.reads++; if (error) throw error; return {}; },
    requestPermission() { throw new Error('Background checks must not prompt'); },
  };
  const elements = { '#history-count': {}, '#document-list': {} };
  const context = {
    documents: [doc], sharedHistoryRecords: null, activeId: 'one', HISTORY_LIMIT: 20,
    checkingHistoryAvailability: false, document: { hidden: false }, handleRestore: Promise.resolve(),
    fileHandles: new Map([['one', handle]]), fileWriteCounts: new Map(), deletingRecords: new Set(),
    isMissingOriginalFile, save: () => calls.saved++,
    $: selector => elements[selector], icon: () => '', escapeHTML: value => value,
  };
  const api = runInNewContext(['setOriginalFileMissing', 'renderDocumentList', 'checkHistoryFileAvailability'].map(fn).join('\n') + '\n({checkHistoryFileAvailability});', context);
  return { doc, calls, handle, context, api, elements, error: value => { error = value; }, permission: value => { permission = value; } };
}

test('passive history checks mark missing names, persist once, and clear the mark after file recovery', async () => {
  const setup = fixture();
  await setup.api.checkHistoryFileAvailability();
  assert.equal(setup.doc.fileMissing, true);
  assert.match(setup.elements['#document-list'].innerHTML, /selected file-missing/);
  assert.match(setup.elements['#document-list'].innerHTML, /原文件不存在/);
  assert.equal(setup.calls.saved, 1);
  await setup.api.checkHistoryFileAvailability();
  assert.equal(setup.calls.saved, 1);
  setup.error(null); await setup.api.checkHistoryFileAvailability();
  assert.equal(setup.doc.fileMissing, false);
  assert.doesNotMatch(setup.elements['#document-list'].innerHTML, /file-missing/);
  assert.equal(setup.calls.saved, 2);
});

test('permission loss, unavailable service, hidden pages and obsolete checks do not mark files missing', async () => {
  for (const situation of ['denied', 'prompt', 'error', 'hidden', 'replaced', 'write']) {
    const setup = fixture();
    if (['denied', 'prompt'].includes(situation)) setup.permission(situation);
    if (situation === 'error') setup.error(new Error('offline'));
    if (situation === 'hidden') setup.context.document.hidden = true;
    if (situation === 'write') setup.context.fileWriteCounts.set('one', 1);
    if (situation === 'replaced') setup.handle.getFile = async () => {
      setup.context.fileHandles.set('one', {});
      throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
    };
    await setup.api.checkHistoryFileAvailability();
    assert.equal(setup.doc.fileMissing, undefined, situation);
    assert.equal(setup.calls.saved, 0, situation);
  }
});
