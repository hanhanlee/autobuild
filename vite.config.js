import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      // 關鍵設定：告訴 Vite 不要監聽 builds 資料夾下的任何檔案
      // 這可以大幅減少 watcher 的消耗，避免 ENOSPC 錯誤
      ignored: ['**/builds/**', '**/node_modules/**', '**/.git/**']
    }
  }
})
