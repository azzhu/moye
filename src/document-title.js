/** 输入 Markdown，跳过开头空行、HTML 注释和 YAML 元数据，返回首行一级标题内容或空串。 */
export function extractDocumentTitle(markdown = '') {
  const lines = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  let frontmatterSkipped = false;
  while (index < lines.length) {
    let line = lines[index];
    if (!line.trim()) { index++; continue; }
    if (!frontmatterSkipped && line.trim() === '---') {
      frontmatterSkipped = true;
      index++;
      while (index < lines.length && !/^(---|\.\.\.)\s*$/.test(lines[index].trim())) index++;
      if (index === lines.length) return '';
      index++;
      continue;
    }
    // 只跳过有效内容前的注释，保留结束标记后同一行的内容。
    while (line.trimStart().startsWith('<!--')) {
      line = line.trimStart().slice(4);
      while (!line.includes('-->')) {
        if (++index >= lines.length) return '';
        line = lines[index];
      }
      line = line.slice(line.indexOf('-->') + 3);
    }
    if (!line.trim()) { index++; continue; }
    const heading = /^#\s+(.*)$/.exec(line);
    return heading ? heading[1].replace(/\s+#+\s*$/, '').trim() : '';
  }
  return '';
}
