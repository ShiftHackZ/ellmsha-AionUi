import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CheremshaSpritePlayer,
  PET_STATE_ANIMATION,
  getAtlasPosition,
  resolvePetAnimation,
} from '@renderer/pet/cheremshaSprite';
import { PET_STATES } from '@/process/pet/petTypes';

type MotionPreferenceStub = Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'> & {
  setMatches: (matches: boolean) => void;
};

function createMotionPreference(initialMatches = false): MotionPreferenceStub {
  let matches = initialMatches;
  const listeners = new Set<() => void>();

  return {
    get matches() {
      return matches;
    },
    addEventListener: (_type, listener) => listeners.add(listener as () => void),
    removeEventListener: (_type, listener) => listeners.delete(listener as () => void),
    setMatches(nextMatches) {
      matches = nextMatches;
      listeners.forEach((listener) => listener());
    },
  };
}

describe('Cheremsha sprite state mapping', () => {
  it('maps every Aion state explicitly', () => {
    expect(Object.keys(PET_STATE_ANIMATION).toSorted()).toEqual(PET_STATES.toSorted());
  });

  it('uses idle for an unknown future state', () => {
    expect(resolvePetAnimation('future-state')).toBe('idle');
  });

  it('addresses the first and last atlas cells without drifting', () => {
    expect(getAtlasPosition(0, 0)).toBe('0% 0%');
    expect(getAtlasPosition(10, 7)).toBe('100% 100%');
  });
});

describe('Cheremsha sprite animation', () => {
  let element: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    element = document.createElement('div');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('advances the selected state from its first frame', () => {
    const player = new CheremshaSpritePlayer(element, createMotionPreference());

    player.setState('working');
    expect(element.style.backgroundPosition).toBe('0% 10%');

    vi.advanceTimersByTime(110);
    expect(element.style.backgroundPosition).toBe(`${100 / 7}% 10%`);
    player.dispose();
  });

  it('keeps a representative static frame and creates no timer when motion is reduced', () => {
    const player = new CheremshaSpritePlayer(element, createMotionPreference(true));

    player.setState('error');
    vi.advanceTimersByTime(10_000);

    expect(element.style.backgroundPosition).toBe(`${(4 * 100) / 7}% 50%`);
    expect(vi.getTimerCount()).toBe(0);
    player.dispose();
  });

  it('stops immediately when reduced motion is enabled at runtime', () => {
    const motionPreference = createMotionPreference();
    const player = new CheremshaSpritePlayer(element, motionPreference);
    player.setState('done');
    vi.advanceTimersByTime(160);
    expect(element.style.backgroundPosition).not.toBe('0% 60%');

    motionPreference.setMatches(true);

    expect(element.style.backgroundPosition).toBe(`${(3 * 100) / 7}% 60%`);
    expect(vi.getTimerCount()).toBe(0);
    player.dispose();
  });

  it('resumes from frame zero when reduced motion is disabled', () => {
    const motionPreference = createMotionPreference(true);
    const player = new CheremshaSpritePlayer(element, motionPreference);
    player.setState('happy');

    motionPreference.setMatches(false);
    vi.advanceTimersByTime(170);

    expect(element.style.backgroundPosition).toBe(`${100 / 7}% 80%`);
    player.dispose();
  });

  it('holds the final frame of a non-looping state', () => {
    const player = new CheremshaSpritePlayer(element, createMotionPreference());
    player.setState('yawning');

    vi.advanceTimersByTime(240 * 8);

    expect(element.style.backgroundPosition).toBe('100% 90%');
    expect(vi.getTimerCount()).toBe(0);
    player.dispose();
  });

  it('keeps the sleeping pose across dozing and sleeping state changes', () => {
    const player = new CheremshaSpritePlayer(element, createMotionPreference());

    player.setState('dozing');
    expect(element.style.backgroundPosition).toBe('100% 90%');

    player.setState('sleeping');
    expect(element.style.backgroundPosition).toBe('100% 90%');
    expect(vi.getTimerCount()).toBe(0);
    player.dispose();
  });
});
