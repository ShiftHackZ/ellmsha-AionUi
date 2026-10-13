import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PreviewContextMenu from '@/renderer/pages/conversation/Preview/components/PreviewPanel/PreviewContextMenu';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const props = {
  contextMenu: { show: true, tabId: 'second', x: 610, y: 60 },
  tabs: [
    { id: 'first', title: 'First' },
    { id: 'second', title: 'Second' },
  ],
  currentTheme: 'light' as const,
  onClose: vi.fn(),
  onCloseLeft: vi.fn(),
  onCloseRight: vi.fn(),
  onCloseOthers: vi.fn(),
  onCloseAll: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('innerWidth', 1200);
  vi.stubGlobal('innerHeight', 800);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    width: 180,
    height: 160,
    right: 180,
    bottom: 160,
    toJSON: () => ({}),
  });
});
describe('preview context menu viewport positioning', () => {
  it('escapes the transformed preview containing block while preserving client coordinates and actions', () => {
    const view = render(
      <div style={{ transform: 'translateX(0)', overflow: 'hidden', marginLeft: 400 }}>
        <PreviewContextMenu {...props} />
      </div>
    );
    const menu = document.body.querySelector<HTMLElement>('[data-native-browser-overlay]')!;
    expect(menu.parentElement).toBe(document.body);
    expect(view.container.contains(menu)).toBe(false);
    expect(menu.style.left).toBe('610px');
    expect(menu.style.top).toBe('60px');
    fireEvent.click(view.getByText('preview.closeLeft'));
    expect(props.onCloseLeft).toHaveBeenCalledWith('second');
    fireEvent.mouseDown(document.body);
    expect(props.onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.body.querySelector('[data-native-browser-overlay]')).toBeNull();
  });

  it('keeps the measured menu inside the viewport at its right and bottom edges, including resize', () => {
    const view = render(
      <PreviewContextMenu {...props} currentTheme='dark' contextMenu={{ ...props.contextMenu, x: 1190, y: 790 }} />
    );
    const menu = document.body.querySelector<HTMLElement>('[data-native-browser-overlay]')!;
    expect(menu.style.left).toBe('1012px');
    expect(menu.style.top).toBe('632px');
    vi.stubGlobal('innerWidth', 900);
    vi.stubGlobal('innerHeight', 600);
    fireEvent(window, new Event('resize'));
    expect(menu.style.left).toBe('712px');
    expect(menu.style.top).toBe('432px');
    view.unmount();
  });
});
