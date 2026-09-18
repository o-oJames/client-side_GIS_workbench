/**
 * Dark-mode integration tests.
 *
 * The first half drives the real app: the toggle must sit in the Settings
 * footer immediately right of the lock button, flip `data-theme` on <html>
 * (which is the only thing App.css needs to repaint the whole UI), remember the
 * choice, and be reachable from the split-view footer too — the two panes share
 * one Settings panel, so the theme has to travel App -> SplitScreen -> MapPage
 * -> SettingsDialog.
 *
 * The second half is the styling check that needs no browser: App.css must keep
 * every colour in its two token blocks. A hard-coded colour anywhere else is a
 * patch of light theme that survives the switch to dark, and a token defined in
 * only one block is a value that silently keeps its light meaning — neither is
 * visible to a unit test of the toggle, and both are how a dark mode rots.
 */
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import App from './App';
import { THEME_STORAGE_KEY } from './constants';
import { THEME_ATTRIBUTE } from './utils/theme';

/** Let pending promises + the async layer-restore effects settle inside act(). */
const tick = async (n = 1) => {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise<void>(r => setTimeout(r, 0));
    });
  }
};

const setUrl = (search: string) => window.history.replaceState(null, '', '/map' + search);
const paintedTheme = () => document.documentElement.getAttribute(THEME_ATTRIBUTE);
const themeButton = (root: ParentNode = document) =>
  root.querySelector('.settings-theme-button') as HTMLButtonElement | null;

/** The split panel keeps BOTH sides' dialogs mounted; this returns the visible one. */
const visibleDialog = () => {
  const dialogs = Array.from(document.querySelectorAll('.settings-dialog'));
  return dialogs.find(d => !d.classList.contains('settings-dialog--hidden')) as HTMLElement;
};

const TWO_WORKSPACES = {
  workspaces: [{ id: 'default', name: 'Default' }, { id: 'ws-x', name: 'Survey' }],
  activeId: 'default',
};

function stubSystemPreference(prefersDark: boolean) {
  const original = (window as any).matchMedia;
  (window as any).matchMedia = (query: string) => ({
    matches: prefersDark && /dark/.test(query),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  return () => { (window as any).matchMedia = original; };
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute(THEME_ATTRIBUTE);
  setUrl('');
});

afterEach(() => {
  document.documentElement.removeAttribute(THEME_ATTRIBUTE);
});

describe('the Settings footer theme toggle', () => {
  it('sits immediately right of the lock button, in the footer', async () => {
    render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
    await tick(3);
    fireEvent.click(screen.getByTitle('Settings'));
    await tick();

    const lock = screen.getByRole('button', { name: 'Lock app' });
    const toggle = lock.nextElementSibling as HTMLElement | null;
    expect(toggle?.classList.contains('settings-theme-button'), 'not right of the lock button').toBe(true);
    expect(toggle?.closest('.settings-dialog-footer .settings-footer-left')).toBeTruthy();
    // The rest of the footer keeps its order behind the new button.
    expect(toggle?.nextElementSibling?.classList.contains('settings-split-mode-button')).toBe(true);
  });

  it('paints the dark theme, labels itself after the theme it offers, and remembers', async () => {
    render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
    await tick(3);
    fireEvent.click(screen.getByTitle('Settings'));
    await tick();

    const toggle = themeButton()!;
    expect(toggle).toBeTruthy();
    // Light is the starting point: the button offers the dark theme.
    expect(paintedTheme()).toBe('light');
    expect(toggle.getAttribute('aria-label')).toBe('Switch to dark theme');
    expect(toggle.getAttribute('title')).toMatch(/dark/i);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);
    await tick();
    expect(paintedTheme()).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    // Now it offers the way back, and reports that dark mode is on.
    expect(themeButton()!.getAttribute('aria-label')).toBe('Switch to light theme');
    expect(themeButton()!).toHaveAttribute('aria-pressed', 'true');
    // The icon swaps with the offered theme (sun in the dark, moon in the light).
    expect(themeButton()!.querySelector('svg')).toBeTruthy();

    fireEvent.click(themeButton()!);
    await tick();
    expect(paintedTheme()).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(themeButton()!.getAttribute('aria-label')).toBe('Switch to dark theme');
  });

  it('boots straight into a stored dark theme', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
    await tick(3);

    expect(paintedTheme()).toBe('dark');
    fireEvent.click(screen.getByTitle('Settings'));
    await tick();
    expect(themeButton()!.getAttribute('aria-label')).toBe('Switch to light theme');
  });

  it('follows the system preference until the user picks a theme', async () => {
    const restore = stubSystemPreference(true);
    render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
    await tick(3);
    expect(paintedTheme()).toBe('dark');
    // An implicit theme is not a stored one.
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

    fireEvent.click(screen.getByTitle('Settings'));
    await tick();
    fireEvent.click(themeButton()!);
    await tick();
    expect(paintedTheme()).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    restore();
  });

  it('is in the split-view footer too, and still drives the same attribute', async () => {
    localStorage.setItem('mapviewer-workspaces', JSON.stringify(TWO_WORKSPACES));
    setUrl('?split-screen=true&workspaces=default,ws-x');
    render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
    await tick(3);

    fireEvent.click(screen.getByRole('button', { name: 'Split view settings' }));
    await tick();
    const dialog = visibleDialog();
    const toggle = themeButton(dialog)!;
    expect(toggle, 'no theme toggle in the split footer').toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Lock app' }).nextElementSibling).toBe(toggle);

    fireEvent.click(toggle);
    await tick();
    expect(paintedTheme()).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });
});

// ---------------------------------------------------------------------------
// App.css itself: the token contract the toggle depends on.
// ---------------------------------------------------------------------------
const APP_CSS = readFileSync(join(__dirname, 'App.css'), 'utf8');
const INDEX_CSS = readFileSync(join(__dirname, 'index.css'), 'utf8');
/** Comments are prose and may mention colours; the blocks hold the tokens. */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const TOKEN_BLOCK = /:root(\[data-theme='dark'\])?\s*\{[^}]*\}/g;

function tokenBlocks() {
  const blocks = stripComments(APP_CSS).match(TOKEN_BLOCK) || [];
  expect(blocks, 'expected the light and dark token blocks').toHaveLength(2);
  // A /g/ match is (string | undefined)[] in the ES2018 lib, and the length is
  // asserted above, so the fallbacks are only there for the type checker.
  return { light: blocks[0] ?? '', dark: blocks[1] ?? '' };
}

const definedTokens = (block: string) =>
  new Set([...block.matchAll(/^\s*(--[A-Za-z0-9-]+)\s*:/gm)].map(m => m[1]));

describe('App.css keeps every colour in the theme tokens', () => {
  it('has a light block and a data-theme="dark" block', () => {
    const { light, dark } = tokenBlocks();
    expect(light.startsWith(':root {')).toBe(true);
    expect(dark.startsWith(":root[data-theme='dark']")).toBe(true);
    expect(light).toMatch(/color-scheme:\s*light/);
    expect(dark).toMatch(/color-scheme:\s*dark/);
  });

  it('defines the same tokens in both themes, so nothing keeps a light value', () => {
    const { light, dark } = tokenBlocks();
    const lightTokens = definedTokens(light);
    const darkTokens = definedTokens(dark);
    expect(lightTokens.size).toBeGreaterThan(50); // a real palette, not a stub
    expect([...lightTokens].filter(t => !darkTokens.has(t))).toEqual([]);
    expect([...darkTokens].filter(t => !lightTokens.has(t))).toEqual([]);
  });

  it('defines every token the stylesheets use', () => {
    const { light, dark } = tokenBlocks();
    const defined = definedTokens(light);
    for (const d of definedTokens(dark)) defined.add(d);
    const used = new Set<string>();
    for (const css of [stripComments(APP_CSS), stripComments(INDEX_CSS)]) {
      for (const m of css.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)) used.add(m[1]);
    }
    expect([...used].filter(t => !defined.has(t))).toEqual([]);
  });

  it('hard-codes no colour outside the token blocks', () => {
    const body = stripComments(APP_CSS).replace(TOKEN_BLOCK, '');
    const hexes = [...body.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)].map(m => m[0]);
    const functions = [...body.matchAll(/\brgba?\(\s*[0-9.]/g)].map(m => m[0]);
    expect(hexes, 'hard-coded hex colour in a rule').toEqual([]);
    expect(functions, 'hard-coded rgb()/rgba() in a rule').toEqual([]);
    // `transparent` and `inherit` are theme-independent and stay allowed.
  });

  it('themes the app backdrop and the inherited text colour', () => {
    expect(INDEX_CSS).toMatch(/background:\s*var\(--app-bg\)/);
    expect(INDEX_CSS).toMatch(/color:\s*var\(--body-text\)/);
    // An area no tile covers must not glare white in the dark theme.
    expect(APP_CSS).toMatch(/\.map-container\s*\{[^}]*background:\s*var\(--map-bg\)/s);
  });
});
