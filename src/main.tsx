import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { loadAutosave, startAutosave } from './store/persistence';
import './styles.css';

if (window.native) document.body.classList.add('is-electron');
await loadAutosave();
startAutosave();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
