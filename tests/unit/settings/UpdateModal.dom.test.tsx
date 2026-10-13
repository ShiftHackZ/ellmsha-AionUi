import React from 'react';
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
vi.mock('@/renderer/components/settings/UpdateNotificationCard', () => ({
  default: () => <div>shared installer card</div>,
}));
import UpdateModal from '@/renderer/components/settings/UpdateModal';
it('uses the shared full-installer notification entry point', () => {
  render(<UpdateModal />);
  expect(screen.getByText('shared installer card')).toBeInTheDocument();
});
