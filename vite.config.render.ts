/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// The "render" vitest project (renderer-3d.md §3): rendered-pixel contrast assertions run in a
// real headless Chromium via vitest browser mode, not jsdom — jsdom has no WebGL, and a rendered
// pixel is exactly what this project exists to read back.
export default defineConfig({
  optimizeDeps: {
    include: [
      'three/examples/jsm/lines/Line2.js',
      'three/examples/jsm/lines/LineGeometry.js',
      'three/examples/jsm/lines/LineMaterial.js',
      'three/examples/jsm/lines/LineSegments2.js',
      'three/examples/jsm/lines/LineSegmentsGeometry.js',
      'three/examples/jsm/utils/BufferGeometryUtils.js',
    ],
  },
  test: {
    name: 'render',
    include: ['src/render/three/**/*.rendered.test.ts'],
    browser: {
      enabled: true,
      provider: 'playwright',
      name: 'chromium',
      headless: true,
      providerOptions: {
        launch: {
          // Deterministic software rasterisation so CI and a laptop produce identical pixels —
          // renderer-3d.md §3.
          args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
        },
      },
    },
  },
});
