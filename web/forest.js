// Builds a macro-scale forest floor: everything is sized in meters against
// the housefly's true ~13x9x20mm body, so grass reads as looming vegetation
// rather than a lawn. No external textures — ground, sky and bark are all
// generated on <canvas> so the scene has no asset-licensing footprint of
// its own beyond the fly model.
import * as THREE from "three";
import { heavenToScene, FRUIT_POS, SUNBEAM_POS, SUNBEAM_RADIUS, CLEARING_W, CLEARING_H } from "./heaven-coords.js";

import { ForestNavigation } from "./navigation.js";

// ---- tiny deterministic PRNG + value noise (no external noise lib) -------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function valueNoise2D(rng, size = 64) {
  const grid = new Float32Array(size * size);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  return (x, y) => {
    x = ((x % 1) + 1) % 1;
    y = ((y % 1) + 1) % 1;
    const gx = x * (size - 1), gy = y * (size - 1);
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const x1 = Math.min(x0 + 1, size - 1), y1 = Math.min(y0 + 1, size - 1);
    const tx = gx - x0, ty = gy - y0;
    const lerp = (a, b, t) => a + (b - a) * t;
    const v00 = grid[y0 * size + x0], v10 = grid[y0 * size + x1];
    const v01 = grid[y1 * size + x0], v11 = grid[y1 * size + x1];
    return lerp(lerp(v00, v10, tx), lerp(v01, v11, tx), ty);
  };
}

// ---- procedural ground texture --------------------------------------------
function makeGroundTexture(rng) {
  const size = 1024;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");

  const noise = valueNoise2D(mulberry32(rng() * 1e9), 48);
  const fine = valueNoise2D(mulberry32(rng() * 1e9), 160);

  const img = ctx.createImageData(size, size);
  const humusLo = [46, 34, 24], humusHi = [82, 63, 38];
  const mossLo = [42, 58, 28], mossHi = [86, 108, 52];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const n = noise(u * 5, v * 5) * 0.7 + fine(u * 20, v * 20) * 0.3;
      const mossMask = Math.max(0, noise(u * 3 + 8.1, v * 3 + 4.4) - 0.4) * 2.2;
      const base = mossMask > 0.15 ? mossLo.map((c0, i) => c0 + (mossHi[i] - c0) * n)
                                    : humusLo.map((c0, i) => c0 + (humusHi[i] - c0) * n);
      const speck = fine(u * 60, v * 60) > 0.93 ? -18 : 0;
      const idx = (y * size + x) * 4;
      img.data[idx] = base[0] + speck;
      img.data[idx + 1] = base[1] + speck;
      img.data[idx + 2] = base[2] + speck;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

// ---- procedural sky gradient -----------------------------------------------
function makeSkyTexture() {
  const c = document.createElement("canvas");
  c.width = 16; c.height = 256;
  const ctx = c.getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "#dff0c8");   // sunlit canopy gap, top
  grad.addColorStop(0.35, "#a9cf8f");
  grad.addColorStop(0.7, "#5f8a55");
  grad.addColorStop(1, "#2c4a2c");   // shaded undergrowth, bottom
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 16, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---- grass blade geometry (curved, tapered plane) -------------------------
function makeBladeGeometry() {
  const segs = 4;
  const positions = [];
  const uvs = [];
  const bend = []; // 0 at base, 1 at tip: how much a blade feels wind
  const indices = [];
  const width0 = 1; // unit width at base, scaled per-instance
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const w = width0 * (1 - t) * 0.5;
    const bow = Math.sin(t * Math.PI * 0.5) * 0.18; // slight forward curve
    positions.push(-w, t, bow, w, t, bow);
    uvs.push(0, t, 1, t);
    bend.push(t * t, t * t);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    indices.push(a, b, c, b, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute("aBend", new THREE.Float32BufferAttribute(bend, 1));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function makeGrassMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x6c9a4a,
    roughness: 0.75,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    mat.userData.shader = shader;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         attribute float aBend;
         uniform float uTime;
         varying float vBend;`
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         vBend = aBend;
         {
           // per-instance world position drives phase so blades don't sway in lockstep
           vec4 iw = instanceMatrix[3];
           float phase = iw.x * 3.7 + iw.z * 2.3;
           float sway = sin(uTime * 1.6 + phase) * 0.09
                      + sin(uTime * 3.1 + phase * 1.7) * 0.03;
           transformed.x += sway * aBend;
         }`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         varying float vBend;`
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
         diffuseColor.rgb *= mix(0.62, 1.15, sqrt(vBend));`
      );
  };
  mat.customProgramCacheKey = () => "grass-wind";
  return mat;
}

function jitterGeometry(geo, amount, rng) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      pos.getX(i) + (rng() - 0.5) * amount,
      pos.getY(i) + (rng() - 0.5) * amount,
      pos.getZ(i) + (rng() - 0.5) * amount
    );
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

// heaven.world.FRUIT_POS: what a hungry fly (state FEED) actually walks to.
function buildFruit(scene, x, z) {
  const group = new THREE.Group();
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xb3272a, roughness: 0.35, metalness: 0.05 });
  const stemMat = new THREE.MeshStandardMaterial({ color: 0x4a3820, roughness: 0.9 });
  const berries = [
    [0, 0.013, 0, 0.016],
    [0.012, 0.010, 0.008, 0.013],
    [-0.010, 0.009, -0.006, 0.012],
  ];
  for (const [dx, dy, dz, r] of berries) {
    const berry = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), skinMat);
    berry.position.set(dx, dy, dz);
    berry.castShadow = berry.receiveShadow = true;
    group.add(berry);
  }
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.0015, 0.002, 0.014, 6), stemMat);
  stem.position.set(0, 0.02, 0);
  stem.rotation.z = 0.3;
  stem.castShadow = true;
  group.add(stem);
  group.position.set(x, 0, z);
  scene.add(group);
  group.updateMatrixWorld(true); // feeding raycasts can run before a render
  return group;
}

// heaven.world.SUNBEAM_POS: where a comfortable, quiet fly (state BASK,
// pose bask_belly_up once satiety/mating make it reachable) suns itself.
function buildSunbeam(scene, x, z) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d");
  const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, "rgba(255,244,200,0.85)");
  grad.addColorStop(0.6, "rgba(255,230,160,0.35)");
  grad.addColorStop(1, "rgba(255,230,160,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  const patch = new THREE.Mesh(
    new THREE.CircleGeometry(SUNBEAM_RADIUS, 48),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
  );
  patch.rotation.x = -Math.PI / 2;
  patch.position.set(x, 0.0015, z);
  scene.add(patch);

  const glow = new THREE.PointLight(0xffdf9e, 0.6, SUNBEAM_RADIUS * 4, 2);
  glow.position.set(x, 0.12, z);
  scene.add(glow);
}

/**
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} renderer
 * @returns {{ groundRadius: number, clearingRadius: number, update(t:number): void }}
 */
export function buildForest(scene, renderer, foodLayout = []) {
  const rng = mulberry32(20260915);
  const navigation = new ForestNavigation();
  // Sized to comfortably hold heaven.world's real 1.2x0.8m clearing (half
  // diagonal ~0.72m) — the live server-driven flies roam that whole area.
  const groundRadius = 0.85;
  const clearingRadius = 0.2;

  // sky + fog
  scene.background = makeSkyTexture();
  scene.fog = new THREE.FogExp2(0x557a45, 2.6);

  // lighting: soft hemisphere fill + one dappled "sun" shaft
  scene.add(new THREE.HemisphereLight(0xcfe8b0, 0x3a2e1c, 0.9));
  const sun = new THREE.DirectionalLight(0xfff2d0, 2.4);
  sun.position.set(0.5, 0.9, 0.35);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -groundRadius;
  sun.shadow.camera.right = groundRadius;
  sun.shadow.camera.top = groundRadius;
  sun.shadow.camera.bottom = -groundRadius;
  sun.shadow.camera.near = 0.05;
  sun.shadow.camera.far = 3;
  sun.shadow.bias = -0.00002
  sun.shadow.normalBias = 0.00015;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xbcd8ff, 0.35);
  fill.position.set(-0.6, 0.4, -0.4);
  scene.add(fill);

  // ground
  const groundGeo = new THREE.CircleGeometry(groundRadius, 96);
  const groundTex = makeGroundTexture(rng);
  groundTex.repeat.set(6, 6);
  const groundMat = new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // landmarks the live sim actually references — kept clear of grass so
  // they stay visible from a distance
  const [fruitX, fruitZ] = heavenToScene(...FRUIT_POS);
  const [sunX, sunZ] = heavenToScene(...SUNBEAM_POS);
  const foods = foodLayout.map(food => {
    const [x, z] = heavenToScene(food.x, food.y);
    return { ...food, worldX: food.x, worldY: food.y, x, z, radius: food.id === 'berries' ? 0.016 : food.radius };
  });
  const landmarks = [
    { x: fruitX, z: fruitZ, r: 0.07 },
    { x: sunX, z: sunZ, r: SUNBEAM_RADIUS * 0.5 },
    ...foods.map(f => ({ x: f.x, z: f.z, r: f.radius + 0.045 })),
  ];
  const nearLandmark = (x, z) => landmarks.some((l) => Math.hypot(x - l.x, z - l.z) < l.r);

  // grass
  const bladeGeo = makeBladeGeometry();
  const grassMat = makeGrassMaterial();
  const bladeCount = 5500;
  const grass = new THREE.InstancedMesh(bladeGeo, grassMat, bladeCount);
  grass.castShadow = true;
  grass.receiveShadow = true;
  const dummy = new THREE.Object3D();
  let placed = 0;
  let guard = 0;
  while (placed < bladeCount && guard < bladeCount * 6) {
    guard++;
    const r = clearingRadius + rng() * (groundRadius - clearingRadius);
    const a = rng() * Math.PI * 2;
    // bias density outward from the clearing so the fly stays readable
    if (r < clearingRadius + 0.05 && rng() > 0.35) continue;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    // Keep the entire simulated walking area clear, including blade bend.
    if (Math.abs(x) < CLEARING_W / 2 + 0.025 && Math.abs(z) < CLEARING_H / 2 + 0.025) continue;
    if (nearLandmark(x, z)) continue;
    const height = THREE.MathUtils.lerp(0.07, 0.22, rng() * rng());
    const width = THREE.MathUtils.lerp(0.006, 0.012, rng());
    dummy.position.set(x, 0, z);
    dummy.rotation.set(0, rng() * Math.PI * 2, 0);
    dummy.scale.set(width / 1, height, width / 1);
    dummy.updateMatrix();
    grass.setMatrixAt(placed, dummy.matrix);
    const green = new THREE.Color().setHSL(0.24 + rng() * 0.08, 0.45 + rng() * 0.2, 0.32 + rng() * 0.18);
    grass.setColorAt(placed, green);
    placed++;
  }
  grass.count = placed;
  scene.add(grass);

  // pebbles
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x7c7468, roughness: 0.95 });
  for (let i = 0; i < 22; i++) {
    const geo = jitterGeometry(new THREE.IcosahedronGeometry(1, 1), 0.28, rng);
    const rock = new THREE.Mesh(geo, rockMat);
    let x, z;
    do {
      const r = clearingRadius * 0.6 + rng() * groundRadius * 0.9;
      const a = rng() * Math.PI * 2;
      x = Math.cos(a) * r; z = Math.sin(a) * r;
    } while (nearLandmark(x, z));
    const scale = THREE.MathUtils.lerp(0.012, 0.03, rng());
    rock.position.set(x, scale * 0.4, z);
    rock.scale.set(scale, scale * (0.6 + rng() * 0.3), scale);
    rock.rotation.y = rng() * Math.PI * 2;
    rock.castShadow = rock.receiveShadow = true;
    scene.add(rock);
    navigation.addCircle(x, z, scale * 1.15, scale * 1.5);
  }

  // twigs
  const twigMat = new THREE.MeshStandardMaterial({ color: 0x5a4128, roughness: 0.9 });
  for (let i = 0; i < 12; i++) {
    const len = THREE.MathUtils.lerp(0.05, 0.14, rng());
    const geo = new THREE.CylinderGeometry(len * 0.03, len * 0.045, len, 6);
    const twig = new THREE.Mesh(geo, twigMat);
    let x, z;
    do {
      const r = clearingRadius * 0.5 + rng() * groundRadius * 0.85;
      const a = rng() * Math.PI * 2;
      x = Math.cos(a) * r; z = Math.sin(a) * r;
    } while (nearLandmark(x, z));
    twig.position.set(x, len * 0.03, z);
    twig.rotation.set(Math.PI / 2 + (rng() - 0.5) * 0.3, 0, rng() * Math.PI * 2);
    twig.castShadow = twig.receiveShadow = true;
    scene.add(twig);
    twig.updateMatrixWorld(true);
    const a = twig.localToWorld(new THREE.Vector3(0, -len / 2, 0));
    const b = twig.localToWorld(new THREE.Vector3(0, len / 2, 0));
    navigation.addCapsule(a.x, a.z, b.x, b.z, len * 0.045, len * 0.1);
  }

  // fallen leaves (simple diamond shape, alpha-free so no texture needed)
  const leafShape = new THREE.Shape();
  leafShape.moveTo(0, -1);
  leafShape.quadraticCurveTo(0.55, -0.3, 0, 1);
  leafShape.quadraticCurveTo(-0.55, -0.3, 0, -1);
  const leafGeo = new THREE.ShapeGeometry(leafShape, 6);
  const leafColors = [0x9c5a2a, 0xb9772f, 0x7a4a20, 0xc98f3a];
  for (let i = 0; i < 16; i++) {
    const leaf = new THREE.Mesh(
      leafGeo,
      new THREE.MeshStandardMaterial({
        color: leafColors[i % leafColors.length],
        roughness: 0.85,
        side: THREE.DoubleSide,
      })
    );
    let x, z;
    do {
      const r = clearingRadius * 0.4 + rng() * groundRadius * 0.8;
      const a = rng() * Math.PI * 2;
      x = Math.cos(a) * r; z = Math.sin(a) * r;
    } while (nearLandmark(x, z));
    const scale = THREE.MathUtils.lerp(0.015, 0.03, rng());
    leaf.position.set(x, 0.0008, z);
    leaf.rotation.set(-Math.PI / 2 + (rng() - 0.5) * 0.2, 0, rng() * Math.PI * 2);
    leaf.scale.setScalar(scale);
    leaf.receiveShadow = true;
    scene.add(leaf);
    navigation.addCircle(x, z, scale, scale * 0.22);
  }

  const berries = buildFruit(scene, fruitX, fruitZ);
  for (const food of foods) if (food.id === 'berries') food.object = berries;
  navigation.addCircle(fruitX, fruitZ, 0.016, 0.029, 'berries');
  navigation.addCircle(fruitX + 0.012, fruitZ + 0.008, 0.013, 0.023, 'berries');
  navigation.addCircle(fruitX - 0.010, fruitZ - 0.006, 0.012, 0.021, 'berries');
  buildSunbeam(scene, sunX, sunZ);

  return {
    groundRadius,
    clearingRadius,
    navigation,
    foods,
    addFoodModels(pack) {
      for (const food of foods) {
        if (!food.model) continue;
        const template = pack.getObjectByName(food.model);
        if (!template) throw new Error(`Missing food model: ${food.model}`);
        // Keep glTF's authored Z-up -> Y-up conversion on the child. Yaw
        // belongs on a wrapper so long fruit stays flat on the ground.
        const model = new THREE.Group();
        model.add(template.clone(true));
        model.scale.setScalar(food.size);
        model.position.set(food.x, 0.0003, food.z);
        model.rotation.y = 0;
        model.traverse(node => {
          if (!node.isMesh) return;
          node.castShadow = true; node.receiveShadow = true;
          const tune = material => {
            const clone = material.clone(); clone.metalness = 0; clone.roughness = Math.max(0.65, material.roughness);
            return clone;
          };
          node.material = Array.isArray(node.material) ? node.material.map(tune) : tune(node.material);
        });
        scene.add(model);
        model.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        let radius = 0;
        model.traverse(node => {
          if (!node.isMesh) return;
          const positions = node.geometry.attributes.position;
          const point = new THREE.Vector3();
          for (let i = 0; i < positions.count; i++) {
            point.fromBufferAttribute(positions, i).applyMatrix4(node.matrixWorld);
            radius = Math.max(radius, Math.hypot(point.x - center.x, point.z - center.z));
          }
        });
        food.radius = radius;
        food.height = box.max.y;
        food.x = center.x; food.z = center.z;
        model.rotation.y = food.heading ?? 0;
        model.updateMatrixWorld(true);
        food.object = model;
        navigation.addCircle(food.x, food.z, food.radius, food.height, food.id);
      }
    },
    // Where a feeding fly stands on the line from a food's center toward
    // (fromX, fromZ): its proboscis tip meets the food's real surface, and
    // its eyes stay out. `contact` is FlyRig's measured FEED_CONTACT.
    feedingSpot(food, fromX, fromZ, heading, contact) {
      let dx = fromX - food.x, dz = fromZ - food.z;
      if (Math.hypot(dx, dz) < 0.001) { dx = -Math.sin(heading); dz = -Math.cos(heading); }
      const norm = Math.hypot(dx, dz);
      dx /= norm; dz /= norm;
      // How far along the approach the food's surface lies, for a ray at
      // `height` shifted `side` across it; null where nothing of the food is.
      const surface = (height, side = 0) => {
        if (!food.object) return food.radius;
        const start = food.radius + 0.02;
        const origin = new THREE.Vector3(food.x + dx * start - dz * side, height, food.z + dz * start + dx * side);
        const hit = new THREE.Raycaster(origin, new THREE.Vector3(-dx, 0, -dz), 0, start).intersectObject(food.object, true)[0];
        return hit ? start - hit.distance : null;
      };
      let distance = -Infinity;
      for (const point of contact.eyes) {
        for (const side of point.side ? [point.side, -point.side] : [0]) {
          const s = surface(point.height, side);
          if (s !== null) distance = Math.max(distance, s + point.reach);
        }
      }
      const tip = surface(contact.tip.height);
      if (tip !== null) distance = Math.max(distance, tip + contact.tip.reach);
      if (distance === -Infinity) distance = food.radius + contact.tip.reach;
      // A food that curves away below the eyes stops the head short; `reach`
      // is how much further the proboscis must extend to touch it.
      const reach = tip === null ? 0 : distance - (tip + contact.tip.reach);
      return { x: food.x + dx * distance, z: food.z + dz * distance, heading: Math.atan2(-dx, -dz), reach };
    },
    fruit: { x: fruitX, z: fruitZ, radius: 0.016 },
    update(t) {
      const shader = grassMat.userData.shader;
      if (shader) shader.uniforms.uTime.value = t;
    },
  };
}
