// Sketch-to-Slides model calls. Providers: 'ollama' (default, local, sketch-ollama.cjs) and 'anthropic' (Claude, optional). Plain Node module: used by the Electron main process
// (electron/sketch-main.cjs) and by the command-line tool (scripts/sketch2slides.mjs). No Electron imports here.
// The API key is passed in by the caller; it never reaches the renderer and is never logged.
const Anthropic = require('@anthropic-ai/sdk');
const { RECOGNIZE_SYSTEM, RECOGNIZE_USER, REVIEW_SYSTEM, LOCAL_RECOGNIZE_SYSTEM, localRecognizeUser } = require('./sketch-prompts.cjs');
const { LOCAL_SCHEMA, localToModelIR } = require('./sketch-local.cjs');
const ollama = require('./sketch-ollama.cjs');

const DEFAULT_MODEL = 'claude-opus-5-5';

class SketchAIError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function imageBlock(img) {
  return { type: 'image', source: { type: 'base64', media_type: img.mime || 'image/png', data: img.base64 } };
}

/** One structured-output request. Returns { data, usage, model, ms, stopReason }. */
async function callJSON({ apiKey, model, system, content, schema, effort }) {
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 5 * 60 * 1000 });
  const t0 = Date.now();
  let res;
  try {
    res = await client.beta.messages.create({
      model: model || DEFAULT_MODEL,
      max_tokens: 16000,
      // A declined request is re-run server-side on Anthropic's recommended fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: effort || 'high', format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new SketchAIError('The API key was rejected. Check it in AI settings.', 'auth');
    if (e instanceof Anthropic.PermissionDeniedError) throw new SketchAIError('This API key may not use the model.', 'permission');
    if (e instanceof Anthropic.RateLimitError) throw new SketchAIError('Rate limited by the API. Try again in a moment.', 'rate');
    if (e instanceof Anthropic.BadRequestError) throw new SketchAIError(`The API rejected the request: ${e.message}`, 'bad-request');
    if (e instanceof Anthropic.APIConnectionError) throw new SketchAIError('Could not reach the API (network).', 'network');
    if (e instanceof Anthropic.APIError) throw new SketchAIError(`API error ${e.status}: ${e.message}`, 'api');
    throw e;
  }
  const ms = Date.now() - t0;
  if (res.stop_reason === 'refusal') throw new SketchAIError(`The model declined this image (${res.stop_details?.category ?? 'unspecified'}).`, 'refusal');
  if (res.stop_reason === 'max_tokens') throw new SketchAIError('The model response was cut off (too many elements).', 'max-tokens');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new SketchAIError('The model did not return valid JSON.', 'json');
  }
  return { data, usage: res.usage, model: res.model, ms, stopReason: res.stop_reason };
}

/** image: { base64, mime, width, height }. Returns the raw model IR ({ elements, notes }). */
async function recognize({ provider = 'ollama', apiKey, model, host, image, schema, onProgress }) {
  if (provider === 'ollama') {
    // Local models get their own short prompt and flat pixel format, converted here to the shared IR.
    const r = await ollama.chatJSON({
      host, model, schema: LOCAL_SCHEMA, system: LOCAL_RECOGNIZE_SYSTEM, images: [image.base64], onProgress,
      text: localRecognizeUser(image.width, image.height),
    });
    return { ...r, local: r.data, data: localToModelIR(r.data, image.width, image.height) };
  }
  return callJSON({
    apiKey, model, schema, effort: 'high',
    system: RECOGNIZE_SYSTEM,
    content: [imageBlock(image), { type: 'text', text: `${RECOGNIZE_USER}\nImage size: ${image.width}×${image.height} px.` }],
  });
}

/** original/rendering: images; ir: the IR the rendering was built from. Returns { ok, summary, patches }. */
async function review({ provider = 'ollama', apiKey, model, host, original, rendering, ir, issues, schema }) {
  const checks = Array.isArray(issues) && issues.length
    ? `\n\nAutomatic checks reported these problems (fix them if they are real conversion errors):\n- ${issues.join('\n- ')}`
    : '';
  if (provider === 'ollama') {
    return ollama.chatJSON({
      host, model, schema, system: REVIEW_SYSTEM, images: [original.base64, rendering.base64],
      text: `The first image is the ORIGINAL hand-drawn image, the second is the RENDERING of the converted slide.\nIntermediate description (JSON):\n${JSON.stringify({ elements: ir.elements })}${checks}`,
    });
  }
  return callJSON({
    apiKey, model, schema, effort: 'high',
    system: REVIEW_SYSTEM,
    content: [
      { type: 'text', text: 'ORIGINAL hand-drawn image:' },
      imageBlock(original),
      { type: 'text', text: 'RENDERING of the converted slide:' },
      imageBlock(rendering),
      { type: 'text', text: `Intermediate description (JSON):\n${JSON.stringify({ elements: ir.elements }, null, 1)}${checks}` },
    ],
  });
}

module.exports = { recognize, review, SketchAIError, DEFAULT_MODEL, ollama };
