/**
 * Источник «mtproto»: официальный MTProto API Telegram через библиотеку mtcute (слой 223).
 * Метод payments.getUniqueStarGift(slug) возвращает полные публичные данные подарка,
 * включая владельца (owner_id + объект пользователя с username), флаги crafted/burned
 * и цену перепродажи. Метод доступен ТОЛЬКО пользовательским аккаунтам (не ботам) —
 * поэтому нужна сессия аккаунта (рекомендуется отдельный, второстепенный аккаунт).
 * Используются только публичные данные — то же, что видно в приложении Telegram.
 */
import { MemoryStorage, TelegramClient, tl } from '@mtcute/node';
import { logger } from '../logger.js';
import type { FetchResult, GiftAttribute, GiftInfo, GiftSource } from '../types.js';
import { parseSlug } from '../types.js';
import { AdaptiveRateLimiter } from '../util/rateLimiter.js';
import { SourceHealth } from './health.js';
import { webImageUrl } from './web.js';

const NOT_FOUND_ERRORS = new Set(['STARGIFT_SLUG_INVALID', 'STARGIFT_NOT_FOUND', 'STARGIFT_INVALID']);

function createClient(apiId: number, apiHash: string): TelegramClient {
  return new TelegramClient({
    apiId,
    apiHash,
    storage: new MemoryStorage(),
    updates: false,
    logLevel: 1, // только ошибки
  });
}

function mapRarity(r: tl.TypeStarGiftAttributeRarity | undefined, legacyPermille?: number): Pick<GiftAttribute, 'permille' | 'tier'> {
  if (!r) return { permille: legacyPermille ?? null, tier: null };
  if (r._ === 'starGiftAttributeRarity') return { permille: r.permille, tier: null };
  return { permille: null, tier: r._.replace('starGiftAttributeRarity', '').toLowerCase() };
}

type AnyPeerObj = { _: string; id: number; username?: string; usernames?: tl.TypeUsername[]; firstName?: string; lastName?: string; title?: string };

function activeUsername(o: AnyPeerObj | undefined): string | null {
  if (!o) return null;
  if (o.username) return o.username;
  const u = o.usernames?.find((x) => x.active);
  return u?.username ?? null;
}

/** Преобразование ответа payments.uniqueStarGift в GiftInfo (вынесено для тестов) */
export function mapUniqueGift(res: tl.payments.RawUniqueStarGift, requestedSlug: string): GiftInfo | null {
  const g = res.gift;
  if (g._ !== 'starGiftUnique') return null;
  const parsed = parseSlug(g.slug) ?? parseSlug(requestedSlug);
  if (!parsed) return null;

  let model: GiftAttribute | null = null;
  let backdrop: GiftAttribute | null = null;
  let symbol: GiftAttribute | null = null;
  for (const a of g.attributes) {
    if (a._ === 'starGiftAttributeModel') model = { name: a.name, ...mapRarity(a.rarity) };
    else if (a._ === 'starGiftAttributeBackdrop') backdrop = { name: a.name, ...mapRarity(a.rarity) };
    else if (a._ === 'starGiftAttributePattern') symbol = { name: a.name, ...mapRarity(a.rarity) };
  }

  let ownerId: number | null = null;
  let ownerObj: AnyPeerObj | undefined;
  const p = g.ownerId;
  if (p) {
    if (p._ === 'peerUser') {
      ownerId = p.userId;
      ownerObj = (res.users as unknown as AnyPeerObj[]).find((u) => u.id === p.userId);
    } else if (p._ === 'peerChannel') {
      ownerId = p.channelId;
      ownerObj = (res.chats as unknown as AnyPeerObj[]).find((c) => c.id === p.channelId);
    } else if (p._ === 'peerChat') {
      ownerId = p.chatId;
      ownerObj = (res.chats as unknown as AnyPeerObj[]).find((c) => c.id === p.chatId);
    }
  }
  const displayName =
    g.ownerName ??
    (ownerObj ? (ownerObj.title ?? [ownerObj.firstName, ownerObj.lastName].filter(Boolean).join(' ')) || null : null);

  return {
    slug: `${parsed.collection}-${g.num}`,
    collection: parsed.collection,
    num: g.num,
    title: g.title,
    model,
    backdrop,
    symbol,
    ownerName: displayName,
    ownerUsername: activeUsername(ownerObj),
    ownerId,
    ownerAddress: g.ownerAddress ?? null,
    onSale: !!(g.resellAmount && g.resellAmount.length > 0),
    crafted: !!g.crafted,
    burned: !!g.burned,
    issued: g.availabilityIssued,
    total: g.availabilityTotal,
    imageUrl: webImageUrl(g.slug),
    source: 'mtproto',
  };
}

export interface MtprotoCatalogGift {
  id: string;
  title: string | null;
  upgradable: boolean;
}

export class MtprotoSource implements GiftSource {
  readonly name = 'mtproto' as const;
  readonly limiter: AdaptiveRateLimiter;
  readonly health = new SourceHealth('mtproto');
  private client: TelegramClient | null = null;
  private ready = false;
  me: { id: number; username: string | null } | null = null;
  lastAuthError: string | null = null;

  constructor(
    private readonly apiId: number | undefined,
    private readonly apiHash: string | undefined,
    maxRps: number,
  ) {
    this.limiter = new AdaptiveRateLimiter(0.2, maxRps, maxRps / 2);
  }

  get configured(): boolean {
    return !!(this.apiId && this.apiHash);
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Подключение по строке сессии. Возвращает true при успехе. */
  async connect(session: string): Promise<boolean> {
    if (!this.configured) return false;
    await this.disconnect();
    const client = createClient(this.apiId!, this.apiHash!);
    try {
      await client.importSession(session, true);
      await client.connect();
      const me = await client.getMe();
      if (me.isBot) throw new Error('Сессия принадлежит боту — нужен пользовательский аккаунт');
      this.client = client;
      this.ready = true;
      this.me = { id: me.id, username: me.username };
      this.lastAuthError = null;
      logger.info({ userId: me.id }, 'MTProto: аккаунт подключён');
      return true;
    } catch (e) {
      this.lastAuthError = e instanceof Error ? e.message : String(e);
      logger.error({ err: this.lastAuthError }, 'MTProto: не удалось подключиться по сессии');
      await client.destroy().catch(() => undefined);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.ready = false;
    const c = this.client;
    this.client = null;
    if (c) await c.destroy().catch(() => undefined);
  }

  async fetchGift(slug: string): Promise<FetchResult> {
    if (!this.client || !this.ready) return { status: 'unavailable', reason: 'MTProto не подключён' };
    await this.limiter.acquire();
    const started = Date.now();
    try {
      const res = await this.client.call({ _: 'payments.getUniqueStarGift', slug });
      const gift = mapUniqueGift(res, slug);
      this.limiter.onSuccess();
      this.health.ok(Date.now() - started);
      return gift ? { status: 'found', gift } : { status: 'not_found' };
    } catch (e) {
      return this.handleError(e);
    }
  }

  private handleError(e: unknown): FetchResult {
    if (tl.RpcError.is(e)) {
      if (NOT_FOUND_ERRORS.has(e.text)) {
        this.limiter.onSuccess();
        this.health.ok(0);
        return { status: 'not_found' };
      }
      if (e.code === 420 || e.text.startsWith('FLOOD')) {
        const sec = (e as unknown as { seconds?: number }).seconds ?? Number(/(\d+)/.exec(e.text)?.[1] ?? 30);
        this.limiter.onThrottle(sec * 1000);
        this.health.fail(`FLOOD_WAIT ${sec}s`);
        return { status: 'unavailable', reason: `FLOOD_WAIT ${sec}s`, retryAfterMs: sec * 1000 };
      }
      if (e.code === 401 || e.text.startsWith('AUTH_KEY') || e.text === 'SESSION_REVOKED' || e.text === 'USER_DEACTIVATED') {
        this.ready = false;
        this.lastAuthError = e.text;
        logger.error({ err: e.text }, 'MTProto: сессия недействительна — войдите заново через /login');
      }
      this.health.fail(e.text);
      this.limiter.onThrottle();
      return { status: 'unavailable', reason: e.text };
    }
    const reason = e instanceof Error ? e.message : String(e);
    this.health.fail(reason);
    this.limiter.onThrottle();
    return { status: 'unavailable', reason };
  }

  /** Каталог обычных подарков (для обнаружения новых коллекций) */
  async listCatalog(): Promise<MtprotoCatalogGift[]> {
    if (!this.client || !this.ready) return [];
    await this.limiter.acquire();
    const res = await this.client.call({ _: 'payments.getStarGifts', hash: 0 });
    if (res._ !== 'payments.starGifts') return [];
    return res.gifts
      .filter((g): g is tl.RawStarGift => g._ === 'starGift')
      .map((g) => ({ id: g.id.toString(), title: g.title ?? null, upgradable: g.upgradeStars !== undefined }));
  }
}

/**
 * Вход в аккаунт по QR-коду (https://core.telegram.org/api/qr-login).
 * onUrl вызывается с tg://login?token=... — его нужно показать как QR-код и отсканировать
 * в приложении Telegram: Настройки → Устройства → Подключить устройство.
 * Возвращает строку сессии.
 */
export async function loginWithQr(params: {
  apiId: number;
  apiHash: string;
  onUrl: (url: string, expires: Date) => void | Promise<void>;
  getPassword: () => Promise<string>;
  onInvalidPassword?: () => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<{ session: string; userId: number; username: string | null }> {
  const client = createClient(params.apiId, params.apiHash);
  try {
    const user = await client.start({
      qrCodeHandler: (url, expires) => void Promise.resolve(params.onUrl(url, expires)).catch(() => undefined),
      password: () => params.getPassword(),
      invalidCodeCallback: async (type) => {
        if (type === 'password') await params.onInvalidPassword?.();
      },
      abortSignal: params.signal,
    });
    if (user.isBot) throw new Error('Это бот, нужен пользовательский аккаунт');
    const session = await client.exportSession();
    return { session, userId: user.id, username: user.username };
  } finally {
    await client.destroy().catch(() => undefined);
  }
}
