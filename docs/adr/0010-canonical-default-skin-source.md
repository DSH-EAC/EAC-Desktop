# ADR 0010: Canonical default Skin source and EAC assembly

Date: 2026-09-21
Status: Accepted for v6 stage 7
Owner: DSH-Desktop-EAC maintainers (host profile and assembly)

## Decision

`dsh-desktop-eac-default-skins` is the only editable source for the official
`system.default@2.0.0` Skin. DSH-Desktop-EAC stores only the exact manager and
default release artifacts named by `tauri-shell/skin-manager-artifact.lock.json`.
The lock records source commits, CI runs, artifact names, and SHA-256 digests;
startup and staging reject missing or mismatched bytes.

The EAC-owned `tauri-shell/host-profile.json` is the source for host topology:
regions, slot descriptors, instance kinds, z-index policy, capabilities, dsh
adapter ranges, and the embedded fallback coordinate. Host topology and active
binding state are not Skin payload and must not be copied into default-skins.
User selection, lifecycle, active bindings, generations, and rollback belong to
the manager; EAC consumes its verified snapshot and fault state.

The manager path is enabled by default. `DSH_UI_SKIN_MANAGER_ROLLBACK=1` is a
one-release emergency switch that selects the small embedded recovery styles;
it is not a source mirror, does not restore the removed registry, and must be
removed or expired by the next release governance review. The normal path is
offline: staging verifies and copies only the pinned manager/default artifacts.
It must never read a mutable branch, GitHub raw URL, or network source at
runtime.

The tracked EAC source files under `dsh-desktop/assets/ui-skin/`, including the
old active registry and `system-default` directory, are deleted after this
cutover. `assets/shell-skin` and the old AIO v1 package model are historical
only and must not be restored. The embedded fallback remains host-owned and
contains only the minimum recovery styles, not a second default package source.

## License and aggregation

The canonical default-skins repository owns the default Skin MIT license,
`Copyright (c) 2026 Ebony-Vinyl`, its empty third-party inventory, and any
future real NOTICE obligations. EAC's top-level MIT license continues to cover
EAC code; the staged default artifact remains accompanied by its locked source,
provenance and digest. EAC release notes and bundle manifests must identify the
artifact coordinate and digest rather than claiming ownership of its editable
source.

## Rejected alternatives and replacement gates

- Keeping an EAC registry or source mirror is rejected because it permits drift
  from the canonical default-skins source.
- Runtime reads from mutable `main`/`raw` or network downloads are rejected
  because offline startup and reproducible rollback are required.
- Restoring `assets/shell-skin` or AIO v1 is rejected; any future alternative
  Skin needs a separate reviewed package and release task.
- Deleting the source is accepted only with pinned artifact existence/digest,
  HostProfile validation, staged offline closure, and rollback lock checks.

## Verification

The stage-7 static gate checks that the source tree and active registry are
absent, HostProfile owns six regions and three instance kinds, the artifact
contains six contributions but no host topology, the lock digests match actual
files, and the emergency rollback switch is explicit. Build, test, and
cross-platform WebView validation are CI responsibilities for this stage and
are recorded as NOT RUN locally under the freeze-avoidance policy.
