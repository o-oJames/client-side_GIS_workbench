/**
 * Light/dark UI theme.
 *
 * App.css keeps every colour it uses in two blocks of custom properties at the
 * top of the file (`:root` and `:root[data-theme='dark']`), so switching themes
 * is a matter of writing one attribute on <html>. This module owns that
 * attribute plus the localStorage preference behind it; it is pure (no React)
 * so it can be called from index.tsx before the first paint and tested on its
 * own.
 *
 * The preference is app-wide rather than per workspace: it describes the
 * display, not the data, and follows the user between workspaces.
 */
import { THEME_STORAGE_KEY } from '../constants';
import type { ThemeMode } from '../types';

/** Attribute on <html> that selects the App.css token block. */
export const THEME_ATTRIBUTE = 'data-theme';

/** Browser-chrome colour per theme, written to <meta name="theme-color">. */
const THEME_COLOR_META: Record<ThemeMode, string> = {
  light: '#4a90e2',
  dark: '#10141a',
};

/** Type guard for values read back from storage or the DOM. */
export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark';
}

/** The other theme — what the footer toggle switches to. */
export function otherTheme(theme: ThemeMode): ThemeMode {
  return theme === 'dark' ? 'light' : 'dark';
}

/** The persisted theme, or null when the user has never picked one. */
export function loadTheme(): ThemeMode | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(stored) ? stored : null;
  } catch (e) {
    console.error('[Theme] Failed to read the stored theme:', e);
    return null;
  }
}

/** Persist an explicit choice. Anything else is treated as 'light'. */
export function saveTheme(theme: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (e) {
    console.error('[Theme] Failed to save the theme:', e);
  }
}

/** The operating system's preference; 'light' when it cannot be read. */
export function systemTheme(): ThemeMode {
  try {
    if (typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
  } catch (e) {
    console.error('[Theme] Failed to read the system theme:', e);
  }
  return 'light';
}

/**
 * The theme to paint at boot: the stored choice when there is one, otherwise
 * the system preference. Called before the first render (index.tsx) so a dark
 * session never flashes light, and again after an app-lock restore.
 */
export function initialTheme(): ThemeMode {
  return loadTheme() ?? systemTheme();
}

/**
 * Paint the document: the `data-theme` attribute drives every token in
 * App.css, and the theme-colour meta tag keeps mobile browser chrome in step.
 */
export function applyTheme(theme: ThemeMode): void {
  try {
    document.documentElement.setAttribute(THEME_ATTRIBUTE, theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLOR_META[theme]);
  } catch (e) {
    console.error('[Theme] Failed to apply the theme:', e);
  }
}

/** The theme currently painted on <html> ('light' when nothing is set). */
export function currentTheme(): ThemeMode {
  try {
    const painted = document.documentElement.getAttribute(THEME_ATTRIBUTE);
    if (isThemeMode(painted)) return painted;
  } catch (e) {
    console.error('[Theme] Failed to read the applied theme:', e);
  }
  return 'light';
}
