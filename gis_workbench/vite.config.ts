import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    // The differential GEOS suites live in ../geoprocessing_tool_tests — outside
    // this project root — so Vite has to be allowed to transform files from there.
    // '..' resolves to the repo root, which is exactly the scope Vite's default
    // workspace search already picks (it walks up to the .git directory), so this
    // widens nothing; it just makes the existing scope explicit and survives the
    // test files no longer sitting under src/.
    fs: { allow: ['..'] },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/setupTests.ts',
    // '../geoprocessing_tool_tests' holds the GEOS-oracle suites plus the golden
    // data generated for them. That material is test-only and must not ship in
    // src/, but it is still part of THIS project's suite: `npm run test:run`
    // covers it, and `npm run test:geos` runs just those two files.
    include: [
      'src/**/*.test.{ts,tsx}',
      '../geoprocessing_tool_tests/**/*.test.ts',
    ],
  },
});
