// End-to-end tests against the real app binary (set APP_EXE for the packaged exe). Run serially.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.test.ts'],
    fileParallelism: false,
    testTimeout: 180000
  }
})
