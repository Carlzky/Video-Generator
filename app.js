import { Client } from "@gradio/client";

const $ = (id) => document.getElementById(id);
const form = $("generator-form");
const generateButton = $("generate-btn");
const buttonLabel = $("button-label");
const overallStatus = $("overall-status");
const errorBox = $("error-box");
const expandedPrompt = $("expanded-prompt");
const keyframeImage = $("keyframe-image");
const keyframeFrame = $("keyframe-frame");
const openKeyframe = $("open-keyframe");
const finalVideo = $("final-video");
const videoEmpty = $("video-empty");
const downloadVideo = $("download-video");
const videoSource = $("video-source");
const modelPreset = $("modelPreset");

const STEP_IDS = ["step-1", "step-2", "step-3"];
let currentVideoObjectUrl = null;

function setStep(index, state, message) {
  const element = $(STEP_IDS[index]);
  element.classList.remove("active", "done");
  if (state === "active") element.classList.add("active");
  if (state === "done") element.classList.add("done");
  element.querySelector(".step-status").textContent = message;
}

function resetPipeline() {
  STEP_IDS.forEach((id, index) => {
    $(id).classList.remove("active", "done");
    $(id).querySelector(".step-status").textContent = "Waiting";
  });
  expandedPrompt.textContent = "Your expanded prompt will appear here.";
  expandedPrompt.classList.add("muted");
  keyframeImage.hidden = true;
  keyframeImage.removeAttribute("src");
  keyframeFrame.querySelector(".empty-state").hidden = false;
  openKeyframe.hidden = true;
  finalVideo.pause();
  finalVideo.hidden = true;
  finalVideo.removeAttribute("src");
  videoEmpty.hidden = false;
  downloadVideo.href = "#";
  downloadVideo.classList.add("disabled");
  downloadVideo.setAttribute("aria-disabled", "true");
  videoSource.textContent = "";
  errorBox.hidden = true;
  errorBox.textContent = "";
  if (currentVideoObjectUrl) {
    URL.revokeObjectURL(currentVideoObjectUrl);
    currentVideoObjectUrl = null;
  }
}

function setOverallStatus(text, state = "") {
  overallStatus.textContent = text;
  overallStatus.className = `status-pill ${state}`.trim();
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  setOverallStatus("Needs attention", "failed");
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)} seconds.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function encodePrompt(value) {
  return encodeURIComponent(value).replace(/%20/g, "%20");
}

async function expandPrompt(userPrompt, apiKey, ratio) {
  const model = "gemini-3.8-flash";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const instruction = `Expand the user's idea into exactly one cinematic sentence for AI video generation. Preserve the core idea. Include subject, setting, lighting, mood, composition, lens/camera movement, and subtle motion. Avoid text, captions, logos, and multiple shots. Frame for ${ratio}. Return only the sentence, with no quotation marks or explanation. User idea: ${userPrompt}`;
  const response = await withTimeout(fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: instruction }] }],
      generationConfig: { temperature: 0.8, maxOutputTokens: 180 }
    })
  }), 45000, "Gemini prompt expansion");

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `Gemini request failed (HTTP ${response.status}). Check the API key, model access, and quota.`);
  }
  const result = data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
  if (!result) throw new Error("Gemini returned no prompt text. Try a different prompt or model.");
  return result.replace(/^["'“”]+|["'“”]+$/g, "").replace(/\s+/g, " ");
}

function pollinationsHeaders(apiKey) {
  const headers = {};
  if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
  return headers;
}

function getPollinationsImageUrl(prompt, ratio, apiKey) {
  const [width, height] = ratio === "9:16" ? [768, 1365] : [1365, 768];
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    model: "flux",
    nologo: "true",
    safe: "true"
  });
  if (apiKey.trim()) params.set("key", apiKey.trim());
  return `https://gen.pollinations.ai/image/${encodePrompt(prompt)}?${params.toString()}`;
}

async function verifyImageUrl(url) {
  const image = new Image();
  image.referrerPolicy = "no-referrer";
  await withTimeout(new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error("The keyframe image could not be loaded. The image endpoint may require authorization, block browser access, or be temporarily unavailable."));
    image.src = url;
  }), 90000, "Keyframe generation");
  return url;
}

function extractUrl(value, depth = 0) {
  if (depth > 8 || value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^https?:\/\/\S+/i.test(trimmed)) return trimmed;
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractUrl(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const key of ["url", "video", "video_url", "path", "src", "name"]) {
      if (value[key]) {
        const found = extractUrl(value[key], depth + 1);
        if (found) return found;
      }
    }
    for (const item of Object.values(value)) {
      const found = extractUrl(item, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function replaceTemplateTokens(value, prompt, imageValue) {
  if (typeof value === "string") {
    if (value === "{{IMAGE_URL}}") return imageValue;
    let replaced = value.replaceAll("{{PROMPT}}", prompt);
    if (typeof imageValue === "string") {
      replaced = replaced.replaceAll("{{IMAGE_URL}}", imageValue);
    }
    return replaced;
  }
  if (Array.isArray(value)) return value.map((item) => replaceTemplateTokens(item, prompt, imageValue));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceTemplateTokens(item, prompt, imageValue)]));
  }
  return value;
}

async function tryHuggingFace(prompt, imageUrl, spaceId, endpoint, token, payloadText) {
  if (!spaceId.trim()) throw new Error("No Hugging Face Space ID configured.");

  let imagePayloadValue = imageUrl;
  if (imageUrl) {
    try {
      const imgRes = await fetch(imageUrl);
      if (imgRes.ok) imagePayloadValue = await imgRes.blob();
    } catch (e) {
      console.warn("Could not fetch image as Blob, falling back to string URL:", e);
    }
  }

  let payloadTemplate;
  try {
    payloadTemplate = JSON.parse(payloadText);
  } catch {
    throw new Error("The Hugging Face payload must be valid JSON.");
  }
  const payload = replaceTemplateTokens(payloadTemplate, prompt, imagePayloadValue);
  const options = token.trim() ? { token: token.trim() } : {};
  const client = await withTimeout(Client.connect(spaceId.trim(), options), 45000, "Hugging Face connection");
  
  const result = await withTimeout(client.predict(endpoint.trim() || "/predict", payload), 240000, "Hugging Face video generation");
  const mediaUrl = extractUrl(result?.data);
  if (!mediaUrl) {
    throw new Error("Hugging Face returned a result, but no direct media URL was found. Check the Space's output schema in View API.");
  }
  return mediaUrl;
}

async function tryPollinationsVideo(prompt, ratio, apiKey, imageUrl) {
  const params = new URLSearchParams({
    model: "community",
    aspectRatio: ratio,
    duration: "5"
  });
  if (apiKey.trim()) params.set("key", apiKey.trim());
  if (imageUrl) params.set("image", imageUrl);
  const url = `https://gen.pollinations.ai/video/${encodePrompt(prompt)}?${params.toString()}`;
  const response = await withTimeout(fetch(url, {
    method: "GET",
    headers: pollinationsHeaders(apiKey)
  }), 240000, "Pollinations video fallback");
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Pollinations video fallback failed (HTTP ${response.status}). ${detail.slice(0, 350)}`);
  }
  const type = response.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    const data = await response.json();
    const mediaUrl = extractUrl(data);
    if (!mediaUrl) throw new Error("Pollinations returned JSON without a recognizable video URL.");
    return mediaUrl;
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error("Pollinations returned an empty video response.");
  return URL.createObjectURL(blob);
}

async function showVideo(url, source) {
  let playableUrl = url;
  try {
    const response = await withTimeout(fetch(url), 90000, "Video download");
    if (!response.ok) throw new Error(`Video fetch failed (HTTP ${response.status})`);
    const blob = await response.blob();
    if (!blob.size) throw new Error("The returned video file is empty.");
    if (currentVideoObjectUrl) URL.revokeObjectURL(currentVideoObjectUrl);
    currentVideoObjectUrl = URL.createObjectURL(blob);
    playableUrl = currentVideoObjectUrl;
    downloadVideo.href = currentVideoObjectUrl;
  } catch (error) {
    downloadVideo.href = url;
    downloadVideo.target = "_blank";
    downloadVideo.rel = "noopener";
    videoSource.textContent = "Direct provider link; download may depend on provider permissions.";
  }
  finalVideo.src = playableUrl;
  finalVideo.hidden = false;
  videoEmpty.hidden = true;
  downloadVideo.classList.remove("disabled");
  downloadVideo.setAttribute("aria-disabled", "false");
  downloadVideo.download = "ai-cinema-studio.mp4";
  if (!videoSource.textContent) videoSource.textContent = `Generated via ${source}`;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  resetPipeline();

  const userPrompt = $("prompt").value.trim();
  const ratio = $("aspect-ratio").value;
  const geminiKey = $("gemini-key").value.trim();
  const pollinationsKey = $("pollinations-key").value.trim();
  const hfToken = $("hf-token").value.trim();
  const hfSpace = $("hf-space").value.trim();
  const hfEndpoint = $("hf-endpoint").value.trim();
  const hfPayload = $("hf-payload").value;

  if (!userPrompt) {
    showError("Enter a scene description first.");
    return;
  }
  if (!geminiKey) {
    showError("Enter a Google Gemini API key to expand the prompt.");
    return;
  }

  generateButton.disabled = true;
  buttonLabel.textContent = "Generating…";
  setOverallStatus("In progress", "busy");

  try {
    setStep(0, "active", "Expanding…");
    const cinematicPrompt = await expandPrompt(userPrompt, geminiKey, ratio);
    expandedPrompt.textContent = cinematicPrompt;
    expandedPrompt.classList.remove("muted");
    setStep(0, "done", "Complete");

    setStep(1, "active", "Rendering…");
    const imageUrl = getPollinationsImageUrl(cinematicPrompt, ratio, pollinationsKey);
    await verifyImageUrl(imageUrl);
    keyframeImage.src = imageUrl;
    keyframeImage.hidden = false;
    keyframeFrame.querySelector(".empty-state").hidden = true;
    openKeyframe.href = imageUrl;
    openKeyframe.hidden = false;
    setStep(1, "done", "Complete");

    setStep(2, "active", "Trying Hugging Face…");
    let videoUrl;
    let source;
    let hfError = null;

    try {
      videoUrl = await tryHuggingFace(cinematicPrompt, imageUrl, hfSpace, hfEndpoint, hfToken, hfPayload);
      source = "Hugging Face";
    } catch (error) {
      hfError = error;
      setStep(2, "active", "Trying fallback…");
      videoSource.textContent = "Hugging Face unavailable; trying Pollinations fallback…";
      videoUrl = await tryPollinationsVideo(cinematicPrompt, ratio, pollinationsKey, imageUrl);
      source = "Pollinations fallback";
    }

    await showVideo(videoUrl, source);
    setStep(2, "done", "Complete");
    setOverallStatus("Complete");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showError(`${message}\n\nIf video generation failed, verify the Hugging Face Space ID, endpoint, and payload against that Space's View API page. Pollinations may also require an API key or may not permit browser requests. ${error?.cause ? String(error.cause) : ""}`);
    if (!$("step-1").classList.contains("done")) setStep(0, "active", "Failed");
    else if (!$("step-2").classList.contains("done")) setStep(1, "active", "Failed");
    else setStep(2, "active", "Failed");
  } finally {
    generateButton.disabled = false;
    buttonLabel.textContent = "Generate video";
  }
});

$("prompt").addEventListener("input", () => {
  if (!errorBox.hidden) errorBox.hidden = true;
});

function applyModelPreset() {
  const preset = modelPreset.value;
  const hfSpace = $("hf-space");
  const hfEndpoint = $("hf-endpoint");
  const hfPayload = $("hf-payload");

  if (preset === "wan") {
    hfSpace.value = "kulkas2pintu/wan777";
    hfEndpoint.value = "/generate_video";
    hfPayload.value = JSON.stringify({
      "input_image": "{{IMAGE_URL}}",
      "last_image": "{{IMAGE_URL}}",
      "prompt": "{{PROMPT}}",
      "steps": 4,
      "negative_prompt": "static, blurry, low quality",
      "duration_seconds": 3.5,
      "guidance_scale": 1,
      "guidance_scale_2": 1,
      "seed": 42,
      "randomize_seed": true,
      "quality": 6,
      "scheduler": "FlowMatchEulerDiscrete",
      "flow_shift": 3,
      "frame_multiplier": "16",
      "video_component": true,
      "safe_mode": true
    }, null, 2);
  } else if (preset === "ltx") {
    hfSpace.value = "00000tt/LTX-2.3-10Eros";
    hfEndpoint.value = "/generate";
    hfPayload.value = JSON.stringify({
      "image_path": "{{IMAGE_URL}}",
      "prompt": "{{PROMPT}}",
      "negative_prompt": "captions, music, transition, VR, bad quality, subtitles, text, watermark, overlay effects, cartoon, childish, ugly, text, blur, logo, static, low quality, noise, mutant, horror, film grain",
      "preset": "tuned",
      "seconds": 4.0,
      "max_width": 1120,
      "max_height": 1344,
      "mode": "anchor only",
      "face_bbox": "none",
      "likeness_strength": 0.9,
      "likeness_anchor_strength": 0.15,
      "latent_anchor_strength": 0.08,
      "first_frame_strength": 0.82,
      "seed": -1,
      "randomize_seed": true,
      "gen_budget": 0,
      "target_mp": 1.15,
      "snap_multiple": "64",
      "custom_res_enabled": false,
      "sulphur_lora_strength": 0.15,
      "sulphur_v1_lora_strength": 0.15,
      "vbvr_lora_strength": 0.5,
      "dreamly_lora_strength": 0.6,
      "synth_lora_strength": 0.0,
      "plora_lora_strength": 0.0,
      "singularity_lora_strength": 0.3,
      "omninft_lora_strength": 0.8,
      "omninft_bf16_lora_strength": 0.0,
      "better_motion_lora_strength": 0.0,
      "physics_v2_lora_strength": 0.0,
      "hardcut_lora_strength": 0.0,
      "transition_lora_strength": 0.0,
      "sulphur_audio_strength": 0.15,
      "sulphur_v1_audio_strength": 0.15,
      "vbvr_audio_strength": 0.5,
      "dreamly_audio_strength": 0.6,
      "synth_audio_strength": 0.0,
      "plora_audio_strength": 0.0,
      "singularity_audio_strength": 0.3,
      "omninft_audio_strength": 0.8,
      "omninft_bf16_audio_strength": 0.0,
      "better_motion_audio_strength": 0.0,
      "physics_v2_audio_strength": 0.0,
      "hardcut_audio_strength": 0.0,
      "transition_audio_strength": 0.0,
      "cache_at_step": 0,
      "cache_warmup": 400,
      "energy_threshold": 0.3,
      "anchor_similarity_threshold": 0.3,
      "sigma_string": "0.4824, 0.2412, 0.0",
      "input_mode": "single image (i2v)",
      "msr_ref2": null,
      "msr_ref3": null,
      "msr_ref4": null,
      "msr_background": null,
      "msr_frame_count": "41",
      "msr_guide_strength": 1.0,
      "msr_lora_strength": 0.7,
      "prompt_relay_enabled": false,
      "prompt_segments": "{{PROMPT}}",
      "scene_chain_enabled": false,
      "scene_chain_prompt": "{{PROMPT}}",
      "scene_chain_max_scenes": 2,
      "scene_chain_frame_overlap": 8,
      "scene_chain_mid_guide": true,
      "scene_chain_mid_guide_strength": 0.25,
      "kv_enabled": false,
      "kv_strength": 1.0,
      "audio_ref_enabled": false,
      "audio_ref_file": null,
      "audio_ref_guidance_scale": 3.0,
      "audio_ref_stem_sep": false,
      "audio_ref_normalize": true,
      "kf_last_image": null,
      "kf_strength": 0.82,
      "kf_mid_enabled": false,
      "kf_mid_1_image": null,
      "kf_mid_1_pos": 50,
      "kf_mid_2_image": null,
      "kf_mid_2_pos": 50,
      "kf_mid_3_image": null,
      "kf_mid_3_pos": 50,
      "kf_mid_4_image": null,
      "kf_mid_4_pos": 50,
      "kf_mid_5_image": null,
      "kf_mid_5_pos": 50,
      "profile_name": "default",
      "skip_refine": false
    }, null, 2);
  }
}

if (modelPreset) {
  modelPreset.addEventListener("change", applyModelPreset);
}
applyModelPreset();