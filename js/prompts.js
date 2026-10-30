// All prompts in one place, so they're easy to tweak.

const ANGLE = {
  top_down: 'shot straight down from directly above (flat-lay / top-down view)',
  high_angle: 'shot from above at roughly a 45 degree angle',
  eye_level: 'shot at eye level, straight on',
  low_angle: 'shot from slightly below',
};
export const anglePhrase = (a) => ANGLE[a] || ANGLE.top_down;

export const analyze = `Analyze this product photo for an online reseller (Vinted, Depop, eBay, etc.).
Return ONLY JSON with exactly these keys:
{
 "shot_type": "full_product" | "partial" | "closeup_detail" | "label_or_tag" | "other",
 "product": "short description, e.g. 'black Nike hoodie, folded'",
 "camera_angle": "top_down" | "high_angle" | "eye_level" | "low_angle",
 "coverage": number 0-100 (roughly how much of the frame the product fills),
 "current_background": "what is behind / under the product right now",
 "lighting": "light direction, softness and colour temperature",
 "room_for_props": true | false (true only if there is clearly visible empty background space around the product where a small decorative object could sit naturally),
 "notes": "anything a retoucher should know (reflections, transparent parts, hanging straps, etc.)"
}`;

export function suggest(angle) {
  return `You are an art director for resale listing photos (Vinted, Depop, eBay, Grailed).
Look at the product photo(s). Suggest 4 DIFFERENT background scenes that would make this product look premium, realistic and more likely to sell.
Every scene must be a real-world surface or setting that works for this camera angle: ${anglePhrase(angle)}.
(For top-down flat lays think floors, tables, bedsheets, rugs, paper sweeps. For eye-level think rooms, walls, studio sweeps.)
Make them varied: 1) clean & minimal, 2) warm & cozy, 3) premium / luxury, 4) trendy lifestyle.
Pick colours that complement the product without clashing or blending into it.
Return ONLY JSON: {"ideas":[{"name":"2-4 words","description":"one detailed sentence describing ONLY the empty surface/scene: material, colour, texture, lighting, mood"}]}`;
}

export function backdrop(description, angle) {
  return `Generate a photorealistic, EMPTY background plate for product photography.
Scene: ${description}
Camera: ${anglePhrase(angle)} — the same height and angle as a phone photo of a product placed on this surface.
Lighting: soft, natural and realistic with gentle falloff.
The scene must be completely empty: no products, no clothing, no people, no hands, no text, no logos, no watermark. Keep the central area clear where a product will be placed.
Ultra-detailed, sharp, high resolution, looks like a real photo, not a render.`;
}

export const describeBg = `Describe this background/surface in one detailed sentence for a photo retoucher: material, colour, texture, lighting direction, mood. Return only the sentence.`;

export function replaceBg({ analysis, hasRef, bgDescription, rules = [], variation = 0 }) {
  const a = analysis || {};
  const lines = [];
  lines.push('You are a world-class product photo retoucher for e-commerce listings.');
  lines.push(hasRef
    ? 'IMAGE 1 is the original product photo. IMAGE 2 is the background reference scene.'
    : 'IMAGE 1 is the original product photo.');
  lines.push(`TASK: Replace everything around the product in IMAGE 1 with ${hasRef ? 'the scene from IMAGE 2' : 'this scene'}${bgDescription ? ` (${bgDescription})` : ''}.`);
  lines.push(`
RULES — THE PRODUCT:
- The product must stay EXACTLY the same: same shape, outline, folds, wrinkles, stitching, fabric texture, colours, prints, logos, text, tags, hardware and size.
- Keep the product in the same position, scale and orientation in the frame. Do not redraw, restyle, straighten, iron, or "improve" it. Do not add, remove or move any detail on it.
- Only allowed product change: a very subtle exposure / white-balance harmonisation so it looks like it was really shot in the new scene. True colours must be preserved.

RULES — THE SCENE:
- Keep the original camera angle, crop and composition of IMAGE 1.${hasRef ? '\n- Adapt the reference scene to this photo: match perspective, viewing angle, texture scale and lighting to IMAGE 1. Do NOT just paste IMAGE 2 flat behind the product. Keep its material, colour and style identical so every photo in the set looks shot in the same place.' : ''}
- Completely remove the original floor / surface / wall and any clutter, hands or other objects.
- Add realistic contact shadows and soft ambient occlusion where the product touches the surface, consistent with the scene's light direction.
- Clean, natural edges — no halos, cut-out outlines or blur seams around the product.
- Photorealistic, sharp, high resolution. No text, watermarks, borders or frames.`);
  if (a.shot_type === 'closeup_detail' || a.shot_type === 'label_or_tag') {
    lines.push('- This is a close-up / detail shot: only small parts of the background are visible. Keep that background natural and slightly out of focus like a real macro shot. Do not add any objects.');
  }
  if (a.notes) lines.push(`- Retoucher note about this photo: ${a.notes}`);
  if (rules.length) {
    lines.push('\nALSO APPLY THESE SAVED PROJECT EDITS:');
    for (const r of rules) lines.push(`- ${r.text} (small, tasteful, realistic, placed in empty space, never covering the product)`);
  }
  if (variation > 0) {
    lines.push(`\nVARIATION SET #${variation}: keep the same background material, colour and style, but make this a fresh, distinct shot — shift the texture/pattern placement, any props' arrangement and the light angle slightly so it doesn't look identical to earlier listings. The product itself stays exactly the same.`);
  }
  return lines.join('\n');
}

export function edit(request) {
  return `Edit this product listing photo: ${request}
RULES: Keep the product exactly as it is (shape, colours, logos, text, tags, folds) and keep the background, framing and lighting the same. Only add or change what was asked.
Anything added must be small, tasteful and realistic, with correct lighting, perspective and shadows, placed naturally in empty space and never covering the product unless asked.
Photorealistic, high resolution, no text or watermark.`;
}

export function decide(request, count) {
  return `A reseller wants to apply this change to their product photos: "${request}"
Above are ${count} photos, labelled PHOTO 1..${count}, each with a short analysis.
Decide for EACH photo whether the change makes sense.
- If the request ADDS an object / prop: say NO for close-ups, tag or label shots, and photos where the product fills the frame with no free background space. Say YES only where it can sit naturally.
- If the request is a global look change (lighting, colour grade, mood, shadow): usually YES for all.
Return ONLY JSON: {"decisions":[{"n":1,"apply":true,"reason":"max 8 words"}]}`;
}
