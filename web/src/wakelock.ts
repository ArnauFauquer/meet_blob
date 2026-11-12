// Keeps the tablet screen on. The lock is released when the page is hidden,
// so it is requested again each time the page becomes visible.
export function keepAwake(): void {
  const request = () => {
    if (document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
    navigator.wakeLock.request('screen').catch(() => {
      // not allowed (no secure context, battery saver): the screen may sleep
    });
  };
  request();
  document.addEventListener('visibilitychange', request);
}
