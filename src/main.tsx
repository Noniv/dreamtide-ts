import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { initNativeWindow } from './game/nativeWindow';

// Desktop (Tauri) window integration; a no-op in the browser build.
initNativeWindow();

// no StrictMode: the engine owns canvases/RAF and dev double-mount would
// create a second engine instance
createRoot(document.getElementById('root')!).render(<App />);

// Reveal from the boot veil once the app has mounted, fonts are ready, and a
// couple of frames have been painted under it (hides font swap / first canvas
// frame). Holds the purple veil ~300ms, then fades over 600ms and removes it.
const boot = document.getElementById('boot');
if (boot) {
  const reveal = () => {
    // two RAFs: let React commit + the first render frame paint before the hold
    requestAnimationFrame(() => requestAnimationFrame(() => {
      setTimeout(() => {
        boot.classList.add('hide'); // 600ms CSS opacity fade
        boot.addEventListener('transitionend', () => boot.remove(), { once: true });
        // safety fallback in case transitionend doesn't fire (> fade duration)
        setTimeout(() => boot.remove(), 900);
      }, 300); // stay fully purple for 300ms first
    }));
  };
  const fontsReady = (document as Document & { fonts?: FontFaceSet }).fonts?.ready;
  if (fontsReady) fontsReady.then(reveal); else reveal();
}
