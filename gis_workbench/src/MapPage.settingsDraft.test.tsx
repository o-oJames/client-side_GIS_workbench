// ---------------------------------------------------------------------------
// MapPage.settingsDraft.test.tsx — closing the Settings panel must not cost the
// user anything they were typing. An unpinned panel closes on any outside click
// (and on ✕ / the gear), which made it easy to lose a half-filled "Add Raster
// Layer" / "Add Vector Layer" form. The panel now stays mounted and only hides,
// so the pending content — typed values, the chosen source type, discovery
// results, a picked file — is exactly as it was when the panel is reopened.
// Portalled overlays anchored to the viewport (context menus, export popup) are
// the exception: they are dismissed on hide so they never float over the map.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';

/** Let the async layer-restore effect settle inside act(). */
const tick = async () => {
  await act(async () => {
    await new Promise<void>(r => setTimeout(r, 0));
  });
};

const dialog = () => document.querySelector('.settings-dialog') as HTMLElement | null;
const isHidden = () => !!dialog()?.classList.contains('settings-dialog--hidden');

/** The `.settings-section` whose title matches, e.g. "Raster Layers". */
function sectionOf(title: string): HTMLElement {
  const section = Array.from(document.querySelectorAll<HTMLElement>('.settings-section'))
    .find(s => s.querySelector('.settings-section-title')?.textContent === title);
  expect(section).toBeTruthy();
  return section!;
}

/** The expanded add-layer form of a section (null while it is collapsed). */
const addFormOf = (title: string) => sectionOf(title).querySelector<HTMLElement>('.settings-add-form');
const rasterForm = () => addFormOf('Raster Layers');
const vectorForm = () => addFormOf('Vector Layers');

const mapViewport = () => document.querySelector('.ol-viewport') as HTMLElement;

/** Open the panel and expand one of the two add-layer forms. */
async function openAddForm(buttonLabel: string) {
  fireEvent.click(screen.getByTitle('Settings'));
  await tick();
  expect(isHidden()).toBe(false);
  fireEvent.click(screen.getByText(buttonLabel));
  await tick();
}

/** Pick an option from a real CustomSelect (its menu is portalled to body). */
async function pickSelectOption(root: HTMLElement, optionText: RegExp) {
  fireEvent.click(root.querySelector('.custom-select-trigger') as HTMLButtonElement);
  await tick();
  const option = Array.from(document.querySelectorAll<HTMLElement>('.custom-select-menu-portal .custom-select-option'))
    .find(o => optionText.test(o.textContent || ''));
  expect(option).toBeTruthy();
  fireEvent.click(option!);
  await tick();
}

// `visibility` is inherited *and* transitionable, so any descendant carrying a
// `transition: all …` (Add / Cancel / Apply buttons, the dashed add-layer
// buttons, ~24 rules in App.css) would keep its inherited `visible` value for
// the whole transition and linger on screen after the panel hides. jsdom does
// not run CSS transitions, so this guards the stylesheet rule that stops them
// from ever starting inside the hidden panel.
test('the hidden panel disables descendant transitions so nothing lingers after it hides', () => {
  // Vitest serves modules over a non-file: URL, so resolve the stylesheet
  // from the module directory (Node) or the project root (fallback).
  const here = (import.meta as any).dirname as string | undefined;
  const css = readFileSync(here ? join(here, 'App.css') : join(process.cwd(), 'src', 'App.css'), 'utf8');
  const rule = css.match(/\.settings-dialog--hidden,\s*\.settings-dialog--hidden \*\s*\{([^}]*)\}/);
  expect(rule).not.toBeNull();
  expect(rule![1]).toContain('transition: none');
});

beforeEach(() => {
  localStorage.clear();
});

test('an outside click that closes the unpinned panel keeps the half-filled raster add form', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick();
  await openAddForm('+ Add Raster Layer');

  const url = 'https://tiles.example.com/{z}/{x}/{y}.png';
  fireEvent.change(within(rasterForm()!).getByPlaceholderText('Layer name'), {
    target: { value: 'Auckland 2025' },
  });
  fireEvent.change(within(rasterForm()!).getByPlaceholderText(/^XYZ URL/), { target: { value: url } });

  // An accidental click on the map closes the unpinned panel…
  fireEvent.pointerDown(mapViewport());
  await tick();
  expect(isHidden()).toBe(true);

  // …but nothing was discarded: the form is still expanded, still filled in.
  fireEvent.click(screen.getByTitle('Settings'));
  await tick();
  expect(isHidden()).toBe(false);
  expect(rasterForm()).toBeTruthy();
  expect(within(rasterForm()!).getByPlaceholderText('Layer name')).toHaveValue('Auckland 2025');
  expect(within(rasterForm()!).getByPlaceholderText(/^XYZ URL/)).toHaveValue(url);
});

test('the ✕ button keeps the vector add form and its chosen source type', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick();
  await openAddForm('+ Add Vector Layer');

  // Switch the source type away from the default (File) to MVT.
  await pickSelectOption(vectorForm()!, /MVT/);
  fireEvent.change(within(vectorForm()!).getByPlaceholderText('Layer name'), {
    target: { value: 'Buildings MVT' },
  });
  fireEvent.change(within(vectorForm()!).getByPlaceholderText(/^MVT URL/), {
    target: { value: 'https://tiles.example.com/buildings/{z}/{x}/{y}.pbf' },
  });

  fireEvent.click(document.querySelector('.settings-dialog-close') as HTMLButtonElement);
  await tick();
  expect(isHidden()).toBe(true);

  fireEvent.click(screen.getByTitle('Settings'));
  await tick();
  const form = vectorForm()!;
  expect(form).toBeTruthy();
  // The selected source type survived too — not just the text inputs.
  expect(form.querySelector('.custom-select-trigger')!.textContent).toContain('MVT');
  expect(within(form).getByPlaceholderText('Layer name')).toHaveValue('Buildings MVT');
  expect(within(form).getByPlaceholderText(/^MVT URL/))
    .toHaveValue('https://tiles.example.com/buildings/{z}/{x}/{y}.pbf');
});

test('a viewport-anchored menu opened in the panel does not outlive it', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick();
  fireEvent.click(screen.getByTitle('Settings'));
  await tick();

  // Right-click the lock button: its menu is portalled to document.body, so
  // hiding the panel would otherwise leave it floating over the map.
  fireEvent.contextMenu(screen.getByLabelText('Lock app'));
  await tick();
  expect(document.querySelector('.lock-context-menu')).not.toBeNull();

  fireEvent.pointerDown(mapViewport());
  await tick();
  expect(isHidden()).toBe(true);
  expect(document.querySelector('.lock-context-menu')).toBeNull();

  // Reopening starts with a clean footer — no stale menu.
  fireEvent.click(screen.getByTitle('Settings'));
  await tick();
  expect(document.querySelector('.lock-context-menu')).toBeNull();
});

test('a workspace switch starts from a clean panel (the draft is per workspace)', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  await tick();
  await openAddForm('+ Add Raster Layer');
  fireEvent.change(within(rasterForm()!).getByPlaceholderText('Layer name'), {
    target: { value: 'Half typed' },
  });

  // Create + switch to another workspace from the panel header: MapPage is
  // keyed by workspace, so the whole panel (draft included) is rebuilt.
  fireEvent.click(screen.getByRole('button', { name: /switch workspace/i }));
  fireEvent.click(screen.getByRole('button', { name: /new workspace/i }));
  fireEvent.change(screen.getByPlaceholderText('Workspace name'), { target: { value: 'Survey' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  await tick();

  fireEvent.click(screen.getByTitle('Settings'));
  await tick();
  expect(isHidden()).toBe(false);
  expect(screen.getByText('+ Add Raster Layer')).toBeInTheDocument();
  expect(rasterForm()).toBeNull();
});
