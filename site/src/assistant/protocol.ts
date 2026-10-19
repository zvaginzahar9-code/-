/**
 * Wire protocol between the browser and /api/chat. Types only: shared by the
 * serverless function (api/) and the assistant UI (src/assistant/).
 */

export const SECTIONS = ['top', 'production', 'catalog', 'items', 'experience', 'request', 'contacts'] as const;
export type SectionId = (typeof SECTIONS)[number];

export const VOLTAGES = [35, 110, 220, 330, 500] as const;

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}
export interface ChatRequest {
  messages: ChatTurn[];
}

/** A catalogue record as shown in a product card. `null` means the catalogue has no value. */
export interface ProductCard {
  slug: string;
  mark: string;
  kv: number;
  H: number;
  h: number | null;
  L: number | null;
  mass: number | null;
  wire: string | null;
  project: string | null;
  /** tower-only drawing, relative to the site root */
  image: string;
  /** a caveat recorded with the source data, shown next to the value it concerns */
  note?: string;
}
export interface ProductDetails extends ProductCard {
  specs: { label: string; value: string }[];
}
export interface CompareRow {
  label: string;
  /** one value per compared tower; null = not given in the catalogue */
  values: (string | null)[];
  differs: boolean;
}

/** Things the page does on the assistant's behalf. Each one is validated on the server. */
export type UiAction =
  | { kind: 'open_tower'; slug: string; mark: string }
  | { kind: 'section'; section: SectionId }
  | { kind: 'filter'; kv: number | null; query: string | null; view: 'line' | 'table' | null }
  | { kind: 'compare'; slugs: string[]; marks: string[] };

export interface InquiryDraft {
  items: { slug: string; mark: string; quantity: number | null }[];
  note: string | null;
}

export type ErrorCode = 'not_configured' | 'rate_limited' | 'bad_request' | 'provider' | 'unavailable' | 'timeout' | 'forbidden';

export type ServerEvent =
  | { t: 'status'; phase: 'thinking' | 'tool'; label?: string }
  | { t: 'text'; d: string }
  /** the answer text streamed so far failed the server's fact check and is withdrawn; a replacement follows */
  | { t: 'retract' }
  | { t: 'products'; items: ProductCard[]; total: number }
  | { t: 'details'; item: ProductDetails }
  | { t: 'compare'; items: ProductCard[]; rows: CompareRow[] }
  | { t: 'action'; action: UiAction }
  | { t: 'inquiry'; draft: InquiryDraft }
  | { t: 'done'; stop: 'end' | 'max_tokens' | 'refusal' | 'limit' }
  | { t: 'error'; code: ErrorCode; message: string };

export const LIMITS = {
  maxTurns: 24,
  maxUserChars: 1500,
  maxAssistantChars: 4000,
  maxTotalChars: 24000,
} as const;
