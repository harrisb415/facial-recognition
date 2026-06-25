import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/index.css';

if ('serviceWorker' in navigator) {
  // Registered from the app's own origin only — see public/sw.js and
  // offline-model-loading-plan.md for the caching strategy this enables.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.error('Service worker registration failed:', err);
    });
  });
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root element not found in index.html');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
