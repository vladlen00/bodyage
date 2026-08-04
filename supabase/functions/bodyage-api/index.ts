// Supabase Edge Function: bodyage-api
// Черновики и завершённые замеры возраста тела.
// Написана по образцу cycles-api: авторизация ручная (verify_jwt=false),
// service_role для обхода RLS, защита - явный фильтр user_id из JWT в
// КАЖДОМ запросе к PostgREST.
//
// Деплой ТОЛЬКО:
//   npx supabase functions deploy bodyage-api --project-ref kjzxrpwqyyjcykwbqskn --no-verify-jwt
// MCP-деплой сбрасывает verify_jwt в true и ломает собственную авторизацию.

const SUPPORTED_ACTIONS = [
  "draft_get",
  "draft_save",
  "draft_drop",
  "save",
  "list",
  "compare",
] as const;
type Action = typeof SUPPORTED_ACTIONS[number];

const MEASUREMENTS = "bodyage_measurements";
const DRAFTS = "bodyage_drafts";

// Звёздочки нет нигде: колонки перечислены явно.
// answers в список НЕ входит: он крупный и на экране истории не нужен.
const MEASUREMENT_LIST_COLUMNS =
  "id,created_at,started_at,subject,age,sex,has_age,body_age,shift," +
  "score_sum,completed_blocks,equivalent,weakest_block,scores,config_version";
const MEASUREMENT_FULL_COLUMNS = MEASUREMENT_LIST_COLUMNS + ",answers";
const DRAFT_COLUMNS = "subject,age,sex,answers,block_index,started_at,updated_at,expires_at";

// Блоки теста. Ключи ответов и баллов обязаны лежать внутри этого списка:
// чужой ключ в jsonb - либо баг клиента, либо чья-то самодеятельность.
const BLOCK_IDS = [
  "pulse_rest",
  "balance_open",
  "balance_closed",
  "pulse_recovery",
  "pushups",
  "chair_stand",
  "floor_rise",
];
const BLOCK_COUNT = 7;
const MAX_SCORE_PER_BLOCK = 3;

const DRAFT_TTL_DAYS = 7;          // живёт 7 дней от ПОСЛЕДНЕГО касания
const DEFAULT_LIST_LIMIT = 12;
const MAX_LIST_LIMIT = 50;
const MAX_JSON_CHARS = 4000;       // потолок на answers и scores разом
const MAX_OPTION_IDS = 20;         // отметок в одной половине вставания с пола

// app.irenabio.com добавлен намеренно: в cycles-api его нет, а веб-подписчица
// приходит именно оттуда. Прокси /sb не подключаем: он отражает любой Origin.
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/app\.irenabio\.com$/,
  /\.github\.io$/,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https:\/\/web\.telegram\.org$/,
  /^https:\/\/t\.me$/,
];

function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(url.host) || re.test(url.origin));
  } catch {
    return false;
  }
}

// ==========================================================================
// BASE64URL И JWT
// ==========================================================================

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const base64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64urlEncode(data: Uint8Array): string {
  let bin = "";
  for (const b of data) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// Ручная HS256, как в cycles-api. Порядок: подпись, exp, sub, потом src.
async function verifyJWT(
  token: string,
  secret: string
): Promise<{ valid: boolean; sub?: string; idSource?: string; reason?: string }> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return { valid: false, reason: "malformed" };
    const [headerB64, payloadB64, sigB64] = parts;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const expectedBuf = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${headerB64}.${payloadB64}`)
    );
    if (b64urlEncode(new Uint8Array(expectedBuf)) !== sigB64) {
      return { valid: false, reason: "invalid_signature" };
    }

    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp <= now) {
      return { valid: false, reason: "expired" };
    }
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      return { valid: false, reason: "no_sub" };
    }

    // Телеграм-токен (verify-access) идёт без src, веб-токен (mint-app-token)
    // приходит с src:"web". Третьего варианта быть не должно: неизвестное
    // значение - это не наш токен, разговор окончен.
    let idSource: string;
    if (payload.src === undefined || payload.src === null) {
      idSource = "telegram";
    } else if (payload.src === "web") {
      idSource = "web";
    } else {
      return { valid: false, reason: "unknown_src" };
    }

    return { valid: true, sub: payload.sub, idSource };
  } catch (e) {
    console.error("verifyJWT error:", e);
    return { valid: false, reason: "malformed" };
  }
}

// ==========================================================================
// CORS И ОТВЕТЫ
// ==========================================================================

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin || "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function okResponse(origin: string | null, data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

function errorResponse(
  origin: string | null,
  status: number,
  error: string,
  reason?: string,
  details?: string
): Response {
  const body: Record<string, unknown> = { ok: false, error };
  if (reason) body.reason = reason;
  if (details) body.details = details;
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

// ==========================================================================
// POSTGREST
// ==========================================================================

// @ts-ignore Deno runtime
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
// @ts-ignore Deno runtime
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

async function supabaseFetchJson(path: string, options: RequestInit = {}): Promise<unknown> {
  const res = await fetch(SUPABASE_URL + path, {
    ...options,
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE_KEY!,
      "Authorization": "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`supabase ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ==========================================================================
// ВАЛИДАТОРЫ
// ==========================================================================

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

function isSex(v: unknown): v is string {
  return v === "female" || v === "male";
}

function isSubject(v: unknown): v is string {
  return v === "self" || v === "guest";
}

function isUuid(v: unknown): v is string {
  return typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function isBlockId(v: unknown): v is string {
  return typeof v === "string" && BLOCK_IDS.includes(v);
}

// Список отметок одной половины вставания с пола. Каталог опций живёт в
// конфиге фронта, дублировать его здесь нельзя (разъедется), поэтому
// проверяем форму: короткие безопасные идентификаторы, немного и без мусора.
function isOptionIdList(v: unknown): boolean {
  return Array.isArray(v)
    && v.length <= MAX_OPTION_IDS
    && v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 32 && /^[a-z_]+$/.test(x));
}

// Один ответ. null = блок пропущен.
function isAnswerValue(blockId: string, v: unknown): boolean {
  if (v === null) return true;
  if (typeof v === "number") return isInt(v, 0, 1000);
  if (typeof v !== "object") return false;

  const o = v as Record<string, unknown>;
  if (blockId === "pulse_recovery") {
    return Object.keys(o).length === 2 && isInt(o.peak, 0, 300) && isInt(o.after, 0, 300);
  }
  if (blockId === "floor_rise") {
    return Object.keys(o).length === 2 && isOptionIdList(o.descent) && isOptionIdList(o.rise);
  }
  return false;
}

// answers целиком. partial=true для черновика: там ответов может не быть вовсе.
function validateAnswers(v: unknown, partial: boolean): string | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return "invalid_answers";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (!partial && keys.length !== BLOCK_COUNT) return "answers_incomplete";
  if (keys.length > BLOCK_COUNT) return "invalid_answers";
  for (const k of keys) {
    if (!isBlockId(k)) return "unknown_block";
    if (!isAnswerValue(k, o[k])) return "invalid_answer_value";
  }
  if (JSON.stringify(o).length > MAX_JSON_CHARS) return "answers_too_big";
  return null;
}

// scores: балл 0..3 или null у пропущенного блока.
function validateScores(v: unknown): string | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return "invalid_scores";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== BLOCK_COUNT) return "scores_incomplete";
  for (const k of keys) {
    if (!isBlockId(k)) return "unknown_block";
    const s = o[k];
    if (s !== null && !isInt(s, 0, MAX_SCORE_PER_BLOCK)) return "invalid_score_value";
  }
  if (JSON.stringify(o).length > MAX_JSON_CHARS) return "scores_too_big";
  return null;
}

// Пороги и формулу считает фронт: конфиг и calc.js живут там, и второй
// экземпляр той же арифметики здесь неизбежно разъедется. Зато две проверки
// сходимости делаются без единого порога и ловят мусор на входе.
function checkTotalsConsistent(
  scores: Record<string, number | null>,
  completedBlocks: number,
  scoreSum: number
): string | null {
  const values = BLOCK_IDS.map((id) => scores[id]);
  const done = values.filter((s) => s !== null && s !== undefined) as number[];
  if (done.length !== completedBlocks) return "completed_blocks_mismatch";
  const sum = done.reduce((a, b) => a + b, 0);
  if (sum !== scoreSum) return "score_sum_mismatch";
  return null;
}

// ==========================================================================
// ЧЕРНОВИК
// ==========================================================================

function draftExpiryISO(): string {
  return new Date(Date.now() + DRAFT_TTL_DAYS * 86400000).toISOString();
}

// Протухшие черновики этого человека убираем при каждом обращении: отдельная
// уборка по расписанию ради одной таблицы не нужна.
async function purgeExpiredDrafts(userId: string): Promise<void> {
  try {
    const params = new URLSearchParams();
    params.set("user_id", `eq.${userId}`);
    params.set("expires_at", `lt.${new Date().toISOString()}`);
    await supabaseFetchJson(`/rest/v1/${DRAFTS}?${params.toString()}`, { method: "DELETE" });
  } catch (e) {
    // Уборка не критична: чтение всё равно фильтрует по expires_at.
    console.error("purgeExpiredDrafts:", (e as Error).message);
  }
}

async function handleDraftGet(
  origin: string | null,
  userId: string,
  payload: any
): Promise<Response> {
  const subject = payload?.subject === undefined ? "self" : payload.subject;
  if (!isSubject(subject)) return errorResponse(origin, 400, "Invalid subject", "invalid_subject");

  await purgeExpiredDrafts(userId);

  const params = new URLSearchParams();
  params.set("user_id", `eq.${userId}`);
  params.set("subject", `eq.${subject}`);
  params.set("expires_at", `gt.${new Date().toISOString()}`);
  params.set("select", DRAFT_COLUMNS);
  params.set("limit", "1");

  try {
    const data = await supabaseFetchJson(`/rest/v1/${DRAFTS}?${params.toString()}`);
    const arr = Array.isArray(data) ? data : [];
    return okResponse(origin, { draft: arr[0] ?? null });
  } catch (e) {
    return errorResponse(origin, 500, "Supabase error", "supabase_error", (e as Error).message);
  }
}

async function handleDraftSave(
  origin: string | null,
  userId: string,
  idSource: string,
  payload: any
): Promise<Response> {
  if (!payload || typeof payload !== "object") {
    return errorResponse(origin, 400, "Missing payload", "missing_payload");
  }

  const subject = payload.subject === undefined ? "self" : payload.subject;
  if (!isSubject(subject)) return errorResponse(origin, 400, "Invalid subject", "invalid_subject");

  if (payload.age !== undefined && payload.age !== null && !isInt(payload.age, 18, 69)) {
    return errorResponse(origin, 400, "Invalid age", "invalid_age");
  }
  if (payload.sex !== undefined && payload.sex !== null && !isSex(payload.sex)) {
    return errorResponse(origin, 400, "Invalid sex", "invalid_sex");
  }
  if (payload.block_index !== undefined && !isInt(payload.block_index, 0, BLOCK_COUNT)) {
    return errorResponse(origin, 400, "Invalid block_index", "invalid_block_index");
  }

  const answers = payload.answers === undefined ? {} : payload.answers;
  const answersError = validateAnswers(answers, true);
  if (answersError) return errorResponse(origin, 400, "Invalid answers", answersError);

  // started_at в теле НЕТ намеренно: при upsert по конфликту PostgREST
  // обновляет только присланные колонки, поэтому дата старта переживает
  // сохранение, а на вставке берётся из default.
  const body = {
    user_id: userId,
    id_source: idSource,
    subject,
    age: payload.age ?? null,
    sex: payload.sex ?? null,
    answers,
    block_index: payload.block_index ?? 0,
    updated_at: new Date().toISOString(),
    expires_at: draftExpiryISO(),
  };

  try {
    const data = await supabaseFetchJson(
      `/rest/v1/${DRAFTS}?on_conflict=user_id,subject&select=${DRAFT_COLUMNS}`,
      {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(body),
      }
    );
    const arr = Array.isArray(data) ? data : [];
    return okResponse(origin, { draft: arr[0] ?? null });
  } catch (e) {
    return errorResponse(origin, 500, "Supabase error", "supabase_error", (e as Error).message);
  }
}

async function handleDraftDrop(
  origin: string | null,
  userId: string,
  payload: any
): Promise<Response> {
  const subject = payload?.subject === undefined ? "self" : payload.subject;
  if (!isSubject(subject)) return errorResponse(origin, 400, "Invalid subject", "invalid_subject");

  const params = new URLSearchParams();
  params.set("user_id", `eq.${userId}`);
  params.set("subject", `eq.${subject}`);
  params.set("select", "subject");

  try {
    const data = await supabaseFetchJson(`/rest/v1/${DRAFTS}?${params.toString()}`, {
      method: "DELETE",
      headers: { "Prefer": "return=representation" },
    });
    const arr = Array.isArray(data) ? data : [];
    return okResponse(origin, { dropped: arr.length > 0 });
  } catch (e) {
    return errorResponse(origin, 500, "Supabase error", "supabase_error", (e as Error).message);
  }
}

// ==========================================================================
// ЗАВЕРШЁННЫЙ ЗАМЕР
// ==========================================================================

async function handleSave(
  origin: string | null,
  userId: string,
  idSource: string,
  payload: any
): Promise<Response> {
  if (!payload || typeof payload !== "object") {
    return errorResponse(origin, 400, "Missing payload", "missing_payload");
  }

  const subject = payload.subject === undefined ? "self" : payload.subject;
  if (!isSubject(subject)) return errorResponse(origin, 400, "Invalid subject", "invalid_subject");

  if (!isInt(payload.age, 18, 69)) return errorResponse(origin, 400, "Invalid age", "invalid_age");
  if (!isSex(payload.sex)) return errorResponse(origin, 400, "Invalid sex", "invalid_sex");

  const answersError = validateAnswers(payload.answers, false);
  if (answersError) return errorResponse(origin, 400, "Invalid answers", answersError);

  const scoresError = validateScores(payload.scores);
  if (scoresError) return errorResponse(origin, 400, "Invalid scores", scoresError);

  if (!isInt(payload.completed_blocks, 0, BLOCK_COUNT)) {
    return errorResponse(origin, 400, "Invalid completed_blocks", "invalid_completed_blocks");
  }
  if (!isInt(payload.score_sum, 0, BLOCK_COUNT * MAX_SCORE_PER_BLOCK)) {
    return errorResponse(origin, 400, "Invalid score_sum", "invalid_score_sum");
  }
  const totalsError = checkTotalsConsistent(
    payload.scores,
    payload.completed_blocks,
    payload.score_sum
  );
  if (totalsError) return errorResponse(origin, 400, "Totals mismatch", totalsError);

  if (typeof payload.has_age !== "boolean") {
    return errorResponse(origin, 400, "Invalid has_age", "invalid_has_age");
  }
  // Цифра есть ровно тогда, когда есть возраст тела и сдвиг. То же самое
  // сторожит constraint в базе, но отдать 400 понятнее, чем 500 из PostgREST.
  if (payload.has_age) {
    if (!isInt(payload.body_age, 18, 85)) {
      return errorResponse(origin, 400, "Invalid body_age", "invalid_body_age");
    }
    if (!isInt(payload.shift, -40, 40)) {
      return errorResponse(origin, 400, "Invalid shift", "invalid_shift");
    }
  } else if (payload.body_age !== undefined && payload.body_age !== null) {
    return errorResponse(origin, 400, "body_age without has_age", "body_age_unexpected");
  }

  if (payload.equivalent !== undefined && payload.equivalent !== null
      && !isInt(payload.equivalent, 0, 100)) {
    return errorResponse(origin, 400, "Invalid equivalent", "invalid_equivalent");
  }
  if (payload.weakest_block !== undefined && payload.weakest_block !== null
      && !isBlockId(payload.weakest_block)) {
    return errorResponse(origin, 400, "Invalid weakest_block", "invalid_weakest_block");
  }
  if (typeof payload.config_version !== "string"
      || payload.config_version.length === 0
      || payload.config_version.length > 32) {
    return errorResponse(origin, 400, "Invalid config_version", "invalid_config_version");
  }

  const body = {
    user_id: userId,
    id_source: idSource,
    subject,
    age: payload.age,
    sex: payload.sex,
    answers: payload.answers,
    scores: payload.scores,
    completed_blocks: payload.completed_blocks,
    score_sum: payload.score_sum,
    equivalent: payload.equivalent ?? null,
    has_age: payload.has_age,
    body_age: payload.has_age ? payload.body_age : null,
    shift: payload.has_age ? payload.shift : null,
    weakest_block: payload.weakest_block ?? null,
    config_version: payload.config_version,
    started_at: null as string | null,
  };

  // Дату старта берём из черновика, а не из клиентских часов.
  try {
    const params = new URLSearchParams();
    params.set("user_id", `eq.${userId}`);
    params.set("subject", `eq.${subject}`);
    params.set("select", "started_at");
    params.set("limit", "1");
    const draft = await supabaseFetchJson(`/rest/v1/${DRAFTS}?${params.toString()}`);
    const darr = Array.isArray(draft) ? draft : [];
    if (darr[0] && typeof darr[0].started_at === "string") body.started_at = darr[0].started_at;
  } catch (e) {
    console.error("save: draft lookup failed:", (e as Error).message);
  }

  let saved: any = null;
  try {
    const data = await supabaseFetchJson(
      `/rest/v1/${MEASUREMENTS}?select=${MEASUREMENT_LIST_COLUMNS}`,
      {
        method: "POST",
        headers: { "Prefer": "return=representation" },
        body: JSON.stringify(body),
      }
    );
    const arr = Array.isArray(data) ? data : [];
    saved = arr[0] ?? null;
  } catch (e) {
    return errorResponse(origin, 500, "Supabase error", "supabase_error", (e as Error).message);
  }

  // Порядок важен: сперва замер лёг в историю, только потом чистим черновик.
  // Если уборка не удалась, черновик протухнет сам или будет перезаписан
  // следующим стартом, а дублей в истории не появится.
  try {
    const params = new URLSearchParams();
    params.set("user_id", `eq.${userId}`);
    params.set("subject", `eq.${subject}`);
    await supabaseFetchJson(`/rest/v1/${DRAFTS}?${params.toString()}`, { method: "DELETE" });
  } catch (e) {
    console.error("save: draft cleanup failed:", (e as Error).message);
  }

  return okResponse(origin, { measurement: saved });
}

async function handleList(
  origin: string | null,
  userId: string,
  payload: any
): Promise<Response> {
  const subject = payload?.subject === undefined ? "self" : payload.subject;
  if (!isSubject(subject)) return errorResponse(origin, 400, "Invalid subject", "invalid_subject");

  let limit = DEFAULT_LIST_LIMIT;
  if (payload?.limit !== undefined) {
    if (!isInt(payload.limit, 1, MAX_LIST_LIMIT)) {
      return errorResponse(origin, 400, "Invalid limit", "invalid_limit");
    }
    limit = payload.limit;
  }

  const params = new URLSearchParams();
  params.set("user_id", `eq.${userId}`);
  params.set("subject", `eq.${subject}`);
  params.set("order", "created_at.desc");
  params.set("limit", String(limit));
  params.set("select", MEASUREMENT_LIST_COLUMNS);

  try {
    const data = await supabaseFetchJson(`/rest/v1/${MEASUREMENTS}?${params.toString()}`);
    return okResponse(origin, { measurements: Array.isArray(data) ? data : [] });
  } catch (e) {
    return errorResponse(origin, 500, "Supabase error", "supabase_error", (e as Error).message);
  }
}

// Сравнение двух замеров. Без id берём самый первый и самый последний:
// это и есть "старт и финал спринта".
async function handleCompare(
  origin: string | null,
  userId: string,
  payload: any
): Promise<Response> {
  const subject = payload?.subject === undefined ? "self" : payload.subject;
  if (!isSubject(subject)) return errorResponse(origin, 400, "Invalid subject", "invalid_subject");

  const wantIds = payload?.from_id !== undefined || payload?.to_id !== undefined;
  if (wantIds && (!isUuid(payload.from_id) || !isUuid(payload.to_id))) {
    return errorResponse(origin, 400, "Invalid id", "invalid_id");
  }

  try {
    let first: any = null;
    let last: any = null;

    if (wantIds) {
      const params = new URLSearchParams();
      params.set("user_id", `eq.${userId}`);
      params.set("id", `in.(${payload.from_id},${payload.to_id})`);
      params.set("select", MEASUREMENT_FULL_COLUMNS);
      const data = await supabaseFetchJson(`/rest/v1/${MEASUREMENTS}?${params.toString()}`);
      const arr = Array.isArray(data) ? data : [];
      first = arr.find((r: any) => r.id === payload.from_id) ?? null;
      last = arr.find((r: any) => r.id === payload.to_id) ?? null;
    } else {
      const base = new URLSearchParams();
      base.set("user_id", `eq.${userId}`);
      base.set("subject", `eq.${subject}`);
      base.set("select", MEASUREMENT_FULL_COLUMNS);
      base.set("limit", "1");

      const oldest = new URLSearchParams(base);
      oldest.set("order", "created_at.asc");
      const newest = new URLSearchParams(base);
      newest.set("order", "created_at.desc");

      const [a, b] = await Promise.all([
        supabaseFetchJson(`/rest/v1/${MEASUREMENTS}?${oldest.toString()}`),
        supabaseFetchJson(`/rest/v1/${MEASUREMENTS}?${newest.toString()}`),
      ]);
      first = (Array.isArray(a) ? a : [])[0] ?? null;
      last = (Array.isArray(b) ? b : [])[0] ?? null;
    }

    if (!first || !last) {
      return okResponse(origin, { first: null, last: null, blocks: [], same: false });
    }
    // Один и тот же замер сравнивать не с чем: пусть фронт скажет об этом прямо.
    const same = first.id === last.id;

    const blocks = BLOCK_IDS.map((id) => {
      const from = first.scores?.[id] ?? null;
      const to = last.scores?.[id] ?? null;
      return {
        id,
        from,
        to,
        delta: from === null || to === null ? null : to - from,
      };
    });

    return okResponse(origin, {
      first,
      last,
      blocks,
      same,
      // Пороги между замерами могли поменяться. Молчать об этом нельзя:
      // одинаковый результат дал бы разные баллы, и сравнение соврёт.
      config_changed: first.config_version !== last.config_version,
    });
  } catch (e) {
    return errorResponse(origin, 500, "Supabase error", "supabase_error", (e as Error).message);
  }
}

// ==========================================================================
// ГЛАВНЫЙ ОБРАБОТЧИК
// ==========================================================================

// @ts-ignore Deno runtime
Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  // 0. CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }

  // 1. Метод
  if (req.method !== "POST") {
    return errorResponse(origin, 405, "Method not allowed", "method_not_allowed");
  }

  // 2. Origin
  if (!isOriginAllowed(origin)) {
    return errorResponse(origin, 403, "Origin not allowed", "origin_not_allowed");
  }

  // 3. Окружение
  // @ts-ignore Deno runtime
  const jwtSecret = Deno.env.get("JWT_SECRET");
  if (!jwtSecret || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return errorResponse(origin, 500, "Server misconfigured", "server_misconfigured");
  }

  // 4. Заголовок авторизации
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return errorResponse(origin, 401, "Missing Authorization header", "missing_auth_header");
  }
  const token = authHeader.slice("Bearer ".length).trim();

  // 5. JWT
  const verified = await verifyJWT(token, jwtSecret);
  if (!verified.valid || !verified.sub || !verified.idSource) {
    return errorResponse(origin, 401, "Invalid token", verified.reason);
  }
  const userId = verified.sub;
  const idSource = verified.idSource;

  // 6. Тело
  let body: any;
  try {
    body = await req.json();
  } catch {
    return errorResponse(origin, 400, "Invalid JSON body", "bad_json");
  }

  // 7. Действие
  const action = body?.action;
  if (typeof action !== "string" || action.length === 0) {
    return errorResponse(origin, 400, "Missing action", "missing_action");
  }
  if (!SUPPORTED_ACTIONS.includes(action as Action)) {
    return errorResponse(origin, 400, "Unknown action", "unknown_action");
  }

  // 8. Диспетч
  const payload = body?.payload ?? {};
  switch (action as Action) {
    case "draft_get":  return handleDraftGet(origin, userId, payload);
    case "draft_save": return handleDraftSave(origin, userId, idSource, payload);
    case "draft_drop": return handleDraftDrop(origin, userId, payload);
    case "save":       return handleSave(origin, userId, idSource, payload);
    case "list":       return handleList(origin, userId, payload);
    case "compare":    return handleCompare(origin, userId, payload);
  }

  return errorResponse(origin, 500, "Internal error", "unreachable");
});
