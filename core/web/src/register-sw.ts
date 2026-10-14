/**
 * The service worker is what makes the portal installable. Not under Vite's
 * dev server, whose modules change on every save; and browsers only offer one
 * over HTTPS or on localhost.
 */
export function registerServiceWorker(prod: boolean, win: Window = window) {
  if (!prod || !("serviceWorker" in win.navigator)) return;
  win.addEventListener("load", () => {
    win.navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
