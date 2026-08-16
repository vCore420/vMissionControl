const form = document.getElementById('loginForm');
const errorEl = document.getElementById('loginError');

// If there's no protection to log into (or a session already covers this
// browser), there's nothing for this page to do — send straight through
// rather than making someone type a password that doesn't exist.
fetch('/api/auth/status')
  .then((r) => r.json())
  .then(({ enabled, authenticated }) => {
    if (!enabled || authenticated) window.location.replace('/');
  })
  .catch(() => {});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.classList.add('hidden');
  const password = form.elements.password.value;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || 'sign in failed');
    window.location.replace('/');
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
    form.elements.password.value = '';
    form.elements.password.focus();
  }
});
