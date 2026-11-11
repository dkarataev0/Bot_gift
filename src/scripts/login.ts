/**
 * Альтернатива /login в боте: вход по QR-коду в терминале. Печатает строку сессии,
 * которую можно сохранить в переменную окружения TG_SESSION (в настройках Render).
 * Запуск: TG_API_ID=... TG_API_HASH=... npm run login
 */
import { createInterface } from 'node:readline/promises';
import QRCode from 'qrcode';
import { loginWithQr } from '../sources/mtproto.js';

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;
if (!apiId || !apiHash) {
  console.error('Задайте TG_API_ID и TG_API_HASH (https://my.telegram.org → API development tools)');
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const res = await loginWithQr({
  apiId,
  apiHash,
  onUrl: async (url, expires) => {
    console.clear();
    console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
    console.log(`Telegram на телефоне → Настройки → Устройства → Подключить устройство. Код действует до ${expires.toLocaleTimeString()}`);
  },
  getPassword: () => rl.question('Пароль двухэтапной проверки: '),
  onInvalidPassword: () => console.log('Неверный пароль'),
});
rl.close();
console.log('\nУспешно. Строка сессии (держите в секрете, это доступ к аккаунту!):\n');
console.log(res.session);
process.exit(0);
