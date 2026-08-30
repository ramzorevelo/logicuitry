// Sending the user to a url outside the app.
//
// A browser tab is `window.open`. A desktop WebView has no tabs to open into,
// so the shell hands the url to the system browser through its opener plugin,
// which is scoped to the one host we ever pass it.

import { isDesktop } from '../../io/platform';

/** False when the url could not be opened at all: a blocked popup, or a shell
 *  that refused. Callers offer a copyable link rather than leaving the user
 *  looking at nothing. */
export async function openExternal(url: string): Promise<boolean> {
  if (isDesktop()) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
      return true;
    } catch {
      return false;
    }
  }
  return Boolean(window.open(url, '_blank', 'noopener,noreferrer'));
}
