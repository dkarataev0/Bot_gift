/**
 * Конфигурация приложения. Все секреты берутся ТОЛЬКО из переменных окружения.
 */

function str(name: string, def?: string): string | undefined {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return def;
  return v.trim();
}

function required(name: string): string {
  const v = str(name);
  if (!v) throw new Error(`Не задана обязательная переменная окружения ${name}`);
  return v;
}

function num(name: string, def: number): number {
  const v = str(name);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Переменная ${name} должна быть числом, получено "${v}"`);
  return n;
}

function bool(name: string, def: boolean): boolean {
  const v = str(name);
  if (v === undefined) return def;
  return ['1', 'true', 'yes', 'on', 'да'].includes(v.toLowerCase());
}

function idList(name: string): number[] {
  const v = str(name);
  if (!v) return [];
  return v
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((x) => Number(x))
    .filter((x) => Number.isSafeInteger(x) && x > 0);
}

export interface AppConfig {
  botToken: string;
  databaseUrl: string;
  databaseSsl: boolean;
  allowedUserIds: number[];
  port: number;
  timezone: string;
  logLevel: string;

  /** MTProto (пользовательский аккаунт) — необязательно, но нужен для username владельца */
  apiId?: number;
  apiHash?: string;
  /** Строка сессии mtcute (можно не задавать и войти через /login в боте) */
  tgSession?: string;
  /** Ключ шифрования сессии, сохранённой в БД через /login */
  sessionSecret?: string;

  /** Лимиты запросов */
  webMaxRps: number;
  webMinRps: number;
  webProbeMaxRps: number;
  mtprotoMaxRps: number;
  workers: number;

  /** Интервалы планировщика, мс */
  hotIntervalMs: number;
  warmIntervalMs: number;
  coldIntervalMs: number;
  maxFetchPerTick: number;

  /** Уведомления о «пропущенных» во время простоя подарках не отправляются, если окно больше этого */
  maxNotifyWindowMs: number;
  discoveryIntervalMs: number;
  favoritesRecheckMs: number;
  /** Сколько дней хранить историю подарков (избранные не удаляются) */
  retentionDays: number;
  /** Отправлять ли картинку подарка в уведомлении */
  sendImages: boolean;
}

export function loadConfig(): AppConfig {
  const apiIdRaw = str('TG_API_ID');
  return {
    botToken: required('BOT_TOKEN'),
    databaseUrl: required('DATABASE_URL'),
    databaseSsl: bool('DATABASE_SSL', true),
    allowedUserIds: idList('ALLOWED_USER_IDS'),
    port: num('PORT', 10000),
    timezone: str('TZ_DISPLAY', 'Europe/Moscow')!,
    logLevel: str('LOG_LEVEL', 'info')!,

    apiId: apiIdRaw ? Number(apiIdRaw) : undefined,
    apiHash: str('TG_API_HASH'),
    tgSession: str('TG_SESSION'),
    sessionSecret: str('SESSION_SECRET'),

    webMaxRps: num('WEB_MAX_RPS', 0.6),
    webMinRps: num('WEB_MIN_RPS', 0.08),
    webProbeMaxRps: num('WEB_PROBE_MAX_RPS', 1.5),
    mtprotoMaxRps: num('MTPROTO_MAX_RPS', 4),
    workers: num('WORKERS', 3),

    hotIntervalMs: num('HOT_INTERVAL_MS', 3_000),
    warmIntervalMs: num('WARM_INTERVAL_MS', 20_000),
    coldIntervalMs: num('COLD_INTERVAL_MS', 90_000),
    maxFetchPerTick: num('MAX_FETCH_PER_TICK', 25),

    maxNotifyWindowMs: num('MAX_NOTIFY_WINDOW_MS', 15 * 60_000),
    discoveryIntervalMs: num('DISCOVERY_INTERVAL_MS', 30 * 60_000),
    favoritesRecheckMs: num('FAVORITES_RECHECK_MS', 10 * 60_000),
    retentionDays: num('RETENTION_DAYS', 30),
    sendImages: bool('SEND_IMAGES', true),
  };
}
