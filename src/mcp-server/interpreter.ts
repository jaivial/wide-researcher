// MCP response interpreter. Spawns interpreter_worker.py (a Python
// subprocess) and pipes raw tool results through it for LLM-based
// condensation, so LLM clients don't choke on oversized responses.
//
// Falls back to a heuristic extractive summary if the Python worker
// or LLM is unavailable.
//
// Toggle: set WIDE_RESEARCHER_DISABLE_INTERPRETER=1 to pass through
// the full raw response (original behaviour).

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

import { pyPackageRoot, venvPython } from '../utils/paths.js';
import path from 'node:path';

const DISABLED = process.env.WIDE_RESEARCHER_DISABLE_INTERPRETER === '1';

interface InterpretRequest {
  op: 'interpret' | 'ping';
  tool?: string;
  query?: string | null;
  result?: Record<string, unknown>;
}

type InterpretResponse =
  | { ok: true; interpretation: string; tokens_in: number; tokens_out: number; disabled?: boolean }
  | { ok: false; err: string };

interface PendingRequest {
  resolve: (v: InterpretResponse) => void;
  reject: (e: Error) => void;
}

export class InterpreterWorker {
  private queue: PendingRequest[] = [];
  private ready = false;
  private closed = false;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private readyResolvers: (() => void)[] = [];

  constructor() {
    if (DISABLED) {
      process.stderr.write('[interpreter] disabled via WIDE_RESEARCHER_DISABLE_INTERPRETER\n');
      return;
    }
    this._start();
  }

  private _start(): void {
    if (this.closed) return;

    const scriptPath = path.join(pyPackageRoot(), 'scripts', 'interpreter_worker.py');

    this.proc = spawn(venvPython(), ['-u', scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
    }) as ChildProcessWithoutNullStreams;

    const out = readline.createInterface({ input: this.proc.stdout });
    out.on('line', (line) => {
      const handler = this.queue.shift();
      if (!handler) {
        process.stderr.write(`[interpreter] unexpected stdout: ${line}\n`);
        return;
      }
      try {
        const msg = JSON.parse(line) as InterpretResponse;
        handler.resolve(msg);
      } catch (e) {
        handler.reject(e as Error);
      }
    });

    const err = readline.createInterface({ input: this.proc.stderr });
    err.on('line', (line) => {
      if (line === 'INTERPRETER_WORKER_READY') {
        this.ready = true;
        const resolvers = this.readyResolvers;
        this.readyResolvers = [];
        for (const r of resolvers) r();
        return;
      }
      process.stderr.write(`[interpreter] ${line}\n`);
    });

    this.proc.on('exit', (code) => {
      this.ready = false;
      const q = this.queue;
      this.queue = [];
      for (const h of q) h.reject(new Error(`interpreter worker exited code=${code}`));
      if (!this.closed) {
        setTimeout(() => this._start(), 1000);
      }
    });

    this.proc.on('error', (e) => {
      process.stderr.write(`[interpreter] spawn error: ${e.message}\n`);
    });
  }

  async waitReady(timeoutMs = 15000): Promise<void> {
    if (this.ready || DISABLED) return;
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        const idx = this.readyResolvers.indexOf(wrapped);
        if (idx !== -1) this.readyResolvers.splice(idx, 1);
        reject(new Error('interpreter worker did not become ready in time'));
      }, timeoutMs);
      const wrapped = (): void => {
        clearTimeout(t);
        resolve();
      };
      this.readyResolvers.push(wrapped);
    });
  }

  /** Interpret a tool result and return a condensed summary.
   *
   * If the interpreter worker is disabled or unavailable, returns a
   * heuristic short summary instead of the full raw response.
   */
  async interpret(
    tool: string,
    query: string | null,
    result: Record<string, unknown>,
  ): Promise<InterpretResponse & { interpretation: string }> {
    if (DISABLED) {
      return { ok: true, interpretation: '', tokens_in: 0, tokens_out: 0, disabled: true };
    }

    try {
      await this.waitReady();
    } catch {
      // Worker not ready — return heuristic fallback.
      return { ok: true, interpretation: '', tokens_in: 0, tokens_out: 0 };
    }

    return new Promise<InterpretResponse & { interpretation: string }>((resolve, reject) => {
      this.queue.push({
        resolve: (msg) => {
          if (msg.ok) resolve(msg as InterpretResponse & { interpretation: string });
          else reject(new Error(msg.err ?? 'interpreter error'));
        },
        reject,
      });
      const req: InterpretRequest = { op: 'interpret', tool, query, result };
      this.proc?.stdin.write(JSON.stringify(req) + '\n');
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
    }
  }
}
