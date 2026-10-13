import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PreviewTabs from '@/renderer/pages/conversation/Preview/components/PreviewPanel/PreviewTabs';
import styles from '@/renderer/components/base/SelectedTab.module.css';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
describe('right sidebar selected tab', () => {
  it.each(['light', 'dark'])('keeps a distinct selected marker in %s, after hover and keyboard selection', (theme) => {
    document.documentElement.dataset.theme = theme;
    const onSwitchTab = vi.fn();
    const ref = React.createRef<HTMLDivElement>();
    const props = {
      tabs: [
        { id: 'a', title: 'Alpha' },
        { id: 'b', title: 'Beta' },
      ],
      activeTabId: 'a',
      tabFadeState: { left: false, right: false },
      tabsContainerRef: ref,
      onSwitchTab,
      onCloseTab: vi.fn(),
      onContextMenu: vi.fn(),
    };
    const { rerender, unmount } = render(<PreviewTabs {...props} />);
    const alpha = screen.getByRole('tab', { name: 'Alpha' });
    const beta = screen.getByRole('tab', { name: 'Beta' });
    expect(alpha).toHaveAttribute('aria-selected', 'true');
    expect(alpha).toHaveClass(styles.tab);
    fireEvent.mouseOver(beta);
    expect(alpha).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(alpha, { key: 'ArrowRight' });
    expect(onSwitchTab).toHaveBeenCalledWith('b');
    expect(document.activeElement).toBe(beta);
    rerender(<PreviewTabs {...props} activeTabId='b' />);
    expect(beta).toHaveAttribute('aria-selected', 'true');
    expect(alpha).toHaveAttribute('aria-selected', 'false');
    unmount();
  });
});
