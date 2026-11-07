import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import App from './App';
import { clearTemporary } from './lib/files';

// Temporary export files and Excel-sheet copies from earlier sessions are removed at
// start-up so that consumer data is not retained in browser storage.
clearTemporary().catch(() => {});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
