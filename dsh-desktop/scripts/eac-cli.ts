import path = require('node:path');
import { pathToFileURL } from 'node:url';
import { bundledPackageManager } from '../lib/desktop/package-manager';

// Keep import() native in the CommonJS build: the selected kernel is ESM.
const importKernel = new Function('url', 'return import(url)') as (url: string) => Promise<{
  runCli?: (options: { packageManager: ReturnType<typeof bundledPackageManager> }) => Promise<void>;
}>;

export async function run(): Promise<void> {
  const root = path.resolve(__dirname, '..');
  const kernel = process.env.DSH_EAC_KERNEL_BIN || require.resolve('@deepseek-ai/dsh/lib/bin.js');
  const packageManager = bundledPackageManager(root, process.execPath);
  const cli = await importKernel(pathToFileURL(kernel).href);
  if (typeof cli.runCli !== 'function') throw new Error('Selected DSH kernel does not support the desktop CLI launcher.');
  // Market reinvocations retain the selected overlay and this carrier.
  process.env.DSH_EAC_KERNEL_BIN = kernel;
  process.env.DSH_BIN = __filename;
  await cli.runCli({ packageManager });
}

if (require.main === module) {
  void run().catch((error: unknown) => {
    console.error('[eac-cli]', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
