import { createRequire } from 'node:module'
import { join } from 'node:path'
import { commitProfileConfig, readProfileConfig } from './profile-sync.mjs'

const require = createRequire(import.meta.url)

function bundleTools() {
  const root = process.env.DSH_DESKTOP_RESOURCE_ROOT
  if (!root) throw new Error('当前宿主未提供插件元数据解析服务，请升级桌面客户端')
  return {
    ...require(join(root, 'lib', 'bundle-identity.js')),
    ...require(join(root, 'plugin-manager-state.js')),
  }
}

/** Keep bundle registration stable and write overrides for every declared loader entry. */
export function togglePackage(dir, packageName, enabled) {
  let entryIds = []
  try {
    const tools = bundleTools()
    if (tools.KERNEL_BUNDLE_PACKAGES.has(packageName)) throw new Error('核心插件不可停用')
    const result = commitProfileConfig(dir, (cfg) => {
      if (!cfg.bundles.includes(packageName)) throw new Error('插件尚未注册: ' + packageName)
      const identity = tools.resolveBundleIdentities(dir, cfg.bundles)[packageName]
      if (!identity?.ok) throw new Error(identity?.error || '无法解析插件元数据')
      entryIds = identity.entryIds
      return {
        patch: tools.toggleBundleInPatch(cfg.patchText, identity, enabled),
        summary: (enabled ? '启用 ' : '关闭 ') + packageName,
      }
    })
    return { ...result, id: entryIds[0], entryIds }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

/** An install spec is not a package ID. Accept only an unambiguous installed identity. */
export function installedPackageName(dir, op) {
  const cfg = readProfileConfig(dir)
  const names = cfg.bundles.filter(name => Object.hasOwn(cfg.dependencies, name))
  const exact = names.filter(name => name === op.pkg || name === op.target)
  const matchingSpec = names.filter(name => cfg.dependencies[name] === op.target)
  const added = names.filter(name => !Object.hasOwn(op.beforeDeps || {}, name))
  const candidates = exact.length ? exact : matchingSpec.length ? matchingSpec : added
  if (candidates.length !== 1) throw new Error('安装已完成，但无法唯一确定插件包名；配置未改动')
  return candidates[0]
}
