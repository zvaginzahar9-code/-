import Anthropic from '@anthropic-ai/sdk';
import type { ChatTurn, ServerEvent } from '../src/assistant/protocol.ts';
import { checkAnswer, quotesInstructions, safeAnswer, sanitizeCall } from './guard.ts';
import { SYSTEM_PROMPT } from './prompt.ts';
import { runTool, toolDefinitions, toolLabel } from './tools.ts';

/** Conversation loop: model → tools → model, with hard limits on rounds, calls and time. */

export const TURN_LIMITS = {
  /** model requests per user message */
  maxRounds: 5,
  /** tool calls per user message */
  maxToolCalls: 8,
  /** one model request, ms */
  requestTimeoutMs: 40_000,
  /** the whole turn, ms (the function itself is capped at 60 s in vercel.json) */
  turnTimeoutMs: 52_000,
  maxOutputTokens: 4000,
} as const;

/** The slice of the SDK the loop uses; tests pass a scripted double. */
export interface ModelClient {
  messages: {
    stream(body: Anthropic.MessageStreamParams, options?: { signal?: AbortSignal; timeout?: number }): {
      on(event: 'text', listener: (delta: string) => void): unknown;
      finalMessage(): Promise<Anthropic.Message>;
    };
  };
}

export type TurnLimits = { -readonly [K in keyof typeof TURN_LIMITS]: number };

export interface TurnOptions {
  client: ModelClient;
  /** overrides for slower providers */
  limits?: Partial<TurnLimits>;
  model: string;
  effort: 'low' | 'medium' | 'high';
  history: ChatTurn[];
  emit: (event: ServerEvent) => void;
  signal?: AbortSignal;
  now?: () => number;
}

export interface TurnReport {
  rounds: number;
  tools: string[];
  stop: string;
  /** kinds of unsupported statements the fact check found (the answer was replaced) */
  withdrawn: string[];
  /** where the time went: one entry per model request and per tool call, in order */
  steps: Record<string, string | number>[];
  inputTokens: number;
  outputTokens: number;
}

export async function runTurn(o: TurnOptions): Promise<TurnReport> {
  const now = o.now ?? Date.now;
  const started = now();
  const limits = { ...TURN_LIMITS, ...o.limits };
  const messages: Anthropic.MessageParam[] = o.history.map(m => ({ role: m.role, content: m.content }));
  const report: TurnReport = { rounds: 0, tools: [], stop: 'end', withdrawn: [], steps: [], inputTokens: 0, outputTokens: 0 };
  const seen = new Set<string>();
  // what the fact check needs at the end of the turn
  let answer = '';
  const toolResults: string[] = [];
  const actions = new Map<string, boolean>(); // page-action tool → did it succeed
  let cards = false;
  const ACTIONS = ['open_tower_sheet', 'go_to_section', 'filter_catalog', 'open_comparison'];

  /** Withdraws an answer that states things nothing supports, and says only what is certain. */
  const verify = () => {
    const failedActions = [...actions].filter(([, ok]) => !ok).map(([name]) => name);
    const violations = checkAnswer({ text: answer, history: o.history, toolResults, failedActions });
    if (!violations.length) return;
    report.withdrawn = [...new Set(violations.map(v => v.kind))];
    o.emit({ t: 'retract' });
    o.emit({ t: 'text', d: safeAnswer(violations, { cards, failedAction: failedActions.length > 0 }) });
  };

  const finish = (stop: 'end' | 'max_tokens' | 'refusal' | 'limit') => {
    report.stop = stop;
    o.emit({ t: 'done', stop });
    return report;
  };

  while (true) {
    if (o.signal?.aborted) {
      report.stop = 'aborted';
      return report;
    }
    const left = limits.turnTimeoutMs - (now() - started);
    if (report.rounds >= limits.maxRounds || left < 3000) return finish('limit');
    report.rounds++;
    o.emit({ t: 'status', phase: 'thinking' });

    // lets the turn stop the model the moment it starts reciting its instructions
    const cut = new AbortController();
    const onOuterAbort = () => cut.abort();
    o.signal?.addEventListener('abort', onOuterAbort, { once: true });
    let leaked = false;
    const stream = o.client.messages.stream(
      {
        model: o.model,
        max_tokens: limits.maxOutputTokens,
        system: SYSTEM_PROMPT,
        tools: toolDefinitions,
        messages,
        output_config: { effort: o.effort },
        cache_control: { type: 'ephemeral' },
      },
      { signal: cut.signal, timeout: Math.min(limits.requestTimeoutMs, left) },
    );
    stream.on('text', d => {
      if (leaked) return;
      answer += d;
      if (quotesInstructions(answer)) {
        leaked = true;
        cut.abort();
        return;
      }
      o.emit({ t: 'text', d });
    });
    const asked = now();
    let message: Anthropic.Message;
    try {
      message = await stream.finalMessage();
    } catch (e) {
      if (!leaked) throw e;
      // generation was cut off on purpose: withdraw what was shown and say only what is certain
      report.steps.push({ step: 'model', ms: now() - asked, cut: 'instructions' });
      verify();
      return finish('end');
    } finally {
      o.signal?.removeEventListener('abort', onOuterAbort);
    }
    if (leaked) {
      verify();
      return finish('end');
    }
    const timings = (message as { timings?: Record<string, string | number>[] }).timings;
    if (timings?.length) report.steps.push(...timings);
    else report.steps.push({ step: 'model', ms: now() - asked, inTokens: message.usage?.input_tokens ?? 0, outTokens: message.usage?.output_tokens ?? 0 });
    report.inputTokens += message.usage?.input_tokens ?? 0;
    report.outputTokens += message.usage?.output_tokens ?? 0;

    if (message.stop_reason === 'refusal') {
      verify();
      return finish('refusal');
    }
    const calls = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    // a tool call cut off by the token limit is never run
    if (message.stop_reason === 'max_tokens') {
      verify();
      return finish('max_tokens');
    }
    if (message.stop_reason !== 'tool_use' || !calls.length) {
      verify();
      return finish('end');
    }
    // text written before a tool call is a preamble, not the answer
    if (answer) {
      answer = '';
      o.emit({ t: 'retract' });
    }

    messages.push({ role: 'assistant', content: message.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      const key = `${call.name}:${JSON.stringify(call.input)}`;
      let outcome;
      if (report.tools.length >= limits.maxToolCalls) {
        outcome = { result: { error: 'Лимит действий на один запрос исчерпан. Ответь пользователю тем, что уже известно.' }, isError: true };
      } else if (seen.has(key)) {
        outcome = { result: { error: 'Этот вызов уже выполнен в текущем запросе — используй полученный результат.' }, isError: true };
      } else {
        seen.add(key);
        report.tools.push(call.name);
        o.emit({ t: 'status', phase: 'tool', label: toolLabel(call.name) });
        // arguments the model added on its own are removed before the tool runs
        const clean = sanitizeCall(call.name, call.input, o.history);
        const ranAt = performance.now();
        outcome = runTool(call.name, clean.input);
        report.steps.push({ step: 'tool', name: call.name, ms: Math.round((performance.now() - ranAt) * 100) / 100 });
        if (clean.dropped.length && outcome.result && typeof outcome.result === 'object') {
          outcome.result = { ...(outcome.result as object), ignored_arguments: clean.dropped };
        }
        outcome.events?.forEach(o.emit);
        if (ACTIONS.includes(call.name)) actions.set(call.name, !outcome.isError); // the latest attempt decides
        if (outcome.events?.some(e => (e.t === 'products' && e.items.length > 0) || e.t === 'details' || e.t === 'compare')) cards = true;
      }
      const content = JSON.stringify(outcome.result);
      toolResults.push(content);
      results.push({ type: 'tool_result', tool_use_id: call.id, content, ...(outcome.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
}
