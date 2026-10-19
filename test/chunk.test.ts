import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  chunkDocument,
  embeddingText,
  estimateTokens,
  slugify,
} from '../src/menu/chunk.js';
import { htmlToMarkdown } from '../src/menu/html.js';
import { MENU } from './helpers.js';

const OPTIONS = { chunkTokens: 500, overlapTokens: 60 };

describe('chunkDocument', () => {
  it('cuts at headings and keeps each chunk under one heading', () => {
    const text = readFileSync(join(MENU, 'sharing.md'), 'utf8');
    const chunks = chunkDocument({ title: 'Sharing a list', text }, OPTIONS);
    const headings = chunks.map((c) => c.heading);
    expect(headings).toContain('Sharing a list with someone');
    expect(headings).toContain("If Pantry can't find the person");
    const share = chunks.find(
      (c) => c.heading === 'Sharing a list with someone'
    )!;
    expect(share.trail).toEqual([
      'Sharing a list',
      'Sharing a list with someone',
    ]);
    expect(share.anchor).toBe('sharing-a-list-with-someone');
    expect(share.text).toMatch(/type the other person's email address/);
    // Line numbers point into the source file.
    const lines = text.split('\n');
    expect(lines[share.line - 1]).toMatch(/^1\. Open the list/);
  });

  it('splits a long section into chunks of about chunk_tokens, with overlap', () => {
    const paragraphs = Array.from(
      { length: 30 },
      (_, i) => `Paragraph ${i} ` + 'word '.repeat(60).trim() + '.'
    );
    const text = `# Long\n\n## Section\n\n${paragraphs.join('\n\n')}`;
    const chunks = chunkDocument(
      { title: 'Long', text },
      { chunkTokens: 200, overlapTokens: 50 }
    );
    expect(chunks.length).toBeGreaterThan(4);
    for (const c of chunks) {
      expect(estimateTokens(c.text)).toBeLessThanOrEqual(200 + 50);
      expect(c.heading).toBe('Section');
    }
    // Each chunk after the first starts with the end of the one before.
    const firstOfSecond = chunks[1]!.text.split('\n\n')[0]!;
    expect(chunks[0]!.text).toContain(firstOfSecond);
  });

  it('does not take a # inside a code fence for a heading', () => {
    const text =
      '# Doc\n\n## Real\n\nIntro.\n\n```sh\n# not a heading\necho hi\n```\n\nAfter.';
    const chunks = chunkDocument({ title: 'Doc', text }, OPTIONS);
    expect(chunks.map((c) => c.heading)).toEqual(['Real']);
    expect(chunks[0]!.text).toContain('# not a heading');
  });

  it('numbers repeated headings the way GitHub does', () => {
    const text = '# A\n\n## Notes\n\none\n\n## Notes\n\ntwo';
    const anchors = chunkDocument({ title: 'A', text }, OPTIONS).map(
      (c) => c.anchor
    );
    expect(anchors).toEqual(['notes', 'notes-1']);
    expect(slugify("If Pantry can't find the person")).toBe(
      'if-pantry-cant-find-the-person'
    );
  });

  it('keeps explicit anchors from HTML headings', () => {
    const page = htmlToMarkdown(
      `<html><head><title>Guide</title></head><body><nav>Home</nav><main>
       <h1>Guide</h1><h2 id="invite">Inviting people</h2><p>Type their <b>email</b>.</p>
       <script>alert(1)</script></main><footer>©</footer></body></html>`,
      'https://docs.example.com/guide'
    );
    expect(page.title).toBe('Guide');
    expect(page.markdown).not.toMatch(/alert|Home|©/);
    const chunks = chunkDocument(
      { title: page.title, text: page.markdown },
      OPTIONS
    );
    expect(chunks[0]).toMatchObject({
      heading: 'Inviting people',
      anchor: 'invite',
    });
    expect(chunks[0]!.text).toBe('Type their email.');
  });

  it('embeds the heading trail with the text', () => {
    const [chunk] = chunkDocument(
      { title: 'Items', text: '# Items\n\n## Adding an item\n\nType it.' },
      OPTIONS
    );
    expect(embeddingText('Items', chunk!)).toBe(
      'Items › Adding an item\n\nType it.'
    );
  });
});
