// Phase 42.1：Web 测试环境初始化
import '@testing-library/jest-dom/vitest';

/**
 * Node ≥22 自带实验性全局 localStorage/sessionStorage（未提供 --localstorage-file 时值为 undefined），
 * 且 `localStorage` 不在 vitest `populateGlobal` 的 KEYS 白名单内 → 在 Node ≥22 上
 * `k in global` 为真而被过滤，jsdom 的真实 Web Storage 不会被拷贝到 globalThis。
 * 此处安装内存版 Storage 兜底，保证 api.ts（token / user / traceId 会话存取）可测，
 * 行为与 Web Storage 一致（同源内存键值对，用例间经 beforeEach 清空）。
 */
class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(String(key)) ? this.map.get(String(key))! : null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(String(key));
  }
  setItem(key: string, value: string): void {
    this.map.set(String(key), String(value));
  }
}

function ensureStorage(g: typeof globalThis): void {
  const target = g as typeof globalThis & { localStorage?: Storage; sessionStorage?: Storage };
  if (typeof target.localStorage === 'undefined' || target.localStorage === null) {
    Object.defineProperty(g, 'localStorage', { value: new MemoryStorage(), configurable: true, writable: true });
  }
  if (typeof target.sessionStorage === 'undefined' || target.sessionStorage === null) {
    Object.defineProperty(g, 'sessionStorage', { value: new MemoryStorage(), configurable: true, writable: true });
  }
}
ensureStorage(globalThis);

// jsdom 不实现 matchMedia（响应式逻辑测试需要时使用）
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// 每个用例前清理 localStorage / 会话状态
beforeEach(() => {
  localStorage.clear();
});
