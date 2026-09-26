// Integration tests that open real console windows on this machine. Run serially.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/win/**/*.win.test.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000
  }
})
