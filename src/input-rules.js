// Only text inserted by typing (or a completed IME composition) triggers rules.
export function markdownInputRule(text) {
  const block = /^(#{1,3}|[-*]|1\.|>) $/.exec(text);
  if (block) {
    const marker = block[1];
    return { type: 'block', tag: marker[0] === '#' ? `h${marker.length}` : marker === '>' ? 'blockquote' : marker === '1.' ? 'ol' : 'ul', length: text.length };
  }
  // Require a closing pair at the caret, nonempty content and unescaped markers.
  for (const [pattern, tag, delimiter] of [[/\*\*([^*\n]+)\*\*$/, 'strong', '**'], [/`([^`\n]+)`$/, 'code', '`']]) {
    const match = pattern.exec(text);
    if (!match || !match[1].trim() || /^\s|\s$/.test(match[1])) continue;
    const start = match.index;
    if (text[start - 1] === delimiter[0]) continue;
    const slashes = /\\+$/.exec(text.slice(0, start))?.[0].length || 0;
    if (slashes % 2) continue;
    if (tag === 'strong' && (text.slice(0, start).match(/(?<!\\)`/g)?.length || 0) % 2) continue;
    return { type: 'inline', tag, start, end: text.length, delimiter: delimiter.length };
  }
  return null;
}

export function applyVisualInputRule(editor, before = () => {}) {
  const doc = editor.ownerDocument;
  const selection = doc.defaultView.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return false;
  const caret = selection.getRangeAt(0);
  if (!editor.contains(caret.startContainer)) return false;
  const element = caret.startContainer.nodeType === 1 ? caret.startContainer : caret.startContainer.parentElement;
  if (element.closest('pre,code,a,[contenteditable="false"]')) return false;
  const block = element.closest('p,div,h1,h2,h3,h4,h5,h6,li,td,th,blockquote');
  // A bare editor has no paragraph until the first Enter; use it as the block.
  const container = block && editor.contains(block) ? block : editor;
  const nodes = [];
  let text = '', offset = null;
  const boundary = /^(BR|P|DIV|H[1-6]|LI|UL|OL|TD|TH|BLOCKQUOTE|PRE|CODE|A|IMG|INPUT)$/;
  function visit(node) {
    if (node.nodeType === 3) {
      const start = text.length;
      nodes.push({ node, start, end: start + node.textContent.length });
      if (node === caret.startContainer) offset = start + caret.startOffset;
      text += node.textContent;
      return;
    }
    if (node.nodeType !== 1) return;
    if (node !== container && (boundary.test(node.tagName) || node.getAttribute('contenteditable') === 'false')) {
      text += '\n'; return;
    }
    for (let i = 0; i <= node.childNodes.length; i++) {
      if (node === caret.startContainer && caret.startOffset === i) offset = text.length;
      if (i < node.childNodes.length) visit(node.childNodes[i]);
    }
  }
  visit(container);
  if (offset === null) return false;
  const prefix = text.slice(0, offset).replace(/\u00a0/g, ' ');
  const rule = markdownInputRule(prefix);
  if (!rule) return false;
  if (rule.type === 'block' && (container !== editor && !['P', 'DIV'].includes(container.tagName))) return false;
  // Never replace a root which also contains other blocks.
  if (rule.type === 'block' && container.querySelector('p,div,h1,h2,h3,h4,h5,h6,ul,ol,li,blockquote,pre,table')) return false;
  const point = (at, end = false) => {
    const entry = (end ? [...nodes].reverse() : nodes).find(item => at >= item.start && at <= item.end);
    return entry ? [entry.node, at - entry.start] : [container, 0];
  };
  const range = (start, end) => {
    const result = doc.createRange(); result.setStart(...point(start)); result.setEnd(...point(end, true)); return result;
  };
  before();
  let destination;
  if (rule.type === 'block') {
    range(0, rule.length).deleteContents();
    const replacement = doc.createElement(rule.tag);
    let content = replacement;
    if (rule.tag === 'ul' || rule.tag === 'ol') { content = doc.createElement('li'); replacement.append(content); }
    else if (rule.tag === 'blockquote') { content = doc.createElement('p'); replacement.append(content); }
    while (container.firstChild) content.append(container.firstChild);
    if (!content.textContent && !content.querySelector('br,img,input')) content.append(doc.createElement('br'));
    if (container === editor) editor.append(replacement);
    else container.replaceWith(replacement);
    destination = doc.createRange(); destination.setStart(content, 0);
  } else {
    // Work backwards so deleting the closing delimiter doesn't shift the body.
    const closing = range(rule.end - rule.delimiter, rule.end);
    const bodyRange = range(rule.start + rule.delimiter, rule.end - rule.delimiter);
    const opening = range(rule.start, rule.start + rule.delimiter);
    closing.deleteContents();
    const body = bodyRange.extractContents();
    opening.deleteContents();
    const replacement = doc.createElement(rule.tag); replacement.append(body);
    opening.insertNode(replacement);
    destination = doc.createRange(); destination.setStartAfter(replacement);
  }
  destination.collapse(true);
  selection.removeAllRanges(); selection.addRange(destination);
  return true;
}

export function installMarkdownInputRules({ editor, enabled, before, commit, plain }) {
  let composing = false;
  let compositionPending = false;
  let pastePending = false;
  function transform() {
    if (!enabled()) return false;
    if (!applyVisualInputRule(editor, before)) return false;
    commit(); return true;
  }
  editor.addEventListener('compositionstart', () => { composing = true; });
  editor.addEventListener('compositionend', () => {
    composing = false; compositionPending = true;
    // Browsers differ on whether the final input comes before or after compositionend.
    queueMicrotask(() => {
      if (!compositionPending) return;
      compositionPending = false;
      if (!transform()) plain();
    });
  });
  editor.addEventListener('paste', () => {
    pastePending = true;
    queueMicrotask(() => { pastePending = false; });
  }, true);
  editor.addEventListener('input', event => {
    if (composing || event.isComposing) return;
    if (compositionPending) return; // The microtask commits the final IME text once.
    const typed = event.inputType === 'insertText' || event.inputType === 'insertCompositionText';
    if (pastePending || !typed || !transform()) plain();
  });
}
