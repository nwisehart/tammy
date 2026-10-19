// The menu as the server and the CLI open it.

import type { TammyConfig } from '../config.js';
import type { Db } from '../db.js';
import { createEmbedder, type Embedder } from './embed.js';
import { Retriever } from './retrieve.js';
import { MenuStore } from './store.js';

export interface Menu {
  store: MenuStore;
  embedder: Embedder;
  retriever: Retriever;
}

export function openMenu(
  config: TammyConfig,
  db: Db,
  options: { allowDownload: boolean; embedder?: Embedder }
): Menu {
  const store = new MenuStore(db);
  const embedder =
    options.embedder ??
    createEmbedder(config.menu.embeddings, options.allowDownload);
  const retriever = new Retriever(store, embedder, {
    topK: config.menu.topK,
    minScore: config.menu.minScore,
  });
  return { store, embedder, retriever };
}
