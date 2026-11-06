import { renderMarkdown, serializeMarkdown, escapeHTML, safeURL } from './markdown.js';
import { icon } from './icons.js';
import { HISTORY_LIMIT, recentDocuments, migrateHistory } from './history.js';
import { SharedHistoryStore, HISTORY_STORAGE_PREFIX, PAGE_DRAFT_STORAGE_KEY, restorePageDrafts } from './history-sync.js';
import { OriginalFileWriter, hasUnsavedFileChanges, isMissingOriginalFile, rememberFileHandle, recallFileHandle, forgetFileHandle } from './file-access.js';
import { installTableTools } from './table-tools.js';
import { localFileFromHash } from './local-file-handle.js';
import { refreshLocalImages } from './local-images.js';
import { DirectoryImageLoader, imageDirectoryKey, validateImageDirectory } from './directory-images.js';
import { refreshCodeCopyButtons } from './code-copy.js';
import { installOutlineTracking } from './outline-tracking.js';
import { APPEARANCE_STORAGE_KEY, READING_STYLES, resolveReadingStyle, applyReadingStyle } from './appearance.js';
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const STORAGE_KEY = 'inkwell.workspace.v1';
let documents = [];
let activeId = null;
let mode = 'visual';
let dark = false;
let contentWidth = 1080;
let fontSize = 16;
const clampWidth = (value, min, max, fallback) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
let storageAvailable = true;
let historyStore = null;
let sharedHistoryRecords = null;
try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
  if (saved && Array.isArray(saved.documents) && saved.documents.every(d => typeof d.id === 'string' && typeof d.title === 'string' && typeof d.markdown === 'string')) {
    documents = migrateHistory(saved.documents);
    mode = saved.mode === 'source' ? 'source' : 'visual';
    dark = !!saved.dark;
    fontSize = clampWidth(saved.fontSize, 12, 24, 16);
    if (saved.fontDefaultVersion !== 16 && (saved.fontSize === 15 || (saved.fontSize === 14 && saved.fontDefaultVersion !== 15))) fontSize = 16;
    contentWidth = saved.contentWidth === 'full' ? 'full' : clampWidth(saved.contentWidth, 480, 1400, 1080);
    if (saved.widthDefaultVersion !== 1080 && saved.contentWidth === 780) contentWidth = 1080;
  }
} catch { storageAvailable = false; }
let readingStyle = resolveReadingStyle(null, dark).id;
try { readingStyle = resolveReadingStyle(localStorage.getItem(APPEARANCE_STORAGE_KEY), dark).id; }
catch { /* Appearance still works when local storage is unavailable. */ }
const current = () => documents.find(d => d.id === activeId);
const histories = new Map();
const fileHandles = new Map();
const imageDirectories = new Map();
const imageDirectoryStates = new Map();
const authorizingImageDirectories = new Set();
const fileWriters = new Map();
const fileSaveTimers = new Map();
const fileSaveStates = new Map();
const fileWriteCounts = new Map();
const deletingRecords = new Set();
const externalChecks = new Set();
let historyOpenVersion = 0;
let openingHistoryId = null;
let composingDocument = false;
let resizingTable = false;
let conflictReview = null;
const LAST_OPENED_HANDLE_KEY = '@picker:last-opened';
let lastOpenedHandle = null;
try {
  historyStore = new SharedHistoryStore(localStorage);
  documents = historyStore.initialize(documents);
  sharedHistoryRecords = documents;
} catch { storageAvailable = false; }
try {
  const sharedRecords = new Set(documents);
  documents = restorePageDrafts(sessionStorage, documents);
  documents.filter(doc => doc.fileDirty && !sharedRecords.has(doc)).forEach(doc => {
    historyStore?.localDrafts.add(doc.id);
    historyStore?.remember(doc);
  });
} catch { /* Shared history and original-file saving still work without session storage. */ }
// Restore in advance so opening the picker still occurs directly in the click gesture.
recallFileHandle(LAST_OPENED_HANDLE_KEY).then(handle => { lastOpenedHandle ||= handle; }).catch(() => {});
const handleRestore = Promise.all(documents.map(async doc => {
  await Promise.all([
    recallFileHandle(doc.id).then(handle => { if (handle) fileHandles.set(doc.id, handle); }).catch(() => {}),
    recallFileHandle(imageDirectoryKey(doc.id)).then(directory => { if (directory) imageDirectories.set(doc.id, directory); }).catch(() => {}),
  ]);
}));
let saveTimer;
let toastTimer;
let savedRange;
let lastEditTime = 0;
let lastEditKind;

function button(action, name, label, cls = '', extra = '') {
  return `<button type="button" class="icon-button ${cls}" data-action="${action}" aria-label="${label}" title="${label}" ${extra}>${icon(name)}</button>`;
}

$('#app').innerHTML = `
  <aside class="sidebar">
    <a class="brand" href="/" aria-label="墨页首页"><span class="brand-mark">${icon('feather', 23)}</span><span>墨页<span class="brand-en">INKWELL</span></span></a>
    <section class="sidebar-document-info" aria-label="当前文档" hidden><h2 id="document-title" class="document-title" aria-label="文档名称"></h2><div class="document-meta"><span>${icon('clock', 13)}<span id="updated-label">刚刚编辑</span></span><span class="meta-dot">·</span><span id="heading-words">0 字</span></div><div class="sidebar-document-type">Markdown 文档</div></section>
    <button class="new-button" data-action="open">${icon('folder', 17)}<span>打开文档</span><kbd>⌘ O</kbd></button>
    <div class="section-caption history-caption"><span>历史记录</span><span class="history-count" id="history-count">0 / 20</span></div>
    <div class="document-list" id="document-list" aria-label="历史记录"></div>
    <div class="sidebar-bottom">
      <div class="sidebar-divider"></div>
      <button class="nav-item" data-action="help">${icon('help')}<span>使用指南</span><span class="external-arrow">↗</span></button>
      <button class="nav-item" data-action="settings">${icon('settings')}<span>设置</span><span class="settings-current" id="settings-current">默认</span></button>
      <div class="local-note sidebar-save-status"><span class="local-dot" aria-hidden="true"></span><button class="save-state" id="save-state" data-action="save-file" title="保存到原始文件 / 重新授权" aria-live="polite"></button></div>
    </div>
  </aside>
  <div class="main-shell">
    <main class="workspace">
      <section class="editor-card" aria-label="Markdown 编辑器">
        <div class="format-toolbar">${button('sidebar', 'menu', '打开历史记录', 'mobile-menu')}<div class="toolbar-group">${button('undo', 'undo', '撤销 ⌘ Z')}${button('redo', 'redo', '重做 ⌘ ⇧ Z')}</div><span class="toolbar-separator"></span><div class="dropdown-wrap"><button class="heading-select" data-action="headings"><span id="format-label">正文</span>${icon('down', 12)}</button><div id="headings-menu" class="popover headings-menu" hidden><button data-heading="p">正文</button><button data-heading="h1">一级标题 <small>H1</small></button><button data-heading="h2">二级标题 <small>H2</small></button><button data-heading="h3">三级标题 <small>H3</small></button></div></div><span class="toolbar-separator"></span><div class="toolbar-group">${button('bold', 'bold', '加粗 ⌘ B')}${button('italic', 'italic', '斜体 ⌘ I')}${button('strike', 'strike', '删除线')}${button('inline-code', 'code', '行内代码')}${button('link', 'link', '插入链接 ⌘ K')}</div><span class="toolbar-separator"></span><div class="toolbar-group">${button('bullet', 'list', '无序列表')}${button('number', 'ordered', '有序列表')}${button('quote', 'quote', '引用')}${button('table', 'table', '插入表格')}</div><span class="toolbar-separator toolbar-last"></span><div class="dropdown-wrap"><button class="insert-button" data-action="insert">${icon('plus', 15)}<span>插入</span>${icon('down', 11)}</button><div id="insert-menu" class="popover insert-menu" hidden><button data-action="task">${icon('task', 16)}任务清单</button><button data-action="codeblock">${icon('code', 16)}代码块</button><button data-action="rule">${icon('rule', 16)}分割线</button><button data-action="table">${icon('table', 16)}表格</button><button data-action="image">${icon('file', 16)}图片链接</button></div></div><span class="toolbar-spacer" title="双击进入或退出文档全屏"></span><div class="view-options"><button class="width-button image-directory-button" data-action="image-directory" aria-label="授权图片目录" title="授权图片目录：选择 Markdown 所在文件夹（只读）" hidden>${icon('folder', 15)}<span>图片目录</span></button><div class="dropdown-wrap"><button class="width-button" data-action="width" aria-label="调整可视化宽度" aria-expanded="false">${icon('split', 15)}<span>宽度</span>${icon('down', 11)}</button><div class="popover width-menu" id="width-menu" hidden><label for="content-width">正文宽度 <output id="width-value">1080 px</output></label><input id="content-width" type="range" min="480" max="1400" step="20" aria-label="可视化正文宽度"><div class="width-presets"><button data-width="640">紧凑</button><button data-width="960">宽屏</button><button data-width="full">铺满</button></div><p>正文宽度受当前可视化区域限制。</p><button class="width-reset" data-action="reset-width">恢复默认宽度</button></div></div><button class="width-button mode-setting" data-action="display-mode" aria-label="切换显示模式"><span>切换显示模式</span></button><div class="dropdown-wrap"><button class="font-button" data-action="font-size" aria-label="调整文档字体大小" aria-expanded="false" title="调整文档字体大小"><span aria-hidden="true">A<span class="font-small">a</span></span></button><div class="popover font-menu" id="font-menu" hidden><label for="font-size">字体大小 <output id="font-value">16 px</output></label><div class="font-stepper"><button data-action="font-smaller" aria-label="减小字体">−</button><input id="font-size" type="range" min="12" max="24" step="1" aria-label="文档字体大小"><button data-action="font-larger" aria-label="增大字体">+</button></div><p>调整文档显示字号，不改变 Markdown 内容。</p><button class="font-reset" data-action="reset-font">恢复默认字号</button></div></div>${button('outline', 'outline', '显示或隐藏文档大纲', 'outline-toggle active', 'aria-pressed="true"')}${button('focus', 'expand', '文档全屏', '', 'aria-pressed="false"')}</div></div>
        <div class="editing-area" data-mode="visual">
          <section class="source-pane"><div class="pane-heading"><span><span class="pane-dot source-dot"></span>MARKDOWN<span class="pane-subtitle">源码编辑</span></span><span class="file-extension">.md</span></div><div class="source-content"><div class="line-numbers" aria-hidden="true"></div><textarea id="source-editor" aria-label="Markdown 源码" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off"></textarea></div><div class="pane-footer"><span>UTF-8</span><span id="cursor-position">行 1，列 1</span></div></section>
          <section class="preview-pane"><div class="preview-scroll"><article id="visual-editor" class="prose" contenteditable="true" role="textbox" aria-label="可视化编辑内容" aria-multiline="true" spellcheck="false"></article></div></section>
          <aside class="outline-pane"><div class="outline-heading">文档大纲<span id="outline-count">0</span></div><nav id="outline-list" aria-label="文档大纲"></nav><div class="outline-note">${icon('feather', 19)}<p>专注当下的想法<br>剩下的，交给墨页。</p></div></aside>
        </div>
        <div class="editor-status"><button class="status-sync" data-action="save-file" title="保存到原始文件 / 重新授权"><span class="status-dot"></span><span id="sync-status">尚未打开原文件</span></button><div class="status-shortcuts" aria-label="快捷键提示">${icon('keyboard', 13)}<span><kbd>⌘ B</kbd> 加粗</span><span class="status-divider"></span><span><kbd>⌘ I</kbd> 斜体</span><span class="status-divider"></span><span><kbd>⌘ S</kbd> 保存</span></div><div class="status-metrics"><span id="status-words">0 字</span><span class="status-divider"></span><span id="status-lines">0 行</span><span class="status-divider"></span><span>Markdown</span></div></div>
      </section>
      <section class="empty-state" hidden>${button('sidebar', 'menu', '打开历史记录', 'mobile-menu empty-history-toggle')}<div>${icon('files', 36)}</div><h2>打开文档，继续你的思路</h2><p>选择本地 Markdown 文件，或从左侧历史记录中继续编辑。</p><button class="new-button" data-action="open">${icon('folder', 16)}打开文档</button></section>
    </main>
  </div>
  <div id="toast" class="toast" role="status" hidden></div>
  <dialog id="modal"><div id="modal-content"></div></dialog>
`;

const source = $('#source-editor');
const visual = $('#visual-editor');
const title = $('#document-title');
const directoryImageLoader = new DirectoryImageLoader();
const tableTools = installTableTools({
  editor: visual,
  canEdit: () => !!current() && fileWriters.has(activeId) && openingHistoryId !== activeId && !composingDocument,
  begin: () => { historyForDoc(); lastEditKind = null; },
  commit: () => { changed('table-layout'); lastEditKind = null; },
  busy: value => { resizingTable = value; },
});
const outlineTracking = installOutlineTracking({
  editor: visual,
  scroll: $('.preview-scroll'),
  list: $('#outline-list'),
  pane: $('.outline-pane'),
  enabled: () => mode === 'visual' && !!current(),
});

function applyFontSize() {
  $('.editing-area').style.setProperty('--document-font-size', `${fontSize}px`);
  $('#font-size').value = String(fontSize);
  $('#font-value').textContent = `${fontSize} px`;
  $('[data-action="font-smaller"]').disabled = fontSize <= 12;
  $('[data-action="font-larger"]').disabled = fontSize >= 24;
}

function setFontSize(value) {
  fontSize = clampWidth(value, 12, 24, 16);
  applyFontSize();
  save();
}

$('#font-size').addEventListener('input', event => setFontSize(Number(event.target.value)));
window.addEventListener('resize', () => closePopovers());

function applyWidths() {
  const area = $('.editing-area');
  area.style.setProperty('--content-width', contentWidth === 'full' ? '100%' : `${contentWidth}px`);
  area.classList.toggle('wide-content', contentWidth === 'full' || contentWidth > 780);
  $('#content-width').value = contentWidth === 'full' ? '1400' : String(contentWidth);
  $('#content-width').setAttribute('aria-valuetext', contentWidth === 'full' ? '铺满可用空间' : `${contentWidth} 像素`);
  $('#width-value').textContent = contentWidth === 'full' ? '铺满' : `${contentWidth} px`;
  $$('[data-width]').forEach(button => button.classList.toggle('selected', String(contentWidth) === button.dataset.width));
}

$('#content-width').addEventListener('input', event => {
  contentWidth = clampWidth(Number(event.target.value), 480, 1400, 1080);
  applyWidths(); save();
});

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').innerHTML = icon('check', 16) + `<span>${escapeHTML(message)}</span>`;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3200);
}

function save(immediate = false) {
  clearTimeout(saveTimer);
  const perform = () => {
    // A different page's clean disk snapshot must never erase this page's
    // unsaved draft backup when the user refreshes it.
    try { sessionStorage.setItem(PAGE_DRAFT_STORAGE_KEY, JSON.stringify(documents.filter(doc =>
      (doc.fileDirty && (!historyStore || historyStore.ownsDraft(doc))) || fileWriteCounts.get(doc.id)))); }
    catch { /* The existing beforeunload check still protects unsaved edits. */ }
    try {
      if (historyStore) applySharedHistory(historyStore.publish(documents));
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ documents: historyStore ? [] : documents, historyVersion: historyStore ? 2 : 1, activeId, mode, dark, contentWidth, fontSize, fontDefaultVersion: 16, widthDefaultVersion: 1080 }));
      storageAvailable = true;
    } catch { storageAvailable = false; }
    renderFileSaveState();
  };
  if (immediate) perform(); else saveTimer = setTimeout(perform, 200);
}

function applySharedHistory(records) {
  const local = new Map(documents.map(doc => [doc.id, doc]));
  const protectedRecord = doc => doc.id === activeId || (doc.fileDirty && historyStore.ownsDraft(doc)) || fileWriteCounts.get(doc.id)
    || openingHistoryId === doc.id || authorizingImageDirectories.has(doc.id) || historyStore.hasLocalChanges(doc);
  sharedHistoryRecords = records;
  documents = records.map(record => {
    const existing = local.get(record.id);
    if (existing && protectedRecord(existing)) return existing;
    historyStore.remember(record);
    return record;
  });
  const visible = new Set(records.map(doc => doc.id));
  for (const doc of local.values()) {
    // History deletion never closes another page's editor or discards its
    // pending save. Keep its working copy, but exclude it from the sidebar
    // and from future shared-history writes through the durable tombstone.
    if (!visible.has(doc.id) && protectedRecord(doc)) documents.push(doc);
  }
  renderDocumentList();
  void restoreSharedHistoryHandles(records);
}

const restoringHistoryHandles = new Set();
async function restoreSharedHistoryHandles(records) {
  await Promise.all(records.map(async doc => {
    if (fileHandles.has(doc.id) || restoringHistoryHandles.has(doc.id)) return;
    restoringHistoryHandles.add(doc.id);
    try {
      const [handle, directory] = await Promise.all([recallFileHandle(doc.id), recallFileHandle(imageDirectoryKey(doc.id))]);
      if (!documents.some(item => item.id === doc.id)) return;
      if (handle) fileHandles.set(doc.id, handle);
      if (directory) imageDirectories.set(doc.id, directory);
    } catch { /* Opening the record can retry the IndexedDB lookup. */ }
    finally { restoringHistoryHandles.delete(doc.id); }
  }));
}

function syncSharedHistory(force = false) {
  if (!historyStore) return;
  try {
    if (force || historyStore.hasChanges()) applySharedHistory(historyStore.read());
  } catch { storageAvailable = false; renderFileSaveState(); }
}

function renderFileSaveState() {
  const doc = current();
  const state = doc ? fileSaveStates.get(doc.id) : null;
  let label = '尚未打开原文件';
  let detail = '使用「打开文档」选择文件并授权读写';
  if (doc) {
    if (openingHistoryId === doc.id) { label = '正在读取原文件…'; detail = '正在核对磁盘最新内容，历史草稿暂不可编辑'; }
    else if (state?.historyReadError) { label = '未读取原文件'; detail = state.error; }
    else if (state?.conflict) { label = '外部修改冲突'; detail = state.historyReadOnly ? '原文件与网页都有修改；点击这里重新授权后核对两份内容' : '原文件与网页都有修改，自动保存已暂停；点击这里核对两份内容'; }
    else if (state?.historyReadOnly) { label = '原文件只读'; detail = state.error; }
    else if (state?.error) { label = '原文件未保存'; detail = state.error; }
    else if (fileWriteCounts.get(doc.id)) { label = '正在写入原文件…'; detail = '等待文件写入完成，请勿关闭页面'; }
    else if (fileSaveTimers.has(doc.id) || doc.fileDirty) { label = '修改尚未写回'; detail = fileWriters.has(doc.id) ? '即将自动写回原文件' : '点击此处重新授权，才能保存回原始文件'; }
    else if (fileWriters.has(doc.id)) { label = '已保存到原文件'; detail = '修改会在停止输入 0.45 秒后自动写回原文件'; }
    else { label = '需要文件授权'; detail = '历史记录是浏览器草稿；点击此处授权原文件后才能编辑和写回'; }
  }
  $('#save-state').textContent = label;
  $('#save-state').title = detail;
  $('#save-state').disabled = !doc;
  $('#sync-status').textContent = detail + (!storageAvailable ? '（浏览器草稿备份不可用）' : '');
  $('#save-state').classList.toggle('file-save-error', !!state?.error || !!state?.conflict || !!doc?.fileDirty);
}

function updateFileEditability() {
  const editable = !!current() && fileWriters.has(activeId) && openingHistoryId !== activeId;
  source.readOnly = !editable;
  visual.contentEditable = String(editable);
  visual.querySelectorAll('input[type=checkbox]').forEach(input => { input.disabled = !editable; });
}

function refreshDocumentImages() {
  const doc = current();
  const handle = fileHandles.get(activeId);
  const button = $('[data-action="image-directory"]');
  button.hidden = !doc || handle?.type === 'moye-local-file' || !visual.querySelector('img[data-image-path]');
  button.disabled = !doc || authorizingImageDirectories.has(activeId);
  if (!doc || handle?.type === 'moye-local-file') {
    directoryImageLoader.clear();
    if (doc) refreshLocalImages(visual, handle);
    return;
  }
  const directory = imageDirectories.get(doc.id);
  const state = imageDirectoryStates.get(doc.id);
  button.classList.toggle('active', !!directory && state?.permission === 'granted');
  button.title = state?.permission === 'granted'
    ? `图片目录：${directory.name}（只读）；点击重新选择目录或刷新图片`
    : state?.error || '授权图片目录：选择当前 Markdown 所在文件夹（只读），以显示相邻图片';
  void directoryImageLoader.refresh(visual, doc.id, handle, directory).then(result => {
    if (!result || !documents.includes(doc) || imageDirectories.get(doc.id) !== directory) return;
    imageDirectoryStates.set(doc.id, result);
    if (activeId !== doc.id || fileHandles.get(doc.id) !== handle) return;
    button.classList.toggle('active', result.permission === 'granted');
    button.title = result.permission === 'granted'
      ? `图片目录：${result.name}（只读）；点击重新选择目录或刷新图片`
      : result.error || '授权图片目录：点击重新授予目录只读权限';
  });
}

async function authorizeImageDirectory() {
  const doc = current();
  const fileHandle = fileHandles.get(doc?.id);
  if (!doc || authorizingImageDirectories.has(doc.id) || fileHandle?.type === 'moye-local-file') return;
  if (!fileHandle) { toast('请先通过「打开文档」选择原始 Markdown 文件，再授权图片目录'); return; }
  if (!window.showDirectoryPicker) { toast('当前浏览器不支持目录授权，请使用 Chrome 或 Edge，或用 moye 命令打开文档'); return; }
  authorizingImageDirectories.add(doc.id);
  $('[data-action="image-directory"]').disabled = true;
  try {
    const saved = imageDirectories.get(doc.id);
    const permission = imageDirectoryStates.get(doc.id)?.permission;
    let directory;
    // Request a remembered directory's permission directly inside the click gesture.
    if (saved && !['granted', 'error'].includes(permission)) {
      if (await saved.requestPermission({ mode: 'read' }) !== 'granted') throw new Error('未获得图片目录读取授权；Markdown 文件的编辑与保存不受影响');
      directory = saved;
    } else {
      directory = await window.showDirectoryPicker({ id: 'moye-image-directory', mode: 'read', startIn: saved || fileHandle });
    }
    await validateImageDirectory(directory, fileHandle);
    if (!documents.includes(doc) || fileHandles.get(doc.id) !== fileHandle) return;
    imageDirectories.set(doc.id, directory);
    imageDirectoryStates.set(doc.id, { permission: 'granted', name: directory.name });
    let remembered = true;
    try { await rememberFileHandle(imageDirectoryKey(doc.id), directory); }
    catch { remembered = false; }
    if (!documents.includes(doc)) return;
    if (activeId === doc.id) { directoryImageLoader.clear(); refreshDocumentImages(); }
    toast(remembered ? `已关联图片目录：${directory.name}（只读）` : '图片目录已授权，但浏览器未能记住关联；下次打开可能需要重新选择');
  } catch (error) {
    if (error.name !== 'AbortError') toast(error.message || '图片目录授权失败，请重试');
  } finally {
    authorizingImageDirectories.delete(doc.id);
    if (activeId === doc.id) refreshDocumentImages();
  }
}

function scheduleOriginalSave(doc) {
  doc.fileDirty = true;
  if (fileSaveStates.get(doc.id)?.conflict) { renderFileSaveState(); return; }
  fileSaveStates.delete(doc.id);
  clearTimeout(fileSaveTimers.get(doc.id));
  fileSaveTimers.set(doc.id, setTimeout(() => { void flushOriginalFile(doc); }, 450));
  renderFileSaveState();
}

async function flushOriginalFile(doc) {
  clearTimeout(fileSaveTimers.get(doc.id));
  fileSaveTimers.delete(doc.id);
  if (openingHistoryId === doc.id) return false;
  if (fileSaveStates.get(doc.id)?.conflict) { renderFileSaveState(); return false; }
  if (!doc.fileDirty) { renderFileSaveState(); return true; }
  const writer = fileWriters.get(doc.id);
  if (!writer) {
    fileSaveStates.set(doc.id, { error: '尚未授权原始文件，无法写回；请点击保存状态重新授权' });
    renderFileSaveState(); return false;
  }
  const snapshot = doc.markdown;
  fileWriteCounts.set(doc.id, (fileWriteCounts.get(doc.id) || 0) + 1);
  renderFileSaveState();
  try {
    await writer.save(snapshot);
    doc.fileDiskContent = writer.diskContent;
    doc.fileDirty = doc.markdown !== snapshot;
    fileSaveStates.delete(doc.id);
    return true;
  } catch (error) {
    doc.fileDirty = true;
    if (isMissingOriginalFile(error)) setOriginalFileMissing(doc, true);
    if (error.code === 'EXTERNAL_MODIFICATION') {
      clearTimeout(fileSaveTimers.get(doc.id)); fileSaveTimers.delete(doc.id);
      fileSaveStates.set(doc.id, { conflict: true, external: error.externalContent });
    } else fileSaveStates.set(doc.id, { error: error.message || '原文件写入失败，请检查权限后重试' });
    return false;
  } finally {
    fileWriteCounts.set(doc.id, Math.max(0, (fileWriteCounts.get(doc.id) || 1) - 1));
    save(true);
  }
}

async function authorizeOriginalFile() {
  const doc = current();
  if (!doc) return;
  if (openingHistoryId === doc.id) return;
  if (fileSaveStates.get(doc.id)?.historyReadError || fileSaveStates.get(doc.id)?.historyReadOnly) { void openHistoryDocument(doc.id); return; }
  if (fileSaveStates.get(doc.id)?.conflict) { showFileConflict(doc); return; }
  const handle = fileHandles.get(doc.id);
  if (!handle) {
    toast('请通过「打开文档」重新选择原始文件以建立读写关联');
    return;
  }
  try {
    // Call from the user's click, before unrelated asynchronous work.
    if (await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('未获得读写授权，原文件不会被修改');
    if (!fileWriters.has(doc.id)) {
      const disk = await (await handle.getFile()).text();
      if (!hasUnsavedFileChanges(doc) || doc.markdown === disk.replace(/^\uFEFF/, '')) doc.fileDirty = false;
      if (doc.fileDirty && doc.fileDiskContent !== disk) throw new Error('原文件已改变，无法自动合并草稿；请先复制草稿，再重新打开原文件');
      if (!doc.fileDirty) {
        doc.markdown = disk.replace(/^\uFEFF/, '');
        histories.delete(doc.id);
      }
      fileWriters.set(doc.id, new OriginalFileWriter(handle, disk));
      doc.fileDiskContent = disk;
      fileSaveStates.delete(doc.id);
      if (activeId === doc.id) loadDocument(doc.id);
    }
    const ok = await flushOriginalFile(doc);
    if (ok) toast('原始文件已连接，修改将自动写回');
  } catch (error) {
    fileSaveStates.set(doc.id, { error: error.message }); renderFileSaveState();
  }
}

function applyExternalContent(doc, writer, disk, modified) {
  if (activeId === doc.id) tableTools.reset();
  const visible = activeId === doc.id;
  const scroll = visible ? { sourceTop: source.scrollTop, sourceLeft: source.scrollLeft, previewTop: $('.preview-scroll').scrollTop, previewLeft: $('.preview-scroll').scrollLeft, start: source.selectionStart, end: source.selectionEnd } : null;
  let caret = null;
  const selection = window.getSelection();
  if (visible && selection?.rangeCount && visual.contains(selection.anchorNode)) {
    const range = selection.getRangeAt(0);
    const before = document.createRange();
    before.selectNodeContents(visual); before.setEnd(range.startContainer, range.startOffset);
    caret = { start: before.toString().length, length: range.toString().length };
  }
  doc.markdown = disk.replace(/^\uFEFF/, '');
  doc.fileDiskContent = disk;
  doc.fileDirty = false;
  doc.updated = Number.isFinite(modified) ? modified : Date.now();
  writer.diskContent = disk;
  writer.bom = disk.startsWith('\uFEFF') ? '\uFEFF' : '';
  histories.delete(doc.id);
  fileSaveStates.delete(doc.id);
  if (visible) {
    savedRange = null; lastEditKind = null;
    source.value = doc.markdown;
    source.setSelectionRange(Math.min(scroll.start, source.value.length), Math.min(scroll.end, source.value.length));
    visual.innerHTML = renderMarkdown(doc.markdown);
    updateStats(); updateHistoryButtons(); updateFileEditability();
    if (caret) {
      const walker = document.createTreeWalker(visual, NodeFilter.SHOW_TEXT);
      const nodes = []; let total = 0;
      while (walker.nextNode()) { const node = walker.currentNode; nodes.push({ node, start: total }); total += node.textContent.length; }
      const position = offset => {
        offset = Math.min(offset, total);
        const entry = nodes.find(item => offset <= item.start + item.node.textContent.length) || nodes.at(-1);
        return entry ? [entry.node, offset - entry.start] : [visual, 0];
      };
      const range = document.createRange();
      range.setStart(...position(caret.start)); range.setEnd(...position(caret.start + caret.length));
      selection.removeAllRanges(); selection.addRange(range); savedRange = range.cloneRange();
    }
    source.scrollTop = scroll.sourceTop; source.scrollLeft = scroll.sourceLeft;
    $('.line-numbers').style.transform = `translateY(-${source.scrollTop}px)`;
    $('.preview-scroll').scrollTop = scroll.previewTop; $('.preview-scroll').scrollLeft = scroll.previewLeft;
  }
  renderDocumentList(); save(true);
}

async function checkExternalModification() {
  const doc = current();
  if (!doc || document.hidden || composingDocument || resizingTable || deletingRecords.has(doc.id) || externalChecks.has(doc.id) || fileWriteCounts.get(doc.id) || openingHistoryId === doc.id) return;
  const writer = fileWriters.get(doc.id);
  if (!writer) return;
  externalChecks.add(doc.id);
  const baseline = writer.diskContent;
  try {
    const external = await writer.inspectExternal();
    if (activeId !== doc.id || !documents.includes(doc) || fileWriters.get(doc.id) !== writer || fileWriteCounts.get(doc.id) || writer.diskContent !== baseline || composingDocument || resizingTable || deletingRecords.has(doc.id) || openingHistoryId === doc.id) return;
    setOriginalFileMissing(doc, false);
    const unsaved = hasUnsavedFileChanges(doc, baseline);
    const matchesDisk = doc.markdown === external.content.replace(/^\uFEFF/, '');
    if ((!unsaved || matchesDisk) && (external.content !== baseline || doc.fileDirty || fileSaveStates.get(doc.id)?.conflict)) {
      clearTimeout(fileSaveTimers.get(doc.id)); fileSaveTimers.delete(doc.id);
      applyExternalContent(doc, writer, external.content, external.modified);
      if (external.content !== baseline) toast('原文件有外部修改，已自动刷新');
      return;
    }
    if (external.content === baseline) {
      if (fileSaveStates.get(doc.id)?.watchError) { fileSaveStates.delete(doc.id); renderFileSaveState(); }
      return;
    }
    if (unsaved) {
      const first = !fileSaveStates.get(doc.id)?.conflict;
      clearTimeout(fileSaveTimers.get(doc.id)); fileSaveTimers.delete(doc.id);
      fileSaveStates.set(doc.id, { conflict: true, external: external.content });
      renderFileSaveState(); save(true);
      if (first) toast('检测到外部修改：已暂停自动保存，点击保存状态核对冲突');
      return;
    }
    applyExternalContent(doc, writer, external.content, external.modified);
    toast('原文件有外部修改，已自动刷新');
  } catch (error) {
    if (activeId === doc.id && fileWriters.get(doc.id) === writer && isMissingOriginalFile(error)) setOriginalFileMissing(doc, true);
    if (activeId === doc.id && fileWriters.get(doc.id) === writer && !fileSaveStates.get(doc.id)?.conflict) {
      fileSaveStates.set(doc.id, { error: error.message || '暂时无法读取原文件，已保留当前显示内容', watchError: true });
      renderFileSaveState();
    }
  } finally { externalChecks.delete(doc.id); }
}

function showFileConflict(doc) {
  const state = fileSaveStates.get(doc.id);
  if (!state?.conflict) return;
  conflictReview = { id: doc.id, draft: doc.markdown, writer: fileWriters.get(doc.id) };
  showModal(`${modalHeader('原文件与网页都有修改', '自动保存已暂停，两份内容均未被覆盖')}<div class="conflict-versions"><label>网页未保存的修改<textarea id="conflict-draft" readonly aria-label="网页草稿"></textarea></label><label>检测到的磁盘内容<textarea id="conflict-disk" readonly aria-label="磁盘内容"></textarea></label></div><p class="help-notice">可先复制网页草稿另行保留。选择「采用原文件内容」会放弃当前网页草稿，并重新读取原文件。关闭窗口可继续保留草稿，自动保存仍暂停。</p><div class="modal-actions"><button class="secondary-button" data-action="close-modal">保留网页草稿</button><button class="primary-button" data-action="use-disk-version">采用原文件内容</button></div>`, () => {
    $('#conflict-draft').value = doc.markdown;
    $('#conflict-disk').value = state.external.replace(/^\uFEFF/, '');
  });
}

async function useDiskVersion() {
  const review = conflictReview;
  const doc = current();
  if (!review || !doc || doc.id !== review.id || fileWriters.get(doc.id) !== review.writer) return;
  try {
    const external = await review.writer.inspectExternal();
    if (activeId !== review.id || !documents.includes(doc) || fileWriters.get(doc.id) !== review.writer) return;
    if (doc.markdown !== review.draft || fileWriteCounts.get(doc.id)) { showFileConflict(doc); toast('网页草稿有变化，请重新核对'); return; }
    clearTimeout(fileSaveTimers.get(doc.id)); fileSaveTimers.delete(doc.id);
    applyExternalContent(doc, review.writer, external.content, external.modified);
    $('#modal').close(); conflictReview = null;
    toast('已重新读取原文件');
  } catch (error) { toast(error.message || '读取原文件失败，草稿已保留'); }
}

async function openOriginalFile() {
  if (!window.showOpenFilePicker) {
    showModal(`${modalHeader('此浏览器不支持直接写回原文件')}<div class="help-intro">请使用当前版本的 Chrome 或 Edge 打开墨页，再点击「打开文档」并允许文件读写。当前浏览器不会退回只保存缓存的方式。</div><button class="primary-button" data-action="close-modal">知道了</button>`);
    return;
  }
  try {
    const pickerOptions = {
      id: 'inkwell-open-document',
      multiple: false,
      types: [{ description: 'Markdown 文档', accept: { 'text/plain': ['.md', '.markdown', '.txt'] } }],
    };
    if (lastOpenedHandle) pickerOptions.startIn = lastOpenedHandle;
    const [handle] = await window.showOpenFilePicker(pickerOptions);
    lastOpenedHandle = handle;
    void rememberFileHandle(LAST_OPENED_HANDLE_KEY, handle).catch(() => {});
    if (await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('未获得文件写入授权，文件尚未打开');
    const file = await handle.getFile();
    if (file.size > 2 * 1024 * 1024) throw new Error('请选择小于 2 MB 的 Markdown 文档');
    const disk = await file.text();
    await handleRestore;
    let doc;
    for (const candidate of documents) {
      if (historyStore?.isDeleted(candidate.id)) continue;
      const oldHandle = fileHandles.get(candidate.id);
      if (oldHandle && oldHandle.type !== 'moye-local-file' && await handle.isSameEntry(oldHandle)) { doc = candidate; break; }
    }
    if (!doc) {
      const clean = disk.replace(/^\uFEFF/, '');
      // Cache-only documents from previous versions must not overwrite a file on open.
      doc = { id: crypto.randomUUID(), title: file.name.replace(/\.(md|markdown|txt)$/i, ''), extension: file.name.match(/\.(md|markdown|txt)$/i)?.[0] || '.md', sourcePath: file.name, markdown: clean, updated: Date.now() };
      documents.unshift(doc);
    }
    doc.fileMissing = false;
    if (!hasUnsavedFileChanges(doc) || doc.markdown === disk.replace(/^\uFEFF/, '')) doc.fileDirty = false;
    if (!doc.fileDirty) { doc.markdown = disk.replace(/^\uFEFF/, ''); histories.delete(doc.id); }
    const baseline = doc.fileDirty ? doc.fileDiskContent : disk;
    fileHandles.set(doc.id, handle);
    fileWriters.set(doc.id, new OriginalFileWriter(handle, baseline ?? disk));
    if (!doc.fileDirty) doc.fileDiskContent = disk;
    try { await rememberFileHandle(doc.id, handle); } catch { toast('文件已连接；下次重新打开页面可能需要再次选择文件'); }
    loadDocument(doc.id);
    fileSaveStates.delete(doc.id);
    if (doc.fileDirty) {
      // Retained unsaved changes are never written just by opening a file.
      fileSaveStates.set(doc.id, { error: '已恢复未写回草稿；核对内容后按 ⌘ / Ctrl + S 保存到原文件' });
    }
    renderFileSaveState();
  } catch (error) {
    if (error.name !== 'AbortError') toast(error.message || '文件打开失败');
  }
}

function relativeTime(time) {
  const minutes = Math.floor((Date.now() - time) / 60000);
  if (minutes < 1) return '刚刚编辑';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
}

function setOriginalFileMissing(doc, missing) {
  if (!documents.includes(doc) || !!doc.fileMissing === missing) return;
  doc.fileMissing = missing;
  save(true);
  renderDocumentList();
}

let checkingHistoryAvailability = false;
async function checkHistoryFileAvailability() {
  if (document.hidden || checkingHistoryAvailability) return;
  checkingHistoryAvailability = true;
  try {
    await handleRestore;
    for (const id of documents.map(doc => doc.id)) {
      if (document.hidden) break;
      const doc = documents.find(doc => doc.id === id);
      if (!doc) continue;
      const handle = fileHandles.get(doc.id);
      // Native getFile checks existence without reading the Markdown body.
      // Never prompt for permission as part of a background history check.
      if (!handle || handle.type === 'moye-local-file' || deletingRecords.has(doc.id) || fileWriteCounts.get(doc.id)) continue;
      const valid = () => documents.includes(doc) && fileHandles.get(doc.id) === handle && !deletingRecords.has(doc.id) && !fileWriteCounts.get(doc.id);
      try {
        if (await handle.queryPermission({ mode: 'read' }) !== 'granted' || !valid()) continue;
        await handle.getFile();
        if (valid()) setOriginalFileMissing(doc, false);
      } catch (error) {
        if (valid() && isMissingOriginalFile(error)) setOriginalFileMissing(doc, true);
      }
    }
  } finally { checkingHistoryAvailability = false; }
}

function renderDocumentList() {
  const records = sharedHistoryRecords || documents;
  $('#history-count').textContent = `${records.length} / ${HISTORY_LIMIT}`;
  $('#document-list').innerHTML = records.length ? records.map(doc => `<div class="doc-row ${doc.id === activeId ? 'selected' : ''} ${doc.fileMissing ? 'file-missing' : ''}"><button class="doc-select" data-document="${escapeHTML(doc.id)}" title="${escapeHTML((doc.title || '未命名文档') + (doc.fileMissing ? '（原文件不存在，可能已删除或移动）' : ''))}">${icon('file', 16)}<span>${escapeHTML(doc.title || '未命名文档')}</span></button><button class="icon-button history-delete" data-delete-history="${escapeHTML(doc.id)}" aria-label="删除历史记录：${escapeHTML(doc.title || '未命名文档')}" title="删除历史记录，不删除原文件" ${deletingRecords.has(doc.id) ? 'disabled' : ''}>${icon('trash', 14)}</button></div>`).join('') : '<p class="list-empty">暂无历史记录<br>打开文档后自动保留，最多 20 条。</p>';
}

async function deleteHistoryRecord(id) {
  const doc = documents.find(item => item.id === id);
  if (!doc || deletingRecords.has(id)) return;
  deletingRecords.add(id);
  renderDocumentList();
  try {
    await handleRestore;
    if (doc.fileDirty || fileWriteCounts.get(id)) {
      if (!await flushOriginalFile(doc) || doc.fileDirty || fileWriteCounts.get(id)) {
        toast('修改尚未保存到原文件，已保留这条记录');
        return;
      }
    }
    try { await forgetFileHandle(id); }
    catch {
      if (fileHandles.has(id)) { toast('文件关联清理失败，已保留记录，请重试'); return; }
    }
    if (doc.fileDirty || fileWriteCounts.get(id)) { toast('文档有新的未保存修改，已保留记录'); return; }
    try { historyStore?.delete(id); }
    catch {
      const handle = fileHandles.get(id);
      if (handle) await rememberFileHandle(id, handle).catch(() => {});
      toast('历史删除状态保存失败，已保留记录，请重试'); return;
    }
    clearTimeout(fileSaveTimers.get(id));
    fileSaveTimers.delete(id);
    documents = documents.filter(item => item.id !== id);
    for (const map of [histories, fileHandles, fileWriters, fileSaveStates, fileWriteCounts, imageDirectories, imageDirectoryStates]) map.delete(id);
    if (activeId === id) {
      if (documents[0]) void openHistoryDocument(documents[0].id);
      else loadDocument(null);
    }
    else renderDocumentList();
    save(true);
    toast('已删除历史记录，原始文件未删除');
  } finally {
    deletingRecords.delete(id);
    renderDocumentList();
  }
}

function updateNumbers() {
  const lineCount = source.value.split('\n').length;
  $('.line-numbers').innerHTML = Array.from({ length: lineCount }, (_, i) => `<div>${i + 1}</div>`).join('');
  $('.line-numbers').style.transform = `translateY(-${source.scrollTop}px)`;
  $('#status-lines').textContent = `${lineCount} 行`;
  cursorPosition();
}

function updateStats() {
  refreshCodeCopyButtons(visual, toast);
  refreshDocumentImages();
  const text = visual.textContent || '';
  const chinese = (text.match(/[\p{Script=Han}]/gu) || []).length;
  const other = (text.replace(/[\p{Script=Han}]/gu, ' ').match(/[\p{L}\p{N}]+/gu) || []).length;
  const count = chinese + other;
  $('#heading-words').textContent = `${count} 字`;
  $('#status-words').textContent = `${count} 字`;
  $('#updated-label').textContent = relativeTime(current()?.updated || Date.now());
  updateNumbers();
  updateOutline();
}

function updateOutline() {
  const headings = [...visual.querySelectorAll('h1,h2,h3,h4,h5,h6')];
  $('#outline-count').textContent = headings.length;
  $('#outline-list').innerHTML = headings.length ? headings.map((h, i) => {
    h.id = `heading-${i}`;
    return `<button data-outline="${i}" class="outline-item ${mode === 'source' && i === 0 ? 'current' : ''}" style="--level:${Number(h.tagName[1]) - 1}"><span>${escapeHTML(h.textContent || '未命名标题')}</span></button>`;
  }).join('') : '<p class="outline-empty">添加标题后<br>在这里快速导航</p>';
  outlineTracking.refresh();
}

function setMode(value) {
  tableTools.reset();
  mode = value === 'source' ? 'source' : 'visual';
  $('.editing-area').dataset.mode = mode;
  $('[data-action="display-mode"]').title = `当前：${mode === 'source' ? '源码' : '可视化'}；点击切换为${mode === 'source' ? '可视化' : '源码'}`;
  save();
}

function historyForDoc() {
  if (!current()) return null;
  if (!histories.has(activeId)) histories.set(activeId, { entries: [current().markdown], index: 0 });
  return histories.get(activeId);
}

function recordHistory(kind) {
  const history = historyForDoc();
  const value = current().markdown;
  if (history.entries[history.index] === value) return;
  const now = Date.now();
  const coalesce = lastEditKind === kind && now - lastEditTime < 700 && history.index > 0 && history.index === history.entries.length - 1;
  history.entries.splice(history.index + 1);
  if (coalesce) history.entries[history.index] = value;
  else { history.entries.push(value); history.index++; }
  if (history.entries.length > 150) { history.entries.shift(); history.index--; }
  lastEditTime = now;
  lastEditKind = kind;
  updateHistoryButtons();
}

function updateHistoryButtons() {
  const history = historyForDoc();
  $('[data-action="undo"]').disabled = openingHistoryId === activeId || !fileWriters.has(activeId) || !history || history.index === 0;
  $('[data-action="redo"]').disabled = openingHistoryId === activeId || !fileWriters.has(activeId) || !history || history.index === history.entries.length - 1;
}

function applyHistory(direction) {
  if (openingHistoryId === activeId || !fileWriters.has(activeId)) return;
  tableTools.reset();
  const history = historyForDoc();
  if (!history) return;
  const next = history.index + direction;
  if (next < 0 || next >= history.entries.length) return;
  history.index = next;
  lastEditKind = null;
  current().markdown = history.entries[history.index];
  source.value = current().markdown;
  visual.innerHTML = renderMarkdown(current().markdown);
  savedRange = null;
  current().updated = Date.now();
  documents = recentDocuments(documents, doc => doc.id === activeId || doc.fileDirty || fileWriteCounts.get(doc.id));
  renderDocumentList();
  scheduleOriginalSave(current());
  updateStats(); updateHistoryButtons(); save();
}

function updatePageTitle() {
  const name = current()?.title.trim();
  document.title = name ? (/\.(md|markdown|txt)$/i.test(name) ? name : name + (current().extension || '.md')) : '墨页 · Markdown 工作空间';
  title.textContent = name || '';
  title.title = current()?.sourcePath || document.title;
}


async function openCommandLineDocument() {
  const version = historyOpenVersion;
  try {
    const handle = await localFileFromHash(window.location.hash);
    if (!handle) return;
    await handleRestore;
    // A user's explicit document selection takes precedence over a slow startup read.
    if (historyOpenVersion !== version) return;
    let doc = documents.find(item => item.localFilePath === handle.path);
    if (doc && historyStore?.isDeleted(doc.id)) doc = null;
    if (!doc) {
      const originalId = `local-${handle.id}`;
      const id = historyStore?.isDeleted(originalId) ? `${originalId}-${crypto.randomUUID()}` : originalId;
      doc = { id, title: handle.name.replace(/\.(md|markdown|txt)$/i, ''), extension: handle.name.match(/\.(md|markdown|txt)$/i)?.[0] || '.md', sourcePath: handle.path, localFilePath: handle.path, markdown: '', updated: Date.now() };
      documents.unshift(doc);
    }
    doc.sourcePath = handle.path;
    fileHandles.set(doc.id, handle);
    try { await rememberFileHandle(doc.id, handle); } catch { toast('原文件已连接，但浏览器未能记住历史文件关联'); }
    if (historyOpenVersion !== version) return;
    if (!document.body.classList.contains('focus-mode')) actions.focus();
    await openHistoryDocument(doc.id);
  } catch (error) { toast(error.message || '命令行文件打开失败，请在终端重新运行 moye'); }
}

function loadDocument(id, readHistory = false) {
  tableTools.reset();
  historyOpenVersion++;
  openingHistoryId = readHistory ? id : null;
  activeId = id;
  const doc = current();
  if (doc) {
    doc.lastOpened = Date.now();
    documents = recentDocuments(documents, doc => doc.id === activeId || doc.fileDirty || fileWriteCounts.get(doc.id));
    const retainedIds = new Set(documents.map(item => item.id));
    for (const historyId of histories.keys()) if (!retainedIds.has(historyId)) histories.delete(historyId);
  }
  savedRange = null;
  lastEditKind = null;
  const empty = !doc;
  $('.empty-state').hidden = !empty;
  ['.sidebar-document-info', '.editor-card'].forEach(s => { $(s).hidden = empty; });
  if (doc) {
    title.textContent = doc.title;
    source.value = doc.markdown;
    visual.innerHTML = renderMarkdown(doc.markdown);
    source.scrollTop = 0;
    $('.preview-scroll').scrollTop = 0;
    updateStats(); updateHistoryButtons();
  }
  updatePageTitle();
  updateFileEditability();
  renderFileSaveState();
  renderDocumentList(); save();
  $('.sidebar').classList.remove('mobile-open');
  if (!doc) refreshDocumentImages();
  void checkExternalModification();
}

async function openHistoryDocument(id) {
  const doc = documents.find(item => item.id === id);
  if (!doc || deletingRecords.has(id)) return;
  clearTimeout(fileSaveTimers.get(id)); fileSaveTimers.delete(id);
  loadDocument(id, true);
  const version = historyOpenVersion;
  const stillCurrent = () => version === historyOpenVersion && activeId === id && documents.includes(doc);
  let permissionPromise;
  let handle = fileHandles.get(id);
  try {
    // Initiate permission while the history click still carries user activation.
    if (handle) permissionPromise = handle.requestPermission({ mode: 'readwrite' });
    else {
      await handleRestore;
      if (!stillCurrent()) return;
      handle = fileHandles.get(id);
      if (!handle) {
        handle = await recallFileHandle(id);
        if (!stillCurrent()) return;
        if (handle) fileHandles.set(id, handle);
      }
      if (!handle) throw new Error('这条历史记录没有原文件关联，当前显示的是旧草稿；请通过「打开文档」重新选择原文件');
      permissionPromise = handle.requestPermission({ mode: 'readwrite' });
    }
    const permission = await permissionPromise;
    if (!stillCurrent()) return;
    const canRead = permission === 'granted' || await handle.queryPermission({ mode: 'read' }) === 'granted';
    if (!stillCurrent()) return;
    if (!canRead) throw new Error('未获得原文件读取权限，当前显示的是旧草稿；点击这里重新授权或使用「打开文档」');
    const previousWriter = fileWriters.get(id);
    // Finish existing writes before taking a fresh disk snapshot.
    if (previousWriter) await previousWriter.pending.catch(() => {});
    if (!stillCurrent()) return;
    const file = await handle.getFile();
    if (file.size > 2 * 1024 * 1024) throw new Error('原文件超过 2 MB，未刷新；当前保留历史草稿');
    const disk = await file.text();
    if (!stillCurrent()) return;
    setOriginalFileMissing(doc, false);
    clearTimeout(fileSaveTimers.get(id)); fileSaveTimers.delete(id);
    const baseline = doc.fileDiskContent ?? previousWriter?.diskContent;
    const unsaved = hasUnsavedFileChanges(doc, baseline) && doc.markdown !== disk.replace(/^\uFEFF/, '');
    const writer = new OriginalFileWriter(handle, unsaved ? baseline ?? disk : disk);
    if (permission === 'granted') fileWriters.set(id, writer);
    else fileWriters.delete(id);
    openingHistoryId = null;
    if (unsaved) {
      // Read from disk, but never discard or silently write a restored draft.
      if (baseline === undefined || disk !== baseline) {
        fileSaveStates.set(id, { conflict: true, external: disk, historyReadOnly: permission !== 'granted' });
        toast('原文件已有修改，已保留网页草稿；点击保存状态对照两份内容');
      } else {
        fileSaveStates.set(id, { historyReadOnly: permission !== 'granted', error: '已读取原文件并恢复未保存草稿；核对后点击保存状态授权写回' });
      }
    } else {
      applyExternalContent(doc, writer, disk, file.lastModified);
      if (permission !== 'granted') fileSaveStates.set(id, { historyReadOnly: true, error: '已读取原文件最新内容，目前只读；点击这里授权写入后再编辑' });
    }
    updateFileEditability(); updateHistoryButtons(); renderFileSaveState(); save(true);
  } catch (error) {
    if (!stillCurrent()) return;
    if (isMissingOriginalFile(error)) setOriginalFileMissing(doc, true);
    openingHistoryId = null;
    fileWriters.delete(id);
    fileSaveStates.set(id, { historyReadError: true, error: error.message || '原文件读取失败，当前显示的是历史草稿；请重新打开原文件' });
    updateFileEditability(); updateHistoryButtons(); renderFileSaveState();
    toast('未能读取原文件，当前显示的是历史草稿');
  } finally {
    if (stillCurrent()) { openingHistoryId = null; updateFileEditability(); updateHistoryButtons(); renderFileSaveState(); }
  }
}

function changed(kind) {
  if (!current() || openingHistoryId === activeId || resizingTable || !fileWriters.has(activeId)) return;
  const doc = current();
  if (kind === 'source') {
    doc.markdown = source.value;
    visual.innerHTML = renderMarkdown(doc.markdown);
    savedRange = null;
  } else {
    doc.markdown = serializeMarkdown(visual);
    source.value = doc.markdown;
  }
  doc.updated = Date.now();
  recordHistory(kind);
  documents = recentDocuments(documents, doc => doc.id === activeId || doc.fileDirty || fileWriteCounts.get(doc.id));
  renderDocumentList();
  scheduleOriginalSave(doc);
  updateStats(); save();
}

source.addEventListener('input', () => changed('source'));
visual.addEventListener('input', () => changed('visual'));
visual.addEventListener('change', event => { if (event.target.matches('input[type=checkbox]')) changed('task'); });
visual.addEventListener('paste', event => {
  event.preventDefault();
  document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
});
visual.addEventListener('click', event => {
  const a = event.target.closest('a');
  if (a) {
    event.preventDefault();
    if ((event.metaKey || event.ctrlKey) && safeURL(a.href)) window.open(a.href, '_blank', 'noopener,noreferrer');
  }
});
source.addEventListener('scroll', () => { $('.line-numbers').style.transform = `translateY(-${source.scrollTop}px)`; });
function cursorPosition() {
  const before = source.value.slice(0, source.selectionStart).split('\n');
  $('#cursor-position').textContent = `行 ${before.length}，列 ${before.at(-1).length + 1}`;
}
source.addEventListener('keyup', cursorPosition);
source.addEventListener('click', cursorPosition);
source.addEventListener('keydown', event => {
  if (event.key === 'Tab') {
    if (source.readOnly) return;
    event.preventDefault();
    source.setRangeText('  ', source.selectionStart, source.selectionEnd, 'end');
    changed('source');
  }
});
document.addEventListener('selectionchange', () => {
  const selection = window.getSelection();
  if (!selection.rangeCount || !visual.contains(selection.anchorNode)) return;
  savedRange = selection.getRangeAt(0).cloneRange();
  const anchor = selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement;
  const heading = anchor.closest('h1,h2,h3,h4,h5,h6');
  $('#format-label').textContent = heading ? ({ H1: '一级标题', H2: '二级标题', H3: '三级标题' }[heading.tagName] || '标题') : '正文';
  for (const [action, command] of [['bold', 'bold'], ['italic', 'italic'], ['strike', 'strikeThrough']]) {
    const active = document.queryCommandState(command);
    $(`[data-action="${action}"]`).classList.toggle('active', active);
    $(`[data-action="${action}"]`).setAttribute('aria-pressed', String(active));
  }
});

$('.format-toolbar').addEventListener('mousedown', event => {
  if (event.target.closest('button, .toolbar-spacer')) event.preventDefault();
});

$('.toolbar-spacer').addEventListener('dblclick', event => {
  if (event.button !== 0 || !current()) return;
  event.preventDefault();
  closePopovers();
  actions.focus();
});

function focusVisual() {
  if (!current() || openingHistoryId === activeId || !fileWriters.has(activeId)) return false;
  if (mode === 'source') {
    setMode('visual');
  }
  visual.focus();
  const selection = window.getSelection();
  if (savedRange && visual.contains(savedRange.commonAncestorContainer)) {
    selection.removeAllRanges(); selection.addRange(savedRange);
  } else {
    const range = document.createRange(); range.selectNodeContents(visual); range.collapse(false);
    selection.removeAllRanges(); selection.addRange(range);
  }
  return true;
}

function sourceWrap(prefix, suffix = prefix, placeholder = '文字') {
  const start = source.selectionStart;
  const end = source.selectionEnd;
  const selected = source.value.slice(start, end) || placeholder;
  source.setRangeText(prefix + selected + suffix, start, end, 'end');
  source.focus();
  source.setSelectionRange(start + prefix.length, start + prefix.length + selected.length);
  changed('format');
}

function insertHTML(html) {
  if (focusVisual()) { document.execCommand('insertHTML', false, html); changed('insert'); }
}

function format(action, value) {
  if (!current() || openingHistoryId === activeId || !fileWriters.has(activeId)) return;
  if (document.activeElement === source || mode === 'source') {
    if (action === 'bold') return sourceWrap('**');
    if (action === 'italic') return sourceWrap('*');
    if (action === 'strike') return sourceWrap('~~');
    if (action === 'inline-code') return sourceWrap('`');
    const prefixes = { bullet: '- ', number: '1. ', quote: '> ' };
    if (prefixes[action] || action === 'heading') {
      const start = source.value.lastIndexOf('\n', source.selectionStart - 1) + 1;
      const lineEnd = source.value.indexOf('\n', source.selectionEnd);
      const end = lineEnd < 0 ? source.value.length : lineEnd;
      const content = source.value.slice(start, end).split('\n').map(line => (action === 'heading' ? (value === 'p' ? '' : '#'.repeat(Number(value[1])) + ' ') + line.replace(/^#{1,6}\s+/, '') : prefixes[action] + line)).join('\n');
      source.setRangeText(content, start, end, 'end'); source.focus(); changed('format'); return;
    }
  }
  if (action === 'inline-code') {
    if (!focusVisual()) return;
    const selected = window.getSelection().toString() || '代码';
    insertHTML(`<code>${escapeHTML(selected)}</code>&nbsp;`); return;
  }
  if (!focusVisual()) return;
  const commands = { bold: 'bold', italic: 'italic', strike: 'strikeThrough', bullet: 'insertUnorderedList', number: 'insertOrderedList', quote: 'formatBlock', heading: 'formatBlock' };
  document.execCommand(commands[action], false, action === 'quote' ? 'blockquote' : value);
  changed('format');
}

function closePopovers() {
  $$('.popover').forEach(p => { p.hidden = true; });
  for (const action of ['width', 'font-size']) $(`[data-action="${action}"]`).setAttribute('aria-expanded', 'false');
}
function togglePopover(id) {
  const wasHidden = $(id).hidden;
  closePopovers();
  const menu = $(id);
  menu.hidden = !wasHidden;
  if (wasHidden && ['#width-menu', '#font-menu'].includes(id)) {
    const trigger = menu.parentElement.querySelector('button');
    const rect = trigger.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 8}px`;
    menu.style.right = `${Math.max(10, window.innerWidth - rect.right)}px`;
    menu.style.maxHeight = `${Math.max(0, window.innerHeight - rect.bottom - 20)}px`;
  }
}

function showModal(content, after) {
  $('#modal').classList.remove('appearance-dialog');
  $('#modal-content').innerHTML = content;
  $('#modal').showModal();
  $('#modal-content').querySelector('[autofocus]')?.focus();
  after?.();
}
const modalHeader = (heading, sub = '') => `<div class="modal-heading"><div><h2>${heading}</h2>${sub ? `<p>${sub}</p>` : ''}</div>${button('close-modal', 'close', '关闭弹窗')}</div>`;

function showSettings() {
  showModal(`${modalHeader('设置', '选择适合你的阅读风格')}<div class="appearance-intro"><span>显示风格</span><span>选择后立即应用并关闭 · 自动记住</span></div><div class="appearance-grid" role="group" aria-label="网页显示风格">${READING_STYLES.map(style => `<button type="button" class="appearance-option" data-reading-style="${style.id}" aria-pressed="${style.id === readingStyle}" style="--sample-bg:${style.tokens.bg};--sample-paper:${style.tokens.paper};--sample-sidebar:${style.tokens.sidebar};--sample-accent:${style.tokens.purple};--sample-text:${style.tokens['reading-text']};--sample-line:${style.tokens.line};--sample-font:${style.tokens['reading-font'].replaceAll('"', '&quot;')};--sample-radius:${style.tokens['card-radius']}"><span class="appearance-preview" aria-hidden="true"><span class="sample-sidebar"><i></i><i></i><i></i></span><span class="sample-paper"><span class="sample-title">让阅读，慢下来</span><span class="sample-rule"></span><span class="sample-copy">字里行间，留住每一个想法。</span><span class="sample-lines"><i></i><i></i></span></span><span class="appearance-check">${icon('check', 13)}</span></span><span class="appearance-name">${style.name}<small>${style.badge}</small></span><span class="appearance-description">${style.description}</span></button>`).join('')}</div><p class="appearance-note">风格仅调整显示外观，保留文档字号、正文宽度和行距；不会改动 Markdown 文件。</p><div class="appearance-footer"><span id="appearance-feedback" role="status">当前风格：${resolveReadingStyle(readingStyle).name}</span><button class="primary-button" data-action="close-modal">完成</button></div>`);
  $('#modal').classList.add('appearance-dialog');
}

function selectReadingStyle(id) {
  readingStyle = resolveReadingStyle(id).id;
  applyTheme();
  let remembered = true;
  try { localStorage.setItem(APPEARANCE_STORAGE_KEY, readingStyle); }
  catch { remembered = false; }
  for (const option of $$('[data-reading-style]')) {
    option.setAttribute('aria-pressed', String(option.dataset.readingStyle === readingStyle));
  }
  const feedback = $('#appearance-feedback');
  if (feedback) feedback.textContent = `已应用「${resolveReadingStyle(readingStyle).name}」${remembered ? '，已记住选择' : '；浏览器存储不可用，本次选择未记住'}`;
  $('#modal').close();
  if (!remembered) toast('已应用风格，但浏览器存储不可用，本次选择未记住');
}

function showHelp() {
  showModal(`${modalHeader('给想法，一个舒适的空间', '墨页 · Markdown 工作空间')}<div class="help-intro">点击「宽度」右侧的「切换显示模式」按钮，在源码和可视化之间切换，全屏时也可使用。两种模式的内容实时同步。</div><div class="help-grid"><div>${icon('split', 22)}<h3>双向编辑</h3><p>在源码模式编写 Markdown，或在可视化模式直接修改文字、列表与表格。</p></div><div>${icon('folder', 22)}<h3>打开本地文档</h3><p>点击左侧「打开文档」，选择 .md、.markdown 或 .txt 文件。</p></div><div>${icon('files', 22)}<h3>历史记录</h3><p>自动保留最近打开或编辑的 20 篇文档。超出后自动移除最早的记录，授权后修改会自动写回原始文件，浏览器额外保存草稿。</p></div><div>${icon('keyboard', 22)}<h3>常用快捷键</h3><p>⌘ / Ctrl + B 加粗，I 斜体，S 保存，Z 撤销，Shift + Z 重做。</p></div></div><div class="help-notice">支持标题、粗体、斜体、删除线、链接、图片链接、列表、任务、引用、代码块与表格。支持 span 的 color 颜色与 font-weight 字重，以及 strong / b 加粗；其余 HTML 显示为文本。光标位于表格第一行时可调整整体宽度，拖动列间边界可调整列宽，Esc 取消拖动。文档包含本地相对路径图片时，可点击工具栏右侧「图片目录」，选择当前 Markdown 所在文件夹并授权只读访问。暂不支持数学公式与 Mermaid。请使用 Chrome 或 Edge 打开文件并允许读写。修改后停止输入约 0.45 秒会自动写回，写入成功后显示「已保存到原文件」。点击历史记录会重新读取原文件，需要时请求读写授权；读取失败会标明当前为旧草稿。<br>在可视化区域编辑后，Markdown 的空行、列表符号等格式可能会被统一整理。按住 ⌘ / Ctrl 点击文中链接可在新标签页打开。</div><button class="primary-button" data-action="close-modal">开始写作 ${icon('arrow', 16)}</button>`);
}

function showLink(image = false) {
  if (!current() || openingHistoryId === activeId || !fileWriters.has(activeId)) return;
  const inSource = document.activeElement === source || mode === 'source';
  const start = source.selectionStart; const end = source.selectionEnd;
  const selected = inSource ? source.value.slice(start, end) : window.getSelection().toString();
  showModal(`${modalHeader(image ? '插入图片' : '插入链接', image ? '通过图片地址插入图片' : '为选中的文字添加一个链接')}<form id="link-form"><label class="form-label" for="link-text">${image ? '图片描述' : '链接文字'}</label><input class="form-input" id="link-text" value="${escapeHTML(selected)}" placeholder="${image ? '图片描述' : '显示的文字'}"><label class="form-label" for="link-url">${image ? '图片地址' : '链接地址'}</label><input class="form-input" id="link-url" placeholder="https://" required autofocus><p class="form-error" id="link-error" hidden>请输入以 https:// 或 http:// 开头的有效地址。</p><div class="modal-actions"><button type="button" class="secondary-button" data-action="close-modal">取消</button><button class="primary-button" type="submit">插入${image ? '图片' : '链接'}</button></div></form>`, () => {
    $('#link-form').addEventListener('submit', event => {
      event.preventDefault();
      const url = safeURL($('#link-url').value);
      if (!url || (image && !/^https?:/i.test(url))) { $('#link-error').hidden = false; return; }
      const text = $('#link-text').value || (image ? '图片' : url);
      $('#modal').close();
      if (inSource) {
        source.setRangeText(`${image ? '!' : ''}[${text.replace(/[\[\]]/g, '')}](${url})`, start, end, 'end');
        source.focus(); changed('insert');
      } else insertHTML(image ? `<img src="${escapeHTML(url)}" alt="${escapeHTML(text)}" contenteditable="false"><p><br></p>` : `<a href="${escapeHTML(url)}" rel="noopener noreferrer">${escapeHTML(text)}</a>`);
    });
  });
}

function insertBlock(action) {
  if (!current() || openingHistoryId === activeId || !fileWriters.has(activeId)) return;
  const blocks = {
    task: { md: '- [ ] 新任务\n', html: '<ul><li class="task-item"><input type="checkbox" contenteditable="false" aria-label="任务状态"><span>新任务</span></li></ul><p><br></p>' },
    rule: { md: '\n---\n', html: '<hr><p><br></p>' },
    codeblock: { md: '\n```\n在这里输入代码\n```\n', html: '<pre data-language=""><code>在这里输入代码</code></pre><p><br></p>' },
    table: { md: '\n| 标题一 | 标题二 | 标题三 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n| 内容 | 内容 | 内容 |\n', html: '<table><thead><tr><th>标题一</th><th>标题二</th><th>标题三</th></tr></thead><tbody><tr><td>内容</td><td>内容</td><td>内容</td></tr><tr><td>内容</td><td>内容</td><td>内容</td></tr></tbody></table><p><br></p>' },
  };
  if (mode === 'source' || document.activeElement === source) {
    const at = source.selectionStart;
    const prefix = at > 0 && source.value[at - 1] !== '\n' ? '\n\n' : '';
    source.setRangeText(prefix + blocks[action].md, at, source.selectionEnd, 'end'); source.focus(); changed('insert');
  } else insertHTML(blocks[action].html);
}

const actions = {
  'image-directory': () => { void authorizeImageDirectory(); },
  'use-disk-version': () => { void useDiskVersion(); },
  open: openOriginalFile,
  'save-file': authorizeOriginalFile,
  help: showHelp,
  undo: () => applyHistory(-1),
  redo: () => applyHistory(1),
  width: () => { togglePopover('#width-menu'); $('[data-action="width"]').setAttribute('aria-expanded', String(!$('#width-menu').hidden)); },
  'display-mode': () => setMode(mode === 'source' ? 'visual' : 'source'),
  'font-size': () => { togglePopover('#font-menu'); $('[data-action="font-size"]').setAttribute('aria-expanded', String(!$('#font-menu').hidden)); },
  'font-smaller': () => setFontSize(fontSize - 1),
  'font-larger': () => setFontSize(fontSize + 1),
  'reset-font': () => setFontSize(16),
  'reset-width': () => { contentWidth = 1080; applyWidths(); save(); },
  headings: () => togglePopover('#headings-menu'),
  insert: () => togglePopover('#insert-menu'),

  'close-modal': () => $('#modal').close(),
  link: () => showLink(),
  image: () => showLink(true),
  outline: () => {
    const hidden = $('.editing-area').classList.toggle('hide-outline');
    $('.outline-toggle').classList.toggle('active', !hidden);
    $('.outline-toggle').setAttribute('aria-pressed', String(!hidden));
  },
  focus: () => {
    const focused = document.body.classList.toggle('focus-mode');
    $('[data-action="focus"]').setAttribute('aria-pressed', String(focused));
    $('[data-action="focus"]').classList.toggle('active', focused);
    $('[data-action="focus"]').setAttribute('aria-label', focused ? '退出文档全屏' : '文档全屏');
    $('[data-action="focus"]').title = focused ? '退出文档全屏（Esc）' : '文档全屏';
  },
  sidebar: () => $('.sidebar').classList.toggle('mobile-open'),
  settings: showSettings,
};
function applyTheme() {
  const style = applyReadingStyle(document.documentElement, readingStyle);
  dark = style.dark;
  $('#settings-current').textContent = style.name;
  outlineTracking.refresh();
}

document.addEventListener('click', event => {
  const styleButton = event.target.closest('[data-reading-style]');
  if (styleButton) { selectReadingStyle(styleButton.dataset.readingStyle); return; }
  const deleteButton = event.target.closest('[data-delete-history]');
  if (deleteButton) {
    if (!deleteButton.disabled) void deleteHistoryRecord(deleteButton.dataset.deleteHistory);
    return;
  }
  const actionButton = event.target.closest('[data-action]');
  const documentButton = event.target.closest('[data-document]');
  const headingButton = event.target.closest('[data-heading]');
  const outlineButton = event.target.closest('[data-outline]');
  if (!event.target.closest('.dropdown-wrap')) closePopovers();
  if (actionButton && !actionButton.disabled) {
    const action = actionButton.dataset.action;
    if (['bold', 'italic', 'strike', 'inline-code', 'bullet', 'number', 'quote'].includes(action)) format(action);
    else if (['task', 'rule', 'codeblock', 'table'].includes(action)) insertBlock(action);
    else actions[action]?.();
    if (!['headings', 'insert', 'width', 'reset-width', 'font-size', 'font-smaller', 'font-larger', 'reset-font'].includes(action)) closePopovers();
  }
  if (documentButton) {
    const doc = documents.find(d => d.id === documentButton.dataset.document);
    if (doc) { $('#modal').close(); void openHistoryDocument(doc.id); }
  }
  const widthPreset = event.target.closest('[data-width]');
  if (widthPreset) { contentWidth = widthPreset.dataset.width === 'full' ? 'full' : Number(widthPreset.dataset.width); applyWidths(); save(); }
  if (headingButton) { format('heading', headingButton.dataset.heading); closePopovers(); }
  if (outlineButton) {
    const index = Number(outlineButton.dataset.outline);
    if (mode === 'source') {
      const headings = [...source.value.matchAll(/^#{1,6}\s+.+/gm)];
      const at = headings[index]?.index || 0;
      source.focus(); source.setSelectionRange(at, at);
      source.scrollTop = source.value.slice(0, at).split('\n').length * fontSize * 1.85 - 80;
    } else {
      const heading = $(`#heading-${index}`);
      if (heading) {
        const scroll = $('.preview-scroll');
        scroll.scrollTo({ top: scroll.scrollTop + heading.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 20, behavior: 'smooth' });
        heading.classList.remove('heading-flash'); void heading.offsetWidth; heading.classList.add('heading-flash');
      }
    }
    outlineTracking.select(index);
  }
});

document.addEventListener('keydown', event => {
  const mod = event.metaKey || event.ctrlKey;
  if (event.key === 'Escape' && !$('#modal').open) { closePopovers(); $('.sidebar').classList.remove('mobile-open'); if (document.body.classList.contains('focus-mode')) actions.focus(); }
  if (!mod) return;
  const key = event.key.toLowerCase();
  if ($('#modal').open) return;
  if (key === 's') { event.preventDefault(); save(true); void authorizeOriginalFile(); }
  if (key === 'k' && [source, visual].includes(document.activeElement)) { event.preventDefault(); showLink(); }
  if (key === 'o') { event.preventDefault(); void openOriginalFile(); }
  if (['b', 'i'].includes(key) && [source, visual].includes(document.activeElement)) { event.preventDefault(); format(key === 'b' ? 'bold' : 'italic'); }
  if ((key === 'z' || key === 'y') && [source, visual].includes(document.activeElement)) { event.preventDefault(); applyHistory(event.shiftKey || key === 'y' ? 1 : -1); }
});
$('#modal').addEventListener('click', event => { if (event.target === $('#modal')) { const r = $('#modal').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $('#modal').close(); } });
window.addEventListener('beforeunload', event => {
  save(true);
  if (documents.some(doc => doc.fileDirty) || [...fileWriteCounts.values()].some(count => count > 0)) {
    event.preventDefault(); event.returnValue = '';
  }
});
handleRestore.then(() => { renderFileSaveState(); refreshDocumentImages(); void checkHistoryFileAvailability(); });
for (const editor of [source, visual]) {
  editor.addEventListener('compositionstart', () => { composingDocument = true; });
  editor.addEventListener('compositionend', () => { composingDocument = false; void checkExternalModification(); });
}
window.addEventListener('storage', event => {
  if (event.key === null || event.key?.startsWith(HISTORY_STORAGE_PREFIX)) syncSharedHistory(true);
});
setInterval(() => { if (!document.hidden) syncSharedHistory(); }, 1000);
setInterval(() => { void checkExternalModification(); }, 1500);
setInterval(() => { void checkHistoryFileAvailability(); }, 15000);
window.addEventListener('focus', () => { syncSharedHistory(true); void checkExternalModification(); void checkHistoryFileAvailability(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { syncSharedHistory(true); void checkExternalModification(); void checkHistoryFileAvailability(); }
});
applyTheme();
applyWidths();
applyFontSize();
loadDocument(activeId);
setMode(mode);
void openCommandLineDocument();
