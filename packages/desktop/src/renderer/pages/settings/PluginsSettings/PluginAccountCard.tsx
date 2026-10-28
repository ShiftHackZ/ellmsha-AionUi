import React from 'react';
import PluginIcon from './PluginIcon';

type PluginAccountCardProps = React.PropsWithChildren<{
  provider: string;
  title: string;
  status: React.ReactNode;
  subtitle?: string;
  error?: string;
  actions: React.ReactNode;
}>;

const PluginAccountCard: React.FC<PluginAccountCardProps> = ({
  provider,
  title,
  status,
  subtitle,
  error,
  actions,
  children,
}) => (
  <div className='border border-border-2 bg-base rd-12px px-14px py-10px flex flex-col gap-12px'>
    <div className='flex items-start justify-between gap-12px flex-wrap'>
      <div className='flex min-w-0 items-start gap-12px'>
        <PluginIcon name={provider} account />
        <div className='min-w-0'>
          <div className='flex items-center gap-8px flex-wrap'>
            <span className='text-14px font-600 text-t-primary'>{title}</span>
            {status}
          </div>
          {subtitle && <div className='text-13px text-t-secondary mt-6px break-words'>{subtitle}</div>}
          {error && <div className='text-12px text-status-error mt-6px break-words'>{error}</div>}
        </div>
      </div>
      <div className='flex gap-8px shrink-0 flex-wrap'>{actions}</div>
    </div>
    {children}
  </div>
);
export default PluginAccountCard;
