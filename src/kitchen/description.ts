// The investigation card's description: the report in the shape Prepcook's
// planning agent reads best — what to do, what was expected, what happened —
// followed by the customer's own words from the thread.

import type { FileInvestigationArgs } from '../brain/tools.js';

export interface ThreadLine {
  name: string;
  text: string;
}

function section(title: string, body: string | undefined): string {
  const text = body?.trim();
  return text ? `## ${title}\n\n${text}` : '';
}

export function investigationDescription(
  args: FileInvestigationArgs,
  context: {
    reporter: string;
    permalink: string;
    product: string;
    thread: ThreadLine[];
  }
): string {
  const quoted = context.thread
    .slice(-12)
    .map(
      (line) =>
        `**${line.name}:**\n${line.text
          .trim()
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n')}`
    )
    .join('\n\n');
  return [
    `Reported in Slack by ${context.reporter}${args.customer ? ` (${args.customer})` : ''} and filed by Tammy, ${context.product}'s support assistant. Thread: ${context.permalink}`,
    section('Summary', args.summary),
    section('Steps to reproduce', args.steps),
    section('Expected', args.expected),
    section('Actual', args.actual),
    section('Environment', args.environment),
    section('When it started', args.started),
    section('How often', args.frequency),
    section('From the conversation', quoted),
  ]
    .filter(Boolean)
    .join('\n\n');
}
