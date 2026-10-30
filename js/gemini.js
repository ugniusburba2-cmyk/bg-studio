// Minimal Gemini API client (runs straight from the browser with your own key).
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

const clean = (m) => String(m || '').trim().replace(/^models\//, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function friendlyError(status, text) {
  let msg = text;
  try { msg = JSON.parse(text).error?.message || text; } catch {}
  if (status === 400 && /API key not valid/i.test(msg)) return 'Your API key is not valid. Check it in Settings.';
  if (status === 404) return `Model not found (${msg}). Open Settings and tap "Test key" to pick an available model.`;
  if (status === 429) return 'Rate limit or quota reached. Image generation needs billing enabled on your Google AI Studio key. Wait a minute and try again.';
  if (status === 403) return `Access denied: ${msg}`;
  return `Gemini error ${status}: ${String(msg).slice(0, 300)}`;
}

/**
 * parts: [{text}, {inline_data:{mime_type,data}}]
 * opts: { image: bool, aspectRatio, json: bool }
 * returns { text, images: [{mimeType, data}] }
 */
export async function generate({ apiKey, model, parts, image = false, aspectRatio = null, json = false }) {
  if (!apiKey) throw new Error('Add your Gemini API key in Settings first.');
  const body = { contents: [{ role: 'user', parts }] };
  const gc = {};
  if (image) {
    gc.responseModalities = ['TEXT', 'IMAGE'];
    if (aspectRatio) gc.imageConfig = { aspectRatio };
  }
  if (json) gc.responseMimeType = 'application/json';
  if (Object.keys(gc).length) body.generationConfig = gc;

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = await fetch(`${BASE}/models/${encodeURIComponent(clean(model))}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastErr = new Error('Network error — check your connection.');
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (res.ok) {
      const data = await res.json();
      const cand = data.candidates?.[0];
      const out = { text: '', images: [] };
      for (const p of cand?.content?.parts || []) {
        const inl = p.inlineData || p.inline_data;
        if (inl?.data) out.images.push({ mimeType: inl.mimeType || inl.mime_type || 'image/png', data: inl.data });
        else if (p.text && !p.thought) out.text += p.text;
      }
      if (image && !out.images.length) {
        const why = cand?.finishReason || data.promptFeedback?.blockReason || 'no image returned';
        throw new Error(`The model didn't return an image (${why}). ${out.text ? 'It said: ' + out.text.slice(0, 200) : 'Try again.'}`);
      }
      return out;
    }
    const text = await res.text();
    // Some models don't accept imageConfig — retry without it.
    if (res.status === 400 && body.generationConfig?.imageConfig && /imageConfig|aspect/i.test(text)) {
      delete body.generationConfig.imageConfig;
      continue;
    }
    lastErr = new Error(friendlyError(res.status, text));
    if (res.status === 429 || res.status >= 500) { await sleep(3000 * (attempt + 1)); continue; }
    throw lastErr;
  }
  throw lastErr;
}

export async function listModels(apiKey) {
  const res = await fetch(`${BASE}/models?pageSize=1000`, { headers: { 'x-goog-api-key': apiKey } });
  if (!res.ok) throw new Error(friendlyError(res.status, await res.text()));
  const data = await res.json();
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => clean(m.name));
}

const IMAGE_PREF = [
  'gemini-3.1-flash-image', 'gemini-3.1-flash-image-preview', 'gemini-nano-banana-2.1',
  'gemini-3-pro-image', 'gemini-3-pro-image-preview', 'gemini-2.5-flash-image',
];
const TEXT_PREF = ['gemini-flash-latest', 'gemini-3.1-flash', 'gemini-3-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash'];

export function pickModels(names) {
  const isImage = (n) => /image|banana/i.test(n);
  const img = IMAGE_PREF.find((m) => names.includes(m)) || names.find((n) => isImage(n) && /flash/i.test(n)) || names.find(isImage);
  const txt = TEXT_PREF.find((m) => names.includes(m)) ||
    names.find((n) => /flash/i.test(n) && !/image|tts|live|audio|embedding|lite/i.test(n));
  return { image: img, text: txt, imageModels: names.filter(isImage), textModels: names.filter((n) => !isImage(n) && !/tts|embedding|audio|live/i.test(n)) };
}

export function parseJSON(text) {
  const t = String(text || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(t); } catch {}
  const m = t.match(/[\[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  throw new Error('Could not understand the AI response. Try again.');
}
