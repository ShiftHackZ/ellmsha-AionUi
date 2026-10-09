import release from './release.json';

/** The harness release is independent of its pinned upstream components. */
export const harnessRelease = release;
export const harnessVersion = `v${release.version} Patch ${release.patch}`;
export const showUpstreamPromotions = false;
