import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base: './'` for the Tauri build so assets load over the tauri:// protocol
// from disk; absolute '/' for the plain web build. The Tauri CLI sets
// TAURI_ENV_* vars when it invokes the before{Dev,Build}Command.
// `clearScreen: false` keeps Tauri's compile output visible.
const isTauri = !!process.env.TAURI_ENV_PLATFORM;

export default defineConfig({
  plugins: [react()],
  base: isTauri ? './' : '/',
  clearScreen: false,
  server: {
    strictPort: true,
  },
});
