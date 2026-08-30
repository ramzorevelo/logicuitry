import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/theme/fonts-d-din.css';
import '@fontsource/jetbrains-mono/400.css';
// Per-theme display faces, headings only: one Latin weight each.
import '@fontsource/syne/latin-600.css';
import '@fontsource/cinzel/latin-600.css';
import '@fontsource/chakra-petch/latin-600.css';
import '@fontsource/rajdhani/latin-600.css';
import './ui/theme/tokens.css';
import './ui/app.css';
import './ui/dialog.css';
import { App } from './ui/App';
import { MenuProvider } from './ui/menu/MenuProvider';
import { applyTheme } from './render/theme';
import { getPrefs } from './ui/prefs';
import { installErrorLog } from './ui/report/errorLog';

installErrorLog();

// Before first paint, so a non-default theme never flashes the light palette.
applyTheme(getPrefs().defaultTheme);

const root = document.getElementById('root')!;
// The boot placeholder is plain markup inside #root; createRoot would leave it
// under the app's own tree otherwise.
root.replaceChildren();

createRoot(root).render(
  <StrictMode>
    <MenuProvider>
      <App />
    </MenuProvider>
  </StrictMode>,
);
