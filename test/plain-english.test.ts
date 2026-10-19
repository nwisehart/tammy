import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseTriageReport, whoseSide } from '../src/plain-english/report.js';
import {
  asAdvice,
  composeFromReport,
  JARGON_DENYLIST,
  leaks,
  sanitize,
  TRANSLATE_PROMPT,
  translateReport,
} from '../src/plain-english/translate.js';
import { FakeClaude, text } from './helpers.js';

const DIR = join(import.meta.dirname, '..', 'src', 'plain-english', 'fixtures');
const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith('.md'))
  .map((f) => ({
    name: f,
    report: parseTriageReport(readFileSync(join(DIR, f), 'utf8')),
  }));

const STACK = /\bat\s+\S+\s+\(\S+:\d+:\d+\)|Error:/;
const PATH = /\b[\w.-]+\/[\w.-]+\/|\.(?:js|mjs|ts)\b|\/lists\/:/;

function assertCustomerSafe(message: string) {
  expect(message).not.toMatch(STACK);
  expect(message).not.toMatch(PATH);
  expect(message).not.toMatch(/`/);
  expect(message).not.toMatch(/^#+\s/m);
  for (const word of JARGON_DENYLIST) {
    expect(message.toLowerCase()).not.toMatch(
      new RegExp(
        `(?<![\\w-])${word.toLowerCase().replace(/\s+/g, '\\s+')}(?![\\w-])`
      )
    );
  }
  expect(leaks(message)).toEqual([]);
}

describe('the fixtures', () => {
  it('are triage reports with all six sections', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(3);
    for (const { report } of fixtures) {
      for (const key of [
        'what_happens',
        'where',
        'why',
        'scope',
        'workaround',
        'confidence',
      ] as const) {
        expect(report[key]).not.toBe('');
      }
    }
  });

  it('carry what must never reach a customer, so the tests mean something', () => {
    const all = fixtures.map((f) => f.report.markdown).join('\n');
    expect(all).toMatch(STACK);
    expect(all).toMatch(PATH);
    expect(leaks(all).length).toBeGreaterThan(0);
  });
});

describe.each(fixtures)('composing $name without a model', ({ report }) => {
  const message = composeFromReport(report, { title: 'x', product: 'Pantry' });

  it('leaks no stack trace, path, code or jargon', () => {
    assertCustomerSafe(message);
  });

  it('covers what happened, whose side it is, a workaround, and what happens next', () => {
    expect(message).toContain("*What's happening:*");
    expect(message).toContain('*Your setup or ours:*');
    expect(message).toContain('*What happens next:*');
    expect(message).toMatch(/In the meantime|isn't a way around it yet/);
    expect(message).not.toMatch(/promise(?!\s+when)/i);
  });
});

describe('the workaround', () => {
  it('becomes advice', () => {
    const sharing = fixtures.find((f) => f.name.startsWith('sharing'))!.report;
    const message = composeFromReport(sharing, {
      title: 'x',
      product: 'Pantry',
    });
    expect(message).toContain(
      "In the meantime, you can type the other person's email all in lower case (ann@example.com) when sharing."
    );
    expect(message).not.toMatch(/Workaround/i);
  });

  it('says so when there is none', () => {
    const sso = fixtures.find((f) => f.name.startsWith('sso'))!.report;
    const message = composeFromReport(sso, { title: 'x', product: 'Pantry' });
    expect(message).toContain("There isn't a way around it yet");
    expect(message).toContain('comes from how things are set up');
    expect(message).toContain("isn't certain yet");
  });

  it.each([
    ['Export as XLSX.', 'In the meantime, you can export as XLSX.'],
    ['Users can sign in again.', 'In the meantime, you can sign in again.'],
    ['None found', "There isn't a way around it yet, I'm afraid."],
    [
      'The XLSX export is complete.',
      'In the meantime: The XLSX export is complete.',
    ],
  ])('%s → %s', (input, expected) => {
    expect(asAdvice(input)).toBe(expected);
  });
});

describe('a model translation', () => {
  it('is asked for with the report and the rules', async () => {
    const claude = new FakeClaude([text('x'.repeat(10))]);
    const sharing = fixtures[0]!.report;
    await translateReport(
      sharing,
      { title: 'Sharing fails', product: 'Pantry' },
      {
        client: claude,
        model: 'claude-main',
      }
    );
    const call = claude.calls[0]!;
    expect(call.system).toBe(TRANSLATE_PROMPT);
    expect(JSON.stringify(call.messages)).toContain('## Workaround');
    expect(TRANSLATE_PROMPT).toMatch(/No stack traces/);
    expect(TRANSLATE_PROMPT).toMatch(/Do not promise a fix/);
  });

  it('is sanitised when the model lets something through', async () => {
    const leaky = [
      '## What happens',
      'Sharing fails when the email has a capital letter. The handler in `src/routes/sharing.js` compares with `u.email === email`.',
      '    at Router.handle (src/routes/sharing.js:22:7)',
      '## Where',
      'POST /lists/:listId/share',
      '## Workaround',
      'Type the email in lower case.',
      'Our harness reproduced it on main, and a regression test is coming in the next deploy.',
      'The team has the details and will look at what to do next.',
    ].join('\n');
    const claude = new FakeClaude([text(leaky)]);
    const out = await translateReport(
      fixtures[0]!.report,
      { title: 'x', product: 'Pantry' },
      {
        client: claude,
        model: 'm',
      }
    );
    assertCustomerSafe(out);
    expect(out).toContain('Sharing fails when the email has a capital letter.');
    expect(out).toContain(
      'In the meantime, you can type the email in lower case.'
    );
    expect(out).toContain('The team has the details');
  });

  it('falls back to the composed message when the model fails', async () => {
    const claude = new FakeClaude([new Error('rate limited')]);
    const out = await translateReport(
      fixtures[0]!.report,
      { title: 'x', product: 'Pantry' },
      {
        client: claude,
        model: 'm',
      }
    );
    expect(out).toContain('*Your setup or ours:*');
    assertCustomerSafe(out);
  });
});

describe('sanitize', () => {
  it('keeps plain English and ordinary product words', () => {
    const plain =
      'It happens on an iPhone and on macOS, every time, for every list.';
    expect(sanitize(plain)).toBe(plain);
    expect(sanitize('Use `ann@example.com` instead.')).toBe(
      'Use ann@example.com instead.'
    );
  });

  it('drops fenced code whole', () => {
    expect(sanitize('Before.\n```\nthrow new Error()\n```\nAfter.')).toBe(
      'Before.\n\nAfter.'
    );
  });
});

describe('whose side', () => {
  it.each([
    ['A defect, not configuration: the harness fails on a fresh seed.', 'ours'],
    [
      'Configuration, not a defect: it passes once the address matches.',
      'setup',
    ],
    ['Only this workspace, because of its SSO settings.', 'setup'],
    ['Unclear.', 'unknown'],
  ])('%s', (scope, side) => {
    expect(whoseSide(scope)).toBe(side);
  });
});
