// Sketch-to-Slides model calls through a local Ollama server (default provider: no API key, no cost).
// Plain Node module (no Electron imports), shared by the Electron main process and the command-line tool.
// Ollama's /api/chat takes base64 images on the user message and constrains the output with `format` (a JSON Schema).

const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'qwen2.5vl:7b';

class OllamaError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * Parses model text as JSON. Local models sometimes wrap JSON in prose or code fences even with a schema:
 * the first balanced {...} block is tried before giving up. Never invents content.
 */
function parseModelJSON(text) {
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.indexOf('{');
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  throw new OllamaError('The local model did not return valid JSON.', 'json');
}

async function ollamaStatus(host = DEFAULT_OLLAMA_HOST) {
  try {
    const r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { running: false, models: [] };
    const j = await r.json();
    return { running: true, models: (j.models ?? []).map((m) => m.name) };
  } catch {
    return { running: false, models: [] };
  }
}

/**
 * Pixel area that Ollama's Qwen2.5-VL runner maps to its minimum of 1024 visual tokens (28×28 px each; the server
 * runs with --image-min-tokens 1024 and upscales smaller images). Sending images of this area keeps the model's
 * pixel coordinates in the frame of the image we sent (docs/SKETCH_DEVLOG.md, experiment 3).
 */
const LOCAL_IMAGE_PIXELS = 1024 * 28 * 28;
/** Cap on generated tokens: a normal answer is ~500; runaway repetition was observed (experiment 3). */
const MAX_OUTPUT_TOKENS = 2048;

/** One structured-output chat request, streamed (avoids HTTP header timeouts on slow local generation). */
async function chatJSON({ host = DEFAULT_OLLAMA_HOST, model = DEFAULT_OLLAMA_MODEL, system, text, images, schema, numCtx = 16384, timeoutMs = 10 * 60 * 1000, onProgress }) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        stream: true,
        format: schema,
        // Deterministic decoding: transcription, not creativity.
        options: { temperature: 0, num_ctx: numCtx, num_predict: MAX_OUTPUT_TOKENS },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: text, images },
        ],
      }),
    });
  } catch (e) {
    if (e?.name === 'TimeoutError') throw new OllamaError('The local model took too long.', 'timeout');
    throw new OllamaError(`Could not reach Ollama at ${host}. Is it running (ollama serve)?`, 'network');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 404) throw new OllamaError(`Model "${model}" is not installed. Run: ollama pull ${model}`, 'model');
    throw new OllamaError(`Ollama error ${res.status}: ${body.slice(0, 300)}`, 'api');
  }
  let content = '', last = null, buf = '', tokens = 0;
  const decoder = new TextDecoder();
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const j = JSON.parse(line);
        if (j.error) throw new OllamaError(`Ollama error: ${j.error}`, 'api');
        content += j.message?.content ?? '';
        tokens++;
        if (onProgress && tokens % 25 === 0) onProgress(tokens);
        if (j.done) last = j;
      }
    }
  } catch (e) {
    if (e instanceof OllamaError) throw e;
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new OllamaError('The local model took too long.', 'timeout');
    throw new OllamaError(`Connection to Ollama was interrupted: ${e?.message ?? e}`, 'network');
  }
  if (!last) throw new OllamaError('Ollama ended the response early.', 'api');
  const usage = { input_tokens: last.prompt_eval_count, output_tokens: last.eval_count, load_ms: Math.round((last.load_duration ?? 0) / 1e6), prompt_ms: Math.round((last.prompt_eval_duration ?? 0) / 1e6), eval_ms: Math.round((last.eval_duration ?? 0) / 1e6) };
  if (last.done_reason === 'length') {
    const err = new OllamaError(`The local model did not finish its answer within ${MAX_OUTPUT_TOKENS} tokens (it may be repeating itself).`, 'max-tokens');
    err.raw = content; err.usage = usage;
    throw err;
  }
  let data;
  try {
    data = parseModelJSON(content);
  } catch (e) {
    e.raw = content; e.usage = usage;
    throw e;
  }
  return { data, raw: content, model: `ollama/${last.model ?? model}`, ms: Date.now() - t0, usage, stopReason: last.done_reason };
}

module.exports = { LOCAL_IMAGE_PIXELS, chatJSON, ollamaStatus, parseModelJSON, OllamaError, DEFAULT_OLLAMA_HOST, DEFAULT_OLLAMA_MODEL };
