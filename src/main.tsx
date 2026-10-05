import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { startAutosave, startNewSession } from './store/persistence';
import './styles.css';

if (window.native) document.body.classList.add('is-electron');
await startNewSession();
startAutosave();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
