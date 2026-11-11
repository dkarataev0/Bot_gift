import type pg from 'pg';
import {
  type CollectionState,
  type Confidence,
  type EventKind,
  type GiftAttribute,
  type GiftEvent,
  type GiftInfo,
  type UserSettings,
  normalizeSettings,
} from '../types.js';

export interface NewEvent {
  dedupKey: string;
  giftSlug: string;
  kind: EventKind;
  confidence: Confidence;
  detectedAt: Date;
  windowStart: Date | null;
  windowEnd: Date | null;
  notify: boolean;
  details: Record<string, unknown>;
}

export interface CollectionPatch {
  title?: string | null;
  headNum?: number;
  issued?: number | null;
  total?: number | null;
  baselineDone?: boolean;
  headConfirmedAt?: Date | null;
  lastCheckedAt?: Date | null;
  lastNewAt?: Date | null;
  nextCheckAt?: Date;
  incChecks?: boolean;
  incErrors?: boolean;
}

export interface StoredGift extends GiftInfo {
  firstSeenAt: Date;
  updatedAt: Date;
}

/** Минимальный интерфейс хранилища, нужный детектору (реализуется Postgres и in-memory для тестов) */
export interface DetectorStore {
  upsertGift(gift: GiftInfo): Promise<{ previous: StoredGift | null }>;
  insertEvent(e: NewEvent): Promise<GiftEvent | null>;
  updateCollection(base: string, patch: CollectionPatch): Promise<void>;
}

export interface UserRow {
  chatId: number;
  username: string | null;
  isOwner: boolean;
  settings: UserSettings;
}

const attr = (name: unknown, permille: unknown, tier: unknown): GiftAttribute | null =>
  name == null ? null : { name: String(name), permille: permille == null ? null : Number(permille), tier: (tier as string) ?? null };

function rowToGift(r: Record<string, any>): StoredGift {
  return {
    slug: r.slug,
    collection: r.collection,
    num: r.num,
    title: r.title,
    model: attr(r.model, r.model_permille, r.model_tier),
    backdrop: attr(r.backdrop, r.backdrop_permille, r.backdrop_tier),
    symbol: attr(r.symbol, r.symbol_permille, r.symbol_tier),
    ownerName: r.owner_name,
    ownerUsername: r.owner_username,
    ownerId: r.owner_id,
    ownerAddress: r.owner_address,
    onSale: r.on_sale,
    crafted: r.crafted,
    burned: null,
    issued: r.issued,
    total: r.total,
    imageUrl: r.image_url,
    source: r.source,
    firstSeenAt: r.first_seen_at,
    updatedAt: r.updated_at,
  };
}

function rowToCollection(r: Record<string, any>): CollectionState {
  return {
    base: r.base,
    title: r.title,
    headNum: r.head_num,
    issued: r.issued,
    total: r.total,
    baselineDone: r.baseline_done,
    headConfirmedAt: r.head_confirmed_at,
    lastCheckedAt: r.last_checked_at,
    lastNewAt: r.last_new_at,
    nextCheckAt: r.next_check_at,
    checksCount: Number(r.checks_count),
    enabled: r.enabled,
  };
}

function rowToEvent(r: Record<string, any>): GiftEvent {
  return {
    id: Number(r.id),
    dedupKey: r.dedup_key,
    giftSlug: r.gift_slug,
    kind: r.kind,
    confidence: r.confidence,
    detectedAt: r.detected_at,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    details: r.details ?? {},
  };
}

export class Repository implements DetectorStore {
  constructor(readonly pool: pg.Pool) {}

  // ---------- collections ----------

  /** Возвращает true, если коллекция новая */
  async upsertCollection(base: string, discoveredBy: string, title: string | null = null): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO collections(base, title, discovered_by) VALUES ($1, $2, $3)
       ON CONFLICT (base) DO NOTHING`,
      [base.toLowerCase(), title, discoveredBy],
    );
    return (rowCount ?? 0) > 0;
  }

  async listCollections(): Promise<CollectionState[]> {
    const { rows } = await this.pool.query('SELECT * FROM collections ORDER BY base');
    return rows.map(rowToCollection);
  }

  async getCollection(base: string): Promise<CollectionState | null> {
    const { rows } = await this.pool.query('SELECT * FROM collections WHERE base = $1', [base]);
    return rows[0] ? rowToCollection(rows[0]) : null;
  }

  async updateCollection(base: string, p: CollectionPatch): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if (p.title !== undefined) sets.push(`title = COALESCE($${vals.push(p.title)}, title)`);
    if (p.headNum !== undefined) sets.push(`head_num = GREATEST(head_num, $${vals.push(p.headNum)})`);
    if (p.issued !== undefined) add('issued', p.issued);
    if (p.total !== undefined) add('total', p.total);
    if (p.baselineDone !== undefined) add('baseline_done', p.baselineDone);
    if (p.headConfirmedAt !== undefined) add('head_confirmed_at', p.headConfirmedAt);
    if (p.lastCheckedAt !== undefined) add('last_checked_at', p.lastCheckedAt);
    if (p.lastNewAt !== undefined) add('last_new_at', p.lastNewAt);
    if (p.nextCheckAt !== undefined) add('next_check_at', p.nextCheckAt);
    if (p.incChecks) sets.push('checks_count = checks_count + 1');
    if (p.incErrors) sets.push('errors_count = errors_count + 1');
    if (!sets.length) return;
    sets.push('updated_at = now()');
    vals.push(base);
    await this.pool.query(`UPDATE collections SET ${sets.join(', ')} WHERE base = $${vals.length}`, vals);
  }

  // ---------- gifts ----------

  async upsertGift(g: GiftInfo): Promise<{ previous: StoredGift | null }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const prev = await client.query('SELECT * FROM gifts WHERE slug = $1 FOR UPDATE', [g.slug]);
      const v = [
        g.slug, g.collection, g.num, g.title,
        g.model?.name ?? null, g.model?.permille ?? null, g.model?.tier ?? null,
        g.backdrop?.name ?? null, g.backdrop?.permille ?? null, g.backdrop?.tier ?? null,
        g.symbol?.name ?? null, g.symbol?.permille ?? null, g.symbol?.tier ?? null,
        g.ownerName, g.ownerUsername, g.ownerId, g.ownerAddress, g.onSale, g.crafted,
        g.imageUrl, g.issued, g.total, g.source,
      ];
      await client.query(
        `INSERT INTO gifts(slug, collection, num, title, model, model_permille, model_tier,
            backdrop, backdrop_permille, backdrop_tier, symbol, symbol_permille, symbol_tier,
            owner_name, owner_username, owner_id, owner_address, on_sale, crafted, image_url, issued, total, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
         ON CONFLICT (slug) DO UPDATE SET
           title = COALESCE(EXCLUDED.title, gifts.title),
           model = COALESCE(EXCLUDED.model, gifts.model),
           model_permille = COALESCE(EXCLUDED.model_permille, gifts.model_permille),
           model_tier = COALESCE(EXCLUDED.model_tier, gifts.model_tier),
           backdrop = COALESCE(EXCLUDED.backdrop, gifts.backdrop),
           backdrop_permille = COALESCE(EXCLUDED.backdrop_permille, gifts.backdrop_permille),
           backdrop_tier = COALESCE(EXCLUDED.backdrop_tier, gifts.backdrop_tier),
           symbol = COALESCE(EXCLUDED.symbol, gifts.symbol),
           symbol_permille = COALESCE(EXCLUDED.symbol_permille, gifts.symbol_permille),
           symbol_tier = COALESCE(EXCLUDED.symbol_tier, gifts.symbol_tier),
           owner_name = EXCLUDED.owner_name,
           owner_username = CASE WHEN EXCLUDED.source = 'mtproto' OR EXCLUDED.owner_name IS DISTINCT FROM gifts.owner_name
                                 THEN EXCLUDED.owner_username ELSE COALESCE(EXCLUDED.owner_username, gifts.owner_username) END,
           owner_id = CASE WHEN EXCLUDED.source = 'mtproto' THEN EXCLUDED.owner_id ELSE gifts.owner_id END,
           owner_address = EXCLUDED.owner_address,
           on_sale = COALESCE(EXCLUDED.on_sale, gifts.on_sale),
           crafted = COALESCE(EXCLUDED.crafted, gifts.crafted),
           image_url = COALESCE(EXCLUDED.image_url, gifts.image_url),
           issued = COALESCE(EXCLUDED.issued, gifts.issued),
           total = COALESCE(EXCLUDED.total, gifts.total),
           source = EXCLUDED.source,
           updated_at = now()`,
        v,
      );
      await client.query('COMMIT');
      return { previous: prev.rows[0] ? rowToGift(prev.rows[0]) : null };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async getGift(slug: string): Promise<StoredGift | null> {
    const { rows } = await this.pool.query('SELECT * FROM gifts WHERE slug = $1', [slug.toLowerCase()]);
    return rows[0] ? rowToGift(rows[0]) : null;
  }

  // ---------- events ----------

  /** Вставляет событие; null — если такое событие уже было (дедупликация по dedup_key) */
  async insertEvent(e: NewEvent): Promise<GiftEvent | null> {
    const { rows } = await this.pool.query(
      `INSERT INTO events(dedup_key, gift_slug, kind, confidence, detected_at, window_start, window_end, notify_status, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (dedup_key) DO NOTHING
       RETURNING *`,
      [e.dedupKey, e.giftSlug, e.kind, e.confidence, e.detectedAt, e.windowStart, e.windowEnd,
        e.notify ? 'pending' : 'skipped', e.details],
    );
    return rows[0] ? rowToEvent(rows[0]) : null;
  }

  async pendingEvents(limit = 100): Promise<GiftEvent[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM events WHERE notify_status = 'pending' ORDER BY id LIMIT $1`,
      [limit],
    );
    return rows.map(rowToEvent);
  }

  async setEventStatus(id: number, status: 'done' | 'skipped'): Promise<void> {
    await this.pool.query('UPDATE events SET notify_status = $2 WHERE id = $1', [id, status]);
  }

  async recentUpgrades(limit: number, collection?: string): Promise<(GiftEvent & { gift: StoredGift })[]> {
    const { rows } = await this.pool.query(
      `SELECT e.*, row_to_json(g.*) AS g FROM events e JOIN gifts g ON g.slug = e.gift_slug
       WHERE e.kind IN ('upgrade','craft') AND ($2::text IS NULL OR g.collection = $2)
       ORDER BY e.detected_at DESC, e.id DESC LIMIT $1`,
      [limit, collection ?? null],
    );
    return rows.map((r) => ({
      ...rowToEvent(r),
      gift: rowToGift({ ...r.g, first_seen_at: new Date(r.g.first_seen_at), updated_at: new Date(r.g.updated_at) }),
    }));
  }

  // ---------- users ----------

  async getUser(chatId: number): Promise<UserRow | null> {
    const { rows } = await this.pool.query('SELECT * FROM users WHERE chat_id = $1', [chatId]);
    const r = rows[0];
    return r ? { chatId: r.chat_id, username: r.username, isOwner: r.is_owner, settings: normalizeSettings(r.settings) } : null;
  }

  async listUsers(): Promise<UserRow[]> {
    const { rows } = await this.pool.query('SELECT * FROM users ORDER BY created_at');
    return rows.map((r) => ({ chatId: r.chat_id, username: r.username, isOwner: r.is_owner, settings: normalizeSettings(r.settings) }));
  }

  async countOwners(): Promise<number> {
    const { rows } = await this.pool.query('SELECT count(*)::int AS c FROM users WHERE is_owner');
    return rows[0].c;
  }

  async upsertUser(chatId: number, username: string | null, isOwner: boolean): Promise<UserRow> {
    await this.pool.query(
      `INSERT INTO users(chat_id, username, is_owner) VALUES ($1, $2, $3)
       ON CONFLICT (chat_id) DO UPDATE SET username = EXCLUDED.username,
         is_owner = users.is_owner OR EXCLUDED.is_owner, updated_at = now()`,
      [chatId, username, isOwner],
    );
    return (await this.getUser(chatId))!;
  }

  async saveSettings(chatId: number, s: UserSettings): Promise<void> {
    await this.pool.query('UPDATE users SET settings = $2, updated_at = now() WHERE chat_id = $1', [chatId, s]);
  }

  // ---------- notifications ----------

  /** Резервирует отправку; false — уже отправлялось этому пользователю */
  async claimNotification(eventId: number, chatId: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'INSERT INTO notifications(event_id, chat_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [eventId, chatId],
    );
    return (rowCount ?? 0) > 0;
  }

  async setNotificationMessage(eventId: number, chatId: number, messageId: number): Promise<void> {
    await this.pool.query('UPDATE notifications SET message_id = $3 WHERE event_id = $1 AND chat_id = $2', [eventId, chatId, messageId]);
  }

  // ---------- favorites ----------

  async toggleFavorite(chatId: number, slug: string): Promise<boolean> {
    const del = await this.pool.query('DELETE FROM favorites WHERE chat_id = $1 AND gift_slug = $2', [chatId, slug]);
    if ((del.rowCount ?? 0) > 0) return false;
    await this.pool.query('INSERT INTO favorites(chat_id, gift_slug) VALUES ($1, $2) ON CONFLICT DO NOTHING', [chatId, slug]);
    return true;
  }

  async isFavorite(chatId: number, slug: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM favorites WHERE chat_id = $1 AND gift_slug = $2', [chatId, slug]);
    return (rowCount ?? 0) > 0;
  }

  async listFavorites(chatId: number): Promise<StoredGift[]> {
    const { rows } = await this.pool.query(
      `SELECT g.* FROM favorites f JOIN gifts g ON g.slug = f.gift_slug WHERE f.chat_id = $1 ORDER BY f.created_at DESC`,
      [chatId],
    );
    return rows.map(rowToGift);
  }

  /** Избранные подарки, давно не перепроверявшиеся (для отслеживания смены владельца) */
  async favoritesDueForRecheck(olderThanMs: number, limit: number): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT gift_slug, min(last_checked_at) AS lc FROM favorites
       GROUP BY gift_slug
       HAVING min(COALESCE(last_checked_at, 'epoch')) < now() - ($1::double precision * interval '1 millisecond')
       ORDER BY lc NULLS FIRST LIMIT $2`,
      [olderThanMs, limit],
    );
    return rows.map((r) => r.gift_slug);
  }

  async markFavoriteChecked(slug: string): Promise<void> {
    await this.pool.query('UPDATE favorites SET last_checked_at = now() WHERE gift_slug = $1', [slug]);
  }

  async favoriteWatchers(slug: string): Promise<number[]> {
    const { rows } = await this.pool.query('SELECT chat_id FROM favorites WHERE gift_slug = $1', [slug]);
    return rows.map((r) => r.chat_id);
  }

  // ---------- kv ----------

  async kvGet<T>(key: string): Promise<T | null> {
    const { rows } = await this.pool.query('SELECT value FROM kv WHERE key = $1', [key]);
    return rows[0] ? (rows[0].value as T) : null;
  }

  async kvSet(key: string, value: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO kv(key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  async kvDelete(key: string): Promise<void> {
    await this.pool.query('DELETE FROM kv WHERE key = $1', [key]);
  }

  // ---------- stats ----------

  async stats(): Promise<{
    upgrades1h: number; upgrades24h: number; crafts24h: number; giftsTotal: number;
    collectionsTotal: number; baselinePending: number;
    windowMedianSec: number | null; windowP90Sec: number | null;
    top24h: { collection: string; title: string | null; n: number }[];
  }> {
    const a = await this.pool.query(`SELECT
      count(*) FILTER (WHERE kind = 'upgrade' AND detected_at > now() - interval '1 hour')::int AS u1,
      count(*) FILTER (WHERE kind = 'upgrade' AND detected_at > now() - interval '24 hours')::int AS u24,
      count(*) FILTER (WHERE kind = 'craft' AND detected_at > now() - interval '24 hours')::int AS c24,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM detected_at - window_start))
        FILTER (WHERE kind IN ('upgrade','craft') AND detected_at > now() - interval '24 hours' AND confidence <> 'low') AS med,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM detected_at - window_start))
        FILTER (WHERE kind IN ('upgrade','craft') AND detected_at > now() - interval '24 hours' AND confidence <> 'low') AS p90
      FROM events`);
    const b = await this.pool.query(`SELECT
      (SELECT count(*)::int FROM gifts) AS g,
      (SELECT count(*)::int FROM collections) AS c,
      (SELECT count(*)::int FROM collections WHERE NOT baseline_done) AS bp`);
    const top = await this.pool.query(`SELECT g.collection, c.title, count(*)::int AS n FROM events e
      JOIN gifts g ON g.slug = e.gift_slug JOIN collections c ON c.base = g.collection
      WHERE e.kind IN ('upgrade','craft') AND e.detected_at > now() - interval '24 hours'
      GROUP BY g.collection, c.title ORDER BY n DESC LIMIT 10`);
    const r = a.rows[0];
    return {
      upgrades1h: r.u1, upgrades24h: r.u24, crafts24h: r.c24,
      windowMedianSec: r.med == null ? null : Number(r.med),
      windowP90Sec: r.p90 == null ? null : Number(r.p90),
      giftsTotal: b.rows[0].g, collectionsTotal: b.rows[0].c, baselinePending: b.rows[0].bp,
      top24h: top.rows,
    };
  }

  /** Удаляет старые подарки (и их события), кроме избранных и текущих «голов» коллекций */
  async cleanup(retentionDays: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM gifts g
       WHERE g.first_seen_at < now() - ($1::int * interval '1 day')
         AND NOT EXISTS (SELECT 1 FROM favorites f WHERE f.gift_slug = g.slug)
         AND NOT EXISTS (SELECT 1 FROM collections c WHERE c.base = g.collection AND c.head_num = g.num)`,
      [retentionDays],
    );
    return rowCount ?? 0;
  }

  async ping(): Promise<boolean> {
    await this.pool.query('SELECT 1');
    return true;
  }
}
