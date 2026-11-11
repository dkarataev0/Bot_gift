/** Обнаружение коллекций (в т.ч. новых) */
import type { Repository } from '../db/repository.js';
import { logger } from '../logger.js';
import { BUILTIN_COLLECTIONS, fetchFragmentCollections, titleToBase } from '../sources/catalog.js';
import type { MtprotoSource } from '../sources/mtproto.js';

export class CollectionDiscovery {
  lastRunAt: Date | null = null;
  lastError: string | null = null;
  lastFragmentCount = 0;

  constructor(
    private readonly repo: Repository,
    private readonly mtproto: MtprotoSource,
    private readonly onNewCollection: (base: string) => void,
  ) {}

  /** Возвращает список добавленных коллекций */
  async run(): Promise<string[]> {
    const firstRun = (await this.repo.listCollections()).length === 0;
    const added: string[] = [];
    const add = async (base: string, by: string, title: string | null = null) => {
      if (!/^[a-z0-9]{2,64}$/.test(base)) return;
      if (await this.repo.upsertCollection(base, by, title)) added.push(base);
    };

    try {
      const list = await fetchFragmentCollections();
      this.lastFragmentCount = list.length;
      for (const c of list) await add(c.base, 'fragment');
      this.lastError = null;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      logger.warn({ err: this.lastError }, 'Каталог fragment.com недоступен');
    }

    if (this.mtproto.isReady()) {
      try {
        for (const g of await this.mtproto.listCatalog()) {
          if (g.upgradable && g.title) await add(titleToBase(g.title), 'mtproto', g.title);
        }
      } catch (e) {
        logger.warn({ err: e instanceof Error ? e.message : e }, 'MTProto: не удалось получить каталог подарков');
      }
    }

    if ((await this.repo.listCollections()).length === 0) {
      logger.warn('Использую встроенный список коллекций');
      for (const b of BUILTIN_COLLECTIONS) await add(b, 'builtin');
    }

    this.lastRunAt = new Date();
    if (added.length) logger.info({ added: added.length }, 'Добавлены коллекции');
    if (!firstRun) for (const b of added) this.onNewCollection(b);
    return added;
  }
}
