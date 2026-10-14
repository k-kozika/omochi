import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const bridge = process.env.OMOCHI_HUB ?? 'http://127.0.0.1:5555'

// Proxy the development bridge; ?ws= selects another A2UI endpoint.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/ws': { target: bridge, ws: true },
    },
  },
})
