import { createServer } from 'node:http';
import { GrammyError } from 'grammy';
import { SESSION_KV_KEY, createBot, setBotCommands } from './bot/bot.js';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db/pool.js';
import { Repository } from './db/repository.js';
import { logger } from './logger.js';
import { Detector } from './monitor/detector.js';
import { CollectionDiscovery } from './monitor/discovery.js';
import { OwnerTracker } from './monitor/ownerTracker.js';
import { Scheduler, sleep } from './monitor/scheduler.js';
import { Notifier } from './notify/notifier.js';
import { MtprotoSource } from './sources/mtproto.js';
import { SourceRouter } from './sources/router.js';
import { WebSource } from './sources/web.js';
import { decrypt } from './util/crypto.js';

async function main() {
  const config = loadConfig();
  const startedAt = new Date();
  logger.info('Запуск сервиса мониторинга подарков');

  const pool = createPool(config.databaseUrl, config.databaseSsl);
  await migrate(pool);
  const repo = new Repository(pool);

  // --- источники ---
  const web = new WebSource(config.webMinRps, config.webMaxRps, config.webProbeMaxRps);
  const mtproto = new MtprotoSource(config.apiId, config.apiHash, config.mtprotoMaxRps);
  const sources = new SourceRouter(mtproto, web);
  if (mtproto.configured) {
    let session = config.tgSession;
    if (!session && config.sessionSecret) {
      const stored = await repo.kvGet<{ enc: string }>(SESSION_KV_KEY);
      if (stored?.enc) {
        try {
          session = decrypt(stored.enc, config.sessionSecret);
        } catch {
          logger.error('Не удалось расшифровать сохранённую сессию (сменился SESSION_SECRET?) — выполните /login заново');
        }
      }
    }
    if (session) await mtproto.connect(session);
    else logger.warn('MTProto настроен, но сессии нет — войдите через /login в боте. Пока работает web-источник.');
  } else {
    logger.warn('MTProto не настроен (TG_API_ID/TG_API_HASH) — работает только web-источник, username владельцев недоступен');
  }

  // --- мониторинг ---
  let notifier: Notifier | null = null;
  const onEvents = () => notifier?.kick();
  const detector = new Detector(repo, sources, {
    maxFetchPerTick: config.maxFetchPerTick,
    maxNotifyWindowMs: config.maxNotifyWindowMs,
    issuedRecheckEvery: 15,
  });
  const scheduler = new Scheduler(repo, detector, {
    workers: config.workers,
    hotIntervalMs: config.hotIntervalMs,
    warmIntervalMs: config.warmIntervalMs,
    coldIntervalMs: config.coldIntervalMs,
  }, onEvents);
  const discovery = new CollectionDiscovery(repo, mtproto, (base) => void notifier?.notifyNewCollection(base));

  const refreshPriority = async () => {
    const users = await repo.listUsers();
    scheduler.setPriority(users.flatMap((u) => (u.settings.enabled ? u.settings.selected : [])));
  };

  // --- бот ---
  const bot = createBot({
    config, repo, sources, scheduler, discovery, startedAt,
    notifierStats: () => ({ sent: notifier?.sent ?? 0, failed: notifier?.failed ?? 0, lastSentAt: notifier?.lastSentAt ?? null }),
    onSettingsChanged: () => void refreshPriority().catch(() => undefined),
  });
  notifier = new Notifier(bot.api, repo, config.timezone, config.sendImages);
  const tracker = new OwnerTracker(repo, sources, config.favoritesRecheckMs, onEvents);

  await discovery.run();
  await scheduler.reload();
  await refreshPriority();
  scheduler.start();
  notifier.start();
  tracker.start();
  const discoveryTimer = setInterval(() => {
    void discovery.run().then(() => scheduler.reload()).catch((e) => logger.error({ err: e }, 'Ошибка обновления каталога'));
  }, config.discoveryIntervalMs);

  const cleanup = () =>
    void repo.cleanup(config.retentionDays)
      .then((n) => n && logger.info({ deleted: n }, 'Удалены старые записи'))
      .catch((e) => logger.error({ err: e }, 'Ошибка очистки'));
  const cleanupTimer = setInterval(cleanup, 6 * 3600_000);
  cleanup();

  // --- health-check для Render ---
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith('/health')) {
      const tickAge = scheduler.lastTickAt ? Date.now() - scheduler.lastTickAt.getTime() : Infinity;
      const dbOk = await repo.ping().catch(() => false);
      const ok = dbOk && tickAge < 120_000;
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok, dbOk, tickAgeMs: tickAge, source: sources.activeName, collections: scheduler.size }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Telegram gift upgrade monitor is running. See /health');
  });
  server.listen(config.port, () => logger.info({ port: config.port }, 'Health-сервер запущен'));

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Остановка…');
    // Если что-то зависло (ожидание лимита запросов и т.п.) — выходим принудительно
    setTimeout(() => process.exit(0), 8000).unref();
    clearInterval(discoveryTimer);
    clearInterval(cleanupTimer);
    tracker.stop();
    notifier?.stop();
    await bot.stop().catch(() => undefined);
    await scheduler.stop();
    await mtproto.disconnect();
    server.close();
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => logger.error({ err: e }, 'Необработанная ошибка (promise)'));

  await setBotCommands(bot).catch((e) => logger.warn({ err: e }, 'Не удалось установить список команд'));

  // Long polling с автоматическим перезапуском (например, при 409 во время деплоя, когда старый экземпляр ещё жив)
  while (!stopping) {
    try {
      await bot.start({
        allowed_updates: ['message', 'callback_query'],
        onStart: (info) => logger.info({ bot: info.username }, 'Бот запущен (long polling)'),
      });
      if (!stopping) await sleep(5000);
    } catch (e) {
      const conflict = e instanceof GrammyError && e.error_code === 409;
      logger.error({ err: conflict ? '409 Conflict: работает другой экземпляр бота' : e }, 'Polling остановлен, перезапуск через 10 с');
      await sleep(10_000);
    }
  }
}

main().catch((e) => {
  logger.fatal({ err: e }, 'Критическая ошибка запуска');
  process.exit(1);
});
