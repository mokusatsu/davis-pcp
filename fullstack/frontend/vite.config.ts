import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig(({ mode }) => {
  const isStatic = mode === 'static'

  return {
    base: isStatic ? './' : '/',
    plugins: [react()],
    define: {
      'import.meta.env.VITE_STATIC_BUILD': JSON.stringify(isStatic ? 'true' : 'false'),
    },
    build: {
      outDir: isStatic ? resolve(__dirname, '../../dist/static') : 'dist',
      emptyOutDir: isStatic ? false : true,
    },
    worker: {
      format: 'es',
    },
    server: {
      port: 5173,
      proxy: {
        '/api': { target: process.env.DAVIS_PCP_API_TARGET || 'http://127.0.0.1:8420', changeOrigin: true },
        '/ws': { target: 'ws://127.0.0.1:8420', ws: true },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: './tests/setup.ts',
    },
  } as never
})
