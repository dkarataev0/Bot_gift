import { describe, expect, it } from 'vitest';
import { Detector } from '../src/monitor/detector.js';
import { Clock, FakeSource, MemoryStore } from './helpers.js';

function setup(opts: { maxFetchPerTick?: number } = {}) {
  const store = new MemoryStore();
  const source = new FakeSource();
  const clock = new Clock();
  const detector = new Detector(store, source, {
    maxFetchPerTick: opts.maxFetchPerTick ?? 25,
    maxNotifyWindowMs: 15 * 60_000,
    issuedRecheckEvery: 3,
    now: clock.now,
  });
  store.addCollection('plushpepe');
  source.issued.set('plushpepe', 100);
  return { store, source, clock, detector };
}

describe('Detector: первичная загрузка', () => {
  it('запоминает текущий максимум номера и НЕ создаёт событий для старых подарков', async () => {
    const { store, detector } = setup();
    const out = await detector.checkCollection(store.get('plushpepe'));
    expect(out.status).toBe('baseline');
    expect(store.events).toHaveLength(0);
    const c = store.get('plushpepe');
    expect(c.baselineDone).toBe(true);
    expect(c.headNum).toBe(100);
  });

  it('пустая коллекция: после baseline первый же улучшенный подарок — новое событие', async () => {
    const { store, source, clock, detector } = setup();
    source.issued.set('plushpepe', 0);
    await detector.checkCollection(store.get('plushpepe'));
    expect(store.get('plushpepe').headNum).toBe(0);
    clock.advance(3000);
    source.issued.set('plushpepe', 1);
    const out = await detector.checkCollection(store.get('plushpepe'));
    expect(out.newCount).toBe(1);
    expect(store.events[0]!.giftSlug).toBe('plushpepe-1');
  });
});

describe('Detector: новые улучшения', () => {
  it('тихая проверка не создаёт событий и обновляет время подтверждения', async () => {
    const { store, clock, detector } = setup();
    await detector.checkCollection(store.get('plushpepe'));
    clock.advance(5000);
    const out = await detector.checkCollection(store.get('plushpepe'));
    expect(out.status).toBe('quiet');
    expect(store.events).toHaveLength(0);
    expect(store.get('plushpepe').headConfirmedAt!.getTime()).toBe(clock.t);
  });

  it('новый номер -> событие upgrade с окном времени между проверками', async () => {
    const { store, source, clock, detector } = setup();
    await detector.checkCollection(store.get('plushpepe'));
    const t0 = clock.t;
    clock.advance(4000);
    source.issued.set('plushpepe', 102);
    const out = await detector.checkCollection(store.get('plushpepe'));
    expect(out.status).toBe('new');
    expect(out.newCount).toBe(2);
    expect(store.events.map((e) => e.giftSlug)).toEqual(['plushpepe-101', 'plushpepe-102']);
    const ev = store.events[0]!;
    expect(ev.kind).toBe('upgrade');
    expect(ev.confidence).toBe('medium'); // web-источник не различает крафт
    expect(ev.windowStart!.getTime()).toBe(t0);
    expect(ev.windowEnd!.getTime()).toBe(clock.t);
    expect((ev as unknown as { notify: boolean }).notify).toBe(true);
    expect(store.get('plushpepe').headNum).toBe(102);
  });

  it('MTProto: crafted=true -> отдельное событие craft, иначе upgrade с высокой достоверностью', async () => {
    const { store, source, clock, detector } = setup();
    source.web = false;
    await detector.checkCollection(store.get('plushpepe'));
    clock.advance(3000);
    source.issued.set('plushpepe', 102);
    source.crafted.add('plushpepe-102');
    await detector.checkCollection(store.get('plushpepe'));
    expect(store.events.map((e) => [e.kind, e.confidence])).toEqual([
      ['upgrade', 'high'],
      ['craft', 'high'],
    ]);
  });

  it('повторная обработка тех же номеров (перезапуск до сохранения head) не создаёт дублей', async () => {
    const { store, source, clock, detector } = setup();
    await detector.checkCollection(store.get('plushpepe'));
    clock.advance(3000);
    source.issued.set('plushpepe', 103);
    const snapshot = store.get('plushpepe'); // состояние «до» — как будто head не успел сохраниться
    await detector.checkCollection(store.get('plushpepe'));
    expect(store.events).toHaveLength(3);
    // новый экземпляр детектора (перезапуск) обрабатывает ту же коллекцию со старым head
    const detector2 = new Detector(store, source, { maxFetchPerTick: 25, maxNotifyWindowMs: 15 * 60_000, issuedRecheckEvery: 3, now: clock.now });
    const out = await detector2.checkCollection(snapshot);
    expect(out.newCount).toBe(3);
    expect(out.events).toHaveLength(0); // все три — дубли, отклонены
    expect(store.events).toHaveLength(3);
  });

  it('после долгого простоя события сохраняются, но не рассылаются (низкая достоверность времени)', async () => {
    const { store, source, clock, detector } = setup();
    await detector.checkCollection(store.get('plushpepe'));
    clock.advance(3 * 3600_000); // сервис «лежал» 3 часа
    source.issued.set('plushpepe', 105);
    const fresh = new Detector(store, source, { maxFetchPerTick: 25, maxNotifyWindowMs: 15 * 60_000, issuedRecheckEvery: 3, now: clock.now });
    await fresh.checkCollection(store.get('plushpepe'));
    expect(store.events).toHaveLength(5);
    for (const e of store.events) {
      expect(e.confidence).toBe('low');
      expect((e as unknown as { notify: boolean }).notify).toBe(false);
    }
    // а следующие — снова свежие
    clock.advance(3000);
    source.issued.set('plushpepe', 106);
    await fresh.checkCollection(store.get('plushpepe'));
    const last = store.events.at(-1)!;
    expect(last.giftSlug).toBe('plushpepe-106');
    expect((last as unknown as { notify: boolean }).notify).toBe(true);
  });

  it('источник недоступен -> ошибка, head не сдвигается, событий нет', async () => {
    const { store, source, clock, detector } = setup();
    await detector.checkCollection(store.get('plushpepe'));
    source.issued.set('plushpepe', 110);
    source.unavailable = true;
    clock.advance(3000);
    const out = await detector.checkCollection(store.get('plushpepe'));
    expect(out.status).toBe('error');
    expect(store.get('plushpepe').headNum).toBe(100);
    expect(store.events).toHaveLength(0);
  });

  it('пропущенный (сожжённый) номер внутри диапазона пропускается', async () => {
    const { store, source, clock, detector } = setup();
    await detector.checkCollection(store.get('plushpepe'));
    clock.advance(3000);
    source.issued.set('plushpepe', 104);
    source.missing.add('plushpepe-102');
    await detector.checkCollection(store.get('plushpepe'));
    expect(store.events.map((e) => e.giftSlug)).toEqual(['plushpepe-101', 'plushpepe-103', 'plushpepe-104']);
    expect(store.get('plushpepe').headNum).toBe(104);
  });

  it('если отсутствует именно head+1, периодическая перепроверка issued находит следующие номера', async () => {
    const { store, source, clock, detector } = setup();
    await detector.checkCollection(store.get('plushpepe')); // checksCount=1
    source.issued.set('plushpepe', 103);
    source.missing.add('plushpepe-101');
    clock.advance(3000);
    await detector.checkCollection(store.get('plushpepe')); // checksCount=2 -> тихо
    expect(store.events).toHaveLength(0);
    clock.advance(3000);
    await detector.checkCollection(store.get('plushpepe')); // (2+1)%3==0 -> перепроверка issued
    expect(store.events.map((e) => e.giftSlug)).toEqual(['plushpepe-102', 'plushpepe-103']);
  });

  it('большой поток: обрабатывается не больше maxFetchPerTick за проверку, остаток помечается backlog', async () => {
    const { store, source, clock, detector } = setup({ maxFetchPerTick: 10 });
    await detector.checkCollection(store.get('plushpepe'));
    clock.advance(3000);
    source.issued.set('plushpepe', 125);
    const out1 = await detector.checkCollection(store.get('plushpepe'));
    expect(out1.newCount).toBe(10);
    expect(out1.backlog).toBe(true);
    const out2 = await detector.checkCollection(store.get('plushpepe'));
    const out3 = await detector.checkCollection(store.get('plushpepe'));
    expect(out2.newCount + out3.newCount).toBe(15);
    expect(out3.backlog).toBe(false);
    expect(new Set(store.events.map((e) => e.giftSlug)).size).toBe(25);
    expect(store.events.every((e) => (e as unknown as { notify: boolean }).notify)).toBe(true);
  });
});
