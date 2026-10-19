// Retrieval: the query is embedded with the index's own model and the
// nearest chunks come back with a citation each. A result whose best score is
// below `min_score` is "thin": the menu has nothing solid on the question,
// and Tammy says she does not know rather than guess.

import type { Embedder } from './embed.js';
import type { Hit, MenuStore } from './store.js';

export interface Citation {
  /** The section's heading. */
  heading: string;
  /** `docs/sharing.md`, or the page URL. */
  source: string;
  /** A link to the section, for web sources (`<url>#<anchor>`). */
  url: string | null;
  anchor: string | null;
  line: number;
}

export interface Passage extends Hit {
  citation: Citation;
}

export interface SearchResult {
  query: string;
  passages: Passage[];
  /** True when nothing scored at least `min_score`. */
  thin: boolean;
  best: number;
}

export function citationFor(hit: Hit): Citation {
  let url: string | null = null;
  if (hit.url) {
    const u = new URL(hit.url);
    if (hit.anchor) u.hash = hit.anchor;
    url = u.toString();
  }
  return {
    heading: hit.heading,
    source: hit.label,
    url,
    anchor: hit.anchor,
    line: hit.line,
  };
}

/** `docs/sharing.md#sharing-a-list (line 12)`, for logs and the CLI. */
export function describeCitation(c: Citation): string {
  if (c.url) return c.url;
  return `${c.source}${c.anchor ? `#${c.anchor}` : ''} (line ${c.line})`;
}

export class Retriever {
  constructor(
    private readonly store: MenuStore,
    private readonly embedder: Embedder,
    private readonly options: { topK: number; minScore: number }
  ) {}

  /** Whether an index exists, and how big it is. */
  status(): { model: string | null; documents: number; chunks: number } {
    return { model: this.store.model()?.id ?? null, ...this.store.counts() };
  }

  async search(query: string, k = this.options.topK): Promise<SearchResult> {
    const built = this.store.model();
    if (!built) return { query, passages: [], thin: true, best: 0 };
    if (built.id !== this.embedder.id) {
      throw new Error(
        `the menu was indexed with ${built.id}, not ${this.embedder.id}; run tammy index --full`
      );
    }
    const [vector] = await this.embedder.embed([query]);
    const hits = this.store.nearest(vector!, k);
    const passages = hits.map((hit) => ({
      ...hit,
      citation: citationFor(hit),
    }));
    const best = passages[0]?.score ?? 0;
    return { query, passages, thin: best < this.options.minScore, best };
  }
}
