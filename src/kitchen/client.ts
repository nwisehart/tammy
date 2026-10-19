// The Prepcook card API (Prepcook's docs/api.md): file an investigation,
// read a card, convert one. Every call carries the PREPCOOK_API_TOKEN bearer
// token and reads Prepcook's `{ success, data, message }` envelope.

export type WorkClass = 'investigation' | 'bug' | 'story';

export interface Origin {
  kind: 'tammy';
  /** The Slack thread's permalink. */
  ref: string;
  reporter?: string;
}

export interface Attachment {
  name: string;
  url: string;
}

export interface FileInvestigationInput {
  title: string;
  description: string;
  origin: Origin;
  attachments?: Attachment[];
  metadata?: { channel: string; customer?: string } & Record<string, unknown>;
  start?: boolean;
}

export interface FiledCard {
  id: string;
  url: string;
  key: string;
}

export interface TriageReport {
  what_happens: string;
  where: string;
  why: string;
  scope: string;
  workaround: string;
  confidence: string;
  markdown: string;
}

export interface CardView {
  id: string;
  key: string;
  title: string;
  url: string;
  project_id: string;
  status: string;
  column: string;
  work_class: string;
  report: TriageReport | null;
  confidence: 'low' | 'medium' | 'high' | null;
  harness: { path: string | null; outcome: string } | null;
  comments: number;
  rca_id: string | null;
  origin: { kind: string; ref: string; reporter?: string | null } | null;
}

export interface ConvertedCard {
  id: string;
  from: string;
  to: string;
  column: string;
  plan_carried_over: boolean;
}

export class KitchenError extends Error {
  constructor(
    message: string,
    /** The HTTP status, or 0 when Prepcook could not be reached. */
    readonly status: number
  ) {
    super(message);
    this.name = 'KitchenError';
  }
}

export interface KitchenOptions {
  baseUrl: string;
  token: string;
  /** The board to file on; Prepcook's default board when unset. */
  board?: string | null;
  retries?: number;
  timeoutMs?: number;
  /** Base delay between retries, doubled each time. */
  backoffMs?: number;
  fetch?: typeof fetch;
}

/** The API Tammy needs from Prepcook; tests substitute their own. */
export interface Kitchen {
  fileInvestigation(input: FileInvestigationInput): Promise<FiledCard>;
  getCard(id: string): Promise<CardView>;
  convert(
    id: string,
    workClass: 'bug' | 'story',
    by: string
  ): Promise<ConvertedCard>;
}

type RetryPolicy = 'safe' | 'unwritten';

export class KitchenClient implements Kitchen {
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly backoffMs: number;

  constructor(private readonly options: KitchenOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.retries = options.retries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.backoffMs = options.backoffMs ?? 500;
  }

  /**
   * Files an investigation card and starts it (it lands in Plan). Prepcook
   * has no idempotency key, so a POST is retried only when nothing can have
   * been written: the server was not reached, or answered 503 (the board
   * could not be reached). A timeout is not retried; it may have filed.
   */
  async fileInvestigation(input: FileInvestigationInput): Promise<FiledCard> {
    const body = {
      ...(this.options.board ? { project_id: this.options.board } : {}),
      title: input.title.slice(0, 255),
      description: input.description,
      work_class: 'investigation',
      origin: input.origin,
      attachments: input.attachments ?? [],
      metadata: input.metadata ?? {},
      start: input.start ?? true,
    };
    return this.call<FiledCard>('POST', '/api/cards', body, 'unwritten');
  }

  async getCard(id: string): Promise<CardView> {
    return this.call<CardView>(
      'GET',
      `/api/cards/${encodeURIComponent(id)}`,
      undefined,
      'safe'
    );
  }

  /**
   * Converts an investigation. Retried like a read: a second conversion of
   * the same card is refused with 409, never applied twice.
   */
  async convert(
    id: string,
    workClass: 'bug' | 'story',
    by: string
  ): Promise<ConvertedCard> {
    return this.call<ConvertedCard>(
      'POST',
      `/api/cards/${encodeURIComponent(id)}/convert`,
      { work_class: workClass, by },
      'safe'
    );
  }

  private async call<T>(
    method: string,
    path: string,
    body: unknown,
    policy: RetryPolicy
  ): Promise<T> {
    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.options.token}`,
            Accept: 'application/json',
            ...(body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        const timedOut =
          error instanceof Error &&
          (error.name === 'TimeoutError' || error.name === 'AbortError');
        const retryable = policy === 'safe' || !timedOut;
        if (retryable && attempt < this.retries) {
          await this.sleep(attempt++);
          continue;
        }
        throw new KitchenError(
          timedOut
            ? `Prepcook did not answer ${method} ${path} in time`
            : `could not reach Prepcook at ${this.options.baseUrl}`,
          0
        );
      }
      const retryable =
        policy === 'safe' ? response.status >= 500 : response.status === 503;
      if (retryable && attempt < this.retries) {
        await response.body?.cancel();
        await this.sleep(attempt++);
        continue;
      }
      let envelope: { success?: boolean; data?: T; message?: string | null };
      try {
        envelope = (await response.json()) as typeof envelope;
      } catch {
        throw new KitchenError(
          `Prepcook answered ${method} ${path} with ${response.status} and no JSON`,
          response.status
        );
      }
      if (!response.ok || envelope.success === false || !envelope.data) {
        throw new KitchenError(
          `Prepcook refused ${method} ${path} (${response.status}): ${envelope.message ?? 'no reason given'}`,
          response.status
        );
      }
      return envelope.data;
    }
  }

  private sleep(attempt: number): Promise<void> {
    return new Promise((r) => setTimeout(r, this.backoffMs * 2 ** attempt));
  }
}

/** The card id at the end of a card URL (`…/issues/<id>`). */
export function cardIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /\/issues\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(url);
  return match?.[1] ?? null;
}
