import type { ThemeAppearance } from '@/common/theme/types';

export type MemoryThemePalette = {
  background: string;
  surface: string;
  surfaceMuted: string;
  hover: string;
  active: string;
  text: string;
  textSecondary: string;
  textDisabled: string;
  border: string;
  borderSubtle: string;
  brand: string;
  brandHover: string;
  brandActive: string;
  brandSubtle: string;
  success: string;
  warning: string;
  error: string;
};

export type MemoryThemePayload = {
  appearance: ThemeAppearance;
  palette: MemoryThemePalette;
};

const PALETTE_SOURCES: Record<keyof MemoryThemePalette, string[]> = {
  background: ['--bg-base'],
  surface: ['--bg-1', '--bg-base'],
  surfaceMuted: ['--bg-2', '--bg-1'],
  hover: ['--bg-hover', '--bg-2'],
  active: ['--bg-active', '--bg-3'],
  text: ['--text-primary'],
  textSecondary: ['--text-secondary'],
  textDisabled: ['--text-disabled', '--bg-6'],
  border: ['--border-base', '--bg-3'],
  borderSubtle: ['--border-light', '--bg-2'],
  brand: ['--primary', '--brand'],
  brandHover: ['--color-primary-light-1', '--brand-hover', '--primary'],
  brandActive: ['--color-primary-dark-1', '--primary'],
  brandSubtle: ['--brand-light', '--bg-2'],
  success: ['--success'],
  warning: ['--warning'],
  error: ['--danger'],
};

type CssVariableReader = Pick<CSSStyleDeclaration, 'getPropertyValue'>;

function readFirst(styles: CssVariableReader, names: string[]): string {
  for (const name of names) {
    const value = styles.getPropertyValue(name).trim();
    if (value) return value;
  }
  return '';
}

export function createMemoryThemePayload(
  appearance: ThemeAppearance,
  styles: CssVariableReader = getComputedStyle(document.documentElement)
): MemoryThemePayload {
  return {
    appearance,
    palette: Object.fromEntries(
      Object.entries(PALETTE_SOURCES).map(([key, names]) => [key, readFirst(styles, names)])
    ) as MemoryThemePalette,
  };
}
