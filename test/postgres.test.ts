/**
 * Интеграционные тесты на настоящем PostgreSQL. Запускаются, если задан TEST_DATABASE_URL
 * (пустая тестовая БД — таблицы будут пересозданы!).
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrate } from '../src/db/pool.js';
import { Repository } from '../src/db/repository.js';
import { Detector } from '../src/monitor/detector.js';
import { Clock, FakeSource, gift } from './helpers.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('PostgreSQL', () => {
  let pool: pg.Pool;
  let repo: Repository;

  beforeAll(async () => {
    pool = createPool(url!, false);
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
    await migrate(pool); // повторный запуск миграций безопасен
    repo = new Repository(pool);
  });
  afterAll(async () => pool?.end());

  it('дедупликация событий и уведомлений', async () => {
    await repo.upsertCollection('plushpepe', 'test');
    await repo.upsertGift(gift('plushpepe', 1));
    const e = { dedupKey: 'new:plushpepe-1', giftSlug: 'plushpepe-1', kind: 'upgrade' as const, confidence: 'high' as const, detectedAt: new Date(), windowStart: null, windowEnd: null, notify: true, details: {} };
    const first = await repo.insertEvent(e);
    expect(first).not.toBeNull();
    expect(await repo.insertEvent(e)).toBeNull();
    await repo.upsertUser(100, 'me', true);
    expect(await repo.claimNotification(first!.id, 100)).toBe(true);
    expect(await repo.claimNotification(first!.id, 100)).toBe(false);
    expect((await repo.pendingEvents()).map((x) => x.id)).toContain(first!.id);
    await repo.setEventStatus(first!.id, 'done');
    expect((await repo.pendingEvents()).map((x) => x.id)).not.toContain(first!.id);
  });

  it('детектор + перезапуск: состояние сохраняется, старые подарки не рассылаются, дублей нет', async () => {
    await repo.upsertCollection('lolpop', 'test');
    const source = new FakeSource();
    source.issued.set('lolpop', 500);
    const clock = new Clock();
    const opts = { maxFetchPerTick: 25, maxNotifyWindowMs: 15 * 60_000, issuedRecheckEvery: 10, now: clock.now };

    const d1 = new Detector(repo, source, opts);
    await d1.checkCollection((await repo.getCollection('lolpop'))!);
    expect((await repo.getCollection('lolpop'))!.headNum).toBe(500);

    clock.advance(3000);
    source.issued.set('lolpop', 502);
    const o1 = await d1.checkCollection((await repo.getCollection('lolpop'))!);
    expect(o1.events).toHaveLength(2);

    // «перезапуск»: новый детектор, состояние из БД
    const d2 = new Detector(repo, source, opts);
    clock.advance(3000);
    const o2 = await d2.checkCollection((await repo.getCollection('lolpop'))!);
    expect(o2.status).toBe('quiet');
    clock.advance(3000);
    source.issued.set('lolpop', 503);
    const o3 = await d2.checkCollection((await repo.getCollection('lolpop'))!);
    expect(o3.events.map((e) => e.giftSlug)).toEqual(['lolpop-503']);

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM events WHERE gift_slug LIKE 'lolpop-%'`);
    expect(rows[0].n).toBe(3);
    const recent = await repo.recentUpgrades(10, 'lolpop');
    expect(recent[0]!.gift.slug).toBe('lolpop-503');
  });

  it('избранное, настройки, статистика', async () => {
    await repo.upsertUser(200, null, false);
    expect(await repo.toggleFavorite(200, 'lolpop-501')).toBe(true);
    expect((await repo.listFavorites(200)).map((g) => g.slug)).toEqual(['lolpop-501']);
    expect(await repo.favoritesDueForRecheck(0, 10)).toContain('lolpop-501');
    expect(await repo.toggleFavorite(200, 'lolpop-501')).toBe(false);
    const u = (await repo.getUser(200))!;
    await repo.saveSettings(200, { ...u.settings, muted: ['lolpop'] });
    expect((await repo.getUser(200))!.settings.muted).toEqual(['lolpop']);
    const st = await repo.stats();
    expect(st.upgrades24h).toBeGreaterThanOrEqual(3);
    expect(st.windowMedianSec).not.toBeNull();
  });

  it('kv', async () => {
    await repo.kvSet('x', { a: 1 });
    expect(await repo.kvGet('x')).toEqual({ a: 1 });
    await repo.kvDelete('x');
    expect(await repo.kvGet('x')).toBeNull();
  });
});
