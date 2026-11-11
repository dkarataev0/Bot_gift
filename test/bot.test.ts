/**
 * Тест бота «как в Telegram»: настоящие объекты Update подаются в grammY,
 * исходящие вызовы Bot API перехватываются. Нужен TEST_DATABASE_URL.
 */
import pg from 'pg';
import type { Update } from 'grammy/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBot } from '../src/bot/bot.js';
import type { AppConfig } from '../src/config.js';
import { createPool, migrate } from '../src/db/pool.js';
import { Repository } from '../src/db/repository.js';
import { Detector } from '../src/monitor/detector.js';
import { CollectionDiscovery } from '../src/monitor/discovery.js';
import { Scheduler } from '../src/monitor/scheduler.js';
import { Notifier } from '../src/notify/notifier.js';
import { MtprotoSource } from '../src/sources/mtproto.js';
import { SourceRouter } from '../src/sources/router.js';
import { WebSource } from '../src/sources/web.js';
import { gift } from './helpers.js';

const url = process.env.TEST_DATABASE_URL;
const OWNER = 111;
const STRANGER = 222;

describe.skipIf(!url)('Бот', () => {
  let pool: pg.Pool;
  let repo: Repository;
  let bot: ReturnType<typeof createBot>;
  let notifier: Notifier;
  let calls: { method: string; payload: any }[] = [];
  let updateId = 1;
  let msgId = 1000;

  const msg = (from: number, text: string): Update => ({
    update_id: updateId++,
    message: {
      message_id: msgId++, date: 0, text,
      chat: { id: from, type: 'private', first_name: 'U' },
      from: { id: from, is_bot: false, first_name: 'U' },
      entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] : undefined,
    },
  });
  const cb = (from: number, data: string): Update => ({
    update_id: updateId++,
    callback_query: {
      id: String(updateId), chat_instance: 'x', data,
      from: { id: from, is_bot: false, first_name: 'U' },
      message: { message_id: 1, date: 0, chat: { id: from, type: 'private', first_name: 'U' }, text: 'old' },
    },
  });
  const sent = (m = 'sendMessage') => calls.filter((c) => c.method === m);

  beforeAll(async () => {
    pool = createPool(url!, false);
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
    repo = new Repository(pool);
    await repo.upsertCollection('plushpepe', 'test', 'Plush Pepe');
    const sources = new SourceRouter(new MtprotoSource(undefined, undefined, 1), new WebSource(0.1, 0.5, 1));
    const scheduler = new Scheduler(repo, new Detector(repo, sources, { maxFetchPerTick: 5, maxNotifyWindowMs: 1e6, issuedRecheckEvery: 5 }),
      { workers: 1, hotIntervalMs: 1000, warmIntervalMs: 1000, coldIntervalMs: 1000 }, () => undefined);
    const config = { botToken: '1:x', allowedUserIds: [], timezone: 'UTC' } as unknown as AppConfig;
    bot = createBot({
      config, repo, sources, scheduler, startedAt: new Date(),
      discovery: new CollectionDiscovery(repo, sources.mtproto, () => undefined),
      notifierStats: () => ({ sent: 0, failed: 0, lastSentAt: null }),
      onSettingsChanged: () => undefined,
      botInfo: { id: 1, is_bot: true, first_name: 'B', username: 'test_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as any,
    });
    bot.api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload });
      const result = method.startsWith('send') || method.startsWith('edit')
        ? { message_id: msgId++, date: 0, chat: { id: (payload as any).chat_id, type: 'private' }, text: '' }
        : true;
      return { ok: true, result } as any;
    });
    await bot.init();
    notifier = new Notifier(bot.api, repo, 'UTC', true);
  });
  afterAll(async () => pool?.end());
  beforeEach(() => {
    calls = [];
  });

  it('/start: первый пользователь становится владельцем, получает меню', async () => {
    await bot.handleUpdate(msg(OWNER, '/start'));
    const m = sent()[0]!;
    expect(m.payload.text).toContain('Мониторинг улучшенных подарков');
    expect(JSON.stringify(m.payload.reply_markup)).toContain('m:filters');
    expect((await repo.getUser(OWNER))!.isOwner).toBe(true);
  });

  it('посторонний пользователь не получает доступ', async () => {
    await bot.handleUpdate(msg(STRANGER, '/start'));
    expect(sent()[0]!.payload.text).toContain('приватный бот');
    expect(await repo.getUser(STRANGER)).toBeNull();
  });

  it('все команды отвечают', async () => {
    for (const c of ['/settings', '/filters', '/latest', '/favorites', '/stats', '/status', '/help', '/collections']) {
      calls = [];
      await bot.handleUpdate(msg(OWNER, c));
      expect(sent().length, c).toBeGreaterThan(0);
    }
  });

  it('фильтры кнопками сохраняются в БД', async () => {
    await bot.handleUpdate(cb(OWNER, 'f:username'));
    expect((await repo.getUser(OWNER))!.settings.onlyWithUsername).toBe(true);
    expect(sent('editMessageText').length).toBe(1);
    await bot.handleUpdate(cb(OWNER, 'f:username'));
    await bot.handleUpdate(cb(OWNER, 'f:rar'));
    expect((await repo.getUser(OWNER))!.settings.maxPermille).toBe(50);
    await bot.handleUpdate(cb(OWNER, 'f:rar'));
    await bot.handleUpdate(cb(OWNER, 'f:rar'));
    await bot.handleUpdate(cb(OWNER, 'f:rar'));
    await bot.handleUpdate(cb(OWNER, 'f:rar'));
    expect((await repo.getUser(OWNER))!.settings.maxPermille).toBeNull();
    await bot.handleUpdate(cb(OWNER, 'c:t:plushpepe:0'));
    expect((await repo.getUser(OWNER))!.settings.selected).toEqual(['plushpepe']);
    await bot.handleUpdate(cb(OWNER, 'c:t:plushpepe:0'));
    expect((await repo.getUser(OWNER))!.settings.muted).toEqual(['plushpepe']);
    await bot.handleUpdate(cb(OWNER, 'c:t:plushpepe:0'));
    const s = (await repo.getUser(OWNER))!.settings;
    expect(s.selected).toEqual([]);
    expect(s.muted).toEqual([]);
    await bot.handleUpdate(msg(OWNER, '/models Pumpkin, Cyberpunk'));
    expect((await repo.getUser(OWNER))!.settings.models).toEqual(['Pumpkin', 'Cyberpunk']);
    await bot.handleUpdate(msg(OWNER, '/models clear'));
    expect((await repo.getUser(OWNER))!.settings.models).toEqual([]);
  });

  it('уведомление о новом улучшении: доходит один раз, с кнопками; избранное работает', async () => {
    await repo.upsertGift(gift('plushpepe', 42, { ownerUsername: 'owner_x', ownerName: 'Owner X' }));
    await repo.insertEvent({ dedupKey: 'new:plushpepe-42', giftSlug: 'plushpepe-42', kind: 'upgrade', confidence: 'high',
      detectedAt: new Date(), windowStart: new Date(Date.now() - 3000), windowEnd: new Date(), notify: true, details: {} });
    await notifier.flush();
    const m = sent();
    expect(m).toHaveLength(1);
    expect(m[0]!.payload.chat_id).toBe(OWNER);
    expect(m[0]!.payload.text).toContain('#42');
    const kb = JSON.stringify(m[0]!.payload.reply_markup);
    expect(kb).toContain('https://t.me/owner_x?text=');
    expect(kb).toContain('fav:plushpepe-42');

    calls = [];
    await notifier.flush();
    expect(sent()).toHaveLength(0); // повторно не отправляется

    await bot.handleUpdate(cb(OWNER, 'fav:plushpepe-42'));
    expect(await repo.isFavorite(OWNER, 'plushpepe-42')).toBe(true);
    expect(sent('editMessageReplyMarkup')).toHaveLength(1);
    calls = [];
    await bot.handleUpdate(msg(OWNER, '/favorites'));
    expect(sent()[0]!.payload.text).toContain('Plush Pepe #42');
  });

  it('фильтр «только выбранные» отсекает чужие коллекции', async () => {
    const u = (await repo.getUser(OWNER))!;
    await repo.saveSettings(OWNER, { ...u.settings, mode: 'selected', selected: ['durovscap'] });
    await repo.upsertGift(gift('plushpepe', 43));
    await repo.insertEvent({ dedupKey: 'new:plushpepe-43', giftSlug: 'plushpepe-43', kind: 'upgrade', confidence: 'high',
      detectedAt: new Date(), windowStart: null, windowEnd: null, notify: true, details: {} });
    await notifier.flush();
    expect(sent()).toHaveLength(0);
    expect(await repo.pendingEvents()).toHaveLength(0);
  });
});
