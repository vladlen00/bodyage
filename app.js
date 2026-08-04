// Возраст тела - экраны, плеер, таймеры, Wake Lock.
// Заход 1: результат живёт только в памяти страницы, F5 его теряет.
// Ни авторизации, ни Supabase, ни сохранения тут нет по замыслу.

// ==========================================================================
// ТЕМА
// ==========================================================================
// Ключ и механика те же, что на app.irenabio.com: pre-render скрипт в <head>
// ставит data-theme до первого кадра, тумблер только переключает и запоминает.

(function wireThemeToggle() {
  const KEY = "irena_theme";
  const btn = document.getElementById("theme-toggle");
  const ic = document.getElementById("theme-toggle-ic");
  const isDark = () => document.documentElement.getAttribute("data-theme") === "dark";

  function reflect() {
    ic.className = "ti " + (isDark() ? "ti-sun" : "ti-moon");
    btn.setAttribute("aria-label", isDark() ? "Светлая тема" : "Тёмная тема");
  }
  reflect();

  btn.addEventListener("click", () => {
    const dark = !isDark();
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    try { localStorage.setItem(KEY, dark ? "dark" : "light"); } catch (e) {}
    reflect();
  });
})();

// ==========================================================================
// ЗВУК
// ==========================================================================
// Синтез через Web Audio API, mp3 не нужен. AudioContext разблокируем ОДИН
// раз по первому жесту на старте теста: без этого на iPhone первый сигнал
// просто не прозвучит.

let audioCtx = null;
let audioUnlocked = false;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function unlockAudio() {
  if (audioUnlocked) return;
  try {
    const ctx = getAudioCtx();
    if (ctx.state === "suspended") ctx.resume();
    // Немой импульс: именно он будит контекст на iOS, одного resume мало.
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.01);
    audioUnlocked = true;
  } catch (e) {}
}

// Готовый медиаэлемент с сигналом. Web Audio на iOS оказался ненадёжен:
// контекст уходит в suspended, и на экране паузы, где таймер стартует САМ,
// без жеста, сигнал не звучал вовсе. Элемент <audio>, единожды
// разблокированный жестом, переживает засыпание надёжнее.
let beepEl = null;
// Идёт ли прямо сейчас немая разблокировка. Её завершение приходит
// асинхронно и обязано отличать "это была разблокировка, глуши" от
// "пока я ждал, зазвучал настоящий сигнал, не трогай".
let beepPriming = false;

// WAV собираем в коде: отдельный файл в репозитории ради полусекунды
// синуса не нужен, а data-URI не требует сети в момент сигнала.
function buildBeepDataUri(freq, seconds, volume) {
  const rate = 22050;
  const total = Math.floor(rate * seconds);
  const size = 44 + total * 2;
  const view = new DataView(new ArrayBuffer(size));
  const ascii = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  ascii(0, "RIFF");  view.setUint32(4, size - 8, true);   ascii(8, "WAVE");
  ascii(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);  view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, total * 2, true);

  // Те же мягкие края, что у Web Audio, иначе щёлкает.
  const fade = Math.floor(rate * TIMER_SOUND.fadeInSec);
  for (let i = 0; i < total; i++) {
    let gain = volume;
    if (i < fade) gain *= i / fade;
    if (i > total - fade) gain *= (total - i) / fade;
    const v = Math.sin((2 * Math.PI * freq * i) / rate) * gain;
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 32767, true);
  }

  let bin = "";
  const bytes = new Uint8Array(view.buffer);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return "data:audio/wav;base64," + btoa(bin);
}

// Разблокировка звука. Зовём на КАЖДОМ жесте, ведущем к экрану с таймером:
// на экране паузы таймер стартует автоматически, своего жеста там нет.
function primeAudio() {
  unlockAudio();
  try {
    if (!beepEl) {
      beepEl = document.createElement("audio");
      beepEl.preload = "auto";
      beepEl.src = buildBeepDataUri(
        TIMER_SOUND.freq,
        TIMER_SOUND.durationMs / 1000,
        TIMER_SOUND.volume
      );
      document.body.appendChild(beepEl);
    }
    // Короткий немой play прямо внутри жеста: именно он снимает с элемента
    // запрет на самостоятельное воспроизведение позже.
    beepPriming = true;
    beepEl.muted = true;
    const p = beepEl.play();
    const settle = () => {
      // Настоящий сигнал мог начаться, пока мы ждали: тогда глушить нельзя.
      if (beepPriming) {
        try { beepEl.pause(); beepEl.currentTime = 0; } catch (e) {}
      }
      beepPriming = false;
      beepEl.muted = false;
    };
    if (p && typeof p.then === "function") p.then(settle).catch(settle);
    else settle();
  } catch (e) {}
}

function playTone(freq, durationMs, vol) {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    const dur = durationMs / 1000;
    // Мягкие fade in / fade out, чтобы не щёлкало.
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + TIMER_SOUND.fadeInSec);
    gain.gain.setValueAtTime(vol, ctx.currentTime + dur - TIMER_SOUND.fadeOutSec);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + dur);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + dur);
  } catch (e) {}
}

async function playBeepElement() {
  try {
    if (!beepEl) return false;
    // Настоящий сигнал старше незавершённой разблокировки.
    beepPriming = false;
    beepEl.muted = false;
    beepEl.currentTime = 0;
    const p = beepEl.play();
    if (p && typeof p.then === "function") await p;
    return true;
  } catch (e) {
    console.error("beep element:", e);
    return false;
  }
}

// Запасной путь. resume() обязателен ПЕРЕД игрой: iOS усыпляет контекст
// сам, и на двухминутной паузе он к финишу уже не running.
async function playToneFallback() {
  try {
    const ctx = getAudioCtx();
    if (ctx.state !== "running") await ctx.resume();
    if (ctx.state !== "running") return false;
    playTone(TIMER_SOUND.freq, TIMER_SOUND.durationMs, TIMER_SOUND.volume);
    return true;
  } catch (e) {
    console.error("web audio fallback:", e);
    return false;
  }
}

// Вибрация первой: она не зависит от звука и на Android спасает, когда
// телефон в беззвучном режиме. На iOS Safari её нет, там надежда на звук.
async function signalTimerEnd() {
  try { if (navigator.vibrate) navigator.vibrate(TIMER_SOUND.vibratePattern); } catch (e) {}
  if (await playBeepElement()) return;
  await playToneFallback();
}

// ==========================================================================
// WAKE LOCK
// ==========================================================================
// В кодовой базе такого не было, пишем с нуля. Блокировка отпускается при
// уходе со вкладки и сама НЕ возвращается, поэтому берём её заново на
// visibilitychange. Старые браузеры про API не знают, всё в try/catch:
// отказ не должен ломать тест, просто экран может гаснуть.

let wakeLock = null;
let wakeLockWanted = false;

async function requestWakeLock() {
  if (!wakeLockWanted) return;
  if (wakeLock) return;
  try {
    if (!("wakeLock" in navigator)) return;
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch (e) {
    wakeLock = null;
  }
}

async function releaseWakeLock() {
  wakeLockWanted = false;
  try { if (wakeLock) await wakeLock.release(); } catch (e) {}
  wakeLock = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") requestWakeLock();
});

// Свернули браузер или ушли в другое приложение - видео замолкает.
// pagehide добирает случаи, где visibilitychange не приходит: уход по
// аппаратной кнопке "назад" и заморозка страницы в bfcache.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") pauseVideo();
});
window.addEventListener("pagehide", () => { pauseVideo(); });

// ==========================================================================
// KINESCOPE
// ==========================================================================
// Плеер создаётся ОДИН раз и живёт до конца теста, дальше только seekTo.
// Параметр ?seek= намеренно не используем: он обрезает начало манифеста и
// отнимает возможность отмотать назад.

let kinescopeFactory = null;
let kinescopePlayer = null;
let kinescopeLoading = null;

function loadKinescopeSdk() {
  if (kinescopeFactory) return Promise.resolve(kinescopeFactory);
  if (kinescopeLoading) return kinescopeLoading;

  kinescopeLoading = new Promise((resolve, reject) => {
    window.onKinescopeIframeAPIReady = function (factory) {
      kinescopeFactory = factory;
      resolve(factory);
    };
    const tag = document.createElement("script");
    tag.src = VIDEO.sdkUrl;
    tag.onerror = () => reject(new Error("sdk_load_failed"));
    const first = document.getElementsByTagName("script")[0];
    first.parentNode.insertBefore(tag, first);
    setTimeout(() => reject(new Error("sdk_timeout")), 15000);
  });
  return kinescopeLoading;
}

async function getPlayer() {
  if (kinescopePlayer) return kinescopePlayer;
  const factory = await loadKinescopeSdk();
  kinescopePlayer = await factory.create("kinescope-player", {
    url: VIDEO.playerUrl,
    size: { width: "100%", height: "100%" },
  });
  return kinescopePlayer;
}

// Открыт ли модал прямо сейчас. Нужен из-за гонки: пока грузится SDK и
// создаётся плеер, модал могли уже закрыть, и запоздавший play() запускал
// бы звук у невидимого плеера.
let videoOpen = false;
// Толкнули ли мы запись в history ради аппаратной кнопки "назад".
let videoHistoryPushed = false;

// Пауза плеера. Идемпотентна, безопасна до создания плеера.
async function pauseVideo() {
  try {
    if (kinescopePlayer) await kinescopePlayer.pause();
  } catch (e) {
    console.error("kinescope pause:", e);
  }
}

async function openVideoAt(seconds) {
  const modal = document.getElementById("video-modal");
  const err = document.getElementById("video-error");
  err.hidden = true;
  modal.hidden = false;
  document.body.classList.add("no-scroll");
  videoOpen = true;

  // Аппаратная кнопка "назад" на Android должна закрывать видео, а не всю
  // аппу. Своя запись в history ловится popstate ниже.
  try {
    window.history.pushState({ irenaVideo: true }, "");
    videoHistoryPushed = true;
  } catch (e) {
    videoHistoryPushed = false;
  }

  try {
    const player = await getPlayer();
    await player.seekTo(seconds);
    await player.play();
    // Модал закрыли, пока плеер поднимался: гасим сразу, иначе Ирена
    // говорит из кармана.
    if (!videoOpen) await pauseVideo();
  } catch (e) {
    // Сюда же прилетит ошибка домена, если Kinescope не пустит github.io.
    console.error("kinescope:", e);
    err.textContent = TEXTS.video.error;
    err.hidden = false;
  }
}

// Единственная дверь наружу из видео. Вызывается отовсюду, включая
// showScreen, поэтому обязана быть дешёвой и молчаливой на холостом ходу.
// fromPopstate: назад уже отработал, второй раз в history лезть нельзя.
function closeVideo(fromPopstate) {
  const wasOpen = videoOpen;
  videoOpen = false;
  document.getElementById("video-modal").hidden = true;
  document.body.classList.remove("no-scroll");
  pauseVideo();

  if (wasOpen && videoHistoryPushed && !fromPopstate) {
    videoHistoryPushed = false;
    try { window.history.back(); } catch (e) {}
  }
  if (fromPopstate) videoHistoryPushed = false;
}

// ==========================================================================
// ТАЙМЕР
// ==========================================================================
// Отсчёт по дельте Date.now(), а не по числу тиков: в фоне браузер троттлит
// setInterval и счётчик тиков уплывает. Тик здесь только перерисовывает.

function createTimer(onTick, onDone) {
  let endAt = 0;
  let handle = null;

  function left() {
    return Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
  }
  function stop() {
    if (handle) { clearInterval(handle); handle = null; }
  }
  function start(seconds) {
    stop();
    endAt = Date.now() + seconds * 1000;
    onTick(left());
    handle = setInterval(() => {
      const rest = left();
      onTick(rest);
      if (rest <= 0) { stop(); onDone(); }
    }, 200);
  }
  return { start, stop, left, isRunning: () => handle !== null };
}

function fmtClock(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

// ==========================================================================
// СОСТОЯНИЕ
// ==========================================================================

const state = {
  profile: { age: null, sex: null, who: "self" },
  answers: {},                        // blockId -> ответ или null при пропуске
  floor: { descent: [], rise: [] },   // текущие галочки вставания с пола
  floorStep: 0,                       // какая половина блока с галочками на экране
  index: 0,                           // индекс блока в BLOCKS
  // Пришли в блок с экрана результата дозаполнить пропущенное. Отличает
  // "иду по порядку" от "вернулась исправить": по "Дальше" не следующий
  // блок, а обратно на результат.
  returnToResult: false,
  skipNoticeShown: false,             // строку про дозаполнение показали
  showSkipNote: false,                // показать её на ближайшем блоке
};

function $(id) { return document.getElementById(id); }

function showScreen(id) {
  // ЛЮБАЯ смена экрана гасит видео. Раньше пауза висела только на крестике,
  // и всё остальное её обходило: "Дальше", "Назад", "Пропустить блок",
  // переход на паузу, на результат, "Пройти заново". Женщина уходила делать
  // упражнение, а Ирена продолжала говорить из телефона.
  closeVideo();

  ["view-intro", "view-safety", "view-block", "view-rest", "view-result"]
    .forEach(v => { $(v).hidden = (v !== id); });
  const body = document.querySelector("#" + id + " .screen-body");
  if (body) body.scrollTop = 0;
  // У .screen стоит min-height: 100dvh, поэтому на длинном содержимом растёт
  // сам экран и прокручивается ОКНО, а не тело. Без сброса окна переход на
  // результат открывался посередине, с обрезанной цифрой возраста.
  window.scrollTo(0, 0);
}

// ==========================================================================
// ЭКРАН 1: ВХОД
// ==========================================================================

function renderIntro() {
  $("intro-title").textContent = TEXTS.intro.title;
  $("intro-lead").textContent = TEXTS.intro.lead;
  $("intro-age-label").textContent = TEXTS.intro.ageLabel;
  $("intro-sex-label").textContent = TEXTS.intro.sexLabel;
  $("intro-who-label").textContent = TEXTS.intro.whoLabel;
  $("intro-start").textContent = TEXTS.intro.start;
  $("intro-age").placeholder = TEXTS.intro.agePlaceholder;
  $("intro-age").min = LIMITS.entryAgeMin;
  $("intro-age").max = LIMITS.entryAgeMax;

  buildOptions($("intro-sex"), "sex", [
    { value: "female", label: TEXTS.intro.sexFemale },
    { value: "male",   label: TEXTS.intro.sexMale },
  ], v => { state.profile.sex = v; });

  buildOptions($("intro-who"), "who", [
    { value: "self",  label: TEXTS.intro.whoSelf },
    { value: "other", label: TEXTS.intro.whoOther },
  ], v => { state.profile.who = v; });

  // Пол не выбран заранее: тест проходят и женщины, и мужчины.
  selectOption($("intro-who"), "self");
  state.profile.who = "self";
}

function buildOptions(host, name, items, onPick) {
  host.innerHTML = "";
  items.forEach(item => {
    const label = document.createElement("label");
    label.className = "opt";
    label.dataset.value = item.value;
    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.value = item.value;
    const span = document.createElement("span");
    span.textContent = item.label;
    label.appendChild(input);
    label.appendChild(span);
    label.addEventListener("click", () => {
      selectOption(host, item.value);
      onPick(item.value);
    });
    host.appendChild(label);
  });
}

function selectOption(host, value) {
  host.querySelectorAll(".opt").forEach(el => {
    const on = el.dataset.value === value;
    el.classList.toggle("selected", on);
    const input = el.querySelector("input");
    if (input) input.checked = on;
  });
}

$("intro-start").addEventListener("click", () => {
  const err = $("intro-age-error");
  const age = parseInt($("intro-age").value, 10);
  const okAge = Number.isInteger(age) && age >= LIMITS.entryAgeMin && age <= LIMITS.entryAgeMax;

  if (!okAge || !state.profile.sex) {
    err.textContent = !okAge ? TEXTS.intro.ageError : TEXTS.intro.sexLabel;
    err.hidden = false;
    return;
  }
  err.hidden = true;
  state.profile.age = age;

  // Первый жест на старте теста: будим звук и берём Wake Lock.
  primeAudio();
  wakeLockWanted = true;
  requestWakeLock();

  showScreen("view-safety");
});

// ==========================================================================
// ЭКРАН 2: ПРЕДУПРЕЖДЕНИЕ
// ==========================================================================

function renderSafety() {
  $("safety-title").textContent = TEXTS.safety.title;
  $("safety-text").textContent = TEXTS.safety.text;
  $("safety-watch").querySelector("span").textContent = TEXTS.safety.watch;
  $("safety-start").textContent = TEXTS.safety.start;
}

$("safety-watch").addEventListener("click", () => openVideoAt(TIMECODES.intro));
$("safety-start").addEventListener("click", () => {
  // Последний жест перед экраном паузы, где таймер стартует сам.
  // Разблокировка идемпотентна, лишний вызов ничего не стоит.
  primeAudio();
  state.index = 0;
  goToBlock();
});

// ==========================================================================
// ЭКРАН ОТДЫХА
// ==========================================================================

const restTimer = createTimer(
  sec => { $("rest-value").textContent = fmtClock(sec); },
  () => {
    signalTimerEnd();
    $("rest-next").disabled = false;
    document.querySelector("#view-rest .timer").classList.remove("running");
    // Видимый сигнал рядом со звуковым: телефон в беззвучном режиме
    // молчит независимо от того, как мы играем звук.
    $("rest-hint").textContent = TEXTS.block.timerDone;
  }
);

function showRest(cfg, blockIndex) {
  $("rest-kicker").textContent = TEXTS.rest.kicker;
  $("rest-title").textContent = cfg.title;
  $("rest-text").textContent = cfg.text;
  $("rest-hint").textContent = TEXTS.rest.skipHint;
  $("rest-next").textContent = TEXTS.block.next;
  $("rest-next").disabled = true;
  document.querySelector("#view-rest .timer").classList.add("running");

  showScreen("view-rest");
  restTimer.start(TIMERS[cfg.timer].seconds);

  $("rest-next").onclick = () => {
    restTimer.stop();
    renderBlock(blockIndex);
    showScreen("view-block");
  };
}

// Переход к блоку по state.index с учётом обязательной паузы перед ним.
// Вход в блок ВСЕГДА с нуля: галочки и внутренний шаг сбрасываются здесь,
// а не в renderBlock, потому что renderBlock зовут ещё и на "Назад".
function goToBlock() {
  // Единственная точка перехода между блоками, и вызывается она всегда из
  // жеста: подтверждаем разблокировку звука здесь, чтобы экран паузы с его
  // автостартом таймера был прикрыт независимо от того, откуда пришли.
  primeAudio();

  if (state.index >= BLOCKS.length) { finish(); return; }
  const block = BLOCKS[state.index];
  state.floor = { descent: [], rise: [] };
  state.floorStep = 0;
  const rest = REST_BEFORE[block.id];
  if (rest && !state.restDone) {
    state.restDone = true;
    showRest(rest, state.index);
    return;
  }
  renderBlock(state.index);
  showScreen("view-block");
}

// ==========================================================================
// ЭКРАН БЛОКА
// ==========================================================================

const blockTimer = createTimer(
  sec => { $("timer-value").textContent = fmtClock(sec); },
  () => {
    signalTimerEnd();
    $("timer-btn").textContent = TEXTS.block.timerStart;
    document.querySelector("#block-timer").classList.remove("running");
  }
);

function renderBlock(i) {
  const block = BLOCKS[i];
  blockTimer.stop();

  $("block-progress").textContent = TEXTS.block.progress
    .replace("{n}", block.n).replace("{total}", BLOCKS.length);
  $("block-progress-fill").style.width = Math.round((block.n / BLOCKS.length) * 100) + "%";

  $("block-icon").className = "ti " + block.icon;
  $("block-title").textContent = block.title;
  $("block-hint").textContent = block.hint.join(" ");
  $("block-watch").querySelector("span").textContent = TEXTS.block.watch;
  $("block-details-label").textContent = TEXTS.block.details;
  $("block-protocol").textContent = block.protocol;
  document.querySelector(".protocol").open = false;   // всегда свёрнута
  $("block-next").textContent = TEXTS.block.next;
  $("block-skip").textContent = TEXTS.block.skip;
  $("block-back").textContent = TEXTS.block.back;
  $("block-error").hidden = true;

  // Строка про дозаполнение живёт ровно один экран после первого пропуска.
  const skipNote = $("skip-note");
  if (state.showSkipNote) {
    skipNote.textContent = TEXTS.block.skipNote;
    skipNote.hidden = false;
    state.showSkipNote = false;
  } else {
    skipNote.hidden = true;
  }

  renderSubstep(block);

  // Пометка про фазу цикла - только женщинам.
  const note = $("block-note");
  if (block.noteFemale && state.profile.sex === "female") {
    note.textContent = block.noteFemale;
    note.hidden = false;
  } else {
    note.hidden = true;
  }

  // Таймер блока.
  const timerBox = $("block-timer");
  if (block.timer) {
    const t = TIMERS[block.timer];
    timerBox.hidden = false;
    timerBox.classList.remove("running");
    $("timer-value").textContent = fmtClock(t.seconds);
    $("timer-btn").textContent = TEXTS.block.timerStart;
    $("timer-btn").onclick = () => {
      if (blockTimer.isRunning()) {
        blockTimer.stop();
        $("timer-btn").textContent = TEXTS.block.timerStart;
        $("timer-value").textContent = fmtClock(t.seconds);
        timerBox.classList.remove("running");
      } else {
        // Видео замолкает на старте таймера: иначе голос Ирены перекроет
        // сигнал окончания, ради которого таймер и нужен.
        closeVideo();
        primeAudio();
        blockTimer.start(t.seconds);
        $("timer-btn").textContent = TEXTS.block.timerStop;
        timerBox.classList.add("running");
      }
    };
  } else {
    timerBox.hidden = true;
  }

  renderInputs(block);
}

// Подзаголовок внутреннего шага и кнопка "Назад".
// Блок с галочками разбит на два экрана: женщина отмечает по памяти сразу
// после упражнения, и если половина списка ушла за край экрана, она про неё
// забудет и завысит себе балл. Прогресс сверху при этом НЕ меняется: для
// проходящей это один блок, "Блок 7 из 7" на обоих экранах.
function renderSubstep(block) {
  const cfg = SCORING[block.id];
  const sub = $("block-substep");
  const back = $("block-back");
  const split = cfg.input === "checkboxes" && cfg.halves.length > 1;

  if (!split) {
    sub.hidden = true;
    back.hidden = true;
    return;
  }

  const half = cfg.halves[state.floorStep];
  sub.textContent = TEXTS.block.substep
    .replace("{n}", state.floorStep + 1)
    .replace("{total}", cfg.halves.length)
    .replace("{label}", half.label);
  sub.hidden = false;
  back.hidden = state.floorStep === 0;

  // У каждого шага своя подсказка: на втором экране висела строка "сядь на
  // пол и встань обратно", хотя к этому моменту это уже сделано.
  if (half.hint) $("block-hint").textContent = half.hint;
}

function renderInputs(block) {
  const cfg = SCORING[block.id];
  const single = $("input-single");
  const pair = $("input-pair");
  const checks = $("input-checks");

  single.hidden = true; pair.hidden = true; checks.hidden = true;
  $("block-soft").hidden = true;

  if (cfg.input === "pulse_pair") {
    pair.hidden = false;
    $("input-peak-label").textContent = TEXTS.block.peakLabel;
    $("input-after-label").textContent = TEXTS.block.afterLabel;
    $("input-peak").value = "";
    $("input-after").value = "";
    return;
  }

  // Отметки НЕ сбрасываем: сброс живёт в goToBlock, иначе "Назад" на первый
  // экран блока стирал бы уже проставленные галочки.
  if (cfg.input === "checkboxes") {
    checks.hidden = false;
    renderFloorChecks(cfg);
    return;
  }

  single.hidden = false;
  $("input-single-label").textContent = block.inputLabel;
  $("input-single-unit").textContent = block.inputUnit || "";
  $("input-single-value").value = "";
}

// Галочки вставания с пола. На экране ТОЛЬКО текущая половина: её название
// стоит подзаголовком под заголовком блока, поэтому подписи над списком нет.
// Взаимоисключение считает calc.js по флагу exclusive, здесь только отрисовка.
function renderFloorChecks(cfg) {
  const host = $("input-checks");
  const half = cfg.halves[state.floorStep];
  host.innerHTML = "";

  const row = document.createElement("div");
  row.className = "checks";

  cfg.penalties.forEach(p => {
    const label = document.createElement("label");
    label.className = "check";
    label.dataset.half = half.id;
    label.dataset.option = p.id;

    const input = document.createElement("input");
    input.type = "checkbox";
    const span = document.createElement("span");
    span.textContent = p.label;
    label.appendChild(input);
    label.appendChild(span);

    label.addEventListener("click", e => {
      e.preventDefault();
      state.floor[half.id] = toggleFloorRiseOption(state.floor[half.id], p.id, cfg);
      reflectFloorChecks(cfg);
    });

    row.appendChild(label);
  });

  host.appendChild(row);
  reflectFloorChecks(cfg);
}

function reflectFloorChecks(cfg) {
  $("input-checks").querySelectorAll(".check").forEach(el => {
    const on = (state.floor[el.dataset.half] || []).includes(el.dataset.option);
    el.classList.toggle("selected", on);
    const input = el.querySelector("input");
    if (input) input.checked = on;
  });
}

// Мягкая подсказка про уже умноженный пульс. Поля принимают счёт за 15
// секунд, но привычка вписать минутные 140 никуда не денется. Подсказка
// живёт на вводе, а не на кнопке "Дальше": показать её в момент перехода
// бессмысленно, экран уже сменится. Проход она не блокирует.
function reflectPulseSoftHint() {
  const cfg = SCORING[BLOCKS[state.index].id];
  const box = $("block-soft");
  if (!cfg || cfg.softAbove === undefined) { box.hidden = true; return; }

  const high = ["input-peak", "input-after"].some(id => {
    const v = parseInt($(id).value, 10);
    return Number.isInteger(v) && v > cfg.softAbove;
  });
  box.textContent = TEXTS.block.pulseSoftHint;
  box.hidden = !high;
}

["input-peak", "input-after"].forEach(id => {
  $(id).addEventListener("input", reflectPulseSoftHint);
});

// Сбор ответа. Возвращает { ok: true, value } или { ok: false }.
function collectAnswer(block) {
  const cfg = SCORING[block.id];

  if (cfg.input === "checkboxes") {
    if (!floorRiseAnswered(state.floor, cfg)) return { ok: false };
    return { ok: true, value: { descent: state.floor.descent.slice(), rise: state.floor.rise.slice() } };
  }

  if (cfg.input === "pulse_pair") {
    const peak = parseInt($("input-peak").value, 10);
    const after = parseInt($("input-after").value, 10);
    const inRange = v => Number.isInteger(v) && v >= cfg.valid.min && v <= cfg.valid.max;
    if (!inRange(peak) || !inRange(after)) return { ok: false };
    // Пишем ОБА значения: введённое за 15 секунд и посчитанное в минуту.
    // Пересчёт после перекалибровки порогов будет опираться на сырое.
    return {
      ok: true,
      value: {
        peak,
        after,
        peak_per_minute: pulsePerMinute(peak, cfg),
        after_per_minute: pulsePerMinute(after, cfg),
      },
    };
  }

  const v = parseInt($("input-single-value").value, 10);
  if (!Number.isInteger(v) || v < cfg.valid.min || v > cfg.valid.max) return { ok: false };
  return { ok: true, value: v };
}

$("block-watch").addEventListener("click", () => {
  openVideoAt(BLOCKS[state.index].timecode);
});

$("block-next").addEventListener("click", () => {
  const block = BLOCKS[state.index];
  const cfg = SCORING[block.id];

  // Блок с галочками идёт по половинам: сначала посадка, потом подъём.
  // Пока половины не кончились, "Дальше" ведёт на следующий шаг того же блока.
  if (cfg.input === "checkboxes") {
    const half = cfg.halves[state.floorStep];
    if (!(state.floor[half.id] || []).length) {
      $("block-error").textContent = TEXTS.block.checksError;
      $("block-error").hidden = false;
      return;
    }
    if (state.floorStep < cfg.halves.length - 1) {
      state.floorStep += 1;
      renderBlock(state.index);
      $("view-block").querySelector(".screen-body").scrollTop = 0;
      window.scrollTo(0, 0);
      return;
    }
  }

  const res = collectAnswer(block);
  if (!res.ok) {
    $("block-error").textContent = TEXTS.block.inputError;
    $("block-error").hidden = false;
    return;
  }
  blockTimer.stop();
  state.answers[block.id] = res.value;

  // Дозаполнение: возвращаемся на результат, а не идём по порядку дальше.
  if (state.returnToResult) {
    state.returnToResult = false;
    finish();
    return;
  }

  state.index += 1;
  goToBlock();
});

// Назад по внутренним шагам блока. Отметки прошлого шага остаются на месте:
// state.floor чистится только на входе в блок, в goToBlock.
$("block-back").addEventListener("click", () => {
  if (state.floorStep === 0) return;
  state.floorStep -= 1;
  renderBlock(state.index);
  $("view-block").querySelector(".screen-body").scrollTop = 0;
  window.scrollTo(0, 0);
});

// Пропуск не штрафуется: причины бывают честные, поэтому просто null.
// Пропускается блок ЦЕЛИКОМ, вместе со вторым внутренним шагом.
$("block-skip").addEventListener("click", () => {
  blockTimer.stop();
  state.answers[BLOCKS[state.index].id] = null;

  if (state.returnToResult) {
    state.returnToResult = false;
    finish();
    return;
  }

  // Про то, что пропуск обратим, говорим один раз и сразу после первого.
  if (!state.skipNoticeShown) {
    state.skipNoticeShown = true;
    state.showSkipNote = true;
  }

  state.index += 1;
  goToBlock();
});

// Возврат в пропущенный блок с экрана результата. Экран паузы по дороге
// НЕ показываем: она приходит с результата, отдохнувшая, а пауза нужна
// была, чтобы пульс улёгся после предыдущей нагрузки.
function openBlockForFix(blockId) {
  const i = BLOCKS.findIndex(b => b.id === blockId);
  if (i < 0) return;
  state.returnToResult = true;
  state.index = i;
  state.floor = { descent: [], rise: [] };
  state.floorStep = 0;
  renderBlock(i);
  showScreen("view-block");
}

// ==========================================================================
// ЭКРАН РЕЗУЛЬТАТА
// ==========================================================================

function finish() {
  blockTimer.stop();
  restTimer.stop();
  state.showSkipNote = false;
  releaseWakeLock();
  renderResult(computeResult(state.answers, state.profile));
  showScreen("view-result");
}

function renderResult(r) {
  const head = $("result-head");
  const none = $("result-none");

  if (r.hasAge) {
    head.hidden = false;
    none.hidden = true;
    $("result-title").textContent = TEXTS.result.title;
    $("result-age").textContent = r.bodyAge;
    // Строка вердикта из AGE_SHIFT снята с экрана: она дублировала подпись
    // под цифрой слово в слово ("соответствует возрасту" и "Тело
    // соответствует возрасту"). В конфиге title остался, он ещё пригодится
    // в сохранённом замере.

    const cap = $("result-caption");
    const n = Math.abs(r.shift);
    if (r.shift < 0) {
      cap.textContent = TEXTS.result.younger.replace("{n}", n).replace("{years}", yearsWord(n));
      cap.className = "result-caption younger";
    } else if (r.shift === 0) {
      cap.textContent = TEXTS.result.same;
      cap.className = "result-caption same";
    } else {
      cap.textContent = TEXTS.result.older.replace("{n}", n).replace("{years}", yearsWord(n));
      cap.className = "result-caption older";
    }
  } else {
    head.hidden = true;
    none.hidden = false;
    $("result-none-title").textContent = TEXTS.result.notEnoughTitle;
    $("result-none-text").textContent = TEXTS.result.notEnoughText;
  }

  // Дисклеймер объясняет цифру возраста. Пропущено больше двух блоков -
  // цифры на экране нет, значит и объяснять нечего.
  $("result-disclaimer").textContent = TEXTS.result.disclaimer;
  $("result-disclaimer").hidden = !r.hasAge;

  const weak = $("result-weak");
  if (r.weakest) {
    weak.hidden = false;
    $("weak-kicker").textContent = TEXTS.result.weakLinkKicker;
    $("weak-title").textContent = r.weakest.title;
    $("weak-text").textContent = r.weakest.text;
  } else {
    weak.hidden = true;
  }

  $("breakdown-title").textContent = TEXTS.result.breakdownTitle;
  const list = $("breakdown-list");
  list.innerHTML = "";
  r.perBlock.forEach(b => {
    const li = document.createElement("li");

    const name = document.createElement("span");
    name.className = "breakdown-name";
    name.textContent = b.title;

    // Пропущенный блок - не приговор: строка кликабельна и ведёт обратно в
    // блок. Иначе три пропуска убивают результат, а исправить это можно
    // только пройдя весь тест заново.
    if (b.skipped) {
      li.className = "is-skipped";
      const fix = document.createElement("button");
      fix.type = "button";
      fix.className = "breakdown-fix";
      const fill = document.createElement("span");
      fill.className = "breakdown-fill";
      fill.textContent = TEXTS.result.blockFill;
      fix.appendChild(name);
      fix.appendChild(fill);
      fix.addEventListener("click", () => openBlockForFix(b.id));
      li.appendChild(fix);
      list.appendChild(li);
      return;
    }

    const score = document.createElement("span");
    score.className = "breakdown-score";
    score.textContent = TEXTS.result.blockScore
      .replace("{score}", b.score).replace("{max}", MAX_SCORE_PER_BLOCK);

    li.appendChild(name);
    li.appendChild(score);
    list.appendChild(li);
  });

  $("result-restart").textContent = TEXTS.result.restart;
}

$("result-restart").addEventListener("click", () => {
  state.answers = {};
  state.floor = { descent: [], rise: [] };
  state.floorStep = 0;
  state.index = 0;
  state.restDone = false;
  state.returnToResult = false;
  state.skipNoticeShown = false;
  state.showSkipNote = false;
  showScreen("view-intro");
});

// ==========================================================================
// ОБЩЕЕ
// ==========================================================================

// Все двери из модала ведут в closeVideo: крестик, тап по фону, Esc и
// аппаратная кнопка "назад" на Android.
$("video-close").addEventListener("click", () => closeVideo());
$("video-modal").addEventListener("click", e => {
  if (e.target === $("video-modal")) closeVideo();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && videoOpen) closeVideo();
});
window.addEventListener("popstate", () => {
  if (videoOpen) closeVideo(true);
});

document.title = TEXTS.appTitle;
renderIntro();
renderSafety();
showScreen("view-intro");
