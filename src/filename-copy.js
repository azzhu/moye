import { copyCodeText } from './code-copy.js';

/** 输入完整文件名并复制不含末尾扩展名的名称；通知结果，返回是否成功，不修改文档。 */
export async function copyFilename(filename, notify, copy = copyCodeText) {
  if (!filename) return false;
  const name = filename.replace(/\.(md|markdown|txt)$/i, '');
  if (!name) return false;
  try {
    // 复用剪贴板兼容逻辑，只有实际复制成功才提示成功。
    await copy(name);
    notify('文件名已复制');
    return true;
  } catch {
    notify('文件名复制失败，请允许浏览器访问剪贴板后重试');
    return false;
  }
}
