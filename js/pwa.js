// Installable-app plumbing: service worker (offline) and the install prompt.

export const APP_VERSION = '1.1.0';

let deferred = null;
export const installPrompt = () => deferred;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e;
});
window.addEventListener('appinstalled', () => {
  deferred = null;
});

export function registerServiceWorker() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}
