/**
 * Живая проверка источников данных: npm run check-sources
 * Ничего не пишет в БД. Если заданы TG_API_ID/TG_API_HASH/TG_SESSION — проверяет и MTProto.
 */
import { fetchFragmentCollections } from '../sources/catalog.js';
import { MtprotoSource } from '../sources/mtproto.js';
import { WebSource } from '../sources/web.js';

const slug = process.argv[2] ?? 'PlushPepe-1';

console.log('1) Каталог коллекций fragment.com/gifts …');
try {
  const list = await fetchFragmentCollections();
  console.log(`   OK: ${list.length} коллекций, например: ${list.slice(0, 5).map((c) => c.base).join(', ')}`);
} catch (e) {
  console.log(`   ОШИБКА: ${e instanceof Error ? e.message : e}`);
}

console.log(`2) Публичная страница t.me/nft/${slug} …`);
const web = new WebSource(0.1, 1, 1);
for (let i = 0; i < 3; i++) {
  const r = await web.fetchGift(slug);
  console.log('   ', JSON.stringify(r.status === 'found' ? { ...r.gift, imageUrl: '…' } : r));
  if (r.status !== 'unavailable') break;
  await new Promise((res) => setTimeout(res, 5000));
}
console.log('3) Несуществующий номер …');
console.log('   ', JSON.stringify(await web.fetchGift(slug.replace(/-\d+$/, '-999999999'))));

const { TG_API_ID, TG_API_HASH, TG_SESSION } = process.env;
if (TG_API_ID && TG_API_HASH && TG_SESSION) {
  console.log('4) MTProto payments.getUniqueStarGift …');
  const m = new MtprotoSource(Number(TG_API_ID), TG_API_HASH, 2);
  if (await m.connect(TG_SESSION)) {
    console.log('   ', JSON.stringify(await m.fetchGift(slug)));
    console.log('   ', JSON.stringify(await m.fetchGift(slug.replace(/-\d+$/, '-999999999'))));
    const cat = await m.listCatalog();
    console.log(`   каталог: ${cat.length} подарков, улучшаемых: ${cat.filter((g) => g.upgradable).length}`);
  } else console.log(`   не удалось подключиться: ${m.lastAuthError}`);
  await m.disconnect();
} else {
  console.log('4) MTProto пропущен (нет TG_API_ID/TG_API_HASH/TG_SESSION)');
}
process.exit(0);
