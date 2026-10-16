'use strict';

const $ = (id) => document.getElementById(id);
const form = $('generator-form');
const generateButton = $('generate-btn');
const buttonLabel = $('button-label');
const overallStatus = $('overall-status');
const errorBox = $('error-box');
const expandedPrompt = $('expanded-prompt');
const keyframeImage = $('keyframe-image');
const keyframeFrame = $('keyframe-frame');
const openKeyframe = $('open-keyframe');
const finalVideo = $('final-video');
const videoEmpty = $('video-empty');
const downloadVideo = $('download-video');
const videoSource = $('video-source');
const STEP_IDS = ['step-1', 'step-2', 'step-3'];
let csrfToken = '';

function setStep(index, state, message) {
  const element = $(STEP_IDS[index]);
  if (!element) return;
  element.classList.remove('active', 'done');
  if (state === 'active') element.classList.add('active');
  if (state === 'done') element.classList.add('done');
  const status = element.querySelector('.step-status');
  if (status) status.textContent = message;
}

function resetPipeline() {
  STEP_IDS.forEach((id) => {
    const element = $(id);
    element.classList.remove('active', 'done');
    const status = element.querySelector('.step-status');
    if (status) status.textContent = 'Waiting';
  });
  expandedPrompt.textContent = 'Your expanded prompt will appear here.';
  expandedPrompt.classList.add('muted');
  keyframeImage.hidden = true;
  keyframeImage.removeAttribute('src');
  keyframeFrame.querySelector('.empty-state').hidden = false;
  openKeyframe.hidden = true;
  finalVideo.pause();
  finalVideo.hidden = true;
  finalVideo.removeAttribute('src');
  finalVideo.load();
  videoEmpty.hidden = false;
  downloadVideo.href = '#';
  downloadVideo.classList.add('disabled');
  downloadVideo.setAttribute('aria-disabled', 'true');
  videoSource.textContent = '';
  errorBox.hidden = true;
  errorBox.textContent = '';
}

function setOverallStatus(text, state = '') {
  overallStatus.textContent = text;
  overallStatus.className = `status-pill ${state}`.trim();
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  setOverallStatus('Needs attention', 'failed');
}

function setAuthenticated(authenticated) {
  document.body.classList.toggle('authenticated', authenticated);
  if (!authenticated) {
    csrfToken = '';
    $('login-password').value = '';
    $('login-password').focus();
  }
}

async function readJsonResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
  return data;
}

async function checkSession() {
  try {
    const response = await fetch('/api/auth/status', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });
    const data = await readJsonResponse(response);
    csrfToken = data.csrfToken || '';
    setAuthenticated(Boolean(data.authenticated));
  } catch {
    setAuthenticated(false);
    $('login-error').textContent = 'Could not reach the studio server. Check that the app is running and reload this page.';
    $('login-error').hidden = false;
  }
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = $('login-password').value;
  const button = $('login-button');
  const label = $('login-label');
  const error = $('login-error');
  error.hidden = true;
  button.disabled = true;
  label.textContent = 'Checking…';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await readJsonResponse(response);
    csrfToken = data.csrfToken;
    setAuthenticated(true);
    $('login-password').value = '';
  } catch (err) {
    error.textContent = err.message || 'Sign-in failed. Check the password and try again.';
    error.hidden = false;
    $('login-password').select();
  } finally {
    button.disabled = false;
    label.textContent = 'Unlock studio';
  }
});

$('logout-button').addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: '{}'
    });
  } finally {
    setAuthenticated(false);
    resetPipeline();
  }
});

function handleServerEvent(event) {
  if (event.type === 'progress') {
    if (Number.isInteger(event.step)) setStep(event.step, event.state || '', event.message || '');
    if (event.status) setOverallStatus(event.status, event.statusState || '');
    return;
  }
  if (event.type === 'prompt') {
    expandedPrompt.textContent = event.prompt;
    expandedPrompt.classList.remove('muted');
    return;
  }
  if (event.type === 'keyframe') {
    keyframeImage.src = event.url;
    keyframeImage.hidden = false;
    keyframeFrame.querySelector('.empty-state').hidden = true;
    openKeyframe.href = event.url;
    openKeyframe.hidden = false;
    return;
  }
  if (event.type === 'video') {
    finalVideo.src = event.url;
    finalVideo.hidden = false;
    videoEmpty.hidden = true;
    downloadVideo.href = event.downloadUrl || event.url;
    downloadVideo.classList.remove('disabled');
    downloadVideo.setAttribute('aria-disabled', 'false');
    videoSource.textContent = `Generated via ${event.source || 'AI video provider'}`;
    return;
  }
  if (event.type === 'complete') {
    setOverallStatus('Complete');
    return;
  }
  if (event.type === 'error') throw new Error(event.message || 'Video generation failed.');
}

async function readNdjsonStream(response) {
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Generation request failed (HTTP ${response.status}).`);
  }
  if (!response.body) throw new Error('The server returned an empty generation response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let gotComplete = false;
  while (true) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value || new Uint8Array(), { stream: !done });
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      handleServerEvent(event);
      if (event.type === 'complete') gotComplete = true;
    }
    if (done) break;
  }
  if (pending.trim()) {
    const event = JSON.parse(pending.trim());
    handleServerEvent(event);
    if (event.type === 'complete') gotComplete = true;
  }
  if (!gotComplete) throw new Error('The generation connection ended before the server confirmed completion.');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  resetPipeline();
  const prompt = $('prompt').value.trim();
  const ratio = $('aspect-ratio').value;
  const model = $('modelPreset').value;
  if (prompt.length < 3) {
    showError('Enter a scene description with at least 3 characters.');
    return;
  }
  generateButton.disabled = true;
  buttonLabel.textContent = 'Generating…';
  setOverallStatus('Starting', 'busy');
  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson',
        'X-CSRF-Token': csrfToken
      },
      body: JSON.stringify({ prompt, ratio, model })
    });
    await readNdjsonStream(response);
  } catch (err) {
    if (err.message === 'Unauthorized') {
      setAuthenticated(false);
      return;
    }
    showError(err.message || 'Video generation failed. Verify your provider credentials and quota in the server environment settings.');
    const stepIndex = STEP_IDS.findIndex((id) => !$(id).classList.contains('done'));
    if (stepIndex >= 0) setStep(stepIndex, 'active', 'Failed');
  } finally {
    generateButton.disabled = false;
    buttonLabel.textContent = 'Generate video';
  }
});

$('prompt').addEventListener('input', () => {
  if (!errorBox.hidden) errorBox.hidden = true;
});

checkSession();
