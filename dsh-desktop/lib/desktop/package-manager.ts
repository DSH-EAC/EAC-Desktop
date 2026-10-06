import fs = require('node:fs');
import path = require('node:path');

export const PNPM_VERSION = '11.7.0';
export const PNPM_RUNTIME_FILES = ['bin/pnpm.cjs', 'bin/pnpm.mjs', 'dist/pnpm.mjs'];

export interface PackageManagerInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Use a JS entry, never a .cmd shim or a package manager from the user's PATH. */
export function bundledPackageManager(appRoot: string, node: string): PackageManagerInvocation {
  const root = path.join(appRoot, 'vendor', 'pnpm');
  const entry = path.join(root, 'bin', 'pnpm.cjs');
  let version: unknown;
  try { version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; }
  catch { throw new Error('Bundled pnpm is missing; rebuild the runtime with npm run fetch-pnpm.'); }
  if (version !== PNPM_VERSION || PNPM_RUNTIME_FILES.some((file) => !fs.existsSync(path.join(root, file)))) {
    throw new Error(`Bundled pnpm must be ${PNPM_VERSION}; rebuild the runtime with npm run fetch-pnpm.`);
  }
  if (!fs.existsSync(node)) throw new Error('Bundled Node runtime is missing.');
  // Pnpm lifecycle commands may invoke node. Put this runtime first without
  // discarding the system tools needed by explicitly approved build scripts.
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const inherited = process.env[pathKey] || '';
  return { command: node, args: [entry], env: { [pathKey]: [path.dirname(node), inherited].filter(Boolean).join(path.delimiter) } };
}
