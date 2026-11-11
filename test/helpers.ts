import type { CollectionPatch, DetectorStore, NewEvent, StoredGift } from '../src/db/repository.js';
import type { CollectionState, FetchResult, GiftEvent, GiftInfo, GiftSource } from '../src/types.js';

export function gift(collection: string, num: number, extra: Partial<GiftInfo> = {}): GiftInfo {
  return {
    slug: `${collection}-${num}`,
    collection,
    num,
    title: 'Plush Pepe',
    model: { name: 'Pumpkin', permille: 30, tier: null },
    backdrop: { name: 'Onyx Black', permille: 20, tier: null },
    symbol: { name: 'Illuminati', permille: 5, tier: null },
    ownerName: 'Owner',
    ownerUsername: null,
    ownerId: null,
    ownerAddress: null,
    onSale: null,
    crafted: null,
    burned: null,
    issued: null,
    total: 10_000,
    imageUrl: null,
    source: 'web',
    ...extra,
  };
}

/** Поддельный источник: «мир», где в коллекции выпущено issued подарков (номера из missing отсутствуют) */
export class FakeSource implements GiftSource {
  readonly name = 'web' as const;
  issued = new Map<string, number>();
  missing = new Set<string>();
  crafted = new Set<string>();
  unavailable = false;
  calls: string[] = [];
  web = true;

  isReady() {
    return true;
  }

  async fetchGift(slug: string): Promise<FetchResult> {
    this.calls.push(slug);
    if (this.unavailable) return { status: 'unavailable', reason: 'test' };
    const [col, n] = [slug.replace(/-\d+$/, ''), Number(slug.split('-').pop())];
    const issued = this.issued.get(col) ?? 0;
    if (n < 1 || n > issued || this.missing.has(slug)) return { status: 'not_found' };
    return {
      status: 'found',
      gift: gift(col, n, {
        issued,
        crafted: this.web ? null : this.crafted.has(slug),
        source: this.web ? 'web' : 'mtproto',
      }),
    };
  }
}

export class MemoryStore implements DetectorStore {
  collections = new Map<string, CollectionState>();
  gifts = new Map<string, StoredGift>();
  events: GiftEvent[] = [];
  private seq = 0;

  addCollection(base: string): CollectionState {
    const c: CollectionState = {
      base, title: null, headNum: 0, issued: null, total: null, baselineDone: false,
      headConfirmedAt: null, lastCheckedAt: null, lastNewAt: null, nextCheckAt: new Date(0), checksCount: 0, enabled: true,
    };
    this.collections.set(base, c);
    return c;
  }

  /** Снимок состояния (как если бы его перечитали из БД) */
  get(base: string): CollectionState {
    return { ...this.collections.get(base)! };
  }

  async upsertGift(g: GiftInfo) {
    const previous = this.gifts.get(g.slug) ?? null;
    this.gifts.set(g.slug, { ...g, firstSeenAt: previous?.firstSeenAt ?? new Date(), updatedAt: new Date() });
    return { previous };
  }

  async insertEvent(e: NewEvent): Promise<GiftEvent | null> {
    if (this.events.some((x) => x.dedupKey === e.dedupKey)) return null;
    const ev: GiftEvent = { id: ++this.seq, ...e };
    (ev as GiftEvent & { notify: boolean }).notify = e.notify;
    this.events.push(ev);
    return ev;
  }

  async updateCollection(base: string, p: CollectionPatch) {
    const c = this.collections.get(base)!;
    if (p.title !== undefined && p.title !== null) c.title = p.title;
    if (p.headNum !== undefined) c.headNum = Math.max(c.headNum, p.headNum);
    if (p.issued !== undefined) c.issued = p.issued;
    if (p.total !== undefined) c.total = p.total;
    if (p.baselineDone !== undefined) c.baselineDone = p.baselineDone;
    if (p.headConfirmedAt !== undefined) c.headConfirmedAt = p.headConfirmedAt;
    if (p.lastCheckedAt !== undefined) c.lastCheckedAt = p.lastCheckedAt;
    if (p.lastNewAt !== undefined) c.lastNewAt = p.lastNewAt;
    if (p.nextCheckAt !== undefined) c.nextCheckAt = p.nextCheckAt;
    if (p.incChecks) c.checksCount++;
  }
}

export class Clock {
  t = Date.parse('2026-11-11T12:00:00Z');
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}
