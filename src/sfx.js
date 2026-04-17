import { MathUtils } from 'three';

const CRACK_FILES = [
  '/sfx/crk1.mp3',
  '/sfx/crk2.mp3',
  '/sfx/crk3.mp3',
  '/sfx/crk4.mp3',
  '/sfx/crk5.mp3',
  '/sfx/crk6.mp3',
  '/sfx/crk7.mp3',
  '/sfx/crk8.mp3',
];

const PITCH_BASE = 1.0;
const PITCH_SPREAD = 0.4; // range [0.8, 1.2]
const VOL_BASE = 0.85;
const VOL_SPREAD = 0.3; // range [0.7, 1.0]

let ctx = null;
const buffers = [];
let loaded = false;

async function load() {
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  const bufs = await Promise.all(
    CRACK_FILES.map(async (url) => {
      const res = await fetch(url);
      const arr = await res.arrayBuffer();
      return ctx.decodeAudioData(arr);
    }),
  );
  buffers.push(...bufs);
  loaded = true;
}

load();

let gammaBuffer = null;
let gammaGain = null;
let gammaStarted = false;

async function loadGamma() {
  // wait until ctx exists (created in load())
  while (!ctx) await new Promise((r) => setTimeout(r, 50));
  const res = await fetch('/sfx/gamma.mp3');
  const arr = await res.arrayBuffer();
  gammaBuffer = await ctx.decodeAudioData(arr);
}
loadGamma();

export function setGammaVolume(v) {
  if (!gammaStarted || !gammaGain) return;
  const target = Math.max(0, Math.min(1, v));
  const now = ctx.currentTime;
  gammaGain.gain.cancelScheduledValues(now);
  gammaGain.gain.setValueAtTime(gammaGain.gain.value, now);
  gammaGain.gain.linearRampToValueAtTime(target, now + 0.6);
}

export function startGamma() {
  if (gammaStarted) return;
  if (!loaded || !gammaBuffer) return;
  if (ctx.state === 'suspended') ctx.resume();
  const source = ctx.createBufferSource();
  source.buffer = gammaBuffer;
  source.loop = true;
  gammaGain = ctx.createGain();
  gammaGain.gain.value = 0;
  source.connect(gammaGain).connect(ctx.destination);
  source.start(0);
  gammaStarted = true;
}

let lastCrackIdx = -1;
export function playCrack() {
  if (!loaded) return;
  if (ctx.state === 'suspended') ctx.resume();
  let idx = Math.floor(Math.random() * buffers.length);
  if (buffers.length > 1 && idx === lastCrackIdx) {
    idx = (idx + 1) % buffers.length;
  }
  lastCrackIdx = idx;
  const buf = buffers[idx];
  const source = ctx.createBufferSource();
  source.buffer = buf;
  source.playbackRate.value = PITCH_BASE + MathUtils.randFloatSpread(PITCH_SPREAD);
  const gain = ctx.createGain();
  gain.gain.value = VOL_BASE + MathUtils.randFloatSpread(VOL_SPREAD);
  source.connect(gain).connect(ctx.destination);
  source.start(0);
}
