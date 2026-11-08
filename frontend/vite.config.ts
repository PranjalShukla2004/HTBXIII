import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'
import { commentary } from './commentary.server.ts'

export default defineConfig(({ mode }) => {
  // Server-side only: keys from HTBXIII/.env for the commentator. Never sent to the page.
  const repoEnv = loadEnv(mode, fileURLToPath(new URL('..', import.meta.url)), '')
  return {
    plugins: [react(), tailwindcss(), commentary(repoEnv)],
    // The backend only accepts browser Origins listed in its FRONTEND_ORIGINS
    // (default: localhost/127.0.0.1 on ports 3000 and 5173). Fail loudly instead of
    // silently moving to another port whose requests the backend would reject.
    server: { port: 5173, strictPort: true },
  }
})
