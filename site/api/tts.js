// GENERATED from server/ by scripts/build_api.mjs — edit the sources, then run `npm run build:api`.
//#region server/http.ts
const EFFORTS = [
	"low",
	"medium",
	"high"
];
function readConfig(env) {
	const effort = env.ASSISTANT_EFFORT;
	const apiKey = env.ANTHROPIC_API_KEY?.trim() || null;
	const geminiKey = env.GEMINI_API_KEY?.trim() || null;
	const hosted = Boolean(env.VERCEL);
	const named = env.ASSISTANT_PROVIDER?.trim().toLowerCase();
	const provider = named === "anthropic" || named === "gemini" || named === "ollama" ? named : hosted && geminiKey && !env.OLLAMA_BASE_URL?.trim() ? "gemini" : "ollama";
	const levels = [
		"minimal",
		"low",
		"medium",
		"high"
	];
	const level = env.GEMINI_THINKING_LEVEL?.trim().toLowerCase();
	const baseUrl = env.OLLAMA_BASE_URL?.trim() || (hosted ? null : "http://127.0.0.1:11434");
	const numCtx = Number(env.OLLAMA_NUM_CTX);
	const model = env.ASSISTANT_MODEL?.trim() || (provider === "ollama" ? "qwen3:8b" : provider === "gemini" ? "gemini-3.5-flash-lite" : "claude-opus-5-5");
	const mode = env.ASSISTANT_TOOL_MODE?.trim().toLowerCase();
	const toolMode = mode === "native" || mode === "json" ? mode : model.toLowerCase().startsWith("qwen3") ? "native" : "json";
	return {
		provider,
		model,
		configured: provider === "ollama" ? baseUrl !== null : provider === "gemini" ? geminiKey !== null : apiKey !== null,
		apiKey,
		effort: EFFORTS.includes(effort) ? effort : "low",
		gemini: {
			apiKey: geminiKey,
			baseUrl: env.GEMINI_BASE_URL?.trim() || "https://generativelanguage.googleapis.com",
			thinkingLevel: levels.includes(level) ? level : "minimal"
		},
		ollama: {
			baseUrl,
			apiKey: env.OLLAMA_API_KEY?.trim() || null,
			numCtx: Number.isInteger(numCtx) && numCtx >= 2048 && numCtx <= 65536 ? numCtx : 8192,
			keepAlive: /^-?\d+[smh]?$/.test(env.OLLAMA_KEEP_ALIVE?.trim() ?? "") ? env.OLLAMA_KEEP_ALIVE.trim() : "30m",
			think: env.ASSISTANT_THINK === "1",
			toolMode
		}
	};
}
const USER_MESSAGES = {
	not_configured: "Ассистент ещё не подключён к языковой модели. Каталог и форма заявки на сайте работают как обычно.",
	rate_limited: "Слишком много запросов подряд. Подождите минуту и повторите.",
	bad_request: "Не удалось обработать сообщение. Сократите его и попробуйте ещё раз.",
	provider: "Языковая модель сейчас недоступна. Попробуйте ещё раз чуть позже.",
	unavailable: "Языковая модель не отвечает. Если это локальный запуск — проверьте, что Ollama запущен, и повторите.",
	timeout: "Ответ занял слишком много времени. Попробуйте повторить запрос.",
	forbidden: "Запрос отклонён."
};
const STATUS = {
	not_configured: 503,
	rate_limited: 429,
	bad_request: 400,
	provider: 502,
	unavailable: 503,
	timeout: 504,
	forbidden: 403
};
function errorResponse(code, headers = {}) {
	return Response.json({
		error: code,
		message: USER_MESSAGES[code]
	}, {
		status: STATUS[code],
		headers: {
			"Cache-Control": "no-store",
			...headers
		}
	});
}
/**
* The assistant is same-origin only: browsers of other sites are turned away. This stops
* cross-site use from a visitor's browser; it is not abuse protection — a script can omit
* these headers, and for it only the limits below (and the provider's spend cap) apply.
*/
function originAllowed(request) {
	const site = request.headers.get("sec-fetch-site");
	if (site && site !== "same-origin") return false;
	const origin = request.headers.get("origin");
	if (!origin) return true;
	const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}
/**
* Fixed-window limiter kept in the function instance's memory. It slows down a single
* abusive client per warm instance; it is not a global quota (that needs a shared store).
*/
function createRateLimiter(max, windowMs, now = Date.now) {
	const hits = /* @__PURE__ */ new Map();
	return (key) => {
		const t = now();
		if (hits.size > 5e3) {
			for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
			for (const k of hits.keys()) {
				if (hits.size <= 4e3) break;
				hits.delete(k);
			}
		}
		const cur = hits.get(key);
		if (!cur || cur.reset <= t) {
			hits.set(key, {
				n: 1,
				reset: t + windowMs
			});
			return {
				ok: true,
				retryAfter: 0
			};
		}
		cur.n++;
		return {
			ok: cur.n <= max,
			retryAfter: Math.ceil((cur.reset - t) / 1e3)
		};
	};
}
const clientKey = (request) => request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
//#endregion
//#region server/tts.ts
/**
* POST /api/tts {text} — the assistant's answer read aloud by a neural voice (Gemini TTS).
* The audio streams back as raw 16-bit PCM, mono, 24 kHz, while it is being generated, so the
* page starts playing before the whole phrase is synthesised. The key stays on the server.
* When the voice is unavailable (no key, quota, outage) the page falls back to the browser voice.
*
* Request format: Interactions API with `response_format: {type: "audio"}` and a
* `speech_metadata` annotation for the delivery style (ai.google.dev/gemini-api/docs/speech-generation).
*/
const MAX_CHARS = 900;
const perMinute = createRateLimiter(30, 6e4);
const perHour = createRateLimiter(240, 36e5);
const SAMPLE_RATE = 24e3;
const runtimeEnv = () => globalThis.process?.env ?? {};
/**
* The voice and its manner: a lively, warm consultant rather than a reader of letters.
* Each TTS model has its own free-tier quota, so when one answers 429 the next is tried
* (GEMINI_TTS_MODEL may list several, comma-separated).
*/
function ttsSettings(env) {
	const models = (env.GEMINI_TTS_MODEL?.trim() || "gemini-3.8-flash-lite-tts,gemini-3.8-flash-tts,gemini-3.1-flash-tts-preview").split(",").map((s) => s.trim()).filter(Boolean);
	return {
		model: models[0],
		models,
		voice: env.GEMINI_TTS_VOICE?.trim() || "Puck",
		style: env.GEMINI_TTS_STYLE?.trim() || "warm, lively and friendly, like an engaged consultant talking to a client; natural conversational pace with expressive intonation"
	};
}
/**
* Text as it should be heard: abbreviations a speech model mispronounces or spells out with a
* foreign accent are written the way a Russian speaker says them; list dashes and quotes go.
*/
function speakable(text) {
	const word = (w, unitAfterDigit = false) => new RegExp(`${unitAfterDigit ? "(?<=\\d\\s?)" : "(?<![\\p{L}\\d])"}${w}(?![\\p{L}\\d])`, "gu");
	const words = [
		[word("кВ", true), " киловольт"],
		[word("кВ"), "киловольт"],
		[word("МВт", true), " мегаватт"],
		[word("ШГЭС"), "Шульбинская гэс"],
		[word("ВЛ"), "вэ-эл"],
		[word("ТОО"), "тэ-о-о"],
		[word("ООО"), "о-о-о"],
		[word("ОРУ"), "о-эр-у"],
		[word("ПС"), "подстанция"],
		[word("КМД"), "кэ-эм-дэ"],
		[word("КЗГЦ"), "кэ-зэ-гэ-цэ"],
		[word("ЭК"), "э-ка"],
		[word("ЭМК"), "э-эм-ка"],
		[word("ГЭС"), "гэс"],
		[word("ВЭС"), "вэс"],
		[word("ВКО"), "Восточно-Казахстанская область"],
		[word("РК"), "Республики Казахстан"],
		[word("БИН"), "бин"]
	];
	let t = text.replace(/[«»"“”]/g, "").replace(/^\s*[-•*]\s+/gm, "").replace(/\s+[—–]\s+/g, ", ");
	for (const [re, to] of words) t = t.replace(re, to);
	return t.replace(/\s+/g, " ").replace(/\s+([,.])/g, "$1").trim();
}
function base64ToBytes(b64) {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
async function handleTts(request, deps = {}) {
	const env = deps.env ?? runtimeEnv();
	const config = readConfig(env);
	const apiKey = config.gemini.apiKey;
	if (request.method === "GET") return Response.json({ configured: !!apiKey }, { headers: { "Cache-Control": "no-store" } });
	if (request.method !== "POST") return new Response(null, {
		status: 405,
		headers: { Allow: "GET, POST" }
	});
	if (!originAllowed(request)) return errorResponse("forbidden");
	if (!request.headers.get("content-type")?.trim().toLowerCase().startsWith("application/json")) return errorResponse("bad_request");
	if (Number(request.headers.get("content-length") ?? 0) > 8e3) return errorResponse("bad_request");
	const key = clientKey(request);
	const gate = deps.limit ? deps.limit(key) : [perMinute(key), perHour(key)].find((r) => !r.ok) ?? {
		ok: true,
		retryAfter: 0
	};
	if (!gate.ok) return errorResponse("rate_limited", { "Retry-After": String(gate.retryAfter) });
	let text = "";
	try {
		const body = JSON.parse(await request.text());
		text = typeof body.text === "string" ? body.text.replace(/\s+/g, " ").trim() : "";
	} catch {
		return errorResponse("bad_request");
	}
	if (!text || text.length > MAX_CHARS) return errorResponse("bad_request");
	if (!apiKey) return errorResponse("not_configured");
	const { models, voice, style } = ttsSettings(env);
	const spoken = speakable(text);
	const doFetch = deps.fetch ?? fetch;
	const upstream = new AbortController();
	request.signal?.addEventListener("abort", () => upstream.abort(), { once: true });
	const timer = setTimeout(() => upstream.abort(), 3e4);
	let res;
	let model = models[0];
	for (model of models) {
		try {
			res = await doFetch(`${config.gemini.baseUrl.replace(/\/+$/, "")}/v1beta/interactions?alt=sse`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-goog-api-key": apiKey
				},
				body: JSON.stringify({
					model,
					input: [{
						type: "user_input",
						content: [{
							type: "text",
							text: spoken,
							annotations: [{
								type: "speech_metadata",
								style
							}]
						}]
					}],
					response_format: {
						type: "audio",
						mime_type: "audio/l16",
						sample_rate: SAMPLE_RATE
					},
					generation_config: { speech_config: [{ voice }] },
					stream: true
				}),
				signal: upstream.signal,
				redirect: "error"
			});
		} catch {
			clearTimeout(timer);
			return errorResponse("unavailable");
		}
		if (res.status !== 429 && res.status !== 404) break;
		console.error(JSON.stringify({
			evt: "tts_fallback",
			status: res.status,
			model
		}));
		await res.body?.cancel().catch(() => {});
	}
	if (!res.ok || !res.body) {
		clearTimeout(timer);
		console.error(JSON.stringify({
			evt: "tts_error",
			status: res.status,
			model
		}));
		return errorResponse(res.status === 429 ? "rate_limited" : res.status === 401 || res.status === 403 ? "not_configured" : "unavailable");
	}
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	const started = Date.now();
	let bytes = 0;
	const body = new ReadableStream({
		async start(controller) {
			let buffer = "";
			let odd = null;
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
					const frames = buffer.split("\n\n");
					buffer = frames.pop() ?? "";
					for (const frame of frames) {
						const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
						if (!data || data === "[DONE]") continue;
						let e;
						try {
							e = JSON.parse(data);
						} catch {
							continue;
						}
						if (e.event_type === "step.delta" && e.delta?.type === "audio" && e.delta.data) {
							let chunk = base64ToBytes(e.delta.data);
							if (odd !== null) {
								const joined = new Uint8Array(chunk.length + 1);
								joined[0] = odd;
								joined.set(chunk, 1);
								chunk = joined;
								odd = null;
							}
							if (chunk.length % 2) {
								odd = chunk[chunk.length - 1];
								chunk = chunk.subarray(0, chunk.length - 1);
							}
							bytes += chunk.length;
							controller.enqueue(chunk);
						}
					}
				}
			} catch {} finally {
				clearTimeout(timer);
				console.log(JSON.stringify({
					evt: "tts",
					model,
					voice,
					chars: text.length,
					seconds: +(bytes / 2 / SAMPLE_RATE).toFixed(1),
					ms: Date.now() - started
				}));
				try {
					controller.close();
				} catch {}
			}
		},
		cancel() {
			upstream.abort();
		}
	});
	return new Response(body, { headers: {
		"Content-Type": `audio/L16; rate=${SAMPLE_RATE}; channels=1`,
		"Cache-Control": "no-store",
		"X-Sample-Rate": String(SAMPLE_RATE)
	} });
}
//#endregion
//#region server/tts-entry.ts
/** Vercel Function entry: the assistant's neural voice (see tts.ts). */
var tts_entry_default = { fetch: (request) => handleTts(request) };
//#endregion
export { tts_entry_default as default };
