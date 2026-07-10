import { defineConfig } from 'vitest/config';
import { TEST_DATABASE_URL } from './tests/test-db';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: './tests/global-setup.ts',
    setupFiles: ['./tests/setup.ts'],
    fileParallelism: false,
    // 워크트리(.claude/worktrees/*)가 저장소 루트 아래에 중첩되어 있어서, 이 exclude가
    // 없으면 vitest가 각 워크트리 안의 테스트까지 전부 다시 수집해 같은 test.db를
    // 두고 서로 충돌한다.
    exclude: ['**/node_modules/**', '**/.claude/worktrees/**'],
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
    },
  },
});
