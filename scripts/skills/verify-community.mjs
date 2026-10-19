#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_SKILL_BYTES = 200 * 1024 * 1024;
const defaultUiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function inspectTree(directory, root = directory, files = []) {
  let bytes = 0;
  for (const name of readdirSync(directory).sort()) {
    const file = path.join(directory, name);
    const stat = lstatSync(file);
    assert(!stat.isSymbolicLink(), `Symlinks are not importable: ${file}`);
    if (stat.isDirectory()) bytes += inspectTree(file, root, files).bytes;
    else {
      assert(stat.isFile(), `Unsupported file type: ${file}`);
      assert(stat.size <= MAX_FILE_BYTES, `File exceeds 50 MiB import limit: ${file}`);
      bytes += stat.size;
      files.push(path.relative(root, file).split(path.sep).join('/'));
    }
    assert(bytes <= MAX_SKILL_BYTES, `Skill exceeds 200 MiB import limit: ${directory}`);
  }
  return { bytes, files };
}

function skillName(directory) {
  const content = readFileSync(path.join(directory, 'SKILL.md'), 'utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  assert(frontmatter, `Missing skill frontmatter: ${directory}`);
  const names = [...frontmatter.matchAll(/^name:[ \t]*(.*)$/gm)];
  assert(names.length === 1, `Expected one frontmatter name: ${directory}`);
  let name = names[0][1].trim();
  if (name.startsWith('"')) name = JSON.parse(name);
  else if (name.startsWith("'")) {
    assert(name.endsWith("'"), `Unterminated skill name: ${directory}`);
    name = name.slice(1, -1).replaceAll("''", "'");
  } else name = name.replace(/[ \t]+#.*$/, '').trim();
  assert(
    typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) && !name.includes('..'),
    `Unsupported or unsafe skill name: ${directory}`
  );
  assert(/^description:[ \t]*\S/m.test(frontmatter), `Missing skill description: ${directory}`);
  return name;
}

// Match Core discovery: a SKILL.md owns its full tree, including nested references.
function discoverSkills(directory, result = []) {
  assert(
    lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(),
    `Invalid skill root: ${directory}`
  );
  if (existsSync(path.join(directory, 'SKILL.md'))) {
    result.push({ directory, name: skillName(directory), ...inspectTree(directory) });
    return result;
  }
  for (const name of readdirSync(directory).sort()) {
    const file = path.join(directory, name);
    const stat = lstatSync(file);
    assert(!stat.isSymbolicLink(), `Symlinks are not importable: ${file}`);
    if (stat.isDirectory()) discoverSkills(file, result);
  }
  return result;
}

function verifyUpstream(directory, declaration, actualFiles) {
  const metadata = JSON.parse(readFileSync(path.join(directory, 'UPSTREAM.json'), 'utf8'));
  assert(metadata.schemaVersion === 1, `Invalid UPSTREAM.json schema: ${directory}`);
  assert(
    metadata.commit === declaration.revision &&
      metadata.repository === declaration.repository &&
      metadata.license === declaration.license,
    `UPSTREAM pin/repository/license differs from SOURCES.json: ${directory}`
  );
  for (const field of ['revision', 'sourcePath', 'retrievedAt']) {
    assert(typeof metadata[field] === 'string' && metadata[field].trim(), `Missing UPSTREAM ${field}: ${directory}`);
  }
  assert(Number.isFinite(Date.parse(metadata.retrievedAt)), `Invalid retrieval date: ${directory}`);
  for (const [field, value] of Object.entries({
    adaptations: metadata.adaptations,
    excluded: metadata.excluded,
    required: metadata.runtime?.required,
    optional: metadata.runtime?.optional,
    network: metadata.runtime?.network,
  })) {
    assert(
      Array.isArray(value) && value.every((item) => typeof item === 'string'),
      `Invalid UPSTREAM ${field}: ${directory}`
    );
  }
  assert(Array.isArray(metadata.files) && metadata.files.length > 0, `Missing UPSTREAM files: ${directory}`);
  const declaredFiles = new Set();
  for (const file of metadata.files) {
    assert(
      typeof file.path === 'string' &&
        file.path &&
        !path.posix.isAbsolute(file.path) &&
        !file.path.includes('\\') &&
        file.path.split('/').every((part) => part && part !== '.' && part !== '..') &&
        file.path !== 'UPSTREAM.json',
      `Unsafe UPSTREAM file path: ${directory}`
    );
    assert(!declaredFiles.has(file.path), `Duplicate UPSTREAM file: ${file.path}`);
    declaredFiles.add(file.path);
    assert(typeof file.upstreamPath === 'string' && file.upstreamPath.trim(), `Missing upstreamPath: ${file.path}`);
    assert(
      file.upstreamBlobSha1 === undefined ||
        (typeof file.upstreamBlobSha1 === 'string' && /^[a-f0-9]{40}$/i.test(file.upstreamBlobSha1)),
      `Invalid upstream blob ID: ${file.path}`
    );
    assert(
      file.upstreamSha256 === undefined ||
        (typeof file.upstreamSha256 === 'string' && /^[a-f0-9]{64}$/i.test(file.upstreamSha256)),
      `Invalid upstream SHA256: ${file.path}`
    );
    assert(typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(file.sha256), `Invalid SHA256: ${file.path}`);
    assert(actualFiles.includes(file.path), `UPSTREAM file is missing: ${file.path}`);
    const digest = createHash('sha256')
      .update(readFileSync(path.join(directory, file.path)))
      .digest('hex');
    assert(digest === file.sha256, `Bundle hash mismatch: ${directory}/${file.path}`);
  }
  assert.deepEqual(
    [...declaredFiles].sort(),
    actualFiles.filter((file) => file !== 'UPSTREAM.json').sort(),
    `UPSTREAM files do not cover bundle: ${directory}`
  );
}

/** Validate pinned community packages and the three packs Core imports at startup. */
export function verifyCommunitySkills(uiRoot = defaultUiRoot) {
  const skillsRoot = path.join(uiRoot, 'resources', 'ellmsha-skills');
  const community = path.join(skillsRoot, 'community');
  const allSkills = [
    skillsRoot,
    path.resolve(uiRoot, '../ponytail/skills'),
    path.resolve(uiRoot, '../bmad-method/ellmsha-skills'),
  ].flatMap((directory) => discoverSkills(directory));
  const names = new Map();
  for (const skill of allSkills) {
    assert(
      !names.has(skill.name),
      `Duplicate skill name ${skill.name}: ${names.get(skill.name)} and ${skill.directory}`
    );
    names.set(skill.name, skill.directory);
  }

  const manifest = JSON.parse(readFileSync(path.join(community, 'SOURCES.json'), 'utf8'));
  assert(
    manifest.schemaVersion === 1 && Array.isArray(manifest.skills) && Array.isArray(manifest.skipped),
    'Invalid community SOURCES.json schema'
  );
  assert(manifest.skills.length > 0, 'Community manifest must declare at least one skill');
  const declared = new Set();
  const checked = [];
  for (const skill of manifest.skills) {
    assert(
      typeof skill.directory === 'string' &&
        /^[a-z0-9][a-z0-9._-]*$/.test(skill.directory) &&
        !skill.directory.includes('..'),
      'Manifest directory must be one safe folder name'
    );
    assert(!declared.has(skill.directory), `Duplicate manifest directory: ${skill.directory}`);
    declared.add(skill.directory);
    assert(
      typeof skill.revision === 'string' && /^[a-f0-9]{40}$/i.test(skill.revision),
      `Expected pinned 40-hex revision: ${skill.directory}`
    );
    assert(typeof skill.repository === 'string' && skill.repository.trim(), `Missing repository: ${skill.directory}`);
    assert(typeof skill.license === 'string' && skill.license.trim(), `Missing license identifier: ${skill.directory}`);
    const directory = path.join(community, skill.directory);
    const actual = allSkills.find((item) => item.directory === directory);
    assert(
      actual && actual.name === skill.name,
      `Declared skill directory/name does not match SKILL.md: ${skill.directory}`
    );
    assert(
      readdirSync(directory).some(
        (file) =>
          /^licen[cs]e(?:[.-].+)?$/i.test(file) &&
          lstatSync(path.join(directory, file)).isFile() &&
          lstatSync(path.join(directory, file)).size > 0
      ),
      `Missing nonempty LICENSE file: ${skill.directory}`
    );
    verifyUpstream(directory, skill, actual.files);
    checked.push({ directory: skill.directory, name: actual.name, revision: skill.revision, bytes: actual.bytes });
  }
  const actualDirectories = readdirSync(community).filter((name) =>
    lstatSync(path.join(community, name)).isDirectory()
  );
  assert.deepEqual(actualDirectories.sort(), [...declared].sort(), 'Community folders differ from declared packages');
  return { schemaVersion: 1, checked, totalAvailableSkills: allSkills.length, skipped: manifest.skipped.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(verifyCommunitySkills(), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
