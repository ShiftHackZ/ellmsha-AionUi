import { describe, expect, it } from 'vitest';
import { createMemoryThemePayload } from '@renderer/pages/settings/MemorySettings/memoryTheme';

const styles = (values: Record<string, string>) => ({
  getPropertyValue: (name: string) => values[name] ?? '',
});

describe('createMemoryThemePayload', () => {
  it('copies the active semantic palette for an embedded MemoryPanel', () => {
    const payload = createMemoryThemePayload(
      'dark',
      styles({
        '--bg-base': '#07090c',
        '--bg-1': '#0d1116',
        '--bg-2': '#151b22',
        '--bg-hover': '#1a2028',
        '--bg-active': '#202832',
        '--text-primary': '#f2f6f8',
        '--text-secondary': '#aebbc3',
        '--text-disabled': '#7f929f',
        '--border-base': '#293640',
        '--border-light': '#1e2730',
        '--primary': '#c5ff5a',
        '--color-primary-light-1': '#d5ff88',
        '--color-primary-dark-1': '#a7db40',
        '--brand-light': '#22301b',
        '--success': '#23c343',
        '--warning': '#ff9a2e',
        '--danger': '#f76560',
      })
    );

    expect(payload.appearance).toBe('dark');
    expect(payload.palette.background).toBe('#07090c');
    expect(payload.palette.brand).toBe('#c5ff5a');
    expect(payload.palette.error).toBe('#f76560');
  });

  it('falls back through semantic aliases when a custom theme omits optional shades', () => {
    const payload = createMemoryThemePayload(
      'light',
      styles({
        '--bg-base': '#fff',
        '--bg-1': '#fafafa',
        '--bg-2': '#f0f0f0',
        '--bg-3': '#ddd',
        '--bg-6': '#888',
        '--text-primary': '#111',
        '--text-secondary': '#555',
        '--primary': '#7257d3',
        '--success': '#27864a',
        '--warning': '#a86400',
        '--danger': '#c33',
      })
    );

    expect(payload.palette.hover).toBe('#f0f0f0');
    expect(payload.palette.brandHover).toBe('#7257d3');
    expect(payload.palette.border).toBe('#ddd');
  });
});
