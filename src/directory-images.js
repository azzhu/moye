import { relativeImagePath } from './image-path.js';

export const imageDirectoryKey = id => `@image-directory:${id}`;

export async function validateImageDirectory(directory, fileHandle) {
  if (!fileHandle || fileHandle.type === 'moye-local-file') throw new Error('请先通过「打开文档」选择原始 Markdown 文件');
  let candidate;
  try { candidate = await directory.getFileHandle(fileHandle.name); }
  catch (error) {
    if (error.name === 'NotFoundError' || error.name === 'TypeMismatchError') throw new Error('请选择当前 Markdown 文件所在的文件夹，而不是图片子目录');
    throw error;
  }
  if (!await candidate.isSameEntry(fileHandle)) throw new Error('所选目录中的同名文件不是当前文档，请选择当前 Markdown 所在的文件夹');
}

export async function readDirectoryImage(directory, path) {
  const safePath = relativeImagePath(path);
  if (!safePath) throw new Error('图片路径无效，仅支持目录内的相对路径图片');
  const parts = safePath.split('/');
  let parent = directory;
  for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part);
  const handle = await parent.getFileHandle(parts.at(-1));
  const file = await handle.getFile();
  if (file.size > 20 * 1024 * 1024) throw new Error('图片超过 20 MB');
  return file;
}

function directoryImageError(error) {
  if (error.name === 'NotFoundError') return '图片文件不存在，请检查相对路径';
  if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return '图片目录读取权限已失效，请点击右上角「图片目录」重新授权';
  return error.message || '图片读取失败，请重新选择图片目录';
}

// Blob URLs belong only to the active document and are never serialized to Markdown.
export class DirectoryImageLoader {
  constructor({ createURL = file => URL.createObjectURL(file), revokeURL = url => URL.revokeObjectURL(url) } = {}) {
    this.createURL = createURL; this.revokeURL = revokeURL; this.context = null;
  }

  clear() {
    const context = this.context;
    this.context = null;
    if (context) for (const resource of context.resources.values()) if (resource.url) this.revokeURL(resource.url);
  }

  fail(image, message) {
    image.onload = null; image.onerror = null;
    image.removeAttribute('src');
    image.classList.add('local-image-error');
    image.alt = `${message}：${image.getAttribute('data-image-path')}`;
    image.title = image.alt;
  }

  async refresh(editor, docId, fileHandle, directory) {
    if (!this.context || this.context.editor !== editor || this.context.docId !== docId || this.context.fileHandle !== fileHandle || this.context.directory !== directory) {
      this.clear();
      this.context = { editor, docId, fileHandle, directory, resources: new Map(), validation: null, images: [] };
    }
    const context = this.context;
    const images = [...editor.querySelectorAll('img[data-image-path]')];
    context.images = images;
    const paths = new Set(images.map(image => image.getAttribute('data-image-path')));
    for (const [path, resource] of context.resources) if (!paths.has(path)) {
      context.resources.delete(path);
      if (resource.url) this.revokeURL(resource.url);
    }
    const current = () => this.context === context;
    const failAll = message => { if (current()) for (const image of context.images) this.fail(image, message); };
    if (!directory) {
      failAll('请点击右上角「图片目录」，授权 Markdown 所在文件夹以显示图片');
      return { permission: 'prompt' };
    }
    try {
      const permission = await directory.queryPermission({ mode: 'read' });
      if (!current()) return null;
      if (permission !== 'granted') {
        // Permission checks are passive: background refresh never opens an authorization prompt.
        for (const resource of context.resources.values()) if (resource.url) this.revokeURL(resource.url);
        context.resources.clear();
        failAll('图片目录读取权限已失效，请点击右上角「图片目录」重新授权');
        return { permission };
      }
      context.validation ||= validateImageDirectory(directory, fileHandle);
      await context.validation;
      if (!current()) return null;
      const jobs = context.images.map(async image => {
        const path = image.getAttribute('data-image-path');
        let resource = context.resources.get(path);
        if (!resource) {
          resource = { url: null, error: null };
          context.resources.set(path, resource);
          resource.pending = readDirectoryImage(directory, path).then(file => {
            if (!current() || context.resources.get(path) !== resource) return;
            resource.url = this.createURL(file);
          }).catch(error => { resource.error = directoryImageError(error); });
        }
        await resource.pending;
        if (!current() || context.resources.get(path) !== resource || !context.images.includes(image)) return;
        if (resource.error) { this.fail(image, resource.error); return; }
        if (!resource.url || image.getAttribute('src') === resource.url) return;
        const originalAlt = image.getAttribute('data-image-alt') || '';
        image.onload = () => {
          if (current() && image.getAttribute('src') === resource.url) {
            image.classList.remove('local-image-error'); image.alt = originalAlt; image.title = path;
          }
        };
        image.onerror = () => {
          if (current() && image.getAttribute('src') === resource.url) this.fail(image, '图片内容无法解码，请检查文件完整性');
        };
        image.classList.remove('local-image-error'); image.alt = originalAlt; image.title = path;
        image.setAttribute('src', resource.url);
      });
      await Promise.all(jobs);
      return current() ? { permission: 'granted', name: directory.name } : null;
    } catch (error) {
      failAll(directoryImageError(error));
      return current() ? { permission: 'error', error: directoryImageError(error) } : null;
    }
  }
}
