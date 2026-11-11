import pg from 'pg';
import { logger } from '../logger.js';
import { migrations } from './migrations.js';

// BIGINT -> number (chat_id/owner_id помещаются в безопасный диапазон JS)
pg.types.setTypeParser(20, (v) => Number(v));

export function createPool(databaseUrl: string, ssl: boolean): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    // Supabase pooler использует сертификат, которого нет в системном хранилище Node;
    // соединение всё равно шифруется TLS.
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
  });
  pool.on('error', (err) => logger.error({ err }, 'Ошибка соединения с БД (будет переподключение)'));
  return pool;
}

export async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    // Защита от одновременного запуска двух экземпляров
    await client.query('SELECT pg_advisory_lock(424242)');
    const { rows } = await client.query<{ version: number }>('SELECT version FROM schema_migrations');
    const done = new Set(rows.map((r) => r.version));
    for (const m of migrations) {
      if (done.has(m.version)) continue;
      logger.info({ version: m.version, name: m.name }, 'Применяю миграцию');
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations(version, name) VALUES ($1, $2)', [m.version, m.name]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(424242)').catch(() => undefined);
    client.release();
  }
}
