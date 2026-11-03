import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';
import { restorePanes } from './components/Splitter.tsx';

// Pane widths the human set, before the first paint.
restorePanes();

// A file dropped where nothing takes it would replace the app with that file.
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, e => {
    if (e.defaultPrevented || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
