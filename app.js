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

// Тишина для разблокировки и настоящий сигнал. Строятся один раз лениво.
let silentWavUri = null;
let beepWavUri = null;
let beepSrcIsSilent = true;

// WAV собираем в коде: отдельный файл в репозитории ради полусекунды
// синуса не нужен, а data-URI не требует сети в момент сигнала.
// volume 0 даёт настоящую тишину: все отсчёты нулевые.
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
//
// Разблокируем ПУСТЫМ файлом, а не настоящим сигналом. Ставка на muted не
// оправдалась: в Telegram WebView на iOS немое проигрывание прозвучало
// ВСЛУХ, и телефон пикал на экране "Прежде чем начать", где никакого
// таймера нет. Тишина звучит одинаково при любом отношении движка к muted.
// Разрешение, снятое жестом, живёт на самом элементе и переживает смену src.
function primeAudio() {
  unlockAudio();
  try {
    if (!silentWavUri) {
      silentWavUri = buildBeepDataUri(TIMER_SOUND.freq, 0.05, 0);
      beepWavUri = buildBeepDataUri(
        TIMER_SOUND.freq,
        TIMER_SOUND.durationMs / 1000,
        TIMER_SOUND.volume
      );
    }
    if (!beepEl) {
      beepEl = document.createElement("audio");
      beepEl.preload = "auto";
      beepEl.src = silentWavUri;
      beepSrcIsSilent = true;
      document.body.appendChild(beepEl);
    }
    if (beepPriming) return;   // разблокировка уже идёт

    beepPriming = true;
    if (!beepSrcIsSilent) { beepEl.src = silentWavUri; beepSrcIsSilent = true; }

    const p = beepEl.play();
    const settle = () => {
      // Настоящий сигнал мог начаться, пока мы ждали: тогда не мешаем.
      if (beepPriming) {
        try { beepEl.pause(); beepEl.currentTime = 0; } catch (e) {}
        beepEl.src = beepWavUri;
        beepSrcIsSilent = false;
      }
      beepPriming = false;
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
    if (!beepEl || !beepWavUri) return false;
    // Настоящий сигнал старше незавершённой разблокировки: если она ещё в
    // полёте, забираем элемент себе и ставим настоящий звук.
    beepPriming = false;
    beepEl.muted = false;
    if (beepSrcIsSilent) { beepEl.src = beepWavUri; beepSrcIsSilent = false; }
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

// Видимый сигнал: вспышки на всю площадь плюс пульсация цифры. Звук может
// не пройти вовсе (беззвучный режим глушит и медиаэлемент, и Web Audio), а
// это заметно боковым зрением, не глядя на экран. Уважение к
// prefers-reduced-motion живёт в CSS, здесь только классы.
const FLASH_MS = 1300;

function flashScreen() {
  try {
    const flash = $("flash");
    const values = [$("timer-value"), $("rest-value")];
    flash.classList.remove("on");
    values.forEach(v => v && v.classList.remove("pulse"));
    // Перезапуск анимации: без чтения offsetWidth браузер склеит снятие и
    // навешивание класса в один кадр и ничего не покажет.
    void flash.offsetWidth;
    flash.classList.add("on");
    values.forEach(v => v && v.classList.add("pulse"));
    setTimeout(() => {
      flash.classList.remove("on");
      values.forEach(v => v && v.classList.remove("pulse"));
    }, FLASH_MS);
  } catch (e) {}
}

// Вибрация первой: она не зависит от звука и на Android спасает, когда
// телефон в беззвучном режиме. На iOS Safari её нет, там надежда на звук
// и на вспышку.
async function signalTimerEnd() {
  flashScreen();
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

// Экраны, где тумблер темы виден. На блоках и паузе его НЕТ: он висит ровно
// там, куда идёт палец к кнопкам самого Телеграма, и на живом проходе его
// задели случайно. Блоки это большая часть теста, значит и почти все шансы
// промахнуться. На входе и результате цена ошибки мала: там сразу видно,
// что произошло, и можно вернуть обратно.
const THEME_TOGGLE_SCREENS = ["view-intro", "view-safety", "view-resume", "view-result", "view-compare"];

function showScreen(id) {
  // ЛЮБАЯ смена экрана гасит видео. Раньше пауза висела только на крестике,
  // и всё остальное её обходило: "Дальше", "Назад", "Пропустить блок",
  // переход на паузу, на результат, "Пройти заново". Женщина уходила делать
  // упражнение, а Ирена продолжала говорить из телефона.
  closeVideo();

  // Скрываем ВСЕ экраны, а не список из пяти: гейт, блокировка и
  // продолжение замера тоже .screen, и они обязаны уходить.
  document.querySelectorAll(".screen").forEach(el => { el.hidden = el.id !== id; });
  $("theme-toggle").hidden = !THEME_TOGGLE_SCREENS.includes(id);
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
  ], v => {
    state.profile.sex = v;
    $("intro-sex-error").hidden = true;
    reflectStartEnabled();
  });

  buildOptions($("intro-who"), "who", [
    { value: "self",  label: TEXTS.intro.whoSelf },
    { value: "other", label: TEXTS.intro.whoOther },
  ], v => { state.profile.who = v; });

  $("intro-result").querySelector("span").textContent = TEXTS.result.openFromIntro;
  $("intro-compare").querySelector("span").textContent = TEXTS.compare.openFromIntro;

  // Пол не выбран заранее: тест проходят и женщины, и мужчины.
  selectOption($("intro-who"), "self");
  state.profile.who = "self";
  reflectStartEnabled();
}

// Кнопка входа выключена, пока пол не выбран. Пол задаёт пороги трёх блоков
// из семи, и умолчания у него быть не может ни явного, ни молчаливого.
// Именно ВЫКЛЮЧЕНА, а не молча не срабатывает: по мёртвой на вид кнопке не
// понять, ждут от тебя ещё чего-то или сломалось приложение.
function reflectStartEnabled() {
  $("intro-start").disabled = !state.profile.sex;
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

// У каждого поля своя ошибка и своё место под ним. Раньше ошибка пола жила
// в слоте ошибки возраста и текстом брала лейбл "Пол": женщина видела над
// кнопкой одинокое слово не под тем полем.
$("intro-start").addEventListener("click", () => {
  const ageErr = $("intro-age-error");
  const sexErr = $("intro-sex-error");
  const age = parseInt($("intro-age").value, 10);
  const okAge = Number.isInteger(age) && age >= LIMITS.entryAgeMin && age <= LIMITS.entryAgeMax;

  ageErr.textContent = TEXTS.intro.ageError;
  ageErr.hidden = okAge;
  // Кнопка при невыбранном поле уже выключена, сюда мы попасть не должны.
  // Проверка остаётся: пороги трёх блоков зависят от пола, и подстраховка
  // на случай, если выключение однажды обойдут, стоит трёх строк.
  sexErr.textContent = TEXTS.intro.sexError;
  sexErr.hidden = !!state.profile.sex;

  if (!okAge || !state.profile.sex) return;

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
    // Пауза вышла, пропускать нечего.
    $("rest-note").hidden = true;
  }
);

function showRest(cfg, blockIndex) {
  $("rest-kicker").textContent = TEXTS.rest.kicker;
  $("rest-title").textContent = cfg.title;
  $("rest-text").textContent = cfg.text;
  $("rest-hint").textContent = TEXTS.rest.skipHint;
  $("rest-note").textContent = TEXTS.rest.skipNote;
  $("rest-note").hidden = false;
  $("rest-next").textContent = TEXTS.block.next;
  // Разрешён ли пропуск, решает конфиг, а не экран.
  $("rest-next").disabled = !cfg.skippable;
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
  // Черновик пишется на каждом переходе между блоками: если тест бросят на
  // середине, потеряется максимум один блок.
  saveDraftQuietly();

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

  const peak = parseInt($("input-peak").value, 10);
  const after = parseInt($("input-after").value, 10);
  const inRange = v => Number.isInteger(v) && v >= cfg.valid.min && v <= cfg.valid.max;
  const both = inRange(peak) && inRange(after);

  // Сравнение НЕстрогое: ровно 55 за 15 секунд это уже 220 в минуту.
  const high = [peak, after].some(v => Number.isInteger(v) && v >= cfg.softAbove);
  // Два одинаковых числа дают падение 0 и ноль баллов ни за что.
  const same = both && peak === after;

  const hint = high ? TEXTS.block.pulseSoftHint : (same ? TEXTS.block.pulseSameHint : null);

  const icon = box.querySelector("i");

  if (hint) {
    box.className = "soft-hint warn";
    // Иконку ставим классом, а не подменой глифа: кодпоинты шрифта угадывать
    // нельзя, а имя класса шрифт разрешает сам.
    icon.className = "ti ti-alert-circle";
    $("block-soft-lead").textContent = hint.lead;
    $("block-soft-text").textContent = hint.text;
    box.hidden = false;
    return;
  }

  // Норму занимает пересчёт: то же место, тот же размер, спокойный вид.
  if (both) {
    const perMinutePeak = pulsePerMinute(peak, cfg);
    const perMinuteAfter = pulsePerMinute(after, cfg);
    box.className = "soft-hint calm";
    $("block-soft-lead").textContent = "";
    $("block-soft-text").textContent = TEXTS.block.pulseEcho
      .replace("{peak}", perMinutePeak)
      .replace("{after}", perMinuteAfter)
      .replace("{drop}", perMinutePeak - perMinuteAfter);
    box.hidden = false;
    return;
  }

  box.hidden = true;
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
  // Черновик догоняет и дозаполненные блоки: сюда приходят обе дороги.
  saveDraftQuietly();
  renderResult(computeResult(state.answers, state.profile));
  showScreen("view-result");
}

// Строка под названием блока в разборе: то самое число, по которому считали.
// Без неё "0 из 3" читается как отказ системы, а не как результат: живой
// прогон дал жалобу "стул не засчитан" - женщина не увидела своего числа и
// решила, что ввод потерялся. Форма строки живёт в resultEcho у блока.
function blockEcho(entry) {
  const block = BLOCKS.find(b => b.id === entry.id);
  const cfg = block && block.resultEcho;
  if (!cfg) return "";
  if (cfg.text) return cfg.text;
  if (typeof entry.value !== "number" || !isFinite(entry.value)) return "";
  if (entry.value === 0 && cfg.zero) return cfg.zero;

  // Отрицательное значение выносим в слова: "падение на -20 ударов" это
  // мусор на экране, а пульс после нагрузки действительно может вырасти.
  let n = entry.value;
  let prefix = cfg.prefix || "";
  if (n < 0 && cfg.negPrefix) { prefix = cfg.negPrefix; n = -n; }

  return prefix + n + " " + pluralWord(n, cfg.forms) + (cfg.suffix || "");
}

// r     - объект расчёта: свежий из computeResult или восстановленный из
//         сохранённой строки через resultFromSaved.
// saved  - сама строка базы, если замер восстановленный, иначе ничего.
//          Различий на экране четыре: дата, отсутствие кнопки сохранения,
//          выключенное дозаполнение и подпись кнопки повтора.
function renderResult(r, saved) {
  const head = $("result-head");
  const none = $("result-none");

  // Дата замера. У свежего её нет: он "сегодня", и строка занимала бы место
  // зря. У восстановленного она обязательна, его открывают и через месяц.
  const when = $("result-when");
  if (saved && saved.created_at) {
    when.textContent = TEXTS.result.savedOn.replace("{date}", fmtDayFull(saved.created_at));
    when.hidden = false;
  } else {
    when.hidden = true;
  }

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
      // Ноль бывает двух разных сортов. Обычный - тело правда соответствует
      // возрасту. Второй - результат упёрся в нижнюю границу, и ноль тут
      // следствие ограничителя: в 18 лет с лучшим возможным результатом
      // подпись "соответствует возрасту" читается как насмешка. Разводим.
      const atFloor = r.clampedTo === "min";
      cap.textContent = atFloor ? TEXTS.result.atFloor : TEXTS.result.same;
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

  // Строка про край шкалы. Живёт только тогда, когда цифру держит не
  // результат, а граница: молчаливый упор женщина принимает за поломку.
  // Причину показываем ОДНУ, самую конкретную. Граница возраста идёт первой:
  // она объясняет и почему цифра именно 18, и почему улучшения её не двигают.
  // Предел полос остаётся на случай, когда границы возраста нет, - это ровно
  // случай Ирены: 39 лет, всё на максимум, цифра 29 и не меньше никогда.
  const limit = $("result-limit");
  let limitText = "";
  if (r.hasAge) {
    if (r.clampedTo === "min") {
      limitText = TEXTS.result.limitFloor.replace("{n}", LIMITS.resultAgeMin);
    } else if (r.clampedTo === "max") {
      limitText = TEXTS.result.limitCeiling.replace("{n}", LIMITS.resultAgeMax);
    } else if (r.atScaleTop) {
      limitText = TEXTS.result.limitTop;
    }
    // Хвост про спринт дописывается к ЛЮБОЙ из причин: во всех трёх случаях
    // цифру держит шкала, значит и через месяц она будет той же.
    if (limitText) {
      limitText += " " + TEXTS.result.limitSprint;
    }
  }
  limit.textContent = limitText;
  limit.hidden = !limitText;

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
    //
    // На ВОССТАНОВЛЕННОМ замере строка не кликается. Причина не в том, что
    // дозаполнение там неуместно: openBlockForFix уводит в блок с пустым
    // state.answers, и "Дальше" оттуда вернуло бы результат, пересчитанный
    // из одного этого блока. То есть тап по строке стёр бы ей с экрана
    // ровно то, за чем она пришла. Да и черновик после сохранения удалён:
    // дописывать некуда, вышел бы второй замер в истории, а не правка
    // первого.
    if (b.skipped && saved) {
      const mark = document.createElement("span");
      mark.className = "breakdown-mark";
      mark.textContent = TEXTS.result.blockSkipped;
      li.appendChild(name);
      li.appendChild(mark);
      list.appendChild(li);
      return;
    }

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

    // Название и эхо введённого числа идут одной колонкой: балл справа
    // остаётся узким и не воюет за ширину с длинной строкой эха.
    const main = document.createElement("div");
    main.className = "breakdown-main";
    main.appendChild(name);

    const echoText = blockEcho(b);
    if (echoText) {
      const echo = document.createElement("span");
      echo.className = "breakdown-echo";
      echo.textContent = echoText;
      main.appendChild(echo);
    }

    li.appendChild(main);
    li.appendChild(score);
    list.appendChild(li);
  });

  const saveBtn = $("result-save");
  const compareBtn = $("result-compare");
  const restartBtn = $("result-restart");
  compareBtn.textContent = TEXTS.result.compare;

  // Восстановленный замер сохранять не надо: он уже в истории. Второй
  // кнопки вместо "Сохранить результат" тут нет намеренно, она была бы
  // прочитана как "сохранить ещё раз".
  if (saved) {
    // lastResult заряжает кнопку сохранения. Оставить в ней чужой объект
    // нельзя: он ушёл бы в базу вместе с пустыми state.answers.
    lastResult = null;
    saveBtn.hidden = true;
    $("result-save-state").hidden = true;
    compareBtn.hidden = !hasSecondMeasurement();
    restartBtn.textContent = TEXTS.result.restartSaved;
    // Единственная кнопка на экране не может быть тихой.
    restartBtn.className = compareBtn.hidden ? "btn btn-primary" : "btn btn-ghost";
    return;
  }

  restartBtn.textContent = TEXTS.result.restart;
  restartBtn.className = "btn btn-ghost";

  // Кнопка сохранения возвращается в исходное состояние на каждый пересчёт:
  // после дозаполнения пропущенного блока сохранять надо заново.
  lastResult = r;
  saveBtn.hidden = false;
  saveBtn.disabled = false;
  saveBtn.textContent = TEXTS.save.button;
  $("result-save-state").hidden = true;
  // Сравнение открывается только по сохранённому замеру, поэтому кнопка
  // уходит вместе со сбросом сохранения: после дозаполнения блока замер
  // надо сохранить заново, и сравнивать до этого нечего.
  compareBtn.hidden = true;
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
// ЧЕРНОВИК И СОХРАНЕНИЕ
// ==========================================================================
// Черновик нужен потому, что пульс покоя меряется утром лёжа, а тест женщина
// открывает днём. Без него она либо соврёт себе цифру, либо бросит на первом
// блоке.

// Готовый замер, который не удалось отправить. Лежит на телефоне до
// следующего живого входа.
const PENDING_KEY = "bodyage_pending_measurement";

let lastResult = null;   // последний посчитанный результат, его и сохраняем

function currentSubject() {
  return state.profile.who === "other" ? "guest" : "self";
}

// Ответы ровно по семи блокам: функция требует полный набор ключей.
function answersForSave() {
  const out = {};
  BLOCKS.forEach(b => {
    out[b.id] = state.answers[b.id] === undefined ? null : state.answers[b.id];
  });
  return out;
}

function draftPayload() {
  return {
    subject: currentSubject(),
    age: state.profile.age,
    sex: state.profile.sex,
    answers: state.answers,
    block_index: Math.min(state.index, BLOCKS.length),
  };
}

// Черновик пишется молча и на любой сбой отвечает молчанием: это подстраховка,
// а не часть теста. Уронить прохождение из-за неудавшегося сохранения нельзя.
function saveDraftQuietly() {
  if (!state.profile.age || !state.profile.sex) return;
  try {
    BodyAgeApi.draftSave(draftPayload())
      .catch(e => console.error("draft_save:", e.message));
  } catch (e) {
    console.error("draft_save:", e);
  }
}

function measurementPayload(r) {
  const scores = {};
  r.perBlock.forEach(b => { scores[b.id] = b.skipped ? null : b.score; });
  return {
    subject: currentSubject(),
    age: state.profile.age,
    sex: state.profile.sex,
    answers: answersForSave(),
    scores,
    completed_blocks: r.completed,
    score_sum: r.sum,
    equivalent: r.hasAge ? r.equivalent : null,
    has_age: r.hasAge,
    body_age: r.hasAge ? r.bodyAge : null,
    shift: r.hasAge ? r.shift : null,
    weakest_block: r.weakest ? r.weakest.id : null,
    config_version: CONFIG_VERSION,
  };
}

function stashPending(payload) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(payload)); } catch (e) {}
}
function clearPending() {
  try { localStorage.removeItem(PENDING_KEY); } catch (e) {}
}

// Отложенный замер уходит при первом же живом входе, молча.
async function flushPending() {
  let raw = null;
  try { raw = localStorage.getItem(PENDING_KEY); } catch (e) { return; }
  if (!raw) return;
  try {
    await BodyAgeApi.save(JSON.parse(raw));
    clearPending();
    // В истории только что появилась строка, о которой запрос на входе не
    // знал: он мог уйти раньше. Спрашиваем заново, иначе строка "Посмотреть
    // свой результат" не появится до следующего входа.
    loadHistory();
  } catch (e) {
    console.error("отложенный замер не ушёл:", e.message);
  }
}

async function saveMeasurement() {
  if (!lastResult) return;
  const btn = $("result-save");
  const st = $("result-save-state");
  const payload = measurementPayload(lastResult);

  btn.disabled = true;
  st.hidden = false;
  st.className = "save-state";
  st.textContent = TEXTS.save.saving;

  try {
    const data = await BodyAgeApi.save(payload);
    clearPending();
    st.className = "save-state ok";
    st.textContent = currentSubject() === "guest" ? TEXTS.save.savedGuest : TEXTS.save.saved;
    btn.hidden = true;

    // Замер лёг в историю, теперь сравнение возьмёт именно его. Гостевой
    // замер не трогает ни историю, ни строки на входе: он про другого
    // человека и лежит под своим subject.
    if (currentSubject() === "self") {
      await rememberSaved(data && data.measurement, payload.answers);
      $("result-compare").hidden = !hasSecondMeasurement();
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = TEXTS.save.retry;
    // Токен мог протухнуть прямо посреди теста: на вебе он живёт 15 минут.
    // Замер при этом не теряется, он ждёт на телефоне.
    if (e.message === "token_expired" || e.message === "no_token") {
      stashPending(payload);
      st.textContent = TEXTS.save.expired;
    } else {
      st.textContent = TEXTS.save.error;
    }
  }
}

// ==========================================================================
// ИСТОРИЯ ЗАМЕРОВ
// ==========================================================================
// Один запрос на входе отвечает сразу на три вопроса: есть ли сохранённый
// замер, есть ли с чем его сравнивать и что именно показывать. Действие
// compare без параметров отдаёт первый и последний замер ЦЕЛИКОМ, вместе с
// answers, поэтому отдельное действие "последний замер" в edge-функции не
// понадобилось. list для этого не годится: answers в него не входит
// намеренно, он для списка.
//
// Гостевые замеры сюда не попадают: они лежат общей кучей под одним
// subject='guest', и "последний гостевой" может оказаться другим человеком.
let historyCache = null;   // { first, last, same, config_changed } или null

async function loadHistory() {
  try {
    historyCache = await BodyAgeApi.compare({ subject: "self" });
  } catch (e) {
    // Строки на входе просто не появятся. Сам тест от истории не зависит,
    // ронять из-за неё вход нельзя.
    console.error("history:", e.message);
    historyCache = null;
  }
  reflectIntroRows();
}

function hasSavedMeasurement() {
  return !!(historyCache && historyCache.last);
}

// Есть ли ВТОРОЙ замер. same означает, что первый и последний это одна и та
// же строка, то есть замер всего один.
function hasSecondMeasurement() {
  return !!(historyCache && historyCache.first && historyCache.last && !historyCache.same);
}

// Две строки, а не одна умная. Строка сравнения уже жила до этой правки и
// ведёт к главному результату спринта: свести обе в одну значило бы отодвинуть
// финал на лишний тап ровно для тех, кто до финала дошёл.
function reflectIntroRows() {
  $("intro-result").hidden = !hasSavedMeasurement();
  $("intro-compare").hidden = !hasSecondMeasurement();
}

// Свежесохранённый замер кладём в кэш руками: иначе она сохранит, вернётся
// на вход и увидит по строке ПОЗАВЧЕРАШНИЙ замер. Ответ save приходит без
// answers (их нет в списочных колонках), поэтому дописываем те, что и
// отправляли.
async function rememberSaved(measurement, answers) {
  // Кэша нет - значит запрос на входе не прошёл, и что лежит в истории, мы
  // не знаем. Не гадаем, а спрашиваем заново. Ответ ждём: сразу за этим
  // решается, показывать ли кнопку сравнения.
  if (!measurement || !historyCache) return loadHistory();

  const row = Object.assign({}, measurement, { answers });
  if (!historyCache.first) historyCache.first = row;
  historyCache.last = row;
  historyCache.same = historyCache.first.id === row.id;
  reflectIntroRows();
}

// Экран результата последнего замера, восстановленный из базы. Цифры берутся
// из строки, а не пересчитываются: на экране обязано быть ровно то, что она
// видела в день замера.
function openSavedResult() {
  if (!hasSavedMeasurement()) return;
  const row = historyCache.last;
  renderResult(resultFromSaved(row), row);
  showScreen("view-result");
}

$("intro-result").addEventListener("click", openSavedResult);

// ==========================================================================
// ЭКРАН СРАВНЕНИЯ: СТАРТ И СЕЙЧАС
// ==========================================================================
// Сравниваем сырые числа: возраст тела упирается в потолок шкалы, и у
// женщины в хорошей форме он не сдвинется за спринт вообще. Арифметика
// живёт в calc.js, здесь только экран.

// Куда вернуть по кнопке "Назад": пришли со входа или с результата.
let compareReturnTo = "view-intro";

function fmtDay(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.getDate() + " " + MONTHS_GENITIVE[d.getMonth()];
}

// То же самое, но с годом, когда год не текущий. Дата сохранённого замера
// живёт над цифрой, и "6 августа" без года через полтора года соврёт.
function fmtDayFull(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const day = fmtDay(iso);
  return d.getFullYear() === new Date().getFullYear() ? day : day + " " + d.getFullYear();
}

// Строка чисел блока, разобранная на три куска: второе число красится
// отдельно, поэтому склеенной строкой обойтись нельзя.
function compareValueParts(row) {
  const block = BLOCKS.find(b => b.id === row.id);
  const cfg = (block && (block.compareEcho || block.resultEcho)) || null;
  if (!cfg) return { before: row.from + " → ", to: String(row.to), after: "" };

  // Готовый шаблон нужен вставанию с пола: там не единицы, а доля от десяти.
  if (cfg.template) {
    const filled = cfg.template
      .replace("{from}", row.from)
      .replace("{max}", blockRawCeiling(SCORING[row.id]));
    const half = filled.split("{to}");
    return { before: half[0], to: String(row.to), after: half[1] || "" };
  }

  return {
    before: (cfg.prefix || "") + row.from + " → ",
    to: String(row.to),
    // Склоняем по ВТОРОМУ числу: оно последнее в строке.
    after: " " + pluralWord(row.to, cfg.forms) + (cfg.suffix || ""),
  };
}

// Правая ячейка. Пусто у обычных строк: там всё сказано числами.
function compareMarkText(row) {
  if (row.status === "ceiling") return TEXTS.compare.ceiling;
  if (row.status !== "no_pair") return "";
  if (row.missing === "both") return TEXTS.compare.missingBoth;
  return row.missing === "first" ? TEXTS.compare.missingFirst : TEXTS.compare.missingLast;
}

// Шапка. Числа не приукрашиваем и дробь в свою пользу не подкручиваем:
// знаменатель - все блоки, где есть оба замера, включая упершиеся в потолок.
function compareSummaryText(c) {
  const T = TEXTS.compare;
  if (c.comparable === 0) return T.nothingToCompare;
  if (c.better === 0 && c.worse === 0) return T.hold;
  if (c.better === 0) return T.noGrowth;
  return (c.worse > 0 ? T.grewAndDropped : T.grew)
    .replace("{n}", c.better)
    .replace("{блоках}", pluralWord(c.better, BLOCKS_FORMS))
    .replace("{c}", c.comparable)
    .replace("{m}", c.worse);
}

function renderCompare(data) {
  const T = TEXTS.compare;
  $("cmp-title").textContent = T.title;
  $("cmp-blocks-title").textContent = T.blocksTitle;
  $("cmp-back").textContent = T.back;

  const state = $("cmp-state");
  const first = data && data.first;
  const last = data && data.last;

  // Замер один. Попасть сюда так нельзя, но между проверкой и запросом мог
  // пройти любой срок, и падать на этом незачем.
  if (!first || !last || data.same) {
    $("cmp-pair").hidden = true;
    $("cmp-summary").hidden = true;
    $("cmp-blocks").hidden = true;
    $("cmp-note-birthday").hidden = true;
    $("cmp-note-config").hidden = true;
    state.textContent = T.onlyOne;
    state.hidden = false;
    return;
  }
  state.hidden = true;
  $("cmp-blocks").hidden = false;
  $("cmp-summary").hidden = false;

  // Пара цифр возраста. Если хотя бы у одного замера цифры нет (пропущено
  // больше двух блоков), пары тоже нет: сравнивать не с чем.
  const bothHaveAge = first.has_age && last.has_age
    && typeof first.body_age === "number" && typeof last.body_age === "number";
  $("cmp-pair").hidden = !bothHaveAge;
  if (bothHaveAge) {
    $("cmp-date-from").textContent = fmtDay(first.created_at);
    $("cmp-date-to").textContent = fmtDay(last.created_at);
    $("cmp-age-from").textContent = first.body_age;
    $("cmp-age-to").textContent = last.body_age;
  }

  // День рождения между замерами двигает цифру сам: возраст тела считается
  // от паспортного. За месяц спринта попадёт примерно каждая двенадцатая.
  const birthday = bothHaveAge && first.age !== last.age;
  $("cmp-note-birthday").textContent = T.birthday;
  $("cmp-note-birthday").hidden = !birthday;

  // Пороги могли пересобрать между замерами. Сырые числа этим не задеты,
  // а две цифры возраста считались по разным шкалам, и молчать нельзя.
  const changed = bothHaveAge && !!data.config_changed;
  $("cmp-note-config").textContent = T.configChanged;
  $("cmp-note-config").hidden = !changed;

  const cmp = compareMeasurements(first.answers, last.answers);
  $("cmp-summary").textContent = compareSummaryText(cmp);

  const list = $("cmp-list");
  list.innerHTML = "";
  cmp.rows.forEach(row => {
    const li = document.createElement("li");

    const main = document.createElement("div");
    main.className = "breakdown-main";

    const name = document.createElement("span");
    name.className = "breakdown-name";
    name.textContent = row.title;
    main.appendChild(name);

    if (row.status !== "no_pair") {
      const parts = compareValueParts(row);
      const echo = document.createElement("span");
      echo.className = "breakdown-echo";
      echo.appendChild(document.createTextNode(parts.before));
      const to = document.createElement("span");
      to.className = "cmp-to" + (row.status === "better" ? " up" : "");
      to.textContent = parts.to;
      echo.appendChild(to);
      echo.appendChild(document.createTextNode(parts.after));
      main.appendChild(echo);
    }

    li.appendChild(main);

    const markText = compareMarkText(row);
    if (markText) {
      const mark = document.createElement("span");
      mark.className = "cmp-mark";
      mark.textContent = markText;
      li.appendChild(mark);
    }

    list.appendChild(li);
  });
}

async function openCompare(returnTo) {
  compareReturnTo = returnTo;
  const state = $("cmp-state");

  $("cmp-title").textContent = TEXTS.compare.title;
  $("cmp-back").textContent = TEXTS.compare.back;
  showScreen("view-compare");

  try {
    const data = await BodyAgeApi.compare({ subject: "self" });
    // Данные свежее того, что лежит в кэше с момента входа: забираем их и
    // туда, чтобы строки на входе и восстановленный замер не отставали.
    historyCache = data;
    reflectIntroRows();
    renderCompare(data);
  } catch (e) {
    console.error("compare:", e.message);
    $("cmp-pair").hidden = true;
    $("cmp-summary").hidden = true;
    $("cmp-blocks").hidden = true;
    $("cmp-note-birthday").hidden = true;
    $("cmp-note-config").hidden = true;
    state.textContent = TEXTS.compare.error;
    state.hidden = false;
  }
}

$("cmp-back").addEventListener("click", () => showScreen(compareReturnTo));
$("intro-compare").addEventListener("click", () => openCompare("view-intro"));
$("result-compare").addEventListener("click", () => openCompare("view-result"));

// ==========================================================================
// ЭКРАН НЕЗАКОНЧЕННОГО ЗАМЕРА
// ==========================================================================

function renderResume(draft) {
  const done = Object.keys(draft.answers || {}).length;
  $("resume-title").textContent = TEXTS.resume.title;
  $("resume-text").textContent = TEXTS.resume.text;
  $("resume-progress").textContent = TEXTS.resume.progress
    .replace("{done}", done).replace("{total}", BLOCKS.length);

  const started = draft.started_at ? new Date(draft.started_at) : null;
  const days = started ? Math.floor((Date.now() - started.getTime()) / 86400000) : 0;
  $("resume-when").textContent = days < 1
    ? TEXTS.resume.whenToday
    : TEXTS.resume.whenDays.replace("{n}", days).replace("{days}", daysWord(days));

  $("resume-continue").textContent = TEXTS.resume.continue;
  $("resume-restart").textContent = TEXTS.resume.restart;

  $("resume-continue").onclick = () => {
    state.profile.age = draft.age;
    state.profile.sex = draft.sex;
    state.profile.who = draft.subject === "guest" ? "other" : "self";
    state.answers = draft.answers || {};
    state.index = Math.min(draft.block_index || 0, BLOCKS.length);
    goToBlock();
  };

  $("resume-restart").onclick = () => {
    try { BodyAgeApi.draftDrop({ subject: draft.subject || "self" }); } catch (e) {}
    showScreen("view-intro");
  };
}

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

$("result-save").addEventListener("click", saveMeasurement);

// ==========================================================================
// СТАРТ
// ==========================================================================
// Гейт первым делом: без доступа не должно отрисоваться ничего, кроме
// экрана блокировки. Дальше отложенный замер и предложение продолжить.

(async function init() {
  document.title = TEXTS.appTitle;
  renderIntro();
  renderSafety();

  const allowed = await IrenaAuth.checkAccess();
  if (!allowed) return;      // экран показал auth.js

  flushPending();            // молча и не дожидаясь

  // История для строк на входе. Не дожидаемся: экран входа не должен ждать
  // сети, строки появятся, когда ответ придёт. Ответ приезжает вместе с
  // ответами последнего замера, поэтому тап по строке открывает результат
  // сразу, без второго похода в сеть и без состояния загрузки.
  loadHistory();

  let draft = null;
  try {
    const data = await BodyAgeApi.draftGet({ subject: "self" });
    draft = data && data.draft;
  } catch (e) {
    // Черновик не критичен: не смогли прочитать - начинаем с чистого листа.
    console.error("draft_get:", e.message);
  }

  if (draft && draft.answers && Object.keys(draft.answers).length > 0) {
    renderResume(draft);
    showScreen("view-resume");
    return;
  }
  showScreen("view-intro");
})();
