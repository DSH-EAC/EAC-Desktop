import { spawn } from 'node:child_process';
import { childProcessSpawnOptions, killTreeAndWait } from './proc';

export interface RemovePluginOptions {
  node: string;
  carrier: string;
  kernel: string;
  profile: string;
  name: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Delegate to the kernel transaction; it owns lockfiles, rollback and removal. */
export function removePluginPackage(options: RemovePluginOptions): Promise<{ ok: boolean; error?: string; restartRequired?: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(options.node, [options.carrier, 'plugin', '--profile', options.profile, 'remove', options.name], {
      ...childProcessSpawnOptions(),
      cwd: options.cwd,
      env: { ...options.env, DSH_EAC_KERNEL_BIN: options.kernel, DSH_BIN: options.carrier },
      windowsHide: true,
      stdio: 'ignore',
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void killTreeAndWait(child).then(() => resolve({ ok: false, error: 'Plugin uninstall timed out; check the plugin manager before retrying.' }));
    }, options.timeoutMs ?? 120_000);
    child.once('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, error: 'Could not start the bundled plugin manager.' });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      resolve(code === 0
        ? { ok: true, restartRequired: true }
        : { ok: false, error: `Plugin uninstall failed (exit ${code ?? 'signal'}); the kernel retains its transaction diagnostics.` });
    });
  });
}
