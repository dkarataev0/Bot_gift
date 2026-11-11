import type { EventKind, GiftInfo, UserSettings } from '../types.js';

const RARE_TIERS = new Set(['uncommon', 'rare', 'epic', 'legendary']);

function attrPasses(a: GiftInfo['model'], maxPermille: number): boolean {
  if (!a) return false;
  if (a.permille != null) return a.permille <= maxPermille;
  return a.tier != null && RARE_TIERS.has(a.tier);
}

/** Проходит ли подарок фильтры пользователя. Возвращает причину отказа или null. */
export function rejectReason(s: UserSettings, g: GiftInfo, kind: EventKind): string | null {
  if (!s.enabled) return 'уведомления выключены';
  if (kind === 'craft' && !s.includeCrafted) return 'крафт отключён';
  const col = g.collection.toLowerCase();
  if (s.muted.includes(col)) return 'коллекция отключена';
  if (s.mode === 'selected' && !s.selected.includes(col)) return 'коллекция не выбрана';
  if (s.onlyWithUsername && !g.ownerUsername) return 'нет публичного username';
  if (s.models.length) {
    const m = g.model?.name.toLowerCase();
    if (!m || !s.models.some((x) => x.toLowerCase() === m)) return 'модель не в списке';
  }
  if (s.maxPermille != null) {
    const attrs =
      s.rarityAttr === 'model' ? [g.model] :
      s.rarityAttr === 'backdrop' ? [g.backdrop] :
      s.rarityAttr === 'symbol' ? [g.symbol] : [g.model, g.backdrop, g.symbol];
    if (!attrs.some((a) => attrPasses(a, s.maxPermille!))) return 'недостаточно редкий';
  }
  return null;
}

export function passesFilters(s: UserSettings, g: GiftInfo, kind: EventKind): boolean {
  return rejectReason(s, g, kind) === null;
}
