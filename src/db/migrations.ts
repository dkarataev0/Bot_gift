/**
 * Миграции схемы БД. Применяются автоматически при старте (src/db/migrate.ts),
 * каждая — ровно один раз (учёт в таблице schema_migrations).
 */
export const migrations: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'init',
    sql: `
CREATE TABLE IF NOT EXISTS collections (
  base              TEXT PRIMARY KEY,              -- slug коллекции в нижнем регистре, напр. 'plushpepe'
  title             TEXT,                          -- 'Plush Pepe'
  gift_id           TEXT,                          -- id обычного подарка (из MTProto), если известен
  head_num          INTEGER NOT NULL DEFAULT 0,    -- максимальный обработанный номер
  issued            INTEGER,                       -- выпущено (по данным источника)
  total             INTEGER,                       -- максимум возможных
  baseline_done     BOOLEAN NOT NULL DEFAULT FALSE,-- первичная загрузка выполнена (до неё уведомлений нет)
  head_confirmed_at TIMESTAMPTZ,                   -- когда последний раз подтверждено, что номера head+1 ещё нет
  last_checked_at   TIMESTAMPTZ,
  last_new_at       TIMESTAMPTZ,                   -- когда последний раз найден новый номер
  next_check_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  checks_count      BIGINT NOT NULL DEFAULT 0,
  errors_count      BIGINT NOT NULL DEFAULT 0,
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  discovered_by     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gifts (
  slug                 TEXT PRIMARY KEY,           -- 'plushpepe-123' (нижний регистр)
  collection           TEXT NOT NULL REFERENCES collections(base) ON DELETE CASCADE,
  num                  INTEGER NOT NULL,
  title                TEXT,
  model                TEXT,
  model_permille       INTEGER,
  model_tier           TEXT,
  backdrop             TEXT,
  backdrop_permille    INTEGER,
  backdrop_tier        TEXT,
  symbol               TEXT,
  symbol_permille      INTEGER,
  symbol_tier          TEXT,
  owner_name           TEXT,
  owner_username       TEXT,
  owner_id             BIGINT,
  owner_address        TEXT,
  on_sale              BOOLEAN,
  crafted              BOOLEAN,
  image_url            TEXT,
  issued               INTEGER,
  total                INTEGER,
  source               TEXT NOT NULL,
  first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (collection, num)
);
CREATE INDEX IF NOT EXISTS gifts_first_seen_idx ON gifts (first_seen_at DESC);
CREATE INDEX IF NOT EXISTS gifts_owner_username_idx ON gifts (lower(owner_username));
CREATE INDEX IF NOT EXISTS gifts_model_idx ON gifts (lower(model));

-- События. Уникальный dedup_key гарантирует, что одно событие не будет записано (и отправлено) дважды.
CREATE TABLE IF NOT EXISTS events (
  id             BIGSERIAL PRIMARY KEY,
  dedup_key      TEXT NOT NULL UNIQUE,
  gift_slug      TEXT NOT NULL REFERENCES gifts(slug) ON DELETE CASCADE,
  kind           TEXT NOT NULL,       -- upgrade | craft | transfer | resale_listed
  confidence     TEXT NOT NULL,       -- high | medium | low
  detected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_start   TIMESTAMPTZ,         -- событие произошло не раньше...
  window_end     TIMESTAMPTZ,         -- ...и не позже
  notify_status  TEXT NOT NULL DEFAULT 'pending', -- pending | done | skipped
  details        JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS events_detected_idx ON events (detected_at DESC);
CREATE INDEX IF NOT EXISTS events_pending_idx ON events (notify_status) WHERE notify_status = 'pending';

CREATE TABLE IF NOT EXISTS users (
  chat_id     BIGINT PRIMARY KEY,
  username    TEXT,
  is_owner    BOOLEAN NOT NULL DEFAULT FALSE,
  settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Факт отправки конкретного события конкретному пользователю (вторая линия защиты от дублей).
CREATE TABLE IF NOT EXISTS notifications (
  event_id    BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  chat_id     BIGINT NOT NULL REFERENCES users(chat_id) ON DELETE CASCADE,
  message_id  BIGINT,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, chat_id)
);

CREATE TABLE IF NOT EXISTS favorites (
  chat_id     BIGINT NOT NULL REFERENCES users(chat_id) ON DELETE CASCADE,
  gift_slug   TEXT NOT NULL REFERENCES gifts(slug) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_checked_at TIMESTAMPTZ,
  PRIMARY KEY (chat_id, gift_slug)
);

CREATE TABLE IF NOT EXISTS kv (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
  },
];
