import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WandCleanupEditor } from './WandCleanupEditor';
import * as snapStore from '../utils/snapOriginalStore';

// The stash lives in IndexedDB — mock the store so the editor sees a known
// original without a browser database.
jest.mock('../utils/snapOriginalStore', () => ({
  loadSnapOriginal: jest.fn(),
}));

/** Jaggy 10×10 square outline (zigzag amplitude 0.2 on every edge). */
function jaggySquare(): number[][] {
  const ring: number[][] = [];
  const steps = 20;
  const size = 10;
  const jitter = (i: number) => (i % 2 === 0 ? 0 : 0.2);
  for (let i = 0; i <= steps; i++) ring.push([(i / steps) * size, jitter(i)]);
  for (let i = 1; i <= steps; i++) ring.push([size - jitter(i), (i / steps) * size]);
  for (let i = 1; i <= steps; i++) ring.push([size - (i / steps) * size, size - jitter(i)]);
  for (let i = 1; i < steps; i++) ring.push([jitter(i), size - (i / steps) * size]);
  return ring;
}

const loadMock = snapStore.loadSnapOriginal as jest.Mock;

beforeEach(() => {
  loadMock.mockReset();
});

describe('WandCleanupEditor', () => {
  it('renders nothing when no original is stashed', async () => {
    loadMock.mockResolvedValue(null);
    const { container } = render(
      <WandCleanupEditor featureId="f1" workspaceId="ws" onLiveUpdate={jest.fn()} onCommit={jest.fn()} />,
    );
    // Once the (mocked) stash lookup resolves with nothing, the section
    // disappears entirely.
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it('live-updates the map while the slider moves and commits on release', async () => {
    loadMock.mockResolvedValue({ rings: [jaggySquare()], meterPerPx: 1 });
    const onLiveUpdate = jest.fn();
    const onCommit = jest.fn();
    render(
      <WandCleanupEditor featureId="f1" workspaceId="ws" onLiveUpdate={onLiveUpdate} onCommit={onCommit} />,
    );

    const slider = (await screen.findByLabelText('Strength')) as HTMLInputElement;
    expect(slider.value).toBe('4'); // default strength
    // As-traced count is shown (80 unique vertices for the jaggy square).
    expect(screen.getByText(/80 →/)).toBeInTheDocument();

    fireEvent.change(slider, { target: { value: '6' } });
    expect(onLiveUpdate).toHaveBeenCalledTimes(1);
    const [featureId, rings] = onLiveUpdate.mock.calls[0];
    expect(featureId).toBe('f1');
    expect(rings.length).toBe(1);
    // Strength 6 > zigzag amplitude 0.2 → most staircase vertices removed.
    expect(rings[0].length).toBeLessThan(80);
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.pointerUp(slider);
    expect(onCommit).toHaveBeenCalledWith('f1');
  });

  it('restores the exact as-traced shape at minimum strength', async () => {
    const originalRings = [jaggySquare()];
    loadMock.mockResolvedValue({ rings: originalRings, meterPerPx: 1 });
    const onLiveUpdate = jest.fn();
    const onCommit = jest.fn();
    render(
      <WandCleanupEditor featureId="f2" workspaceId="ws" onLiveUpdate={onLiveUpdate} onCommit={onCommit} />,
    );

    const restore = await screen.findByRole('button', { name: 'Restore as-traced shape' });
    fireEvent.click(restore);
    expect(onLiveUpdate).toHaveBeenCalledWith('f2', originalRings);
    expect(onCommit).toHaveBeenCalledWith('f2');
  });
});
