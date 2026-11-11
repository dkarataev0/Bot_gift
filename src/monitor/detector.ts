/**
 * Детектор новых улучшений.
 *
 * Принцип (проверено на реальных данных): при улучшении обычного подарка Telegram присваивает
 * коллекционному подарку СЛЕДУЮЩИЙ порядковый номер в коллекции (slug вида PlushPepe-2826),
 * а счётчик «issued» коллекции растёт. Поэтому новое улучшение = появление номера head+1.
 *
 * - Первичная загрузка (baseline): запоминаем текущий максимум номера БЕЗ уведомлений —
 *   старые подарки не считаются новыми.
 * - Далее каждый номер > head — это подарок, выпущенный после момента headConfirmedAt
 *   (последней проверки, где номера head+1 ещё не было). Это даёт подтверждённое окно времени улучшения.
 * - Если окно слишком большое (сервис был выключен), событие сохраняется, но не рассылается.
 * - Крафт (crafted=true в MTProto) — отдельный тип события, это не улучшение.
 * - Дедупликация: уникальный ключ события new:<slug> в БД.
 */
import type { CollectionPatch, DetectorStore } from '../db/repository.js';
import type { CollectionState, Confidence, FetchResult, GiftEvent, GiftInfo, GiftSource } from '../types.js';
import { makeSlug } from '../types.js';

export interface DetectorOptions {
  maxFetchPerTick: number;
  maxNotifyWindowMs: number;
  /** Раз в сколько «тихих» проверок перечитывать счётчик issued (обнаружение пропусков номеров) */
  issuedRecheckEvery: number;
  now?: () => Date;
}

export interface CheckOutcome {
  status: 'baseline' | 'quiet' | 'new' | 'error';
  events: GiftEvent[];
  /** Остались необработанные номера — проверить коллекцию снова как можно скорее */
  backlog: boolean;
  newCount: number;
  error?: string;
  retryAfterMs?: number;
}

interface Observation {
  issued: number;
  at: Date;
}

export class Detector {
  /** Наблюдения счётчика issued по коллекциям (в памяти) — для точного окна времени улучшения */
  private observations = new Map<string, Observation[]>();
  private readonly now: () => Date;

  constructor(
    private readonly store: DetectorStore,
    private readonly source: GiftSource,
    private readonly opts: DetectorOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  private observe(base: string, issued: number, at: Date) {
    const list = this.observations.get(base) ?? [];
    list.push({ issued, at });
    if (list.length > 64) list.shift();
    this.observations.set(base, list);
  }

  /** Самый поздний момент, когда номер n ещё точно НЕ существовал */
  windowStartFor(c: CollectionState, n: number): Date | null {
    let best: Date | null = c.headConfirmedAt && c.headNum < n ? c.headConfirmedAt : null;
    for (const o of this.observations.get(c.base) ?? []) {
      if (o.issued < n && (!best || o.at > best)) best = o.at;
    }
    return best;
  }

  /** Самый ранний момент, когда номер n уже точно существовал */
  windowEndFor(c: CollectionState, n: number, fallback: Date): Date {
    let best = fallback;
    for (const o of this.observations.get(c.base) ?? []) {
      if (o.issued >= n && o.at < best) best = o.at;
    }
    return best;
  }

  async checkCollection(c: CollectionState): Promise<CheckOutcome> {
    return c.baselineDone ? this.liveCheck(c) : this.baseline(c);
  }

  private async baseline(c: CollectionState): Promise<CheckOutcome> {
    const now = this.now();
    const r = await this.source.fetchGift(makeSlug(c.base, Math.max(1, c.headNum)));
    if (r.status === 'unavailable') return this.fail(c, r);
    if (r.status === 'not_found') {
      // В коллекции ещё нет ни одного улучшенного подарка — все будущие номера будут новыми
      await this.store.updateCollection(c.base, {
        baselineDone: true, headConfirmedAt: now, lastCheckedAt: now, incChecks: true,
      });
      return { status: 'baseline', events: [], backlog: false, newCount: 0 };
    }
    const g = r.gift;
    const head = Math.max(g.issued ?? g.num, g.num, c.headNum);
    await this.store.upsertGift(g); // сохраняем как «первое обнаружение» без события
    this.observe(c.base, head, now);
    await this.store.updateCollection(c.base, {
      title: g.title, headNum: head, issued: g.issued, total: g.total,
      baselineDone: true, headConfirmedAt: now, lastCheckedAt: now, incChecks: true,
    });
    return { status: 'baseline', events: [], backlog: false, newCount: 0 };
  }

  private async liveCheck(c: CollectionState): Promise<CheckOutcome> {
    const now = this.now();
    const probeNum = c.headNum + 1;
    const r = await this.source.fetchGift(makeSlug(c.base, probeNum), 'probe');
    if (r.status === 'unavailable') return this.fail(c, r);

    if (r.status === 'not_found') {
      // Периодически перечитываем issued: если номер head+1 «выпал» (сожжён/скрыт), а дальше есть новые — не застрянем
      if (c.headNum > 0 && (c.checksCount + 1) % this.opts.issuedRecheckEvery === 0) {
        const h = await this.source.fetchGift(makeSlug(c.base, c.headNum));
        if (h.status === 'found' && h.gift.issued != null && h.gift.issued > probeNum) {
          this.observe(c.base, h.gift.issued, now);
          return this.processRange(c, probeNum + 1, h.gift.issued, null);
        }
      }
      this.observe(c.base, c.headNum, now);
      await this.store.updateCollection(c.base, { headConfirmedAt: now, lastCheckedAt: now, incChecks: true });
      return { status: 'quiet', events: [], backlog: false, newCount: 0 };
    }

    const issued = Math.max(r.gift.issued ?? probeNum, probeNum);
    this.observe(c.base, issued, now);
    return this.processRange(c, probeNum, issued, r);
  }

  private async processRange(
    c: CollectionState,
    from: number,
    target: number,
    first: Extract<FetchResult, { status: 'found' }> | null,
  ): Promise<CheckOutcome> {
    const events: GiftEvent[] = [];
    const limit = Math.min(target, c.headNum + this.opts.maxFetchPerTick);
    let lastDone = c.headNum;
    let newCount = 0;
    let error: string | undefined;
    let retryAfterMs: number | undefined;
    let issued: number | null = null;
    let total: number | null = null;
    let title: string | null = null;

    for (let n = from; n <= limit; n++) {
      const r = first && n === from ? first : await this.source.fetchGift(makeSlug(c.base, n));
      if (r.status === 'unavailable') {
        error = r.reason;
        retryAfterMs = r.retryAfterMs;
        break;
      }
      if (r.status === 'not_found') {
        // пропуск номера (например, сожжён при крафте) — идём дальше, если известно, что дальше есть номера
        if (n < target) {
          lastDone = n;
          continue;
        }
        break;
      }
      const ev = await this.recordNew(c, r.gift);
      if (ev) events.push(ev);
      newCount++;
      lastDone = n;
      issued = r.gift.issued ?? issued;
      total = r.gift.total ?? total;
      title = r.gift.title ?? title;
    }

    const now = this.now();
    const patch: CollectionPatch = { lastCheckedAt: now, incChecks: true };
    if (lastDone > c.headNum) patch.headNum = lastDone;
    if (newCount > 0) patch.lastNewAt = now;
    if (issued != null) patch.issued = issued;
    if (total != null) patch.total = total;
    if (title) patch.title = title;
    if (error) patch.incErrors = true;
    await this.store.updateCollection(c.base, patch);
    c.headNum = Math.max(c.headNum, lastDone);

    return {
      status: error && newCount === 0 ? 'error' : 'new',
      events,
      backlog: lastDone < target,
      newCount,
      error,
      retryAfterMs,
    };
  }

  private async recordNew(c: CollectionState, g: GiftInfo): Promise<GiftEvent | null> {
    const now = this.now();
    const windowStart = this.windowStartFor(c, g.num);
    const windowEnd = this.windowEndFor(c, g.num, now);
    const stale = !windowStart || windowEnd.getTime() - windowStart.getTime() > this.opts.maxNotifyWindowMs;
    const kind = g.crafted ? 'craft' : 'upgrade';
    const confidence: Confidence = stale ? 'low' : g.crafted === null ? 'medium' : 'high';

    await this.store.upsertGift(g);
    return this.store.insertEvent({
      dedupKey: `new:${g.slug}`,
      giftSlug: g.slug,
      kind,
      confidence,
      detectedAt: now,
      windowStart,
      windowEnd,
      notify: !stale,
      details: { source: g.source, stale, issued: g.issued, craftedKnown: g.crafted !== null },
    });
  }

  private async fail(c: CollectionState, r: Extract<FetchResult, { status: 'unavailable' }>): Promise<CheckOutcome> {
    await this.store.updateCollection(c.base, { lastCheckedAt: this.now(), incErrors: true });
    return { status: 'error', events: [], backlog: false, newCount: 0, error: r.reason, retryAfterMs: r.retryAfterMs };
  }
}
