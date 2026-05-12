// Interactive embed-model picker.
// Runs during `init`. Asks the user which embed model to use, then
// (if Cohere) prompts for an API key and stores it in secrets.json.

import { ask, askSecret, select } from '../utils/prompt.js';
import { setSecret, secretsFilePath } from '../utils/secrets.js';
import {
  DEFAULT_PROVIDER,
  EMBED_MODELS,
  modelById,
  type EmbedModel,
  type EmbedProvider,
} from '../models/registry.js';
import { log } from '../utils/log.js';
import { deriveProjectIdentity } from './claude-bundle.js';
import {
  findLatestBackup,
  getCollectionInfo,
  snapshotCollection,
} from '../utils/qdrant-snapshot.js';

export interface PickEmbedModelOptions {
  /** Skip the interactive picker; use this provider directly. */
  forceProvider?: EmbedProvider;
  /** Skip API-key prompt; use this value (for CI / scripted installs). */
  apiKey?: string;
  /** Project cwd — used to detect existing collection + offer backup. */
  cwd?: string;
  /** Skip the "reindex required, proceed?" reconfirmation prompt. */
  noConfirmReindex?: boolean;
  /** Skip the "restore from previous backup?" prompt. */
  noOfferRestore?: boolean;
}

export interface PickEmbedModelResult {
  model: EmbedModel;
  /** Set when the chosen model required a key + we just stored it. */
  apiKeyStored?: boolean;
  /** Path to a saved snapshot of the old collection (if we just snapshotted). */
  oldCollectionBackup?: string;
  /** Path to a previously-saved snapshot we should restore from. */
  restoreFromBackup?: string;
}

/** Lightweight live-test that the Cohere key actually works. */
async function validateCohereKey(apiKey: string, modelId: string): Promise<boolean> {
  try {
    const res = await fetch('https://api.cohere.com/v2/embed', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        input_type: 'search_document',
        embedding_types: ['float'],
        texts: ['probe'],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn(`Cohere API validation returned HTTP ${res.status}: ${body.slice(0, 200)}`);
      return false;
    }
    const j = (await res.json()) as { embeddings?: { float?: number[][] } };
    return Array.isArray(j.embeddings?.float) && (j.embeddings!.float![0]?.length ?? 0) > 0;
  } catch (e) {
    log.warn(`Cohere API validation failed: ${(e as Error).message}`);
    return false;
  }
}

export async function pickEmbedModel(
  opts: PickEmbedModelOptions = {},
): Promise<PickEmbedModelResult> {
  // Non-interactive path
  if (opts.forceProvider) {
    const m = modelById(opts.forceProvider);
    const r: PickEmbedModelResult = { model: m };
    if (m.requiresApiKey && opts.apiKey) {
      const field = m.apiKeySecretField!;
      await setSecret(field, opts.apiKey);
      r.apiKeyStored = true;
    }
    // CI / scripted mode → never prompt; auto-snapshot if dim differs.
    await augmentWithReindexFlow(r, { ...opts, noConfirmReindex: true, noOfferRestore: true });
    return r;
  }

  // Interactive picker
  const choices = Object.values(EMBED_MODELS).map((m) => ({
    value: m.provider,
    label: m.label,
    description: `${m.description} · ${m.pricingNote ?? ''}`,
  }));
  const defaultIdx = choices.findIndex((c) => c.value === DEFAULT_PROVIDER);
  const provider = await select('Which embed model do you want to use?', choices, defaultIdx >= 0 ? defaultIdx : 0);
  const model = modelById(provider);

  if (!model.requiresApiKey) {
    log.ok(`embed model: ${model.label}`);
    const r: PickEmbedModelResult = { model };
    await augmentWithReindexFlow(r, opts);
    return r;
  }

  // API key required — prompt for it
  log.info(`${model.label} requires an API key.`);
  log.info(`This is stored in ${secretsFilePath()} with mode 600 (user-only).`);
  log.info('You can rotate / remove it later with `wide-researcher embed-model set` (TBD in v0.2).');
  const key = await askSecret(`Paste your Cohere production API key (input hidden): `);

  if (!key || key.length < 20) {
    throw new Error(
      'No API key entered (or key suspiciously short). Re-run `wide-researcher init` ' +
        'when you have it, or pick MiniLM-L6 instead.',
    );
  }

  log.step('validating API key against Cohere /v2/embed');
  const ok = await validateCohereKey(key, model.modelId);
  if (!ok) {
    const cont = await ask(
      'Validation failed. Store the key anyway and continue? (you can fix it later) [y/N]: ',
      'N',
    );
    if (!cont.toLowerCase().startsWith('y')) {
      throw new Error('Aborted by user after Cohere key validation failure.');
    }
  }

  const field = model.apiKeySecretField!;
  await setSecret(field, key);
  log.ok(`API key stored at ${secretsFilePath()}`);
  const cohereResult: PickEmbedModelResult = { model, apiKeyStored: true };
  await augmentWithReindexFlow(cohereResult, opts);
  return cohereResult;
}

/* ── reindex-confirmation + backup/restore flow ──────────────────────── */

/**
 * After a model is chosen, check if an existing Qdrant collection
 * uses a DIFFERENT vector dimensionality. If so:
 *
 *   1. Tell the user a full reindex is required (cost / time hint).
 *   2. Reconfirm via [y/N].
 *   3. Snapshot the existing collection into
 *      ~/.wide-researcher/backups/<slug>__<old-provider>__<ts>.snapshot
 *   4. Detect any previously-saved backup matching the NEW provider
 *      and offer to restore it (skip reindex).
 *
 * Mutates `result` with `oldCollectionBackup` / `restoreFromBackup`
 * so the downstream installer can act on them.
 */
async function augmentWithReindexFlow(
  result: PickEmbedModelResult,
  opts: PickEmbedModelOptions,
): Promise<void> {
  const id = deriveProjectIdentity(opts.cwd);
  const info = await getCollectionInfo(id.slug);

  if (!info.exists) {
    // Fresh install — no reindex worry, no backup to make.
    return;
  }

  const newDim = result.model.embedDim;
  const oldDim = info.vectorSize;
  const dimMismatch = oldDim !== undefined && oldDim !== newDim;

  if (!dimMismatch) {
    log.skip(
      `existing collection ${id.slug} already at dim=${newDim} — no reindex needed.`,
    );
    return;
  }

  // Infer old provider from dim (best-effort)
  const oldProvider: EmbedProvider =
    oldDim === 1536 ? 'cohere' : oldDim === 384 ? 'local-minilm' : 'unknown' as EmbedProvider;

  // (1) Look for an existing backup of the NEW provider — saves a reindex
  if (!opts.noOfferRestore) {
    const existing = await findLatestBackup(id.slug, result.model.provider);
    if (existing) {
      log.info(
        `Found previous backup for provider=${result.model.provider}:\n` +
          `  ${existing.filename}\n` +
          `  Restoring this snapshot skips the full reindex.`,
      );
      const ans = await ask(
        `Restore from this backup instead of reindexing? [Y/n]: `,
        'Y',
      );
      if (!ans.toLowerCase().startsWith('n')) {
        result.restoreFromBackup = existing.absPath;
        log.ok(`will restore from ${existing.absPath}`);
        // Even though we restore, also back up the CURRENT collection
        // first (so the user can flip back later without reindex).
        await maybeSnapshot(id.slug, oldProvider, result);
        return;
      }
    }
  }

  // (2) No restore available (or user declined) → reindex required.
  log.warn(
    `\nSwitching from dim=${oldDim} (${oldProvider}) → dim=${newDim} (${result.model.provider})\n` +
      `requires a FULL REINDEX of the qdrant collection (existing vectors\n` +
      `become invalid). Approximate cost:\n` +
      (result.model.provider === 'cohere'
        ? `  • Cohere API: ~$0.10 / 1M input tokens. A 5,000-file repo runs\n` +
          `    ~$2-5. Time: ~3-5 min (network-bound, batched at 96/req).\n`
        : `  • Local MiniLM: $0 (CPU-only). Time: ~5 min on a 5,000-file repo.\n`),
  );

  if (!opts.noConfirmReindex) {
    const ans = await ask(
      `Proceed with full reindex? Old collection will be backed up first. [y/N]: `,
      'N',
    );
    if (!ans.toLowerCase().startsWith('y')) {
      throw new Error(
        'Reindex declined by user. Existing collection left untouched. ' +
          'Re-run with the previously-chosen model to abort cleanly, or pass ' +
          '`--no-confirm-reindex` to skip this prompt next time.',
      );
    }
  }

  // (3) Snapshot the existing collection BEFORE we recreate it.
  await maybeSnapshot(id.slug, oldProvider, result);
}

async function maybeSnapshot(
  slug: string,
  oldProvider: EmbedProvider,
  result: PickEmbedModelResult,
): Promise<void> {
  try {
    const snapshotPath = await snapshotCollection(slug, oldProvider);
    result.oldCollectionBackup = snapshotPath;
  } catch (e) {
    log.warn(
      `Snapshot failed: ${(e as Error).message}\n` +
        `Continuing anyway — reindex will proceed without a backup.`,
    );
  }
}
