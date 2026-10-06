import fs = require('node:fs');
import path = require('node:path');
import { PNPM_VERSION, PNPM_RUNTIME_FILES } from '../lib/desktop/package-manager';

/** pnpm is an exact, integrity-locked build dependency copied into the runtime. */
export function copyBundledPnpm(source: string, destination: string): void {
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')) as { version?: string };
  if (pkg.version !== PNPM_VERSION || PNPM_RUNTIME_FILES.some((file) => !fs.existsSync(path.join(source, file)))) {
    throw new Error(`Expected pnpm@${PNPM_VERSION}; run npm ci before fetching runtimes.`);
  }
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  copyBundledPnpm(path.join(root, 'node_modules', 'pnpm'), path.join(root, 'vendor', 'pnpm'));
  console.log(`Bundled pnpm@${PNPM_VERSION}`);
}
