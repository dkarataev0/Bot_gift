/** Редкость атрибута: permille = доля в тысячных (10 = 1%), tier — для «крафтовых» атрибутов без процента */
export interface GiftAttribute {
  name: string;
  permille: number | null;
  tier: string | null;
}

/** Нормализованные публичные данные коллекционного подарка (не зависит от источника) */
export interface GiftInfo {
  /** slug в нижнем регистре: 'plushpepe-1' */
  slug: string;
  /** база коллекции в нижнем регистре: 'plushpepe' */
  collection: string;
  num: number;
  title: string | null;
  model: GiftAttribute | null;
  backdrop: GiftAttribute | null;
  symbol: GiftAttribute | null;
  /** Отображаемое имя владельца (как в профиле), если публично */
  ownerName: string | null;
  /** Публичный username владельца (без @), если есть */
  ownerUsername: string | null;
  ownerId: number | null;
  /** TON-адрес, если подарок выведен в блокчейн */
  ownerAddress: string | null;
  /** Выставлен на продажу (известно только из MTProto) */
  onSale: boolean | null;
  /** Создан крафтом, а не улучшением (известно только из MTProto) */
  crafted: boolean | null;
  burned: boolean | null;
  issued: number | null;
  total: number | null;
  imageUrl: string | null;
  source: SourceName;
}

export type SourceName = 'web' | 'mtproto';

export type FetchResult =
  | { status: 'found'; gift: GiftInfo }
  | { status: 'not_found' }
  /** Временная ошибка/ограничение — повторить позже, НЕ считать отсутствием подарка */
  | { status: 'unavailable'; reason: string; retryAfterMs?: number };

export interface GiftSource {
  readonly name: SourceName;
  isReady(): boolean;
  /**
   * mode='probe' — проверка существования следующего номера (обычно ответ «нет»);
   * для web-источника такие запросы ограничиваются отдельно и мягче, чем загрузка страниц.
   */
  fetchGift(slug: string, mode?: FetchMode): Promise<FetchResult>;
}

export type FetchMode = 'probe' | 'page';

export type EventKind = 'upgrade' | 'craft' | 'transfer' | 'resale_listed';
export type Confidence = 'high' | 'medium' | 'low';

export interface CollectionState {
  base: string;
  title: string | null;
  headNum: number;
  issued: number | null;
  total: number | null;
  baselineDone: boolean;
  headConfirmedAt: Date | null;
  lastCheckedAt: Date | null;
  lastNewAt: Date | null;
  nextCheckAt: Date;
  checksCount: number;
  enabled: boolean;
}

export interface GiftEvent {
  id: number;
  dedupKey: string;
  giftSlug: string;
  kind: EventKind;
  confidence: Confidence;
  detectedAt: Date;
  windowStart: Date | null;
  windowEnd: Date | null;
  details: Record<string, unknown>;
}

export interface UserSettings {
  /** Получать уведомления */
  enabled: boolean;
  /** 'all' — все коллекции кроме отключённых; 'selected' — только выбранные */
  mode: 'all' | 'selected';
  selected: string[];
  muted: string[];
  onlyWithUsername: boolean;
  /** Пустой список — любые модели. Сравнение без учёта регистра. */
  models: string[];
  /** Порог редкости в промилле (10 = 1%). null — без фильтра */
  maxPermille: number | null;
  rarityAttr: 'any' | 'model' | 'backdrop' | 'symbol';
  includeCrafted: boolean;
  notifyNewCollections: boolean;
  notifyFavoritesChanges: boolean;
  tradeTemplate: string;
}

export const DEFAULT_TRADE_TEMPLATE =
  'Привет! Увидел твой коллекционный подарок {gift}. Интересен обмен? Могу предложить свои варианты.';

export const DEFAULT_SETTINGS: UserSettings = {
  enabled: true,
  mode: 'all',
  selected: [],
  muted: [],
  onlyWithUsername: false,
  models: [],
  maxPermille: null,
  rarityAttr: 'any',
  includeCrafted: true,
  notifyNewCollections: true,
  notifyFavoritesChanges: true,
  tradeTemplate: DEFAULT_TRADE_TEMPLATE,
};

export function normalizeSettings(raw: unknown): UserSettings {
  const s = { ...DEFAULT_SETTINGS, ...((raw as Partial<UserSettings>) ?? {}) };
  s.selected = Array.isArray(s.selected) ? s.selected.map(String) : [];
  s.muted = Array.isArray(s.muted) ? s.muted.map(String) : [];
  s.models = Array.isArray(s.models) ? s.models.map(String) : [];
  if (s.mode !== 'all' && s.mode !== 'selected') s.mode = 'all';
  if (!['any', 'model', 'backdrop', 'symbol'].includes(s.rarityAttr)) s.rarityAttr = 'any';
  if (typeof s.tradeTemplate !== 'string' || !s.tradeTemplate.trim()) s.tradeTemplate = DEFAULT_TRADE_TEMPLATE;
  return s;
}

/** 'PlushPepe-12' -> { collection: 'plushpepe', num: 12 } */
export function parseSlug(slug: string): { collection: string; num: number } | null {
  const m = /^([A-Za-z0-9]+)-(\d+)$/.exec(slug.trim());
  if (!m) return null;
  return { collection: m[1]!.toLowerCase(), num: Number(m[2]) };
}

export function makeSlug(collection: string, num: number): string {
  return `${collection.toLowerCase()}-${num}`;
}
