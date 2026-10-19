/**
 * The assistant's launcher. It is the only assistant code in the main bundle: the panel,
 * its styles and the voice services load on first use.
 */
export function initAssistant(loadCatalog: () => Promise<void>) {
  const launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.className = 'launch';
  launcher.setAttribute('aria-haspopup', 'dialog');
  launcher.setAttribute('aria-expanded', 'false');
  launcher.setAttribute('aria-controls', 'assistant-panel');
  launcher.innerHTML = `
    <svg class="launch__wire" viewBox="0 0 44 24" aria-hidden="true">
      <path class="launch__line" d="M5 8 Q22 22 39 8" />
      <path class="launch__pulse" d="M5 8 Q22 22 39 8" pathLength="100" />
      <rect class="launch__node" x="2" y="5" width="6" height="6" transform="rotate(45 5 8)" />
      <rect x="36" y="5" width="6" height="6" transform="rotate(45 39 8)" />
    </svg>
    <span class="launch__text"><b>Навигатор</b><span data-launch-hint>Спросить об опорах</span></span>
    <i class="launch__dot" aria-hidden="true"></i>`;
  document.body.appendChild(launcher);
  const hint = launcher.querySelector<HTMLElement>('[data-launch-hint]')!;

  let panel: Promise<ReturnType<typeof import('./panel').createPanel>> | null = null;
  const load = () =>
    (panel ??= import('./panel').then(m =>
      m.createPanel({
        launcher,
        loadCatalog,
        setUnread(on) {
          launcher.classList.toggle('has-unread', on);
          hint.textContent = on ? 'Есть новый ответ' : launcher.classList.contains('has-thread') ? 'Вернуться к диалогу' : 'Спросить об опорах';
        },
      }),
    ));

  // warm the chunk when the visitor shows intent, so the click opens at once
  launcher.addEventListener('pointerenter', () => void load(), { once: true });
  launcher.addEventListener('focus', () => void load(), { once: true });
  launcher.addEventListener('click', async () => {
    launcher.classList.add('is-loading');
    try {
      (await load()).open();
    } catch {
      panel = null;
      hint.textContent = 'Не удалось загрузить — нажмите ещё раз';
    } finally {
      launcher.classList.remove('is-loading');
    }
  });
  new MutationObserver(() => {
    if (!launcher.classList.contains('has-unread')) hint.textContent = launcher.classList.contains('has-thread') ? 'Вернуться к диалогу' : 'Спросить об опорах';
  }).observe(launcher, { attributes: true, attributeFilter: ['class'] });
}
