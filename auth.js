// Возраст тела - auth.js
// Регистрирует:
//   window.IrenaAuth   - доступ в аппу: Дверь 2, ТГ-ветка, веб-ветка.
//   window.BodyAgeApi  - обёртка над edge-функцией bodyage-api.
//
// Структура взята из cycle/auth.js, ЛОГИКА проверки - из glutes.
// Разница принципиальная: в cycle на вебе наличие токена принимается за
// вердикт, и подделка localStorage открывает платное. Здесь на вебе вердикт
// даёт СЕРВЕР через verify-app-token, а обрыв связи трактуется fail-closed.
//
// Файл ничего не делает при загрузке: checkAccess() зовёт app.js.

(function () {
  const SUPABASE_FUNCTIONS = "https://kjzxrpwqyyjcykwbqskn.supabase.co/functions/v1";
  const VERIFY_URL = SUPABASE_FUNCTIONS + "/verify-access";        // ТГ: initData
  const APP_VERIFY_URL = SUPABASE_FUNCTIONS + "/verify-app-token"; // веб: токен
  const API_URL = SUPABASE_FUNCTIONS + "/bodyage-api";

  const TOKEN_KEY = "irena_access_token";
  const TOKEN_EXPIRES_KEY = "irena_access_token_expires_at";
  const SUBSCRIBE_URL = "https://t.me/Biochakirena_bot";
  const WEB_APP_URL = "https://app.irenabio.com/";

  const TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;
  const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

  // Три ПРЯМЫЕ попытки. Прокси /sb намеренно не подключён: он отражает любой
  // Origin, и тащить этот хвост в новый код на запуске незачем. Аудитория
  // приходит из Телеграма, там аппа грузится инфраструктурой самого Телеграма.
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAYS_MS = [1000, 2000];

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function $(id) { return document.getElementById(id); }

  // ===================== ТОКЕН =====================

  function getStoredToken() {
    try {
      const token = localStorage.getItem(TOKEN_KEY);
      const expiresAt = parseInt(localStorage.getItem(TOKEN_EXPIRES_KEY) || "0", 10);
      if (!token || !expiresAt) return null;
      if (Date.now() >= expiresAt - TOKEN_EXPIRY_BUFFER_MS) return null;
      return token;
    } catch {
      return null;
    }
  }

  function storeToken(token, ttlSeconds) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(TOKEN_EXPIRES_KEY, String(Date.now() + ttlSeconds * 1000));
    } catch {
      // приватный режим и прочие ограничения: молча живём без кэша
    }
  }

  function clearToken() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_EXPIRES_KEY);
    } catch {}
  }

  // ДВЕРЬ 2: веб-токен из фрагмента URL. Дословно как в cycle и glutes.
  // В Телеграме irena_token в хэше нет, значит здесь no-op и ТГ-ветку это
  // не задевает.
  function consumeWebToken() {
    try {
      let raw = window.location.hash || "";
      if (raw.charAt(0) === "#") raw = raw.slice(1);
      if (!raw) return false;
      const params = new URLSearchParams(raw);
      const token = params.get("irena_token");
      if (!token) return false;
      let ttl = parseInt(params.get("exp") || "0", 10);
      if (!ttl || ttl <= 0) ttl = 900; // реальный TTL задаёт mint-app-token
      storeToken(token, ttl);
      // вычистить токен из URL: чтобы не остался в истории и не ушёл ссылкой
      params.delete("irena_token");
      params.delete("exp");
      const rest = params.toString();
      window.history.replaceState(
        null, "",
        window.location.pathname + window.location.search + (rest ? "#" + rest : "")
      );
      return true;
    } catch {
      return false;
    }
  }

  function getInitData() {
    try {
      if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) {
        return window.Telegram.WebApp.initData;
      }
    } catch {}
    return null;
  }

  // ===================== ЭКРАНЫ =====================
  // Вёрстка своя, в стиле аппы: разметка лежит в index.html, стили в
  // style.css. Инлайновые простыни из glutes сюда не переносим.

  function hideAllScreens() {
    document.querySelectorAll(".screen").forEach(el => { el.hidden = true; });
  }

  function showChecking(show) {
    const el = $("view-gate");
    if (!el) return;
    if (show) {
      hideAllScreens();
      $("gate-title").textContent = TEXTS.gate.checking;
      $("gate-text").textContent = TEXTS.gate.checkingText;
    }
    el.hidden = !show;
  }

  // reason уходит в мелкую служебную строку внизу: женщине она не нужна,
  // а в переписке с поддержкой экономит полчаса.
  function showBlocked(reason) {
    const isTg = !!getInitData();
    hideAllScreens();
    $("blocked-icon").className = "ti ti-lock";
    $("blocked-title").textContent = TEXTS.blocked.title;
    $("blocked-text").textContent = isTg ? TEXTS.blocked.textTelegram : TEXTS.blocked.textWeb;
    const cta = $("blocked-cta");
    cta.textContent = isTg ? TEXTS.blocked.ctaTelegram : TEXTS.blocked.ctaWeb;
    cta.href = isTg ? SUBSCRIBE_URL : WEB_APP_URL;
    if (isTg) { cta.target = "_blank"; cta.rel = "noopener"; }
    else { cta.removeAttribute("target"); cta.removeAttribute("rel"); }
    $("blocked-retry").hidden = true;
    $("blocked-reason").textContent = reason || "";
    $("view-blocked").hidden = false;
  }

  // Fail-closed при обрыве: НЕ пускаем, но и не приговариваем. С подпиской
  // всё в порядке, до сервера не достучались - отсюда кнопка "Обновить".
  function showConnectionFail(reason) {
    hideAllScreens();
    $("blocked-icon").className = "ti ti-wifi-off";
    $("blocked-title").textContent = TEXTS.blocked.offlineTitle;
    $("blocked-text").textContent = TEXTS.blocked.offlineText;
    const cta = $("blocked-cta");
    cta.textContent = TEXTS.blocked.ctaWeb;
    cta.href = WEB_APP_URL;
    cta.hidden = true;
    const retry = $("blocked-retry");
    retry.textContent = TEXTS.blocked.retry;
    retry.hidden = false;
    retry.onclick = () => window.location.reload();
    $("blocked-reason").textContent = reason || "";
    $("view-blocked").hidden = false;
  }

  // ===================== ЗАПРОСЫ ВЕРДИКТА =====================

  // ТГ-ветка. Возвращает {res,data}, если сервер ОТВЕТИЛ любым статусом
  // (403 это вердикт, не повторяем), либо {networkError:true} после трёх
  // обрывов.
  async function requestVerifyInitData(initData) {
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(VERIFY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData }),
        });
        const data = await res.json().catch(() => ({}));
        return { res, data };
      } catch (e) {
        lastError = e;
        if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAYS_MS[attempt - 1]);
      }
    }
    console.error("verify-access: все попытки провалились:", lastError);
    return { networkError: true };
  }

  // Веб-ветка. 5xx это "вердикта нет" и повод повторить, 401 и 403 - вердикт.
  async function requestVerifyToken(token) {
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(APP_VERIFY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (res.status >= 500) throw new Error("server_5xx");
        const data = await res.json().catch(() => ({}));
        return { res, data };
      } catch (e) {
        lastError = e;
        if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAYS_MS[attempt - 1]);
      }
    }
    console.error("verify-app-token: все попытки провалились:", lastError);
    return { networkError: true };
  }

  // ===================== ГЛАВНАЯ ПРОВЕРКА =====================

  async function checkAccess() {
    consumeWebToken();                 // в ТГ no-op
    const cached = getStoredToken();
    const initData = getInitData();

    if (initData) {
      // ===== ТГ-ветка. Ровно как в glutes, verify-app-token отсюда
      // недостижим: там гейт src:"web", и ТГ-токены он отбивает. =====
      if (cached) return true;         // быстрый вход по живому токену
      showChecking(true);
      const result = await requestVerifyInitData(initData);
      showChecking(false);
      if (result.networkError) {
        showConnectionFail("network_error");
        return false;
      }
      const { res, data } = result;
      if (res.ok && data.ok && data.token) {
        storeToken(data.token, data.expiresIn || DEFAULT_TTL_SECONDS);
        return true;
      }
      const reason =
        res.status === 403 ? "not_a_member" :
        res.status === 401 ? "invalid_init_data" :
        "error_" + res.status;
      showBlocked(reason);
      return false;
    }

    // ===== ВЕБ-ветка. Наличие токена НЕ вердикт: подпись, exp и живую
    // подписку проверяет сервер. =====
    if (!cached) { showBlocked("no_web_token"); return false; }

    showChecking(true);
    const v = await requestVerifyToken(cached);
    showChecking(false);

    if (v.networkError) { showConnectionFail("network_error"); return false; }
    if (v.res.ok && v.data.ok) return true;

    // Сервер сказал НЕТ: токен крафтовый, протухший или подписки нет.
    // Мёртвый токен вычищаем, иначе он будет вечно водить по кругу.
    clearToken();
    showBlocked("web_" + ((v.data && v.data.reason) || ("error_" + v.res.status)));
    return false;
  }

  // ===================== BODYAGE API =====================

  async function request(action, payload) {
    const token = getStoredToken();
    if (!token) throw new Error("no_token");

    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token,
      },
      body: JSON.stringify({ action, payload: payload || {} }),
    });

    // 401 от функции: токен протух или подпись не сошлась. Экран блокировки
    // отсюда НЕ показываем намеренно. Веб-токен живёт 15 минут, а тест идёт
    // двадцать с лишним, и выбрасывать женщину из середины прохождения из-за
    // неудавшегося сохранения нельзя. Решение принимает app.js: черновик
    // молчит, готовый замер откладывается до следующего живого входа.
    if (res.status === 401) {
      clearToken();
      throw new Error("token_expired");
    }

    let body;
    try {
      body = await res.json();
    } catch {
      throw new Error("bad_response");
    }
    if (body && body.ok === true) return body.data;
    throw new Error((body && (body.reason || body.error)) || ("http_" + res.status));
  }

  // ===================== ЭКСПОРТ =====================

  if (typeof window !== "undefined") {
    window.IrenaAuth = {
      VERIFY_URL,
      APP_VERIFY_URL,
      TOKEN_KEY,
      TOKEN_EXPIRES_KEY,
      SUBSCRIBE_URL,
      WEB_APP_URL,
      getStoredToken,
      storeToken,
      clearToken,
      getInitData,
      consumeWebToken,
      showBlocked,
      showConnectionFail,
      checkAccess,
    };

    window.BodyAgeApi = {
      API_URL,
      request,
      draftGet:  p => request("draft_get", p),
      draftSave: p => request("draft_save", p),
      draftDrop: p => request("draft_drop", p),
      save:      p => request("save", p),
      list:      p => request("list", p),
      compare:   p => request("compare", p),
    };
  }
})();
