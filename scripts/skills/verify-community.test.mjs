import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyCommunitySkills } from './verify-community.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ellmsha-skill-validator-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ui = path.join(root, 'aionui');
  const community = path.join(ui, 'resources/ellmsha-skills/community');
  const skill = path.join(community, 'sample');
  for (const dir of [skill, path.join(root, 'ponytail/skills'), path.join(root, 'bmad-method/ellmsha-skills')])
    mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: sample\ndescription: Test skill\n---\nRead references.\n');
  writeFileSync(path.join(skill, 'LICENSE'), 'MIT license fixture\n');
  mkdirSync(path.join(skill, 'references'));
  writeFileSync(path.join(skill, 'references/SKILL.md'), 'Reference example, not an installed nested skill.\n');
  const source = {
    directory: 'sample',
    name: 'sample',
    repository: 'https://github.com/example/sample',
    revision: 'a'.repeat(40),
    release: null,
    license: 'MIT',
  };
  const manifest = { schemaVersion: 1, skills: [source], skipped: [] };
  const upstream = {
    schemaVersion: 1,
    repository: source.repository,
    revision: 'main',
    commit: source.revision,
    sourcePath: '.',
    license: source.license,
    retrievedAt: '2026-10-16T00:00:00Z',
    runtime: { required: [], optional: [], network: [] },
    adaptations: [],
    excluded: [],
    files: ['SKILL.md', 'LICENSE', 'references/SKILL.md'].map((file) => ({
      path: file,
      upstreamPath: file,
      sha256: createHash('sha256')
        .update(readFileSync(path.join(skill, file)))
        .digest('hex'),
    })),
  };
  const save = () => {
    writeFileSync(path.join(community, 'SOURCES.json'), JSON.stringify(manifest));
    writeFileSync(path.join(skill, 'UPSTREAM.json'), JSON.stringify(upstream));
  };
  save();
  return { root, ui, community, skill, source, manifest, upstream, save };
}

test('accepts complete pinned packages and keeps nested SKILL references inside their parent', (t) => {
  const f = fixture(t);
  assert.equal(verifyCommunitySkills(f.ui).totalAvailableSkills, 1);
});

test('rejects undeclared package directories and duplicate names in another global pack', (t) => {
  const f = fixture(t);
  const extra = path.join(f.community, 'undeclared');
  mkdirSync(extra);
  assert.throws(() => verifyCommunitySkills(f.ui), /Community folders differ/);
  rmSync(extra, { recursive: true });
  const duplicate = path.join(f.root, 'ponytail/skills/other');
  mkdirSync(duplicate);
  writeFileSync(path.join(duplicate, 'SKILL.md'), readFileSync(path.join(f.skill, 'SKILL.md')));
  assert.throws(() => verifyCommunitySkills(f.ui), /Duplicate skill name sample/);
});

test('rejects mutable pins and provenance disagreement', (t) => {
  const f = fixture(t);
  f.source.revision = 'main';
  f.save();
  assert.throws(() => verifyCommunitySkills(f.ui), /40-hex revision/);
  f.source.revision = 'b'.repeat(40);
  f.save();
  assert.throws(() => verifyCommunitySkills(f.ui), /UPSTREAM pin/);
});

test('rejects changed or omitted content from the provenance file list', (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.skill, 'LICENSE'), 'Changed license\n');
  assert.throws(() => verifyCommunitySkills(f.ui), /Bundle hash mismatch/);
  writeFileSync(path.join(f.skill, 'LICENSE'), 'MIT license fixture\n');
  writeFileSync(path.join(f.skill, 'unlisted.md'), 'Untracked reference');
  assert.throws(() => verifyCommunitySkills(f.ui), /do not cover bundle/);
});

test('validates optional upstream content hashes without confusing them with adapted bundle hashes', (t) => {
  const f = fixture(t);
  f.upstream.files[0].upstreamSha256 = 'b'.repeat(64);
  f.upstream.files[0].upstreamBlobSha1 = 'c'.repeat(40);
  f.save();
  assert.equal(verifyCommunitySkills(f.ui).checked.length, 1);
  f.upstream.files[0].upstreamSha256 = 'invalid';
  f.save();
  assert.throws(() => verifyCommunitySkills(f.ui), /Invalid upstream SHA256/);
  f.upstream.files[0].upstreamSha256 = ['b'.repeat(64)];
  f.save();
  assert.throws(() => verifyCommunitySkills(f.ui), /Invalid upstream SHA256/);
});

test('rejects missing license and path traversal in provenance', (t) => {
  const f = fixture(t);
  rmSync(path.join(f.skill, 'LICENSE'));
  assert.throws(() => verifyCommunitySkills(f.ui), /Missing nonempty LICENSE/);
  writeFileSync(path.join(f.skill, 'LICENSE'), 'MIT license fixture\n');
  f.upstream.files[0].path = '../outside';
  f.save();
  assert.throws(() => verifyCommunitySkills(f.ui), /Unsafe UPSTREAM file path/);
});

test('rejects symlinks instead of following files outside the package', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  symlinkSync(path.join(f.root, 'outside'), path.join(f.skill, 'escape'));
  assert.throws(() => verifyCommunitySkills(f.ui), /Symlinks are not importable/);
});

test('enforces actual importer file and total size limits before reading large contents', (t) => {
  const f = fixture(t);
  const file = path.join(f.skill, 'large.bin');
  writeFileSync(file, '');
  truncateSync(file, 50 * 1024 * 1024 + 1);
  assert.throws(() => verifyCommunitySkills(f.ui), /50 MiB import limit/);
  rmSync(file);
  for (let i = 0; i < 5; i++) {
    const chunk = path.join(f.skill, `chunk-${i}.bin`);
    writeFileSync(chunk, '');
    truncateSync(chunk, 45 * 1024 * 1024);
  }
  assert.throws(() => verifyCommunitySkills(f.ui), /200 MiB import limit/);
});
