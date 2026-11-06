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

/**
 * A cut-off answer (token limit, or stopped because the model looped) still holds finished elements. Returns the complete
 * `{...}` objects of the "elements" array, in order, up to the first one that is not complete; nothing is completed or invented.
 */
function salvageElements(text) {
  const key = text.indexOf('"elements"');
  const open = key >= 0 ? text.indexOf('[', key) : -1;
  const kept = [];
  if (open < 0) return kept;
  let depth = 0, inStr = false, esc = false, start = -1;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}' && depth > 0 && --depth === 0) {
      try {
        const obj = JSON.parse(text.slice(start, i + 1));
        if (JSON.stringify(obj) !== JSON.stringify(kept[kept.length - 1])) kept.push(obj); // a looping model repeats one element: keep it once
      } catch { break; }
    } else if (c === ']' && depth === 0) break;
  }
  return kept;
}

/** True when the tail of the answer is one short unit (16-120 chars) repeated at least 4 times in a row: the model is looping. */
function isRepeating(text) {
  const tail = text.slice(-600);
  for (let u = 16; u <= 120; u++) {
    if (tail.length < u * 4) break;
    const unit = tail.slice(-u);
    if (unit.trim() && tail.slice(-u * 4) === unit.repeat(4)) return true;
  }
  return false;
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
async function chatJSON({ host = DEFAULT_OLLAMA_HOST, model = DEFAULT_OLLAMA_MODEL, system, text, images, schema, numCtx = 16384, timeoutMs = 10 * 60 * 1000, onProgress, plain = false, maxTokens = MAX_OUTPUT_TOKENS }) {
  const t0 = Date.now();
  const ac = new AbortController(); // lets us stop a looping answer instead of waiting for the token limit
  let res;
  try {
    res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ac.signal]),
      body: JSON.stringify({
        model,
        stream: true,
        ...(plain ? {} : { format: schema }),
        // Deterministic decoding: transcription, not creativity.
        options: { temperature: 0, num_ctx: numCtx, num_predict: maxTokens },
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
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
  let content = '', last = null, buf = '', tokens = 0, looped = false;
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
        if (tokens % 40 === 0 && isRepeating(content)) { looped = true; ac.abort(); break; }
      }
      if (looped) break;
    }
  } catch (e) {
    if (!looped) {
      if (e instanceof OllamaError) throw e;
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new OllamaError('The local model took too long.', 'timeout');
      throw new OllamaError(`Connection to Ollama was interrupted: ${e?.message ?? e}`, 'network');
    }
  }
  if (!last && !looped) throw new OllamaError('Ollama ended the response early.', 'api');
  const usage = last
    ? { input_tokens: last.prompt_eval_count, output_tokens: last.eval_count, load_ms: Math.round((last.load_duration ?? 0) / 1e6), prompt_ms: Math.round((last.prompt_eval_duration ?? 0) / 1e6), eval_ms: Math.round((last.eval_duration ?? 0) / 1e6) }
    : { output_tokens: tokens };
  const modelName = `ollama/${last?.model ?? model}`;
  if (plain) {
    // Free text (Document Mode): a loop is cut at the repeating tail by the caller's parser (consecutive duplicates are dropped);
    // a long answer that hit the token limit keeps what it wrote.
    return { text: content, raw: content, model: modelName, ms: Date.now() - t0, usage, stopReason: looped ? 'repeat' : last?.done_reason };
  }
  if (looped || last.done_reason === 'length') {
    // The answer was cut off (token limit) or stopped because it looped: keep the elements it finished, drop the rest.
    const kept = salvageElements(content);
    const reason = looped ? 'the model started repeating itself' : `the ${MAX_OUTPUT_TOKENS}-token limit was reached`;
    if (kept.length) {
      return { data: { elements: kept, _salvaged: { kept: kept.length, reason } }, raw: content, model: modelName, ms: Date.now() - t0, usage, stopReason: looped ? 'repeat' : 'length' };
    }
    const err = new OllamaError(`The local model did not finish its answer (${reason}) and nothing usable came before that.`, 'max-tokens');
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
  return { data, raw: content, model: modelName, ms: Date.now() - t0, usage, stopReason: last.done_reason };
}

module.exports = { LOCAL_IMAGE_PIXELS, chatJSON, ollamaStatus, parseModelJSON, salvageElements, isRepeating, OllamaError, DEFAULT_OLLAMA_HOST, DEFAULT_OLLAMA_MODEL };
