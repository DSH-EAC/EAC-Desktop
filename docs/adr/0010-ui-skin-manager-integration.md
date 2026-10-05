# ADR 0010: UI skin manager integration boundary

Date: 2026-09-20
Status: Accepted for v6 stage 0
Supersedes: the future-loader implications of ADR 0009; ADR 0009 remains the static package migration baseline
Owners: DSH-Desktop-EAC maintainers (host integration); dsh-ui-skin-manager maintainers (manager contract and runtime policy)

## Context

ADR 0009 replaced the obsolete `assets/shell-skin` layout with the current `assets/ui-skin/system-default` static package structure. The EAC shell currently selects one directory through `registry.json`, serves an explicit asset whitelist, concatenates CSS during startup, and injects it into the WebView. It does not implement package discovery, per-slot binding, lifecycle isolation, hot switching, persistence, or rollback.

The v6 UI skin manager refactor separates the control plane (`dsh-ui-skin-manager`), host capability/recovery boundary (this repository), and official default content (`dsh-desktop-eac-default-skins`). This ADR freezes how EAC integrates that architecture without duplicating manager responsibilities or moving loader policy into the shell.

## Decision

### 1. Three-repository ownership

| Repository | Owns | Must not own |
| --- | --- | --- |
| `dsh-ui-skin-manager` | package/schema contract, validation, install index, selection/binding, per-slot lifecycle, fault isolation, effect ledger, persistence, rollback, diagnostics structure | Tauri privileges, EAC business behavior, official default source |
| `DSH-Desktop-EAC` | `HostProfile`, slot mount points, stable `data-*` anchors, Tauri/WebView/resource/capability adapters, build locks, embedded fallback | package selection, dependency solving, lifecycle policy, editable default-skin source after migration |
| `dsh-desktop-eac-default-skins` | official `system.default` contribution source, package assets, conformance fixtures, license/source materials, reproducible release artifact | host slot topology, active registry, lifecycle engine, EAC staging logic |

The normative cross-repository versions and owners are listed in `docs/ui-skin-cross-repo-interface-versions.md` in the manager repository. EAC pins a reviewed manager artifact and default artifact by exact version and SHA-256 digest at build time.

### 2. Host profile and slot topology

EAC owns `dsh-desktop-eac-ui-skin-profile@^0.3.0`; the current static `^0.3` spelling is SemVer-equivalent migration input. The initial regions are `top-sidebar`, `bottom-sidebar`, `left-sidebar`, `right-sidebar`, `session`, and `overlay`. `popup`, `dialog`, and `floating-window` remain instance kinds. Existing `data-region`, `data-control-name`, and `data-state` anchors are the initial stable host surface.

These six regions are not a permanent ceiling. Before a visual element can be replaced by a Skin, EAC must place it in a versioned slot with a props schema, mount contract, z-index policy, capability set, and fallback contribution. EAC does not retain a parallel customizable shell appearance layer. There is no shell-skin package and no package-wide switch requirement; each slot is independently selectable, activatable, recoverable, and freely composable with other slots.

EAC-private slot IDs may be designed under this profile. Public dsh integration uses explicit versioned mappings to `dsh.client`, `ctx.theme`, `ctx.slots`, and Cordis disposal. Similar names do not imply compatibility. A changed dsh slot `kind`, `scope`, or props requires a range-specific adapter and compile/runtime capability tests.

### 3. Host consumption contract

The host consumes only manager outputs that have passed package, path, digest, compatibility, and lifecycle preparation gates:

- `ActiveBindingSnapshot`: committed generation and per-slot exact package/version/digest/contribution bindings;
- `ResolvedAssetSet`: normalized, inventory-checked assets for the same digest and generation;
- `FaultState`: structured, redacted manager faults and permitted recovery actions;
- the host-profile version used to resolve the snapshot.

EAC rejects a snapshot with an unsupported profile, unknown slot, mismatched digest, stale generation, or asset outside the resolved inventory. It does not repeat package discovery, dependency resolution, user selection, health policy, previous-known-good retention, or rollback ordering.

EAC's official `.dshpack` Feature Pack structure is a supported distribution container for a Skin only when its metadata declares exactly one UI Skin payload. The manager extracts that inner `SkinPackage` and applies its own schema, path, asset, digest, capability, trust, and lifecycle checks; a generic `.dshpack` containing plugins, presets, or skills is not a Skin input. EAC owns outer Feature Pack indexing and provenance, while the manager owns the inner package contract and activation decision.

The existing `/skin/` or replacement resource channel keeps canonical path resolution, inventory whitelist, MIME restrictions, and traversal/symlink escape rejection. It serves only resolved assets for the active/staged generation. A URL or local path never becomes authority by itself.

### 4. Capability and recovery boundary

EAC exposes only the versioned capabilities accepted by manager ADR 0003: current-window controls, current-dialog close, redacted diagnostics actions, bounded host notifications, and public dsh theme/slot adapters. Every capability is scoped to one slot and generation, declared in the contribution, revocable, and denied by default. Raw Tauri handles, arbitrary command invocation, unrestricted filesystem/process/network/RPC access, private host objects, and cross-slot authority are not Skin ABI.

EAC retains an embedded recovery surface for loading/died/boot failure, essential window controls, diagnostics, and repair. It must start when manager state, the manager artifact, or `system.default` is unavailable. The embedded fallback is not a selectable Skin and contains only the minimum recovery UI.

The EAC installer includes one exact, digest-verified official default artifact so first startup and recovery are offline. `system.default` is non-forceable and cannot be removed while it is the last package recovery path. The official default source remains only in `dsh-desktop-eac-default-skins`; the bundled artifact is an immutable build input, not an editable source copy.

### 5. Migration and cutover

Integration is introduced as a bypass path before replacing the static loader:

1. Keep the current `ui-skin` static path and tests as the behavioral baseline.
2. Add host-profile, capability, resource, and manager startup adapters behind an explicit integration switch.
3. Run current static and manager-driven paths against the same default visual fixtures and host behavior tests.
4. Enable per-slot manager bindings only after package validation, fault isolation, recovery, and atomic switch tests pass.
5. Switch canonical default source only after the default-skins release artifact is reproducible and EAC's build lock verifies its digest.
6. Remove the EAC editable default source and obsolete static registry path only with an exact deletion inventory and replacement-test map.

No source is copied from task worktree `b8a54f5` or obsolete `assets/shell-skin`. The migration source is the latest protected `dev` successor architecture (`assets/ui-skin` and ADR 0009). AIO is not migrated in this work and may later be delivered as a separate alternative Skin package.

### 6. Switching, rollback, and user experience

The manager owns `prepare -> preload -> activate(staged) -> health -> commit` and disposal. EAC makes the resulting slot publication atomic across that slot's DOM, styles/theme, registration, capability context, and persisted generation. Different slots may be on different healthy generations.

Only manual import, explicit per-slot selection, and explicit apply are in v6 scope. There is no background update, file watcher, or automatic switch. Incompatible non-default contributions may enter the 30-second force-enable confirmation flow, but JSON, path, asset, and digest failures are never bypassed. Timeout, crash, disconnect, or exit restores the original disabled binding.

Recovery order is candidate rollback, previous slot generation, previous-known-good generation, bundled verified `system.default`, then embedded fallback. Two previous-known-good generations are retained. Structured manager logs rotate at 16 MiB and retain 30 days; EAC owns platform open/copy access while manager owns structure and redaction.

### 7. Licensing and release boundary

The default-skins repository uses MIT with `Copyright (c) 2026 Ebony-Vinyl`. `NOTICE` is created only when an actual license, trademark, source, or attribution obligation requires it. An empty placeholder NOTICE is forbidden. `THIRD-PARTY-NOTICES.md` exists as the source inventory format even when it has no entries. v6 release notes and `CHANGELOG.md` state that v6 is incompatible with v5; v5 history is not backfilled.

Checksums, provenance, release notes, and release CI are generated by project workflows. Stage 0 does not publish, push, tag, open a PR, or create a release.

### 8. Rejected alternatives

- Continue growing the static `registry.json` loader into EAC: rejected because it duplicates manager ownership and cannot isolate per-slot lifecycle.
- Copy old `assets/shell-skin` from `b8a54f5`: rejected because ADR 0009 and the protected `dev` successor supersede it.
- Package-wide shell skin: rejected because all replaceable visual elements must be slot contributions.
- Host selects or rolls back packages itself: rejected because it produces competing control planes.
- Manager or default artifact as an online first-start dependency: rejected because recovery must work offline.
- Migrate AIO in the same cutover: rejected as out of scope.

## Conflict inventory and replacement gates

- ADR 0005 and ADR 0007 remain historical; ADR 0009 already marks their package/loader decisions superseded. They are not implementation inputs.
- ADR 0009 remains valid for the current static package identities, six regions, three instance kinds, 17 states, stable anchors, and path-whitelist behavior. Its future selector language is refined by the manager's per-slot contract.
- Existing `shell-skin-pack` and resource safety tests are not deleted in stage 0. Before any later removal, the implementing change must record exact files/assertions and replace them with manager schema/path/digest tests plus EAC profile/resource/fallback/integration tests.
- The repository's unrelated `dsh-desktop/assets/skills/eac-desktop-tips/SKILL.md` is not a skin protocol and is unchanged. No manager/default-skins SKILL exists to delete.

A conflicting test, SKILL, or specification may be removed only when its obsolete claim, deletion reason, owning ADR, and replacement gate are present in the same reviewed change. CI may not be weakened merely to accommodate new code.

## Consequences

EAC remains the security and recovery boundary while the manager becomes the single control plane for packages and per-slot lifecycle. The migration can compare old and new paths before canonical cutover, and the final source ownership has no editable duplication.

## Acceptance evidence

This ADR assigns every EAC integration field and behavior to a repository owner, fixes bypass/cutover and rollback semantics, and records old-contract treatment. It contains no loader or runtime implementation.
