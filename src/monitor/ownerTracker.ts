/**
 * Отслеживание изменений избранных подарков: смена владельца и выставление на продажу.
 * Это ОТДЕЛЬНЫЕ события, не путать с улучшением.
 */
import type { Repository, StoredGift } from '../db/repository.js';
import { logger } from '../logger.js';
import type { SourceRouter } from '../sources/router.js';
import type { Confidence, GiftEvent, GiftInfo } from '../types.js';

export function ownerKey(g: Pick<GiftInfo, 'ownerId' | 'ownerName' | 'ownerAddress' | 'source'>): string | null {
  if (g.ownerId != null) return `id:${g.ownerId}`;
  if (g.ownerAddress) return `ton:${g.ownerAddress}`;
  if (g.ownerName) return `name:${g.ownerName}`;
  return null;
}

/** Сравнение старого и нового состояния подарка -> список изменений */
export function diffGift(prev: StoredGift, cur: GiftInfo): { kind: 'transfer' | 'resale_listed'; confidence: Confidence; details: Record<string, unknown> }[] {
  const out: { kind: 'transfer' | 'resale_listed'; confidence: Confidence; details: Record<string, unknown> }[] = [];
  const bothIds = prev.ownerId != null && cur.ownerId != null;
  const changed = bothIds ? prev.ownerId !== cur.ownerId : (prev.ownerAddress ?? null) !== (cur.ownerAddress ?? null) || (prev.ownerName ?? null) !== (cur.ownerName ?? null);
  if (changed && ownerKey(cur) && ownerKey(prev)) {
    out.push({
      kind: 'transfer',
      // при сравнении только по отображаемому имени владелец мог просто переименоваться
      confidence: bothIds || (cur.ownerAddress && prev.ownerAddress) ? 'high' : 'low',
      details: {
        from: { name: prev.ownerName, username: prev.ownerUsername, id: prev.ownerId },
        to: { name: cur.ownerName, username: cur.ownerUsername, id: cur.ownerId },
      },
    });
  }
  if (cur.onSale === true && prev.onSale !== true) {
    out.push({ kind: 'resale_listed', confidence: 'high', details: {} });
  }
  return out;
}

export class OwnerTracker {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly repo: Repository,
    private readonly sources: SourceRouter,
    private readonly recheckMs: number,
    private readonly onEvents: (events: GiftEvent[]) => void,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const due = await this.repo.favoritesDueForRecheck(this.recheckMs, 5);
      for (const slug of due) {
        const r = await this.sources.fetchBest(slug);
        if (r.status === 'unavailable') continue;
        await this.repo.markFavoriteChecked(slug);
        if (r.status !== 'found') continue;
        const { previous } = await this.repo.upsertGift(r.gift);
        if (!previous) continue;
        const events: GiftEvent[] = [];
        for (const d of diffGift(previous, r.gift)) {
          const ev = await this.repo.insertEvent({
            dedupKey: `${d.kind}:${slug}:${ownerKey(r.gift)}:${Math.floor(Date.now() / 60_000)}`,
            giftSlug: slug,
            kind: d.kind,
            confidence: d.confidence,
            detectedAt: new Date(),
            windowStart: previous.updatedAt,
            windowEnd: new Date(),
            notify: true,
            details: d.details,
          });
          if (ev) events.push(ev);
        }
        if (events.length) this.onEvents(events);
      }
    } catch (e) {
      logger.error({ err: e }, 'Ошибка перепроверки избранного');
    } finally {
      this.busy = false;
    }
  }
}
