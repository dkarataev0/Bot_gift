import { describe, expect, it } from 'vitest';
import { rejectReason } from '../src/notify/filters.js';
import { fillTemplate, formatNewGift, giftKeyboard } from '../src/notify/format.js';
import { diffGift } from '../src/monitor/ownerTracker.js';
import { DEFAULT_SETTINGS, type GiftEvent, normalizeSettings } from '../src/types.js';
import { gift } from './helpers.js';

const s = (o = {}) => ({ ...DEFAULT_SETTINGS, ...o });

describe('Фильтры', () => {
  const g = gift('plushpepe', 5);
  it('по умолчанию пропускает всё', () => expect(rejectReason(s(), g, 'upgrade')).toBeNull());
  it('пауза', () => expect(rejectReason(s({ enabled: false }), g, 'upgrade')).not.toBeNull());
  it('отключённая коллекция', () => expect(rejectReason(s({ muted: ['plushpepe'] }), g, 'upgrade')).not.toBeNull());
  it('режим выбранных', () => {
    expect(rejectReason(s({ mode: 'selected', selected: ['durovscap'] }), g, 'upgrade')).not.toBeNull();
    expect(rejectReason(s({ mode: 'selected', selected: ['plushpepe'] }), g, 'upgrade')).toBeNull();
  });
  it('только с username', () => {
    expect(rejectReason(s({ onlyWithUsername: true }), g, 'upgrade')).not.toBeNull();
    expect(rejectReason(s({ onlyWithUsername: true }), { ...g, ownerUsername: 'abc_d' }, 'upgrade')).toBeNull();
  });
  it('модели без учёта регистра', () => {
    expect(rejectReason(s({ models: ['pumpkin'] }), g, 'upgrade')).toBeNull();
    expect(rejectReason(s({ models: ['Cyberpunk'] }), g, 'upgrade')).not.toBeNull();
  });
  it('редкость', () => {
    expect(rejectReason(s({ maxPermille: 10 }), g, 'upgrade')).toBeNull(); // узор 0.5%
    expect(rejectReason(s({ maxPermille: 10, rarityAttr: 'model' }), g, 'upgrade')).not.toBeNull(); // модель 3%
    expect(rejectReason(s({ maxPermille: 30, rarityAttr: 'model' }), g, 'upgrade')).toBeNull();
    const tiered = { ...g, model: { name: 'X', permille: null, tier: 'legendary' } };
    expect(rejectReason(s({ maxPermille: 5, rarityAttr: 'model' }), tiered, 'upgrade')).toBeNull();
  });
  it('крафт', () => expect(rejectReason(s({ includeCrafted: false }), g, 'craft')).not.toBeNull());
  it('normalizeSettings чинит мусор', () => {
    const n = normalizeSettings({ mode: 'weird', models: 'x', tradeTemplate: '' });
    expect(n.mode).toBe('all');
    expect(n.models).toEqual([]);
    expect(n.tradeTemplate).toBe(DEFAULT_SETTINGS.tradeTemplate);
  });
});

const ev = (o: Partial<GiftEvent> = {}): GiftEvent => ({
  id: 1, dedupKey: 'k', giftSlug: 'plushpepe-5', kind: 'upgrade', confidence: 'high',
  detectedAt: new Date('2026-11-11T12:42:08Z'), windowStart: new Date('2026-11-11T12:42:04Z'),
  windowEnd: new Date('2026-11-11T12:42:08Z'), details: {}, ...o,
});

type Btn = { text: string; url?: string; copy_text?: { text: string }; callback_data?: string };
const buttons = (kb: ReturnType<typeof giftKeyboard>) => (kb.inline_keyboard.flat() as Btn[]);

describe('Уведомления', () => {
  it('содержит все поля и экранирует HTML', () => {
    const t = formatNewGift(ev(), gift('plushpepe', 5, { ownerName: '<b>x</b>', ownerUsername: 'pepe_owner' }), 'Europe/Moscow');
    expect(t).toContain('НОВЫЙ УЛУЧШЕННЫЙ ПОДАРОК');
    expect(t).toContain('#5');
    expect(t).toContain('Pumpkin');
    expect(t).toContain('Onyx Black');
    expect(t).toContain('Illuminati');
    expect(t).toContain('@pepe_owner');
    expect(t).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(t).toContain('15:42:08');
    expect(t).toContain('Подтверждённое улучшение');
  });

  it('неизвестные данные -> «Неизвестно», а не выдумки', () => {
    const t = formatNewGift(ev(), gift('plushpepe', 5, { model: null, ownerName: null }), 'UTC');
    expect(t).toContain('Модель: Неизвестно');
    expect(t).toContain('Владелец: Неизвестно');
  });

  it('с username: кнопки профиля и обмена с подставленным текстом', () => {
    const b = buttons(giftKeyboard(gift('plushpepe', 5, { ownerUsername: 'pepe_owner' }), DEFAULT_SETTINGS.tradeTemplate, false));
    expect(b.find((x) => x.text.includes('Открыть подарок'))?.url).toBe('https://t.me/nft/plushpepe-5');
    expect(b.find((x) => x.text.includes('Профиль'))?.url).toBe('https://t.me/pepe_owner');
    const trade = b.find((x) => x.text.includes('обмен'))!;
    expect(trade.url).toMatch(/^https:\/\/t\.me\/pepe_owner\?text=/);
    expect(decodeURIComponent(trade.url!.split('text=')[1]!)).toContain('Plush Pepe #5');
    expect(b.find((x) => x.callback_data === 'fav:plushpepe-5')).toBeTruthy();
  });

  it('без username: нет кнопки профиля, обмен = копирование текста', () => {
    const b = buttons(giftKeyboard(gift('plushpepe', 5), DEFAULT_SETTINGS.tradeTemplate, true));
    expect(b.find((x) => x.text.includes('Профиль'))).toBeUndefined();
    expect(b.find((x) => x.copy_text)?.copy_text?.text).toContain('Привет!');
    expect(b.find((x) => x.text.includes('В избранном'))).toBeTruthy();
  });

  it('шаблон', () => {
    expect(fillTemplate('{gift} {link} {owner}', gift('plushpepe', 5, { ownerUsername: 'a_bcd' }))).toBe('Plush Pepe #5 https://t.me/nft/plushpepe-5 @a_bcd');
  });
});

describe('Смена владельца / продажа', () => {
  const stored = (o = {}) => ({ ...gift('plushpepe', 5), firstSeenAt: new Date(), updatedAt: new Date(), ...o });
  it('смена по ID — высокая достоверность', () => {
    const d = diffGift(stored({ ownerId: 1, source: 'mtproto' }), gift('plushpepe', 5, { ownerId: 2, source: 'mtproto' }));
    expect(d).toEqual([expect.objectContaining({ kind: 'transfer', confidence: 'high' })]);
  });
  it('смена только имени — низкая достоверность', () => {
    const d = diffGift(stored({ ownerName: 'A' }), gift('plushpepe', 5, { ownerName: 'B' }));
    expect(d[0]).toMatchObject({ kind: 'transfer', confidence: 'low' });
  });
  it('без изменений — пусто; выставлен на продажу — событие', () => {
    expect(diffGift(stored(), gift('plushpepe', 5))).toEqual([]);
    expect(diffGift(stored({ onSale: false }), gift('plushpepe', 5, { onSale: true }))[0]?.kind).toBe('resale_listed');
  });
});
