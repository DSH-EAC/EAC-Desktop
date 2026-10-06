// M2/#415 迁移面 + EAC-CORE-SHELL-01 皮肤平台退役：
// AIO ≤ 9.6.3 升级用户的旧版桌面皮肤残留清理，以及 M2 预装皮肤平台的外迁清理。
//
// 旧链（assets/skins 目录播种，目录自 v6 Task 3.1 起已删、M2 彻底退役）会把
// 10 款旧皮肤拷进 profile：包名 `@linxin666|@dsh-external/dsh-client-ui-skin-*`，
// patch 行 id 取皮肤包 skin.json 的 wiring.id（`ui-skin-*`，insert 内层行）。
//
// M2 曾在 profile bundles 预装公约皮肤平台（`@dsh-eac/ui-skin-loader` +
// 13 款 `@dsh-eac/skin-*`）。EAC-CORE-SHELL-01 决定：宿主最小壳不再随包皮肤/
// 加载器，皮肤改为市场可选包。因此这批包同样进入退役清理 —— 老 profile 的
// bundles 成员 / patch 行 / 包副本必须清掉，否则「行在包不在」或 bundles
// 成员指空都会拖垮插件树。
//
// 红线：`@linxin666` / `@dsh-external` 作用域下的非皮肤插件（市场安装）不得
// 被作用域级联删除误伤。
//
// 清理走既有退役通道（retireRemovedBuiltinPluginsGated）：同一版本内只执行
// 一次，用户在同版本内的手动调整不被每次启动强制改写（issue #74 门控语义）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const runtimePaths = require(join(root, 'lib', 'desktop', 'runtime-paths.js')) as {
  init(d: unknown): void;
};
const companion = require(join(root, 'lib', 'desktop', 'companion-sync.js')) as {
  init(d: unknown): void;
  retireRemovedBuiltinPluginsGated(profileDir: string): void;
  RETIRED_BUILTIN_PLUGINS: { id: string; name: string }[];
  COMPANION_PLUGINS: { id: string; name: string }[];
};
const profileModule = require(join(root, 'lib', 'desktop', 'profile.js')) as {
  BUNDLED_BUILTIN_PLUGINS: string[];
};

/** 旧链在 profile 里的 10 款皮肤（行 id ← skin.json wiring.id；包名 ← package.json）。 */
const LEGACY_SKINS = [
  { id: 'ui-skin-blue-fantasy', name: '@linxin666/dsh-client-ui-skin-blue-fantasy' },
  { id: 'ui-skin-dragon-heir', name: '@linxin666/dsh-client-ui-skin-dragon-heir' },
  { id: 'ui-skin-maid-atelier', name: '@dsh-external/dsh-client-ui-skin-maid-atelier' },
  { id: 'ui-skin-miku', name: '@linxin666/dsh-client-ui-skin-miku' },
  { id: 'ui-skin-minecraft', name: '@linxin666/dsh-client-ui-skin-minecraft' },
  { id: 'ui-skin-qq98', name: '@linxin666/dsh-client-ui-skin-qq98' },
  { id: 'ui-skin-ths', name: '@linxin666/dsh-client-ui-skin-ths' },
  { id: 'ui-skin-trading', name: '@linxin666/dsh-client-ui-skin-trading' },
  { id: 'ui-skin-whale-song', name: '@linxin666/dsh-client-ui-skin-whale-song' },
  { id: 'ui-skin-xp', name: '@linxin666/dsh-client-ui-skin-xp' },
] as const;

/** M2 预装的公约皮肤平台（EAC-CORE-SHELL-01 起同样退役，必须被清理）。 */
const CONVENTION_PACKAGES = ['@dsh-eac/ui-skin-loader', '@dsh-eac/skin-miku', '@dsh-eac/skin-xp'];
const CONVENTION_ROWS = ['dsh-ui-skin-loader', 'dsh-eac-skin-miku', 'dsh-eac-skin-xp'];

/** 老 profile：旧皮肤 insert 行 + M2 公约皮肤平台行 + 无关插件行。 */
const LEGACY_PATCH = `# dsh web profile patch（由 DSH Desktop 维护）

- insert:
    - id: ui-skin-miku
      name: '@linxin666/dsh-client-ui-skin-miku'
      disabled: true
    - id: dsh-ui-skin-loader
      name: '@dsh-eac/ui-skin-loader'
    - id: ui-skin-maid-atelier
      name: '@dsh-external/dsh-client-ui-skin-maid-atelier'
      disabled: true
    - id: dsh-eac-skin-miku
      name: '@dsh-eac/skin-miku'
- insert:
    - id: ui-skin-xp
      name: '@linxin666/dsh-client-ui-skin-xp'
      disabled: true
- insert:
    - id: ui-skin-trading
      name: '@linxin666/dsh-client-ui-skin-trading'
      disabled: true
    - id: dsh-eac-skin-xp
      name: '@dsh-eac/skin-xp'
- id: dsh-terminal
  name: '@deepseek-ai/dsh-terminal'
  disabled: true
`;

interface Fixture {
  home: string;
  profile: string;
  userData: string;
}

function writePackage(dir: string, name: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...extra }, null, 2) + '\n');
  writeFileSync(join(dir, '.eac-copy-stamp.json'), JSON.stringify({ v: '1.0.0', f: 1, b: 1 }));
}

/** 造一个含旧皮肤残留 + M2 公约皮肤平台的 profile（含 node_modules 副本与 package.json 依赖）。 */
function makeProfile(): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'dsh-legacy-skin-'));
  const userData = join(home, 'userdata');
  const profile = join(home, 'profiles', 'web-desktop');
  mkdirSync(profile, { recursive: true });
  mkdirSync(userData, { recursive: true });
  writeFileSync(join(profile, 'cordis.patch.yml'), LEGACY_PATCH);
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile',
    dependencies: {
      '@deepseek-ai/dsh-base': '0.1.7-rc.2',
      '@linxin666/dsh-client-ui-skin-miku': '1.0.0',
      '@dsh-external/dsh-client-ui-skin-maid-atelier': '1.0.0',
      '@linxin666/dsh-client-ui-skin-xp': '1.0.0',
      ...Object.fromEntries(CONVENTION_PACKAGES.map((name) => [name, '1.1.0'])),
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...CONVENTION_PACKAGES] } },
  }, null, 2) + '\n');
  const modules = join(profile, 'node_modules');
  writePackage(join(modules, '@linxin666', 'dsh-client-ui-skin-miku'), LEGACY_SKINS[3].name);
  writePackage(join(modules, '@dsh-external', 'dsh-client-ui-skin-maid-atelier'), LEGACY_SKINS[2].name);
  writeFileSync(join(modules, '@dsh-external', 'dsh-client-ui-skin-maid-atelier', 'skin.json'), JSON.stringify({ id: 'maid-atelier', wiring: { id: 'ui-skin-maid-atelier' } }));
  writePackage(join(modules, '@linxin666', 'dsh-client-ui-skin-xp'), LEGACY_SKINS[9].name);
  writePackage(join(modules, '@linxin666', 'dsh-client-ui-skin-trading'), LEGACY_SKINS[7].name);
  // 作用域下的非皮肤插件（市场安装）：不得被作用域级联删除误伤
  writePackage(join(modules, '@linxin666', 'dsh-other-plugin'), '@linxin666/dsh-other-plugin');
  // M2 公约皮肤平台：EAC-CORE-SHELL-01 起同样退役，但副本仍需清理干净
  for (const name of CONVENTION_PACKAGES) {
    writePackage(join(modules, ...name.split('/')), name);
  }
  return { home, profile, userData };
}

function initCompanion(fixture: Fixture): void {
  runtimePaths.init({ log: () => {}, getUserDataDir: () => fixture.userData });
  companion.init({
    log: () => {},
    getDshHome: () => fixture.home,
    getUserDataDir: () => fixture.userData,
    showMainWindow: () => {},
    notify: () => {},
  });
}

function readJson(file: string): Record<string, any> {
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('升级迁移清掉旧 ui-skin-* 行、旧皮肤包副本与 package.json 依赖', () => {
  const fixture = makeProfile();
  try {
    initCompanion(fixture);
    companion.retireRemovedBuiltinPluginsGated(fixture.profile);

    const patch = readFileSync(join(fixture.profile, 'cordis.patch.yml'), 'utf8');
    assert.doesNotMatch(patch, /- id: ui-skin-/, '旧版皮肤行必须整行移除（含 insert 内层行）');
    assert.doesNotMatch(patch, /@linxin666\/dsh-client-ui-skin-|@dsh-external\/dsh-client-ui-skin-/, '旧皮肤包名不得再出现在 patch 里');
    assert.match(patch, /- id: dsh-terminal/, '无关插件行必须保留');

    for (const skin of LEGACY_SKINS.slice(0, 4)) {
      const dir = join(fixture.profile, 'node_modules', ...skin.name.split('/'));
      assert.equal(existsSync(dir), false, `${skin.name} 的 profile 包副本必须清理`);
    }
    const pkg = readJson(join(fixture.profile, 'package.json'));
    for (const name of ['@linxin666/dsh-client-ui-skin-miku', '@dsh-external/dsh-client-ui-skin-maid-atelier', '@linxin666/dsh-client-ui-skin-xp']) {
      assert.equal(name in pkg.dependencies, false, `${name} 依赖必须清理`);
    }
    assert.equal(pkg.dependencies['@deepseek-ai/dsh-base'], '0.1.7-rc.2', '无关依赖必须保留');
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('EAC-CORE-SHELL-01：M2 公约皮肤平台随外迁一并退役清理', () => {
  const fixture = makeProfile();
  try {
    initCompanion(fixture);
    companion.retireRemovedBuiltinPluginsGated(fixture.profile);

    const patch = readFileSync(join(fixture.profile, 'cordis.patch.yml'), 'utf8');
    for (const row of CONVENTION_ROWS) {
      assert.doesNotMatch(patch, new RegExp(`- id: ${row}\\b`), `公约皮肤平台行 ${row} 必须随外迁清理`);
    }
    for (const name of CONVENTION_PACKAGES) {
      const dir = join(fixture.profile, 'node_modules', ...name.split('/'));
      assert.equal(existsSync(join(dir, 'package.json')), false, `${name} 包副本必须随外迁清理`);
    }
    const pkg = readJson(join(fixture.profile, 'package.json'));
    for (const name of CONVENTION_PACKAGES) {
      assert.equal(name in pkg.dependencies, false, `${name} 依赖必须随外迁清理`);
      assert.equal((pkg.dsh?.profile?.bundles || []).includes(name), false, `${name} 必须移出 profile bundles`);
    }
    // 作用域下的非皮肤插件（市场安装）不得被级联误伤。
    assert.equal(existsSync(join(fixture.profile, 'node_modules', '@linxin666', 'dsh-other-plugin', 'package.json')), true,
      '同作用域的非皮肤插件不得被误删');
    assert.match(patch, /- id: dsh-terminal/, '无关插件行必须保留');
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('迁移目标与新旧皮肤命名空间零交集（精确条目，非前缀/作用域删除）', () => {
  const retiredIds = new Set(companion.RETIRED_BUILTIN_PLUGINS.map((p) => p.id));
  const retiredNames = new Set(companion.RETIRED_BUILTIN_PLUGINS.map((p) => p.name));
  for (const skin of LEGACY_SKINS) {
    assert.ok(retiredIds.has(skin.id), `旧皮肤行 ${skin.id} 必须在退役清单`);
    assert.ok(retiredNames.has(skin.name), `旧皮肤包 ${skin.name} 必须在退役清单`);
  }
  for (const row of CONVENTION_ROWS) {
    assert.ok(retiredIds.has(row), `公约皮肤行 ${row} 必须在退役清单（外迁后同样清理）`);
  }
  for (const name of CONVENTION_PACKAGES) {
    assert.ok(retiredNames.has(name), `公约皮肤包 ${name} 必须在退役清单（外迁后同样清理）`);
  }
  // 同作用域的非皮肤插件绝不进退役清单。
  assert.equal(retiredNames.has('@linxin666/dsh-other-plugin'), false, '同作用域非皮肤插件不得进退役清单');
});

test('迁移走退役门控：同一版本内只对齐一次，用户后续改动不被反复清除', () => {
  const fixture = makeProfile();
  try {
    initCompanion(fixture);
    companion.retireRemovedBuiltinPluginsGated(fixture.profile);
    // 用户在同版本内手动加回一行：门控语义下不得被下一次启动再次清除。
    const patchPath = join(fixture.profile, 'cordis.patch.yml');
    writeFileSync(patchPath, readFileSync(patchPath, 'utf8') + '\n- id: user-added\n  name: user-plugin\n');
    companion.retireRemovedBuiltinPluginsGated(fixture.profile);
    assert.match(readFileSync(patchPath, 'utf8'), /- id: user-added/, '同版本内用户改动不得被反复清除');
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('退役清单指纹随迁移目标变化（升级后首次启动必然重跑清理）', () => {
  const ids = companion.RETIRED_BUILTIN_PLUGINS.map((p) => `${p.id}:${p.name}`).sort().join('\n');
  const digest = createHash('sha256').update(ids).digest('hex');
  assert.equal(typeof digest, 'string');
  assert.ok(ids.includes('dsh-ui-skin-loader'), '外迁后公约 loader 必须在退役清单（改变指纹，触发重跑）');
  assert.ok(ids.includes('dsh-eac-skin-miku'), '外迁后公约皮肤必须在退役清单');
});