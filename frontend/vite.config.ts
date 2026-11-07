import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The backend only accepts browser Origins listed in its FRONTEND_ORIGINS
  // (default: localhost/127.0.0.1 on ports 3000 and 5173). Fail loudly instead of
  // silently moving to another port whose requests the backend would reject.
  server: { port: 5173, strictPort: true },
})
