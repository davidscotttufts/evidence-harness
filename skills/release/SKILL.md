---
name: release
description: "Cut a release: SemVer from the commits since the last tag (a data/schema migration forces at least a minor, a breaking change a major), bump the version in lockstep across every manifest, tag the merge commit's sha, then verify each registry page and that the published artifact matches the local build. Stops for user approval before tagging or publishing. Use when cutting, tagging or publishing a version."
---

# Release

A release is the one step you can't take back: a published version is cached,
mirrored and installed within minutes. Check before; prove after.

## 1. Decide the version from the commits

`git log <last-tag>..origin/<base> --oneline` (fetch first; never the local branch).
Classify every commit, and state the count ("31 commits since v1.4.2"):

| Found | Bump at least |
|---|---|
| a breaking change to a public API, CLI, wire format or config | major |
| a data or schema migration, or a new feature | minor |
| fixes only | patch |

Before 1.0.0, a breaking change may be a minor; say so. A migration is never a patch.

## 2. Bump in lockstep

Find **every** file that carries the version: package manifests in every workspace,
lockfiles, plugin/pack manifests, `version` constants, docs install snippets.
Search for the old version string; don't rely on a list. After the bump, the same
search must find the old version only in the changelog (and unrelated dependency
entries).

Write the changelog entry from the commits, not from memory.

## 3. Tag the merged commit

The release PR merges first, through the project's own process. Then tag the
**merge commit's sha** on the base (`git tag -a vX.Y.Z <sha>`), never a branch tip or
your local HEAD: either can differ from what was reviewed and gated.

⛔ Show the user the version, the reasoning, the sha and the changelog entry, and
wait for an explicit yes before tagging, pushing the tag, or publishing.

## 4. Verify after publishing

"The workflow went green" is not evidence. For each registry or package page:

- the new version is visible to a fresh client (bypass caches);
- the integrity hash it reports matches the artifact you meant to publish;
- download the published artifact and compare its sha with a local build of the
  tagged commit. **If they differ, say so and stop.** Don't republish or yank
  without the user.

## 5. Record lessons

When anything went wrong, record it with the **command that would have detected
it** (for example `npm view <pkg>@<v> dist.integrity`), and add that command to
step 4 for next time.
