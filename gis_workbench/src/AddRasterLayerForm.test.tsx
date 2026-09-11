// ---------------------------------------------------------------------------
// AddRasterLayerForm.test.tsx — the add-raster-layer form only collapses once
// the layer is really on the map. A rejected add (CORS-blocked COG, bad URL,
// unreadable service) must keep the form open with every input preserved and
// explain the failure right above the Add/Cancel buttons, so a typo never
// costs the user the whole form.
// ---------------------------------------------------------------------------

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddRasterLayerForm } from './components/AddRasterLayerForm';
import type { RasterLayer } from './types';

// Mock CustomSelect to avoid its portal menu in jsdom (same approach as
// PostgisLayer.test.tsx).
vi.mock('./components/CustomSelect', () => ({
  CustomSelect: ({ options, value, onChange }: any) => (
    <select data-testid="custom-select" value={value} onChange={(e) => onChange(e.target.value)}>
      {options
        .filter((opt: any) => !opt.disabled)
        .map((opt: any) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
    </select>
  ),
}));

const COG_URL_PLACEHOLDER = 'https://example.com/data/cog.tif';

function renderForm(over: Record<string, any> = {}) {
  const props = {
    knownSources: [] as any[],
    existingRasterLayers: [] as any[],
    onAddRasterLayer: vi.fn(async (_layer: RasterLayer) => {}),
    onClose: vi.fn(),
    ...over,
  };
  const utils = render(<AddRasterLayerForm {...(props as any)} />);
  fireEvent.click(screen.getByText('+ Add Raster Layer'));
  return { ...utils, props };
}

const addForm = (container: HTMLElement) =>
  container.querySelector('.settings-add-form') as HTMLElement | null;

const errorBox = (container: HTMLElement) =>
  container.querySelector('.settings-add-form-error') as HTMLElement | null;

/** Switch the layer type and return the form's inputs. */
function selectType(container: HTMLElement, type: string) {
  fireEvent.change(screen.getByTestId('custom-select'), { target: { value: type } });
  return addForm(container)!;
}

const cogUrlInput = (container: HTMLElement) =>
  addForm(container)!.querySelector(`input[placeholder="${COG_URL_PLACEHOLDER}"]`) as HTMLInputElement;

const addButton = (container: HTMLElement) =>
  Array.from(addForm(container)!.querySelectorAll('button')).find(b => b.textContent === 'Add') as HTMLButtonElement;

describe('AddRasterLayerForm — failed adds keep the form editable', () => {
  test('a rejected COG add keeps the form open, the URL typed, and shows the error above the buttons', async () => {
    const onAddRasterLayer = vi.fn(async (_layer: RasterLayer) => {
      throw new Error('Could not load the GeoTIFF — the bucket is blocking cross-origin requests (CORS).');
    });
    const onClose = vi.fn();
    const { container } = renderForm({ onAddRasterLayer, onClose });

    selectType(container, 'cog');
    fireEvent.change(cogUrlInput(container), { target: { value: 'https://bucket.s3.amazonaws.com/auckland.tif' } });
    fireEvent.click(addButton(container));

    const box = await waitFor(() => {
      const b = errorBox(container);
      expect(b).toBeTruthy();
      return b!;
    });

    // The failure is explained inline…
    expect(box.textContent).toContain('blocking cross-origin requests (CORS)');
    // …the form is still open for editing…
    expect(addForm(container)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    // …and the user does not have to retype anything.
    expect(cogUrlInput(container).value).toBe('https://bucket.s3.amazonaws.com/auckland.tif');
    // The error sits above the Add/Cancel row.
    expect(box.nextElementSibling?.className).toContain('settings-form-buttons');
  });

  test('the layer config handed to the map is a COG config', async () => {
    const onAddRasterLayer = vi.fn(async (_layer: RasterLayer) => { throw new Error('nope'); });
    const { container } = renderForm({ onAddRasterLayer });

    selectType(container, 'cog');
    fireEvent.change(cogUrlInput(container), { target: { value: 'https://example.com/cog.tif' } });
    fireEvent.change(addForm(container)!.querySelector('input[placeholder="Layer name"]') as HTMLInputElement, {
      target: { value: 'Auckland 2025' },
    });
    fireEvent.click(addButton(container));

    await waitFor(() => expect(onAddRasterLayer).toHaveBeenCalledTimes(1));
    expect(onAddRasterLayer.mock.calls[0][0]).toMatchObject({
      name: 'Auckland 2025',
      type: 'cog',
      url: 'https://example.com/cog.tif',
      cogSource: 'http',
    });
  });

  test('a successful add still collapses the form and clears the inputs', async () => {
    const onAddRasterLayer = vi.fn(async (_layer: RasterLayer) => {});
    const onClose = vi.fn();
    const { container } = renderForm({ onAddRasterLayer, onClose });

    selectType(container, 'cog');
    fireEvent.change(cogUrlInput(container), { target: { value: 'https://example.com/cog.tif' } });
    fireEvent.click(addButton(container));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(addForm(container)).toBeNull();
    expect(errorBox(container)).toBeNull();
    expect(screen.getByText('+ Add Raster Layer')).toBeTruthy();
  });

  test('fixing the input and retrying clears the error and closes the form', async () => {
    let attempt = 0;
    const onAddRasterLayer = vi.fn(async (_layer: RasterLayer) => {
      attempt += 1;
      if (attempt === 1) throw new Error('Request failed');
    });
    const onClose = vi.fn();
    const { container } = renderForm({ onAddRasterLayer, onClose });

    selectType(container, 'cog');
    const input = cogUrlInput(container);
    fireEvent.change(input, { target: { value: 'https://bucket.s3.amazonaws.com/typo.tif' } });
    fireEvent.click(addButton(container));
    await waitFor(() => expect(errorBox(container)).toBeTruthy());

    // The user corrects the typo in place — no retyping of the whole form.
    fireEvent.change(cogUrlInput(container), { target: { value: 'https://bucket.s3.amazonaws.com/right.tif' } });
    fireEvent.click(addButton(container));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(errorBox(container)).toBeNull();
    expect(onAddRasterLayer).toHaveBeenCalledTimes(2);
    expect(onAddRasterLayer.mock.calls[1]![0].url).toBe('https://bucket.s3.amazonaws.com/right.tif');
  });

  test('a missing COG URL is reported above the buttons without touching the map', async () => {
    const onAddRasterLayer = vi.fn(async (_layer: RasterLayer) => {});
    const { container } = renderForm({ onAddRasterLayer });

    selectType(container, 'cog');
    fireEvent.click(addButton(container));

    await waitFor(() => expect(errorBox(container)?.textContent).toContain('Enter the GeoTIFF (COG) URL.'));
    expect(onAddRasterLayer).not.toHaveBeenCalled();
    expect(addForm(container)).toBeTruthy();
  });

  test('a missing XYZ URL is reported above the buttons without touching the map', async () => {
    const onAddRasterLayer = vi.fn(async (_layer: RasterLayer) => {});
    const { container } = renderForm({ onAddRasterLayer });

    fireEvent.click(addButton(container));

    await waitFor(() => expect(errorBox(container)?.textContent).toContain('Enter the XYZ tile URL.'));
    expect(onAddRasterLayer).not.toHaveBeenCalled();
  });

  test('switching layer type clears the previous error', async () => {
    const onAddRasterLayer = vi.fn(async (_layer: RasterLayer) => {});
    const { container } = renderForm({ onAddRasterLayer });

    fireEvent.click(addButton(container));
    await waitFor(() => expect(errorBox(container)).toBeTruthy());

    selectType(container, 'wms');
    expect(errorBox(container)).toBeNull();
  });

  test('Cancel discards the error and collapses the form', async () => {
    const onAddRasterLayer = vi.fn(async (_layer: RasterLayer) => { throw new Error('boom'); });
    const onClose = vi.fn();
    const { container } = renderForm({ onAddRasterLayer, onClose });

    selectType(container, 'cog');
    fireEvent.change(cogUrlInput(container), { target: { value: 'https://example.com/cog.tif' } });
    fireEvent.click(addButton(container));
    await waitFor(() => expect(errorBox(container)).toBeTruthy());

    const cancel = Array.from(addForm(container)!.querySelectorAll('button'))
      .find(b => b.textContent === 'Cancel') as HTMLButtonElement;
    fireEvent.click(cancel);

    expect(addForm(container)).toBeNull();
    expect(errorBox(container)).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
