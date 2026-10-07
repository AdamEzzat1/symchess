import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // results/ sits beside web/: the results page reads the recorded runs from it.
  server: { port: 5173, strictPort: true, fs: { allow: ['..'] } },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
