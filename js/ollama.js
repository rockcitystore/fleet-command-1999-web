// ---------------------------------------------------------------------------
// Browser-side client for a local Ollama server.
//
// Ollama listens on http://localhost:11434 by default. Its CORS policy allows
// localhost origins (verified for http://localhost:8000), so the game's own
// JavaScript can call the API directly from the browser — no proxy needed.
//
// We drive a small local model (qwen3.5:4b, ~3.4 GB Q4_K_M) as the RED fleet
// commander. The model only needs to emit a strict JSON array of orders, so a
// 4B-class model is more than enough and runs comfortably on a single GPU/CPU.
// ---------------------------------------------------------------------------

export const OLLAMA_DEFAULT_BASE = 'http://localhost:11434';
export const OLLAMA_DEFAULT_MODEL = 'qwen3.5:4b';

// Throw if the local Ollama daemon isn't reachable. Used to give the player a
// clear message instead of a generic fetch failure.
export class OllamaUnavailableError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'OllamaUnavailableError';
  }
}

// List installed models via GET /api/tags.
export async function ollamaModels(base = OLLAMA_DEFAULT_BASE) {
  let res;
  try {
    res = await fetch(`${base}/api/tags`, { method: 'GET', cache: 'no-store' });
  } catch (err) {
    throw new OllamaUnavailableError(`Cannot reach Ollama at ${base}: ${err.message}`);
  }
  if (!res.ok) throw new Error(`ollama /api/tags returned ${res.status}`);
  const data = await res.json();
  return (data.models || []).map((m) => m.name);
}

// Non-streaming chat completion via POST /api/chat.
//   messages: [{ role: 'system'|'user'|'assistant', content: string }, ...]
//   opts: { base, model, temperature, num_ctx, num_predict, timeout, signal }
// Returns the assistant message content string.
export async function ollamaChat(messages, opts = {}) {
  const base = opts.base || OLLAMA_DEFAULT_BASE;
  const model = opts.model || OLLAMA_DEFAULT_MODEL;
  const timeout = opts.timeout || 45000;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  // Allow an externally-supplied signal to also cancel us.
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }

  let res;
  try {
    res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        // qwen3.x ships with a "thinking" trace on by default, padding every
        // reply with a long internal-reasoning block. We only need the final
        // JSON array. IMPORTANT: on Ollama 0.32.x the top-level `thinking`
        // field is IGNORED for this qwen3 build, but the `think` field (the
        // OpenAI-compatible toggle) IS honored and cleanly suppresses the trace
        // (verified: thinking_len=0, real content returned). So we use `think`.
        think: opts.think != null ? opts.think : false,
        options: {
          temperature: opts.temperature != null ? opts.temperature : 0.2,
          num_ctx: opts.num_ctx || 4096,
          // Critical: Ollama's default num_predict is 128 tokens, which a
          // thinking trace alone exceeds — leaving `content` empty. Give the
          // model room to emit the JSON order array after its reasoning.
          num_predict: opts.num_predict || 1024,
        },
      }),
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new OllamaUnavailableError(`Ollama request timed out after ${timeout} ms`);
    }
    throw new OllamaUnavailableError(`Cannot reach Ollama at ${base}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error(`ollama /api/chat returned ${res.status} ${res.statusText} ${detail}`);
  }
  const data = await res.json();
  return (data && data.message && data.message.content) || '';
}

// Convenience: ask the model a single prompt and get the text reply.
export async function ollamaAsk(prompt, opts = {}) {
  return ollamaChat([{ role: 'user', content: prompt }], opts);
}

// Streaming chat completion via POST /api/chat (stream: true).
//   opts.onToken(deltaText, fullTextSoFar) is invoked for every content delta
//   as tokens arrive, so the caller can render the reply live.
// Returns the full concatenated assistant content.
export async function ollamaChatStream(messages, opts = {}) {
  const base = opts.base || OLLAMA_DEFAULT_BASE;
  const model = opts.model || OLLAMA_DEFAULT_MODEL;
  const timeout = opts.timeout || 45000;
  const onToken = typeof opts.onToken === 'function' ? opts.onToken : () => {};

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }

  let res;
  try {
    res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        think: opts.think != null ? opts.think : false,
        options: {
          temperature: opts.temperature != null ? opts.temperature : 0.2,
          num_ctx: opts.num_ctx || 4096,
          num_predict: opts.num_predict || 1024,
        },
      }),
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new OllamaUnavailableError(`Ollama request timed out after ${timeout} ms`);
    }
    throw new OllamaUnavailableError(`Cannot reach Ollama at ${base}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error(`ollama /api/chat returned ${res.status} ${res.statusText} ${detail}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Ollama streams newline-delimited JSON objects.
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        const delta = (obj.message && (obj.message.content || obj.message.thinking)) || '';
        if (delta) {
          full += delta;
          onToken(delta, full);
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  // Flush any trailing frame without a trailing newline.
  const tail = buffer.trim();
  if (tail) {
    try {
      const obj = JSON.parse(tail);
      const delta = (obj.message && (obj.message.content || obj.message.thinking)) || '';
      if (delta) { full += delta; onToken(delta, full); }
    } catch { /* ignore */ }
  }
  return full;
}
