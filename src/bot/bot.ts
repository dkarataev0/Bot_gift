import { autoRetry } from '@grammyjs/auto-retry';
import { Bot, type Context, InlineKeyboard, InputFile } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import QRCode from 'qrcode';
import type { AppConfig } from '../config.js';
import type { Repository, UserRow } from '../db/repository.js';
import { logger } from '../logger.js';
import type { CollectionDiscovery } from '../monitor/discovery.js';
import type { Scheduler } from '../monitor/scheduler.js';
import { displayTitle, esc, fmtOwner, fmtPermille, fmtTime, formatGiftCard, giftKeyboard, giftUrl } from '../notify/format.js';
import { loginWithQr } from '../sources/mtproto.js';
import type { SourceRouter } from '../sources/router.js';
import { DEFAULT_TRADE_TEMPLATE, type UserSettings, parseSlug } from '../types.js';
import { encrypt } from '../util/crypto.js';

export const SESSION_KV_KEY = 'mtproto_session';

export interface BotDeps {
  config: AppConfig;
  repo: Repository;
  sources: SourceRouter;
  scheduler: Scheduler;
  discovery: CollectionDiscovery;
  notifierStats: () => { sent: number; failed: number; lastSentAt: Date | null };
  onSettingsChanged: () => void;
  startedAt: Date;
  /** Для тестов: не вызывать getMe */
  botInfo?: UserFromGetMe;
}

type Pending = { kind: 'models' | 'template' } | { kind: 'password'; resolve: (s: string) => void };

const RARITY_STEPS: (number | null)[] = [null, 50, 20, 10, 5];
const ATTR_STEPS: UserSettings['rarityAttr'][] = ['any', 'model', 'backdrop', 'symbol'];
const ATTR_RU: Record<UserSettings['rarityAttr'], string> = { any: 'любой атрибут', model: 'модель', backdrop: 'фон', symbol: 'узор' };
const PAGE = 30;

const onOff = (v: boolean) => (v ? '✅' : '❌');

function mainKeyboard() {
  return new InlineKeyboard()
    .text('🆕 Последние', 'm:latest').text('⭐ Избранное', 'm:fav').row()
    .text('🎛 Фильтры', 'm:filters').text('⚙️ Настройки', 'm:settings').row()
    .text('📊 Статистика', 'm:stats').text('🩺 Статус', 'm:status');
}

export function createBot(deps: BotDeps): Bot {
  const { config, repo, sources } = deps;
  const bot = new Bot(config.botToken, deps.botInfo ? { botInfo: deps.botInfo } : undefined);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
  const pending = new Map<number, Pending>();
  let loginAbort: AbortController | null = null;

  // ---------- доступ ----------
  async function authorize(ctx: Context): Promise<UserRow | null> {
    const from = ctx.from;
    if (!from || from.is_bot) return null;
    if (ctx.chat && ctx.chat.type !== 'private') return null;
    const existing = await repo.getUser(from.id);
    if (config.allowedUserIds.length) {
      if (!config.allowedUserIds.includes(from.id)) return null;
      return existing ?? repo.upsertUser(from.id, from.username ?? null, true);
    }
    if (existing) return existing;
    // Список не задан: первый написавший /start становится владельцем бота
    if ((await repo.countOwners()) === 0 && ctx.message?.text?.startsWith('/start')) {
      logger.info({ userId: from.id }, 'Зарегистрирован владелец бота');
      return repo.upsertUser(from.id, from.username ?? null, true);
    }
    return null;
  }

  const users = new WeakMap<Context, UserRow>();
  bot.use(async (ctx, next) => {
    const u = await authorize(ctx);
    if (!u) {
      if (ctx.chat?.type === 'private' && ctx.message) {
        await ctx.reply(`⛔ Это приватный бот. Ваш Telegram ID: <code>${ctx.from?.id}</code>`, { parse_mode: 'HTML' });
      } else if (ctx.callbackQuery) await ctx.answerCallbackQuery('Нет доступа');
      return;
    }
    users.set(ctx, u);
    await next();
  });
  const me = (ctx: Context) => users.get(ctx)!;

  async function save(ctx: Context, s: UserSettings) {
    await repo.saveSettings(me(ctx).chatId, s);
    me(ctx).settings = s;
    deps.onSettingsChanged();
  }

  async function show(ctx: Context, text: string, kb?: InlineKeyboard) {
    const opts = { parse_mode: 'HTML' as const, reply_markup: kb, link_preview_options: { is_disabled: true } };
    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(text, opts);
        return;
      } catch (e) {
        if (String(e).includes('message is not modified')) return;
      }
    }
    await ctx.reply(text, opts);
  }

  // ---------- экраны ----------
  function mainText(u: UserRow) {
    const mt = sources.mtproto.isReady() ? '✅ MTProto (полные данные + username владельца)' : '🟡 только публичные страницы t.me (без username владельца)';
    return [
      '🎁 <b>Мониторинг улучшенных подарков Telegram</b>',
      '',
      `Уведомления: ${u.settings.enabled ? '✅ включены' : '⏸ на паузе'}`,
      `Источник: ${mt}`,
      `Коллекций под наблюдением: ${deps.scheduler.size}`,
      '',
      'Бот присылает уведомление, когда в любой коллекции появляется новый порядковый номер — то есть кто-то только что улучшил подарок.',
    ].join('\n');
  }

  function settingsView(s: UserSettings) {
    const text = [
      '⚙️ <b>Настройки</b>',
      '',
      `Шаблон предложения обмена:\n<blockquote>${esc(s.tradeTemplate)}</blockquote>`,
      'Изменить: <code>/template ваш текст</code> ({gift} — подарок, {link} — ссылка, {owner} — владелец). Сброс: <code>/template reset</code>',
    ].join('\n');
    const kb = new InlineKeyboard()
      .text(`${onOff(s.enabled)} Уведомления`, 's:enabled').row()
      .text(`${onOff(s.notifyNewCollections)} О новых коллекциях`, 's:notifyNewCollections').row()
      .text(`${onOff(s.notifyFavoritesChanges)} Смена владельца/продажа избранного`, 's:notifyFavoritesChanges').row()
      .text('⬅️ Меню', 'm:main');
    return { text, kb };
  }

  function filtersView(s: UserSettings) {
    const text = [
      '🎛 <b>Фильтры уведомлений</b>',
      '',
      `Коллекции: ${s.mode === 'all' ? `все${s.muted.length ? ` (кроме ${s.muted.length} отключённых)` : ''}` : `только выбранные (${s.selected.length})`}`,
      `Только с публичным username: ${s.onlyWithUsername ? 'да' : 'нет'}`,
      `Модели: ${s.models.length ? esc(s.models.join(', ')) : 'любые'}`,
      `Редкость: ${s.maxPermille == null ? 'любая' : `≤ ${fmtPermille(s.maxPermille)} (${ATTR_RU[s.rarityAttr]})`}`,
      `Крафтовые подарки: ${s.includeCrafted ? 'показывать' : 'скрывать'}`,
      '',
      'Модели: <code>/models Pumpkin, Cyberpunk</code> или <code>/models clear</code>',
      s.onlyWithUsername && !sources.mtproto.isReady()
        ? '\n⚠️ Без MTProto username владельца неизвестен — с фильтром «только с username» уведомлений не будет.'
        : '',
    ].join('\n');
    const kb = new InlineKeyboard()
      .text(`📚 Коллекции: ${s.mode === 'all' ? 'все' : 'выбранные'}`, 'f:mode').text('✏️ Выбрать', 'c:p:0').row()
      .text(`${onOff(s.onlyWithUsername)} Только с username`, 'f:username').row()
      .text(`💎 Редкость: ${s.maxPermille == null ? 'любая' : '≤' + fmtPermille(s.maxPermille)}`, 'f:rar')
      .text(`🔎 ${ATTR_RU[s.rarityAttr]}`, 'f:attr').row()
      .text('🧸 Задать модели', 'f:models').text(`${onOff(s.includeCrafted)} Крафт`, 'f:craft').row()
      .text('♻️ Сбросить фильтры', 'f:reset').text('⬅️ Меню', 'm:main');
    return { text, kb };
  }

  async function collectionsView(s: UserSettings, page: number) {
    const cols = (await repo.listCollections()).sort((a, b) => displayTitle({ title: a.title, collection: a.base }).localeCompare(displayTitle({ title: b.title, collection: b.base })));
    const pages = Math.max(1, Math.ceil(cols.length / PAGE));
    page = Math.min(Math.max(0, page), pages - 1);
    const kb = new InlineKeyboard();
    cols.slice(page * PAGE, page * PAGE + PAGE).forEach((c, i) => {
      const mark = s.selected.includes(c.base) ? '✅' : s.muted.includes(c.base) ? '🔇' : '▫️';
      kb.text(`${mark} ${(c.title ?? c.base).slice(0, 22)}`, `c:t:${c.base}:${page}`);
      if (i % 2 === 1) kb.row();
    });
    kb.row();
    if (page > 0) kb.text('◀️', `c:p:${page - 1}`);
    kb.text(`${page + 1}/${pages}`, 'noop');
    if (page < pages - 1) kb.text('▶️', `c:p:${page + 1}`);
    kb.row().text('⬅️ Фильтры', 'm:filters');
    const text = [
      '📚 <b>Коллекции</b>',
      'Нажатие переключает: ▫️ обычная → ✅ выбрана → 🔇 отключена.',
      `Режим: <b>${s.mode === 'all' ? 'все, кроме 🔇' : 'только ✅'}</b> (переключается в фильтрах). Выбранные проверяются чаще.`,
    ].join('\n');
    return { text, kb };
  }

  async function latestText(collection?: string) {
    const list = await repo.recentUpgrades(15, collection);
    if (!list.length) return '🆕 Пока не обнаружено ни одного нового улучшения. Мониторинг работает — новые появятся здесь.';
    const lines = ['🆕 <b>Последние обнаруженные улучшения</b>', ''];
    for (const e of list) {
      const g = e.gift;
      const mark = e.kind === 'craft' ? '🛠' : e.confidence === 'low' ? '⚪' : '🎁';
      lines.push(`${mark} <a href="${giftUrl(g)}">${esc(displayTitle(g))} #${g.num}</a> · ${esc(g.model?.name ?? '?')} / ${esc(g.backdrop?.name ?? '?')} · ${fmtOwner(g)} · ${fmtTime(e.detectedAt, config.timezone, true)}`);
    }
    lines.push('', '🎁 улучшение · 🛠 крафт · ⚪ найдено после перерыва');
    return lines.join('\n');
  }

  async function favoritesView(chatId: number) {
    const favs = await repo.listFavorites(chatId);
    const kb = new InlineKeyboard();
    if (!favs.length) return { text: '⭐ Избранное пусто. Нажмите «⭐ В избранное» под уведомлением.', kb: kb.text('⬅️ Меню', 'm:main') };
    const lines = ['⭐ <b>Избранное</b> (смена владельца и выставление на продажу отслеживаются)', ''];
    favs.slice(0, 30).forEach((g, i) => {
      lines.push(`${i + 1}. <a href="${giftUrl(g)}">${esc(displayTitle(g))} #${g.num}</a> — ${fmtOwner(g)}`);
      kb.text(`✖️ ${i + 1}`, `fv:rm:${g.slug}`);
      if (i % 5 === 4) kb.row();
    });
    kb.row().text('⬅️ Меню', 'm:main');
    return { text: lines.join('\n'), kb };
  }

  async function statsText() {
    const s = await repo.stats();
    const cyc = deps.scheduler.approxCycleSec;
    const lines = [
      '📊 <b>Статистика мониторинга</b>',
      '',
      `Улучшений за 1 ч: <b>${s.upgrades1h}</b>, за 24 ч: <b>${s.upgrades24h}</b>, крафтов за 24 ч: ${s.crafts24h}`,
      `Подарков в базе: ${s.giftsTotal}, коллекций: ${s.collectionsTotal}${s.baselinePending ? ` (первичная загрузка: осталось ${s.baselinePending})` : ''}`,
      '',
      '<b>Задержка обнаружения</b> (от последней проверки, когда номера ещё не было, до обнаружения — это верхняя граница реальной задержки):',
      `медиана: ${s.windowMedianSec == null ? 'нет данных' : `${s.windowMedianSec.toFixed(1)} с`}, 90%: ${s.windowP90Sec == null ? 'нет данных' : `${s.windowP90Sec.toFixed(1)} с`}`,
      `Средний цикл проверки всех коллекций: ${cyc == null ? 'считается…' : `${cyc.toFixed(0)} с`}`,
    ];
    if (s.top24h.length) {
      lines.push('', '<b>Самые активные коллекции за 24 ч:</b>');
      for (const t of s.top24h) lines.push(`• ${esc(t.title ?? t.collection)} — ${t.n}`);
    }
    return lines.join('\n');
  }

  async function statusText() {
    const m = sources.mtproto;
    const w = sources.web;
    const sch = deps.scheduler;
    const n = deps.notifierStats();
    const dbOk = await repo.ping().catch(() => false);
    const pct = (x: number | null) => (x == null ? '—' : `${Math.round(x * 100)}%`);
    const ago = (d: Date | null) => (d ? `${Math.round((Date.now() - d.getTime()) / 1000)} с назад` : 'никогда');
    const upMin = Math.round((Date.now() - deps.startedAt.getTime()) / 60000);
    return [
      '🩺 <b>Состояние системы</b>',
      '',
      `База данных: ${dbOk ? '✅' : '❌'}`,
      `Активный источник: <b>${sources.activeName === 'mtproto' ? 'MTProto' : 't.me (web)'}</b>`,
      '',
      `<b>MTProto</b>: ${!m.configured ? 'не настроен (нет TG_API_ID/TG_API_HASH)' : m.isReady() ? `✅ подключён (аккаунт ${m.me?.id})` : `❌ не подключён${m.lastAuthError ? ` — ${esc(m.lastAuthError)}` : ' — выполните /login'}`}`,
      m.isReady() ? `  темп ${m.limiter.currentRps.toFixed(2)} запр/с, успешных ${pct(m.health.recentSuccessRate)}, задержка ${m.health.medianLatencyMs ?? '—'} мс${m.limiter.pausedForMs ? `, пауза ${Math.ceil(m.limiter.pausedForMs / 1000)} с (FLOOD_WAIT)` : ''}` : '',
      `<b>t.me (web)</b>: темп страниц ${w.limiter.currentRps.toFixed(2)} запр/с, проб ${w.probeLimiter.currentRps.toFixed(2)} запр/с, успешных ${pct(w.health.recentSuccessRate)}, последний успех ${ago(w.health.lastOkAt)}${w.health.lastError ? `, последняя ошибка: ${esc(w.health.lastError)}` : ''}`,
      `<b>Каталог коллекций</b>: ${deps.discovery.lastRunAt ? `обновлён ${ago(deps.discovery.lastRunAt)}` : 'ещё не обновлялся'}${deps.discovery.lastError ? ` (ошибка fragment: ${esc(deps.discovery.lastError)})` : ''}`,
      '',
      `<b>Мониторинг</b>: коллекций ${sch.size}, проверок ${sch.checks}, ошибок ${sch.errors}, последний цикл ${ago(sch.lastTickAt)}`,
      sch.lastError ? `  последняя ошибка: ${esc(sch.lastError.slice(0, 200))}` : '',
      `<b>Уведомления</b>: отправлено ${n.sent}, ошибок ${n.failed}, последнее ${ago(n.lastSentAt)}`,
      `Аптайм: ${upMin} мин`,
    ].filter((l) => l !== '').join('\n');
  }

  // ---------- команды ----------
  bot.command(['start', 'menu'], async (ctx) => {
    await ctx.reply(mainText(me(ctx)), { parse_mode: 'HTML', reply_markup: mainKeyboard() });
  });
  bot.command('help', async (ctx) => {
    await ctx.reply(
      [
        '<b>Команды</b>',
        '/start — главное меню', '/settings — настройки', '/filters — фильтры', '/latest — последние улучшения',
        '/favorites — избранное', '/stats — статистика', '/status — состояние источников',
        '/gift &lt;ссылка или slug&gt; — посмотреть подарок', '/models — фильтр моделей', '/template — шаблон предложения обмена',
        '/login — подключить аккаунт для MTProto (по QR-коду)', '/logout — отключить аккаунт', '/cancel — отменить ввод',
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
  });
  bot.command('settings', async (ctx) => {
    const v = settingsView(me(ctx).settings);
    await show(ctx, v.text, v.kb);
  });
  bot.command('filters', async (ctx) => {
    const v = filtersView(me(ctx).settings);
    await show(ctx, v.text, v.kb);
  });
  bot.command('collections', async (ctx) => {
    const v = await collectionsView(me(ctx).settings, 0);
    await show(ctx, v.text, v.kb);
  });
  bot.command('latest', async (ctx) => {
    const arg = ctx.match?.trim().toLowerCase().replace(/[^a-z0-9]/g, '') || undefined;
    await show(ctx, await latestText(arg), new InlineKeyboard().text('🔄 Обновить', 'm:latest').text('⬅️ Меню', 'm:main'));
  });
  bot.command('favorites', async (ctx) => {
    const v = await favoritesView(me(ctx).chatId);
    await show(ctx, v.text, v.kb);
  });
  bot.command('stats', async (ctx) => show(ctx, await statsText(), new InlineKeyboard().text('🔄 Обновить', 'm:stats').text('⬅️ Меню', 'm:main')));
  bot.command('status', async (ctx) => show(ctx, await statusText(), new InlineKeyboard().text('🔄 Обновить', 'm:status').text('⬅️ Меню', 'm:main')));

  bot.command('models', async (ctx) => {
    const arg = ctx.match?.trim();
    const s = { ...me(ctx).settings };
    if (!arg) {
      pending.set(me(ctx).chatId, { kind: 'models' });
      await ctx.reply('Пришлите названия моделей через запятую (например: <code>Pumpkin, Cyberpunk</code>) или «clear» для сброса. /cancel — отмена.', { parse_mode: 'HTML' });
      return;
    }
    s.models = arg.toLowerCase() === 'clear' ? [] : arg.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 50);
    await save(ctx, s);
    await ctx.reply(s.models.length ? `Фильтр моделей: ${s.models.join(', ')}` : 'Фильтр моделей сброшен — любые модели.');
  });

  bot.command('template', async (ctx) => {
    const arg = ctx.match?.trim();
    if (!arg) {
      pending.set(me(ctx).chatId, { kind: 'template' });
      await ctx.reply('Пришлите новый текст предложения обмена ({gift}, {link}, {owner} будут подставлены). «reset» — вернуть стандартный. /cancel — отмена.');
      return;
    }
    const s = { ...me(ctx).settings, tradeTemplate: arg.toLowerCase() === 'reset' ? DEFAULT_TRADE_TEMPLATE : arg.slice(0, 1000) };
    await save(ctx, s);
    await ctx.reply('Шаблон сохранён.');
  });

  bot.command('gift', async (ctx) => {
    const raw = (ctx.match ?? '').trim();
    const slugRaw = raw.replace(/^https?:\/\/t\.me\/nft\//i, '').replace(/^tg:\/\/nft\?slug=/i, '').split(/[?#\s]/)[0] ?? '';
    const p = parseSlug(slugRaw);
    if (!p) {
      await ctx.reply('Формат: /gift https://t.me/nft/PlushPepe-1 или /gift PlushPepe-1');
      return;
    }
    const slug = `${p.collection}-${p.num}`;
    const r = await sources.fetchBest(slug);
    if (r.status === 'not_found') return void (await ctx.reply('Такого подарка нет.'));
    if (r.status === 'unavailable') return void (await ctx.reply(`Источник временно недоступен: ${r.reason}. Попробуйте позже.`));
    await repo.upsertCollection(p.collection, 'manual');
    await repo.upsertGift(r.gift);
    const fav = await repo.isFavorite(me(ctx).chatId, slug);
    await ctx.reply(formatGiftCard(r.gift, '🔍 <b>Подарок</b>'), {
      parse_mode: 'HTML',
      reply_markup: giftKeyboard(r.gift, me(ctx).settings.tradeTemplate, fav),
      link_preview_options: { url: giftUrl(r.gift), prefer_large_media: true, show_above_text: true },
    });
  });

  bot.command('cancel', async (ctx) => {
    pending.delete(me(ctx).chatId);
    loginAbort?.abort();
    await ctx.reply('Отменено.');
  });

  // ---------- вход в аккаунт MTProto по QR ----------
  bot.command('login', async (ctx) => {
    const u = me(ctx);
    if (!u.isOwner) return void (await ctx.reply('Доступно только владельцу бота.'));
    if (!config.apiId || !config.apiHash) {
      return void (await ctx.reply('Сначала задайте TG_API_ID и TG_API_HASH в переменных окружения (см. README).'));
    }
    if (!config.sessionSecret) {
      return void (await ctx.reply('Сначала задайте переменную окружения SESSION_SECRET (любая длинная случайная строка) — ею шифруется сессия в базе.'));
    }
    if (loginAbort) return void (await ctx.reply('Вход уже выполняется. /cancel — отменить.'));
    const { apiId, apiHash, sessionSecret } = config;
    loginAbort = new AbortController();
    const timeout = setTimeout(() => loginAbort?.abort(), 5 * 60_000);
    let qrMsgId: number | null = null;
    await ctx.reply(
      [
        '🔐 <b>Подключение аккаунта (MTProto)</b>',
        'Нужно для получения username владельцев и максимальной скорости.',
        'Рекомендуется отдельный (второй) аккаунт. Используется только чтение публичных данных подарков.',
        '',
        'Откройте Telegram на телефоне с этим аккаунтом → <b>Настройки → Устройства → Подключить устройство</b> и отсканируйте QR-код ниже.',
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
    // Вход выполняется в фоне: обработчик должен завершиться, иначе бот не получит сообщение с паролем 2FA
    void (async () => {
    try {
      const res = await loginWithQr({
        apiId,
        apiHash,
        signal: loginAbort.signal,
        onUrl: async (url, expires) => {
          const png = await QRCode.toBuffer(url, { width: 512, margin: 2 });
          if (qrMsgId) await ctx.api.deleteMessage(u.chatId, qrMsgId).catch(() => undefined);
          const m = await ctx.replyWithPhoto(new InputFile(png, 'login.png'), {
            caption: `QR-код действует до ${fmtTime(expires, config.timezone)}. Обновится автоматически.`,
          });
          qrMsgId = m.message_id;
        },
        getPassword: () =>
          new Promise<string>((resolve) => {
            pending.set(u.chatId, { kind: 'password', resolve });
            void ctx.reply('На аккаунте включена двухэтапная проверка. Отправьте пароль одним сообщением — бот сразу удалит его из чата.');
          }),
        onInvalidPassword: async () => {
          await ctx.reply('Неверный пароль, попробуйте ещё раз.');
        },
      });
      await repo.kvSet(SESSION_KV_KEY, { enc: encrypt(res.session, sessionSecret), userId: res.userId, savedAt: new Date().toISOString() });
      const ok = await sources.mtproto.connect(res.session);
      await ctx.reply(ok ? `✅ Аккаунт подключён${res.username ? ` (@${res.username})` : ''}. Теперь используется MTProto.` : `⚠️ Вход выполнен, но подключиться не удалось: ${sources.mtproto.lastAuthError}`);
      if (ok) void deps.discovery.run().then(() => deps.scheduler.reload());
    } catch (e) {
      const msg = loginAbort?.signal.aborted ? 'отменён или истекло время' : e instanceof Error ? e.message : String(e);
      logger.warn({ err: msg }, 'Вход по QR не выполнен');
      await ctx.reply(`❌ Вход не выполнен: ${esc(msg)}`, { parse_mode: 'HTML' });
    } finally {
      clearTimeout(timeout);
      loginAbort = null;
      if (pending.get(u.chatId)?.kind === 'password') pending.delete(u.chatId);
      if (qrMsgId) await ctx.api.deleteMessage(u.chatId, qrMsgId).catch(() => undefined);
    }
    })();
  });

  bot.command('logout', async (ctx) => {
    if (!me(ctx).isOwner) return;
    await repo.kvDelete(SESSION_KV_KEY);
    await sources.mtproto.disconnect();
    await ctx.reply(
      'Сессия удалена из базы, MTProto отключён. Чтобы полностью завершить сеанс, откройте в Telegram: Настройки → Устройства и завершите сеанс «mtcute».' +
        (config.tgSession ? '\n⚠️ Задана переменная TG_SESSION — удалите её в настройках Render, иначе после перезапуска сессия подключится снова.' : ''),
    );
  });

  // ---------- текстовый ввод ----------
  bot.on('message:text', async (ctx, next) => {
    const st = pending.get(me(ctx).chatId);
    if (!st || ctx.message.text.startsWith('/')) return next();
    pending.delete(me(ctx).chatId);
    const text = ctx.message.text.trim();
    if (st.kind === 'password') {
      await ctx.deleteMessage().catch(() => undefined);
      st.resolve(text);
      await ctx.reply('Пароль получен и удалён из чата, проверяю…');
      return;
    }
    const s = { ...me(ctx).settings };
    if (st.kind === 'models') {
      s.models = text.toLowerCase() === 'clear' ? [] : text.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 50);
      await save(ctx, s);
      const v = filtersView(s);
      await ctx.reply(v.text, { parse_mode: 'HTML', reply_markup: v.kb });
    } else {
      s.tradeTemplate = text.toLowerCase() === 'reset' ? DEFAULT_TRADE_TEMPLATE : text.slice(0, 1000);
      await save(ctx, s);
      await ctx.reply('Шаблон сохранён.');
    }
  });

  // ---------- кнопки ----------
  bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery());
  bot.callbackQuery(/^m:(\w+)$/, async (ctx) => {
    const u = me(ctx);
    await ctx.answerCallbackQuery();
    switch (ctx.match[1]) {
      case 'main': return show(ctx, mainText(u), mainKeyboard());
      case 'settings': { const v = settingsView(u.settings); return show(ctx, v.text, v.kb); }
      case 'filters': { const v = filtersView(u.settings); return show(ctx, v.text, v.kb); }
      case 'latest': return show(ctx, await latestText(), new InlineKeyboard().text('🔄 Обновить', 'm:latest').text('⬅️ Меню', 'm:main'));
      case 'fav': { const v = await favoritesView(u.chatId); return show(ctx, v.text, v.kb); }
      case 'stats': return show(ctx, await statsText(), new InlineKeyboard().text('🔄 Обновить', 'm:stats').text('⬅️ Меню', 'm:main'));
      case 'status': return show(ctx, await statusText(), new InlineKeyboard().text('🔄 Обновить', 'm:status').text('⬅️ Меню', 'm:main'));
    }
  });

  bot.callbackQuery(/^s:(enabled|notifyNewCollections|notifyFavoritesChanges)$/, async (ctx) => {
    const key = ctx.match[1] as 'enabled' | 'notifyNewCollections' | 'notifyFavoritesChanges';
    const s = { ...me(ctx).settings, [key]: !me(ctx).settings[key] };
    await save(ctx, s);
    await ctx.answerCallbackQuery('Сохранено');
    const v = settingsView(s);
    await show(ctx, v.text, v.kb);
  });

  bot.callbackQuery(/^f:(mode|username|rar|attr|craft|reset|models)$/, async (ctx) => {
    const s = { ...me(ctx).settings };
    switch (ctx.match[1]) {
      case 'mode':
        s.mode = s.mode === 'all' ? 'selected' : 'all';
        if (s.mode === 'selected' && !s.selected.length) await ctx.reply('Режим «только выбранные»: отметьте коллекции ✅ кнопкой «✏️ Выбрать».');
        break;
      case 'username': s.onlyWithUsername = !s.onlyWithUsername; break;
      case 'rar': s.maxPermille = RARITY_STEPS[(RARITY_STEPS.indexOf(s.maxPermille) + 1) % RARITY_STEPS.length] ?? null; break;
      case 'attr': s.rarityAttr = ATTR_STEPS[(ATTR_STEPS.indexOf(s.rarityAttr) + 1) % ATTR_STEPS.length]!; break;
      case 'craft': s.includeCrafted = !s.includeCrafted; break;
      case 'reset':
        Object.assign(s, { mode: 'all', selected: [], muted: [], onlyWithUsername: false, models: [], maxPermille: null, rarityAttr: 'any', includeCrafted: true });
        break;
      case 'models':
        pending.set(me(ctx).chatId, { kind: 'models' });
        await ctx.answerCallbackQuery();
        await ctx.reply('Пришлите названия моделей через запятую (например: <code>Pumpkin, Cyberpunk</code>) или «clear». /cancel — отмена.', { parse_mode: 'HTML' });
        return;
    }
    await save(ctx, s);
    await ctx.answerCallbackQuery('Сохранено');
    const v = filtersView(s);
    await show(ctx, v.text, v.kb);
  });

  bot.callbackQuery(/^c:p:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const v = await collectionsView(me(ctx).settings, Number(ctx.match[1]));
    await show(ctx, v.text, v.kb);
  });

  bot.callbackQuery(/^c:t:([a-z0-9]+):(\d+)$/, async (ctx) => {
    const base = ctx.match[1]!;
    const s = { ...me(ctx).settings, selected: [...me(ctx).settings.selected], muted: [...me(ctx).settings.muted] };
    if (s.selected.includes(base)) {
      s.selected = s.selected.filter((x) => x !== base);
      s.muted.push(base);
    } else if (s.muted.includes(base)) {
      s.muted = s.muted.filter((x) => x !== base);
    } else {
      s.selected.push(base);
    }
    await save(ctx, s);
    await ctx.answerCallbackQuery();
    const v = await collectionsView(s, Number(ctx.match[2]));
    await show(ctx, v.text, v.kb);
  });

  bot.callbackQuery(/^fav:([a-z0-9]+-\d+)$/, async (ctx) => {
    const slug = ctx.match[1]!;
    const gift = await repo.getGift(slug);
    if (!gift) return void (await ctx.answerCallbackQuery('Подарок не найден в базе'));
    const added = await repo.toggleFavorite(me(ctx).chatId, slug);
    await ctx.answerCallbackQuery(added ? '⭐ Добавлено в избранное' : 'Убрано из избранного');
    await ctx.editMessageReplyMarkup({ reply_markup: giftKeyboard(gift, me(ctx).settings.tradeTemplate, added) }).catch(() => undefined);
  });

  bot.callbackQuery(/^fv:rm:([a-z0-9]+-\d+)$/, async (ctx) => {
    await repo.toggleFavorite(me(ctx).chatId, ctx.match[1]!);
    await ctx.answerCallbackQuery('Убрано');
    const v = await favoritesView(me(ctx).chatId);
    await show(ctx, v.text, v.kb);
  });

  bot.catch((err) => logger.error({ err: err.error, update: err.ctx.update.update_id }, 'Ошибка обработки апдейта бота'));

  return bot;
}

export async function setBotCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands([
    { command: 'start', description: 'Главное меню' },
    { command: 'latest', description: 'Последние улучшенные подарки' },
    { command: 'filters', description: 'Фильтры подарков' },
    { command: 'settings', description: 'Настройки мониторинга' },
    { command: 'favorites', description: 'Избранные подарки' },
    { command: 'stats', description: 'Статистика мониторинга' },
    { command: 'status', description: 'Состояние системы и источников' },
    { command: 'gift', description: 'Посмотреть подарок по ссылке' },
    { command: 'login', description: 'Подключить аккаунт (MTProto)' },
    { command: 'help', description: 'Справка' },
  ]);
}
