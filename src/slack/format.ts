// Slack mrkdwn: what Claude writes (a little markdown) turned into what Slack
// renders, and the citations under an answer — a link when the passage came
// from a web page, "from the menu: <heading>" when it came from a local file.

import type { Reply } from '../brain/brain.js';
import type { Citation } from '../menu/retrieve.js';

export const PLACEHOLDER = '_Tammy is writing…_';

/** Escapes the three characters Slack reserves in message text. */
export function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Link text cannot contain `|` or `>`. */
function linkLabel(text: string): string {
  return escapeText(text.replace(/[|]/g, '/'));
}

export function link(url: string, label: string): string {
  return `<${url}|${linkLabel(label)}>`;
}

/** Markdown (bold, links, headings, bullets) to Slack mrkdwn. */
export function toMrkdwn(markdown: string): string {
  const links: string[] = [];
  // Pull links out first so escaping leaves their URLs alone.
  let text = markdown.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, label: string, url: string) => {
      links.push(link(url, label));
      return `\uE000${links.length - 1}\uE000`;
    }
  );
  // Keep a quote marker at the start of a line.
  text = text
    .split('\n')
    .map((line) => {
      const quote = /^>\s?/.exec(line);
      const body = quote ? line.slice(quote[0].length) : line;
      return (quote ? '>' : '') + escapeText(body);
    })
    .join('\n');
  text = text
    .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/^(\s*)[-*]\s+/gm, '$1• ');
  return text.replace(
    /\uE000(\d+)\uE000/g,
    (_m, i: string) => links[Number(i)]!
  );
}

export function formatCitation(c: Citation): string {
  if (c.url) return link(c.url, c.heading);
  return `from the menu: ${escapeText(c.heading)}`;
}

export function formatCitations(citations: Citation[]): string {
  if (!citations.length) return '';
  if (citations.length === 1) {
    const only = formatCitation(citations[0]!);
    return `_${only[0]!.toUpperCase()}${only.slice(1)}_`;
  }
  return citations
    .map((c, i) => `_[${i + 1}] ${formatCitation(c)}_`)
    .join('\n');
}

/** A reply as posted: the answer, its citations, and any order link. */
export function formatReply(reply: Reply): string {
  let body = reply.text;
  // One citation needs no number in the text.
  if (reply.citations.length === 1) body = body.replace(/\s*\[1\]/g, '');
  const parts = [toMrkdwn(body)];
  const cites = formatCitations(reply.citations);
  if (cites) parts.push(cites);
  if (reply.filed) {
    parts.push(
      `Order ${link(reply.filed.url, reply.filed.key)} is with the kitchen.`
    );
  }
  return parts.join('\n\n');
}
