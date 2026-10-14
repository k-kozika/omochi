import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const target = process.env.OMOCHI_HUB ?? 'http://127.0.0.1:5555';
export default defineConfig({ plugins: [react()], server: { host: '127.0.0.1', proxy: { '/ws': { target, ws: true }, '/api': { target }, '/events': { target }, '/services': { target } } } });
