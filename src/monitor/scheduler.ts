/**
 * Планировщик проверок коллекций.
 * Каждая коллекция имеет время следующей проверки; интервал адаптивный:
 *  - есть необработанные номера -> сразу;
 *  - была активность за последние 10 минут или коллекция в списке «выбранных» -> hotInterval;
 *  - активность за последние 2 часа -> warmInterval; иначе coldInterval.
 * Воркеры всегда берут самую «просроченную» коллекцию, поэтому ни одна не голодает,
 * а общий темп ограничивает AdaptiveRateLimiter источника.
 */
import type { Repository } from '../db/repository.js';
import { logger } from '../logger.js';
import type { CollectionState, GiftEvent } from '../types.js';
import type { CheckOutcome, Detector } from './detector.js';

export interface SchedulerOptions {
  workers: number;
  hotIntervalMs: number;
  warmIntervalMs: number;
  coldIntervalMs: number;
}

export class Scheduler {
  private collections = new Map<string, CollectionState>();
  private inFlight = new Set<string>();
  private priority = new Set<string>();
  private running = false;
  private workers: Promise<void>[] = [];
  lastTickAt: Date | null = null;
  startedAt = new Date();
  checks = 0;
  errors = 0;
  lastError: string | null = null;
  /** Время полного обхода всех коллекций (оценка) */
  private recentCheckTimes: number[] = [];

  constructor(
    private readonly repo: Repository,
    private readonly detector: Detector,
    private readonly opts: SchedulerOptions,
    private readonly onEvents: (events: GiftEvent[]) => void,
  ) {}

  async reload(): Promise<void> {
    for (const c of await this.repo.listCollections()) {
      if (!this.inFlight.has(c.base)) this.collections.set(c.base, c);
    }
  }

  setPriority(bases: Iterable<string>): void {
    this.priority = new Set([...bases].map((b) => b.toLowerCase()));
  }

  get size(): number {
    return this.collections.size;
  }

  /** Средний интервал между проверками одной и той же коллекции (за последние проверки) */
  get approxCycleSec(): number | null {
    const t = this.recentCheckTimes;
    if (t.length < 5) return null;
    const span = (t[t.length - 1]! - t[0]!) / 1000;
    const perSec = (t.length - 1) / Math.max(span, 0.001);
    return this.collections.size / perSec;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (let i = 0; i < this.opts.workers; i++) this.workers.push(this.workerLoop(i));
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.allSettled(this.workers);
  }

  private pickDue(): CollectionState | null {
    const now = Date.now();
    // Первичная загрузка медленная (полные страницы) — не больше одного воркера на неё,
    // чтобы остальные продолжали живой мониторинг уже загруженных коллекций.
    let baselineBusy = 0;
    for (const b of this.inFlight) if (this.collections.get(b)?.baselineDone === false) baselineBusy++;
    let best: CollectionState | null = null;
    for (const c of this.collections.values()) {
      if (!c.enabled || this.inFlight.has(c.base)) continue;
      if (!c.baselineDone && baselineBusy >= Math.max(1, this.opts.workers - 2)) continue;
      if (c.nextCheckAt.getTime() > now) continue;
      if (!best || c.nextCheckAt < best.nextCheckAt) best = c;
    }
    return best;
  }

  private nextDueInMs(): number {
    let min = Infinity;
    for (const c of this.collections.values()) {
      if (!c.enabled || this.inFlight.has(c.base)) continue;
      min = Math.min(min, c.nextCheckAt.getTime() - Date.now());
    }
    return Number.isFinite(min) ? Math.max(0, min) : 1000;
  }

  computeNext(c: CollectionState, o: CheckOutcome, now = Date.now()): number {
    if (o.status === 'error') return now + Math.max(o.retryAfterMs ?? 0, this.opts.warmIntervalMs);
    if (o.backlog || o.status === 'baseline') return now;
    const sinceNew = c.lastNewAt ? now - c.lastNewAt.getTime() : Infinity;
    if (o.status === 'new' || sinceNew < 10 * 60_000 || this.priority.has(c.base)) return now + this.opts.hotIntervalMs;
    if (sinceNew < 2 * 3600_000) return now + this.opts.warmIntervalMs;
    return now + this.opts.coldIntervalMs;
  }

  private async workerLoop(id: number): Promise<void> {
    while (this.running) {
      this.lastTickAt = new Date();
      const c = this.pickDue();
      if (!c) {
        await sleep(Math.max(200, Math.min(this.nextDueInMs(), 1000)));
        continue;
      }
      this.inFlight.add(c.base);
      try {
        const outcome = await this.detector.checkCollection({ ...c });
        this.checks++;
        this.recentCheckTimes.push(Date.now());
        if (this.recentCheckTimes.length > 200) this.recentCheckTimes.shift();
        if (outcome.status === 'error') {
          this.errors++;
          this.lastError = `${c.base}: ${outcome.error}`;
          logger.debug({ collection: c.base, err: outcome.error }, 'Проверка коллекции не удалась');
        }
        if (outcome.newCount > 0) {
          logger.info({ collection: c.base, newCount: outcome.newCount, backlog: outcome.backlog }, 'Найдены новые номера');
        }
        if (outcome.events.length) this.onEvents(outcome.events);
        const fresh = (await this.repo.getCollection(c.base)) ?? c;
        const next = new Date(this.computeNext(fresh, outcome));
        fresh.nextCheckAt = next;
        await this.repo.updateCollection(c.base, { nextCheckAt: next });
        this.collections.set(c.base, fresh);
      } catch (e) {
        this.errors++;
        this.lastError = e instanceof Error ? e.message : String(e);
        logger.error({ err: e, collection: c.base, worker: id }, 'Ошибка в цикле мониторинга');
        c.nextCheckAt = new Date(Date.now() + this.opts.warmIntervalMs);
        await sleep(2000);
      } finally {
        this.inFlight.delete(c.base);
      }
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
