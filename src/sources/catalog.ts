/**
 * Список коллекций. Источники (по убыванию приоритета):
 *  1. https://fragment.com/gifts — публичный каталог всех коллекций (data-value="<slug>"), проверено.
 *  2. MTProto payments.getStarGifts — обычные подарки с возможностью улучшения (название -> slug).
 *  3. Встроенный список, проверенный 11.11.2026 (на случай недоступности обоих).
 */
import { decodeHtml } from './web.js';

export function parseFragmentCollections(html: string): { base: string; hint: string | null }[] {
  const out = new Map<string, string | null>();
  const re = /js-choose-collection-item"[^>]*?(?:data-keywords="([^"]*)"\s*)?data-value="([a-z0-9]+)"/gi;
  for (const m of html.matchAll(re)) {
    const base = m[2]!.toLowerCase();
    if (!out.has(base) || (out.get(base) == null && m[1])) out.set(base, m[1] ? decodeHtml(m[1]) : null);
  }
  // запасной вариант: ссылки вида href="/gifts/<slug>"
  if (out.size === 0) {
    for (const m of html.matchAll(/href="\/gifts\/([a-z0-9]+)"/gi)) out.set(m[1]!.toLowerCase(), null);
  }
  return [...out.entries()].map(([base, hint]) => ({ base, hint }));
}

export async function fetchFragmentCollections(timeoutMs = 20_000): Promise<{ base: string; hint: string | null }[]> {
  const res = await fetch('https://fragment.com/gifts', {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; GiftMonitorBot/1.0)' },
  });
  if (!res.ok) throw new Error(`fragment.com/gifts: HTTP ${res.status}`);
  const list = parseFragmentCollections(await res.text());
  if (list.length < 10) throw new Error(`fragment.com/gifts: подозрительно мало коллекций (${list.length})`);
  return list;
}

/** 'Durov's Cap' -> 'durovscap', 'Jack-in-the-Box' -> 'jackinthebox', 'B-Day Candle' -> 'bdaycandle' */
export function titleToBase(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/['’`]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '')
    .toLowerCase();
}

export const BUILTIN_COLLECTIONS = [
  'plushpepe', 'durovscap', 'homemadecake', 'signetring', 'preciouspeach', 'heartlocket', 'eternalrose', 'lootbag',
  'kissedfrog', 'scaredcat', 'magicpotion', 'voodoodoll', 'swisswatch', 'astralshard', 'iongem', 'minioscar',
  'perfumebottle', 'vintagecigar', 'nailbracelet', 'genielamp', 'sharptongue', 'bondedring', 'crystalball',
  'electricskull', 'berrybox', 'trappedheart', 'skullflower', 'sleighbell', 'lovecandle', 'evileye', 'hexpot',
  'flyingbroom', 'madpumpkin', 'spyagaric', 'witchhat', 'bdaycandle', 'lovepotion', 'toybear', 'diamondring',
  'santahat', 'snowglobe', 'winterwreath', 'snowmittens', 'jinglebells', 'starnotepad', 'jellybunny', 'spicedwine',
  'cookieheart', 'tamagadget', 'hypnolollipop', 'partysparkler', 'lunarsnake', 'deskcalendar', 'jesterhat',
  'eternalcandle', 'recordplayer', 'lolpop', 'gingercookie', 'candycane', 'sakuraflower', 'lightsword', 'restlessjar',
  'ionicdryer', 'bigyear', 'nekohelmet', 'easteregg', 'bunnymuffin', 'snoopdogg', 'swagbag', 'snoopcigar', 'lowrider',
  'westsidesign', 'valentinebox', 'jollychimp', 'jackinthebox', 'petsnake', 'instantramen', 'moonpendant',
  'faithamulet', 'heroichelmet', 'stellarrocket', 'ufcstrike', 'mightyarm', 'freshsocks', 'inputkey', 'cupidcharm',
  'skystilettos', 'moussecake', 'happybrownie', 'poolfloat', 'snakebox', 'xmasstocking', 'whipcupcake', 'victorymedal',
  'rarebird', 'timelessbook', 'chillflame',
];
