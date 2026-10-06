import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted (bundled) font files: no request to a font CDN at runtime.
import '@fontsource/libre-baskerville/400.css';
import '@fontsource/libre-baskerville/400-italic.css';
import '@fontsource/libre-baskerville/700.css';
import { App } from './App';
import './styles.css';

const root = createRoot(document.getElementById('root')!);

if (import.meta.env.DEV && window.location.hash === '#pieces') {
  // Development aid for checking the piece artwork at size.
  void import('./components/Pieces').then(({ PieceSheet }) => root.render(<PieceSheet />));
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
