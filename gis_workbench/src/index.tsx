import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App';
import { applyTheme, initialTheme } from './utils/theme';

// Paint the persisted theme before React renders: App.css swaps its whole
// palette off the data-theme attribute on <html>, so setting it here keeps a
// dark session from flashing the light palette on the way in. App owns the
// attribute from then on (and keeps it in step with the footer toggle).
applyTheme(initialTheme());

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
