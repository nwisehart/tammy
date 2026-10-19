// From the kitchen's TRIAGE REPORT to a message for the customer: what
// happened, what it affects, whether it is their setup or ours, what they
// can do in the meantime, and what happens next. Claude writes it from the
// prompt below; whatever comes back is then passed through `sanitize`, which
// removes anything that must never reach a customer — stack traces, file
// paths, code, internal jargon — even if the model let it through. When no
// model is available, or its answer does not survive sanitising, the
// message is composed from the report's sections instead.

import {
  ApiProvider,
  type LlmProvider,
  type MessagesClient,
} from '../brain/provider.js';
import { errorMessage, silentLogger, type Logger } from '../log.js';
import {
  completeReport,
  confidenceLevel,
  hasWorkaround,
  whoseSide,
  type TriageReport,
} from './report.js';

export const TRANSLATE_PROMPT = `You are Tammy, who looks after customers in Slack. The engineering team (the kitchen) investigated a problem a customer reported and wrote a TRIAGE REPORT for engineers. Rewrite it for the customer.

Write a short Slack message, in plain words, that covers in this order:
1. What happened — what they saw, and why, in one or two sentences a non-engineer understands.
2. What it affects — who or what else runs into it.
3. Whether it comes from their setup or from our side, as the Scope section says. If the report is unsure, say so.
4. What they can do in the meantime: turn the Workaround section into friendly advice ("In the meantime, you can …"). If there is none, say there isn't one yet.
5. What happens next: the team has the details. Do not promise a fix, a date or that anything will change.

Rules:
- No stack traces, error codes, file names, paths, URLs to internal tools, function or variable names, or code of any kind.
- No engineering jargon: not "harness", "repro", "RCA", "root cause", "regression", "endpoint", "deploy", "branch", "commit", "null", "seed", "card", "triage" or "Prepcook". Say "the team", "we", "our side".
- If the confidence is not high, say the team is not certain yet.
- Slack formatting: *bold* for the short labels if you use any, no headings, no tables. Under 150 words.
- Only what the report says. Do not add causes, numbers or advice it does not contain.`;

/** Words that never reach a customer. Matched case-insensitively, whole words. */
export const JARGON_DENYLIST = [
  'harness',
  'repro',
  'reproduction',
  'RCA',
  'root cause',
  'root-cause',
  'stack trace',
  'stacktrace',
  'traceback',
  'worktree',
  'seed data',
  'fresh seed',
  'seeded',
  'regression',
  'endpoint',
  'handler',
  'middleware',
  'null',
  'undefined',
  'NaN',
  'git',
  'the commit',
  'fix branch',
  'feature branch',
  'on main',
  'merge request',
  'pull request',
  'deploy',
  'deployed',
  'refactor',
  'codebase',
  'triage',
  'triaged',
  'Prepcook',
  'orchestrator',
  'playbook',
  'investigation card',
  'unit test',
  'regex',
];

const STACK_TRACE = [
  /^\s*at\s+\S.*(?:\(|\s)\S+:\d+(?::\d+)?\)?\s*$/m,
  /\bat\s+[\w$.<>]+\s+\([^)]*:\d+:\d+\)/,
  /\b[A-Z]\w*(?:Error|Exception)\b:/,
  /Traceback \(most recent call last\)/,
  /\bpanicked at\b/,
];

const FILE_PATH = [
  // /lists/:id/share, ~/x, ./x, ../x
  /(?:^|[\s(`'"])(?:~|\.{1,2})?\/[\w@.:-]+(?:\/[\w@.:-]*)*/,
  // src/routes/sharing.js: two or more separators
  /\b[\w@.-]+\/[\w@.-]+\/[\w@.-]+/,
  // sharing.js, repro.mjs:12
  /\b[\w-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|php|cs|json|ya?ml|toml|sql|sh|env|lock)\b/,
];

/** Ordinary words shaped like code. */
const NOT_CODE =
  /\b(?:macOS|iOS|iPadOS|watchOS|tvOS|iPhone|iPad|iPod|iCloud|eBay)\b/g;

const CODE = [
  /\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/, // obj.method(
  /\b[a-z]+[A-Z][\w$]*\s*\(/, // camelCase(
  /\b[a-z]+[A-Z][\w$]*\b/, // camelCaseIdentifier (see NOT_CODE)
  /\b\w+_\w+\b/, // snake_case
  /===|!==|=>|&&|\|\|/,
  /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\//,
  /:\w+\b\/|\/:\w+/, // route params
];

function jargonPattern(): RegExp {
  const escaped = JARGON_DENYLIST.map((w) =>
    w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  );
  return new RegExp(`(?<![\\w-])(?:${escaped.join('|')})s?(?![\\w-])`, 'i');
}

const JARGON = jargonPattern();

/** Whether `text` holds anything that must not reach a customer. */
export function leaks(text: string): string[] {
  const found: string[] = [];
  if (STACK_TRACE.some((r) => r.test(text))) found.push('stack trace');
  const noUrls = text.replace(/https?:\/\/\S+/g, '');
  if (FILE_PATH.some((r) => r.test(noUrls))) found.push('file path');
  const words = text.replace(NOT_CODE, '');
  if (CODE.some((r) => r.test(words))) found.push('code');
  const jargon = JARGON.exec(text);
  if (jargon) found.push(`jargon: ${jargon[0]}`);
  return found;
}

const FRIENDLY_LABELS: Record<string, string | null> = {
  'what happens': "What's happening",
  'what happened': "What's happening",
  where: null,
  why: 'Why',
  scope: 'Who it affects',
  workaround: 'In the meantime',
  confidence: 'How sure the team is',
};

/**
 * Turns workaround text into advice: "Type the email in lower case." becomes
 * "In the meantime, you can type the email in lower case."
 */
export function asAdvice(workaround: string): string {
  const text = workaround.trim().replace(/\s+/g, ' ');
  if (!hasWorkaround(text)) {
    return "There isn't a way around it yet, I'm afraid.";
  }
  if (/^in the meantime\b/i.test(text)) return text;
  if (/^(you|they|customers?|users?|people)\b/i.test(text)) {
    return `In the meantime, ${text.replace(/^(they|customers?|users?|people)\b/i, 'you')}`;
  }
  const first = text.split(/\s+/)[0]!.toLowerCase();
  const notImperative = [
    'the',
    'this',
    'it',
    'there',
    'a',
    'an',
    'when',
    'if',
    'as',
  ];
  if (notImperative.includes(first)) return `In the meantime: ${text}`;
  return `In the meantime, you can ${text[0]!.toLowerCase()}${text.slice(1)}`;
}

/**
 * A sentence: anything up to a full stop, question or exclamation mark that
 * is followed by a space or the end. A dot inside an email address or a
 * number does not end one.
 */
const SENTENCE = /(?:[^.!?]|[.!?](?!\s|$))+(?:[.!?]+(?=\s|$))?/g;

function unwrapInlineCode(text: string): string {
  return text.replace(/`([^`]+)`/g, (_m, inner: string) =>
    leaks(inner).length ? '`DROP`' : inner
  );
}

/**
 * Removes everything a customer must not see. Fenced code goes; headings
 * become bold labels (and a Workaround section becomes advice); then every
 * sentence that still carries a stack trace, a path, code or jargon is
 * dropped whole, so what remains reads as plain English.
 */
export function sanitize(text: string): string {
  const withoutFences = text.replace(/```[\s\S]*?```/g, '');
  const lines = withoutFences.split(/\r?\n/);
  const out: string[] = [];
  let section: string | null = null;
  for (const raw of lines) {
    const heading = /^\s*#{1,6}\s+(.+?)\s*:?\s*$/.exec(raw);
    if (heading) {
      const name = heading[1]!.toLowerCase().replace(/\*/g, '').trim();
      section = name;
      const label = FRIENDLY_LABELS[name];
      if (name === 'triage report' || label === null) continue;
      if (label && name !== 'workaround') out.push(`*${label}:*`);
      continue;
    }
    if (/^\s*TRIAGE REPORT\s*$/i.test(raw)) continue;
    let line = unwrapInlineCode(raw);
    if (section === 'where') continue;
    if (section === 'workaround' && line.trim()) {
      line = asAdvice(line);
      section = null;
    }
    out.push(line);
  }
  const kept = out
    .join('\n')
    .split(/\n/)
    .map((line) => {
      // Split into sentences, keeping list markers and labels with their text.
      const sentences = line.match(SENTENCE) ?? [line];
      return sentences
        .filter((s) => !s.includes('`DROP`') && leaks(s).length === 0)
        .join('')
        .trim();
    })
    .filter((line, i, all) => line || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .replace(/^\*[^*\n]+:\*\s*$(?=\n(?:\*|$))/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return kept;
}

export interface TranslateContext {
  /** The card's title, as filed. */
  title: string;
  product: string;
  /** Whether Prepcook's harness reproduced the problem. */
  reproduced?: boolean | null;
}

function firstSentences(text: string, n: number): string {
  const sentences = text.replace(/\s+/g, ' ').match(SENTENCE);
  return (sentences ? sentences.slice(0, n).join(' ') : text).trim();
}

/**
 * The customer message composed from the report alone, used without a model
 * or when the model's message does not survive sanitising.
 */
export function composeFromReport(
  input: TriageReport,
  context: TranslateContext
): string {
  const report = completeReport(input);
  const parts: string[] = [
    `The team has looked into this, and here's what they found.`,
  ];
  const what = sanitize(firstSentences(report.what_happens, 2));
  const why = sanitize(firstSentences(report.why, 2));
  if (what) parts.push(`*What's happening:* ${what}`);
  if (why) parts.push(`*Why:* ${why}`);
  // The verdict on whose side it is gets its own line below.
  const scope = sanitize(
    (report.scope.replace(/\s+/g, ' ').match(SENTENCE) ?? [])
      .filter((x) => !/\b(defect|configuration|config)\b/i.test(x))
      .slice(0, 2)
      .join('')
      .trim()
  );
  if (scope) parts.push(`*Who it affects:* ${scope}`);
  const side = whoseSide(report.scope);
  parts.push(
    side === 'ours'
      ? `*Your setup or ours:* This is on our side — nothing you need to change in how you've set things up.`
      : side === 'setup'
        ? `*Your setup or ours:* This comes from how things are set up, rather than something broken on our side.`
        : `*Your setup or ours:* The team hasn't said yet whether this is on our side or comes from the setup.`
  );
  const advice = sanitize(asAdvice(report.workaround));
  parts.push(advice || "There isn't a way around it yet, I'm afraid.");
  const level = confidenceLevel(report.confidence);
  if (context.reproduced === false) {
    parts.push(
      "The team couldn't make it happen on their side, so this is their best explanation rather than a certain one."
    );
  } else if (level === 'high') {
    parts.push(
      'The team has seen it happen themselves and is confident about the explanation.'
    );
  } else if (level === 'medium') {
    parts.push(
      "The team thinks this is the explanation, but isn't certain yet."
    );
  } else {
    parts.push("The team hasn't pinned this down for certain yet.");
  }
  parts.push(
    `*What happens next:* The team has all the details and decides what happens next. I can't promise when or whether it will change, but I'll say so here if they take it on.`
  );
  return parts
    .join('\n\n')
    .replace(/\b(the|this) customer's\b/gi, 'your')
    .replace(/\bthe customer\b/gi, 'you');
}

export interface TranslateOptions {
  /** The API path's client; or pass `provider` (either works for the seat). */
  client?: MessagesClient | null;
  provider?: Pick<LlmProvider, 'complete'> | null;
  model: string;
  log?: Logger;
}

/**
 * The customer message for a report: Claude's rewrite, sanitised; or the
 * composed one when there is no model, the call fails, or too little of the
 * rewrite survives.
 */
export async function translateReport(
  report: TriageReport,
  context: TranslateContext,
  options: TranslateOptions
): Promise<string> {
  const log = options.log ?? silentLogger;
  const full = completeReport(report);
  const provider =
    options.provider ??
    (options.client ? new ApiProvider(options.client) : null);
  if (!provider) return composeFromReport(full, context);
  try {
    const text = await provider.complete({
      model: options.model,
      maxTokens: 700,
      system: TRANSLATE_PROMPT,
      prompt: `Product: ${context.product}\nThe customer's report was filed as: "${context.title}"\n\n${full.markdown || renderReport(full)}`,
    });
    const clean = sanitize(text);
    if (clean.length >= 80) return clean;
    log.warn(
      'the translated report lost too much to sanitising; composing it instead'
    );
  } catch (error) {
    log.warn(
      `translating the report failed: ${errorMessage(error)}; composing it instead`
    );
  }
  return composeFromReport(full, context);
}

export function renderReport(report: TriageReport): string {
  return [
    'TRIAGE REPORT',
    `## What happens\n${report.what_happens}`,
    `## Where\n${report.where}`,
    `## Why\n${report.why}`,
    `## Scope\n${report.scope}`,
    `## Workaround\n${report.workaround}`,
    `## Confidence\n${report.confidence}`,
  ].join('\n\n');
}
