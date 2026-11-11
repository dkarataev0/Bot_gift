import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    // интеграционные тесты используют одну тестовую БД — запускаем файлы последовательно
    fileParallelism: false,
  },
});
