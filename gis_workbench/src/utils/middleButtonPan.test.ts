import { attachMiddleButtonPan, MIDDLE_PAN_CLASS } from './middleButtonPan';
import type { MiddleButtonPanMap } from './middleButtonPan';

// Fake map: the viewport sits at the document origin (client coords ==
// pixels), 1 px = RES map units, and the view centre maps to CENTER_PX.
const RES = 10;
const CENTER_PX: [number, number] = [400, 300];

function makeFakeMap() {
  const viewport = document.createElement('div');
  const canvas = document.createElement('canvas');
  viewport.appendChild(canvas);
  document.body.appendChild(viewport);
  let center: [number, number] = [0, 0];
  const map: MiddleButtonPanMap = {
    getViewport: () => viewport,
    getView: () => ({
      getCenter: () => center,
      setCenter: (c: number[]) => {
        center = [c[0], c[1]];
      },
    }),
    getEventPixel: (e) => [e.clientX, e.clientY],
    getCoordinateFromPixel: (pixel) => [
      center[0] + (pixel[0] - CENTER_PX[0]) * RES,
      center[1] - (pixel[1] - CENTER_PX[1]) * RES,
    ],
  };
  return { map, viewport, canvas, center: () => center as [number, number] };
}

// jsdom has no PointerEvent constructor — a MouseEvent with the pointer
// type bolted on exercises the same code paths.
function fire(target: EventTarget, type: string, init: MouseEventInit = {}, pointerType = 'mouse') {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('attachMiddleButtonPan', () => {
  it('pans the map while the middle button is dragged (content follows the pointer)', () => {
    const { map, viewport, canvas, center } = makeFakeMap();
    const handle = attachMiddleButtonPan(map);

    fire(canvas, 'pointerdown', { button: 1, clientX: 430, clientY: 280 });
    expect(viewport.classList.contains(MIDDLE_PAN_CLASS)).toBe(true);

    // +30 px right, +20 px down → centre shifts 300 units west, 200 north.
    fire(canvas, 'pointermove', { button: -1, buttons: 4, clientX: 460, clientY: 300 });
    expect(center()).toEqual([-300, 200]);

    // A second step keeps panning incrementally (another 40 px down moves
    // the centre a further 400 units north).
    fire(canvas, 'pointermove', { button: -1, buttons: 4, clientX: 460, clientY: 340 });
    expect(center()).toEqual([-300, 600]);

    fire(canvas, 'pointerup', { button: 1, buttons: 0, clientX: 460, clientY: 340 });
    expect(viewport.classList.contains(MIDDLE_PAN_CLASS)).toBe(false);

    // After release, moves no longer pan.
    fire(canvas, 'pointermove', { button: -1, buttons: 0, clientX: 500, clientY: 340 });
    expect(center()).toEqual([-300, 600]);

    handle.detach();
  });

  it('suppresses the default action of the middle press (browser autoscroll)', () => {
    const { map, canvas } = makeFakeMap();
    const handle = attachMiddleButtonPan(map);
    const down = fire(canvas, 'pointerdown', { button: 1, clientX: 400, clientY: 300 });
    expect(down.defaultPrevented).toBe(true);
    handle.detach();
  });

  it('ignores primary-button presses (left drag stays with the map interactions)', () => {
    const { map, viewport, canvas, center } = makeFakeMap();
    const handle = attachMiddleButtonPan(map);

    fire(canvas, 'pointerdown', { button: 0, clientX: 430, clientY: 280 });
    expect(viewport.classList.contains(MIDDLE_PAN_CLASS)).toBe(false);
    fire(canvas, 'pointermove', { button: -1, buttons: 1, clientX: 460, clientY: 300 });
    expect(center()).toEqual([0, 0]);

    handle.detach();
  });

  it('ignores presses that land on overlays inside the viewport', () => {
    const { map, viewport, center } = makeFakeMap();
    const overlay = document.createElement('div');
    viewport.appendChild(overlay);
    const handle = attachMiddleButtonPan(map);

    fire(overlay, 'pointerdown', { button: 1, clientX: 430, clientY: 280 });
    fire(overlay, 'pointermove', { button: -1, buttons: 4, clientX: 460, clientY: 300 });
    expect(center()).toEqual([0, 0]);
    expect(viewport.classList.contains(MIDDLE_PAN_CLASS)).toBe(false);

    handle.detach();
  });

  it('ignores touch pointers', () => {
    const { map, canvas, center } = makeFakeMap();
    const handle = attachMiddleButtonPan(map);

    fire(canvas, 'pointerdown', { button: 1, clientX: 430, clientY: 280 }, 'touch');
    fire(canvas, 'pointermove', { button: -1, buttons: 4, clientX: 460, clientY: 300 }, 'touch');
    expect(center()).toEqual([0, 0]);

    handle.detach();
  });

  it('does not end the pan when another button is released mid-drag', () => {
    const { map, canvas, center } = makeFakeMap();
    const handle = attachMiddleButtonPan(map);

    fire(canvas, 'pointerdown', { button: 1, clientX: 400, clientY: 300 });
    fire(canvas, 'pointerup', { button: 0, buttons: 4, clientX: 400, clientY: 300 });
    fire(canvas, 'pointermove', { button: -1, buttons: 4, clientX: 420, clientY: 300 });
    expect(center()).toEqual([-200, 0]);

    fire(canvas, 'pointerup', { button: 1, buttons: 0, clientX: 420, clientY: 300 });
    fire(canvas, 'pointermove', { button: -1, buttons: 0, clientX: 500, clientY: 300 });
    expect(center()).toEqual([-200, 0]);

    handle.detach();
  });

  it('ends the pan if the middle button is no longer held (missed pointerup)', () => {
    const { map, viewport, canvas, center } = makeFakeMap();
    const handle = attachMiddleButtonPan(map);

    fire(canvas, 'pointerdown', { button: 1, clientX: 400, clientY: 300 });
    fire(canvas, 'pointermove', { button: -1, buttons: 0, clientX: 420, clientY: 300 });
    expect(viewport.classList.contains(MIDDLE_PAN_CLASS)).toBe(false);
    expect(center()).toEqual([0, 0]);

    handle.detach();
  });

  it('detach() removes all listeners and clears the pan class', () => {
    const { map, viewport, canvas, center } = makeFakeMap();
    const handle = attachMiddleButtonPan(map);

    fire(canvas, 'pointerdown', { button: 1, clientX: 400, clientY: 300 });
    handle.detach();
    expect(viewport.classList.contains(MIDDLE_PAN_CLASS)).toBe(false);

    fire(canvas, 'pointermove', { button: -1, buttons: 4, clientX: 460, clientY: 300 });
    expect(center()).toEqual([0, 0]);

    // A fresh press after detach does nothing either.
    fire(canvas, 'pointerdown', { button: 1, clientX: 400, clientY: 300 });
    expect(viewport.classList.contains(MIDDLE_PAN_CLASS)).toBe(false);
  });
});
