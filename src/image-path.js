// Resolve only relative image paths beneath the Markdown document's directory.
export function relativeImagePath(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f\\]/.test(value)) return '';
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { return ''; }
  if (/^[\/]|^[a-z][a-z0-9+.-]*:/i.test(decoded) || /[\u0000-\u001f\u007f\\]/.test(decoded)) return '';
  const parts = decoded.split('/');
  if (parts.some(part => part === '..')) return '';
  const path = parts.filter(part => part && part !== '.').join('/');
  return /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i.test(path) ? path : '';
}

export function localImageURL(token, path) {
  if (!/^[a-f0-9]{64}$/.test(token || '') || !relativeImagePath(path)) return '';
  return '/__moye/image?' + new URLSearchParams({ token, path }).toString();
}
