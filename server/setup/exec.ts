import { execFile } from 'child_process';

export type Run = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number }
) => Promise<{ stdout: string; stderr: string }>;

/** Runs a command via execFile (never a shell); args are passed as a literal argv array. */
export const run: Run = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: opts?.timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as Error & { stdout?: string; stderr?: string };
          e.stdout = String(stdout);
          e.stderr = String(stderr);
          reject(e);
        } else {
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        }
      }
    );
  });
