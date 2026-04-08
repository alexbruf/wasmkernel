# Releasing wasmkernel

## One-time setup

### 1. Create the GitHub repo

```sh
gh repo create alexbruf/wasmkernel --public --source . --remote origin
```

(Or create it via the web UI and `git remote add origin git@github.com:alexbruf/wasmkernel.git`.)

### 2. npm scope

The package publishes as `@alexbruf/wasmkernel`. You need:

- An npm account
- Either an `alexbruf` org with the package scoped under it, **or** publish under your personal scope

```sh
npm login
# verify scope is yours:
npm whoami
```

### 3. NPM_TOKEN repo secret

Generate an automation token on npm:

```sh
npm token create --read-only=false --cidr=0.0.0.0/0
```

Or via [npmjs.com → Access Tokens → Generate → Automation](https://www.npmjs.com/settings/~/tokens). Pick the **Automation** type so it bypasses 2FA at publish time (required for CI).

Add it as a repo secret:

```sh
gh secret set NPM_TOKEN --body "<token>"
```

That's the only secret CI needs. Provenance attestation (`--provenance`) uses GitHub's OIDC and works automatically once the workflow has `id-token: write` permissions, which `publish.yml` already declares.

## Cutting a release

1. Bump the version in `packages/wasmkernel/package.json`:

   ```sh
   cd packages/wasmkernel && npm version patch  # or minor/major
   ```

   This rewrites `package.json` and creates a local commit + tag.

2. Push the commit and tag:

   ```sh
   git push origin main
   git push origin "v$(node -p "require('./packages/wasmkernel/package.json').version")"
   ```

3. The `Publish` workflow takes it from there:
   - Clones the repo with submodules
   - Installs wasi-sdk + binaryen
   - Builds the kernel
   - Builds guest tests
   - Runs the **full** test suite (including the multi-minute argon2/soak/emnapi groups)
   - Verifies the tag matches the package.json version
   - Publishes to npm with sigstore provenance

4. After ~10 minutes you'll see the new version on npm and the provenance badge on the package page.

## CI runs

- **PRs to `main`**: `ci.yml` runs in quick mode (`WASMKERNEL_QUICK_TESTS=1`), skipping the multi-minute groups. Lands in ~3-4 min.
- **Pushes to `main`**: `ci.yml` runs the full suite.
- **Tag pushes (`v*`)**: `publish.yml` runs the full suite + publishes.

## Local dry-run before tagging

```sh
./scripts/build.sh                 # build kernel + guests + tests, syncs package
cd packages/wasmkernel
npm pack --dry-run                 # see what will be in the tarball
```

The prepublishOnly guard refuses to publish if `wasmkernel.wasm` is missing from the package directory — `./scripts/sync-package.sh` (called by `build.sh`) handles that.
