import { recentDocuments } from './history.js';

export const HISTORY_STORAGE_PREFIX = 'inkwell.history.v2:';
export const PAGE_DRAFT_STORAGE_KEY = 'inkwell.page-drafts.v1';
const contentFields = ['markdown', 'fileDirty', 'fileDiskContent', 'updated'];
const validRecord = doc => doc && typeof doc.id === 'string' && typeof doc.title === 'string' && typeof doc.markdown === 'string';

export function restorePageDrafts(storage, records) {
  const drafts = JSON.parse(storage.getItem(PAGE_DRAFT_STORAGE_KEY) || '[]');
  const combined = new Map(records.map(doc => [doc.id, doc]));
  if (Array.isArray(drafts)) {
    for (const doc of drafts) if (validRecord(doc) && doc.fileDirty) combined.set(doc.id, doc);
  }
  return [...combined.values()];
}

// Apply only this page's changes. Merely reopening an old cached document must
// not replace a newer draft or title published by another page.
export function mergeHistoryRecord(local, remote, baseline) {
  if (!remote || !baseline) return { ...local };
  const merged = { ...remote };
  const changed = key => JSON.stringify(local[key]) !== JSON.stringify(baseline[key]);
  for (const key of new Set([...Object.keys(local), ...Object.keys(baseline)])) {
    if (contentFields.includes(key) || key === 'lastOpened' || !changed(key)) continue;
    if (key in local) merged[key] = local[key];
    else delete merged[key];
  }
  if (contentFields.some(changed)) {
    for (const key of contentFields) {
      if (key in local) merged[key] = local[key];
      else delete merged[key];
    }
  }
  const opened = Math.max(Number(local.lastOpened) || 0, Number(remote.lastOpened) || 0);
  if (opened) merged.lastOpened = opened;
  return merged;
}

export class SharedHistoryStore {
  constructor(storage) {
    this.storage = storage;
    this.baselines = new Map();
    this.lastSignal = null;
    this.sequence = 0;
    this.client = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  }

  key(kind, id = '') { return HISTORY_STORAGE_PREFIX + kind + (id ? ':' + encodeURIComponent(id) : ''); }
  isDeleted(id) { return this.storage.getItem(this.key('deleted', id)) !== null; }
  remember(doc) { this.baselines.set(doc.id, JSON.stringify(doc)); }
  hasLocalChanges(doc) { return this.baselines.get(doc.id) !== JSON.stringify(doc); }
  signal() {
    this.storage.setItem(this.key('changed'), `${this.client}:${++this.sequence}`);
  }
  hasChanges() { return this.storage.getItem(this.key('changed')) !== this.lastSignal; }

  initialize(legacyRecords) {
    let wrote = false;
    // During an upgrade, different old pages may unload different legacy
    // snapshots. Import only missing records, always respecting tombstones.
    for (const doc of recentDocuments(legacyRecords)) {
      const key = this.key('record', doc.id);
      if (!this.isDeleted(doc.id) && this.storage.getItem(key) === null) {
        this.storage.setItem(key, JSON.stringify(doc));
        wrote = true;
      }
    }
    if (this.storage.getItem(this.key('ready')) === null) {
      this.storage.setItem(this.key('ready'), '1');
      wrote = true;
    }
    if (wrote) this.signal();
    const records = this.read();
    records.forEach(doc => this.remember(doc));
    return records;
  }

  allRecords() {
    const keys = [];
    for (let index = 0; index < this.storage.length; index++) {
      const key = this.storage.key(index);
      if (key?.startsWith(this.key('record') + ':')) keys.push(key);
    }
    return keys.flatMap(key => {
      let doc;
      try { doc = JSON.parse(this.storage.getItem(key)); } catch { return []; }
      return validRecord(doc) && key === this.key('record', doc.id) && !this.isDeleted(doc.id) ? [doc] : [];
    });
  }

  read() {
    // Capture the signal before reading so a write arriving mid-read is picked
    // up again by the fallback poll even if a storage event was missed.
    this.lastSignal = this.storage.getItem(this.key('changed'));
    return recentDocuments(this.allRecords());
  }

  publish(localRecords) {
    let wrote = false;
    for (const local of localRecords) {
      if (!validRecord(local)) continue;
      const encoded = JSON.stringify(local);
      const previous = this.baselines.get(local.id);
      if (previous === encoded || this.isDeleted(local.id)) continue;
      const key = this.key('record', local.id);
      let remote;
      try { remote = JSON.parse(this.storage.getItem(key)); } catch { /* Replace only a malformed record. */ }
      const next = mergeHistoryRecord(local, validRecord(remote) ? remote : null, previous ? JSON.parse(previous) : null);
      this.storage.setItem(key, JSON.stringify(next));
      this.baselines.set(local.id, encoded);
      wrote = true;
    }
    const all = this.allRecords();
    const keep = new Set(recentDocuments(all).map(doc => doc.id));
    for (const doc of all) {
      if (keep.has(doc.id)) continue;
      // Evicted entries need tombstones too, or an idle page could bring them
      // back and repeatedly displace newer history entries.
      this.storage.setItem(this.key('deleted', doc.id), '1');
      this.storage.removeItem(this.key('record', doc.id));
      wrote = true;
    }
    if (wrote) this.signal();
    return this.read();
  }

  delete(id) {
    // The separate durable marker wins even over a simultaneous stale write
    // to this record's key. It is never cleared by merging or polling.
    this.storage.setItem(this.key('deleted', id), '1');
    this.storage.removeItem(this.key('record', id));
    this.signal();
  }
}
