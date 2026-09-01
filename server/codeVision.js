// The Code agent's "eyes" (Code parity roadmap 4a).
//
// The chosen coding model drives the turn and need not be multimodal. When a
// user attaches an image, the model configured as config.code.visionModel
// describes it, and that description is spliced onto the turn's message the
// same way an @file mention is — see server/codeMentions.js. The coding model
// never sees the pixels, just a careful text description.
//
// One describe call per image so a slow/failed one is isolated. Bounded by its
// own timeout, chained to the turn's AbortController so Stop cancels it.
//
// Whether a model reports vision support is answered by ollama.js#showModel
// (via GET /api/code/model-info) — that's what Settings → Code shows the badge
// from; nothing here needs to check.

import { chat } from './ollama.js';

const MAX_IMAGES = 4;
const DEFAULT_TIMEOUT_MS = 240_000; // fallback if config.code.visionTimeoutMs is unset
const DESCRIBE_NUM_PREDICT = 900;   // a thorough paragraph or two, not an essay

const VISION_SYSTEM =
  'You are the vision component of a coding assistant. Another model, which cannot see, will act on your ' +
  'description. Describe the attached image precisely and usefully for an engineer:\n' +
  '- If it is a screenshot of a UI, describe the layout, components, text, and anything that looks wrong or broken.\n' +
  '- If it shows an error, a terminal, logs, or code, transcribe the relevant text exactly (error messages, ' +
  'file paths, line numbers, stack frames).\n' +
  '- If it is a diagram or a design, describe the structure, the labels, and the relationships.\n' +
  'Be concrete and factual. Do not speculate about code you cannot see, and do not add advice — just report ' +
  'what is in the image.';

// images: [{ name, b64 }]  (b64 = raw base64, no data: prefix)
// → { model, descriptions: [{ name, text } | { name, error }] }
export async function describeImages(config, images, { turnSignal } = {}) {
  const list = Array.isArray(images) ? images.slice(0, MAX_IMAGES) : [];
  if (!list.length) return { model: null, descriptions: [] };

  const model = (config.code?.visionModel || '').trim();
  if (!model) {
    return {
      model: null,
      descriptions: list.map((i) => ({
        name: i.name,
        error: 'no vision model is set — pick one in Settings → Code so the agent can read images',
      })),
    };
  }

  const timeoutMs = Math.min(600_000, Math.max(30_000, Math.round(config.code.visionTimeoutMs) || DEFAULT_TIMEOUT_MS));
  const descriptions = [];
  for (const img of list) {
    // The user hit Stop while an earlier image was describing — don't start the rest.
    if (turnSignal?.aborted) {
      descriptions.push({ name: img.name, error: 'cancelled' });
      continue;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const onTurnAbort = () => abort.abort();
    turnSignal?.addEventListener('abort', onTurnAbort);
    try {
      const content = await chat(config.ollama.baseUrl, {
        model,
        keepAlive: config.code.keepAlive,
        numPredict: DESCRIBE_NUM_PREDICT,
        think: false, // we want the description, not a reasoning trace that eats the time budget
        signal: abort.signal,
        timeoutMs,
        messages: [
          { role: 'system', content: VISION_SYSTEM },
          { role: 'user', content: `Describe this image (filename: ${img.name}).`, images: [img.b64] },
        ],
      });
      descriptions.push({ name: img.name, text: content });
    } catch (err) {
      descriptions.push({
        name: img.name,
        error: /cancelled|timeout|timed out/i.test(err.message)
          ? `the vision model (${model}) didn't finish in time`
          : `the vision model (${model}) couldn't read it: ${err.message}`,
      });
    } finally {
      clearTimeout(timer);
      turnSignal?.removeEventListener('abort', onTurnAbort);
    }
  }
  return { model, descriptions };
}

// Spliced onto the triggering user message's content for the turn.
export function visionBlock(descriptions) {
  if (!descriptions?.length) return '';
  return descriptions
    .map((d) =>
      d.error
        ? `\n\n[image: ${d.name} — ${d.error}]`
        : `\n\n[image: ${d.name} — described by the vision model, which is your only view of it:]\n${d.text}`
    )
    .join('');
}
