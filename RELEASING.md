# Releasing

How versions and releases work for the public repository `orientpine/pingpong-vision`.

## Version numbers

[Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`, tags are `vMAJOR.MINOR.PATCH`.

- **0.1.0** is the first public snapshot of 2026-10-29 (commit `56bb9e8`). It has no tag and stays untagged. The history is never rewritten to add one.
- **v1.0.0** (2026-10-31) is the first tag. From here on every public sync that changes what a user gets gets a new tag.
- **PATCH** (1.0.**1**): fixes only. Nothing a user has to learn, no new setting.
- **MINOR** (1.**1**.0): new features or settings that keep working the old way by default.
- **MAJOR** (**2**.0.0): something a user has to change: a removed setting, a changed environment variable, a new required one, a data format that old clients cannot read.
- A sync that changes only docs, tests or QA scripts does not need a new tag. It can wait for the next release.

`package.json` has no `version` field on purpose. The tag and the CHANGELOG are the version.

## What goes public

Only code that runs in production. Work still on an open branch waits for its merge and its deploy.

## Release steps

Run these on the maintainer's machine. It holds the scan patterns and the private checkout.

1. **Export and scan.** Build the public tree from the deployed private commit. `export-public.sh` runs the leak scan and exits non-zero if any count is not 0.

   ```bash
   R=$(mktemp -d)
   bash scripts/export-public.sh <deployed commit> "$R/tree"
   ```

2. **Write the notes.** Add the new version to `CHANGELOG.md` and `CHANGELOG.ko.md` under a heading `## [x.y.z] - YYYY-MM-DD`. Write it in user words: what changed on screen and what to do differently. Leave out internal PR numbers and names. Move `[Unreleased]` items into it and update the compare links at the bottom.

3. **Commit on top of the public history.** Never force-push.

   ```bash
   git clone https://github.com/orientpine/pingpong-vision "$R/pub"
   rsync -a --delete --exclude .git "$R/tree/" "$R/pub/"
   cd "$R/pub" && git add -A && git status --short
   git commit -m "Release vX.Y.Z: <one line>"
   bash scripts/scan-public.sh . --git      # tree and full history, every count must be 0
   git push origin main
   ```

4. **Tag and publish.** The release body is that version's CHANGELOG section (English) plus a short Korean summary.

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file notes.md
   ```

   GitHub attaches the source zip and tarball by itself. No other assets are uploaded.

5. **Check from a fresh clone.** Clone, run the README quick start (`bun install`, `bash scripts/fetch-models.sh`, `bun server.js`), check `curl -i http://127.0.0.1:8791/healthz` is `200`, and run `scan-public.sh <clone> --git` again.

## Keeping secrets out

- Never commit camera recordings, frames of people other than public datasets, keys, host or account names, or internal addresses.
- The scan's private patterns live only in the maintainer's `~/.config/pingpong-vision/scan-patterns`. They are never committed, and the scanner reads its own file too.
- If something slips out, do not force-push. Make the repository private, tell the maintainer, and publish a clean new repository.
