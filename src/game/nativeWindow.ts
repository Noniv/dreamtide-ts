// Native-window integration for the Tauri desktop build. This is a no-op in the
// plain web build: `__TAURI_INTERNALS__` only exists inside the Tauri WebView, so
// the browser version never imports the API or binds any keys.
//
// The desktop window ships as borderless-maximized (see tauri.conf.json), which
// is "borderless windowed fullscreen". F11 toggles real exclusive fullscreen on
// and off for players who want it.
// True only inside the Tauri desktop WebView; false in the browser build. Use
// this to gate desktop-only UI (e.g. the "Exit" button) so the web version
// never shows it.
export const isNative =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// Quit the desktop app. No-op in the browser (there's no app to close).
export function exitApp(): void {
  if (!isNative) return;
  void import('@tauri-apps/plugin-process').then(({ exit }) => exit(0));
}

export function initNativeWindow(): void {
  if (typeof window === 'undefined') return;
  if (!('__TAURI_INTERNALS__' in window)) return;

  void (async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const appWindow = getCurrentWindow();

    window.addEventListener('keydown', (e) => {
      if (e.key === 'F11') {
        e.preventDefault();
        void appWindow.isFullscreen().then((on) => appWindow.setFullscreen(!on));
      }
    });
  })();
}
