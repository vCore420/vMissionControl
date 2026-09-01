import { api } from './api.js';
import { state, el, toast, escapeHtml, escapeAttr, formatSize, timeAgo, setLocal } from './core.js';

// Shared-folder file browser: List/Thumbnail/Tree views, breadcrumbs,
// rename/move (drag or the rename button), whole-share search, upload
// (button or drag-drop), the image/video/audio preview modal, and the
// Recently Added modal. Self-contained — nothing outside this module calls
// into it except app.js's view-switch handler (`renderFiles`) and its own
// event listeners.

function renderBreadcrumbs() {
  const wrap = el('breadcrumbs');
  const parts = state.filesPath.split('/').filter(Boolean);
  wrap.innerHTML = '';

  const rootBtn = document.createElement('button');
  rootBtn.textContent = '📁 shared';
  rootBtn.onclick = () => { state.filesPath = ''; renderFiles(); };
  wrap.appendChild(rootBtn);

  let acc = '';
  for (const part of parts) {
    acc += (acc ? '/' : '') + part;
    const sep = document.createElement('span');
    sep.textContent = '/';
    wrap.appendChild(sep);
    const btn = document.createElement('button');
    btn.textContent = part;
    const target = acc;
    btn.onclick = () => { state.filesPath = target; renderFiles(); };
    wrap.appendChild(btn);
  }
}

// ---------- Files layout switcher (List / Thumbnail / Tree) ----------
// Per-device only (localStorage), same as the dashboard's.

function setFilesLayoutVisibility(mode) {
  el('fileListTable').classList.toggle('hidden', mode !== 'list');
  el('fileThumbnailView').classList.toggle('hidden', mode !== 'thumbnail');
  el('fileTreeView').classList.toggle('hidden', mode !== 'tree');
  el('breadcrumbs').classList.toggle('hidden', mode === 'tree');
}

export async function renderFiles() {
  setFilesLayoutVisibility(state.filesViewMode);
  const disabled = !state.config.sharedFolder.enabled;
  el('filesDisabledState').classList.toggle('hidden', !disabled);
  el('filesEmptyState').classList.add('hidden');
  if (disabled) {
    el('fileTableBody').innerHTML = '';
    el('fileThumbnailView').innerHTML = '';
    el('fileTreeView').innerHTML = '';
    return;
  }

  if (state.filesViewMode === 'tree') {
    renderBreadcrumbs();
    await renderFileTreeRoot();
    return;
  }

  renderBreadcrumbs();
  try {
    const { items } = await api.listFiles(state.filesPath);
    el('filesEmptyState').classList.toggle('hidden', items.length > 0);
    if (state.filesViewMode === 'thumbnail') renderFilesThumbnailView(items);
    else renderFilesListView(items);
  } catch (err) {
    toast(err.message, true);
  }
}

// Renaming just asks for a new name and moves the item to the same
// folder under that name — reuses the one move endpoint rather than a
// separate rename API, matching how the server treats them as the same
// operation.
async function renameFile(rowPath, currentName) {
  const newName = prompt('Rename to:', currentName);
  if (!newName || newName === currentName) return;
  const parent = rowPath.includes('/') ? rowPath.slice(0, rowPath.lastIndexOf('/')) : '';
  const newPath = parent ? `${parent}/${newName}` : newName;
  try {
    await api.moveFile(rowPath, newPath);
    renderFiles();
  } catch (err) {
    toast(err.message, true);
  }
}

async function moveFileTo(rowPath, name, destFolderPath) {
  const newPath = destFolderPath ? `${destFolderPath}/${name}` : name;
  try {
    await api.moveFile(rowPath, newPath);
    toast(`Moved "${name}"`);
    renderFiles();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderFilesListView(items) {
  const body = el('fileTableBody');
  body.innerHTML = '';
  for (const item of items) {
    const rowPath = state.filesPath ? `${state.filesPath}/${item.name}` : item.name;
    const tr = document.createElement('tr');
    if (item.type === 'dir') tr.className = 'dir-row';
    tr.draggable = true;
    tr.dataset.path = rowPath;
    tr.dataset.name = item.name;
    tr.innerHTML = `
      <td>${item.type === 'dir' ? '📁' : '📄'}</td>
      <td class="file-name">${escapeHtml(item.name)}</td>
      <td>${item.type === 'dir' ? '—' : formatSize(item.size)}</td>
      <td>${item.modified ? new Date(item.modified).toLocaleString() : '—'}</td>
      <td class="file-row-actions"></td>
    `;
    const actions = tr.querySelector('.file-row-actions');
    if (item.type === 'file') {
      const dl = document.createElement('a');
      dl.href = api.downloadUrl(rowPath);
      dl.textContent = '⬇';
      dl.title = 'Download';
      actions.appendChild(dl);
    } else {
      const dlZip = document.createElement('a');
      dlZip.href = api.downloadZipUrl(rowPath);
      dlZip.textContent = '📦';
      dlZip.title = 'Download as .zip';
      dlZip.onclick = (ev) => ev.stopPropagation(); // don't also trigger the row's own "open this folder" click
      actions.appendChild(dlZip);
    }
    const rename = document.createElement('button');
    rename.textContent = '✎';
    rename.title = 'Rename';
    rename.onclick = (ev) => { ev.stopPropagation(); renameFile(rowPath, item.name); };
    actions.appendChild(rename);
    if (state.config.sharedFolder.allowDelete) {
      const del = document.createElement('button');
      del.textContent = '✕';
      del.title = 'Delete';
      del.onclick = async (ev) => {
        ev.stopPropagation();
        if (!confirm(`Delete ${item.name}?`)) return;
        try {
          await api.deleteFile(rowPath);
          renderFiles();
        } catch (err) {
          toast(err.message, true);
        }
      };
      actions.appendChild(del);
    }
    if (item.type === 'dir') {
      tr.addEventListener('click', () => { state.filesPath = rowPath; renderFiles(); });
    } else if (previewType(item.name)) {
      tr.classList.add('previewable');
      tr.addEventListener('click', () => openPreview(buildPreviewEntries(items, state.filesPath), rowPath));
    }

    // Drag a row onto a folder row to move it there — same idea as the
    // reorder drag helper elsewhere, but across a parent/child
    // relationship instead of reordering siblings, so it's its own small
    // handler rather than a reuse of core.js's enableDragReorder.
    tr.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      fileDragData = { path: rowPath, name: item.name };
      tr.classList.add('file-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', rowPath);
    });
    tr.addEventListener('dragend', () => {
      tr.classList.remove('file-dragging');
      fileDragData = null;
    });
    if (item.type === 'dir') {
      tr.addEventListener('dragover', (e) => {
        if (!fileDragData || fileDragData.path === rowPath) return;
        e.preventDefault();
        tr.classList.add('drag-target');
      });
      tr.addEventListener('dragleave', () => tr.classList.remove('drag-target'));
      tr.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        tr.classList.remove('drag-target');
        if (!fileDragData || fileDragData.path === rowPath) return;
        moveFileTo(fileDragData.path, fileDragData.name, rowPath);
      });
    }
    body.appendChild(tr);
  }
}

let fileDragData = null;

const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;
const VIDEO_FILE_RE = /\.(mp4|webm|mkv|mov|avi|m4v)$/i;
const AUDIO_FILE_RE = /\.(mp3|wav|flac|ogg|m4a|aac)$/i;

function previewType(name) {
  if (IMAGE_FILE_RE.test(name)) return 'image';
  if (VIDEO_FILE_RE.test(name)) return 'video';
  if (AUDIO_FILE_RE.test(name)) return 'audio';
  return null;
}

// ---------- Image/video/audio preview ----------
// One modal for all three media types, with Prev/Next cycling through
// whatever previewable list it was opened from — a folder's contents or a
// set of search results, either way just an array of {name, path}.

const previewModal = el('previewModal');
let previewEntries = [];
let previewIndex = -1;

function buildPreviewEntries(items, basePath) {
  return items
    .filter((i) => i.type === 'file' && previewType(i.name))
    .map((i) => ({ name: i.name, path: i.path ?? (basePath ? `${basePath}/${i.name}` : i.name) }));
}

function renderPreviewItem() {
  const entry = previewEntries[previewIndex];
  const url = api.downloadUrl(entry.path);
  const type = previewType(entry.name);
  const body = el('previewBody');
  if (type === 'image') body.innerHTML = `<img src="${escapeAttr(url)}" alt="${escapeAttr(entry.name)}" />`;
  else if (type === 'video') body.innerHTML = `<video src="${escapeAttr(url)}" controls autoplay></video>`;
  else body.innerHTML = `<audio src="${escapeAttr(url)}" controls autoplay></audio>`;
  el('previewName').textContent = entry.name;
  el('previewDownloadBtn').href = url;
  el('previewPosition').textContent = previewEntries.length > 1 ? `${previewIndex + 1} / ${previewEntries.length}` : '';
  el('previewPrevBtn').disabled = previewEntries.length <= 1;
  el('previewNextBtn').disabled = previewEntries.length <= 1;
}

function openPreview(entries, startPath) {
  previewEntries = entries;
  previewIndex = Math.max(0, entries.findIndex((e) => e.path === startPath));
  renderPreviewItem();
  previewModal.classList.remove('hidden');
}

function previewStep(delta) {
  if (previewEntries.length < 2) return;
  previewIndex = (previewIndex + delta + previewEntries.length) % previewEntries.length;
  renderPreviewItem();
}

function closePreview() {
  previewModal.classList.add('hidden');
  el('previewBody').innerHTML = ''; // removing the element stops any playing video/audio
}

el('previewPrevBtn').addEventListener('click', () => previewStep(-1));
el('previewNextBtn').addEventListener('click', () => previewStep(1));
el('closePreviewBtn').addEventListener('click', closePreview);
previewModal.addEventListener('click', (e) => { if (e.target === previewModal) closePreview(); });
document.addEventListener('keydown', (e) => {
  if (previewModal.classList.contains('hidden')) return;
  if (e.key === 'Escape') closePreview();
  else if (e.key === 'ArrowLeft') previewStep(-1);
  else if (e.key === 'ArrowRight') previewStep(1);
});

function renderFilesThumbnailView(items) {
  const wrap = el('fileThumbnailView');
  wrap.innerHTML = '';
  for (const item of items) {
    const rowPath = state.filesPath ? `${state.filesPath}/${item.name}` : item.name;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'file-thumb';

    const iconInner = item.type === 'dir'
      ? '📁'
      : IMAGE_FILE_RE.test(item.name)
        ? `<img src="${escapeAttr(api.downloadUrl(rowPath))}" alt="" loading="lazy" />`
        : recentFileIcon(item.name);

    btn.innerHTML = `
      <div class="file-thumb-icon">${iconInner}</div>
      <div class="file-thumb-name">${escapeHtml(item.name)}</div>
    `;

    if (item.type === 'dir') {
      btn.addEventListener('click', () => { state.filesPath = rowPath; renderFiles(); });
    } else if (previewType(item.name)) {
      btn.addEventListener('click', () => openPreview(buildPreviewEntries(items, state.filesPath), rowPath));
    } else {
      btn.addEventListener('click', () => window.open(api.downloadUrl(rowPath), '_blank', 'noopener'));
    }
    wrap.appendChild(btn);
  }
}

// Lazily fetches each folder's children only when it's actually expanded,
// reusing the same single-directory endpoint List/Thumbnail already use —
// no new backend route, and no risk of trying to walk a huge shared folder
// in one request. treeExpanded persists across re-renders (e.g. after an
// upload) so expanding a folder doesn't collapse everything else.
const treeExpanded = new Set(['']);

async function renderFileTreeRoot() {
  const wrap = el('fileTreeView');
  wrap.innerHTML = '';
  try {
    wrap.appendChild(await buildTreeNode('', 'shared', true));
  } catch (err) {
    toast(err.message, true);
  }
}

async function buildTreeNode(path, label, isDir) {
  const row = document.createElement('div');
  row.className = 'tree-row' + (isDir && state.filesPath === path ? ' active' : '');
  row.innerHTML = `
    <span class="tree-toggle">${isDir ? (treeExpanded.has(path) ? '▼' : '▶') : ''}</span>
    <span>${isDir ? '📁' : '📄'}</span>
    <span class="tree-name">${escapeHtml(label)}</span>
  `;

  const container = document.createElement('div');
  container.appendChild(row);

  if (!isDir) {
    row.addEventListener('click', () => window.open(api.downloadUrl(path), '_blank', 'noopener'));
    return container;
  }

  const childrenWrap = document.createElement('div');
  childrenWrap.className = 'tree-children';
  childrenWrap.classList.toggle('hidden', !treeExpanded.has(path));
  container.appendChild(childrenWrap);

  row.addEventListener('click', async () => {
    state.filesPath = path;
    el('fileTreeView').querySelectorAll('.tree-row.active').forEach((r) => r.classList.remove('active'));
    row.classList.add('active');

    if (treeExpanded.has(path)) {
      treeExpanded.delete(path);
      childrenWrap.classList.add('hidden');
    } else {
      treeExpanded.add(path);
      childrenWrap.classList.remove('hidden');
      if (!childrenWrap.dataset.loaded) {
        await populateTreeChildren(path, childrenWrap);
        childrenWrap.dataset.loaded = 'true';
      }
    }
    row.querySelector('.tree-toggle').textContent = treeExpanded.has(path) ? '▼' : '▶';
  });

  if (treeExpanded.has(path)) {
    await populateTreeChildren(path, childrenWrap);
    childrenWrap.dataset.loaded = 'true';
  }

  return container;
}

async function populateTreeChildren(path, wrapEl) {
  wrapEl.innerHTML = '';
  try {
    const { items } = await api.listFiles(path);
    for (const item of items) {
      const childPath = path ? `${path}/${item.name}` : item.name;
      wrapEl.appendChild(await buildTreeNode(childPath, item.name, item.type === 'dir'));
    }
  } catch (err) {
    toast(err.message, true);
  }
}

el('filesLayoutSwitch').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-layout]');
  if (!btn) return;
  state.filesViewMode = btn.dataset.layout;
  setLocal('mc:filesView', state.filesViewMode);
  el('filesLayoutSwitch').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
  renderFiles();
});

// ---------- Whole-share search ----------
// Recursive across every folder, not just the one currently open — a
// separate results view rather than filtering the current listing, since
// matches can come from anywhere in the tree.

let fileSearchTimer = null;

function clearFileSearch() {
  el('fileSearchInput').value = '';
  el('fileSearchResults').classList.add('hidden');
  el('filesSearchEmptyState').classList.add('hidden');
  setFilesLayoutVisibility(state.filesViewMode);
}

function renderSearchResults(items, query, truncated) {
  el('fileListTable').classList.add('hidden');
  el('fileThumbnailView').classList.add('hidden');
  el('fileTreeView').classList.add('hidden');
  el('breadcrumbs').classList.add('hidden');
  el('filesEmptyState').classList.add('hidden');
  el('filesSearchEmptyState').classList.toggle('hidden', items.length > 0);
  el('fileSearchEmptyQuery').textContent = query;

  const wrap = el('fileSearchResults');
  wrap.classList.remove('hidden');
  const entries = buildPreviewEntries(items, null);

  wrap.innerHTML = items.map((item) => `
    <button type="button" class="recent-item" data-path="${escapeAttr(item.path)}" data-type="${item.type}">
      <span class="recent-item-icon">${item.type === 'dir' ? '📁' : recentFileIcon(item.name)}</span>
      <span class="recent-item-info">
        <div class="recent-item-name">${escapeHtml(item.name)}</div>
        <div class="recent-item-meta">${escapeHtml(item.path)}${item.type === 'file' ? ' · ' + formatSize(item.size) : ''}</div>
      </span>
    </button>
  `).join('') + (truncated ? '<p class="settings-hint">Showing the first matches — narrow your search for more.</p>' : '');

  wrap.querySelectorAll('.recent-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const itemPath = btn.dataset.path;
      const item = items.find((i) => i.path === itemPath);
      if (item.type === 'dir') {
        state.filesPath = itemPath;
        clearFileSearch();
        renderFiles();
      } else if (previewType(item.name)) {
        openPreview(entries, itemPath);
      } else {
        window.open(api.downloadUrl(itemPath), '_blank', 'noopener');
      }
    });
  });
}

async function runFileSearch(query) {
  if (!query) {
    clearFileSearch();
    renderFiles();
    return;
  }
  try {
    const { items, truncated } = await api.searchFiles(query);
    renderSearchResults(items, query, truncated);
  } catch (err) {
    toast(err.message, true);
  }
}

el('fileSearchInput').addEventListener('input', (e) => {
  clearTimeout(fileSearchTimer);
  const query = e.target.value.trim();
  fileSearchTimer = setTimeout(() => runFileSearch(query), 300);
});

el('mkdirBtn').addEventListener('click', async () => {
  const name = prompt('New folder name:');
  if (!name) return;
  try {
    const target = state.filesPath ? `${state.filesPath}/${name}` : name;
    await api.mkdir(target);
    renderFiles();
  } catch (err) {
    toast(err.message, true);
  }
});

// file.webkitRelativePath is only populated for files picked through the
// folder input below (e.g. "Vacation2026/beach.jpg") — empty string for a
// normal file-picker or drag-drop selection, which keeps those landing
// flat in the current folder exactly as before this existed.
async function uploadFiles(files) {
  let uploaded = 0;
  for (const file of files) {
    try {
      await api.uploadFile(state.filesPath, file, file.webkitRelativePath || undefined);
      uploaded += 1;
    } catch (err) {
      toast(`${file.name}: ${err.message}`, true);
    }
  }
  if (uploaded) {
    renderFiles();
    toast(`Uploaded ${uploaded} file${uploaded === 1 ? '' : 's'}`);
  }
}

el('uploadBtn').addEventListener('click', () => el('uploadInput').click());
el('uploadInput').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length) await uploadFiles(files);
});

el('uploadFolderBtn').addEventListener('click', () => el('uploadFolderInput').click());
el('uploadFolderInput').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length) await uploadFiles(files);
});

const fileDrop = el('fileDrop');
['dragenter', 'dragover'].forEach((evt) =>
  fileDrop.addEventListener(evt, (e) => { e.preventDefault(); fileDrop.classList.add('drag-over'); })
);
['dragleave', 'drop'].forEach((evt) =>
  fileDrop.addEventListener(evt, (e) => { e.preventDefault(); fileDrop.classList.remove('drag-over'); })
);
fileDrop.addEventListener('drop', async (e) => {
  // Internal row-to-folder drags (see renderFilesListView) carry no real
  // OS files, just text data — dataTransfer.files is empty for those, so
  // this naturally no-ops instead of double-handling the drop.
  const files = Array.from(e.dataTransfer.files || []);
  if (files.length) await uploadFiles(files);
});

// ---------- Recently added files ----------

const recentModal = el('recentModal');

function recentFileIcon(name) {
  if (IMAGE_FILE_RE.test(name)) return '🖼️';
  if (/\.(mp3|wav|flac|ogg|m4a)$/i.test(name)) return '🎵';
  if (/\.(mp4|webm|mkv|mov|avi)$/i.test(name)) return '🎬';
  return '📄';
}

async function openRecentModal() {
  recentModal.classList.remove('hidden');
  const wrap = el('recentList');
  wrap.innerHTML = '<p class="settings-hint">Loading…</p>';
  try {
    const { items } = await api.getRecentUploads();
    if (!items.length) {
      wrap.innerHTML = '<p class="settings-hint">Nothing uploaded yet this session.</p>';
      return;
    }
    wrap.innerHTML = items.map((item) => {
      const folder = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : 'shared (root)';
      return `
        <button type="button" class="recent-item" data-path="${escapeAttr(item.path)}">
          <span class="recent-item-icon">${recentFileIcon(item.name)}</span>
          <span class="recent-item-info">
            <div class="recent-item-name">${escapeHtml(item.name)}</div>
            <div class="recent-item-meta">${escapeHtml(folder)} · ${formatSize(item.size)} · ${timeAgo(item.uploadedAt)}</div>
          </span>
        </button>
      `;
    }).join('');
    wrap.querySelectorAll('.recent-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const itemPath = btn.dataset.path;
        state.filesPath = itemPath.includes('/') ? itemPath.slice(0, itemPath.lastIndexOf('/')) : '';
        if (state.filesViewMode === 'tree') { state.filesViewMode = 'list'; setLocal('mc:filesView', 'list'); }
        closeRecentModal();
        el('filesLayoutSwitch').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.layout === state.filesViewMode));
        setFilesLayoutVisibility(state.filesViewMode);
        renderFiles();
      });
    });
  } catch (err) {
    wrap.innerHTML = `<p class="settings-hint">${escapeHtml(err.message)}</p>`;
  }
}

function closeRecentModal() {
  recentModal.classList.add('hidden');
}

el('openRecentBtn').addEventListener('click', openRecentModal);
el('closeRecentBtn').addEventListener('click', closeRecentModal);
recentModal.addEventListener('click', (e) => { if (e.target === recentModal) closeRecentModal(); });
