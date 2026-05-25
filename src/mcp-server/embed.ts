// Long-lived Python embed worker. Spawns `embed_worker.py` once
// inside the global venv, keeps it alive, queues one embed request
// per stdin line, reads one JSON response per stdout line.
//
// On worker exit (crash, OOM): logs to stderr, restarts after 1 s
// unless the JS side called `close()`.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import readline from 'node:readline';

import { getEmbed, putEmbed } from '../utils/cache.js';

type WorkerOk = { ok: true; vec?: number[]; vecs?: number[][]; scores?: number[] };
type WorkerErr = { ok: false; err?: string };
type WorkerMsg = WorkerOk | WorkerErr;

interface PendingRequest {
  resolve: (v: WorkerOk) => void;
  reject: (e: Error) => void;
}

export interface EmbedWorkerOptions {
  pythonPath: string;
  scriptPath: string;
  /** Forwarded to the worker as WIDE_RESEARCHER_PROJECT_CONFIG so the
   *  worker pulls the same embed-model path the indexer is using. */
  projectConfigPath: string;
  embedProvider: string;
  embedModel: string;
  embedDim: number;
  secretsPath: string | null;
  cohereApiKeyField: string;
}

export class EmbedWorker {
  private readonly pythonPath: string;
  private readonly scriptPath: string;
  private readonly projectConfigPath: string;
  private readonly embedProvider: string;
  private readonly embedModel: string;
  private readonly embedDim: number;
  private readonly secretsPath: string | null;
  private readonly cohereApiKeyField: string;
  private queue: PendingRequest[] = [];
  private ready = false;
  private closed = false;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private readyResolvers: (() => void)[] = [];

  constructor(opts: EmbedWorkerOptions) {
    this.pythonPath = opts.pythonPath;
    this.scriptPath = opts.scriptPath;
    this.projectConfigPath = opts.projectConfigPath;
    this.embedProvider = opts.embedProvider;
    this.embedModel = opts.embedModel;
    this.embedDim = opts.embedDim;
    this.secretsPath = opts.secretsPath;
    this.cohereApiKeyField = opts.cohereApiKeyField;
    this._start();
  }

  private _loadCohereApiKey(): string | null {
    if (this.embedProvider !== 'cohere' || !this.secretsPath) return null;
    try {
      const raw = readFileSync(this.secretsPath, 'utf8');
      const json = JSON.parse(raw) as Record<string, unknown>;
      const key = json[this.cohereApiKeyField];
      return typeof key === 'string' && key.length >= 20 ? key : null;
    } catch {
      return null;
    }
  }

  private _start(): void {
    if (this.closed) return;
    const cohereApiKey = this._loadCohereApiKey();
    this.proc = spawn(this.pythonPath, ['-u', this.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        WIDE_RESEARCHER_PROJECT_CONFIG: this.projectConfigPath,
        PYTHONUNBUFFERED: '1',
        OMP_NUM_THREADS: '2',
        ORT_NUM_THREADS: '2',
        ...(cohereApiKey ? { COHERE_API_KEY: cohereApiKey } : {}),
        COHERE_EMBED_MODEL: this.embedModel,
        COHERE_EMBED_DIM: String(this.embedDim),
      },
    }) as ChildProcessWithoutNullStreams;

    const out = readline.createInterface({ input: this.proc.stdout });
    out.on('line', (line) => {
      const handler = this.queue.shift();
      if (!handler) {
        process.stderr.write(`[embed-worker] unexpected stdout: ${line}\n`);
        return;
      }
      try {
        const msg = JSON.parse(line) as WorkerMsg;
        if (msg.ok) {
          handler.resolve(msg);
        } else {
          handler.reject(new Error(msg.err ?? 'embed worker error'));
        }
      } catch (e) {
        handler.reject(e as Error);
      }
    });

    const err = readline.createInterface({ input: this.proc.stderr });
    err.on('line', (line) => {
      if (line === 'EMBED_WORKER_READY') {
        this.ready = true;
        const resolvers = this.readyResolvers;
        this.readyResolvers = [];
        for (const r of resolvers) r();
        return;
      }
      process.stderr.write(`[embed-worker] ${line}\n`);
    });

    this.proc.on('exit', (code) => {
      this.ready = false;
      const q = this.queue;
      this.queue = [];
      for (const h of q) h.reject(new Error(`embed worker exited code=${code}`));
      if (!this.closed) {
        setTimeout(() => this._start(), 1000);
      }
    });

    this.proc.on('error', (e) => {
      process.stderr.write(`[embed-worker] spawn error: ${e.message}\n`);
    });
  }

  async waitReady(timeoutMs = 30000): Promise<void> {
    if (this.ready) return;
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        const idx = this.readyResolvers.indexOf(wrapped);
        if (idx !== -1) this.readyResolvers.splice(idx, 1);
        reject(new Error('embed worker did not become ready in time'));
      }, timeoutMs);
      const wrapped = (): void => {
        clearTimeout(t);
        resolve();
      };
      this.readyResolvers.push(wrapped);
    });
  }

  private cacheKey(): string {
    return `${this.embedProvider}::${this.embedModel}::${this.embedDim}`;
  }

  async embed(query: string): Promise<number[]> {
    const normalized = String(query).replaceAll('\n', ' ');
    const modelId = this.cacheKey();
    const cached = await getEmbed(modelId, normalized);
    if (cached) return cached;
    await this.waitReady();
    const vec = await new Promise<number[]>((resolve, reject) => {
      this.queue.push({
        resolve: (msg) => {
          if (Array.isArray(msg.vec)) resolve(msg.vec);
          else reject(new Error('embed worker missing vec'));
        },
        reject,
      });
      const req = JSON.stringify({ op: 'embed', text: normalized });
      this.proc?.stdin.write(req + '\n');
    });
    if (vec.length > 0) await putEmbed(modelId, normalized, vec);
    return vec;
  }

  async rerank(query: string, docs: string[]): Promise<number[]> {
    if (docs.length === 0) return [];
    await this.waitReady();
    return new Promise<number[]>((resolve, reject) => {
      this.queue.push({
        resolve: (msg) => {
          if (Array.isArray(msg.scores)) resolve(msg.scores);
          else reject(new Error('embed worker missing scores'));
        },
        reject,
      });
      const req = JSON.stringify({
        op: 'rerank',
        query: String(query).replaceAll('\n', ' '),
        docs,
      });
      this.proc?.stdin.write(req + '\n');
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
