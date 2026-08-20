// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

describe('jsdom environment probe', () => {
  it('深挖 localStorage 缺失原因', () => {
    // eslint-disable-next-line no-console
    console.log('href =', window.location.href);
    // eslint-disable-next-line no-console
    console.log('descriptor =', Object.getOwnPropertyDescriptor(window, 'localStorage'));
    // eslint-disable-next-line no-console
    console.log('globalThis.localStorage =', globalThis.localStorage);
    try {
      // eslint-disable-next-line no-console
      console.log('window.localStorage via try =', (window as { localStorage?: unknown }).localStorage);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log('getter threw:', (e as Error).message);
    }
    expect(true).toBe(true);
  });
});
