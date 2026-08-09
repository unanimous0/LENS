import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// dev(`vite`)와 preview(`vite preview` — 프로덕션 빌드 확인용)가 같은 프록시를 쓰게 공유.
// preview에 프록시가 없으면 /api 가 404라 프로덕션 빌드를 로컬에서 검증할 수 없다.
const proxy = {
  '/api': {
    target: 'http://localhost:8100',
    changeOrigin: true,
  },
  '/ws': {
    target: 'ws://localhost:8200',
    ws: true,
  },
  '/realtime': {
    target: 'http://localhost:8200',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/realtime/, ''),
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: { proxy },
  preview: { proxy },
})
