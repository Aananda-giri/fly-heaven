import * as THREE from "three";
import { GLTFLoader } from "./vendor/loaders/GLTFLoader.js";
import { DRACOLoader } from "./vendor/loaders/DRACOLoader.js";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { clone as cloneSkinned } from "./vendor/utils/SkeletonUtils.js";
import { buildForest } from "./forest.js";
import { FlyRig, FEED_CONTACT } from "./fly.js";
import { BrainView } from "./brain-view.js";
import { heavenToScene } from "./heaven-coords.js";

// The exported head and front feet point along local +Z.
const FORWARD_SIGN = 1;
const POLL_MS = 150; // roughly matches fly_worker.py's real tick cadence

// ---------------------------------------------------------------- renderer
const canvasHost = document.body;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
canvasHost.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.0005, 10);
camera.position.set(0.065, 0.045, 0.085);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.025;
controls.maxDistance = 1.6;
controls.maxPolarAngle = Math.PI * 0.49;
controls.target.set(0, 0.005, 0);

const foodResponse = await fetch('./food-layout.json');
if (!foodResponse.ok) throw new Error('Food layout could not be loaded');
const foodLayout = await foodResponse.json();
const forest = buildForest(scene, renderer, foodLayout);

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ------------------------------------------------------------ loading UI
const loadingEl = document.getElementById("loading");
const statusEl = document.getElementById("status");
const flyRowEl = document.getElementById("flyRow");
const dopamineFillEl = document.getElementById("dopamineFill");
const dopamineValueEl = document.getElementById("dopamineValue");
const brainTitleEl = document.getElementById("brainTitle");
const brainCanvas = document.getElementById("brainCanvas");
const brainLegendEl = document.getElementById("brainLegend");
const brainFlyEl = document.getElementById("brainFly");
const speedControlEl = document.getElementById("speedControl");
const speedValueEl = document.getElementById("speedValue");
let visualSpeed = 1;
speedControlEl.addEventListener("input", () => {
  visualSpeed = Number(speedControlEl.value);
  speedValueEl.textContent = `${visualSpeed.toFixed(2).replace(/\.00$/, "")}×`;
});
const brainView = new BrainView(document.getElementById("brainView"));
brainFlyEl.addEventListener("change", () => { primaryFlyId = brainFlyEl.value || null; });

function fail(message) {
  loadingEl.textContent = message;
  loadingEl.classList.remove("hidden");
  loadingEl.style.whiteSpace = "pre-wrap";
  loadingEl.style.textAlign = "left";
  loadingEl.style.padding = "20px";
}
addEventListener("error", (e) => fail("ERR: " + (e.error?.stack || e.message)));
addEventListener("unhandledrejection", (e) => fail("REJ: " + (e.reason?.stack || e.reason)));

// ------------------------------------------------------------- fly model
const draco = new DRACOLoader();
draco.setDecoderPath("./vendor/");
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(draco);

function loadBaseModel() {
  return new Promise((resolve, reject) => {
    gltfLoader.load("./assets/housefly.glb", (gltf) => resolve(gltf.scene), undefined, reject);
  });
}

let baseModel = null;
function makeRig(scale) {
  const cloned = cloneSkinned(baseModel);
  const rig = new FlyRig(cloned, { scale, navigation: forest.navigation });
  scene.add(rig.object);
  return rig;
}

// ------------------------------------------------------------ server API
let apiToken = null;
let maxFlies = 4;

// Paths are relative to the page, which the public demo serves under /fly-heaven/.
async function api(path, opts = {}, renewSession = true) {
  const headers = { ...(opts.headers || {}) };
  if (apiToken) headers["X-Fly-Token"] = apiToken;
  const res = await fetch(path, { ...opts, headers });
  // The demo's router moves a page to its fallback server when the first one
  // goes offline, and that server issues its own session token.
  if (res.status === 403 && opts.method && renewSession) {
    apiToken = (await api("api/session")).token;
    return api(path, opts, false);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${path} -> ${res.status}`);
  }
  return res.json();
}

const spawnFly = () => api("api/flies", { method: "POST" });
const despawnFly = (id) => api(`api/flies/${id}`, { method: "DELETE" });
const listFlies = () => api("api/flies");

// ------------------------------------------------------------- fly pairs
// One entry per spawned (male) fly; the female appears once her world
// instance reports her present, and is a second FlyRig, not a puppet of it.
const pairs = new Map();
let primaryFlyId = null; // whichever fly the camera follows

function headingFromDelta(prevPos, x, z, fallback) {
  const dx = x - prevPos.x, dz = z - prevPos.y;
  if (Math.hypot(dx, dz) < 0.0006) return fallback;
  return Math.atan2(FORWARD_SIGN * dx, FORWARD_SIGN * dz);
}

function ensurePair(flyId) {
  let pair = pairs.get(flyId);
  if (pair) return pair;
  pair = {
    male: makeRig(1),
    female: null,
    maleHeading: 0, malePrevPos: new THREE.Vector2(),
    femaleHeading: 0, femalePrevPos: new THREE.Vector2(),
    lastData: null, lastTick: null,
  };
  pairs.set(flyId, pair);
  if (primaryFlyId === null) primaryFlyId = flyId;
  return pair;
}

function removePair(flyId) {
  const pair = pairs.get(flyId);
  if (!pair) return;
  scene.remove(pair.male.object);
  if (pair.female) scene.remove(pair.female.object);
  pairs.delete(flyId);
  if (primaryFlyId === flyId) primaryFlyId = pairs.keys().next().value ?? null;
}

function applyState(flyId, data) {
  const pair = ensurePair(flyId);
  pair.lastData = data;
  if (data.status !== "ready" || !data.male || pair.lastTick === data.tick) return;
  pair.lastTick = data.tick;

  const [mx, mz] = heavenToScene(data.male.x, data.male.y);
  pair.maleHeading = headingFromDelta(pair.malePrevPos, mx, mz, pair.maleHeading);
  pair.malePrevPos.set(mx, mz);
  const mounting = data.state === "COURT" && data.subphase === "MATE";
  let maleX = mx, maleZ = mz, maleHeading = pair.maleHeading, eating = null, reach = 0;
  if (data.pose === "feed") {
    const fruit = forest.foods.find(food => food.id === data.food_target?.id)
      ?? forest.foods.reduce((nearest, food) => Math.hypot(food.x - mx, food.z - mz) < Math.hypot(nearest.x - mx, nearest.z - mz) ? food : nearest, forest.fruit);
    ({ x: maleX, z: maleZ, heading: maleHeading, reach } = forest.feedingSpot(fruit, mx, mz, maleHeading, FEED_CONTACT));
    eating = fruit.id ?? null;
    [maleX, maleZ] = forest.navigation.constrain(maleX, maleZ, pair.male.radius, 0, eating);
  }

  if (data.female.present) {
    if (!pair.female) pair.female = makeRig(1.08); // heaven/blender/animate.py: append_fly('Female', 1.08)
    const [fx, fz] = heavenToScene(data.female.x, data.female.y);
    const courting = data.state === "COURT";
    let [femaleX, femaleZ] = forest.navigation.constrain(fx, fz, pair.female.radius, 0);
    if (data.pose === "feed") {
      let dx = femaleX - maleX, dz = femaleZ - maleZ;
      const gap = pair.male.radius + pair.female.radius;
      if (Math.hypot(dx, dz) < gap) {
        if (Math.hypot(dx, dz) < 0.0001) { dx = 1; dz = 0; }
        const norm = Math.hypot(dx, dz);
        [femaleX, femaleZ] = forest.navigation.constrain(maleX + dx / norm * gap, maleZ + dz / norm * gap, pair.female.radius, 0);
      }
    }
    const movingFemaleHeading = headingFromDelta(pair.femalePrevPos, femaleX, femaleZ, pair.femaleHeading);
    // Preserve her heading during mounting so the pair doesn't spin around
    // coincident simulation positions; song/tapping face one another.
    if (!mounting) pair.femaleHeading = courting
      ? Math.atan2(maleX - femaleX, maleZ - femaleZ)
      : movingFemaleHeading;
    pair.femalePrevPos.set(femaleX, femaleZ);
    pair.female.setTarget({
      x: femaleX, z: femaleZ, heading: pair.femaleHeading, height: 0.0002,
      pose: courting ? "bask" : "walk", tick: data.tick,
    });
    if (mounting) {
      const back = 0.006;
      maleX = femaleX - Math.sin(pair.femaleHeading) * back;
      maleZ = femaleZ - Math.cos(pair.femaleHeading) * back;
      maleHeading = pair.femaleHeading;
    } else {
      const separation = pair.male.radius + pair.female.radius;
      let dx = maleX - femaleX, dz = maleZ - femaleZ;
      const distance = Math.hypot(dx, dz);
      if (distance < separation && data.pose !== "feed") {
        if (distance < 0.0001) { dx = -Math.sin(maleHeading); dz = -Math.cos(maleHeading); }
        const norm = Math.hypot(dx, dz);
        maleX = femaleX + dx / norm * separation;
        maleZ = femaleZ + dz / norm * separation;
      }
      if (courting) maleHeading = Math.atan2(femaleX - maleX, femaleZ - maleZ);
    }
  } else if (pair.female) {
    scene.remove(pair.female.object);
    pair.female = null;
  }

  pair.male.setTarget({
    x: maleX, z: maleZ, heading: maleHeading,
    height: data.male.altitude + (mounting ? 0.0055 : 0.0002),
    pose: data.male.altitude > 0.001 ? "flight" : data.pose,
    wingSong: data.wing_song,
    proboscis: data.proboscis,
    mounted: mounting,
    food: eating,
    reach,
    tick: data.tick,
  });
}

// ------------------------------------------------------------------- UI
// Built once and then only ever updated in place — rebuilding the row each
// poll (every 150ms) would detach the checkbox out from under a click still
// in flight (mousedown on one node, mouseup on its just-replaced twin).
let flyToggleBoxes = null;
function buildFlyToggles() {
  flyRowEl.innerHTML = "";
  flyToggleBoxes = [];
  for (let i = 0; i < maxFlies; i++) {
    const wrap = document.createElement("label");
    wrap.className = "fly-toggle";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.addEventListener("change", () => onToggle(i, box.checked));
    const span = document.createElement("span");
    span.textContent = `#${i + 1}`;
    wrap.append(box, span);
    flyRowEl.appendChild(wrap);
    flyToggleBoxes.push(box);
  }
}

function renderFlyToggles(activeIds) {
  if (!flyToggleBoxes) buildFlyToggles();
  flyToggleBoxes.forEach((box, i) => {
    if (!pendingToggle.has(i)) box.checked = i < activeIds.length;
    box.disabled = pendingToggle.has(i);
  });
}

const pendingToggle = new Set();
let orderedIds = []; // slot i corresponds to the i-th oldest active fly

async function onToggle(slot, wantOn) {
  pendingToggle.add(slot);
  try {
    if (wantOn) {
      await spawnFly();
    } else {
      const id = orderedIds[slot];
      if (id) await despawnFly(id);
    }
  } catch (err) {
    console.error("fly toggle failed", err);
  } finally {
    pendingToggle.delete(slot);
  }
}

// -------------------------------------------------------- brain activity
// A live EEG-style trace of the followed fly's own key readouts — the
// point isn't precision, it's making the (mostly invisible) fact that a
// real spiking network is deciding things legible at a glance, including
// during EXPLORE: the wandering itself is scripted navigation (see
// heaven/world.py), but these six readouts are genuinely what the brain is
// doing under it every tick.
const BRAIN_CHANNELS = [
  { key: "PAM11", label: "dopamine", color: "#ffb84d", max: 100 },
  { key: "MN9", label: "feeding drive", color: "#7ee787", max: 60 },
  { key: "P1", label: "courtship interest", color: "#ff6bcb", max: 40 },
  { key: "pIP10", label: "singing", color: "#c792ea", max: 40 },
  { key: "DNg12", label: "grooming urge", color: "#7fd4ff", max: 20 },
  { key: "motor", label: "overall activity", color: "#e6e6e6", max: 30 },
];
const BRAIN_HISTORY_LEN = 90;
const brainHistory = new Map(BRAIN_CHANNELS.map((c) => [c.key, []]));
let brainHistoryFlyId = null;
let brainHistoryTick = null;

function buildBrainLegend() {
  brainLegendEl.innerHTML = "";
  for (const ch of BRAIN_CHANNELS) {
    const chip = document.createElement("div");
    chip.className = "brain-chip";
    const swatch = document.createElement("span");
    swatch.className = "brain-swatch";
    swatch.style.background = ch.color;
    const label = document.createElement("span");
    label.textContent = ch.label;
    const value = document.createElement("b");
    value.dataset.key = ch.key;
    value.textContent = "0";
    chip.append(swatch, label, value);
    brainLegendEl.appendChild(chip);
  }
}
buildBrainLegend();

function pushBrainSample(flyId, rates, tick) {
  if (flyId === brainHistoryFlyId && tick === brainHistoryTick) return;
  brainHistoryTick = tick;
  if (flyId !== brainHistoryFlyId) {
    brainHistoryFlyId = flyId;
    for (const arr of brainHistory.values()) arr.length = 0;
  }
  for (const ch of BRAIN_CHANNELS) {
    const arr = brainHistory.get(ch.key);
    arr.push(rates?.[ch.key] ?? 0);
    if (arr.length > BRAIN_HISTORY_LEN) arr.shift();
  }
}

function drawBrainChart() {
  const ctx = brainCanvas.getContext("2d");
  const w = brainCanvas.width, h = brainCanvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, h - 1); ctx.lineTo(w, h - 1); ctx.stroke();

  for (const ch of BRAIN_CHANNELS) {
    const arr = brainHistory.get(ch.key);
    if (arr.length < 2) continue;
    ctx.strokeStyle = ch.color;
    ctx.lineWidth = ch.key === "PAM11" ? 2 : 1.3;
    ctx.globalAlpha = ch.key === "PAM11" ? 1 : 0.8;
    ctx.beginPath();
    for (let i = 0; i < arr.length; i++) {
      // stretched to fill the canvas at any buffer length, not just once
      // full — a still-filling trace should still read as "live", not sparse
      const x = (i / Math.max(1, arr.length - 1)) * w;
      const y = h - Math.min(1, arr[i] / ch.max) * (h - 4) - 2;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  for (const el of brainLegendEl.querySelectorAll("b")) {
    const arr = brainHistory.get(el.dataset.key);
    el.textContent = arr.length ? arr[arr.length - 1].toFixed(0) : "0";
  }
}

function poseLabel(data) {
  if (!data) return "";
  if (data.status === "loading") return "hatching a new brain…";
  if (data.status === "error") return "brain error: " + data.message;
  const names = { FEED: "eating", BASK: data.pose === "bask_belly_up" ? "sunbathing" : "basking", COURT: "courting", GROOM: "grooming", THERMOREGULATE: "seeking comfort", ESCAPE: "fleeing", EXPLORE: "wandering" };
  if (data.state === "FEED" && data.food_target?.name) return "eating " + data.food_target.name.toLowerCase();
  return names[data.state] || data.state.toLowerCase();
}

function updateUI(flies) {
  orderedIds = Object.keys(flies).sort((a, b) => flies[b].age_s - flies[a].age_s);
  renderFlyToggles(orderedIds);

  if (brainFlyEl.options.length !== orderedIds.length || orderedIds.some((id, i) => brainFlyEl.options[i]?.value !== id)) {
    brainFlyEl.replaceChildren(...orderedIds.map((id, i) => new Option(`Fly #${i + 1}`, id)));
  }
  brainFlyEl.value = primaryFlyId ?? "";
  const primary = flies[primaryFlyId];
  brainView.setFly(primaryFlyId, primary);
  const primaryLabel = primaryFlyId ? `Fly #${orderedIds.indexOf(primaryFlyId) + 1}` : null;
  if (primary) {
    statusEl.innerHTML = `${primaryLabel} is <span class="pose">${poseLabel(primary)}</span>`;
    const pam11 = primary.rates?.PAM11 ?? 0;
    const pct = Math.min(100, (pam11 / 40) * 100);
    dopamineFillEl.style.width = pct + "%";
    dopamineFillEl.style.boxShadow = primary.reward_active ? "0 0 16px 3px rgba(255,160,80,.9)" : "0 0 10px 1px rgba(255,140,80,.6)";
    dopamineValueEl.textContent = `${pam11.toFixed(0)} Hz`;
    brainTitleEl.textContent = `Brain Activity — ${primaryLabel}`;
    if (primary.status === "ready") pushBrainSample(primaryFlyId, primary.rates, primary.tick);
    drawBrainChart();
  } else {
    statusEl.textContent = orderedIds.length ? "" : "no flies yet — check a box below";
    dopamineFillEl.style.width = "0%";
    dopamineValueEl.textContent = "0 Hz";
    brainTitleEl.textContent = "Brain Activity";
  }
}

// -------------------------------------------------------------- boot + poll
async function boot() {
  const [session] = await Promise.all([
    api("api/session"),
    loadBaseModel().then((m) => { baseModel = m; }),
    gltfLoader.loadAsync('./assets/food-pack.glb').then(gltf => forest.addFoodModels(gltf.scene)),
  ]);
  apiToken = session.token;
  maxFlies = session.max_flies;

  const existing = await listFlies();
  if (Object.keys(existing.flies).length === 0) await spawnFly();

  loadingEl.classList.add("hidden");
  pollLoop();
}

async function pollLoop() {
  try {
    const { flies, max_flies } = await listFlies();
    // The demo's fallback server allows fewer flies at once.
    if (max_flies !== maxFlies) {
      maxFlies = max_flies;
      flyToggleBoxes = null;
    }
    const seen = new Set(Object.keys(flies));
    for (const id of seen) applyState(id, flies[id]);
    for (const id of [...pairs.keys()]) if (!seen.has(id)) removePair(id);
    updateUI(flies);
  } catch (err) {
    statusEl.textContent = "connection lost: " + err.message;
  }
  setTimeout(pollLoop, POLL_MS);
}

boot().catch((err) => fail("Failed to start: " + (err.stack || err)));

// ------------------------------------------------------------ render loop
const clock = new THREE.Clock();
const followTarget = new THREE.Vector3();
const followDelta = new THREE.Vector3();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05) * visualSpeed;
  const t = clock.elapsedTime * visualSpeed;

  forest.update(t);
  brainView.update(dt, t);
  for (const pair of pairs.values()) {
    pair.male.update(dt, t);
    if (pair.female) pair.female.update(dt, t);
  }

  const primary = pairs.get(primaryFlyId);
  if (primary?.male.object.visible) {
    followTarget.copy(primary.male.object.position).y += 0.005;
    followDelta.copy(followTarget).sub(controls.target).multiplyScalar(1 - Math.exp(-dt / 0.25));
    controls.target.add(followDelta);
    camera.position.add(followDelta);
  }

  controls.update();
  renderer.render(scene, camera);
});
