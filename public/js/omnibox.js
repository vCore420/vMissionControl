import { state, el, escapeHtml, groupById } from './core.js';

// The "/" quick-launch command palette — jumps straight to any service in
// a new tab. Fully self-contained: nothing outside this module calls into
// it, and it only reads from core.js's shared state.

const omniboxModal = el('omniboxModal');
const omniboxInput = el('omniboxInput');
const omniboxResultsEl = el('omniboxResults');
let omniboxResults = [];
let omniboxSelectedIndex = 0;

function openOmnibox() {
  omniboxInput.value = '';
  renderOmniboxResults('');
  omniboxModal.classList.remove('hidden');
  omniboxInput.focus();
}

function closeOmnibox() {
  omniboxModal.classList.add('hidden');
}

function renderOmniboxResults(query) {
  const q = query.trim().toLowerCase();
  omniboxResults = state.config.services
    .filter((s) => !q || `${s.name} ${(s.tags || []).join(' ')} ${s.url}`.toLowerCase().includes(q))
    .slice(0, 8);
  omniboxSelectedIndex = 0;

  if (omniboxResults.length === 0) {
    omniboxResultsEl.innerHTML = '<div class="omnibox-empty">No matches</div>';
    return;
  }

  omniboxResultsEl.innerHTML = omniboxResults.map((s, i) => {
    const group = groupById(s.group);
    return `
      <div class="omnibox-result ${i === 0 ? 'active' : ''}" data-index="${i}">
        <span class="omnibox-icon">${s.icon || '🔗'}</span>
        <span class="omnibox-name">${escapeHtml(s.name)}</span>
        <span class="omnibox-url">${escapeHtml(s.url)}</span>
        ${group ? `<span class="card-group-badge" style="background:${group.color}22;color:${group.color}">${escapeHtml(group.name)}</span>` : ''}
      </div>
    `;
  }).join('');

  omniboxResultsEl.querySelectorAll('.omnibox-result').forEach((row) => {
    row.addEventListener('click', () => openOmniboxSelection(Number(row.dataset.index)));
  });
}

function updateOmniboxSelection() {
  const rows = omniboxResultsEl.querySelectorAll('.omnibox-result');
  rows.forEach((row, i) => row.classList.toggle('active', i === omniboxSelectedIndex));
  rows[omniboxSelectedIndex]?.scrollIntoView({ block: 'nearest' });
}

function openOmniboxSelection(index) {
  const service = omniboxResults[index];
  if (!service) return;
  window.open(service.url, '_blank', 'noopener');
  closeOmnibox();
}

omniboxInput.addEventListener('input', (e) => renderOmniboxResults(e.target.value));

omniboxInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    omniboxSelectedIndex = Math.min(omniboxSelectedIndex + 1, omniboxResults.length - 1);
    updateOmniboxSelection();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    omniboxSelectedIndex = Math.max(omniboxSelectedIndex - 1, 0);
    updateOmniboxSelection();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    openOmniboxSelection(omniboxSelectedIndex);
  } else if (e.key === 'Escape') {
    closeOmnibox();
  }
});

omniboxModal.addEventListener('click', (e) => {
  if (e.target === omniboxModal) closeOmnibox();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== '/') return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (document.querySelector('.modal:not(.hidden)')) return;
  e.preventDefault();
  openOmnibox();
});
