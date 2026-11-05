import { icon } from './icons.js';

export async function copyCodeText(text, environment = globalThis) {
  try {
    if (environment.navigator?.clipboard?.writeText) {
      await environment.navigator.clipboard.writeText(text);
      return;
    }
  } catch { /* Local HTML pages can fall back to the browser's copy command. */ }
  const doc = environment.document;
  const active = doc.activeElement;
  const selection = environment.getSelection?.();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const inputSelection = typeof active?.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
  const textarea = doc.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute('aria-label', '复制代码临时区域');
  textarea.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
  doc.body.append(textarea);
  try {
    textarea.select();
    if (!doc.execCommand('copy')) throw new Error('复制失败，请允许浏览器访问剪贴板后重试');
  } finally {
    textarea.remove();
    active?.focus({ preventScroll: true });
    if (inputSelection) active.setSelectionRange(...inputSelection);
    if (selection) {
      selection.removeAllRanges();
      ranges.forEach(range => selection.addRange(range));
    }
  }
}

export function refreshCodeCopyButtons(editor, notify, copy = copyCodeText) {
  for (const pre of editor.querySelectorAll('pre')) {
    if (!pre.querySelector('code') || pre.querySelector('[data-copy-code]')) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy-button';
    button.contentEditable = 'false';
    button.dataset.copyCode = '';
    button.title = '复制代码';
    button.setAttribute('aria-label', '复制代码块内容');
    button.innerHTML = icon('copy', 15);
    button.addEventListener('pointerdown', event => event.preventDefault());
    button.addEventListener('click', async event => {
      event.preventDefault(); event.stopPropagation();
      if (button.disabled) return;
      // Read at click time so edits made after rendering are included exactly,
      // without Markdown fences, language labels, or the button's UI text.
      const code = pre.querySelector('code');
      if (!code) { notify('代码块内容已变化，请重新打开文档后重试'); return; }
      button.disabled = true;
      try {
        await copy(code.textContent);
        button.innerHTML = icon('check', 15);
        button.title = '已复制';
        button.setAttribute('aria-label', '已复制代码块内容');
        notify('代码已复制');
      } catch (error) { notify(error.message || '复制失败，请重试'); }
      finally {
        button.disabled = false;
        setTimeout(() => {
          button.innerHTML = icon('copy', 15);
          button.title = '复制代码';
          button.setAttribute('aria-label', '复制代码块内容');
        }, 1500);
      }
    });
    pre.prepend(button);
  }
}
