import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { startAutosave, startNativeOpen, startSession } from './store/persistence';
import { useStore } from './store/store';
import { loadUserPrefs } from './store/userPrefs';
import { resumePendingCitations } from './citations/resolve';
import './styles.css';

if (window.native) document.body.classList.add('is-electron');
await Promise.all([startSession(), loadUserPrefs()]); // user preferences are independent of the deck session
startAutosave();
void startNativeOpen(); // .mslides files the OS asked us to open (queued until now)
// Citations still loading when a presentation was saved resume when it is opened again.
useStore.subscribe((s, p) => { if (s.deck.id !== p.deck.id) resumePendingCitations(); });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
