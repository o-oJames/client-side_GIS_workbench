# Light & dark theme — how the UI repaints

The app chrome (every panel, dialog, toolbar, popup and window) can be shown in
a light or a dark palette. The map's own content is **never** re-themed: raster
tiles, vector symbology, measurement chips and the attribution keep their
colours in both themes, so a dark basemap preset remains the way to get dark
*geography*.

## The mechanism

`App.css` opens with two blocks of CSS custom properties:

```css
:root                    { --surface: #ffffff; … }   /* light values  */
:root[data-theme='dark'] { --surface: #1c222b; … }   /* dark values   */
```

Every colour used anywhere else in the stylesheet is a `var(--token)` reference
(or `rgba(var(--token-rgb), <alpha>)` for translucent ones, where the rule keeps
its own alpha and only the r,g,b triple is themed). Switching themes is
therefore a single attribute write on `<html>`; there is no per-component dark
variant and no class juggling.

`src/utils/theme.ts` owns that attribute:

| function | job |
|----------|-----|
| `applyTheme(theme)` | writes `data-theme` on `<html>` and syncs `<meta name="theme-color">` |
| `initialTheme()` | stored choice, else the OS `prefers-color-scheme`, else `'light'` |
| `loadTheme()` / `saveTheme()` | the `mapviewer-theme` localStorage key (`'light'` / `'dark'`; absent = no explicit choice) |
| `systemTheme()` / `otherTheme()` / `currentTheme()` / `isThemeMode()` | helpers |

`src/index.tsx` calls `applyTheme(initialTheme())` before the first render so a
dark session never flashes the light palette; `App` keeps the attribute in step
with React state from then on, and re-reads the stored value after an app-lock
restore (the theme is one of the vault's keys).

The preference is **app-wide**, not per workspace: it describes the display, not
the data.

## The toggle

The Settings dialog footer's left group reads `[lock] [theme] [split] [vector
tools]`. The theme pad sits immediately right of the padlock, shares the
padlock's sizing/hover/focus rules, shows a moon while light (offering dark) and
a sun while dark (offering light), and picks up the accent tint while dark mode
is on so the state reads without interpreting the glyph. Because split-screen
shares one Settings panel, the toggle is wired `App → SplitScreen → MapPage →
SettingsDialog` and behaves identically in both modes.

## Token taxonomy

| family | meaning |
|--------|---------|
| `--surface`, `--surface-2…8` | neutral panel fills, most prominent first (panels → subtle alt → muted → chips → disabled greys) |
| `--accent-surface-2…7` | accent-*tinted* fills: hover washes, selection, disabled primary buttons |
| `--danger/--warning/--success-surface-*` | status fills |
| `--ink`, `--ink-blue/-danger/-success` | fills that are already dark in **both** themes (lock placeholder, the error banner) |
| `--border*` | hairlines and outlines, softest first; `-accent/-danger/…` are the tinted variants |
| `--accent`, `--danger`, `--warning`, `--success` (+ `-light/-strong/-deep`) | saturated fills, rings and outlines. `-strong`/`-deep` are hover/active states: the light theme *darkens* them, the dark theme *lightens* them |
| `--text*` | type, strongest first; `--text-cool*` is the blue-grey ramp; `--text-accent*`, `--text-danger*`, … are the saturated label colours |
| `--text-on-accent` | white type/rings on a saturated fill — identical in both themes |
| `--text-on-ink` | pale type on an already-dark chip — identical in both themes |
| `--*-rgb` | r,g,b triples for translucent colours (`--accent-rgb`, `--shadow-rgb`, `--glass-rgb`, …) |
| `--app-bg`, `--map-bg`, `--body-text` | what the app sits on: page backdrop, the map canvas where no tile paints, inherited text colour |

Veils flip or hold by intent: `--veil-rgb`, `--thumb-rgb`, `--track-rgb` and
`--ink-line-rgb` are black in light and white in dark (hover washes, scrollbar
thumbs, hairlines), while `--shadow-rgb`, `--scrim-rgb` (modal backdrops) and
`--gloss-rgb` (specular sheens on coloured fills) stay black/white in both.

## Adding a colour

1. Find the token whose **light** value is the colour you designed with; use
   `var(--token)`.
2. If none fits, add a token to **both** blocks at the top of `App.css` — light
   value = your colour, dark value = its counterpart on the slate palette — and
   reference it from your rule. Never write a literal colour into a rule.
3. `color-scheme` flips with the theme, so native controls (scrollbars,
   checkboxes, colour pickers) follow automatically.

`src/Theme.test.tsx` enforces the contract in CI: both blocks must define the
same token set, every `var(--…)` used by `App.css`/`index.css` must resolve, and
no hex or numeric `rgb()/rgba()` literal may appear outside the two blocks.

## Deliberately not themed

- Basemap and data tiles, drawn feature styles, measurement chips, the SAM
  hint, exported images — data colours are the user's, not the chrome's.
- The OpenLayers attribution (it sits on the tiles, which stay light).
- OpenLayers' own control styling in the **light** theme; the dark theme adds
  `:root[data-theme='dark'] .ol-control …` overrides at the bottom of
  `App.css` because that chrome lives in `ol/ol.css`, which App.css does not own.
