/**
 * Theme preference tests: what is stored, what wins at boot, and what gets
 * painted onto <html>. App.css swaps its whole palette off the data-theme
 * attribute, so these three functions are the entire contract between the
 * Settings footer toggle and the stylesheet.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { THEME_STORAGE_KEY } from '../constants';
import {
  THEME_ATTRIBUTE,
  isThemeMode,
  otherTheme,
  loadTheme,
  saveTheme,
  systemTheme,
  initialTheme,
  applyTheme,
  currentTheme,
} from './theme';

/** Install (or remove) a matchMedia stub, the way a browser preference reads. */
function stubSystemPreference(prefersDark: boolean | 'missing') {
  const original = (window as any).matchMedia;
  if (prefersDark === 'missing') {
    delete (window as any).matchMedia;
  } else {
    (window as any).matchMedia = (query: string) => ({
      matches: prefersDark && /dark/.test(query),
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });
  }
  return () => {
    if (prefersDark === 'missing') delete (window as any).matchMedia;
    else (window as any).matchMedia = original;
  };
}

describe('theme guards and flips', () => {
  it('accepts only the two theme names', () => {
    expect(isThemeMode('light')).toBe(true);
    expect(isThemeMode('dark')).toBe(true);
    expect(isThemeMode('Dark')).toBe(false);
    expect(isThemeMode('solarized')).toBe(false);
    expect(isThemeMode(null)).toBe(false);
    expect(isThemeMode(undefined)).toBe(false);
    expect(isThemeMode(1)).toBe(false);
  });

  it('otherTheme flips both ways', () => {
    expect(otherTheme('light')).toBe('dark');
    expect(otherTheme('dark')).toBe('light');
    expect(otherTheme(otherTheme('dark'))).toBe('dark');
  });
});

describe('theme persistence', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips through localStorage under the app storage key', () => {
    expect(THEME_STORAGE_KEY).toBe('mapviewer-theme');
    expect(loadTheme()).toBeNull();
    saveTheme('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(loadTheme()).toBe('dark');
    saveTheme('light');
    expect(loadTheme()).toBe('light');
  });

  it('ignores a value it does not recognise', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'midnight');
    expect(loadTheme()).toBeNull();
    localStorage.setItem(THEME_STORAGE_KEY, '');
    expect(loadTheme()).toBeNull();
    localStorage.setItem(THEME_STORAGE_KEY, 'DARK');
    expect(loadTheme()).toBeNull();
  });

  it('reports no preference when storage cannot be read or written', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadTheme()).toBeNull();
    read.mockRestore();

    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => saveTheme('dark')).not.toThrow();
    write.mockRestore();
  });
});

describe('the theme to paint at boot', () => {
  beforeEach(() => localStorage.clear());

  it('reads the operating system preference', () => {
    let restore = stubSystemPreference(true);
    expect(systemTheme()).toBe('dark');
    restore();

    restore = stubSystemPreference(false);
    expect(systemTheme()).toBe('light');
    restore();
  });

  it('falls back to light when the browser cannot answer', () => {
    const restore = stubSystemPreference('missing');
    expect(systemTheme()).toBe('light');
    restore();
  });

  it('prefers the stored choice over the system one', () => {
    const restore = stubSystemPreference(true);
    saveTheme('light');
    expect(initialTheme()).toBe('light');
    saveTheme('dark');
    expect(initialTheme()).toBe('dark');
    restore();
  });

  it('follows the system when nothing was stored', () => {
    let restore = stubSystemPreference(true);
    expect(initialTheme()).toBe('dark');
    restore();

    restore = stubSystemPreference(false);
    expect(initialTheme()).toBe('light');
    restore();
  });

  it('does not persist the fallback: an implicit theme stays implicit', () => {
    const restore = stubSystemPreference(true);
    expect(initialTheme()).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    restore();
  });
});

describe('painting the document', () => {
  afterEach(() => {
    document.documentElement.removeAttribute(THEME_ATTRIBUTE);
    document.querySelector('meta[name="theme-color"]')?.remove();
  });

  it('writes data-theme on <html>, which is what App.css keys off', () => {
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBeNull();
    expect(currentTheme()).toBe('light'); // nothing painted yet -> the default

    applyTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(currentTheme()).toBe('dark');

    applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(currentTheme()).toBe('light');
  });

  it('keeps the theme-colour meta tag in step when the page has one', () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    meta.setAttribute('content', '#4a90e2');
    document.head.appendChild(meta);

    applyTheme('dark');
    expect(meta.getAttribute('content')).not.toBe('#4a90e2');
    const dark = meta.getAttribute('content');
    applyTheme('light');
    expect(meta.getAttribute('content')).toBe('#4a90e2');
    applyTheme('dark');
    expect(meta.getAttribute('content')).toBe(dark);
  });

  it('is safe without the meta tag', () => {
    expect(document.querySelector('meta[name="theme-color"]')).toBeNull();
    expect(() => applyTheme('dark')).not.toThrow();
    expect(currentTheme()).toBe('dark');
  });

  it('reads back a garbage attribute as the light default', () => {
    document.documentElement.setAttribute(THEME_ATTRIBUTE, 'chartreuse');
    expect(currentTheme()).toBe('light');
  });
});
