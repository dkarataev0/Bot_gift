/** Простая статистика доступности источника для /status */
export class SourceHealth {
  okCount = 0;
  failCount = 0;
  lastOkAt: Date | null = null;
  lastFailAt: Date | null = null;
  lastError: string | null = null;
  private latencies: number[] = [];
  private recent: boolean[] = [];

  constructor(readonly name: string) {}

  ok(latencyMs: number): void {
    this.okCount++;
    this.lastOkAt = new Date();
    this.latencies.push(latencyMs);
    if (this.latencies.length > 200) this.latencies.shift();
    this.push(true);
  }

  fail(reason: string): void {
    this.failCount++;
    this.lastFailAt = new Date();
    this.lastError = reason;
    this.push(false);
  }

  private push(v: boolean) {
    this.recent.push(v);
    if (this.recent.length > 100) this.recent.shift();
  }

  /** Доля успешных из последних 100 запросов */
  get recentSuccessRate(): number | null {
    if (!this.recent.length) return null;
    return this.recent.filter(Boolean).length / this.recent.length;
  }

  get medianLatencyMs(): number | null {
    if (!this.latencies.length) return null;
    const s = [...this.latencies].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  }
}
