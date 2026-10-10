const ATLAS_COLUMNS = 8;
const ATLAS_ROWS = 11;

const AION_PET_STATES = [
  'idle',
  'thinking',
  'working',
  'done',
  'happy',
  'error',
  'dragging',
  'attention',
  'poke-left',
  'poke-right',
  'notification',
  'random-look',
  'random-read',
  'yawning',
  'dozing',
  'sleeping',
  'waking',
  'sweeping',
  'juggling',
  'building',
  'carrying',
] as const;

export type AionPetState = (typeof AION_PET_STATES)[number];

type SpriteAnimation = {
  row: number;
  frames: readonly number[];
  durations: readonly number[];
  loop: boolean;
  reducedMotionFrame: number;
};

type SpriteAnimationName =
  | 'idle'
  | 'moveRight'
  | 'moveLeft'
  | 'greeting'
  | 'waiting'
  | 'error'
  | 'completion'
  | 'thinking'
  | 'happy'
  | 'fallingAsleep'
  | 'sleeping'
  | 'waking';

const range = (length: number): readonly number[] => Array.from({ length }, (_, index) => index);

const SPRITE_ANIMATIONS: Record<SpriteAnimationName, SpriteAnimation> = {
  idle: {
    row: 0,
    frames: range(7),
    durations: [280, 110, 110, 140, 140, 320, 280],
    loop: true,
    reducedMotionFrame: 0,
  },
  moveRight: { row: 1, frames: range(8), durations: [110], loop: true, reducedMotionFrame: 3 },
  moveLeft: { row: 2, frames: range(8), durations: [110], loop: true, reducedMotionFrame: 3 },
  greeting: { row: 3, frames: range(4), durations: [180], loop: true, reducedMotionFrame: 2 },
  waiting: { row: 4, frames: range(5), durations: [220], loop: true, reducedMotionFrame: 4 },
  error: { row: 5, frames: range(8), durations: [140], loop: true, reducedMotionFrame: 4 },
  completion: { row: 6, frames: range(6), durations: [160], loop: true, reducedMotionFrame: 3 },
  thinking: { row: 7, frames: range(6), durations: [190], loop: true, reducedMotionFrame: 2 },
  happy: { row: 8, frames: range(6), durations: [170], loop: true, reducedMotionFrame: 3 },
  fallingAsleep: { row: 9, frames: range(8), durations: [240], loop: false, reducedMotionFrame: 7 },
  sleeping: { row: 9, frames: [7], durations: [240], loop: false, reducedMotionFrame: 7 },
  waking: { row: 10, frames: range(8), durations: [170], loop: false, reducedMotionFrame: 7 },
};

/**
 * Every Aion pet state is mapped explicitly. States without a dedicated
 * Cheremsha atlas row use the closest readable motion as their fallback.
 */
export const PET_STATE_ANIMATION: Record<AionPetState, SpriteAnimationName> = {
  idle: 'idle',
  thinking: 'thinking',
  working: 'moveRight',
  done: 'completion',
  happy: 'happy',
  error: 'error',
  dragging: 'waiting',
  attention: 'greeting',
  'poke-left': 'moveLeft',
  'poke-right': 'moveRight',
  notification: 'greeting',
  'random-look': 'idle',
  'random-read': 'thinking',
  yawning: 'fallingAsleep',
  dozing: 'sleeping',
  sleeping: 'sleeping',
  waking: 'waking',
  sweeping: 'moveLeft',
  juggling: 'completion',
  building: 'thinking',
  carrying: 'moveRight',
};

type MotionPreference = Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;

export function resolvePetAnimation(state: string): SpriteAnimationName {
  return PET_STATE_ANIMATION[state as AionPetState] ?? 'idle';
}

export function getAtlasPosition(row: number, column: number): string {
  const x = (column * 100) / (ATLAS_COLUMNS - 1);
  const y = (row * 100) / (ATLAS_ROWS - 1);
  return `${x}% ${y}%`;
}

export class CheremshaSpritePlayer {
  private animation = SPRITE_ANIMATIONS.idle;
  private frameIndex = 0;
  private timer: number | null = null;

  private readonly onMotionPreferenceChange = (): void => {
    this.restart();
  };

  constructor(
    private readonly element: HTMLElement,
    private readonly motionPreference: MotionPreference
  ) {
    this.motionPreference.addEventListener('change', this.onMotionPreferenceChange);
    this.restart();
  }

  setState(state: string): void {
    this.animation = SPRITE_ANIMATIONS[resolvePetAnimation(state)];
    this.restart();
  }

  dispose(): void {
    this.clearTimer();
    this.motionPreference.removeEventListener('change', this.onMotionPreferenceChange);
  }

  private restart(): void {
    this.clearTimer();
    this.frameIndex = 0;
    this.renderFrame();
    if (!this.motionPreference.matches && this.animation.frames.length > 1) {
      this.scheduleNextFrame();
    }
  }

  private scheduleNextFrame(): void {
    const duration = this.animation.durations[this.frameIndex] ?? this.animation.durations[0] ?? 160;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      const nextIndex = this.frameIndex + 1;

      if (nextIndex < this.animation.frames.length) {
        this.frameIndex = nextIndex;
      } else if (this.animation.loop) {
        this.frameIndex = 0;
      } else {
        return;
      }

      this.renderFrame();
      this.scheduleNextFrame();
    }, duration);
  }

  private renderFrame(): void {
    const column = this.motionPreference.matches
      ? this.animation.reducedMotionFrame
      : (this.animation.frames[this.frameIndex] ?? 0);
    this.element.style.backgroundPosition = getAtlasPosition(this.animation.row, column);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
