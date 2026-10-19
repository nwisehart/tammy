// The TRIAGE REPORT an investigation card posts (Prepcook's
// docs/method.md): six fixed sections. The webhook carries them as fields;
// a report read from markdown is parsed into the same shape.

export interface TriageSections {
  what_happens: string;
  where: string;
  why: string;
  scope: string;
  workaround: string;
  confidence: string;
}

export interface TriageReport extends TriageSections {
  markdown: string;
}

const HEADINGS: Record<string, keyof TriageSections> = {
  'what happens': 'what_happens',
  where: 'where',
  why: 'why',
  scope: 'scope',
  workaround: 'workaround',
  confidence: 'confidence',
};

/** Parses `## What happens` … `## Confidence` out of a report's markdown. */
export function parseTriageReport(markdown: string): TriageReport {
  const out: TriageReport = {
    what_happens: '',
    where: '',
    why: '',
    scope: '',
    workaround: '',
    confidence: '',
    markdown,
  };
  let current: keyof TriageSections | null = null;
  const buf: Record<string, string[]> = {};
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = HEADINGS[heading[1]!.toLowerCase()] ?? null;
      continue;
    }
    if (current) (buf[current] ??= []).push(line);
  }
  for (const [key, lines] of Object.entries(buf)) {
    out[key as keyof TriageSections] = lines.join('\n').trim();
  }
  return out;
}

/** Fills empty fields from the markdown, for a report with sections left out. */
export function completeReport(report: TriageReport): TriageReport {
  if (!report.markdown) return report;
  const parsed = parseTriageReport(report.markdown);
  const out = { ...report };
  for (const key of Object.values(HEADINGS)) {
    if (!out[key]?.trim()) out[key] = parsed[key];
  }
  return out;
}

export type ConfidenceLevel = 'high' | 'medium' | 'low' | null;

export function confidenceLevel(text: string): ConfidenceLevel {
  const match = /^\W*(high|medium|low)\b/i.exec(text.trim());
  return (match?.[1]?.toLowerCase() as ConfidenceLevel) ?? null;
}

export function hasWorkaround(text: string): boolean {
  const t = text.trim().toLowerCase();
  return !!t && !/^(none|no workaround|n\/a|not found|none found)\b/.test(t);
}

/** Whose side the problem is on, read from the Scope section. */
export function whoseSide(scope: string): 'ours' | 'setup' | 'unknown' {
  const s = scope.toLowerCase();
  if (/\bnot (a |an )?(defect|bug|fault)\b/.test(s)) return 'setup';
  if (
    /\bnot (a |the )?(configuration|config|setup|settings?)\b/.test(s) ||
    /\b(defect|bug)\b/.test(s)
  ) {
    return 'ours';
  }
  if (/\b(configuration|config|setup|settings?)\b/.test(s)) return 'setup';
  return 'unknown';
}
