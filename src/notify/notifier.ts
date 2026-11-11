/**
 * Рассылка уведомлений. Защита от дублей в два уровня:
 *  1) событие создаётся один раз (уникальный dedup_key);
 *  2) перед отправкой резервируется пара (event_id, chat_id) — повторно она не отправится даже после перезапуска.
 * Если событий в пачке слишком много, лишние объединяются в сводку, чтобы не упереться в лимиты Telegram.
 */
import { type Api, GrammyError } from 'grammy';
import type { Repository, StoredGift, UserRow } from '../db/repository.js';
import { logger } from '../logger.js';
import type { GiftEvent } from '../types.js';
import { passesFilters } from './filters.js';
import { displayTitle, esc, fmtOwner, formatChange, formatNewGift, giftKeyboard, giftUrl } from './format.js';

const INDIVIDUAL_LIMIT = 6;
const DIGEST_CHUNK = 25;

export class Notifier {
  private running = false;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  sent = 0;
  failed = 0;
  lastSentAt: Date | null = null;

  constructor(
    private readonly api: Api,
    private readonly repo: Repository,
    private readonly tz: string,
    private readonly showPreview: boolean,
  ) {}

  start(): void {
    // Подбираем «зависшие» события (например, после перезапуска)
    this.timer = setInterval(() => this.kick(), 20_000);
    this.kick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  enqueue(_events: GiftEvent[]): void {
    this.kick();
  }

  kick(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    void this.process()
      .catch((e) => logger.error({ err: e }, 'Ошибка рассылки'))
      .finally(() => {
        this.running = false;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  private async process(): Promise<void> {
    for (;;) {
      const events = await this.repo.pendingEvents(200);
      if (!events.length) return;
      const users = await this.repo.listUsers();
      const perUser = new Map<number, { ev: GiftEvent; gift: StoredGift }[]>();

      for (const ev of events) {
        const gift = await this.repo.getGift(ev.giftSlug);
        if (gift) {
          let recipients: UserRow[];
          if (ev.kind === 'upgrade' || ev.kind === 'craft') {
            recipients = users.filter((u) => passesFilters(u.settings, gift, ev.kind));
          } else {
            const watchers = new Set(await this.repo.favoriteWatchers(gift.slug));
            recipients = users.filter((u) => watchers.has(u.chatId) && u.settings.notifyFavoritesChanges);
          }
          for (const u of recipients) {
            const list = perUser.get(u.chatId) ?? [];
            list.push({ ev, gift });
            perUser.set(u.chatId, list);
          }
        }
      }

      for (const [chatId, items] of perUser) {
        const user = users.find((u) => u.chatId === chatId)!;
        const single = items.slice(0, INDIVIDUAL_LIMIT);
        const rest = items.slice(INDIVIDUAL_LIMIT);
        for (const it of single) await this.sendOne(user, it.ev, it.gift);
        for (let i = 0; i < rest.length; i += DIGEST_CHUNK) await this.sendDigest(user, rest.slice(i, i + DIGEST_CHUNK));
      }

      for (const ev of events) await this.repo.setEventStatus(ev.id, 'done');
      if (events.length < 200) return;
    }
  }

  private async sendOne(user: UserRow, ev: GiftEvent, gift: StoredGift): Promise<void> {
    if (!(await this.repo.claimNotification(ev.id, user.chatId))) return;
    const text = ev.kind === 'upgrade' || ev.kind === 'craft' ? formatNewGift(ev, gift, this.tz) : formatChange(ev, gift, this.tz);
    const fav = await this.repo.isFavorite(user.chatId, gift.slug);
    try {
      const msg = await this.api.sendMessage(user.chatId, text, {
        parse_mode: 'HTML',
        reply_markup: giftKeyboard(gift, user.settings.tradeTemplate, fav),
        link_preview_options: this.showPreview
          ? { url: giftUrl(gift), prefer_large_media: true, show_above_text: true }
          : { is_disabled: true },
      });
      await this.repo.setNotificationMessage(ev.id, user.chatId, msg.message_id);
      this.sent++;
      this.lastSentAt = new Date();
    } catch (e) {
      this.failed++;
      this.logSendError(e, user.chatId);
    }
  }

  private async sendDigest(user: UserRow, items: { ev: GiftEvent; gift: StoredGift }[]): Promise<void> {
    const fresh: typeof items = [];
    for (const it of items) if (await this.repo.claimNotification(it.ev.id, user.chatId)) fresh.push(it);
    if (!fresh.length) return;
    const lines = [`📦 <b>Ещё ${fresh.length} новых подарков</b> (сводка, чтобы не засыпать чат):`, ''];
    for (const { ev, gift } of fresh) {
      const mark = ev.kind === 'craft' ? '🛠' : ev.kind === 'transfer' ? '🔄' : ev.kind === 'resale_listed' ? '💰' : '🎁';
      lines.push(`${mark} <a href="${giftUrl(gift)}">${esc(displayTitle(gift))} #${gift.num}</a> — ${esc(gift.model?.name ?? '?')} · ${fmtOwner(gift)}`);
    }
    lines.push('', '<i>Сузьте фильтры (/filters), если сообщений слишком много.</i>');
    try {
      await this.api.sendMessage(user.chatId, lines.join('\n'), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      this.sent++;
      this.lastSentAt = new Date();
    } catch (e) {
      this.failed++;
      this.logSendError(e, user.chatId);
    }
  }

  async notifyNewCollection(base: string): Promise<void> {
    const users = await this.repo.listUsers();
    for (const u of users) {
      if (!u.settings.enabled || !u.settings.notifyNewCollections) continue;
      try {
        await this.api.sendMessage(
          u.chatId,
          `🆕 <b>Обнаружена новая коллекция:</b> <code>${esc(base)}</code>\nМониторинг улучшений запущен. Первые улучшенные экземпляры придут уведомлениями.`,
          { parse_mode: 'HTML' },
        );
      } catch (e) {
        this.logSendError(e, u.chatId);
      }
    }
  }

  private logSendError(e: unknown, chatId: number) {
    if (e instanceof GrammyError && e.error_code === 403) {
      logger.warn({ chatId }, 'Пользователь заблокировал бота');
    } else {
      logger.error({ err: e, chatId }, 'Не удалось отправить сообщение');
    }
  }
}
