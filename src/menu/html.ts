// HTML to the markdown-ish text the chunker reads. Headings keep their level
// and their `id` (written as a `{#id}` suffix, so a citation can link to the
// section on the page), lists stay lists, code stays fenced, and page chrome
// — navigation, headers, footers, scripts — is dropped.

import { HTMLElement, NodeType, parse, type Node } from 'node-html-parser';

const SKIP = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'button',
  'iframe',
]);

const BLOCK = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'blockquote',
  'figure',
  'figcaption',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'ul',
  'ol',
  'details',
  'summary',
]);

export interface HtmlPage {
  title: string;
  markdown: string;
  /** Every `href` on the page, resolved against `baseUrl` when given. */
  links: string[];
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function render(node: Node, out: string[]): void {
  if (node.nodeType === NodeType.TEXT_NODE) {
    out.push(squash(node.text));
    return;
  }
  if (node.nodeType !== NodeType.ELEMENT_NODE) return;
  const el = node as HTMLElement;
  const tag = el.tagName?.toLowerCase() ?? '';
  if (SKIP.has(tag)) return;
  if (el.getAttribute('aria-hidden') === 'true') return;

  const heading = /^h([1-6])$/.exec(tag);
  if (heading) {
    const id = el.getAttribute('id');
    const text = squash(el.text).trim();
    if (text) {
      out.push(
        `\n\n${'#'.repeat(Number(heading[1]))} ${text}${id ? ` {#${id}}` : ''}\n\n`
      );
    }
    return;
  }
  if (tag === 'pre') {
    out.push(`\n\n\`\`\`\n${el.text.replace(/\n+$/, '')}\n\`\`\`\n\n`);
    return;
  }
  if (tag === 'br') {
    out.push('\n');
    return;
  }
  if (tag === 'li') {
    out.push('\n- ');
    el.childNodes.forEach((child) => render(child, out));
    out.push('\n');
    return;
  }
  if (tag === 'tr') {
    const cells = el.childNodes
      .filter((c) => c.nodeType === NodeType.ELEMENT_NODE)
      .map((c) => squash(c.text).trim());
    out.push(`\n${cells.join(' | ')}\n`);
    return;
  }
  if (tag === 'img') {
    const alt = el.getAttribute('alt');
    if (alt) out.push(` ${alt} `);
    return;
  }
  const block = BLOCK.has(tag);
  if (block) out.push('\n\n');
  el.childNodes.forEach((child) => render(child, out));
  if (block) out.push('\n\n');
}

/** Converts an HTML page to markdown-ish text and collects its links. */
export function htmlToMarkdown(html: string, baseUrl?: string): HtmlPage {
  const root = parse(html, { comment: false });
  const title =
    squash(root.querySelector('title')?.text ?? '').trim() ||
    squash(root.querySelector('h1')?.text ?? '').trim();
  const links: string[] = [];
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:')) continue;
    try {
      links.push(baseUrl ? new URL(href, baseUrl).toString() : href);
    } catch {
      // An href that is not a URL is not worth following.
    }
  }
  const content =
    root.querySelector('main') ??
    root.querySelector('[role=main]') ??
    root.querySelector('article') ??
    root.querySelector('body') ??
    root;
  const out: string[] = [];
  render(content, out);
  let fenced = false;
  const markdown = out
    .join('')
    .split('\n')
    .map((line) => {
      if (line.startsWith('```')) fenced = !fenced;
      if (fenced) return line.replace(/[ \t]+$/g, '');
      return line.trim();
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, markdown, links };
}
