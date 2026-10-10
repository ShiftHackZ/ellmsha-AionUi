import atlas from '@renderer/assets/logos/brand/cheremsha-spritesheet.webp';
import { CheremshaSpritePlayer } from './cheremshaSprite';

const pet = document.getElementById('pet');

if (pet) {
  pet.style.backgroundImage = `url(${atlas})`;

  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const player = new CheremshaSpritePlayer(pet, motionPreference);

  window.petAPI.onStateChange((state: string) => {
    player.setState(state);
  });

  window.addEventListener('unload', () => {
    player.dispose();
  });
}
