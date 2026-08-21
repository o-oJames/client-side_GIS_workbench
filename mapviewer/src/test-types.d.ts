// Re-export Vitest mock types as globals for test files
import type { Mock as ViMock, MockedFunction as ViMockedFunction } from 'vitest';

declare global {
  type Mock<T = any> = ViMock<T>;
  type MockedFunction<T extends (...args: any[]) => any = (...args: any[]) => any> = ViMockedFunction<T>;
}
