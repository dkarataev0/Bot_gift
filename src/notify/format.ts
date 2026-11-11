import { InlineKeyboard } from 'grammy';
import type { GiftAttribute, GiftEvent, GiftInfo } from '../types.js';

export const UNKNOWN = 'Неизвестно';

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function fmtTime(d: Date | null | undefined, tz: string, withDate = false): string {
  if (!d) return UNKNOWN;
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    ...(withDate ? { day: '2-digit', month: '2-digit' } : {}),
  }).format(d);
}

export function fmtPermille(p: number | null): string {
  if (p == null) return '';
  const pct = p / 10;
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

const TIER_RU: Record<string, string> = {
  uncommon: 'необычная', rare: 'редкая', epic: 'эпическая', legendary: 'легендарная',
};

export function fmtAttr(a: GiftAttribute | null): string {
  if (!a || !a.name) return UNKNOWN;
  const r = a.permille != null ? fmtPermille(a.permille) : a.tier ? TIER_RU[a.tier] ?? a.tier : '';
  return r ? `${esc(a.name)} <i>(${r})</i>` : esc(a.name);
}

export function giftUrl(g: Pick<GiftInfo, 'slug'>): string {
  return `https://t.me/nft/${g.slug}`;
}

export function profileUrl(username: string | null): string | null {
  return username && /^[A-Za-z0-9_]{4,32}$/.test(username) ? `https://t.me/${username}` : null;
}

export function displayTitle(g: Pick<GiftInfo, 'title' | 'collection'>): string {
  return g.title ?? g.collection;
}

export function fmtOwner(g: GiftInfo): string {
  if (g.ownerUsername) return `@${esc(g.ownerUsername)}${g.ownerName ? ` (${esc(g.ownerName)})` : ''}`;
  if (g.ownerName) {
    const note = g.source === 'web' ? 'username недоступен без MTProto' : 'нет публичного username';
    return `${esc(g.ownerName)} <i>(${note})</i>`;
  }
  if (g.ownerAddress) return `TON-кошелёк <code>${esc(g.ownerAddress)}</code>`;
  return `${UNKNOWN} <i>(скрыт или не указан)</i>`;
}

export function statusLine(ev: GiftEvent, g: GiftInfo): string {
  if (ev.kind === 'craft') return '🛠 Создан крафтом (это не улучшение) — подтверждено MTProto';
  if (ev.confidence === 'low') return '⚪ Новый номер, обнаружен после перерыва в мониторинге (время улучшения неточно)';
  if (ev.confidence === 'high') return '✅ Подтверждённое улучшение (новый порядковый номер, не крафт)';
  return g.source === 'web'
    ? '🟡 Новый выпущенный номер — улучшение (крафт этот источник не различает)'
    : '🟡 Новый выпущенный номер';
}

export function fillTemplate(template: string, g: GiftInfo): string {
  return template
    .replace(/\{gift\}/g, `${displayTitle(g)} #${g.num}`)
    .replace(/\{link\}/g, giftUrl(g))
    .replace(/\{owner\}/g, g.ownerUsername ? `@${g.ownerUsername}` : g.ownerName ?? '');
}

export function formatNewGift(ev: GiftEvent, g: GiftInfo, tz: string): string {
  const header = ev.kind === 'craft' ? '🛠 <b>НОВЫЙ ПОДАРОК (КРАФТ)</b>' : '🎁 <b>НОВЫЙ УЛУЧШЕННЫЙ ПОДАРОК</b>';
  const lines = [
    header,
    '',
    `Коллекция: <b>${esc(displayTitle(g))}</b>`,
    `Номер: <b>#${g.num}</b>${g.issued && g.total ? ` <i>(выпущено ${g.issued.toLocaleString('ru-RU')} из ${g.total.toLocaleString('ru-RU')})</i>` : ''}`,
    `Модель: ${fmtAttr(g.model)}`,
    `Фон: ${fmtAttr(g.backdrop)}`,
    `Узор: ${fmtAttr(g.symbol)}`,
    `Владелец: ${fmtOwner(g)}`,
  ];
  if (g.onSale != null) lines.push(`На продаже: ${g.onSale ? 'да' : 'нет'}`);
  lines.push('');
  lines.push(`Обнаружен: ${fmtTime(ev.detectedAt, tz)}`);
  lines.push(
    ev.windowStart && ev.confidence !== 'low'
      ? `Улучшен: между ${fmtTime(ev.windowStart, tz)} и ${fmtTime(ev.windowEnd ?? ev.detectedAt, tz)}`
      : `Улучшен: ${UNKNOWN}${ev.windowStart ? ` (после ${fmtTime(ev.windowStart, tz, true)})` : ''}`,
  );
  lines.push(`Статус: ${statusLine(ev, g)}`);
  lines.push(`<i>Текущий владелец может отличаться от того, кто улучшил подарок.</i>`);
  return lines.join('\n');
}

/** Карточка подарка (для /gift, избранного) — без утверждений о времени улучшения */
export function formatGiftCard(g: GiftInfo, header: string): string {
  return [
    header,
    '',
    `Коллекция: <b>${esc(displayTitle(g))}</b>`,
    `Номер: <b>#${g.num}</b>${g.issued && g.total ? ` <i>(выпущено ${g.issued.toLocaleString('ru-RU')} из ${g.total.toLocaleString('ru-RU')})</i>` : ''}`,
    `Модель: ${fmtAttr(g.model)}`,
    `Фон: ${fmtAttr(g.backdrop)}`,
    `Узор: ${fmtAttr(g.symbol)}`,
    `Владелец: ${fmtOwner(g)}`,
    ...(g.onSale != null ? [`На продаже: ${g.onSale ? 'да' : 'нет'}`] : []),
    ...(g.crafted != null ? [`Происхождение: ${g.crafted ? 'крафт' : 'улучшение обычного подарка'}`] : []),
    `Источник данных: ${g.source === 'mtproto' ? 'MTProto' : 't.me (публичная страница)'}`,
  ].join('\n');
}

export function formatChange(ev: GiftEvent, g: GiftInfo, tz: string): string {
  if (ev.kind === 'resale_listed') {
    return [
      '💰 <b>ИЗБРАННЫЙ ПОДАРОК ВЫСТАВЛЕН НА ПРОДАЖУ</b>',
      '',
      `${esc(displayTitle(g))} <b>#${g.num}</b>`,
      `Владелец: ${fmtOwner(g)}`,
      `Обнаружено: ${fmtTime(ev.detectedAt, tz, true)}`,
    ].join('\n');
  }
  const d = ev.details as { from?: { name?: string; username?: string }; to?: { name?: string; username?: string } };
  const who = (x?: { name?: string; username?: string }) =>
    x?.username ? `@${esc(x.username)}` : x?.name ? esc(x.name) : UNKNOWN;
  return [
    '🔄 <b>СМЕНА ВЛАДЕЛЬЦА ИЗБРАННОГО ПОДАРКА</b>',
    '',
    `${esc(displayTitle(g))} <b>#${g.num}</b>`,
    `Было: ${who(d.from)}`,
    `Стало: ${who(d.to)}`,
    `Обнаружено: ${fmtTime(ev.detectedAt, tz, true)} (между проверками ${fmtTime(ev.windowStart, tz, true)} и ${fmtTime(ev.windowEnd, tz, true)})`,
    ev.confidence === 'low'
      ? '<i>Сравнение по отображаемому имени: возможно, владелец просто сменил имя.</i>'
      : '<i>Подтверждено по ID владельца.</i>',
  ].join('\n');
}

/** Inline-кнопки уведомления */
export function giftKeyboard(g: GiftInfo, template: string, isFav: boolean): InlineKeyboard {
  const kb = new InlineKeyboard().url('🎁 Открыть подарок', giftUrl(g));
  const prof = profileUrl(g.ownerUsername);
  if (prof) kb.row().url('👤 Профиль владельца', prof);
  const text = fillTemplate(template, g);
  kb.row();
  if (prof) {
    // t.me/<username>?text=... открывает чат с владельцем и подставляет черновик (не отправляет!)
    kb.url('💬 Предложить обмен', `${prof}?text=${encodeURIComponent(text)}`);
  } else {
    // Нет публичного username — даём скопировать готовое сообщение
    kb.copyText('💬 Скопировать предложение', text.slice(0, 256));
  }
  kb.row().text(isFav ? '★ В избранном (убрать)' : '⭐ В избранное', `fav:${g.slug}`);
  return kb;
}
