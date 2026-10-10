import { useSyncExternalStore } from 'react';

const THEME_KEY = 'enyukado-theme';
const MODE_KEY = 'enyukado-theme-mode';
const listeners = new Set();

function scheduledTheme(date = new Date()) {
  const hour = date.getHours();
  return hour >= 18 || hour < 6 ? 'dark' : 'light';
}

function readMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'manual' ? 'manual' : 'automatic';
  } catch {
    return 'automatic';
  }
}

function readManualTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

let mode = readMode();
let snapshot = {
  theme: mode === 'manual' ? readManualTheme() : scheduledTheme(),
  automatic: mode === 'automatic',
};
let scheduleTimer;

function notify() {
  listeners.forEach((listener) => listener());
}

function applyTheme(theme, automatic = mode === 'automatic') {
  snapshot = { theme, automatic };
  const root = document.documentElement;
  root.classList.add('theme-anim');
  root.setAttribute('data-theme', theme);
  window.setTimeout(() => root.classList.remove('theme-anim'), 450);
  notify();
}

function scheduleNextChange() {
  window.clearTimeout(scheduleTimer);
  if (mode !== 'automatic') return;

  const now = new Date();
  const nextBoundary = new Date(now);
  const nextHour = now.getHours() < 6 ? 6 : now.getHours() < 18 ? 18 : 6;
  nextBoundary.setHours(nextHour, 0, 0, 0);
  if (nextBoundary <= now) nextBoundary.setDate(nextBoundary.getDate() + 1);

  scheduleTimer = window.setTimeout(() => {
    if (mode === 'automatic') applyTheme(scheduledTheme(), true);
    scheduleNextChange();
  }, Math.max(1, nextBoundary.getTime() - now.getTime()));
}

function applyAutomaticTheme() {
  mode = 'automatic';
  try {
    localStorage.setItem(MODE_KEY, mode);
    localStorage.removeItem(THEME_KEY);
  } catch {
    // Theme still works for this tab when storage is unavailable.
  }
  applyTheme(scheduledTheme(), true);
  scheduleNextChange();
}

document.documentElement.setAttribute('data-theme', snapshot.theme);
scheduleNextChange();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && mode === 'automatic') {
    applyTheme(scheduledTheme(), true);
    scheduleNextChange();
  }
});

window.addEventListener('storage', (event) => {
  if (event.key === MODE_KEY || event.key === THEME_KEY) {
    mode = readMode();
    if (mode === 'automatic') {
      applyTheme(scheduledTheme(), true);
      scheduleNextChange();
    } else {
      window.clearTimeout(scheduleTimer);
      applyTheme(readManualTheme(), false);
    }
  }
});

export function setTheme(next) {
  mode = 'manual';
  try {
    localStorage.setItem(MODE_KEY, mode);
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Theme still works for this tab when storage is unavailable.
  }
  window.clearTimeout(scheduleTimer);
  applyTheme(next, false);
}

export function useTheme() {
  const { theme, automatic } = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => ({ theme: 'light', automatic: true })
  );

  return [
    theme,
    () => setTheme(theme === 'dark' ? 'light' : 'dark'),
    automatic,
    applyAutomaticTheme,
  ];
}
