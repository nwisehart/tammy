import { cpSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SourceSpec } from '../src/config.js';
import { openDb } from '../src/db.js';
import {
  createEmbedder,
  HASH_MODEL,
  HashEmbedder as Builtin,
  TransformersEmbedder,
} from '../src/menu/embed.js';
import { indexMenu } from '../src/menu/indexer.js';
import { Retriever } from '../src/menu/retrieve.js';
import { loadSources } from '../src/menu/sources.js';
import { MenuStore } from '../src/menu/store.js';
import { HashEmbedder, MENU, tempDir } from './helpers.js';

const OPTIONS = { chunkTokens: 500, overlapTokens: 60 };
const dirs: { cleanup: () => void }[] = [];
afterEach(() => dirs.splice(0).forEach((d) => d.cleanup()));

function setup(menuDir = MENU) {
  const d = tempDir();
  dirs.push(d);
  const db = openDb(join(d.path, 'tammy.db'));
  const store = new MenuStore(db);
  const embedder = new HashEmbedder();
  const specs: SourceSpec[] = [{ kind: 'path', path: menuDir, include: [] }];
  const retriever = new Retriever(store, embedder, { topK: 5, minScore: 0.35 });
  return { dir: d.path, db, store, embedder, specs, retriever };
}

describe('the Pantry menu', () => {
  it('indexes every document and cites what it retrieves', async () => {
    const { store, embedder, specs, retriever } = setup();
    const summary = await indexMenu(store, embedder, specs, OPTIONS);
    expect(summary).toMatchObject({ added: 6, updated: 0, removed: 0 });
    expect(store.counts().documents).toBe(6);

    const result = await retriever.search('how do I share a list');
    expect(result.thin).toBe(false);
    const top = result.passages[0]!;
    expect(top.label).toBe('menu/sharing.md');
    expect(top.citation).toMatchObject({
      source: 'menu/sharing.md',
      url: null,
      anchor: expect.any(String),
    });
    expect(top.citation.line).toBeGreaterThan(0);
    expect(
      result.passages.some((p) => p.heading === 'Sharing a list with someone')
    ).toBe(true);
  });

  it('finds the right section for other questions', async () => {
    const { store, embedder, specs, retriever } = setup();
    await indexMenu(store, embedder, specs, OPTIONS);
    const password = await retriever.search('I forgot my password');
    expect(password.passages[0]!.heading).toBe('Forgotten your password');
    const bought = await retriever.search('mark an item bought');
    expect(bought.passages[0]!.label).toBe('menu/items.md');
  });

  it('says the result is thin when nothing matches', async () => {
    const { store, embedder, specs, retriever } = setup();
    await indexMenu(store, embedder, specs, OPTIONS);
    const result = await retriever.search(
      'quarterly tax filing deadlines in Belgium'
    );
    expect(result.thin).toBe(true);
  });

  it('re-embeds only what changed, and drops what is gone', async () => {
    const d = tempDir();
    dirs.push(d);
    const menu = join(d.path, 'docs');
    cpSync(MENU, menu, { recursive: true });
    const { store, embedder, specs } = setup(menu);

    await indexMenu(store, embedder, specs, OPTIONS);
    const firstCalls = embedder.calls;

    const again = await indexMenu(store, embedder, specs, OPTIONS);
    expect(again).toMatchObject({
      added: 0,
      updated: 0,
      unchanged: 6,
      removed: 0,
    });
    expect(embedder.calls).toBe(firstCalls);

    writeFileSync(
      join(menu, 'faq.md'),
      '# FAQ\n\n## Is Pantry free?\n\nYes.\n'
    );
    rmSync(join(menu, 'accounts.md'));
    const changed = await indexMenu(store, embedder, specs, OPTIONS);
    expect(changed).toMatchObject({
      added: 0,
      updated: 1,
      unchanged: 4,
      removed: 1,
    });
    expect(embedder.calls).toBe(firstCalls + 1);
    expect(store.counts().documents).toBe(5);

    const full = await indexMenu(store, embedder, specs, {
      ...OPTIONS,
      full: true,
    });
    expect(full.added).toBe(5);
  });

  it('refuses to search an index built with another model', async () => {
    const { store, embedder, specs, db } = setup();
    await indexMenu(store, embedder, specs, OPTIONS);
    const other = new HashEmbedder();
    Object.defineProperty(other, 'id', { value: 'another/model' });
    const retriever = new Retriever(new MenuStore(db), other, {
      topK: 5,
      minScore: 0.3,
    });
    await expect(retriever.search('share')).rejects.toThrow(
      /tammy index --full/
    );
  });
});

describe('the embedder', () => {
  const config = {
    model: 'Xenova/all-MiniLM-L6-v2',
    quantized: true,
    localDir: null,
    cacheDir: '/nonexistent',
  };

  it('is the local sentence model unless builtin:hash is asked for', () => {
    expect(createEmbedder(config, false)).toBeInstanceOf(TransformersEmbedder);
    const hash = createEmbedder({ ...config, model: HASH_MODEL }, false);
    expect(hash).toBeInstanceOf(Builtin);
    expect(hash.id).toBe('builtin:hash');
  });

  it('hashes the same words to the same unit vector', async () => {
    const [a, b, c] = await new Builtin().embed([
      'Sharing lists',
      'share a list',
      'forgotten password',
    ]);
    const dot = (x: Float32Array, y: Float32Array) =>
      x.reduce((n, v, i) => n + v * y[i]!, 0);
    expect(dot(a!, a!)).toBeCloseTo(1);
    expect(dot(a!, b!)).toBeCloseTo(1);
    expect(dot(a!, c!)).toBeCloseTo(0);
  });
});

describe('web sources', () => {
  const pages: Record<string, string> = {
    'https://docs.example.com/guide/': `<html><head><title>Guide</title></head><body><main>
      <h1>Guide</h1><p>Start here.</p>
      <a href="/guide/sharing">Sharing</a> <a href="https://elsewhere.example.org/x">Elsewhere</a>
      <a href="#top">Top</a></main></body></html>`,
    'https://docs.example.com/guide/sharing': `<html><head><title>Sharing</title></head><body><main>
      <h2 id="share">Share a list</h2><p>Type their email and press Share.</p>
      <a href="/guide/deeper">Deeper</a></main></body></html>`,
    'https://docs.example.com/guide/deeper': `<html><body><p>Too deep.</p></body></html>`,
    'https://elsewhere.example.org/x': `<html><body><p>Not ours.</p></body></html>`,
  };
  const fetched: string[] = [];
  const fakeFetch = (async (url: string | URL) => {
    const key = String(url);
    fetched.push(key);
    const body = pages[key];
    return new Response(body ?? 'missing', {
      status: body ? 200 : 404,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }) as typeof fetch;

  it('crawls to the configured depth on the same origin only', async () => {
    fetched.length = 0;
    const { documents, failedRoots } = await loadSources(
      [
        {
          kind: 'url',
          url: 'https://docs.example.com/guide/',
          depth: 1,
          include: [],
        },
      ],
      { fetch: fakeFetch }
    );
    expect(failedRoots).toEqual([]);
    expect(fetched).toEqual([
      'https://docs.example.com/guide/',
      'https://docs.example.com/guide/sharing',
    ]);
    expect(documents.map((d) => d.url)).toEqual(fetched);
  });

  it('cites a web passage as a link to its section', async () => {
    const { store, embedder, retriever } = setup();
    await indexMenu(
      store,
      embedder,
      [
        {
          kind: 'url',
          url: 'https://docs.example.com/guide/',
          depth: 1,
          include: [],
        },
      ],
      { ...OPTIONS, fetch: fakeFetch }
    );
    const result = await retriever.search('share a list email');
    expect(result.passages[0]!.citation).toMatchObject({
      heading: 'Share a list',
      url: 'https://docs.example.com/guide/sharing#share',
    });
  });

  it('keeps the documents of a source that could not be read this time', async () => {
    const { store, embedder, retriever } = setup();
    const spec: SourceSpec = {
      kind: 'url',
      url: 'https://docs.example.com/guide/',
      depth: 1,
      include: [],
    };
    await indexMenu(store, embedder, [spec], { ...OPTIONS, fetch: fakeFetch });
    const down = (async () => {
      throw new Error('connection refused');
    }) as typeof fetch;
    const summary = await indexMenu(store, embedder, [spec], {
      ...OPTIONS,
      fetch: down,
    });
    expect(summary.failedRoots).toEqual([spec.url]);
    expect(summary.removed).toBe(0);
    expect(
      (await retriever.search('share a list')).passages.length
    ).toBeGreaterThan(0);
  });
});
