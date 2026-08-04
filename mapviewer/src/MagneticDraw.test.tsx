/**
 * Integration tests for the magnetic edge-snapping mode (classical livewire
 * edges, model-free) on the line/polygon draw tools.
 *
 * jsdom has no canvas 2D context, so the edge-capture step always fails
 * gracefully here — the tests assert the mode's wiring (right-click arming,
 * hint bar states, tool activation, disarm) rather than the pixel pipeline
 * itself (covered by utils/livewire.test.ts).
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';

const tick = async () => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

/** Size the map container so OL renders a frame (see MapPage.draw.test.tsx). */
function giveMapSize(w = 1024, h = 768) {
  const el = document.getElementById('map') as HTMLElement;
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: w });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: h });
  el.style.border = '0';
  el.style.padding = '0';
  const vp = document.querySelector('.ol-viewport') as HTMLElement | null;
  if (vp) {
    Object.defineProperty(vp, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width: w, height: h, left: 0, top: 0, right: w, bottom: h, x: 0, y: 0, toJSON: {} }),
    });
  }
}

const frame = async (ms = 80) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

beforeEach(() => {
  localStorage.clear();
});

test('right-clicking the line tool arms magnetic edges and shows the hint bar', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  const lineBtn = screen.getByTitle('Draw Line', { exact: false });
  // No magnetic UI before arming.
  expect(screen.queryByText('Magnetic edges')).not.toBeInTheDocument();

  // Right-click the tool button: arms the mode AND activates the tool.
  fireEvent.contextMenu(lineBtn);
  await tick();

  expect(screen.getByText('Magnetic edges')).toBeInTheDocument();
  // Arming activates the line tool (button becomes active).
  expect(lineBtn.className).toContain('active');
  // Armed badge rendered on the button.
  expect(document.querySelector('.draw-toolbar-snap-badge')).not.toBeNull();

  // Right-click again disarms the mode; hint bar disappears.
  fireEvent.contextMenu(lineBtn);
  await tick();
  expect(screen.queryByText('Magnetic edges')).not.toBeInTheDocument();
  expect(document.querySelector('.draw-toolbar-snap-badge')).toBeNull();
});

test('right-clicking the polygon tool arms magnetic edges for polygons', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  const polyBtn = screen.getByTitle('Draw Polygon', { exact: false });
  fireEvent.contextMenu(polyBtn);
  await tick();

  expect(screen.getByText('Magnetic edges')).toBeInTheDocument();
  expect(polyBtn.className).toContain('active');

  // Disarm.
  fireEvent.contextMenu(polyBtn);
  await tick();
  expect(screen.queryByText('Magnetic edges')).not.toBeInTheDocument();
});

test('line drawing still works normally while magnetic mode is armed', async () => {
  render(<MemoryRouter initialEntries={['/map']}><App /></MemoryRouter>);
  giveMapSize();
  await frame();

  // Arm magnetic mode (also activates the line tool). Edge capture itself
  // never completes in jsdom (no tile rendering) — drawing must still work.
  fireEvent.contextMenu(screen.getByTitle('Draw Line', { exact: false }));
  await tick();
  expect(screen.getByText('Magnetic edges')).toBeInTheDocument();

  // Plain clicks still place vertices; dblclick finishes the line.
  const viewport = document.querySelector('.ol-viewport') as HTMLElement;
  const ptr = (type: string, x: number, y: number, buttons = 1) => {
    const ev = new MouseEvent(type, {
      clientX: x, clientY: y, button: 0, buttons, bubbles: true, cancelable: true, view: window,
    });
    Object.defineProperty(ev, 'pointerId', { value: 1 });
    Object.defineProperty(ev, 'pointerType', { value: 'mouse' });
    Object.defineProperty(ev, 'isPrimary', { value: true });
    return ev;
  };
  const clickAt = (x: number, y: number) => {
    fireEvent(viewport, ptr('pointerdown', x, y));
    fireEvent(viewport, ptr('pointerup', x, y, 0));
  };

  clickAt(120, 120);
  await tick();
  clickAt(260, 180);
  await tick();
  clickAt(260, 180); // second pair within the dblclick window → finish
  await tick();

  expect(screen.getByText('Line 1')).toBeInTheDocument();
});
