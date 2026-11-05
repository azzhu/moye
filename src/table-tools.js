import { parseTableLayout, normalizeTableLayout, resizeTableColumns } from './table-layout.js';

export function installTableTools({ editor, canEdit, begin, commit, busy }) {
  const panel = document.createElement('div');
  panel.className = 'table-layout-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', '表格宽度设置');
  panel.innerHTML = '<label>表宽 <input type="number" min="20" max="100" step="1" aria-label="表格宽度百分比">%</label><button type="button" data-table-width="60">60%</button><button type="button" data-table-width="80">80%</button><button type="button" data-table-width="100">100%</button><button type="button" data-table-reset>恢复默认</button>';
  const handle = document.createElement('div');
  handle.className = 'table-column-handle';
  handle.hidden = true;
  handle.title = '左右拖动调整相邻列宽';
  document.body.append(panel, handle);
  const input = panel.querySelector('input');
  const scroll = editor.closest('.preview-scroll');
  let selected = null;
  let boundary = null;
  let drag = null;
  let frame = 0;

  const available = table => table && editor.contains(table) && canEdit() && table.getBoundingClientRect().width > 0;
  const countColumns = table => table.rows[0]?.cells.length || 0;
  const readLayout = table => parseTableLayout(table.dataset.tableLayout, countColumns(table)) || { width: 100, columns: [] };

  function apply(table, layout) {
    table.querySelector(':scope > colgroup')?.remove();
    if (!layout) {
      delete table.dataset.tableLayout;
      table.style.removeProperty('width'); table.style.removeProperty('table-layout');
      return;
    }
    layout = normalizeTableLayout(layout, countColumns(table));
    table.dataset.tableLayout = JSON.stringify(layout);
    table.style.width = layout.width + '%';
    if (layout.columns.length) {
      table.style.tableLayout = 'fixed';
      const group = document.createElement('colgroup');
      layout.columns.forEach(width => {
        const col = document.createElement('col'); col.style.width = width + '%'; group.append(col);
      });
      table.prepend(group);
    } else table.style.removeProperty('table-layout');
  }

  function hide() {
    selected = null; boundary = null;
    panel.hidden = true; handle.hidden = true;
  }

  function position() {
    const viewport = scroll.getBoundingClientRect();
    panel.hidden = true;
    if (available(selected)) {
      const rect = selected.getBoundingClientRect();
      if (rect.bottom > viewport.top && rect.top < viewport.bottom) {
        panel.hidden = false;
        if (document.activeElement !== input) input.value = readLayout(selected).width;
        const minTop = viewport.top + 3;
        panel.style.top = Math.max(minTop, Math.min(rect.top - panel.offsetHeight - 4, viewport.bottom - panel.offsetHeight - 3)) + 'px';
        panel.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 4)) + 'px';
      }
    }
    if (available(boundary?.table)) {
      const rect = boundary.table.getBoundingClientRect();
      const cell = boundary.table.rows[0]?.cells[boundary.index];
      if (!cell) { handle.hidden = true; return; }
      const edge = cell.getBoundingClientRect().right;
      const top = Math.max(rect.top, viewport.top);
      handle.hidden = rect.bottom <= viewport.top || rect.top >= viewport.bottom || edge < viewport.left || edge > viewport.right;
      handle.style.left = (edge - 5) + 'px'; handle.style.top = top + 'px';
      handle.style.height = Math.max(0, Math.min(rect.bottom, viewport.bottom) - top) + 'px';
    } else handle.hidden = true;
  }

  function schedulePosition() {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; position(); });
  }

  function updateSelection() {
    if (drag || panel.contains(document.activeElement)) return;
    const selection = window.getSelection();
    const element = node => node?.nodeType === 1 ? node : node?.parentElement;
    const anchor = element(selection?.anchorNode);
    const focus = element(selection?.focusNode);
    const table = anchor?.closest('table');
    const row = table?.rows[0];
    selected = selection?.rangeCount && editor.contains(document.activeElement) && available(table)
      && row?.contains(anchor) && row.contains(focus) ? table : null;
    position();
  }

  function setWidth(width, reset = false) {
    if (!available(selected) || drag) return;
    if (!reset && (!Number.isFinite(width) || width < 20 || width > 100)) {
      input.value = readLayout(selected).width; return;
    }
    const next = reset ? null : normalizeTableLayout({ ...readLayout(selected), width }, countColumns(selected));
    if ((selected.dataset.tableLayout || '') === (next ? JSON.stringify(next) : '')) return;
    begin(); apply(selected, next); commit(); position();
  }

  panel.addEventListener('pointerdown', event => { if (event.target.closest('button')) event.preventDefault(); });
  panel.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (button) setWidth(Number(button.dataset.tableWidth), button.hasAttribute('data-table-reset'));
  });
  input.addEventListener('change', () => setWidth(input.value.trim() ? Number(input.value) : NaN));
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
    if (event.key === 'Escape') { event.stopPropagation(); input.value = readLayout(selected).width; editor.focus(); hide(); }
  });
  editor.addEventListener('click', updateSelection);
  document.addEventListener('selectionchange', updateSelection);
  document.addEventListener('focusin', updateSelection);
  editor.addEventListener('pointermove', event => {
    if (drag || event.buttons) return;
    const table = event.target.closest('table');
    if (!available(table)) { boundary = null; handle.hidden = true; return; }
    const cells = [...table.rows[0].cells];
    const index = cells.slice(0, -1).findIndex(cell => Math.abs(cell.getBoundingClientRect().right - event.clientX) <= 6);
    if (index < 0) { boundary = null; handle.hidden = true; return; }
    boundary = { table, index }; position();
  });
  editor.addEventListener('pointerleave', event => {
    if (!drag && event.relatedTarget !== handle) { boundary = null; handle.hidden = true; }
  });
  document.addEventListener('pointerdown', event => {
    if (!drag && !editor.contains(event.target) && !panel.contains(event.target) && event.target !== handle) hide();
  });

  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !boundary || !available(boundary.table)) return;
    event.preventDefault();
    const table = boundary.table;
    const rect = table.getBoundingClientRect();
    const cells = [...table.rows[0].cells];
    const layout = readLayout(table);
    if (!layout.columns.length) layout.columns = cells.map(cell => cell.getBoundingClientRect().width / rect.width * 100);
    drag = { table, index: boundary.index, start: event.clientX, pixels: rect.width, layout, before: table.dataset.tableLayout || '', pointerId: event.pointerId };
    begin(); busy(true);
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-table');
  });
  handle.addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!available(drag.table)) { cancel(); return; }
    apply(drag.table, { ...drag.layout, columns: resizeTableColumns(drag.layout.columns, drag.index, event.clientX - drag.start, drag.pixels) });
    position();
  });
  function finish(keep) {
    if (!drag) return;
    const operation = drag; drag = null;
    const changed = operation.before !== (operation.table.dataset.tableLayout || '');
    if (!keep && changed) apply(operation.table, operation.before ? parseTableLayout(operation.before, countColumns(operation.table)) : null);
    busy(false); document.body.classList.remove('resizing-table');
    if (handle.hasPointerCapture(operation.pointerId)) handle.releasePointerCapture(operation.pointerId);
    if (keep && changed && available(operation.table)) commit();
    schedulePosition();
  }
  function cancel() { finish(false); }
  handle.addEventListener('pointerup', () => finish(true));
  handle.addEventListener('pointercancel', cancel);
  handle.addEventListener('lostpointercapture', cancel);
  window.addEventListener('blur', cancel);
  document.addEventListener('keydown', event => {
    if (!drag) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.key === 'Escape') cancel();
  }, true);
  editor.addEventListener('beforeinput', event => { if (drag) event.preventDefault(); });
  scroll.addEventListener('scroll', schedulePosition);
  window.addEventListener('resize', schedulePosition);
  new ResizeObserver(schedulePosition).observe(scroll);
  new MutationObserver(schedulePosition).observe(editor, { childList: true, subtree: true });
  return { reset() { cancel(); hide(); } };
}
