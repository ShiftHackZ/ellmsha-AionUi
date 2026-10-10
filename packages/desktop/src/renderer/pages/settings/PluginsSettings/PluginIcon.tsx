import clockifyLogo from '@/renderer/assets/plugin-logos/clockify.svg';
import linearLogo from '@/renderer/assets/plugin-logos/linear.svg';
import { Avatar } from '@arco-design/web-react';
import { CodeBrackets, Computer, Phone, Puzzle, User } from '@icon-park/react';
import React from 'react';

type PluginIconProps = {
  name: string;
  size?: number;
  account?: boolean;
};

const iconClass = (name: string): string => {
  const normalized = name.toLowerCase();
  if (normalized.includes('mobile')) return 'text-success';
  if (normalized.includes('computer-use')) return 'text-info';
  if (normalized.includes('plugin-dev') || normalized.includes('author')) return 'text-warning';
  return 'text-t-secondary';
};

const brandLogo = (name: string): { backgroundColor: string; src: string; scale: number } | undefined => {
  switch (name.toLowerCase()) {
    case 'clockify':
      return { backgroundColor: '#03a9f4', src: clockifyLogo, scale: 1 };
    case 'linear':
      return { backgroundColor: '#222326', src: linearLogo, scale: 0.62 };
    default:
      return undefined;
  }
};

const PluginGlyph: React.FC<{ name: string; size: number }> = ({ name, size }) => {
  const normalized = name.toLowerCase();
  if (normalized.includes('mobile')) return <Phone theme='outline' size={size} />;
  if (normalized.includes('computer-use')) return <Computer theme='outline' size={size} />;
  if (normalized.includes('plugin-dev') || normalized.includes('author')) {
    return <CodeBrackets theme='outline' size={size} />;
  }
  return <Puzzle theme='outline' size={size} />;
};

const PluginIcon: React.FC<PluginIconProps> = ({ name, size = 32, account = false }) => {
  const brand = account ? undefined : brandLogo(name);

  return (
    <Avatar
      data-testid={`${account ? 'plugin-account-icon' : 'plugin-icon'}-${name}`}
      size={size}
      shape='square'
      className={brand ? undefined : iconClass(name)}
      style={{
        flexShrink: 0,
        backgroundColor: brand?.backgroundColor ?? 'var(--color-fill-2)',
      }}
    >
      {account ? (
        <User theme='outline' size={Math.round(size * 0.55)} />
      ) : brand ? (
        <img
          aria-hidden='true'
          data-testid={`plugin-brand-logo-${name.toLowerCase()}`}
          src={brand.src}
          alt=''
          style={{ display: 'block', width: `${brand.scale * 100}%`, height: `${brand.scale * 100}%`, margin: 'auto' }}
        />
      ) : (
        <PluginGlyph name={name} size={Math.round(size * 0.55)} />
      )}
    </Avatar>
  );
};

export default PluginIcon;
