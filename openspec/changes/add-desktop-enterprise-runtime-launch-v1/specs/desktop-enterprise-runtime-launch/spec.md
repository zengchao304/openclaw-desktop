## ADDED Requirements
### Requirement: Desktop-managed gateway SHALL explicitly load enterprise runtime when installed
When a current-user enterprise shell install manifest is present and valid, OpenClaw Desktop MUST explicitly launch the gateway child process with the enterprise decrypt loader and ESM hook bootstrap instead of relying on `NODE_OPTIONS`.

#### Scenario: Enterprise manifest is valid
- **WHEN** OpenClaw Desktop starts the bundled gateway and a valid enterprise install manifest is discovered
- **THEN** Desktop MUST construct the gateway launch command with explicit `-r <decrypt-loader>` and `--import <esm-hook-bootstrap>` arguments before `openclaw.mjs`
- **AND** Desktop MUST merge the persisted `OPENCLAW_ENTERPRISE_*` runtime environment contract into the gateway child process

#### Scenario: Enterprise runtime is not installed
- **WHEN** OpenClaw Desktop starts the bundled gateway and no enterprise install manifest is found
- **THEN** Desktop MUST keep using the native `node.exe openclaw.mjs gateway run ...` launch path
- **AND** Desktop MUST NOT fail startup solely because enterprise shell is absent

### Requirement: Desktop enterprise runtime discovery SHALL be validated before injection
OpenClaw Desktop MUST validate the discovered enterprise runtime manifest and required runtime asset paths before enabling enterprise launch integration.

#### Scenario: Required enterprise runtime asset is missing
- **WHEN** the enterprise install manifest exists but a required loader, bootstrap, support path, or wrapper path is missing
- **THEN** Desktop MUST treat enterprise runtime integration as inactive
- **AND** Desktop MUST fall back to the native gateway launch path
- **AND** Desktop MUST emit a diagnosable log entry describing why enterprise launch was skipped

#### Scenario: Enterprise manifest discovery succeeds
- **WHEN** the enterprise install manifest and required runtime paths all validate
- **THEN** Desktop MUST emit a diagnosable log entry that enterprise runtime launch is active
- **AND** the log MUST include enough detail for support staff to distinguish discovery success from later seam-matching failures

### Requirement: Desktop enterprise launch diagnostics SHALL separate injection success from runtime hook behavior
OpenClaw Desktop MUST make it possible to distinguish “enterprise runtime was injected” from “enterprise runtime later matched a specific OpenClaw seam”.

#### Scenario: Enterprise runtime injected but later hook seam not matched
- **WHEN** Desktop successfully launches the gateway with explicit enterprise runtime arguments
- **THEN** Desktop logs and verification output MUST still show enterprise launch integration as active
- **AND** support staff MUST be able to diagnose seam-matching issues separately from startup injection issues
