import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFragmentCollections, titleToBase } from '../src/sources/catalog.js';
import { mapUniqueGift } from '../src/sources/mtproto.js';
import { decodeHtml, parseGiftPage } from '../src/sources/web.js';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

describe('Парсер публичной страницы t.me/nft (реальные сохранённые страницы)', () => {
  it('разбирает все поля подарка', () => {
    const g = parseGiftPage(fx('gift_found.html'), 'PlushPepe-1')!;
    expect(g).not.toBeNull();
    expect(g.slug).toBe('plushpepe-1');
    expect(g.collection).toBe('plushpepe');
    expect(g.title).toBe('Plush Pepe');
    expect(g.num).toBe(1);
    expect(g.model).toEqual({ name: 'Pumpkin', permille: 30, tier: null });
    expect(g.backdrop).toEqual({ name: 'Onyx Black', permille: 20, tier: null });
    expect(g.symbol).toEqual({ name: 'Illuminati', permille: 5, tier: null });
    expect(g.ownerName).toBe('Pavel Durov');
    expect(g.ownerUsername).toBeNull(); // публичная страница username не показывает
    expect(g.issued).toBe(2825);
    expect(g.total).toBe(2861);
    expect(g.imageUrl).toMatch(/^https:\/\//);
    expect(g.crafted).toBeNull();
  });

  it('имя владельца с emoji-картинкой', () => {
    const g = parseGiftPage(fx('gift_owner_emoji.html'), 'HomemadeCake-180725')!;
    expect(g.ownerName).toContain('Valeriia');
    expect(g.issued).toBeGreaterThan(180_000);
  });

  it('страница-заглушка (ограничение частоты) -> null, а НЕ «подарка нет»', () => {
    expect(parseGiftPage(fx('gift_degraded.html'), 'AstralShard-1')).toBeNull();
  });

  it('несовпадение номера на странице -> null', () => {
    expect(parseGiftPage(fx('gift_found.html'), 'PlushPepe-2')).toBeNull();
  });

  it('decodeHtml', () => {
    expect(decodeHtml('Durov&#39;s &amp; Co &#x1F600;')).toBe("Durov's & Co 😀");
  });
});

describe('Каталог коллекций', () => {
  it('разбирает fragment.com/gifts', () => {
    const list = parseFragmentCollections(fx('fragment_gifts_snippet.html'));
    expect(list.length).toBeGreaterThan(10);
    const ac = list.find((x) => x.base === 'algorithmcup');
    expect(ac?.hint).toBe('Algorithm Cups');
  });

  it('название -> slug', () => {
    expect(titleToBase("Durov's Cap")).toBe('durovscap');
    expect(titleToBase('Jack-in-the-Box')).toBe('jackinthebox');
    expect(titleToBase('B-Day Candle')).toBe('bdaycandle');
    expect(titleToBase('UFC Strike')).toBe('ufcstrike');
  });
});

describe('MTProto: преобразование payments.uniqueStarGift', () => {
  const base = {
    _: 'payments.uniqueStarGift',
    chats: [],
    users: [{ _: 'user', id: 777, firstName: 'Ivan', usernames: [{ _: 'username', username: 'ivan_gifts', active: true }] }],
    gift: {
      _: 'starGiftUnique',
      id: 1n,
      giftId: 2n,
      title: 'Plush Pepe',
      slug: 'PlushPepe-2826',
      num: 2826,
      ownerId: { _: 'peerUser', userId: 777 },
      attributes: [
        { _: 'starGiftAttributeModel', name: 'Cyberpunk', rarity: { _: 'starGiftAttributeRarity', permille: 12 } },
        { _: 'starGiftAttributeBackdrop', name: 'Onyx Black', rarity: { _: 'starGiftAttributeRarity', permille: 20 } },
        { _: 'starGiftAttributePattern', name: 'Lightning', rarity: { _: 'starGiftAttributeRarityEpic' } },
      ],
      availabilityIssued: 2826,
      availabilityTotal: 2861,
      resellAmount: [{ _: 'starsAmount', amount: 100n, nanos: 0 }],
      crafted: false,
    },
  };

  it('владелец с username, атрибуты, продажа', () => {
    const g = mapUniqueGift(base as never, 'plushpepe-2826')!;
    expect(g.slug).toBe('plushpepe-2826');
    expect(g.ownerUsername).toBe('ivan_gifts');
    expect(g.ownerName).toBe('Ivan');
    expect(g.ownerId).toBe(777);
    expect(g.model).toEqual({ name: 'Cyberpunk', permille: 12, tier: null });
    expect(g.symbol).toEqual({ name: 'Lightning', permille: null, tier: 'epic' });
    expect(g.onSale).toBe(true);
    expect(g.crafted).toBe(false);
    expect(g.issued).toBe(2826);
  });

  it('скрытый владелец', () => {
    const g = mapUniqueGift({ ...base, users: [], gift: { ...base.gift, ownerId: undefined, resellAmount: undefined } } as never, 'plushpepe-2826')!;
    expect(g.ownerUsername).toBeNull();
    expect(g.ownerName).toBeNull();
    expect(g.onSale).toBe(false);
  });
});
