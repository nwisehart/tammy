// Headings-aware chunking. A document is split into sections at its
// headings; each section is cut into chunks of about `chunkTokens` tokens on
// paragraph boundaries, and consecutive chunks of one section share about
// `overlapTokens` tokens so an answer that straddles a cut is still found.
// A chunk never spans two sections, so every chunk has one heading to cite.

export interface ChunkOptions {
  chunkTokens: number;
  overlapTokens: number;
}

export interface Chunk {
  ord: number;
  /** The nearest heading, or the document title above the first one. */
  heading: string;
  /** Every heading above the chunk, outermost first. */
  trail: string[];
  /** The heading's anchor (`sharing-a-list`, or an explicit `{#id}`). */
  anchor: string | null;
  /** 1-based line of the chunk's first new paragraph in the source text. */
  line: number;
  text: string;
}

interface Block {
  line: number;
  text: string;
}

interface Section {
  heading: string;
  trail: string[];
  anchor: string | null;
  blocks: Block[];
}

/** A rough token count: about four characters a token for English prose. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to dashes. */
export function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const EXPLICIT_ANCHOR = /\s*\{#([^}\s]+)\}\s*$/;
const FENCE = /^\s*(```|~~~)/;

function sections(text: string, title: string, markdown: boolean): Section[] {
  const lines = text.split(/\r?\n/);
  const out: Section[] = [];
  const stack: { level: number; heading: string }[] = [];
  const used = new Map<string, number>();
  let current: Section = {
    heading: title,
    trail: [],
    anchor: null,
    blocks: [],
  };
  let para: string[] = [];
  let paraLine = 0;
  let fence: string | null = null;

  const flush = () => {
    if (para.length && para.some((l) => l.trim())) {
      current.blocks.push({ line: paraLine, text: para.join('\n').trim() });
    }
    para = [];
  };

  let start = 0;
  // Skip YAML front matter.
  if (markdown && lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end > 0) start = end + 1;
  }

  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (markdown) {
      const fenceMatch = FENCE.exec(line);
      if (fence) {
        para.push(line);
        if (fenceMatch && fenceMatch[1] === fence) {
          fence = null;
          flush();
        }
        continue;
      }
      if (fenceMatch) {
        flush();
        fence = fenceMatch[1]!;
        paraLine = lineNo;
        para.push(line);
        continue;
      }
      const heading = HEADING.exec(line);
      if (heading) {
        flush();
        if (current.blocks.length) out.push(current);
        const level = heading[1]!.length;
        let name = heading[2]!;
        let anchor: string;
        const explicit = EXPLICIT_ANCHOR.exec(name);
        if (explicit) {
          anchor = explicit[1]!;
          name = name.slice(0, explicit.index);
        } else {
          const slug = slugify(name);
          const n = used.get(slug) ?? 0;
          used.set(slug, n + 1);
          anchor = n === 0 ? slug : `${slug}-${n}`;
        }
        while (stack.length && stack[stack.length - 1]!.level >= level) {
          stack.pop();
        }
        stack.push({ level, heading: name });
        current = {
          heading: name,
          trail: stack.map((s) => s.heading),
          anchor,
          blocks: [],
        };
        continue;
      }
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (!para.length) paraLine = lineNo;
    para.push(line);
  }
  flush();
  if (current.blocks.length) out.push(current);
  return out;
}

/** Cuts a block bigger than one chunk at sentence, then word, boundaries. */
function splitBlock(block: Block, max: number): Block[] {
  if (estimateTokens(block.text) <= max) return [block];
  const pieces = block.text.split(/(?<=[.!?])\s+|\n/);
  const out: Block[] = [];
  let buf = '';
  const push = () => {
    if (buf.trim()) out.push({ line: block.line, text: buf.trim() });
    buf = '';
  };
  for (const piece of pieces) {
    if (estimateTokens(piece) > max) {
      push();
      const words = piece.split(/\s+/);
      for (const word of words) {
        if (estimateTokens(`${buf} ${word}`) > max) push();
        buf = buf ? `${buf} ${word}` : word;
      }
      continue;
    }
    if (estimateTokens(`${buf} ${piece}`) > max) push();
    buf = buf ? `${buf} ${piece}` : piece;
  }
  push();
  return out;
}

/** The last `tokens` worth of a chunk's blocks, to start the next one. */
function tail(blocks: Block[], tokens: number): Block[] {
  if (tokens <= 0) return [];
  const out: Block[] = [];
  let total = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    const size = estimateTokens(block.text);
    if (total + size <= tokens) {
      out.unshift(block);
      total += size;
      continue;
    }
    if (out.length === 0) {
      const words = block.text.split(/\s+/);
      const kept: string[] = [];
      for (let w = words.length - 1; w >= 0; w--) {
        if (estimateTokens([words[w], ...kept].join(' ')) > tokens) break;
        kept.unshift(words[w]!);
      }
      if (kept.length) out.push({ line: block.line, text: kept.join(' ') });
    }
    break;
  }
  return out;
}

export function chunkDocument(
  doc: { title: string; text: string; markdown?: boolean },
  options: ChunkOptions
): Chunk[] {
  const markdown = doc.markdown ?? true;
  const out: Chunk[] = [];
  for (const section of sections(doc.text, doc.title, markdown)) {
    const blocks = section.blocks.flatMap((b) =>
      splitBlock(b, options.chunkTokens)
    );
    let current: Block[] = [];
    let carried: Block[] = [];
    let size = 0;
    const emit = () => {
      const fresh = current.slice(carried.length);
      if (!fresh.length) return;
      out.push({
        ord: out.length,
        heading: section.heading,
        trail: section.trail,
        anchor: section.anchor,
        line: fresh[0]!.line,
        text: current.map((b) => b.text).join('\n\n'),
      });
      carried = tail(current, options.overlapTokens);
      current = [...carried];
      size = carried.reduce((n, b) => n + estimateTokens(b.text), 0);
    };
    for (const block of blocks) {
      const blockSize = estimateTokens(block.text);
      if (
        size + blockSize > options.chunkTokens &&
        current.length > carried.length
      ) {
        emit();
      }
      // Drop overlap that would push a fresh block over the limit.
      while (
        current.length &&
        carried.length &&
        size + blockSize > options.chunkTokens
      ) {
        const dropped = current.shift()!;
        carried.shift();
        size -= estimateTokens(dropped.text);
      }
      current.push(block);
      size += blockSize;
    }
    emit();
  }
  return out;
}

/** What is embedded for a chunk: where it sits, then what it says. */
export function embeddingText(title: string, chunk: Chunk): string {
  const place = [title, ...chunk.trail.filter((h) => h !== title)].join(' › ');
  return `${place}\n\n${chunk.text}`;
}
