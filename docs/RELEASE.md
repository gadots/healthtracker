# Desktop Release

## How a release is produced

Releases are cut from a git tag. `.github/workflows/release.yml` reacts to any tag matching
`v*` and, on a `macos-latest` runner:

1. Fails immediately if the tag does not match `version` in `package.json`.
2. Runs `npm ci` and `npm run check` — no artifact is published unless typecheck, the Electron
   syntax check, the test suite, and the renderer build all pass.
3. Runs `npm run dist -- --mac --arm64 --x64`, producing `OpenFit-<version>-arm64.dmg` and
   `OpenFit-<version>-x64.dmg` in `release/`.
4. Verifies the arm64 bundle carries a signature. electron-builder ad-hoc signs arm64 bundles
   when no Developer ID identity is available; an arm64 app with *no* signature is refused
   outright by macOS, so an unsigned bundle fails the release rather than shipping.
5. Publishes SHA-256 checksums next to the disk images.
6. Creates the GitHub Release with both disk images, `SHA256SUMS.txt`, and install notes.

To cut a release:

```bash
# bump "version" in package.json, commit it, then:
git tag v1.1.0
git push origin v1.1.0
```

The workflow does the rest. Nothing is built locally and nothing is committed to the repo:
`release/` is gitignored.

## What these builds are and are not

They are **unsigned and un-notarized**. That is a deliberate choice for personal use, not an
oversight: signing requires an Apple Developer Program membership and credentials owned by the
distributor, which cannot live in this repository.

The practical consequence is one extra step on first launch — right-click the app, choose
**Open**, confirm — after which macOS remembers the decision. Because the builds are not
signed, `hardenedRuntime` is set to `false` in `package.json`: the hardened runtime is only a
prerequisite for notarization, and enabling it without the matching entitlements would risk
blocking the external `claude` / `codex` CLIs the assistant panel spawns.

There is **no auto-update mechanism**. Updating means downloading the newer disk image and
dragging it over the installed app. User data is unaffected: credentials, the encrypted health
cache, and assistant settings live in `~/Library/Application Support/pulseboard-fitbit-desktop/`,
outside the app bundle.

## Pending: public distribution

None of the following is required for personal use. They are the prerequisites for
distributing OpenFit to people who should not have to bypass Gatekeeper.

1. Join the Apple Developer Program and store a Developer ID Application certificate and its
   password as repository secrets.
2. Set `CSC_LINK` / `CSC_KEY_PASSWORD` on the release job and re-enable `hardenedRuntime`,
   adding an entitlements plist that permits the assistant's child processes.
3. Configure notarization with App Store Connect credentials stored as secrets.
4. Verify signature, hardened runtime, notarization, and Gatekeeper behaviour on the final DMG.

## Other platforms

The electron-builder configuration still describes Windows (NSIS) and Linux (AppImage, deb)
targets, but no workflow builds them and they have never been produced. Before enabling them:

- Windows: sign the NSIS installer with a code-signing certificate and validate SmartScreen
  behaviour.
- Linux: the `deb` target will fail until `build.linux.maintainer` (or an `author` with an
  email address) is set. Publish AppImage and DEB artifacts with checksums.

Code signing cannot be simulated in source code. It requires identities and credentials owned
by the distributor.
