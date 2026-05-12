// Small spawn wrapper that streams stdout/stderr to the parent process
// and rejects on non-zero exit. Used by every installer.

import { spawn, type SpawnOptions } from 'node:child_process';

export interface RunOptions extends SpawnOptions {
  /** When true, capture stdout/stderr instead of streaming. */
  capture?: boolean;
  /** Echo the command being run to stderr before spawning. */
  echo?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(
  cmd: string,
  args: string[] = [],
  opts: RunOptions = {},
): Promise<RunResult> {
  const { capture, echo, stdio, ...rest } = opts;

  if (echo) {
    process.stderr.write(`$ ${cmd} ${args.join(' ')}\n`);
  }

  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(cmd, args, {
      ...rest,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : stdio ?? 'inherit',
    });

    let out = '';
    let err = '';
    child.stdout?.on('data', (b: Buffer) => {
      out += b.toString('utf8');
    });
    child.stderr?.on('data', (b: Buffer) => {
      err += b.toString('utf8');
    });

    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      const result: RunResult = { code: code ?? -1, stdout: out, stderr: err };
      if ((code ?? -1) !== 0) {
        const e = new Error(
          `${cmd} ${args.join(' ')} exited ${code}${err ? `\n${err}` : ''}`,
        );
        (e as { result?: RunResult }).result = result;
        reject(e);
        return;
      }
      resolve(result);
    });
  });
}

export async function which(cmd: string): Promise<string | null> {
  try {
    const r = await run('which', [cmd], { capture: true });
    return r.stdout.trim() || null;
  } catch {
    return null;
  }
}
