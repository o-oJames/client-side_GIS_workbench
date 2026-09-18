/**
 * useWindowStack — the z-order of the floating desktop-OS windows.
 *
 * Pure stacking bookkeeping (the click-to-front gesture itself is covered
 * end to end in MapPage.windowStack.test.tsx): what z-index each open window
 * gets, that a raised window overtakes its siblings, that a freshly opened
 * window lands on top, and that a closed window leaves the stack — so
 * reopening it later brings it back on top instead of its old position.
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { FLOATING_WINDOW_BASE_Z, useWindowStack, type FloatingWindowId } from './useWindowStack';

/** Render the hook with a mutable set of open-window ids. */
function setup(initial: FloatingWindowId[]) {
  let ids = [...initial];
  const view = renderHook(() => useWindowStack(ids));
  return {
    ...view,
    setIds(next: FloatingWindowId[]) {
      ids = [...next];
      view.rerender();
    },
    raise(id: FloatingWindowId) {
      act(() => view.result.current.bringToFront(id));
    },
    z(id: FloatingWindowId) {
      return view.result.current.zIndexFor(id);
    },
  };
}

describe('useWindowStack', () => {
  test('a lone window sits at the base z-index and is the top window', () => {
    const s = setup(['geoProcessing']);
    expect(s.z('geoProcessing')).toBe(FLOATING_WINDOW_BASE_Z);
    expect(s.result.current.topId).toBe('geoProcessing');
    expect(s.result.current.stack).toEqual(['geoProcessing']);
  });

  test('windows opened together stack in id order, one z-step apart', () => {
    const s = setup(['geoProcessing', 'elevationProfile']);
    expect(s.z('geoProcessing')).toBe(FLOATING_WINDOW_BASE_Z);
    expect(s.z('elevationProfile')).toBe(FLOATING_WINDOW_BASE_Z + 1);
    expect(s.result.current.topId).toBe('elevationProfile');
  });

  test('bringToFront raises a window above the one that was on top', () => {
    const s = setup(['geoProcessing', 'elevationProfile']);
    s.raise('geoProcessing');
    expect(s.z('elevationProfile')).toBe(FLOATING_WINDOW_BASE_Z);
    expect(s.z('geoProcessing')).toBe(FLOATING_WINDOW_BASE_Z + 1);
    expect(s.result.current.topId).toBe('geoProcessing');
  });

  test('raising the already-top window changes nothing', () => {
    const s = setup(['attrTable', 'geoProcessing']);
    s.raise('geoProcessing');
    expect(s.z('attrTable')).toBe(FLOATING_WINDOW_BASE_Z);
    expect(s.z('geoProcessing')).toBe(FLOATING_WINDOW_BASE_Z + 1);
  });

  test('three windows keep distinct z-indices through repeated raises', () => {
    const s = setup(['attrTable', 'elevationProfile', 'geoProcessing']);
    s.raise('attrTable');
    s.raise('elevationProfile');
    expect(s.result.current.stack).toEqual(['geoProcessing', 'attrTable', 'elevationProfile']);
    const zs = [s.z('attrTable'), s.z('elevationProfile'), s.z('geoProcessing')];
    expect(new Set(zs).size).toBe(3);
    expect(s.z('elevationProfile')).toBe(FLOATING_WINDOW_BASE_Z + 2);
  });

  test('an id that is not open falls back to the base z-index', () => {
    const s = setup(['geoProcessing']);
    expect(s.z('attrTable')).toBe(FLOATING_WINDOW_BASE_Z);
  });

  test('closing a window compacts the stack under the survivors', () => {
    const s = setup(['attrTable', 'elevationProfile', 'geoProcessing']);
    s.raise('attrTable'); // stack: ep, gp, attrTable (top)
    s.setIds(['attrTable', 'geoProcessing']); // elevation profile closed
    expect(s.result.current.stack).toEqual(['geoProcessing', 'attrTable']);
    expect(s.z('geoProcessing')).toBe(FLOATING_WINDOW_BASE_Z);
    expect(s.z('attrTable')).toBe(FLOATING_WINDOW_BASE_Z + 1);
  });

  test('a reopened window comes back on top, not in its old position', async () => {
    const s = setup(['attrTable', 'geoProcessing']);
    s.raise('attrTable'); // gp bottom, attrTable top
    s.setIds(['geoProcessing']); // attribute table closed
    // Let the prune effect run so the closed id leaves the raised-order state.
    await act(async () => {});
    s.setIds(['geoProcessing', 'attrTable']); // reopened
    expect(s.result.current.topId).toBe('attrTable');
    expect(s.z('attrTable')).toBe(FLOATING_WINDOW_BASE_Z + 1);
    expect(s.z('geoProcessing')).toBe(FLOATING_WINDOW_BASE_Z);
  });

  test('the first window ever opened starts at the base', () => {
    const s: ReturnType<typeof setup> = setup([]);
    expect(s.result.current.stack).toEqual([]);
    expect(s.result.current.topId).toBeNull();
    s.setIds(['elevationProfile']);
    expect(s.z('elevationProfile')).toBe(FLOATING_WINDOW_BASE_Z);
  });
});
