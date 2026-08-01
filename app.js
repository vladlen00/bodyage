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

function signalTimerEnd() {
  playTone(TIMER_SOUND.freq, TIMER_SOUND.durationMs, TIMER_SOUND.volume);
  try { if (navigator.vibrate) navigator.vibrate(TIMER_SOUND.vibratePattern); } catch (e) {}
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

async function openVideoAt(seconds) {
  const modal = document.getElementById("video-modal");
  const err = document.getElementById("video-error");
  err.hidden = true;
  modal.hidden = false;
  document.body.classList.add("no-scroll");
  try {
    const player = await getPlayer();
    await player.seekTo(seconds);
    await player.play();
  } catch (e) {
    // Сюда же прилетит ошибка домена, если Kinescope не пустит github.io.
    console.error("kinescope:", e);
    err.textContent = TEXTS.video.error;
    err.hidden = false;
  }
}

async function closeVideo() {
  document.getElementById("video-modal").hidden = true;
  document.body.classList.remove("no-scroll");
  try { if (kinescopePlayer) await kinescopePlayer.pause(); } catch (e) {}
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
  index: 0,                           // индекс блока в BLOCKS
};

function $(id) { return document.getElementById(id); }

function showScreen(id) {
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
  unlockAudio();
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
function goToBlock() {
  if (state.index >= BLOCKS.length) { finish(); return; }
  const block = BLOCKS[state.index];
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
  $("block-error").hidden = true;

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
        unlockAudio();
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

function renderInputs(block) {
  const cfg = SCORING[block.id];
  const single = $("input-single");
  const pair = $("input-pair");
  const checks = $("input-checks");

  single.hidden = true; pair.hidden = true; checks.hidden = true;

  if (cfg.input === "pulse_pair") {
    pair.hidden = false;
    $("input-peak-label").textContent = TEXTS.block.peakLabel;
    $("input-after-label").textContent = TEXTS.block.afterLabel;
    $("input-peak").value = "";
    $("input-after").value = "";
    return;
  }

  if (cfg.input === "checkboxes") {
    checks.hidden = false;
    state.floor = { descent: [], rise: [] };
    renderFloorChecks(cfg);
    return;
  }

  single.hidden = false;
  $("input-single-label").textContent = block.inputLabel;
  $("input-single-unit").textContent = block.inputUnit || "";
  $("input-single-value").value = "";
}

// Галочки вставания с пола. Взаимоисключение считает calc.js по флагу
// exclusive, здесь только перерисовка.
function renderFloorChecks(cfg) {
  const host = $("input-checks");
  host.innerHTML = "";

  cfg.halves.forEach(half => {
    const wrap = document.createElement("div");
    wrap.className = "half";

    const title = document.createElement("div");
    title.className = "half-title";
    title.textContent = half.label;
    wrap.appendChild(title);

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

    wrap.appendChild(row);
    host.appendChild(wrap);
  });

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
    return { ok: true, value: { peak, after } };
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
  const res = collectAnswer(block);
  if (!res.ok) {
    $("block-error").textContent = TEXTS.block.inputError;
    $("block-error").hidden = false;
    return;
  }
  blockTimer.stop();
  state.answers[block.id] = res.value;
  state.index += 1;
  goToBlock();
});

// Пропуск не штрафуется: причины бывают честные, поэтому просто null.
$("block-skip").addEventListener("click", () => {
  blockTimer.stop();
  state.answers[BLOCKS[state.index].id] = null;
  state.index += 1;
  goToBlock();
});

// ==========================================================================
// ЭКРАН РЕЗУЛЬТАТА
// ==========================================================================

function finish() {
  blockTimer.stop();
  restTimer.stop();
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
    $("result-verdict").textContent = r.title;

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

  $("result-disclaimer").textContent = TEXTS.result.disclaimer;

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
    if (b.skipped) li.className = "is-skipped";

    const name = document.createElement("span");
    name.className = "breakdown-name";
    name.textContent = b.title;

    const score = document.createElement("span");
    score.className = "breakdown-score";
    score.textContent = b.skipped
      ? TEXTS.result.blockSkipped
      : TEXTS.result.blockScore.replace("{score}", b.score).replace("{max}", MAX_SCORE_PER_BLOCK);

    li.appendChild(name);
    li.appendChild(score);
    list.appendChild(li);
  });

  $("result-restart").textContent = TEXTS.result.restart;
}

$("result-restart").addEventListener("click", () => {
  state.answers = {};
  state.floor = { descent: [], rise: [] };
  state.index = 0;
  state.restDone = false;
  showScreen("view-intro");
});

// ==========================================================================
// ОБЩЕЕ
// ==========================================================================

$("video-close").addEventListener("click", closeVideo);
$("video-modal").addEventListener("click", e => {
  if (e.target === $("video-modal")) closeVideo();
});

document.title = TEXTS.appTitle;
renderIntro();
renderSafety();
showScreen("view-intro");
