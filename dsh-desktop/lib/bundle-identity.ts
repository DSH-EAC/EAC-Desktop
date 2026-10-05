import fs = require('node:fs');
import path = require('node:path');
import { isMap, isSeq, parseDocument } from 'yaml';
import type { Document } from 'yaml';
const { KERNEL_BUNDLE_PACKAGES } = require('../plugin-manager-state') as { KERNEL_BUNDLE_PACKAGES: Set<string> };

export interface BundleEntry { id: string; name: string; disabled: boolean }
export type BundleIdentity = { ok: true; entries: BundleEntry[]; entryIds: string[] }
  | { ok: false; error: string; entryIds?: string[] };
export type BundleIdentities = Record<string, BundleIdentity>;
const ID = /^[A-Za-z0-9_.-]+$/;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

/** Parse configuration as data, including the kernel's inert !!js scalars. */
export function parsePatchData(text: string): unknown {
  const doc = parseDocument(text, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }],
  });
  if (doc.errors.length) throw new Error('插件补丁 YAML 无法解析');
  return doc.toJS({ maxAliasCount: 100 });
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Registration means a loader row, not an ID mentioned in a comment or config value. */
export function registeredPatchEntryIds(text: string): Set<string> {
  const data = parsePatchData(text) ?? [];
  if (!Array.isArray(data)) throw new Error('用户补丁必须是列表');
  const ids = new Set<string>();
  for (const value of data) {
    const patch = object(value);
    for (const entry of [patch, ...(Array.isArray(patch?.insert) ? patch.insert : [])]) {
      const row = object(entry);
      if (typeof row?.id === 'string') ids.add(row.id);
    }
  }
  return ids;
}

/** Follow the profile's Node lookup hierarchy, including profiles/node_modules. */
function installedPackageRoot(profileDir: string, packageName: string): string {
  for (let directory = path.resolve(profileDir);;) {
    const candidate = path.join(directory, 'node_modules', ...packageName.split('/'));
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('无法读取插件的安装元数据或补丁');
    directory = parent;
  }
}

/** Read only declared bundle patches; never execute package code or guess a row ID. */
export function resolveBundleIdentity(profileDir: string, packageName: string): BundleIdentity {
  if (!PACKAGE.test(packageName) || packageName.split('/').some((part) => part === '.' || part === '..')) {
    return { ok: false, error: '插件包名无效' };
  }
  try {
    const root = installedPackageRoot(profileDir, packageName);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (manifest.name !== packageName) throw new Error('插件包名与安装元数据不一致');
    const declared: unknown = manifest.dsh?.bundle?.patch;
    const files = typeof declared === 'string' ? [declared] : declared;
    if (!Array.isArray(files) || !files.length || !files.every((file) => typeof file === 'string' && file.length)) {
      throw new Error('插件未声明有效的 dsh.bundle.patch');
    }
    const entries: BundleEntry[] = [];
    const ids = new Set<string>();
    for (const file of files as string[]) {
      if (path.isAbsolute(file)) throw new Error('插件补丁路径超出包目录');
      const filename = fs.realpathSync(path.resolve(root, file));
      const relative = path.relative(root, filename);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error('插件补丁路径超出包目录');
      }
      const patches = parsePatchData(fs.readFileSync(filename, 'utf8'));
      if (!Array.isArray(patches)) throw new Error('插件补丁必须是列表');
      for (const patch of patches) {
        const item = object(patch);
        if (!item || item.insert === undefined) continue;
        if (!Array.isArray(item.insert)) throw new Error('插件声明包含无法静态解析的插入项');
        for (const value of item.insert) {
          const row = object(value);
          if (!row || typeof row.id !== 'string' || !ID.test(row.id) || typeof row.name !== 'string' || !row.name) {
            throw new Error('插件声明包含无法静态解析的条目');
          }
          if (ids.has(row.id)) throw new Error('插件声明包含重复条目: ' + row.id);
          ids.add(row.id);
          entries.push({ id: row.id, name: row.name, disabled: row.disabled === true });
        }
      }
    }
    if (!entries.length) throw new Error('插件没有可独立切换的声明条目');
    return { ok: true, entries, entryIds: entries.map((entry) => entry.id) };
  } catch (error) {
    // Avoid returning filesystem paths from native fs errors to the client.
    return { ok: false, error: error instanceof Error && !('code' in error)
      ? error.message : '无法读取插件的安装元数据或补丁' };
  }
}

/** Refuse overlapping ownership, including rows belonging to a core bundle. */
export function resolveBundleIdentities(profileDir: string, packageNames: readonly string[]): BundleIdentities {
  const results: BundleIdentities = Object.create(null) as BundleIdentities;
  const owners = new Map<string, string[]>();
  for (const name of new Set(packageNames)) {
    const identity = resolveBundleIdentity(profileDir, name);
    results[name] = identity;
    if (identity.ok) for (const entry of identity.entries) {
      owners.set(entry.id, [...owners.get(entry.id) || [], name]);
    }
  }
  const unresolvedCore = packageNames.some((name) => KERNEL_BUNDLE_PACKAGES.has(name) && !results[name]?.ok);
  for (const [id, names] of owners) if (names.length > 1) {
    for (const name of names) results[name] = {
      ok: false, error: '插件条目归属冲突: ' + id, entryIds: results[name]?.entryIds || [],
    };
  }
  // A missing/dynamic core declaration cannot be treated as unowned IDs.
  // Otherwise an external bundle could claim permission/plugin-manager rows.
  if (unresolvedCore) {
    for (const [name, identity] of Object.entries(results)) {
      if (!KERNEL_BUNDLE_PACKAGES.has(name) && identity.ok) {
        results[name] = { ok: false, error: '核心插件元数据不可用，无法确认条目归属', entryIds: identity.entryIds };
      }
    }
  }
  return results;
}

/** Apply all bundle overrides atomically in memory; package defaults need explicit false. */
export function toggleBundleInPatch(text: string, identity: Extract<BundleIdentity, { ok: true }>, enabled: boolean): string {
  const doc: Document = parseDocument(text || '[]\n', {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  });
  if (doc.errors.length) throw new Error('用户补丁 YAML 无法解析');
  if (doc.contents === null) doc.contents = doc.createNode([]);
  if (!isSeq(doc.contents)) throw new Error('用户补丁必须是列表');
  const declared = new Map(identity.entries.map((entry) => [entry.id, entry.name]));
  const checkRow = (value: unknown): void => {
    const row = object(value);
    if (row && object(row.id)?.__jsExpr !== undefined) {
      throw new Error('用户补丁包含无法静态解析的插件标识');
    }
    if (row && typeof row.id === 'string' && declared.has(row.id)
      && row.name !== undefined && row.name !== declared.get(row.id)) {
      throw new Error('用户补丁的插件条目归属冲突: ' + row.id);
    }
  };
  const data: unknown = parsePatchData(text || '[]\n') || [];
  for (const value of data as unknown[]) {
    checkRow(value);
    const patch = object(value);
    if (Array.isArray(patch?.insert)) for (const row of patch.insert) checkRow(row);
  }
  for (const entry of identity.entries) {
    const overrides = doc.contents.items.filter((item) => isMap(item) && item.get('id') === entry.id);
    if (overrides.length > 1) throw new Error('用户补丁包含重复插件覆盖: ' + entry.id);
    const existing = overrides[0];
    if (isMap(existing)) existing.set('disabled', !enabled);
    else doc.contents.add(doc.createNode({ id: entry.id, disabled: !enabled }));
  }
  return doc.toString();
}
