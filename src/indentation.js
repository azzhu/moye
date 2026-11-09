// Compute a textarea edit without touching text outside the selected lines.
export function sourceIndentation(value, start, end, outdent = false) {
  if (!outdent && start === end) return { start, end, text: '  ', selectionStart: start + 2, selectionEnd: start + 2 };
  const from = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
  const last = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const next = value.indexOf('\n', last);
  const to = next < 0 ? value.length : next;
  const edits = [];
  let position = from;
  const text = value.slice(from, to).split('\n').map(line => {
    const remove = outdent ? (/^(?:\t| {1,2})/.exec(line)?.[0].length || 0) : 0;
    edits.push({ position, remove, add: outdent ? 0 : 2 });
    position += line.length + 1;
    return outdent ? line.slice(remove) : '  ' + line;
  }).join('\n');
  const adjusted = offset => offset + edits.reduce((delta, edit) => {
    if (edit.position > offset) return delta;
    return delta + edit.add - Math.min(edit.remove, offset - edit.position);
  }, 0);
  return { start: from, end: to, text, selectionStart: adjusted(start), selectionEnd: adjusted(end) };
}

export function changeVisualIndentation(editor, outdent = false, before = () => {}) {
  const doc = editor.ownerDocument, selection = doc.defaultView.getSelection();
  if (!selection?.rangeCount) return false;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return false;
  const element = node => node.nodeType === 1 ? node : node.parentElement;
  const start = element(range.startContainer), end = element(range.endContainer);
  if (start.closest('pre,table,[contenteditable="false"]') || end.closest('pre,table,[contenteditable="false"]')) return false;
  // Keep the original node positions; moving DOM nodes can collapse live ranges.
  const caret = { start: range.startContainer, startOffset: range.startOffset, end: range.endContainer, endOffset: range.endOffset };
  const backward = selection.anchorNode === range.endContainer && selection.anchorOffset === range.endOffset;
  function restore() {
    const restored = doc.createRange();
    restored.setStart(caret.start, caret.startOffset); restored.setEnd(caret.end, caret.endOffset);
    selection.removeAllRanges(); selection.addRange(restored);
    if (backward && !restored.collapsed && selection.setBaseAndExtent) selection.setBaseAndExtent(caret.end, caret.endOffset, caret.start, caret.startOffset);
  }
  const heading = start.closest('h1,h2,h3,h4,h5,h6');
  if (heading && heading === end.closest('h1,h2,h3,h4,h5,h6')) {
    const level = Number(heading.tagName[1]) + (outdent ? -1 : 1);
    if (level < 1 || level > 6) return true;
    before();
    const replacement = doc.createElement(`h${level}`);
    for (const attribute of heading.attributes) replacement.setAttribute(attribute.name, attribute.value);
    // Element-container selections also need to follow the replacement.
    if (caret.start === heading) caret.start = replacement;
    if (caret.end === heading) caret.end = replacement;
    while (heading.firstChild) replacement.append(heading.firstChild);
    heading.replaceWith(replacement); restore(); return true;
  }
  const first = start.closest('li');
  let last = end.closest('li');
  if (!first || !last || !editor.contains(first) || first.parentElement !== last.parentElement) return false;
  const list = first.parentElement;
  if (!['UL', 'OL'].includes(list.tagName)) return false;
  if (first !== last && !range.collapsed && range.endOffset === 0) {
    const prefix = doc.createRange(); prefix.selectNodeContents(last); prefix.setEnd(range.endContainer, range.endOffset);
    if (!prefix.toString()) last = last.previousElementSibling;
  }
  const siblings = [...list.children].filter(node => node.tagName === 'LI');
  const from = siblings.indexOf(first), to = siblings.indexOf(last);
  if (to < from) return false;
  const items = siblings.slice(from, to + 1);
  const nestedList = (item, startAt = null) => {
    let nested = item.lastElementChild;
    if (nested?.tagName !== list.tagName) {
      nested = doc.createElement(list.tagName);
      if (list.tagName === 'OL' && startAt !== null && startAt !== 1) nested.setAttribute('start', String(startAt));
      item.append(nested);
    }
    return nested;
  };
  if (!outdent) {
    const previous = siblings[from - 1];
    if (!previous) return true; // The first item cannot become its own child.
    before(); nestedList(previous).append(...items);
  } else {
    const parentItem = list.parentElement;
    if (parentItem.tagName !== 'LI' || !['UL', 'OL'].includes(parentItem.parentElement?.tagName)) return true;
    before();
    // Following children stay after the promoted items in document order.
    const following = siblings.slice(to + 1);
    if (following.length) nestedList(items.at(-1), Number(list.getAttribute('start') || 1) + to + 1).append(...following);
    let after = parentItem;
    for (const item of items) { after.after(item); after = item; }
    if (!list.querySelector(':scope > li')) list.remove();
  }
  restore(); return true;
}

export function installIndentationShortcuts({ editor, enabled, before, commit }) {
  editor.addEventListener('keydown', event => {
    if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || !enabled()) return;
    let changed = false;
    const handled = changeVisualIndentation(editor, event.shiftKey, () => { before(); changed = true; });
    if (!handled) return;
    event.preventDefault();
    if (changed) commit();
  });
}
