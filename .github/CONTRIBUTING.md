# Contributing

Thanks for contributing.

Before opening a pull request:

1. Create or reference an issue for substantial changes.
2. Run `npm ci` and `npm test`.
3. Keep the change focused and update documentation when behavior changes.
4. Use a conventional pull request title, such as `fix: handle a stopped bridge`.

Pull requests must pass the repository checks before they can be merged.

## Releases

Releases are deliberate. Merging to `main` runs validation but does not publish
a version. To release, manually run the **CI** workflow against `main`; its
semantic-release job starts only after the quality and compatibility jobs pass.

The release job authenticates as a dedicated GitHub App installed only on this
repository. It reads `RELEASE_APP_CLIENT_ID` from repository variables and
`RELEASE_APP_PRIVATE_KEY` from Actions secrets, then creates a short-lived
installation token with repository contents write access. The App must have
always-allow bypass access to the protected `main` branch and `v*` tags.

Semantic-release derives the next version from Conventional Commit messages,
updates `package.json` and `package-lock.json`, creates a release commit and
`vX.Y.Z` tag, and publishes GitHub release notes. The package is private and is
never published to npm. Do not edit the package version manually.

- `fix:` creates a patch release.
- `feat:` creates a minor release.
- A breaking-change footer or `!` creates a major release.
- Documentation, test, and maintenance-only commits do not create a release.
