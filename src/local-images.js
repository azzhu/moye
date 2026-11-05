import { localImageURL } from './image-path.js';

export function localImageErrorMessage(status, detail) {
  if (status === 403 && detail === '无效的服务凭据') return '后台服务版本较旧；请先保存文档，再运行 moye --stop 并重新用 moye 打开文件';
  if (status === 404) return '图片文件不存在，请检查图片是否位于文档所在目录';
  return detail || '图片内容无法解码，请确认图片文件完整';
}

export function refreshLocalImages(editor, handle, request = (...args) => fetch(...args)) {
  for (const image of editor.querySelectorAll('img[data-image-path]')) {
    const path = image.getAttribute('data-image-path');
    const url = handle?.type === 'moye-local-file' ? localImageURL(handle.token, path) : '';
    const originalAlt = image.getAttribute('data-image-alt') || '';
    const failImage = message => {
      image.classList.add('local-image-error');
      image.alt = message + '：' + path;
      image.title = message + '：' + path;
    };
    if (!url) {
      image.removeAttribute('src');
      failImage('请通过 moye 命令打开文档以加载本地图片');
      continue;
    }
    if (image.getAttribute('src') === url) continue;
    image.classList.remove('local-image-error'); image.alt = originalAlt; image.title = path;
    let errorVersion = 0;
    image.onload = () => { errorVersion++; image.classList.remove('local-image-error'); image.alt = originalAlt; image.title = path; };
    image.onerror = async () => {
      const version = ++errorVersion;
      failImage('图片加载失败，正在检查原因');
      let reason;
      try {
        const response = await request(url, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(5000) });
        const data = response.ok ? null : await response.json();
        reason = localImageErrorMessage(response.status, data?.error);
      } catch { reason = '本地服务未连接，请在终端重新运行 moye 打开文件'; }
      if (image.getAttribute('src') === url && version === errorVersion) failImage(reason);
    };
    image.referrerPolicy = 'no-referrer';
    image.setAttribute('src', url);
  }
}
