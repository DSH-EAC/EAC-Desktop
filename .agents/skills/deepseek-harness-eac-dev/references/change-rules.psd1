@{
    SchemaVersion = 1
    Rules = @(
        @{
            Name = 'tauri-rust'
            Domain = 'tauri-shell'
            Pattern = '^tauri-shell/src/.*\.rs$|^tauri-shell/Cargo\.(toml|lock)$'
            Reference = 'references/tauri-shell.md'
            Level = 'runtime'
            Tests = @('test/bridge-preload-parity.test.ts')
            Smoke = @('cd tauri-shell; cargo run -- --bridge-test', 'MANUAL: exercise GUI settings, overlays and window lifecycle in the current desktop build (legacy gui-smoke.js retired)')
        },
        @{
            Name = 'sidecar-bridge'
            Domain = 'sidecar-bridge'
            Pattern = '^tauri-shell/sidecar/|bridge\.(ts|js)$|preload\.js$'
            Reference = 'references/sidecar-and-bridge.md'
            Level = 'runtime'
            Tests = @('test/bridge-preload-parity.test.ts')
            Smoke = @('cd tauri-shell; cargo run -- --bridge-test')
        },
        @{
            Name = 'client-update'
            Domain = 'updates-packaging'
            Pattern = 'client-updater|lib/desktop/client-update|update-smoke'
            Reference = 'references/updates-and-packaging.md'
            Level = 'package'
            Tests = @(
                'test/client-updater-proxy.test.ts',
                'test/runtime-overlay-health.test.ts',
                'test/bridge-preload-parity.test.ts'
            )
            Smoke = @(
                'MANUAL: exercise release update and rollback with real packages (legacy update-smoke.js retired)',
                'MANUAL: exercise update download, apply, failure and recovery with the current release mechanism; legacy native updater harnesses are retired'
            )
        },
        @{
            Name = 'agent-update'
            Domain = 'updates-packaging'
            Pattern = '(^|/)updater\.(js|ts)$'
            Reference = 'references/updates-and-packaging.md'
            Level = 'full'
            Tests = @(
                'test/runtime-overlay-health.test.ts',
                'test/kernel-pin-consistency.test.ts'
            )
            Smoke = @(
                'MANUAL: verify kernel update backup, version selection and rollback with an isolated profile'
            )
        },
        @{
            Name = 'dependency-patches'
            Domain = 'dependency-patches'
            Pattern = '^dsh-desktop/scripts/patch-deps\.js$|^dsh-desktop/node_modules/@deepseek-ai/dsh-tool-(pwsh|fs|bash)/lib/index\.js$'
            Reference = 'references/dependency-patches.md'
            Level = 'package'
            Tests = @(
                'test/bundle-integrity.test.ts',
                'test/bundled-files.test.ts',
                'test/verify-dist-fresh.test.ts'
            )
            Smoke = @(
                'node tauri-shell/stage-resources.mjs',
                'MANUAL: verify patch-deps idempotence and the staged vendored overlay'
            )
        },
        @{
            Name = 'project-scripts'
            Domain = 'updates-packaging'
            Pattern = '^dsh-desktop/scripts/.*\.(js|cjs|mjs|ts|ps1)$'
            Reference = 'references/updates-and-packaging.md'
            Level = 'full'
            Tests = @('test/bundled-files.test.ts')
            Smoke = @()
        },
        @{
            Name = 'skins'
            Domain = 'plugins'
            Pattern = '^dsh-desktop/assets/skins/|dsh-skin-switch'
            Reference = 'references/dsh-plugins.md'
            Level = 'full'
            Tests = @(
                'test/issue-415-legacy-ui-skin-migration.test.ts',
                'test/issue-415-skin-switch-retirement.test.ts',
                'test/stage-7-canonical-source.test.ts'
            )
            Smoke = @('MANUAL: exercise GUI settings, overlays and window lifecycle in the current desktop build (legacy gui-smoke.js retired)')
        },
        @{
            Name = 'shell-skins'
            Domain = 'tauri-shell'
            Pattern = '^dsh-desktop/assets/shell-skin/'
            Reference = 'references/tauri-shell.md'
            Level = 'targeted'
            Tests = @(
                'test/stage-7-canonical-source.test.ts'
            )
            Smoke = @(
                'MANUAL: confirm retired AIO/shell-skin sources remain absent; visual changes belong in the canonical Skin repository'
            )
        },
        @{
            Name = 'bundled-skills'
            Domain = 'presets-profile'
            Pattern = '^dsh-desktop/assets/skills/|syncBundledSkills'
            Reference = 'references/presets-and-profile.md'
            Level = 'full'
            Tests = @()
            Smoke = @('MANUAL: exercise sidecar boot, restart and exit with a temporary profile (legacy boot-smoke.js retired)')
        },
        @{
            Name = 'openclaw-bridge'
            Domain = 'plugins'
            Pattern = '^openclaw-dsh-bridge/|dsh-openclaw-bridge'
            Reference = 'references/dsh-plugins.md'
            Level = 'full'
            Tests = @()
            Smoke = @(
                'MANUAL: run the external OpenClaw package tests in its owning repository; it is no longer bundled here'
            )
        },
        @{
            Name = 'plugin-update'
            Domain = 'plugins'
            Pattern = 'plugin-updater\.(js|ts)$'
            Reference = 'references/dsh-plugins.md'
            Level = 'full'
            Tests = @(
                'test/plugin-conflict-scan.test.ts'
            )
            Smoke = @(
                'MANUAL: exercise plugin update success and rollback with a temporary profile'
            )
        },
        @{
            Name = 'companion-sync'
            Domain = 'plugins'
            Pattern = 'companion-sync\.(ts|js)$'
            Reference = 'references/dsh-plugins.md'
            Level = 'full'
            Tests = @(
                'test/companion-copy-integrity.test.ts',
                'test/retirement-cleanup.test.ts',
                'test/issue-415-legacy-ui-skin-migration.test.ts',
                'test/issue-416-plugin-distribution-tiers.test.ts',
                'test/kernel-service-compat.test.ts'
            )
            Smoke = @()
        },
        @{
            Name = 'plugin-copy'
            Domain = 'plugins'
            Pattern = '^dsh-desktop/lib/plugin-copy\.(ts|js)$'
            Reference = 'references/dsh-plugins.md'
            Level = 'full'
            Tests = @(
                'test/companion-copy-integrity.test.ts',
                'test/plugin-sync-eol-independence.test.ts'
            )
            Smoke = @()
        },
        @{
            Name = 'plugin-ops'
            Domain = 'plugins'
            Pattern = 'plugin-ops\.(ts|js)$|plugin-manager-state|scripts/onboarding|scripts/plugin-manager-patch|^dsh-desktop/lib/bundle-identity\.(ts|js)$'
            Reference = 'references/dsh-plugins.md'
            Level = 'full'
            Tests = @(
                'test/bundle-identity.test.ts',
                'test/issue-416-plugin-distribution-tiers.test.ts',
                'test/plugin-conflict-scan.test.ts'
            )
            Smoke = @(
                'MANUAL: verify enable/disable/remove and persisted choice after restart with an installed community bundle'
            )
        },
        @{
            Name = 'plugin-package'
            Domain = 'plugins'
            Pattern = '^dsh-desktop/assets/plugins/'
            Reference = 'references/dsh-plugins.md'
            Level = 'full'
            Tests = @(
                'test/market-bundle-identity.test.ts',
                'test/companion-copy-integrity.test.ts',
                'test/issue-416-plugin-distribution-tiers.test.ts',
                'test/kernel-service-compat.test.ts'
            )
            Smoke = @('node tauri-shell/stage-resources.mjs')
        },
        @{
            Name = 'desktop-package-manifest'
            Domain = 'updates-packaging'
            Pattern = '^dsh-desktop/package\.json$'
            Reference = 'references/updates-and-packaging.md'
            Level = 'package'
            Tests = @(
                'test/bundled-files.test.ts',
                'test/dependency-security-overrides.test.ts',
                'test/kernel-pin-consistency.test.ts'
            )
            Smoke = @('node tauri-shell/stage-resources.mjs')
        },
        @{
            Name = 'dsh-compact'
            Domain = 'plugins'
            Pattern = 'dsh-compact|compact-preset-migrate'
            Reference = 'references/dsh-plugins.md'
            Level = 'full'
            Tests = @(
                'test/compact-configform-write-feedback.test.ts',
                'test/kernel-service-compat.test.ts'
            )
            Smoke = @(
                'MANUAL: exercise automatic compaction, overflow recovery and preset migration on an isolated session'
            )
        },
        @{
            Name = 'presets-profile'
            Domain = 'presets-profile'
            Pattern = 'agent-presets|preset-sync|compact-preset-migrate|patch-row|profile|cordis\.patch'
            Reference = 'references/presets-and-profile.md'
            Level = 'full'
            Tests = @(
                'test/credentials-heal.test.ts',
                'test/kernel-service-compat.test.ts'
            )
            Smoke = @(
                'MANUAL: exercise sidecar boot, restart and exit with a temporary profile (legacy boot-smoke.js retired)',
                'MANUAL: verify profile initialization and preset/patch migration are idempotent and preserve custom entries'
            )
        },
        @{
            Name = 'shortcuts'
            Domain = 'presets-profile'
            Pattern = 'shortcuts\.(ts|js)$|shortcut-maintenance'
            Reference = 'references/presets-and-profile.md'
            Level = 'full'
            Tests = @(
                'test/bridge-preload-parity.test.ts',
                'test/l1-native-actions.test.ts'
            )
            Smoke = @()
        },
        @{
            Name = 'balance-pricing'
            Domain = 'product-services'
            Pattern = 'balance\.(ts|js)$|pricing-window|dsh-balance'
            Reference = 'references/product-services.md'
            Level = 'full'
            Tests = @(
                'test/minimal-core-boundary.test.ts',
                'test/bridge-preload-parity.test.ts'
            )
            Smoke = @(
                'MANUAL: verify pricing, theme and enable/disable behavior in the external balance plugin; do not restore retired core features'
            )
        },
        @{
            Name = 'session-notify'
            Domain = 'product-services'
            Pattern = 'session-watcher\.(ts|js)$|notifyOnTurnEnd'
            Reference = 'references/product-services.md'
            Level = 'runtime'
            Tests = @()
            Smoke = @('MANUAL: exercise GUI settings, overlays and window lifecycle in the current desktop build (legacy gui-smoke.js retired)')
        },
        @{
            Name = 'file-preview'
            Domain = 'product-services'
            Pattern = 'file-roots\.(ts|js)$|static-preview\.(ts|js)$|image-paste'
            Reference = 'references/product-services.md'
            Level = 'full'
            Tests = @(
                'test/bundle-integrity.test.ts',
                'test/bundled-files.test.ts',
                'test/l1-native-actions.test.ts'
            )
            Smoke = @()
        },
        @{
            Name = 'runtime-utilities'
            Domain = 'product-services'
            Pattern = 'stable-port|stream-write-guard|koffi-preflight|builtin-collision|bundle-integrity'
            Reference = 'references/product-services.md'
            Level = 'full'
            Tests = @(
                'test/stable-port.test.ts',
                'test/stream-write-after-end.test.ts',
                'test/koffi-preflight.test.ts',
                'test/plugin-conflict-scan.test.ts',
                'test/bundle-integrity.test.ts'
            )
            Smoke = @()
        },
        @{
            Name = 'reliability'
            Domain = 'reliability-security'
            Pattern = 'guard|rescue|recovery|watchdog|logger|redact|safe-mode|diagnostics'
            Reference = 'references/reliability-and-security.md'
            Level = 'full'
            Tests = @(
                'test/atomic-write.test.ts',
                'test/runtime-overlay-health.test.ts',
                'test/settings-write-recovery.test.ts',
                'test/minimal-core-boundary.test.ts'
            )
            Smoke = @(
                'MANUAL: exercise the changed failure/recovery path and verify logs redact secrets'
            )
        },
        @{
            Name = 'packaging'
            Domain = 'updates-packaging'
            Pattern = 'stage-resources|stage-platform-cache|audit-linux-bundle|make-portable|tauri(?:\.[^.]+)?\.conf\.json|^tauri-shell/gen/schemas/.*\.json$|installer|electron-builder|bundle-integrity|verify-dist'
            Reference = 'references/updates-and-packaging.md'
            Level = 'package'
            Tests = @(
                'test/bundle-integrity.test.ts',
                'test/bundled-files.test.ts',
                'test/installer-nsh-lengths.test.ts',
                'test/installer-nsh-pipe.test.ts',
                'test/installer-takeover.test.ts',
                'test/verify-dist-fresh.test.ts'
            )
            Smoke = @('MANUAL: exercise release update and rollback with real packages (legacy update-smoke.js retired)')
        },
        @{
            Name = 'electron-fallback'
            Domain = 'sidecar-bridge'
            Pattern = '^dsh-desktop/main\.js$|^dsh-desktop/preload\.js$'
            Reference = 'references/sidecar-and-bridge.md'
            Level = 'runtime'
            Tests = @(
                'test/bridge-preload-parity.test.ts',
                'test/bundled-files.test.ts',
                'test/minimal-core-boundary.test.ts'
            )
            Smoke = @()
        },
        @{
            Name = 'general-project-code'
            Domain = 'product-services'
            Pattern = '^dsh-desktop/(lib/desktop/|[^/]+\.(ts|js)$)'
            Reference = 'references/product-services.md'
            Level = 'full'
            Tests = @()
            Smoke = @()
        },
        @{
            Name = 'test-files'
            Domain = 'tests-acceptance'
            Pattern = '(^|/)test/|smoke\.js$|upgrade-test'
            Reference = 'references/testing-and-acceptance.md'
            Level = 'targeted'
            Tests = @()
            Smoke = @()
        },
        @{
            Name = 'ci-workflow'
            Domain = 'release-git'
            Pattern = '^\.github/workflows/(?!release).*\.ya?ml$'
            Reference = 'references/release-and-git.md'
            Level = 'targeted'
            Tests = @()
            Smoke = @(
                'MANUAL: review workflow triggers, permissions, shells, paths and local command parity'
            )
        },
        @{
            Name = 'release'
            Domain = 'release-git'
            Pattern = '^\.github/workflows/release.*\.ya?ml$|(^|/)CHANGELOG|package-lock\.json$'
            Reference = 'references/release-and-git.md'
            Level = 'package'
            Tests = @()
            Smoke = @()
        },
        @{
            Name = 'git-policy'
            Domain = 'release-git'
            Pattern = '(^|/)\.gitignore$|(^|/)\.gitattributes$|CODEOWNERS|PULL_REQUEST_TEMPLATE|pull_request_template|CONTRIBUTING\.md$'
            Reference = 'references/team-git-workflow.md'
            Level = 'targeted'
            Tests = @()
            Smoke = @('git diff --check', 'MANUAL: review line-ending and repository policy impact')
        },
        @{
            Name = 'documentation'
            Domain = 'documentation'
            Pattern = '(^|/)(docs|research)/.*\.(md|txt)$|(^|/)(README|CHANGELOG|CONTRIBUTING).*\.md$'
            Reference = 'references/release-and-git.md'
            Level = 'targeted'
            Tests = @()
            Smoke = @()
            Documentation = $true
        },
        @{
            Name = 'skill-maintenance'
            Domain = 'skill-maintenance'
            Pattern = '(^|/)(\.agents/skills/deepseek-harness-eac-dev|deepseek-harness-eac-dev)/(SKILL\.md|agents/openai\.yaml|references/.*\.(md|psd1)|scripts/.*\.ps1|tests/.*\.ps1)$'
            Reference = 'references/skill-maintenance.md'
            Level = 'targeted'
            Tests = @()
            Smoke = @()
            SelfCheck = $true
            Exclusive = $true
        }
    )
}
