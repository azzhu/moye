import { LocalFileHandle } from './local-file-handle.js';

export const isMissingOriginalFile = error => error?.name === 'NotFoundError' || error?.code === 'ENOENT' || error?.code === 'FILE_NOT_FOUND';

export function hasUnsavedFileChanges(doc, baseline = doc.fileDiskContent) {
  if (!doc.fileDirty) return false;
  return typeof baseline !== 'string' || doc.markdown !== baseline.replace(/^\uFEFF/, '');
}

export class OriginalFileWriter {
  constructor(handle, diskContent) {
    this.handle = handle;
    this.diskContent = diskContent;
    this.bom = diskContent.startsWith('\uFEFF') ? '\uFEFF' : '';
    this.pending = Promise.resolve();
  }

  save(content) {
    const operation = this.pending.catch(() => {}).then(async () => {
      if (await this.handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
        throw new Error('文件写入授权已失效，请点击保存状态重新授权');
      }
      const next = this.bom + content.replace(/^\uFEFF/, '');
      if (this.handle.writeIfUnchanged) {
        await this.handle.writeIfUnchanged(this.diskContent, next);
        this.diskContent = next;
        return content;
      }
      const latest = await this.handle.getFile();
      const latestContent = await latest.text();
      if (latestContent !== this.diskContent) {
        const error = new Error('原文件已被其他程序修改，已停止写入；请点击保存状态核对冲突');
        error.code = 'EXTERNAL_MODIFICATION';
        error.externalContent = latestContent;
        throw error;
      }
      const writable = await this.handle.createWritable();
      try {
        await writable.write(next);
        await writable.close();
      } catch (error) {
        try { await writable.abort(); } catch {}
        throw error;
      }
      // Success means the stream has closed and the browser committed the file.
      this.diskContent = next;
      return content;
    });
    this.pending = operation;
    return operation;
  }

  async inspectExternal() {
    if (await this.handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
      throw new Error('文件授权已失效，无法检测外部修改；请点击保存状态重新授权');
    }
    const file = await this.handle.getFile();
    if (file.size > 2 * 1024 * 1024) throw new Error('原文件超过 2 MB，已暂停自动刷新');
    const content = await file.text();
    return { content, modified: file.lastModified };
  }
}

let handleDatabase;
function database() {
  if (!handleDatabase) handleDatabase = new Promise((resolve, reject) => {
    const request = indexedDB.open('inkwell.original-files', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('handles');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return handleDatabase;
}

export async function rememberFileHandle(id, handle) {
  const db = await database();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('handles', 'readwrite');
    transaction.objectStore('handles').put(handle.toStoredHandle?.() || handle, id);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function recallFileHandle(id) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction('handles', 'readonly').objectStore('handles').get(id);
    request.onsuccess = () => resolve(request.result?.type === 'moye-local-file' ? new LocalFileHandle(request.result) : request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function forgetFileHandle(id) {
  const db = await database();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('handles', 'readwrite');
    transaction.objectStore('handles').delete(id);
    transaction.objectStore('handles').delete(`@image-directory:${id}`);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
