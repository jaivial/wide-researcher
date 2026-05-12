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

export interface PickEmbedModelOptions {
  /** Skip the interactive picker; use this provider directly. */
  forceProvider?: EmbedProvider;
  /** Skip API-key prompt; use this value (for CI / scripted installs). */
  apiKey?: string;
}

export interface PickEmbedModelResult {
  model: EmbedModel;
  /** Set when the chosen model required a key + we just stored it. */
  apiKeyStored?: boolean;
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
    if (m.requiresApiKey && opts.apiKey) {
      const field = m.apiKeySecretField!;
      await setSecret(field, opts.apiKey);
      return { model: m, apiKeyStored: true };
    }
    return { model: m };
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
    return { model };
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
  return { model, apiKeyStored: true };
}
