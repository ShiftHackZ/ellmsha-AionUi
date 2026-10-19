# Bundled community skills

`resources/ellmsha-skills/community/SOURCES.json` lists the upstream revisions
selected for the eLLMsha community skill pack. Each skill retains its license,
working references and scripts, plus an `UPSTREAM.json` containing source
provenance, final file hashes, prerequisites and local adaptations. Upstream
directory layouts are preserved so script imports and relative references keep
working. No upstream installers or global hooks run when this pack is imported.

## Delivery

The existing Desktop, Web CLI and Docker packaging paths copy
`resources/ellmsha-skills`. AionCore imports the pack into its app-owned builtin
skills on startup. Skill names enter the shared catalog; full instructions are
loaded when used. Existing running agents may retain their previous catalog.
Deploy through the usual safe application update, preserving the normal profile.

Ponytail remains a separate pack from the parent repository's `ponytail/skills`.
Its upstream revision is also shown in the application's About provenance. Do
not add a second copy under `community`.

## Included capabilities and prerequisites

| Skill          | Included                                               | Additional runtime when needed                                          |
| -------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| Humanizer      | Writing guidance                                       | None                                                                    |
| Hallmark       | Design guidance, references and theme tokens           | Existing file/browser tools                                             |
| REA            | Official reverse-engineering skill and references      | `rea-agents@6.5.0` MCP; analysis-specific tools                         |
| Impeccable     | Design guidance, references and native-engine launcher | Existing engine, or authorized setup with `IMPECCABLE_ALLOW_DOWNLOAD=1` |
| UI UX Pro Max  | Design data and search scripts                         | Python 3                                                                |
| Last30days     | Research workflow and source collectors                | Python 3.12+; optional source credentials/CLIs                          |
| Scrapling      | Official scraping skill and references                 | Python 3.10+, Scrapling; browser extras for browser fetchers            |
| Diagram Design | Templates, references and export helpers               | Python 3; Playwright/Chromium only for PNG export                       |

Onyx/Taste was excluded at the user's request. Bundling an instruction package
does not install its optional runtime or imply that an unavailable tool can run.
The skill integration notes require actual tool discovery, explicit dependency
errors, canonical eLLMsha memory for durable knowledge, and authorized browser
authentication access. Generated design/research deliverables remain normal
task artifacts.

## Updating and checking

1. Select an upstream stable release, or record an exact commit when no release
   exists. Inspect its license and executable scripts before running anything.
2. Replace the selected skill tree, retaining licenses and required notices.
   Reapply only documented path, tool, memory and runtime adaptations.
3. Update the per-skill file hashes and the aggregate source record. Keep source
   revision identity separate from hashes of adapted files. Keep the matching
   `packages/desktop/src/common/branding/release.json` About entries in sync;
   skill entries describe the bundled assets, not installation of optional engines.
4. Run `bun run skills:verify`,
   `node --test scripts/skills/*.test.mjs`, and
   `python3 -B scripts/skills/last30days-guards.test.py`.
5. Exercise changed helper scripts offline where possible and verify the real
   Core importer using an isolated data directory. Never use a production
   profile as an import fixture.

These checks establish asset integrity and catalog delivery. They do not replace
live acceptance of optional external runtimes or a signed application build.
