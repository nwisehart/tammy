// Where the menu comes from: local files, directories and globs, and web
// pages crawled from a starting URL. Every source becomes one or more
// documents of markdown-ish text for the chunker.

import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve } from 'node:path';

import { glob, isDynamicPattern } from 'tinyglobby';

import type { SourceSpec } from '../config.js';
import { errorMessage, silentLogger, type Logger } from '../log.js';
import { htmlToMarkdown } from './html.js';

export interface MenuDocument {
  /** The configured source this document came from. */
  root: string;
  /** Unique: the absolute file path, or the page URL. */
  source: string;
  /** How a person would name it: `docs/sharing.md`, or the URL. */
  label: string;
  /** Set for web pages; citations link here. */
  url: string | null;
  title: string;
  /** Markdown (HTML and PDF are converted to it) or plain text. */
  text: string;
}

export interface LoadResult {
  documents: MenuDocument[];
  /** Roots that could not be read at all; their documents are kept. */
  failedRoots: string[];
}

export const DEFAULT_INCLUDE = [
  '**/*.md',
  '**/*.markdown',
  '**/*.mdx',
  '**/*.txt',
  '**/*.html',
  '**/*.htm',
  '**/*.pdf',
];

const MAX_PAGES = 500;
const FETCH_TIMEOUT_MS = 15000;

export function rootOf(spec: SourceSpec): string {
  return spec.kind === 'path' ? spec.path : spec.url;
}

function firstHeading(markdown: string): string | undefined {
  const match = /^#\s+(.+?)\s*(?:\{#[^}]*\})?\s*$/m.exec(markdown);
  return match?.[1];
}

/** PDF text through `unpdf`, when it is installed; one section per page. */
async function pdfToMarkdown(bytes: Uint8Array): Promise<string | null> {
  let unpdf: typeof import('unpdf');
  try {
    unpdf = await import('unpdf');
  } catch {
    return null;
  }
  const { text } = await unpdf.extractText(bytes, { mergePages: false });
  return text
    .map((page, i) => `## Page ${i + 1} {#page=${i + 1}}\n\n${page.trim()}`)
    .join('\n\n');
}

async function readLocal(
  file: string,
  root: string,
  labelBase: string,
  log: Logger
): Promise<MenuDocument | null> {
  const ext = extname(file).toLowerCase();
  const label = relative(labelBase, file) || basename(file);
  const base = { root, source: file, label, url: null };
  const fallbackTitle = basename(file, ext);
  if (ext === '.pdf') {
    const markdown = await pdfToMarkdown(await readFile(file));
    if (markdown === null) {
      log.warn(`${label}: skipped; reading PDFs needs the unpdf package`);
      return null;
    }
    return { ...base, title: fallbackTitle, text: markdown };
  }
  const raw = await readFile(file, 'utf8');
  if (ext === '.html' || ext === '.htm') {
    const page = htmlToMarkdown(raw);
    return {
      ...base,
      title: page.title || fallbackTitle,
      text: page.markdown,
    };
  }
  if (ext === '.txt') return { ...base, title: fallbackTitle, text: raw };
  return { ...base, title: firstHeading(raw) ?? fallbackTitle, text: raw };
}

async function loadPath(
  spec: Extract<SourceSpec, { kind: 'path' }>,
  log: Logger
): Promise<MenuDocument[]> {
  let files: string[];
  let labelBase: string;
  if (isDynamicPattern(spec.path)) {
    files = await glob(spec.path, { absolute: true, onlyFiles: true });
    labelBase = process.cwd();
  } else {
    const info = await stat(spec.path);
    if (info.isDirectory()) {
      files = await glob(spec.include.length ? spec.include : DEFAULT_INCLUDE, {
        cwd: spec.path,
        absolute: true,
        onlyFiles: true,
        ignore: ['**/node_modules/**', '**/.git/**'],
      });
      labelBase = dirname(resolve(spec.path));
    } else {
      files = [resolve(spec.path)];
      labelBase = dirname(dirname(resolve(spec.path)));
    }
  }
  files.sort();
  const out: MenuDocument[] = [];
  for (const file of files) {
    const doc = await readLocal(file, spec.path, labelBase, log);
    if (doc && doc.text.trim()) out.push(doc);
  }
  return out;
}

function normalise(url: string): string {
  const u = new URL(url);
  u.hash = '';
  return u.toString();
}

async function fetchPage(
  url: string,
  fetchImpl: typeof fetch
): Promise<{ type: string; body: Uint8Array } | null> {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'Tammy docs indexer', Accept: 'text/html,*/*' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!response.ok) return null;
  const type = (response.headers.get('content-type') ?? '').toLowerCase();
  return { type, body: new Uint8Array(await response.arrayBuffer()) };
}

/**
 * Crawls breadth-first from the start URL. Depth 0 reads only that page;
 * each level follows the links found on the one before. Only pages on the
 * start URL's origin are fetched (and, with `include`, only paths starting
 * with one of its prefixes), at most 500 of them.
 */
async function loadUrl(
  spec: Extract<SourceSpec, { kind: 'url' }>,
  log: Logger,
  fetchImpl: typeof fetch
): Promise<MenuDocument[]> {
  const start = new URL(spec.url);
  const allowed = (u: URL) =>
    u.origin === start.origin &&
    (spec.include.length === 0 ||
      spec.include.some((prefix) => u.pathname.startsWith(prefix)));
  const seen = new Set<string>([normalise(spec.url)]);
  let frontier = [normalise(spec.url)];
  const out: MenuDocument[] = [];
  let fetched = 0;
  let failures = 0;
  for (let depth = 0; depth <= spec.depth && frontier.length; depth++) {
    const next: string[] = [];
    for (const url of frontier) {
      if (fetched >= MAX_PAGES) break;
      fetched++;
      let page: Awaited<ReturnType<typeof fetchPage>>;
      try {
        page = await fetchPage(url, fetchImpl);
      } catch (error) {
        failures++;
        log.warn(`${url}: ${errorMessage(error)}`);
        continue;
      }
      if (!page) {
        failures++;
        continue;
      }
      const base = { root: spec.url, source: url, label: url, url };
      if (page.type.includes('html')) {
        const html = new TextDecoder().decode(page.body);
        const parsed = htmlToMarkdown(html, url);
        if (parsed.markdown) {
          out.push({
            ...base,
            title: parsed.title || url,
            text: parsed.markdown,
          });
        }
        for (const link of parsed.links) {
          let u: URL;
          try {
            u = new URL(link);
          } catch {
            continue;
          }
          const key = normalise(u.toString());
          if (!allowed(u) || seen.has(key)) continue;
          seen.add(key);
          next.push(key);
        }
      } else if (page.type.includes('pdf')) {
        const markdown = await pdfToMarkdown(page.body);
        if (markdown) out.push({ ...base, title: url, text: markdown });
      } else if (page.type.startsWith('text/')) {
        const text = new TextDecoder().decode(page.body);
        out.push({ ...base, title: firstHeading(text) ?? url, text });
      }
    }
    frontier = next;
  }
  if (out.length === 0 && failures > 0) {
    throw new Error(`could not read ${spec.url}`);
  }
  return out;
}

/** Reads every source. A source that fails entirely is reported, not fatal. */
export async function loadSources(
  specs: SourceSpec[],
  options: { log?: Logger; fetch?: typeof fetch } = {}
): Promise<LoadResult> {
  const log = options.log ?? silentLogger;
  const fetchImpl = options.fetch ?? fetch;
  const documents: MenuDocument[] = [];
  const failedRoots: string[] = [];
  for (const spec of specs) {
    try {
      const docs =
        spec.kind === 'path'
          ? await loadPath(spec, log)
          : await loadUrl(spec, log, fetchImpl);
      log.info(`${rootOf(spec)}: ${docs.length} document(s)`);
      documents.push(...docs);
    } catch (error) {
      log.error(`${rootOf(spec)}: ${errorMessage(error)}`);
      failedRoots.push(rootOf(spec));
    }
  }
  return { documents, failedRoots };
}
