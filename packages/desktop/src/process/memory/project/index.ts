import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, realpath, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

export const projectContextSchema = z.object({
  project_id: z.string().nullable(),
  name: z.string(),
  workspace: z.string().min(1),
  roots: z.array(z.string().min(1)).min(1).max(64),
});
export type ProjectContext = z.infer<typeof projectContextSchema>;
export type Repository = { name: string; path: string };
const git = promisify(execFile);
const omitted = new Set([
  'node_modules',
  'vendor',
  'build',
  'dist',
  'out',
  'target',
  'coverage',
  'tmp',
  'output',
  'worktrees',
  'qa-artifacts',
]);

/** Discover repositories in a product folder; stop at each Git root (its index includes submodules).
 * ponytail: bounded discovery (3 levels, 2000 directories). Attach deeper repositories explicitly.
 */
export async function discoverRepositories(context: ProjectContext) {
  const repositories: Repository[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  const seen = new Set<string>();
  let visited = 0;
  const walk = async (directory: string, depth: number, label: string): Promise<void> => {
    if (++visited > 2000)
      throw new Error('Repository discovery exceeded 2000 directories; attach repositories directly');
    const marker = await lstat(path.join(directory, '.git')).catch((): null => null);
    if (marker && !marker.isSymbolicLink()) {
      const { stdout } = await git('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { timeout: 5000 });
      if ((await realpath(stdout.trim())) !== directory)
        throw new Error('Git root differs from the selected directory');
      if (!repositories.some((repo) => directory.startsWith(repo.path + path.sep))) {
        repositories.push({ name: label, path: directory });
      }
      return;
    }
    if (depth === 3) return;
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || omitted.has(entry.name)) continue;
      await walk(path.join(directory, entry.name), depth + 1, `${label}/${entry.name}`);
    }
  };
  for (const root of context.roots) {
    try {
      const canonical = await realpath(root);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      await walk(canonical, 0, path.basename(canonical));
    } catch (error) {
      errors.push({ path: root, error: error instanceof Error ? error.message : String(error) });
    }
  }
  // Attached subdirectories can overlap discovered roots, regardless of entry order.
  return {
    repositories: repositories.filter(
      (r) => !repositories.some((p) => p.path !== r.path && r.path.startsWith(p.path + path.sep))
    ),
    errors,
  };
}

/** Resolve registered roots with a conversation-bound capability, never model-supplied paths. */
export async function resolveProjectContext(): Promise<ProjectContext> {
  const origin = process.env.AIONUI_GENERATION_CONTEXT_URL;
  const token = process.env.AIONUI_GENERATION_TOKEN;
  const conversation = process.env.AIONUI_CONVERSATION_ID;
  if (!origin || !token || !conversation)
    throw new Error('Project context requires an application chat. Restart the chat.');
  const response = await fetch(new URL('/api/memory/project/context', origin), {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ conversation_id: conversation }),
  });
  if (!response.ok) throw new Error(`Project context unavailable (HTTP ${response.status})`);
  const envelope = await response.json();
  if (!envelope.success) throw new Error('Project context unavailable');
  return projectContextSchema.parse(envelope.data);
}

/** Native desktop: grant snapshot access only after explicit project indexing.
 * Each project has its own atomic file so concurrent projects cannot overwrite each other.
 */
export async function allowNativeProject(directory: string, context: ProjectContext): Promise<void> {
  const roots = await Promise.all(context.roots.map((root) => realpath(root)));
  const key = createHash('sha256')
    .update(context.project_id || context.workspace)
    .digest('hex');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${key}.json`);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(roots), { mode: 0o600 });
  await rename(temporary, target);
}
