/** Theme toggle: follows the OS until a choice is made, then remembers it. */
export function initThemeToggle(): void {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const current = (): 'light' | 'dark' => {
    const set = root.dataset.theme;
    return set === 'light' || set === 'dark' ? set : media.matches ? 'dark' : 'light';
  };
  const label = () => btn.setAttribute('aria-label', `Switch to ${current() === 'dark' ? 'light' : 'dark'} theme`);

  btn.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    const apply = () => {
      root.dataset.theme = next;
      label();
    };
    try {
      localStorage.setItem('theme', next);
    } catch {
      /* private mode or blocked storage: the choice lasts for this page view */
    }
    if (document.startViewTransition && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      document.startViewTransition(apply);
    } else apply();
  });
  media.addEventListener('change', label);
  label();
}
