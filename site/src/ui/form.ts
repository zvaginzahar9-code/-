import { $ } from '../core/env';

/**
 * Request form. The presentation gives only a phone number, so by default the form
 * assembles the request and offers to call or copy it. To deliver requests automatically,
 * set `data-endpoint` on the form to a POST URL that accepts JSON (see README).
 */
export function initForm() {
  const form = $<HTMLFormElement>('[data-form]');
  const status = $('[data-form-status]');
  if (!form || !status) return;
  const PHONE = '+77776846070';

  form.addEventListener('submit', async e => {
    e.preventDefault();
    let ok = true;
    for (const name of ['name', 'phone']) {
      const input = form.elements.namedItem(name) as HTMLInputElement;
      const bad = !input.value.trim() || (name === 'phone' && input.value.replace(/\D/g, '').length < 10);
      input.closest('.field')!.classList.toggle('is-error', bad);
      if (bad && ok) input.focus();
      ok &&= !bad;
    }
    if (!ok) {
      status.textContent = 'Укажите имя и телефон — по ним мы свяжемся с вами.';
      return;
    }
    const data = Object.fromEntries(new FormData(form)) as Record<string, string>;
    const text = `Запрос расчёта поставки\nИмя: ${data.name}\nКомпания: ${data.company || '—'}\nТелефон: ${data.phone}\n${data.message ? 'Задача: ' + data.message : ''}`;
    const endpoint = form.dataset.endpoint;
    if (endpoint) {
      status.textContent = 'Отправляем…';
      try {
        const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        if (!r.ok) throw new Error(String(r.status));
        status.textContent = 'Запрос отправлен. Мы свяжемся с вами по указанному телефону.';
        form.reset();
        return;
      } catch {
        status.textContent = 'Не удалось отправить запрос. Позвоните нам или скопируйте текст запроса.';
      }
    }
    status.innerHTML = '';
    const call = document.createElement('a');
    call.href = `tel:${PHONE}`;
    call.textContent = 'Позвонить +7 777 684 60 70';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'скопировать текст запроса';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = 'текст скопирован';
      } catch {
        copy.textContent = 'не удалось скопировать';
      }
    });
    status.append('Запрос подготовлен. ', call, ' или ', copy, '.');
  });
}

/** Prefill the request with tower marks chosen in the catalogue. */
export function prefillRequest(marks: string[]) {
  const ta = $<HTMLTextAreaElement>('[data-form-message]');
  if (!ta) return;
  const line = `Опоры: ${marks.join(', ')} — количество: `;
  if (!ta.value.includes(line)) ta.value = (ta.value ? ta.value + '\n' : '') + line;
}
