/**
 * Источник «web»: публичные страницы https://t.me/nft/<slug>.
 * Не требует аккаунта. Проверено вручную (ноябрь 2026):
 *  - существующий подарок -> 200 и таблица .tgme_gift_table (Owner/Model/Backdrop/Symbol/Quantity);
 *  - несуществующий номер  -> 302 (редирект);
 *  - при частых запросах   -> 200, но «заглушка» без таблицы (мягкое ограничение) — это НЕ «нет подарка».
 * Ограничение: username владельца на странице не показывается — только отображаемое имя.
 */
import type { FetchMode, FetchResult, GiftAttribute, GiftInfo, GiftSource } from '../types.js';
import { parseSlug } from '../types.js';
import { AdaptiveRateLimiter } from '../util/rateLimiter.js';
import { SourceHealth } from './health.js';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeHtml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z0-9#]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function stripTags(s: string): string {
  return decodeHtml(s.replace(/<[^>]*>/g, ' ')).replace(/[\s ]+/g, ' ').trim();
}

/** 'Pumpkin <mark>3%</mark>' -> { name: 'Pumpkin', permille: 30 } */
function parseAttrCell(html: string): GiftAttribute {
  const mark = /<mark>([^<]*)<\/mark>/i.exec(html);
  const name = stripTags(html.replace(/<mark>[\s\S]*?<\/mark>/gi, ''));
  let permille: number | null = null;
  let tier: string | null = null;
  if (mark) {
    const txt = stripTags(mark[1]!);
    const pct = /([\d.,]+)\s*%/.exec(txt);
    if (pct) permille = Math.round(Number(pct[1]!.replace(',', '.')) * 10);
    else if (txt) tier = txt.toLowerCase();
  }
  return { name, permille, tier };
}

export function webImageUrl(slug: string): string {
  return `https://nft.fragment.com/gift/${slug.toLowerCase()}.large.jpg`;
}

/** Разбор HTML страницы подарка. null — страница не содержит данных подарка (заглушка). */
export function parseGiftPage(html: string, slug: string): GiftInfo | null {
  if (!html.includes('tgme_gift_table')) return null;
  const parsed = parseSlug(slug);
  if (!parsed) return null;

  const rows = new Map<string, string>();
  const tableMatch = /<table class="table tgme_gift_table">([\s\S]*?)<\/table>/i.exec(html);
  const table = tableMatch ? tableMatch[1]! : html;
  for (const m of table.matchAll(/<th>([\s\S]*?)<\/th>\s*<td>([\s\S]*?)<\/td>/gi)) {
    rows.set(stripTags(m[1]!).toLowerCase(), m[2]!);
  }

  const ogTitle = /<meta property="og:title" content="([^"]*)"/i.exec(html);
  let title: string | null = null;
  let num = parsed.num;
  if (ogTitle) {
    const t = decodeHtml(ogTitle[1]!);
    const tm = /^(.*?)\s*#(\d+)\s*$/.exec(t);
    if (tm) {
      title = tm[1]!.trim();
      num = Number(tm[2]);
    } else title = t.trim();
  }
  if (num !== parsed.num) return null; // защита от неожиданной страницы

  let ownerName: string | null = null;
  let ownerUsername: string | null = null;
  const ownerCell = rows.get('owner');
  if (ownerCell) {
    const link = /href="(?:https?:)?\/\/t\.me\/([A-Za-z0-9_]{4,32})"/i.exec(ownerCell);
    if (link) ownerUsername = link[1]!;
    ownerName = stripTags(ownerCell) || null;
  }

  let issued: number | null = null;
  let total: number | null = null;
  const qty = rows.get('quantity');
  if (qty) {
    const q = /([\d\s ]+)\/([\d\s ]+)/.exec(decodeHtml(qty));
    if (q) {
      issued = Number(q[1]!.replace(/[\s ]/g, ''));
      total = Number(q[2]!.replace(/[\s ]/g, ''));
    }
  }

  const cell = (k: string) => (rows.has(k) ? parseAttrCell(rows.get(k)!) : null);
  const ogImage = /<meta property="og:image" content="([^"]*)"/i.exec(html);

  return {
    slug: `${parsed.collection}-${num}`,
    collection: parsed.collection,
    num,
    title,
    model: cell('model'),
    backdrop: cell('backdrop'),
    symbol: cell('symbol') ?? cell('pattern'),
    ownerName,
    ownerUsername,
    ownerId: null,
    ownerAddress: null,
    onSale: null,
    crafted: null,
    burned: null,
    issued,
    total,
    imageUrl: ogImage ? decodeHtml(ogImage[1]!) : webImageUrl(slug),
    source: 'web',
  };
}

export class WebSource implements GiftSource {
  readonly name = 'web' as const;
  /** Лимит загрузки полных страниц (t.me ограничивает их сильнее) */
  readonly limiter: AdaptiveRateLimiter;
  /** Лимит «проб» следующего номера: ответ 302 t.me отдаёт заметно охотнее (проверено: ~2.5 запр/с, ~83% без заглушек) */
  readonly probeLimiter: AdaptiveRateLimiter;
  readonly health = new SourceHealth('web');

  constructor(minRps: number, maxRps: number, probeMaxRps = 1.5, private readonly timeoutMs = 15_000) {
    this.limiter = new AdaptiveRateLimiter(minRps, maxRps, Math.min(maxRps, Math.max(minRps, 0.3)));
    this.probeLimiter = new AdaptiveRateLimiter(Math.min(minRps * 2, probeMaxRps), probeMaxRps, probeMaxRps * 0.7);
  }

  isReady(): boolean {
    return true;
  }

  async fetchGift(slug: string, mode: FetchMode = 'page'): Promise<FetchResult> {
    const lim = mode === 'probe' ? this.probeLimiter : this.limiter;
    await lim.acquire();
    const started = Date.now();
    try {
      const res = await fetch(`https://t.me/nft/${encodeURIComponent(slug)}`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; GiftMonitorBot/1.0)',
          'accept-language': 'en',
        },
      });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        lim.onSuccess();
        this.health.ok(Date.now() - started);
        return { status: 'not_found' };
      }
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after') ?? '30') * 1000;
        lim.onThrottle(ra);
        this.health.fail('HTTP 429');
        return { status: 'unavailable', reason: 'HTTP 429', retryAfterMs: ra };
      }
      if (res.status !== 200) {
        await res.body?.cancel();
        lim.onThrottle();
        this.health.fail(`HTTP ${res.status}`);
        return { status: 'unavailable', reason: `HTTP ${res.status}` };
      }
      const html = await res.text();
      const gift = parseGiftPage(html, slug);
      if (!gift) {
        // Заглушка без данных: признак мягкого ограничения частоты
        lim.onThrottle();
        this.health.fail('empty page (throttled)');
        return { status: 'unavailable', reason: 'empty page (throttled)' };
      }
      lim.onSuccess();
      this.health.ok(Date.now() - started);
      return { status: 'found', gift };
    } catch (e) {
      lim.onThrottle();
      const reason = e instanceof Error ? e.message : String(e);
      this.health.fail(reason);
      return { status: 'unavailable', reason };
    }
  }
}
