## 1. Spec And Design
- [x] 1.1 Define how Desktop discovers an installed enterprise shell manifest.
- [x] 1.2 Define the explicit gateway launch contract for enterprise-managed preload and ESM hook injection.
- [x] 1.3 Define fail-open fallback behavior when enterprise runtime assets are missing or invalid.

## 2. Desktop Runtime Discovery
- [x] 2.1 Add a helper that discovers and validates the enterprise install manifest from the current-user install location.
- [x] 2.2 Validate required runtime assets from the manifest, including decrypt loader, ESM hook bootstrap, support dir, wrapper path, and OpenClaw entry path compatibility.
- [x] 2.3 Surface structured Desktop logs for enterprise runtime discovery success and failure cases.

## 3. Gateway Launch Integration
- [x] 3.1 Update Desktop gateway launch spec creation to inject enterprise runtime explicitly with `-r` and `--import` arguments instead of relying on `NODE_OPTIONS`.
- [x] 3.2 Merge the persisted `OPENCLAW_ENTERPRISE_*` runtime environment contract into the gateway child process when enterprise integration is active.
- [x] 3.3 Preserve the existing native launch path when enterprise runtime is unavailable or invalid.

## 4. Verification
- [x] 4.1 Extend automated tests or smoke coverage for enterprise runtime launch spec generation and fallback behavior.
- [x] 4.2 Update bundle verification / support docs so Desktop-managed enterprise deployments can be diagnosed deterministically.
- [x] 4.3 Validate the change with `openspec validate add-desktop-enterprise-runtime-launch-v1 --strict`.
