import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { startAutosave, startSession } from './store/persistence';
import { useStore } from './store/store';
import { resumePendingCitations } from './citations/resolve';
import './styles.css';

if (window.native) document.body.classList.add('is-electron');
await startSession();
startAutosave();
// Citations still loading when a presentation was saved resume when it is opened again.
useStore.subscribe((s, p) => { if (s.deck.id !== p.deck.id) resumePendingCitations(); });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
