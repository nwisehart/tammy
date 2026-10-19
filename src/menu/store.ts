// The menu index in SQLite: documents, their chunks, and one vector per
// chunk in a sqlite-vec `vec0` table (cosine distance). The vector table is
// created on the first index, sized to the embedding model, and rebuilt when
// the model changes.

import { getMeta, now, setMeta, type Db } from '../db.js';
import type { Chunk } from './chunk.js';
import type { MenuDocument } from './sources.js';

export interface StoredDocument {
  id: number;
  root: string;
  source: string;
  hash: string;
}

export interface Hit {
  chunkId: number;
  /** Cosine similarity, 1 is identical. */
  score: number;
  text: string;
  heading: string;
  trail: string[];
  anchor: string | null;
  line: number;
  source: string;
  label: string;
  url: string | null;
  title: string;
}

export class MenuStore {
  constructor(private readonly db: Db) {}

  /** The embedding model the index was built with, if any. */
  model(): { id: string; dimensions: number } | null {
    const id = getMeta(this.db, 'embedding_model');
    const dims = getMeta(this.db, 'embedding_dimensions');
    return id && dims ? { id, dimensions: Number(dims) } : null;
  }

  private hasVectors(): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'menu_vectors'"
      )
      .get();
  }

  /** Empties the index and sizes the vector table for `model`. */
  reset(model: { id: string; dimensions: number }): void {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM chunks; DELETE FROM documents;');
      this.db.exec('DROP TABLE IF EXISTS menu_vectors');
      this.db.exec(
        `CREATE VIRTUAL TABLE menu_vectors USING vec0(embedding float[${model.dimensions}] distance_metric=cosine)`
      );
      setMeta(this.db, 'embedding_model', model.id);
      setMeta(this.db, 'embedding_dimensions', String(model.dimensions));
    })();
  }

  documents(): StoredDocument[] {
    return this.db
      .prepare('SELECT id, root, source, hash FROM documents')
      .all() as StoredDocument[];
  }

  counts(): { documents: number; chunks: number } {
    const d = this.db.prepare('SELECT count(*) AS n FROM documents').get() as {
      n: number;
    };
    const c = this.db.prepare('SELECT count(*) AS n FROM chunks').get() as {
      n: number;
    };
    return { documents: d.n, chunks: c.n };
  }

  remove(documentId: number): void {
    this.db.transaction(() => {
      const ids = this.db
        .prepare('SELECT id FROM chunks WHERE document_id = ?')
        .all(documentId) as { id: number }[];
      if (this.hasVectors()) {
        const del = this.db.prepare('DELETE FROM menu_vectors WHERE rowid = ?');
        for (const { id } of ids) del.run(BigInt(id));
      }
      this.db
        .prepare('DELETE FROM chunks WHERE document_id = ?')
        .run(documentId);
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(documentId);
    })();
  }

  /** Replaces a document's chunks and vectors in one transaction. */
  put(
    doc: MenuDocument,
    hash: string,
    chunks: Chunk[],
    vectors: Float32Array[]
  ): void {
    if (!this.hasVectors()) throw new Error('the menu index is not set up');
    this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT id FROM documents WHERE source = ?')
        .get(doc.source) as { id: number } | undefined;
      if (existing) this.remove(existing.id);
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO documents (root, source, label, url, title, hash, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(doc.root, doc.source, doc.label, doc.url, doc.title, hash, now());
      const insertChunk = this.db.prepare(
        `INSERT INTO chunks (document_id, ord, heading, trail, anchor, line, text)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const insertVector = this.db.prepare(
        'INSERT INTO menu_vectors (rowid, embedding) VALUES (?, ?)'
      );
      chunks.forEach((chunk, i) => {
        const { lastInsertRowid: chunkId } = insertChunk.run(
          lastInsertRowid,
          chunk.ord,
          chunk.heading,
          JSON.stringify(chunk.trail),
          chunk.anchor,
          chunk.line,
          chunk.text
        );
        insertVector.run(BigInt(chunkId), vectors[i]!);
      });
    })();
  }

  /** The `k` chunks nearest to `vector`, best first. */
  nearest(vector: Float32Array, k: number): Hit[] {
    if (!this.hasVectors()) return [];
    const rows = this.db
      .prepare(
        `SELECT v.rowid AS chunk_id, v.distance, c.text, c.heading, c.trail,
                c.anchor, c.line, d.source, d.label, d.url, d.title
           FROM (SELECT rowid, distance FROM menu_vectors
                  WHERE embedding MATCH ? AND k = ?) v
           JOIN chunks c ON c.id = v.rowid
           JOIN documents d ON d.id = c.document_id
          ORDER BY v.distance`
      )
      .all(vector, k) as {
      chunk_id: number;
      distance: number;
      text: string;
      heading: string;
      trail: string;
      anchor: string | null;
      line: number;
      source: string;
      label: string;
      url: string | null;
      title: string;
    }[];
    return rows.map((r) => ({
      chunkId: Number(r.chunk_id),
      score: 1 - r.distance,
      text: r.text,
      heading: r.heading,
      trail: JSON.parse(r.trail) as string[],
      anchor: r.anchor,
      line: r.line,
      source: r.source,
      label: r.label,
      url: r.url,
      title: r.title,
    }));
  }
}
