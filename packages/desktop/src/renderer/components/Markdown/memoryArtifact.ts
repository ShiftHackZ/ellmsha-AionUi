/** Typed virtual memory links never resolve to a local filesystem path. */
export function resolveMemoryArtifactPath(href: string): string | undefined {
  try {
    const url = new URL(href);
    if (
      url.protocol !== 'ellmsha-memory:' ||
      url.hostname !== 'artifact' ||
      url.pathname ||
      url.hash ||
      url.username ||
      url.password ||
      url.port
    )
      return undefined;
    if (url.searchParams.size !== 1 || !url.searchParams.has('path')) return undefined;
    const path = url.searchParams.get('path')!;
    if (
      !/^bmad\/[^/]+\/.+\.md$/.test(path) ||
      path.includes('\\') ||
      [...path].some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f) ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      return undefined;
    return path;
  } catch {
    return undefined;
  }
}
