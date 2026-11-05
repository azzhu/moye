// Only numeric layout values may reach CSS or the Markdown metadata comment.
export function normalizeTableLayout(value, count) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const width = value.width ?? 100;
  if (typeof width !== 'number' || !Number.isFinite(width) || width < 20 || width > 100) return null;
  let columns = value.columns ?? [];
  if (!Array.isArray(columns)) return null;
  if (columns.length) {
    if (columns.length !== count || !columns.every(n => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 100)) return null;
    const sum = columns.reduce((a, b) => a + b, 0);
    columns = columns.map(n => Math.round(n / sum * 1000000) / 10000);
    if (columns.some(n => n <= 0)) return null;
  }
  return { width: Math.round(width * 100) / 100, columns };
}

export function parseTableLayout(text, count) {
  try { return normalizeTableLayout(JSON.parse(text), count); } catch { return null; }
}

export function resizeTableColumns(columns, index, deltaPixels, tablePixels) {
  const result = [...columns];
  if (index < 0 || index >= columns.length - 1 || !Number.isFinite(deltaPixels) || !Number.isFinite(tablePixels) || tablePixels <= 0) return result;
  const pair = columns[index] + columns[index + 1];
  // Keep each neighbor at least 48 px where the available pair permits it.
  const minimum = Math.min(48 / tablePixels * 100, pair / 2);
  result[index] = Math.max(minimum, Math.min(pair - minimum, columns[index] + deltaPixels / tablePixels * 100));
  result[index + 1] = pair - result[index];
  return result;
}
