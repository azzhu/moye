import { parseTableLayout } from './table-layout.js';
import { relativeImagePath } from './image-path.js';
export const escapeHTML = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function safeURL(value) {
  const url = String(value).trim();
  return /^(https?:\/\/|mailto:|#)/i.test(url) ? url : '';
}

// Keep only a single text color value; never pass through arbitrary CSS or HTML attributes.
export function safeTextColor(value) {
  const color = String(value || '').trim().toLowerCase();
  if (/^#(?:[a-f0-9]{3}|[a-f0-9]{4}|[a-f0-9]{6}|[a-f0-9]{8})$/.test(color)) return color;
  if (/^[a-z]{1,24}$/.test(color)) return color;
  const functional = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(color);
  if (!functional) return '';
  const parts = functional[2].split(',').map(part => part.trim());
  const hasAlpha = functional[1].endsWith('a');
  if (parts.length !== (hasAlpha ? 4 : 3)) return '';
  const validNumber = (part, max) => /^\d*\.?\d+%?$/.test(part) && Number(part.replace('%', '')) <= (part.endsWith('%') ? 100 : max);
  if (functional[1].startsWith('rgb')) {
    if (!parts.slice(0, 3).every(part => validNumber(part, 255))) return '';
  } else if (!/^-?\d*\.?\d+(?:deg)?$/.test(parts[0]) || !parts.slice(1, 3).every(part => part.endsWith('%') && validNumber(part, 100))) return '';
  if (hasAlpha && !validNumber(parts[3], 1)) return '';
  return functional[1] + '(' + parts.join(', ') + ')';
}

export function inline(source) {
  const tokens = [];
  const stash = html => `\u0000${tokens.push(html) - 1}\u0000`;
  const restore = value => value.replace(/\u0000(\d+)\u0000/g, (_, i) => restore(tokens[Number(i)] || ''));
  let text = String(source).replace(/\u0000/g, '').replace(/(`+)([^\n]*?)\1/g, (_, delimiter, code) => {
    if (code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
    return stash(`<code>${escapeHTML(code)}</code>`);
  });
  text = text.replace(/\\([\\`*{}\[\]()#+\-.!_><|~])/g, (_, char) => stash(escapeHTML(char)));
  const spanStack = [];
  text = text.replace(/<\/?span\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, tag => {
    if (/^<\/span\s*>$/i.test(tag)) {
      if (!spanStack.length) return tag;
      spanStack.pop();
      return stash('</span>');
    }
    if (/^<\//.test(tag) || /\/\s*>$/.test(tag)) return tag;
    const style = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const declarations = (style?.[1] || style?.[2] || '').split(';');
    const colorDeclaration = declarations.map(declaration => /^\s*color\s*:\s*(.*?)\s*$/i.exec(declaration)).filter(Boolean).at(-1);
    const color = safeTextColor(colorDeclaration?.[1]);
    spanStack.push({ index: tokens.length, raw: tag });
    return stash(color ? `<span style="color: ${color};">` : '<span>');
  });
  for (const unclosed of spanStack) tokens[unclosed.index] = escapeHTML(unclosed.raw);
  text = escapeHTML(text);
  text = text.replace(/!\[([^\]]*)\]\((?:&lt;([^\n]*?)&gt;|([^\s)]+))\)/g, (_, alt, angled, plain) => {
    const url = (angled ?? plain).replace(/&(amp|quot|#39|lt|gt);/g, (_, entity) => ({ amp: '&', quot: '"', '#39': "'", lt: '<', gt: '>' }[entity]));
    const valid = url.includes('\u0000') ? '' : safeURL(url);
    const plainAlt = restore(alt).replace(/<[^>]*>/g, '');
    if (valid && /^https?:/i.test(valid)) return stash(`<img src="${escapeHTML(valid)}" alt="${plainAlt}" loading="lazy" />`);
    if (relativeImagePath(url)) return stash(`<img data-image-path="${escapeHTML(url)}" data-image-alt="${plainAlt}" alt="${plainAlt}" loading="lazy" />`);
    return stash(plainAlt);
  });
  text = text.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_, label, url) => {
    const valid = url.includes('\u0000') ? '' : safeURL(url.replace(/&amp;/g, '&'));
    return stash(valid ? `<a href="${escapeHTML(valid)}" rel="noopener noreferrer">${label}</a>` : label);
  });
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>').replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  return restore(text);
}

const tableCells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(s => s.trim().replace(/\\\|/g, '|'));
const isTableDivider = line => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line || '');
const isList = line => /^(\s*)([-+*]|\d+\.)\s+(.*)$/.exec(line);

export function renderMarkdown(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const html = [];
  const special = (line, next) => /^\s*(```|~~~|#{1,6}\s|>|<!-- moye-table:|([-*_])(?:\s*\2){2,}\s*$)/.test(line) || isList(line) || isTableDivider(next);
  function list(baseIndent) {
    let output = '';
    const first = isList(lines[i]);
    const ordered = /\d/.test(first[2]);
    const tag = ordered ? 'ol' : 'ul';
    const start = ordered ? Number(first[2].slice(0, -1)) : 1;
    output += `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>`;
    while (i < lines.length) {
      const m = isList(lines[i]);
      if (!m || m[1].length !== baseIndent || /\d/.test(m[2]) !== ordered) break;
      let content = m[3];
      const task = /^\[([ xX])\]\s?(.*)$/.exec(content);
      output += task ? `<li class="task-item"><input type="checkbox" contenteditable="false" aria-label="任务状态" ${task[1] !== ' ' ? 'checked' : ''}><span>${inline(task[2])}</span>` : `<li>${inline(content)}`;
      i++;
      while (i < lines.length) {
        const nested = isList(lines[i]);
        if (nested && nested[1].length > baseIndent) output += list(nested[1].length);
        else if (lines[i].trim() && !nested && lines[i].match(/^\s+/)?.[0].length > baseIndent) output += `<br>${inline(lines[i++].trim())}`;
        else break;
      }
      output += '</li>';
    }
    return output + `</${tag}>`;
  }
  while (i < lines.length) {
    let line = lines[i];
    let tableLayout = null;
    const metadata = /^\s*<!-- moye-table: (.*?) -->\s*$/.exec(line);
    if (metadata && isTableDivider(lines[i + 2])) {
      tableLayout = parseTableLayout(metadata[1], tableCells(lines[i + 1]).length);
      if (tableLayout) line = lines[++i];
    }
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*(`{3,}|~{3,})([^\s]*)\s*$/.exec(line);
    if (fence) {
      i++;
      const code = [];
      while (i < lines.length && !(lines[i].trim().startsWith(fence[1][0].repeat(fence[1].length)))) code.push(lines[i++]);
      if (i < lines.length) i++;
      html.push(`<pre data-language="${escapeHTML(fence[2])}"><code>${escapeHTML(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { html.push(`<h${heading[1].length}>${inline(heading[2].replace(/\s+#+\s*$/, ''))}</h${heading[1].length}>`); i++; continue; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { html.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*> ?/, ''));
      html.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`); continue;
    }
    if (isTableDivider(lines[i + 1])) {
      const header = tableCells(lines[i]);
      const aligns = tableCells(lines[i + 1]).map(s => s.startsWith(':') && s.endsWith(':') ? 'center' : s.endsWith(':') ? 'right' : 'left');
      const layoutAttributes = tableLayout ? ` data-table-layout="${escapeHTML(JSON.stringify(tableLayout))}" style="width:${tableLayout.width}%;${tableLayout.columns.length ? 'table-layout:fixed;' : ''}"` : '';
      const columnGroup = tableLayout?.columns.length ? '<colgroup>' + tableLayout.columns.map(width => `<col style="width:${width}%">`).join('') + '</colgroup>' : '';
      html.push(`<table${layoutAttributes}>${columnGroup}<thead><tr>` + header.map((s, n) => `<th style="text-align:${aligns[n]}">${inline(s)}</th>`).join('') + '</tr></thead><tbody>');
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const cells = tableCells(lines[i++]);
        html.push('<tr>' + header.map((_, n) => `<td style="text-align:${aligns[n]}">${inline(cells[n] || '')}</td>`).join('') + '</tr>');
      }
      html.push('</tbody></table>'); continue;
    }
    if (isList(line)) { html.push(list(isList(line)[1].length)); continue; }
    const paragraph = [inline(lines[i++])];
    while (i < lines.length && lines[i].trim() && !special(lines[i], lines[i + 1])) paragraph.push(inline(lines[i++]));
    html.push(`<p>${paragraph.join('<br>')}</p>`);
  }
  return html.join('\n') || '<p><br></p>';
}

function inlineMarkdown(node) {
  if (node.nodeType === 3) return node.textContent.replace(/\u00a0/g, ' ').replace(/[\\`*_~\[\]<>]/g, '\\$&').replace(/^(\s*)(#{1,6}|[-+]|\d+\.)(?=\s)/, '$1\\$2');
  if (node.nodeType !== 1) return '';
  const tag = node.tagName.toLowerCase();
  const children = () => [...node.childNodes].map(inlineMarkdown).join('');
  const withTextStyle = value => {
    const color = safeTextColor(node.style?.color || (tag === 'font' ? node.getAttribute('color') : ''));
    return color ? `<span style="color: ${color};">${value}</span>` : value;
  };
  if (tag === 'input') return '';
  if (tag === 'br') return '\n';
  if (tag === 'strong' || tag === 'b') return withTextStyle(`**${children()}**`);
  if (tag === 'em' || tag === 'i') return withTextStyle(`*${children()}*`);
  if (tag === 's' || tag === 'strike' || tag === 'del') return withTextStyle(`~~${children()}~~`);
  if (tag === 'code') {
    const content = node.textContent;
    const fence = '`'.repeat(Math.max(0, ...[...content.matchAll(/`+/g)].map(m => m[0].length)) + 1);
    const padding = content.startsWith('`') || content.endsWith('`') || (content.startsWith(' ') && content.endsWith(' ')) ? ' ' : '';
    return fence + padding + content + padding + fence;
  }
  if (tag === 'a') return withTextStyle(`[${children()}](${safeURL(node.getAttribute('href'))})`);
  if (tag === 'img') {
    const local = node.getAttribute('data-image-path');
    const path = relativeImagePath(local) ? local : safeURL(node.getAttribute('src'));
    const alt = (local ? node.getAttribute('data-image-alt') ?? node.getAttribute('alt') : node.getAttribute('alt')) || '';
    return `![${alt.replace(/[\\\[\]]/g, '\\$&')}](${/[\s()]/.test(path) ? '<' + path + '>' : path})`;
  }
  return withTextStyle(children());
}

function blockMarkdown(node, depth = 0) {
  if (node.nodeType === 3) return node.textContent.trim() ? node.textContent : '';
  if (node.nodeType !== 1) return '';
  const tag = node.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return '#'.repeat(Number(tag[1])) + ' ' + inlineMarkdown(node);
  if (tag === 'hr') return '---';
  if (tag === 'pre') {
    const content = (node.querySelector('code') || node).textContent.replace(/\n$/, '');
    const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map(m => m[0].length));
    const fence = '`'.repeat(longest + 1);
    return `${fence}${node.dataset.language || ''}\n${content}\n${fence}`;
  }
  if (tag === 'blockquote') return serializeMarkdown(node).trimEnd().split('\n').map(s => '> ' + s).join('\n');
  if (tag === 'ul' || tag === 'ol') {
    return [...node.children].filter(n => n.tagName === 'LI').map((li, index) => {
      const nested = [...li.children].filter(n => ['UL', 'OL'].includes(n.tagName));
      const checkbox = li.querySelector(':scope > input[type=checkbox]');
      const content = [...li.childNodes].filter(n => !nested.includes(n)).map(inlineMarkdown).join('').trim();
      const prefix = tag === 'ol' ? `${Number(node.getAttribute('start') || 1) + index}. ` : '- ';
      return '  '.repeat(depth) + prefix + (checkbox ? `[${checkbox.checked ? 'x' : ' '}] ` : '') + content + nested.map(n => '\n' + blockMarkdown(n, depth + 1)).join('');
    }).join('\n');
  }
  if (tag === 'table') {
    const rows = [...node.querySelectorAll('tr')].map(row => [...row.children].map(cell => inlineMarkdown(cell).replace(/\|/g, '\\|').replace(/\n/g, ' ')));
    if (!rows.length) return '';
    const row = values => '| ' + values.join(' | ') + ' |';
    const headerCells = [...node.querySelector('tr').children];
    const dividers = headerCells.map(cell => cell.style.textAlign === 'center' ? ':---:' : cell.style.textAlign === 'right' ? '---:' : '---');
    const layout = parseTableLayout(node.dataset.tableLayout, headerCells.length);
    const metadata = layout ? `<!-- moye-table: ${JSON.stringify(layout)} -->\n` : '';
    return metadata + [row(rows[0]), row(dividers), ...rows.slice(1).map(row)].join('\n');
  }
  if (tag === 'div' && [...node.children].some(n => /^(DIV|P|H[1-6]|UL|OL|TABLE|PRE|BLOCKQUOTE)$/.test(n.tagName))) return serializeMarkdown(node);
  return inlineMarkdown(node);
}

export function serializeMarkdown(element) {
  return [...element.childNodes].map(node => blockMarkdown(node)).filter(Boolean).join('\n\n').trim() + '\n';
}
