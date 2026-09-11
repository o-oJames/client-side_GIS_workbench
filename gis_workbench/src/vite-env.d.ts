/// <reference types="vite/client" />

// Browser API type declarations
interface DecompressionStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

declare var DecompressionStream: {
  prototype: DecompressionStream;
  new(format: string): DecompressionStream;
};
