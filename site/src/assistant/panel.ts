import './assistant.css';
import { gsap, lockScroll } from '../core/smooth';
import { $, $$, finePointer, isNarrow, reducedMotion } from '../core/env';
import { applyDraft, describe, perform, type ActionContext } from './actions';
import { STATUS, createMachine, isBusy } from './machine';
import { renderInto, toPlain } from './markdown';
import { LIMITS, type ChatTurn, type InquiryDraft, type ServerEvent, type UiAction } from './protocol';
import { sendTurn } from './stream';
import { ICON, comparison, inquiryCard, productCard, productList } from './views';
import { LISTEN_MESSAGES, listen, speak, speakStream, stopSpeaking, voiceSupport, type Listener, type SpeechStream } from './voice';
import { createWire } from './wire';

export interface PanelDeps {
  launcher: HTMLButtonElement;
  loadCatalog(): Promise<void>;
  /** an answer arrived while the panel was minimized */
  setUnread(on: boolean): void;
}

interface Note {
  text: string;
}
interface Message {
  role: 'user' | 'assistant';
  text: string;
  /** what the interface really showed or did during this answer; sent back as context */
  notes: Note[];
  el: HTMLElement;
}

const SUGGESTIONS = ['Опоры на 110 кВ высотой до 30 м', 'Сравнить П110-2 и У110-2', 'Как защищают металл от коррозии?', 'Запросить расчёт поставки'];

const TEMPLATE = `
<header class="asst__head">
  <div class="asst__id">
    <h2 class="asst__title" id="asst-title">Навигатор</h2>
    <p class="asst__status"><i aria-hidden="true"></i><span data-status role="status" aria-live="polite">готов</span></p>
  </div>
  <button class="asst__tool" type="button" data-new aria-label="Новый диалог" title="Новый диалог">${ICON.fresh}</button>
  <button class="asst__tool" type="button" data-min aria-label="Свернуть ассистента" title="Свернуть">${ICON.min}</button>
</header>
<div class="asst__stage">
  <canvas class="asst__wire" data-wire aria-hidden="true"></canvas>
  <p class="asst__caption" data-caption></p>
</div>
<div class="asst__log" data-log data-lenis-prevent tabindex="0" role="log" aria-live="off" aria-label="Диалог с ассистентом">
  <div class="welcome" data-welcome>
    <p class="welcome__t">Спросите об опорах или&nbsp;о&nbsp;заводе</p>
    <p class="welcome__lead">Найду опору в каталоге, сравню характеристики, открою чертёж и подготовлю черновик заявки на расчёт.</p>
    <ul class="welcome__list">${SUGGESTIONS.map(s => `<li><button type="button" class="sug" data-suggest>${s}${ICON.arrow}</button></li>`).join('')}</ul>
  </div>
</div>
<button class="asst__jump" type="button" data-jump hidden>${ICON.down}<span>К последнему</span></button>
<div class="asst__tray" data-pick hidden>
  <p data-pick-text></p>
  <button type="button" class="chip chip--solid" data-pick-go>Сравнить</button>
  <button type="button" class="chip" data-pick-clear>Сбросить</button>
</div>
<p class="asst__notice" data-notice role="status" aria-live="polite"></p>
<p class="sr" data-announce role="status" aria-live="polite"></p>
<form class="asst__form" data-form-chat novalidate>
  <label class="sr" for="asst-input">Сообщение ассистенту</label>
  <textarea id="asst-input" rows="1" maxlength="${LIMITS.maxUserChars}" placeholder="Спросите об опорах" data-input enterkeyhint="send"></textarea>
  <button class="asst__btn" type="button" data-mic aria-label="Голосовой режим" title="Голосовой режим">${ICON.mic}</button>
  <button class="asst__btn asst__btn--send" type="submit" data-send aria-label="Отправить" disabled>${ICON.send}</button>
</form>
<div class="asst__voice" data-voice hidden>
  <button class="vbtn" type="button" data-voice-text>${ICON.keyboard}<span>Текст</span></button>
  <button class="vmic" type="button" data-voice-mic><span class="vmic__ic">${ICON.mic}</span><span data-voice-mic-label>Говорить</span></button>
  <button class="vbtn" type="button" data-voice-sound>${ICON.sound}<span data-voice-sound-label>Озвучка</span></button>
</div>
<p class="asst__fine" data-fine>Ответы строятся по каталогу сайта; характеристики уточняются при расчёте.</p>`;

export function createPanel(deps: PanelDeps) {
  document.getElementById('assistant-panel')?.remove(); // a previous attempt that failed half-way
  const panel = document.createElement('section');
  panel.className = 'asst';
  panel.id = 'assistant-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'asst-title');
  panel.dataset.state = 'idle';
  panel.dataset.mode = 'text';
  panel.innerHTML = TEMPLATE;
  document.body.appendChild(panel);

  const log = $('[data-log]', panel)!;
  const input = $<HTMLTextAreaElement>('[data-input]', panel)!;
  const sendBtn = $<HTMLButtonElement>('[data-send]', panel)!;
  const micBtn = $<HTMLButtonElement>('[data-mic]', panel)!;
  const statusEl = $('[data-status]', panel)!;
  const caption = $('[data-caption]', panel)!;
  const notice = $('[data-notice]', panel)!;
  const announcer = $('[data-announce]', panel)!;
  /** one spoken summary per finished event, for screen readers (the log itself is silent) */
  const announce = (text: string) => (announcer.textContent = text);
  const jump = $<HTMLButtonElement>('[data-jump]', panel)!;
  const tray = $('[data-pick]', panel)!;
  const voiceBar = $('[data-voice]', panel)!;
  const voiceMic = $<HTMLButtonElement>('[data-voice-mic]', panel)!;
  const voiceSound = $<HTMLButtonElement>('[data-voice-sound]', panel)!;
  const form = $<HTMLFormElement>('[data-form-chat]', panel)!;
  const wire = createWire($<HTMLCanvasElement>('[data-wire]', panel)!);
  const support = voiceSupport();
  // asking for the voice list starts loading it, so the first spoken answer does not wait for it
  if (support.speak) speechSynthesis.getVoices();

  const messages: Message[] = [];
  const selected = new Map<string, string>(); // slug → mark, chosen for comparison
  let open = false;
  let configured: boolean | null = null;
  let abort: AbortController | null = null;
  let listener: Listener | null = null;
  let speakReplies = true;
  /** the voice reading the current answer while it is being written (voice mode only) */
  let talk: SpeechStream | null = null;
  let statusOverride = '';

  // ── state ────────────────────────────────────────────────
  const machine = createMachine(state => {
    panel.dataset.state = state;
    wire.setState(state);
    if (state !== 'processing') statusOverride = '';
    syncControls();
  });
  const setStatus = (text = '') => {
    statusOverride = text;
    syncControls();
  };
  const setNotice = (text = '') => (notice.textContent = text);
  const setCaption = (text = '') => (caption.textContent = text);

  function syncControls() {
    const state = machine.state;
    const busy = isBusy(state);
    statusEl.textContent = configured === false ? 'не подключён' : statusOverride || STATUS[state];
    const off = configured === false;
    input.disabled = off;
    if (sendBtn.classList.contains('is-stop') !== busy) sendBtn.innerHTML = busy ? ICON.stop : ICON.send;
    sendBtn.setAttribute('aria-label', busy ? 'Остановить ответ' : 'Отправить');
    sendBtn.type = busy ? 'button' : 'submit';
    sendBtn.disabled = off || (!busy && !input.value.trim());
    sendBtn.classList.toggle('is-stop', busy);
    micBtn.disabled = off || !support.listen || busy;
    micBtn.title = support.listen ? 'Голосовой режим' : 'Этот браузер не распознаёт речь';
    micBtn.setAttribute('aria-label', micBtn.title);
    const hearing = state === 'listening' || state === 'transcribing';
    voiceMic.disabled = off || busy || !support.listen;
    voiceMic.classList.toggle('is-on', hearing);
    $('[data-voice-mic-label]', voiceMic)!.textContent = hearing ? 'Готово' : state === 'speaking' ? 'Перебить' : busy ? 'Ждите ответа' : 'Говорить';
    const speaking = state === 'speaking';
    voiceSound.disabled = !support.speak;
    voiceSound.classList.toggle('is-stop', speaking);
    voiceSound.classList.toggle('is-on', speaking || speakReplies);
    $('[data-voice-sound-label]', voiceSound)!.textContent = !support.speak ? 'Нет озвучки' : speaking ? 'Стоп' : speakReplies ? 'Озвучка' : 'Без звука';
    $$('[data-speak] span', panel).forEach(n => (n.textContent = speaking ? 'Остановить' : 'Озвучить'));
    $$<HTMLButtonElement>('[data-suggest], [data-pc-inquiry], [data-pc-compare], [data-pick-go], [data-retry]', panel).forEach(b => (b.disabled = off || busy));
  }

  // ── log ──────────────────────────────────────────────────
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 90;
  let stick = true;
  const toBottom = (smooth = false) => log.scrollTo({ top: log.scrollHeight, behavior: smooth && !reducedMotion ? 'smooth' : 'auto' });
  const follow = () => {
    if (stick) toBottom();
    else jump.hidden = false;
  };
  log.addEventListener(
    'scroll',
    () => {
      stick = nearBottom();
      if (stick) jump.hidden = true;
    },
    { passive: true },
  );
  jump.addEventListener('click', () => {
    stick = true;
    jump.hidden = true;
    toBottom(true);
  });

  function addUser(text: string) {
    $('[data-welcome]', panel)?.remove();
    const el = document.createElement('div');
    el.className = 'msg msg--u';
    el.innerHTML = '<p><span class="sr">Вы: </span><span></span></p>';
    el.querySelector('p > span:last-child')!.textContent = text;
    log.appendChild(el);
    messages.push({ role: 'user', text, notes: [], el });
    stick = true;
    toBottom();
  }

  /** The answer being built: text segments and rich blocks in the order they arrive. */
  function addAssistant() {
    const el = document.createElement('div');
    el.className = 'msg msg--a';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Ответ ассистента');
    el.innerHTML = '<div class="msg__wait" data-wait><i></i><i></i><i></i><span></span></div>';
    log.appendChild(el);
    const message: Message = { role: 'assistant', text: '', notes: [], el };
    messages.push(message);
    let segment: HTMLElement | null = null;
    let segmentText = '';
    let frame = 0;
    const paint = () => {
      frame = 0;
      if (segment) renderInto(segment, segmentText);
      follow();
    };
    const wait = (label: string | null) => {
      const node = $('[data-wait]', el);
      if (label === null) return node?.remove();
      if (node) $('span', node)!.textContent = label;
      else {
        el.insertAdjacentHTML('beforeend', '<div class="msg__wait" data-wait><i></i><i></i><i></i><span></span></div>');
        $('[data-wait] span', el)!.textContent = label;
      }
    };
    return {
      message,
      el,
      wait,
      /** the server withdrew the text of this answer: remove it, keep the cards and actions */
      retract() {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        $$('.msg__text', el).forEach(n => n.remove());
        segment = null;
        segmentText = '';
        message.text = '';
      },
      /** a new model round: later text starts its own block */
      breakText() {
        if (frame) {
          cancelAnimationFrame(frame);
          paint();
        }
        segment?.classList.remove('is-live');
        segment = null;
      },
      text(delta: string) {
        wait(null);
        if (!segment) {
          segment = document.createElement('div');
          segment.className = 'msg__text is-live';
          el.appendChild(segment);
          segmentText = '';
          if (message.text) message.text += '\n\n';
        }
        segmentText += delta;
        message.text += delta;
        frame ||= requestAnimationFrame(paint);
      },
      block(html: string, note?: string) {
        wait(null);
        segment?.classList.remove('is-live');
        if (segment && frame) {
          cancelAnimationFrame(frame);
          paint();
        }
        segment = null;
        const box = document.createElement('div');
        box.className = 'msg__block';
        box.innerHTML = html;
        el.appendChild(box);
        const n = note ? { text: note } : null;
        if (n) message.notes.push(n);
        follow();
        return { box, note: n };
      },
      end() {
        wait(null);
        if (frame) {
          cancelAnimationFrame(frame);
          paint();
        }
        segment?.classList.remove('is-live');
        segment = null;
        if (message.text.trim()) {
          const tools = document.createElement('div');
          tools.className = 'msg__tools';
          tools.innerHTML = `<button type="button" data-copy>${ICON.copy}<span>Копировать</span></button>${support.speak ? `<button type="button" data-speak>${ICON.sound}<span>Озвучить</span></button>` : ''}`;
          el.appendChild(tools);
        }
        follow();
      },
    };
  }

  /** Conversation context for the server: recent turns, with the interface's own notes attached. */
  function history(): ChatTurn[] {
    const turns: ChatTurn[] = [];
    for (const m of messages) {
      const content = (m.role === 'user' ? m.text : [m.text.trim(), ...m.notes.map(n => `[${n.text}]`)].filter(Boolean).join('\n')).slice(0, m.role === 'user' ? LIMITS.maxUserChars : LIMITS.maxAssistantChars);
      if (content) turns.push({ role: m.role, content });
    }
    let recent = turns.slice(-16);
    while (recent.length && recent[0].role !== 'user') recent = recent.slice(1);
    while (recent.reduce((n, t) => n + t.content.length, 0) > LIMITS.maxTotalChars - 2000 && recent.length > 1) {
      recent = recent.slice(1);
      while (recent.length && recent[0].role !== 'user') recent = recent.slice(1);
    }
    return recent;
  }

  // ── a turn ───────────────────────────────────────────────
  const ctx: ActionContext = { loadCatalog: deps.loadCatalog, minimize: () => close(), covers: isNarrow };

  async function runAction(action: UiAction, view: ReturnType<typeof addAssistant>) {
    const { box, note } = view.block(`<p class="act is-pending"><i></i><span></span></p>`, `Действие «${describe(action)}» — выполняется`);
    const row = $('.act', box)!;
    $('span', row)!.textContent = `${describe(action)} — выполняется`;
    const result = await perform(action, ctx);
    row.classList.remove('is-pending');
    row.classList.add(result.ok ? 'is-ok' : 'is-fail');
    $('i', row)!.innerHTML = result.ok ? ICON.ok : ICON.fail;
    $('span', row)!.textContent = result.ok ? `${result.label} — выполнено` : `${result.label} — не удалось выполнить`;
    announce($('span', row)!.textContent ?? '');
    if (note) note.text = `Действие «${result.label}» — ${result.ok ? 'выполнено на странице' : 'НЕ выполнено: страница не смогла его выполнить'}`;
  }

  function onEvent(event: ServerEvent, view: ReturnType<typeof addAssistant>) {
    switch (event.t) {
      case 'status':
        view.breakText();
        machine.send('WORKING');
        setStatus(event.phase === 'tool' && event.label ? event.label.toLowerCase() : '');
        if (!view.message.text || event.phase === 'tool') view.wait(event.phase === 'tool' && event.label ? event.label : 'Обрабатываю запрос');
        follow();
        break;
      case 'retract':
        view.retract();
        talk?.reset(); // what was withdrawn must not go on being said
        break;
      case 'text':
        machine.send('FIRST_TEXT');
        view.text(event.d);
        talk?.push(event.d);
        wire.pluck(event.d.length / 14);
        break;
      case 'products':
        view.block(productList(event.items, event.total, s => selected.has(s)), event.items.length ? `Показаны карточки: ${event.items.map(i => i.mark).join(', ')}${event.total > event.items.length ? ` (из ${event.total} найденных)` : ''}` : 'Поиск по каталогу ничего не нашёл');
        break;
      case 'details':
        view.block(productCard(event.item, selected.has(event.item.slug)), `Показана карточка с характеристиками: ${event.item.mark}`);
        break;
      case 'compare':
        view.block(comparison(event.items, event.rows), `Показана таблица сравнения: ${event.items.map(i => i.mark).join(', ')}`);
        break;
      case 'action':
        void runAction(event.action, view);
        break;
      case 'inquiry': {
        const { box, note } = view.block(inquiryCard(event.draft), 'Показан черновик заявки; пользователь его пока не подтвердил');
        (box as HTMLElement & { draft?: InquiryDraft; note?: Note | null }).draft = event.draft;
        (box as HTMLElement & { note?: Note | null }).note = note;
        break;
      }
      case 'done':
        if (event.stop === 'max_tokens') view.block('<p class="msg__meta">Ответ обрезан по длине. Задайте вопрос уже — отвечу точнее.</p>', 'Ответ был обрезан по длине');
        else if (event.stop === 'refusal') view.block('<p class="msg__meta">С этим запросом помочь не могу. Спросите об опорах, каталоге или компании.</p>', 'Ассистент отказался отвечать на этот запрос');
        else if (event.stop === 'limit') view.block('<p class="msg__meta">Остановился: запрос потребовал слишком много шагов. Уточните вопрос.</p>', 'Ответ остановлен по лимиту шагов');
        break;
      case 'error':
        break; // reported once, by the turn result below
    }
  }

  async function submit(raw: string) {
    const text = raw.trim().slice(0, LIMITS.maxUserChars);
    if (!text || isBusy(machine.state) || configured === false) return;
    stopSpeaking();
    listener?.cancel();
    setNotice();
    // a retry offer belongs to the turn that failed: once a new one starts it is withdrawn
    $$('[data-retry]', panel).forEach(b => b.remove());
    addUser(text);
    const view = addAssistant();
    abort = new AbortController();
    const mine = abort;
    machine.send('SUBMIT');
    view.wait('Обрабатываю запрос');
    // in voice mode the answer is read out as it is written, sentence by sentence
    talk = open && panel.dataset.mode === 'voice' && speakReplies && support.speak && !listener ? startTalk() : null;
    const myTalk = talk;
    const result = await sendTurn(history(), { signal: mine.signal, onEvent: e => onEvent(e, view) });
    if (abort === mine) abort = null;
    // the dialog was reset while this turn was in flight: it no longer owns the interface
    if (!messages.includes(view.message)) return void myTalk?.stop();
    view.end();
    const empty = result.ok && !view.message.text.trim() && !view.message.notes.length && !$('.msg__block', view.el);
    if (!result.ok || empty) myTalk?.stop();
    if (empty) {
      fail(view, 'Ответ пришёл пустым. Попробуйте переформулировать вопрос.');
    } else if (result.ok) {
      machine.send('DONE');
      announce(`Ответ ассистента: ${toPlain(view.message.text).slice(0, 220) || 'показаны данные из каталога'}`);
      if (!open) deps.setUnread(true);
      if (myTalk?.active) {
        myTalk.end();
        // the text is complete but the voice is still reading: the state says so
        if (myTalk.active) machine.send('SPEAK_START');
      }
    } else if (result.aborted) {
      machine.send('CANCEL');
      view.block('<p class="msg__meta">Ответ остановлен.</p>', 'Пользователь остановил ответ');
    } else {
      if (result.code === 'not_configured') {
        configured = false;
        showOffline();
      }
      fail(view, result.message);
    }
    const here = panel.contains(document.activeElement) || document.activeElement === document.body;
    if (open && finePointer && panel.dataset.mode === 'text' && here) input.focus({ preventScroll: true });
  }

  function fail(view: ReturnType<typeof addAssistant>, message: string) {
    machine.send('FAIL');
    const partial = view.message.text.trim() !== '' || !!$('.msg__block', view.el);
    const box = document.createElement('div');
    box.className = 'msg__error';
    box.setAttribute('role', 'alert');
    box.innerHTML = `<p></p>${configured === false ? '' : '<button type="button" class="chip" data-retry>Повторить</button>'}`;
    box.firstElementChild!.textContent = partial ? `${message} Часть ответа выше может быть неполной.` : message;
    view.el.appendChild(box);
    view.message.notes.push({ text: 'Ответ не был получен полностью из-за ошибки' });
    follow();
    syncControls();
  }

  function retry() {
    if (isBusy(machine.state)) return;
    // drop the failed answer and its question from the log, then ask again
    const failed = messages.pop();
    failed?.el.remove();
    const question = messages.pop();
    question?.el.remove();
    machine.send('RESET');
    if (question?.role === 'user') void submit(question.text);
  }

  // ── voice ────────────────────────────────────────────────
  function startTalk(): SpeechStream {
    const s: SpeechStream = speakStream({
      // while the answer is still streaming the state stays "responding"; it becomes
      // "speaking" when the text is complete and the voice is still going (see submit)
      onStart: () => {
        if (machine.state === 'idle') machine.send('SPEAK_START');
      },
      onWord: length => wire.pluck(0.35 + length / 14),
      onEnd(reason) {
        if (talk === s) talk = null;
        if (machine.state === 'speaking') machine.send('SPEAK_END');
        if (reason === 'no-voice') setNotice('В браузере нет русского голоса — ответ показан только текстом.');
        else if (reason === 'failed') setNotice('Не удалось озвучить ответ — он показан текстом.');
        syncControls();
      },
    });
    return s;
  }

  function say(text: string) {
    if (!support.speak || isBusy(machine.state) || listener) return;
    speak(text, {
      onStart: () => machine.send('SPEAK_START'),
      onWord: length => wire.pluck(0.35 + length / 14),
      onEnd(reason) {
        machine.send('SPEAK_END');
        if (reason === 'no-voice') setNotice('В браузере нет русского голоса — ответ показан только текстом.');
        else if (reason === 'failed') setNotice('Не удалось озвучить ответ — он показан текстом.');
      },
    });
  }

  function startListening() {
    if (listener || isBusy(machine.state) || !support.listen) return;
    stopSpeaking();
    setNotice();
    setCaption('Жду доступа к микрофону…');
    let ended = false;
    const started = listen({
      onStart(analyser) {
        machine.send('LISTEN_START');
        wire.setAnalyser(analyser);
        setCaption('Говорите — я слушаю');
        if (!analyser) setNotice('Микрофон включён. Форма сигнала в этом браузере недоступна, поэтому провод неподвижен.');
      },
      onInterim: text => setCaption(text),
      onSpeechEnd: () => machine.send('SPEECH_END'),
      onEnd(result) {
        ended = true;
        listener = null;
        wire.setAnalyser(null);
        if ('error' in result) {
          machine.send(result.error === 'no-speech' ? 'LISTEN_CANCEL' : 'LISTEN_FAIL');
          setCaption(LISTEN_MESSAGES[result.error]);
          announce(LISTEN_MESSAGES[result.error]);
        } else if (result.text && configured !== false) {
          setCaption(result.text);
          void submit(result.text);
        } else {
          machine.send('LISTEN_CANCEL');
          setCaption('Микрофон выключен');
        }
        syncControls();
      },
    });
    // recognition can fail before this call returns: do not keep a finished listener
    listener = ended ? null : started;
    syncControls();
  }

  function setMode(mode: 'text' | 'voice') {
    if (panel.dataset.mode === mode) return;
    panel.dataset.mode = mode;
    form.hidden = mode === 'voice';
    voiceBar.hidden = mode === 'text';
    if (mode === 'text') {
      listener?.cancel();
      stopSpeaking();
      setCaption();
      setNotice();
      if (finePointer) input.focus({ preventScroll: true });
    } else {
      setCaption('Нажмите «Говорить» и задайте вопрос');
      voiceMic.focus({ preventScroll: true });
    }
    // the stage changes height: refit the canvas while it moves, then once more at rest
    const until = performance.now() + 420;
    const refit = () => {
      wire.resize();
      if (performance.now() < until) requestAnimationFrame(refit);
      else toBottom();
    };
    refit();
  }

  micBtn.addEventListener('click', () => {
    setMode('voice');
    startListening();
  });
  voiceMic.addEventListener('click', () => {
    if (listener) listener.stop();
    else startListening();
  });
  $('[data-voice-text]', panel)!.addEventListener('click', () => setMode('text'));
  voiceSound.addEventListener('click', () => {
    if (machine.state === 'speaking' || talk?.active) stopSpeaking();
    else speakReplies = !speakReplies;
    syncControls();
  });

  // ── input ────────────────────────────────────────────────
  const grow = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
  };
  input.addEventListener('input', () => {
    grow();
    syncControls();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', e => {
    e.preventDefault();
    if (isBusy(machine.state)) return;
    const text = input.value;
    if (!text.trim()) return;
    input.value = '';
    grow();
    void submit(text);
  });
  sendBtn.addEventListener('click', () => {
    if (isBusy(machine.state)) abort?.abort();
  });

  // ── delegated clicks inside the log ──────────────────────
  const renderTray = () => {
    const marks = [...selected.values()];
    tray.hidden = !marks.length;
    $('[data-pick-text]', tray)!.textContent = marks.length < 2 ? `${marks.join(', ')} — выберите ещё одну опору` : marks.join(', ');
    $<HTMLButtonElement>('[data-pick-go]', tray)!.hidden = marks.length < 2;
    $$('.pc', log).forEach(card => {
      const on = selected.has(card.dataset.slug!);
      $('[data-pc-compare]', card)?.setAttribute('aria-pressed', String(on));
    });
  };
  $('[data-pick-clear]', tray)!.addEventListener('click', () => {
    selected.clear();
    renderTray();
  });
  $('[data-pick-go]', tray)!.addEventListener('click', () => {
    const marks = [...selected.values()];
    selected.clear();
    renderTray();
    void submit(`Сравните опоры ${marks.join(', ')}`);
  });

  log.addEventListener('click', async e => {
    const target = e.target as Element;
    const btn = target.closest<HTMLButtonElement>('button');
    if (!btn) return;
    const card = btn.closest<HTMLElement>('.pc');
    if (btn.matches('[data-suggest]')) return void submit(btn.textContent ?? '');
    if (btn.matches('[data-retry]')) return retry();
    if (card && btn.matches('[data-pc-open]')) {
      const action: UiAction = { kind: 'open_tower', slug: card.dataset.slug!, mark: card.dataset.mark! };
      const result = await perform(action, ctx);
      if (!result.ok) setNotice(`Не удалось открыть лист ${action.mark}.`);
      return;
    }
    if (card && btn.matches('[data-pc-compare]')) {
      const slug = card.dataset.slug!;
      if (selected.has(slug)) selected.delete(slug);
      else {
        if (selected.size >= 3) selected.delete(selected.keys().next().value!);
        selected.set(slug, card.dataset.mark!);
      }
      return renderTray();
    }
    if (card && btn.matches('[data-pc-inquiry]')) return void submit(`Подготовьте заявку на расчёт: опора ${card.dataset.mark}`);
    if (btn.matches('[data-cmp-page]')) {
      const box = btn.closest<HTMLElement>('.cmpc')!;
      const result = await perform({ kind: 'compare', slugs: box.dataset.slugs!.split(','), marks: box.dataset.marks!.split('|') }, ctx);
      if (!result.ok) setNotice('Не удалось открыть сравнение на странице.');
      return;
    }
    const inq = btn.closest<HTMLElement & { draft?: InquiryDraft; note?: Note | null }>('.msg__block');
    if (inq?.draft && btn.matches('[data-inq-apply], [data-inq-cancel]')) {
      const hint = $('[data-inq-hint]', inq)!;
      const apply = btn.matches('[data-inq-apply]');
      // one decision per draft: both buttons are spent, so it cannot be applied twice
      $$<HTMLButtonElement>('[data-inq-apply], [data-inq-cancel]', inq).forEach(b => b.remove());
      const card = $('.inq', inq)!;
      hint.tabIndex = -1;
      if (!apply) {
        hint.focus({ preventScroll: true });
        card.classList.add('is-off');
        hint.textContent = 'Черновик отменён. В форму ничего не перенесено.';
        if (inq.note) inq.note.text = 'Пользователь отменил черновик заявки';
        return;
      }
      const ok = applyDraft(inq.draft, ctx);
      card.classList.add(ok ? 'is-done' : 'is-off');
      if (!ok) hint.focus({ preventScroll: true });
      hint.textContent = ok ? 'Перенесено в форму. Укажите имя и телефон и нажмите «Отправить запрос» — заявку отправляете вы.' : 'Не удалось найти форму заявки на странице. Позвоните: +7 777 684 60 70.';
      if (inq.note) inq.note.text = ok ? 'Пользователь перенёс черновик в форму заявки на сайте; заявка ещё не отправлена — её отправляет сам пользователь' : 'Перенести черновик в форму не удалось';
      return;
    }
    if (btn.matches('[data-copy], [data-speak]')) {
      const message = messages.find(m => m.el === btn.closest('.msg'));
      if (!message) return;
      if (btn.matches('[data-speak]')) return machine.state === 'speaking' ? stopSpeaking() : say(message.text);
      const label = $('span', btn)!;
      try {
        await navigator.clipboard.writeText(toPlain(message.text));
        label.textContent = 'Скопировано';
        announce('Ответ скопирован');
      } catch {
        label.textContent = 'Не удалось скопировать';
      }
      setTimeout(() => (label.textContent = 'Копировать'), 1600);
    }
  });

  // ── header ───────────────────────────────────────────────
  $('[data-min]', panel)!.addEventListener('click', () => close());
  $('[data-new]', panel)!.addEventListener('click', () => {
    abort?.abort();
    listener?.cancel();
    stopSpeaking();
    messages.splice(0).forEach(m => m.el.remove());
    selected.clear();
    renderTray();
    setNotice();
    machine.send('RESET');
    if (!$('[data-welcome]', panel)) {
      log.insertAdjacentHTML('afterbegin', `<div class="welcome" data-welcome><p class="welcome__t">Спросите об опорах или&nbsp;о&nbsp;заводе</p><p class="welcome__lead">Найду опору в каталоге, сравню характеристики, открою чертёж и подготовлю черновик заявки на расчёт.</p><ul class="welcome__list">${SUGGESTIONS.map(s => `<li><button type="button" class="sug" data-suggest>${s}${ICON.arrow}</button></li>`).join('')}</ul></div>`);
    }
    if (configured === false) showOffline();
    syncControls();
  });

  panel.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (listener) listener.cancel();
      else close();
    } else if (e.key === 'Tab' && isNarrow()) {
      // full-screen on phones: keep focus inside
      const f = $$<HTMLElement>('button:not([disabled]), textarea:not([disabled]), [tabindex="0"]', panel).filter(n => n.offsetParent !== null);
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
    }
  });

  // ── availability ─────────────────────────────────────────
  function showOffline() {
    const welcome = $('[data-welcome]', panel);
    if (welcome && !$('.welcome__off', welcome)) {
      welcome.insertAdjacentHTML('afterbegin', '<p class="welcome__off" role="status">Ассистент ещё не подключён к языковой модели, поэтому отвечать не может. Каталог и форма заявки на сайте работают как обычно.</p>');
    }
    syncControls();
  }
  async function checkAvailability() {
    if (configured !== null) return;
    try {
      const res = await fetch('/api/chat', { headers: { Accept: 'application/json' } });
      const body = res.ok ? await res.json() : null;
      configured = body?.configured === true ? true : body?.configured === false ? false : null;
    } catch {
      configured = null; // unknown: the first message will report the real error
    }
    if (configured === false) showOffline();
    syncControls();
  }

  // ── open / close ─────────────────────────────────────────
  const vv = window.visualViewport;
  const inerted: HTMLElement[] = [];
  const fitViewport = () => {
    if (!vv) return;
    panel.style.setProperty('--vvh', `${vv.height}px`);
    panel.style.setProperty('--vvt', `${vv.offsetTop}px`);
    if (stick) toBottom();
  };
  const overlayOpen = () => $$('[data-sheet], [data-cmp]').some(n => !n.hidden);
  const insetFrom = () => {
    const l = deps.launcher.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const c = (n: number) => Math.max(0, n);
    return `inset(${c(l.top - p.top)}px ${c(p.right - l.right)}px ${c(p.bottom - l.bottom)}px ${c(l.left - p.left)}px)`;
  };
  const parts = () => $$('.asst__head, .asst__stage, .asst__log, .asst__form, .asst__voice, .asst__fine', panel).filter(n => !n.hidden);

  function openPanel() {
    if (open) return;
    open = true;
    gsap.killTweensOf([panel, ...parts()]);
    panel.hidden = false;
    panel.setAttribute('aria-modal', String(isNarrow()));
    deps.launcher.setAttribute('aria-expanded', 'true');
    deps.launcher.classList.add('is-open');
    deps.setUnread(false);
    if (isNarrow()) {
      lockScroll(true);
      for (const n of document.body.children) {
        if (n !== panel && n instanceof HTMLElement && n.tagName !== 'SCRIPT' && !n.inert) {
          n.inert = true;
          inerted.push(n);
        }
      }
    }
    fitViewport();
    vv?.addEventListener('resize', fitViewport);
    vv?.addEventListener('scroll', fitViewport);
    wire.resize();
    wire.wake();
    void checkAvailability();
    if (reducedMotion) gsap.fromTo(panel, { opacity: 0 }, { opacity: 1, duration: 0.15, clearProps: 'opacity' });
    else {
      // the panel unfolds out of the launcher's own rectangle
      gsap.fromTo(panel, { clipPath: insetFrom() }, { clipPath: 'inset(0px 0px 0px 0px)', duration: 0.42, ease: 'expo.out', clearProps: 'clipPath' });
      gsap.fromTo(parts(), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.3, ease: 'power3.out', stagger: 0.035, delay: 0.08, clearProps: 'opacity,transform' });
    }
    toBottom();
    if (finePointer && panel.dataset.mode === 'text' && configured !== false) input.focus({ preventScroll: true });
    else $<HTMLElement>('[data-min]', panel)!.focus({ preventScroll: true });
  }

  function close() {
    if (!open) return;
    open = false;
    // nothing keeps listening or talking behind a closed panel; a running answer continues
    listener?.cancel();
    stopSpeaking();
    vv?.removeEventListener('resize', fitViewport);
    vv?.removeEventListener('scroll', fitViewport);
    inerted.splice(0).forEach(n => (n.inert = false));
    deps.launcher.setAttribute('aria-expanded', 'false');
    deps.launcher.classList.toggle('has-thread', messages.length > 0);
    // the launcher is back at once: the panel folds into it, and it can take focus
    deps.launcher.classList.remove('is-open');
    if (!overlayOpen()) lockScroll(false);
    const done = () => {
      panel.hidden = true;
      gsap.set(panel, { clearProps: 'clipPath,opacity' });
    };
    const hadFocus = panel.contains(document.activeElement);
    gsap.killTweensOf([panel, ...parts()]);
    if (reducedMotion) gsap.to(panel, { opacity: 0, duration: 0.12, onComplete: done });
    else gsap.to(panel, { clipPath: insetFrom(), duration: 0.24, ease: 'power3.inOut', onComplete: done });
    // over the product sheet or the comparison, focus goes back into that dialog
    const overlay = $$('[data-sheet], [data-cmp]').find(n => !n.hidden);
    const back = (overlay && $<HTMLElement>('[data-sheet-close], [data-cmp-close]', overlay)) || deps.launcher;
    if (hadFocus) back.focus({ preventScroll: true });
  }

  new ResizeObserver(() => open && wire.resize()).observe($('[data-wire]', panel)!);
  syncControls();

  return {
    open: openPanel,
    close,
    toggle: () => (open ? close() : openPanel()),
    get isOpen() {
      return open;
    },
  };
}
