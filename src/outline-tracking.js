export function activeOutlineIndex(positions, scrollTop, viewportHeight, contentHeight, threshold = 24) {
  if (!positions.length) return -1;
  if (scrollTop > 0 && contentHeight > viewportHeight && scrollTop + viewportHeight >= contentHeight - 2) return positions.length - 1;
  let active = 0;
  for (let index = 0; index < positions.length; index++) {
    if (positions[index] <= threshold) active = index;
    else break;
  }
  return active;
}

export function installOutlineTracking({ editor, scroll, list, pane, enabled }) {
  let frame = null;

  function select(index) {
    const buttons = [...list.querySelectorAll('[data-outline]')];
    for (const button of buttons) {
      const current = Number(button.dataset.outline) === index;
      button.classList.toggle('current', current);
      if (current) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
      if (!current || !pane.clientHeight) continue;
      const bounds = pane.getBoundingClientRect();
      const rect = button.getBoundingClientRect();
      // Scroll only the outline pane; never move the document being read.
      if (rect.top < bounds.top + 8) pane.scrollTop += rect.top - bounds.top - 8;
      else if (rect.bottom > bounds.bottom - 8) pane.scrollTop += rect.bottom - bounds.bottom + 8;
    }
  }

  function update() {
    if (!enabled() || !scroll.clientHeight) return;
    const top = scroll.getBoundingClientRect().top + (scroll.clientTop || 0);
    const positions = [...editor.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(heading => heading.getBoundingClientRect().top - top);
    select(activeOutlineIndex(positions, scroll.scrollTop, scroll.clientHeight, scroll.scrollHeight));
  }

  function schedule() {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => { frame = null; update(); });
  }

  scroll.addEventListener('scroll', schedule, { passive: true });
  // Image loading, resizing, fullscreen and font changes can all move a heading
  // without a scroll event. Recalculate against the actual rendered geometry.
  editor.addEventListener('load', schedule, true);
  window.addEventListener('resize', schedule);
  const resize = new ResizeObserver(schedule);
  resize.observe(editor); resize.observe(scroll);
  new MutationObserver(schedule).observe(editor, { childList: true, subtree: true, characterData: true });
  return { refresh: schedule, select };
}
