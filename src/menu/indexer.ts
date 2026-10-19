// `tammy index`: reads the sources, chunks and embeds what changed, and
// drops what is gone. A document is re-embedded only when its content hash
// changed, so re-running it over an unchanged menu costs one read per file.

import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';

import type { SourceSpec } from '../config.js';
import { silentLogger, type Logger } from '../log.js';
import { chunkDocument, embeddingText, type ChunkOptions } from './chunk.js';
import type { Embedder } from './embed.js';
import { loadSources } from './sources.js';
import type { MenuStore } from './store.js';

export interface IndexOptions extends ChunkOptions {
  /** Re-embed every document, not just the changed ones. */
  full?: boolean;
  log?: Logger;
  fetch?: typeof fetch;
}

export interface IndexSummary {
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  chunks: number;
  failedRoots: string[];
}

export function contentHash(text: string, options: ChunkOptions): string {
  return createHash('sha256')
    .update(`${options.chunkTokens}:${options.overlapTokens}\n`)
    .update(text)
    .digest('hex');
}

export async function indexMenu(
  store: MenuStore,
  embedder: Embedder,
  specs: SourceSpec[],
  options: IndexOptions
): Promise<IndexSummary> {
  const log = options.log ?? silentLogger;
  const { documents, failedRoots } = await loadSources(specs, {
    log,
    fetch: options.fetch,
  });
  const summary: IndexSummary = {
    added: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    chunks: 0,
    failedRoots,
  };

  const built = store.model();
  let needsReset = options.full || !built || built.id !== embedder.id;
  if (built && built.id !== embedder.id) {
    log.info(
      `embedding model changed (${built.id} → ${embedder.id}); rebuilding`
    );
  }

  const existing = new Map(
    needsReset ? [] : store.documents().map((d) => [d.source, d])
  );
  const seen = new Set<string>();
  for (const doc of documents) {
    seen.add(doc.source);
    const hash = contentHash(doc.text, options);
    const before = existing.get(doc.source);
    if (before && before.hash === hash) {
      summary.unchanged++;
      continue;
    }
    const chunks = chunkDocument(
      {
        title: doc.title,
        text: doc.text,
        markdown: !doc.source.endsWith('.txt'),
      },
      options
    );
    if (chunks.length === 0) continue;
    const vectors = await embedder.embed(
      chunks.map((c) => embeddingText(doc.title, c))
    );
    if (needsReset) {
      store.reset({ id: embedder.id, dimensions: vectors[0]!.length });
      needsReset = false;
    }
    store.put(doc, hash, chunks, vectors);
    summary.chunks += chunks.length;
    if (before) summary.updated++;
    else summary.added++;
    log.info(`${doc.label}: ${chunks.length} chunk(s)`);
  }

  // What the last run read is the menu: documents no longer found are
  // dropped, except under a source that could not be read this time.
  const failed = new Set(failedRoots);
  for (const doc of store.documents()) {
    if (seen.has(doc.source) || failed.has(doc.root)) continue;
    store.remove(doc.id);
    summary.removed++;
  }
  return summary;
}

/**
 * Re-runs an incremental index whenever a file under a local source changes,
 * half a second after the last change. Web sources are not watched.
 */
export function watchMenu(
  specs: SourceSpec[],
  reindex: () => Promise<void>,
  log: Logger = silentLogger
): () => void {
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | null = null;
  let running = Promise.resolve();
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      running = running.then(reindex).catch((error: unknown) => {
        log.error(
          `re-index failed: ${error instanceof Error ? error.message : error}`
        );
      });
    }, 500);
  };
  for (const spec of specs) {
    if (spec.kind !== 'path') continue;
    try {
      watchers.push(watch(spec.path, { recursive: true }, schedule));
      log.info(`watching ${spec.path}`);
    } catch (error) {
      log.warn(
        `cannot watch ${spec.path}: ${error instanceof Error ? error.message : error}`
      );
    }
  }
  return () => {
    if (timer) clearTimeout(timer);
    watchers.forEach((w) => w.close());
  };
}
