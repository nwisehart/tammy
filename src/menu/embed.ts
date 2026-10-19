// Sentence embeddings, computed on this machine. Anthropic offers no
// embeddings API, so the menu is embedded locally with a small sentence
// model (all-MiniLM-L6-v2 by default, 384 dimensions) through
// @xenova/transformers. The model is downloaded once, by `tammy index`, into
// `<data_dir>/models`; at query time Tammy never goes to the network.
//
// `model = "builtin:hash"` swaps in a word-hashing embedder that needs no
// download at all. It matches on shared words rather than meaning, so it is
// for tests, CI and machines that cannot reach Hugging Face, not for
// customers.

import type { EmbeddingsConfig } from '../config.js';

export interface Embedder {
  /** Identifies the model; an index built with another one is rebuilt. */
  readonly id: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** The `menu.embeddings.model` value that selects {@link HashEmbedder}. */
export const HASH_MODEL = 'builtin:hash';

const STOP_WORDS = new Set(
  (
    'a an and are as at be by can do does for from has have how i if in is it ' +
    'its me my of on or so that the their them they this to was we what when ' +
    'where which who why will with you your'
  ).split(' ')
);

function stem(word: string): string {
  return word.replace(/(ing|ed|es|s)$/, '').replace(/e$/, '');
}

/** FNV-1a, 32 bits. */
function fnv(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A deterministic bag-of-words embedder: each stemmed word that is not a
 * stop word is hashed into one of 384 dimensions, and the vector is
 * normalised. No model, no network.
 */
export class HashEmbedder implements Embedder {
  readonly id: string = HASH_MODEL;
  readonly dimensions = 384;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const v = new Float32Array(this.dimensions);
      const words = text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w && !STOP_WORDS.has(w))
        .map(stem);
      for (const w of words) v[fnv(w) % this.dimensions]! += 1;
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
}

/** The embedder `menu.embeddings` names. */
export function createEmbedder(
  config: EmbeddingsConfig,
  allowDownload: boolean
): Embedder {
  return config.model === HASH_MODEL
    ? new HashEmbedder()
    : new TransformersEmbedder(config, allowDownload);
}

type Extractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean }
) => Promise<{ data: Float32Array; dims: number[] }>;

export class TransformersEmbedder implements Embedder {
  readonly id: string;
  private extractor: Promise<Extractor> | null = null;
  private dims = 0;

  constructor(
    private readonly config: EmbeddingsConfig,
    /** Whether the model may be downloaded when it is not cached yet. */
    private readonly allowDownload: boolean
  ) {
    this.id = `${config.model}${config.quantized ? '' : '#fp32'}`;
  }

  get dimensions(): number {
    return this.dims;
  }

  private load(): Promise<Extractor> {
    this.extractor ??= (async () => {
      const transformers = await import('@xenova/transformers');
      const { env, pipeline } = transformers;
      env.cacheDir = this.config.cacheDir;
      env.allowRemoteModels = this.allowDownload;
      if (this.config.localDir) {
        env.localModelPath = this.config.localDir;
        env.allowLocalModels = true;
      } else {
        env.allowLocalModels = false;
      }
      try {
        const extractor = await pipeline(
          'feature-extraction',
          this.config.model,
          { quantized: this.config.quantized }
        );
        return extractor as unknown as Extractor;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const network = /fetch failed/i.test(reason)
          ? ' (the first run downloads it from huggingface.co; behind a proxy, set NODE_USE_ENV_PROXY=1, or see menu.embeddings.local_dir)'
          : '';
        throw new Error(
          this.allowDownload
            ? `could not load the embedding model ${this.config.model}: ${reason}${network}`
            : `the embedding model ${this.config.model} is not in ${this.config.cacheDir}; run tammy index once to download it (${reason})`,
          { cause: error }
        );
      }
    })();
    return this.extractor;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extractor = await this.load();
    const out: Float32Array[] = [];
    // Small batches keep memory flat on a large menu.
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16);
      const tensor = await extractor(batch, {
        pooling: 'mean',
        normalize: true,
      });
      const dim = tensor.dims[tensor.dims.length - 1]!;
      this.dims = dim;
      for (let j = 0; j < batch.length; j++) {
        out.push(tensor.data.slice(j * dim, (j + 1) * dim));
      }
    }
    return out;
  }
}
