import React, { useEffect, useState } from 'react';
import atlas from '@renderer/assets/logos/brand/cheremsha-spritesheet.webp';

const idleDurations = [280, 110, 110, 140, 140, 320];

export default function CheremshaMark() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let current = 0;
    let timer: number;
    const advance = () => {
      timer = window.setTimeout(() => {
        current = (current + 1) % idleDurations.length;
        setFrame(current);
        advance();
      }, idleDurations[current]);
    };
    advance();
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <span
      className='block w-full h-full rounded-8px bg-white overflow-hidden'
      aria-hidden='true'
      style={{
        backgroundImage: `url(${atlas})`,
        backgroundSize: '800% 1100%',
        backgroundPosition: `${(frame * 100) / 7}% 0%`,
        backgroundRepeat: 'no-repeat',
      }}
    />
  );
}
