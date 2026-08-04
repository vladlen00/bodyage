-- ============================================================
-- Возраст тела: завершённые замеры и черновики
-- Доступ ТОЛЬКО через edge-функцию bodyage-api под service_role.
-- RLS включён и НИ ОДНОЙ политики: прямой REST с фронта закрыт
-- наглухо (deny-all), service_role RLS обходит.
-- ============================================================

create table if not exists public.bodyage_measurements (
  id               uuid primary key default gen_random_uuid(),

  -- sub из JWT. В Телеграме это telegram user id, на вебе person_id.
  -- Два разных пространства идентификаторов, поэтому рядом источник:
  -- без него будущее слияние идентичности сделать нечем.
  user_id          text        not null,
  id_source        text        not null check (id_source in ('telegram','web')),

  -- Свой замер или гостевой ("замерить кого-то ещё").
  -- Гостевой в историю как свой не идёт, фильтр по этой колонке.
  subject          text        not null default 'self' check (subject in ('self','guest')),

  -- Профиль на момент замера. Возраст меняется, поэтому хранится в строке.
  age              integer     not null check (age between 18 and 69),
  sex              text        not null check (sex in ('female','male')),

  -- Сырые ответы по блокам: { "pulse_rest": 62, "pulse_recovery": {...}, ... }
  -- null внутри = блок пропущен. Хранятся ИМЕННО сырые, чтобы после
  -- перекалибровки порогов старые замеры можно было пересчитать.
  answers          jsonb       not null,
  -- Баллы по блокам на момент замера: { "pulse_rest": 2, ... }
  scores           jsonb       not null,

  completed_blocks integer     not null check (completed_blocks between 0 and 7),
  score_sum        integer     not null check (score_sum >= 0),
  equivalent       integer,                 -- нормализованная сумма, null если возраст не считался

  -- При трёх и более пропусках возраст не показываем: цифры нет.
  has_age          boolean     not null,
  body_age         integer     check (body_age between 18 and 85),
  shift            integer,
  weakest_block    text,

  -- Версия шкалы. Пороги будут править после калибровки на живых людях,
  -- и без этой колонки сравнение старта с финалом соврёт.
  config_version   text        not null,

  started_at       timestamptz,             -- когда начали (переносится из черновика)
  created_at       timestamptz not null default now(),

  -- Цифра есть ровно тогда, когда есть возраст тела и сдвиг.
  constraint bodyage_age_consistent check (
    (has_age and body_age is not null and shift is not null)
    or (not has_age and body_age is null and shift is null)
  )
);

-- Список и сравнение всегда идут по одному человеку и одному субъекту,
-- свежие сверху.
create index if not exists bodyage_measurements_owner_idx
  on public.bodyage_measurements (user_id, subject, created_at desc);

alter table public.bodyage_measurements enable row level security;
revoke all on public.bodyage_measurements from anon, authenticated;


create table if not exists public.bodyage_drafts (
  user_id      text        not null,
  id_source    text        not null check (id_source in ('telegram','web')),
  -- Свой черновик и гостевой живут отдельными строками: проверка мужа
  -- не затирает её собственный старт. Это и есть первичный ключ.
  subject      text        not null default 'self' check (subject in ('self','guest')),

  age          integer     check (age between 18 and 69),
  sex          text        check (sex in ('female','male')),
  answers      jsonb       not null default '{}'::jsonb,
  block_index  integer     not null default 0 check (block_index between 0 and 7),

  started_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- Живёт 7 дней от ПОСЛЕДНЕГО касания: женщина меряет пульс утром в
  -- понедельник и возвращается в среду, черновик терять нельзя.
  -- Чтение фильтрует по expires_at, протухший черновик для приложения
  -- всё равно что отсутствует.
  expires_at   timestamptz not null,

  primary key (user_id, subject)
);

create index if not exists bodyage_drafts_expires_idx
  on public.bodyage_drafts (expires_at);

alter table public.bodyage_drafts enable row level security;
revoke all on public.bodyage_drafts from anon, authenticated;
