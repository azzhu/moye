import test from 'node:test';
import assert from 'node:assert/strict';
import { activeOutlineIndex, installOutlineTracking } from './outline-tracking.js';

test('outline follows the section above the reading line in both scroll directions and selects the final section at the bottom', () => {
  const headings = [14, 400, 900];
  for (const [scroll, expected] of [[0, 0], [380, 1], [600, 1], [1000, 2], [300, 0]]) {
    assert.equal(activeOutlineIndex(headings.map(top => top - scroll), scroll, 300, 1500), expected);
  }
  assert.equal(activeOutlineIndex([-500, -100, 250], 500, 300, 800), 2);
  assert.equal(activeOutlineIndex([14, 80, 150], 0, 300, 200), 0);
  assert.equal(activeOutlineIndex([], 0, 300, 300), -1);
});

test('scroll and layout events update the current title without moving the document or rebuilding the outline', () => {
  const names = ['window', 'ResizeObserver', 'MutationObserver', 'requestAnimationFrame'];
  const descriptors = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  try {
    const frames = [], resizes = [], mutations = [];
    const surface = properties => ({ listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; }, ...properties });
    const window = surface({});
    Object.assign(globalThis, {
      window,
      requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
      ResizeObserver: class { constructor(callback) { resizes.push(callback); } observe() {} },
      MutationObserver: class { constructor(callback) { mutations.push(callback); } observe() {} },
    });
    let positions = [14, 400, 900];
    const scroll = surface({ scrollTop: 0, clientHeight: 300, scrollHeight: 1300, getBoundingClientRect: () => ({ top: 100 }) });
    const editor = surface({ querySelectorAll: () => positions.map(top => ({ getBoundingClientRect: () => ({ top: top - scroll.scrollTop + 100 }) })) });
    const buttons = [0, 1, 2].map(index => ({
      dataset: { outline: String(index) }, attributes: {}, current: false,
      classList: { toggle(name, value) { buttons[index].current = value; } },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      getBoundingClientRect: () => ({ top: 100 + index * 100 - pane.scrollTop, bottom: 130 + index * 100 - pane.scrollTop }),
    }));
    const list = { querySelectorAll: () => buttons };
    const pane = { clientHeight: 180, scrollTop: 0, getBoundingClientRect: () => ({ top: 100, bottom: 280 }) };
    let enabled = true;
    const tracking = installOutlineTracking({ editor, scroll, list, pane, enabled: () => enabled });
    const flush = () => { while (frames.length) frames.shift()(); };
    const current = () => buttons.findIndex(button => button.current);
    tracking.refresh(); flush(); assert.equal(current(), 0);
    scroll.scrollTop = 390;
    scroll.listeners.scroll(); scroll.listeners.scroll();
    assert.equal(frames.length, 1, 'scroll bursts are coalesced into one animation frame');
    flush(); assert.equal(current(), 1);
    assert.equal(buttons[1].attributes['aria-current'], 'location');
    assert.equal(buttons[0].attributes['aria-current'], undefined);
    // A loaded image above a heading changes its position without scrolling.
    positions = [14, 600, 1100]; editor.listeners.load(); flush(); assert.equal(current(), 0);
    positions = [14, 300, 800]; resizes[0](); flush(); assert.equal(current(), 1);
    scroll.scrollTop = 1000; scroll.listeners.scroll(); flush();
    assert.equal(current(), 2); assert.ok(pane.scrollTop > 0);
    assert.equal(scroll.scrollTop, 1000, 'keeping the outline visible never scrolls the document');
    scroll.scrollTop = 0; scroll.listeners.scroll(); flush(); assert.equal(current(), 0);
    enabled = false; scroll.scrollTop = 1000; scroll.listeners.scroll(); flush(); assert.equal(current(), 0);
    enabled = true; window.listeners.resize(); flush(); assert.equal(current(), 2);
    positions = []; mutations[0](); flush(); assert.equal(current(), -1);
  } finally {
    names.forEach((name, index) => descriptors[index] ? Object.defineProperty(globalThis, name, descriptors[index]) : delete globalThis[name]);
  }
});
