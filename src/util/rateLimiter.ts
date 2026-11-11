/**
 * Адаптивный ограничитель частоты запросов (AIMD):
 *  - при успехах скорость плавно растёт до maxRps;
 *  - при признаках ограничения (пустые страницы, FLOOD_WAIT, 429) — быстро снижается;
 *  - при явном retryAfter — полная пауза.
 * Запросы выдаются строго по очереди, без «пачек».
 */
export class AdaptiveRateLimiter {
  private rps: number;
  private nextSlot = 0;
  private pausedUntil = 0;
  private successStreak = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly minRps: number,
    private readonly maxRps: number,
    initialRps = Math.max(minRps, maxRps / 2),
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.rps = Math.min(maxRps, Math.max(minRps, initialRps));
  }

  get currentRps(): number {
    return this.rps;
  }

  get pausedForMs(): number {
    return Math.max(0, this.pausedUntil - this.now());
  }

  /** Дождаться своей очереди на запрос */
  acquire(): Promise<void> {
    const p = this.chain.then(async () => {
      const t = this.now();
      const start = Math.max(t, this.nextSlot, this.pausedUntil);
      if (start > t) await this.sleep(start - t);
      this.nextSlot = Math.max(this.now(), start) + 1000 / this.rps;
    });
    this.chain = p.catch(() => undefined);
    return p;
  }

  onSuccess(): void {
    this.successStreak++;
    if (this.successStreak >= 10) {
      this.successStreak = 0;
      this.rps = Math.min(this.maxRps, this.rps + Math.max(0.02, this.maxRps * 0.05));
    }
  }

  onThrottle(retryAfterMs?: number): void {
    this.successStreak = 0;
    this.rps = Math.max(this.minRps, this.rps * 0.6);
    if (retryAfterMs && retryAfterMs > 0) {
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + retryAfterMs);
    }
  }
}
