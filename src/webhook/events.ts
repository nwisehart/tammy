// The two Prepcook events Tammy acts on (Prepcook's
// docs/notifications.md), and the envelope every delivery comes in.

import type { TriageReport } from '../plain-english/report.js';

export interface IssueRef {
  key: string;
  title: string;
  url: string | null;
  card_url: string | null;
}

export interface Envelope<T = unknown> {
  type: string;
  severity: 'info' | 'warn' | 'urgent';
  occurred_at: string;
  prepcook: { version: string; board_url: string };
  data: T;
}

export interface InvestigationCompleted {
  issue: IssueRef;
  report: TriageReport;
  rca_url: string | null;
  rca_id: string | null;
  harness: {
    path: string | null;
    outcome: 'reproduced' | 'not_reproduced' | 'unknown' | 'missing';
  };
  confidence: 'low' | 'medium' | 'high' | null;
  source: {
    kind: 'tammy' | 'incident' | 'api';
    ref: string;
    reporter: string | null;
  } | null;
}

export interface CardConverted {
  issue: IssueRef;
  from: 'investigation';
  to: 'bug' | 'story';
  by: string;
  column: string;
}

export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.type === 'string' && typeof v.data === 'object' && v.data !== null
  );
}
