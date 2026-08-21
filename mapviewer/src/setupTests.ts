// jest-dom adds custom matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

// jsdom does not provide TextEncoder/TextDecoder, which the app-lock vault
// crypto (src/utils/appLock.ts) relies on.
import { TextEncoder, TextDecoder } from 'util';

if (typeof (global as any).TextEncoder === 'undefined') {
  (global as any).TextEncoder = TextEncoder;
}
if (typeof (global as any).TextDecoder === 'undefined') {
  (global as any).TextDecoder = TextDecoder;
}

// jsdom does not implement ResizeObserver, which OpenLayers' Map requires.
// Provide a stub whose observe() fires the callback asynchronously (like the
// browser's initial layout observation), so OL calls updateSize() once a test
// has given the map container a size. Tests that never size the container are
// unaffected (updateSize() then keeps the size undefined, as before).
if (typeof (window as any).ResizeObserver === 'undefined') {
  (window as any).ResizeObserver = class ResizeObserver {
    private cb: (entries: any[], observer: any) => void;
    constructor(cb: (entries: any[], observer: any) => void) {
      this.cb = cb;
    }
    observe(target: Element) {
      setTimeout(() => {
        this.cb([{ target, contentRect: target.getBoundingClientRect() }], this);
      }, 0);
    }
    unobserve() {}
    disconnect() {}
  };
}

// jsdom does not implement PointerEvent, but OpenLayers 9 listens for
// pointer events and clones them via `new PointerEvent(type, nativeEvent)`
// while tracking gestures. Provide a minimal MouseEvent-based polyfill so
// tests can synthesise pointer gestures on the map viewport.
if (typeof (window as any).PointerEvent === 'undefined') {
  (window as any).PointerEvent = class PointerEvent extends MouseEvent {
    constructor(type: string, params: any = {}) {
      super(type, params);
      (this as any).pointerId = params.pointerId !== undefined ? params.pointerId : 0;
      (this as any).pointerType = params.pointerType || '';
      (this as any).isPrimary = params.isPrimary !== undefined ? params.isPrimary : true;
      (this as any).width = params.width || 1;
      (this as any).height = params.height || 1;
      (this as any).pressure = params.pressure || 0;
      (this as any).tiltX = params.tiltX || 0;
      (this as any).tiltY = params.tiltY || 0;
      (this as any).twist = params.twist || 0;
    }
  };
}

// jsdom's HTMLCanvasElement.getContext('2d') returns null without the native
// `canvas` package. OpenLayers renders frames once the map has a size, so
// provide a Proxy-based no-op 2D context that satisfies the canvas API the
// renderer touches (state set/get, drawing no-ops, measureText, gradients).
function createMockContext2D(canvas: HTMLCanvasElement): any {
  const state: Record<string, any> = {
    canvas,
    globalAlpha: 1,
    lineWidth: 1,
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    fillStyle: '#000',
    strokeStyle: '#000',
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true,
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    shadowBlur: 0,
    shadowColor: 'rgba(0, 0, 0, 0)',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    lineDashOffset: 0,
  };
  return new Proxy(state, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === 'measureText') {
        return () => ({
          width: 0,
          actualBoundingBoxLeft: 0,
          actualBoundingBoxRight: 0,
          actualBoundingBoxAscent: 0,
          actualBoundingBoxDescent: 0,
        });
      }
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
        return () => ({ addColorStop() {} });
      }
      if (prop === 'createPattern') return () => null;
      if (prop === 'getImageData' || prop === 'createImageData') {
        return (...args: number[]) => {
          const w = Math.max(1, args[0] || 1);
          const h = Math.max(1, args[1] || 1);
          return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
        };
      }
      return () => undefined;
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    },
  });
}

const originalGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (
  this: HTMLCanvasElement,
  contextId: string,
  ...args: any[]
) {
  if (contextId === '2d') {
    const self = this as any;
    if (!self.__mockContext2D) self.__mockContext2D = createMockContext2D(this);
    return self.__mockContext2D;
  }
  return originalGetContext.call(this, contextId as any, ...(args as [any]));
} as any;

// jsdom only provides requestAnimationFrame when pretendToBeVisual is on;
// OpenLayers' animation loop needs it either way.
if (typeof (window as any).requestAnimationFrame !== 'function') {
  (window as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 16) as unknown as number;
  (window as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
}

// jsdom does not provide crypto.randomUUID(), crypto.getRandomValues(), or
// crypto.subtle, which postgisConnector and appLock use. Provide simple implementations.
if (typeof (global as any).crypto === 'undefined') {
  (global as any).crypto = {};
}
if (typeof (global as any).crypto.randomUUID === 'undefined') {
  (global as any).crypto.randomUUID = () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  };
}
if (typeof (global as any).crypto.getRandomValues === 'undefined') {
  (global as any).crypto.getRandomValues = (array: any) => {
    for (let i = 0; i < array.length; i++) {
      array[i] = Math.floor(Math.random() * 256);
    }
    return array;
  };
}
if (typeof (global as any).crypto.subtle === 'undefined') {
  (global as any).crypto.subtle = {
    importKey: async () => ({ type: 'secret', extractable: true }),
    encrypt: async () => new ArrayBuffer(0),
    decrypt: async () => new ArrayBuffer(0),
    deriveKey: async () => ({ type: 'secret', extractable: true }),
    deriveBits: async () => new ArrayBuffer(0),
    digest: async (algo: string, data: ArrayBuffer) => data,
    exportKey: async () => new ArrayBuffer(0),
  };
}

// OpenLayers 10 uses CanvasPattern, CanvasGradient, and createImageBitmap, which jsdom doesn't provide.
if (typeof (global as any).CanvasPattern === 'undefined') {
  (global as any).CanvasPattern = class CanvasPattern {};
}

if (typeof (global as any).CanvasGradient === 'undefined') {
  (global as any).CanvasGradient = class CanvasGradient {
    addColorStop() {}
  };
}

if (typeof (global as any).createImageBitmap === 'undefined') {
  (global as any).createImageBitmap = async (image: any) => image;
}

// OpenLayers 10 uses document.fonts.ready and document.fonts.forEach, which jsdom doesn't provide.
if (typeof (document as any).fonts === 'undefined') {
  (document as any).fonts = {
    ready: Promise.resolve(),
    check: () => true,
    load: () => Promise.resolve([]),
    forEach: (cb: any) => {},
  };
}
