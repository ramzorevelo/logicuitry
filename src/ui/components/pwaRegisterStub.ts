// Stand-in for `virtual:pwa-register/react` in the desktop build, where the
// PWA plugin is off and the virtual module does not exist. A desktop shell
// updates through the installer, never a service worker, so every flag here is
// permanently false and updateServiceWorker does nothing.

import { useState } from 'react';

export function useRegisterSW(_options?: unknown) {
  void _options;
  return {
    needRefresh: useState(false),
    offlineReady: useState(false),
    updateServiceWorker: async (_reload?: boolean) => {
      void _reload;
    },
  };
}
