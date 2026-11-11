/** Шифрование строки сессии MTProto перед сохранением в БД (AES-256-GCM, ключ из SESSION_SECRET) */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function key(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encrypt(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(secret), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decrypt(payload: string, secret: string): string {
  const [v, iv, tag, data] = payload.split(':');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Неизвестный формат зашифрованной сессии');
  const d = createDecipheriv('aes-256-gcm', key(secret), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
