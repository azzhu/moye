import { initialDocuments } from './samples.js';

export const HISTORY_LIMIT = 20;

const historyTime = doc => Math.max(
  Number.isFinite(doc.lastOpened) ? doc.lastOpened : 0,
  Number.isFinite(doc.updated) ? doc.updated : 0,
);

export function recentDocuments(records, preserve = () => false) {
  const seen = new Set();
  const ordered = records.filter(doc => {
    if (!doc || doc.trashed || typeof doc.id !== 'string' || typeof doc.title !== 'string' || typeof doc.markdown !== 'string' || seen.has(doc.id)) return false;
    seen.add(doc.id);
    return true;
  }).sort((a, b) => historyTime(b) - historyTime(a) || (a.id < b.id ? -1 : 1));
  return [...ordered.slice(0, HISTORY_LIMIT), ...ordered.slice(HISTORY_LIMIT).filter(preserve)];
}

export function migrateHistory(records) {
  const samples = initialDocuments();
  const normalize = value => value.replace(/\r\n?/g, '\n').trim();
  return recentDocuments(records.filter(doc => !samples.some(sample =>
    doc?.id === sample.id && doc.title === sample.title && typeof doc.markdown === 'string' && normalize(doc.markdown) === normalize(sample.markdown)
  )));
}
