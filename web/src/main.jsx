import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app.jsx';
import { applyAccent } from './brand.js';
import './tokens.css';
import './reset.css';
import './design.css';

// Development-only proof switch: ?brand=forest and ?brand=ocean render the
// identical interface with only the accent token changed. A built box gets its
// accent from the hosting company instead, through the script the server writes
// before this bundle runs; vite's dev server does not serve that, which is what
// this switch is for.
if (import.meta.env.DEV) {
  const proofAccent = new URLSearchParams(window.location.search).get('brand');
  if (proofAccent === 'forest' || proofAccent === 'ocean') {
    document.documentElement.dataset.brandAccent = proofAccent;
  }
}

// The hosting company's accent, and nothing else about them, is allowed to enter
// the design tokens. `brand.js` owns the validation; the rule it enforces is the
// one at the top of tokens.css — a white-label deployment changes --accent and
// nothing else, so every neutral, place colour and interaction stays legible
// whatever colour a hoster picks.
applyAccent();

createRoot(document.getElementById('desk')).render(<StrictMode><App /></StrictMode>);
