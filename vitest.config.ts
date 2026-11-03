import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    // 통합 테스트가 같은 데이터베이스를 쓰므로 파일 단위로 순차 실행한다.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
