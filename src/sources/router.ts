import type { FetchMode, FetchResult, GiftSource } from '../types.js';
import type { MtprotoSource } from './mtproto.js';
import type { WebSource } from './web.js';

/**
 * Выбирает источник для каждого запроса: MTProto (полные данные, высокая скорость),
 * при его недоступности — публичные страницы t.me (без username владельца).
 */
export class SourceRouter implements GiftSource {
  readonly name = 'mtproto' as const;

  constructor(readonly mtproto: MtprotoSource, readonly web: WebSource) {}

  isReady(): boolean {
    return true;
  }

  get activeName(): 'mtproto' | 'web' {
    return this.mtproto.isReady() && this.mtproto.limiter.pausedForMs === 0 ? 'mtproto' : 'web';
  }

  /** Сколько запросов в секунду сейчас можно делать (для подбора параллельности) */
  get currentRps(): number {
    return this.activeName === 'mtproto' ? this.mtproto.limiter.currentRps : this.web.limiter.currentRps;
  }

  async fetchGift(slug: string, mode: FetchMode = 'page'): Promise<FetchResult> {
    if (this.activeName === 'mtproto') {
      const r = await this.mtproto.fetchGift(slug);
      if (r.status !== 'unavailable') return r;
    }
    return this.web.fetchGift(slug, mode);
  }

  /** Обогащение: получить username владельца через MTProto, если первичный ответ пришёл из web */
  async fetchBest(slug: string): Promise<FetchResult> {
    if (this.mtproto.isReady()) {
      const r = await this.mtproto.fetchGift(slug);
      if (r.status !== 'unavailable') return r;
    }
    return this.web.fetchGift(slug);
  }
}
