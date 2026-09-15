import * as THREE from 'three';

const DEG = THREE.MathUtils.degToRad;
const PARTS = ['Front', 'Center', 'Rear'];
const SIDES = ['L', 'R'];
const WALKING = new Set(['walk', 'follow', 'retreat', 'mount_approach', 'dismount']);
const smooth = (dt, tau) => 1 - Math.exp(-dt / tau);
// At rest the proboscis hangs to the ground. Swinging its base forward lifts
// the labellum to face ahead, just below the eyes; its bones point along
// local +Y at a tenth of world scale, so extending them slides the labellum
// forward (measured: about 0.092 m of reach per local unit).
const PROBOSCIS_SWING = -125;
const PROBOSCIS_EXTENSION = 0.026;
const PROBOSCIS_GAIN = 1 / 0.092;
const MAX_EXTRA_REACH = 0.004;

// Feeding contact for this rig at the peak of a dab, measured from the posed
// skinned mesh: how far ahead of the body center the labellum and the front
// of the compound eyes reach, at a height above the ground and a sideways
// offset.
export const FEED_CONTACT = {
  tip: { reach: 0.0107, height: 0.0032 },
  eyes: [
    { reach: 0.0077, height: 0.0035, side: 0 },
    { reach: 0.008, height: 0.0045, side: 0 },
    { reach: 0.0081, height: 0.0055, side: 0 },
    { reach: 0.0071, height: 0.0065, side: 0 },
    { reach: 0.0076, height: 0.0035, side: 0.0015 },
    { reach: 0.0075, height: 0.0045, side: 0.0015 },
    { reach: 0.007, height: 0.0055, side: 0.0015 },
    { reach: 0.0064, height: 0.0045, side: 0.0025 },
  ],
};

const naturalMaterials = new WeakMap();
function flyMaterial(source) {
  if (naturalMaterials.has(source)) return naturalMaterials.get(source);
  const material = source.clone();
  // Blender's lacquer/transmission setup reads as a gold toy without its
  // studio environment. Keep the texture detail with a matte chitin finish.
  material.metalness = 0;
  material.roughness = Math.max(source.roughness, 0.48);
  if ('transmission' in material) material.transmission = 0;
  if ('clearcoat' in material) material.clearcoat = 0;
  if (/AutoLack|Hinterleib/.test(source.name)) material.color.setRGB(0.48, 0.58, 0.7);
  if (/Wing/.test(source.name)) {
    material.side = THREE.DoubleSide;
    material.transparent = true;
    material.opacity = 0.58;
    material.depthWrite = false;
    material.roughness = 0.35;
  }
  naturalMaterials.set(source, material);
  return material;
}

export class FlyRig {
  constructor(gltfScene, opts = {}) {
    this.object = new THREE.Group();
    this.object.visible = false;
    this.puppet = new THREE.Group();
    this.model = gltfScene;
    this.scale = opts.scale ?? 1;
    this.radius = 0.012 * this.scale;
    this.navigation = opts.navigation;
    this.pivot = 0.0045 * this.scale;
    this.model.scale.setScalar(this.scale);
    this.model.position.y = -this.pivot;
    this.puppet.position.y = this.pivot;
    this.puppet.add(this.model);
    this.object.add(this.puppet);
    this.bones = {};
    this.restQuat = {};
    this.restPos = {};
    this.angles = {};
    this.offsets = {};
    // GLTFLoader removes periods/spaces from names and suffixes duplicate
    // mesh names. Match actual bones using its same sanitization function.
    this.model.traverse(n => {
      if (n.isMesh) {
        n.castShadow = true; n.receiveShadow = true;
        n.material = Array.isArray(n.material) ? n.material.map(flyMaterial) : flyMaterial(n.material);
      }
      if (n.isBone) { this.bones[n.name] = n; this.restQuat[n.name] = n.quaternion.clone(); this.restPos[n.name] = n.position.clone(); }
    });
    this.object.updateMatrixWorld(true);
    this.feet = [];
    for (const part of PARTS) for (const side of SIDES) {
      const base = `Leg.${part}.${side}`;
      const tip = this.bone(`${base}.008`);
      const chain = ['003', '002', '001'].map(seg => this.bone(`${base}.${seg}`));
      if (!tip || chain.some(n => !n)) throw new Error(`Housefly rig is missing ${base}`);
      const rest = this.object.worldToLocal(tip.getWorldPosition(new THREE.Vector3()));
      this.feet.push({ part, side, tip, chain, rest, plant: null, swinging: false, start: new THREE.Vector3(), target: null,
        phase: (part === 'Center') === (side === 'R') ? 0 : 0.5 });
    }
    this.pos = new THREE.Vector2();
    this.height = 0;
    this.heading = 0;
    this.roll = 0;
    this.pitch = 0;
    this.bodyLift = 0;
    this.poseSince = 0;
    this.gaitPhase = 0;
    this.speed = 0;
    this.food = null;
    this.target = { pos: new THREE.Vector2(), height: 0, heading: 0, pose: 'bask', food: null, reach: 0 };
    this._posTau = 0.2;
    this._lastSetAt = null;
    this._lastTick = null;
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._offset = new THREE.Vector3();
    this._joint = new THREE.Vector3();
    this._tip = new THREE.Vector3();
    this._to = new THREE.Vector3();
    this._parentQ = new THREE.Quaternion();
  }

  bone(name) { return this.bones[THREE.PropertyBinding.sanitizeNodeName(name)]; }

  // `food` names the food a feeding fly may reach into (its navigation id);
  // `reach` is how much further than FEED_CONTACT its proboscis must extend.
  setTarget({ x, z, heading, height = 0, pose = 'bask', wingSong = false, proboscis = 0, mounted = false, food = null, reach = 0, tick }) {
    // Polling can return the same neural tick many times. Only fresh ticks
    // measure interpolation cadence or begin a new behavior.
    if (tick !== undefined && tick === this._lastTick) return;
    this._lastTick = tick;
    if (pose !== this.target.pose) this.poseSince = 0;
    const now = performance.now() / 1000;
    if (this._lastSetAt !== null) this._posTau = THREE.MathUtils.lerp(this._posTau, THREE.MathUtils.clamp(now - this._lastSetAt, 0.1, 1.5), 0.3);
    this._lastSetAt = now;
    if (this.navigation) [x, z] = this.navigation.constrain(x, z, this.radius, height, food);
    this.target = { pos: new THREE.Vector2(x, z), heading, height, pose, wingSong, proboscis, mounted, food, reach };
    if (!this.object.visible) {
      this.pos.copy(this.target.pos); this.heading = heading; this.height = height;
      this.object.visible = true;
    }
  }

  rotate(name, x = 0, y = 0, z = 0) {
    const bone = this.bone(name);
    if (bone) this.angles[bone.name] = [x, y, z];
  }

  extend(name, x = 0, y = 0, z = 0) {
    const bone = this.bone(name);
    if (bone) this.offsets[bone.name] = [x, y, z];
  }

  update(dt, t) {
    if (!this.object.visible) return;
    this.poseSince += dt;
    const alpha = smooth(dt, this._posTau);
    const oldX = this.pos.x, oldZ = this.pos.y;
    let x = THREE.MathUtils.lerp(oldX, this.target.pos.x, alpha);
    let z = THREE.MathUtils.lerp(oldZ, this.target.pos.y, alpha);
    this.height += (this.target.height - this.height) * alpha;
    // After feeding, keep reaching into that food until the body backs out,
    // rather than snapping to its collision edge in one frame.
    if (this.target.food !== null || !this.navigation?.overlaps(oldX, oldZ, this.radius, this.height, this.food)) this.food = this.target.food;
    if (this.navigation) [x, z] = this.navigation.move(oldX, oldZ, x, z, this.radius, this.height, this.food);
    this.pos.set(x, z);
    const distance = Math.hypot(x - oldX, z - oldZ);
    this.speed += (distance / Math.max(dt, 0.001) - this.speed) * smooth(dt, 0.1);
    this.gaitPhase += distance / (0.0048 * this.scale);
    const desiredHeading = WALKING.has(this.target.pose) && distance > 0.000005
      ? Math.atan2(x - oldX, z - oldZ) : this.target.heading;
    const dh = desiredHeading - this.heading;
    this.heading += Math.atan2(Math.sin(dh), Math.cos(dh)) * smooth(dt, 0.22);
    const pose = this.target.pose;
    const upsideDown = pose === 'bask_belly_up';
    this.roll += ((upsideDown ? Math.PI * 0.95 : 0) - this.roll) * smooth(dt, 0.55);
    const desiredPitch = pose === 'feed' ? DEG(7) : pose === 'mate' ? DEG(-12) : pose === 'flight' ? DEG(-9) : 0;
    this.pitch += (desiredPitch - this.pitch) * smooth(dt, 0.3);
    this.bodyLift += ((upsideDown ? 0.0015 * this.scale : 0) - this.bodyLift) * smooth(dt, 0.4);
    this.object.position.set(x, this.height, z);
    this.object.rotation.y = this.heading;
    this.puppet.position.y = this.pivot + this.bodyLift;
    this.puppet.rotation.set(this.pitch, 0, this.roll);
    this.angles = {};
    this.offsets = {};
    this._pose(pose, t);
    const boneAlpha = smooth(dt, 0.09);
    for (const [name, bone] of Object.entries(this.bones)) {
      // Grounded legs are solved from their foot contacts below.
      if (name.startsWith('Leg')) continue;
      const angles = this.angles[name] ?? [0, 0, 0];
      this._e.set(...angles.map(DEG));
      this._q.setFromEuler(this._e).premultiply(this.restQuat[name]);
      bone.quaternion.slerp(this._q, boneAlpha);
      this._offset.set(...(this.offsets[name] ?? [0, 0, 0])).add(this.restPos[name]);
      bone.position.lerp(this._offset, boneAlpha);
    }
    this.object.updateMatrixWorld(true);
    this._feet(pose, dt, t);
  }

  _pose(pose, t) {
    const local = this.poseSince;
    this.rotate('Haed', 1.2 * Math.sin(t * 1.1), 0, 2 * Math.sin(t * 0.7));
    this.rotate('Antena.L', 0, 0, 3 * Math.sin(t * 2.3));
    this.rotate('Antena.R', 0, 0, -3 * Math.sin(t * 2.1 + 0.4));
    if (pose === 'feed') {
      // Each dab presses the labellum onto the food, then lifts it away.
      const dab = (1 - Math.cos(local * 7)) / 2;
      const extension = PROBOSCIS_EXTENSION + Math.min(this.target.reach, MAX_EXTRA_REACH) * PROBOSCIS_GAIN;
      this.rotate('Haed', 12 + 1.5 * dab);
      this.rotate('dabbing snout up', PROBOSCIS_SWING);
      this.rotate('dabbing snout down', 4 * dab);
      this.extend('dabbing snout up', 0, extension * (0.4 + 0.6 * dab), 0);
      this.rotate('Torax.front.001', 1.2 * Math.sin(local * 3));
    } else if (pose === 'sing') {
      this.rotate('Wing.R', 0, 7 * Math.sin(local * Math.PI * 2 * 7.3), 62);
      this.rotate('Haed', -3, 0, 2 * Math.sin(local * 2));
    } else if (pose === 'flight') {
      const flap = 55 * Math.sin(t * Math.PI * 2 * 8.3);
      this.rotate('Wing.L', 0, flap, -45);
      this.rotate('Wing.R', 0, -flap, 45);
    } else if (pose === 'mate') {
      this.rotate('Torax.front.001', -14 + 0.7 * Math.sin(local * 2));
      this.rotate('Wing.L', 0, 0, -12);
      this.rotate('Wing.R', 0, 0, 12);
      this.rotate('Haed', -4);
    } else if (pose === 'groom') {
      this.rotate('Haed', 4 * Math.sin(local * 6));
    } else if (pose === 'bask' || pose === 'bask_belly_up') {
      this.rotate('Wing.L', 0, 0, -5);
      this.rotate('Wing.R', 0, 0, 5);
      this.rotate('Haed', 0.5 * Math.sin(local * 0.8));
      this.rotate('Torax.front.001', 0.5 * Math.sin(local * 1.6));
    }
  }

  _feet(pose, dt, t) {
    const walking = WALKING.has(pose) && this.speed > 0.00015;
    const airborne = pose === 'flight' || this.roll > 0.2;
    for (const foot of this.feet) {
      const rest = this.object.localToWorld(foot.rest.clone());
      rest.y = this.height + foot.rest.y;
      let goal = rest.clone();
      if (airborne) {
        goal.copy(foot.rest); goal.y += 0.002 * this.scale;
        goal.x *= 0.8;
        goal.y -= this.pivot;
        this.puppet.localToWorld(goal);
        foot.plant = null;
      } else if (pose === 'groom' && foot.part === 'Front') {
        goal.set((foot.side === 'L' ? 1 : -1) * 0.0014 * this.scale, 0.0045 * this.scale, 0.0068 * this.scale);
        goal.z += 0.0004 * Math.sin(this.poseSince * 18 + (foot.side === 'L' ? 0 : Math.PI));
        this.object.localToWorld(goal);
        foot.plant = null;
      } else if (pose === 'mate') {
        // Grip her thorax and flanks instead of dangling above her back.
        goal.y = (foot.part === 'Front' ? 0.0068 : foot.part === 'Center' ? 0.0055 : 0.0038) * this.scale;
        const local = foot.rest.clone();
        local.x *= 0.72;
        this.object.localToWorld(local);
        goal.x = local.x; goal.z = local.z;
        foot.plant = null;
      } else {
        if (!foot.plant) foot.plant = rest.clone();
        const phase = (this.gaitPhase + foot.phase) % 1;
        const swing = walking && phase > 0.6;
        if (swing) {
          if (!foot.swinging) foot.start.copy(foot.plant);
          const u = (phase - 0.6) / 0.4;
          goal.z += Math.cos(this.heading) * 0.0015 * this.scale;
          goal.x += Math.sin(this.heading) * 0.0015 * this.scale;
          goal.lerpVectors(foot.start, goal.clone(), u * u * (3 - 2 * u));
          goal.y += Math.sin(u * Math.PI) * 0.0012 * this.scale;
          foot.plant.copy(goal);
        } else {
          if (foot.plant.distanceTo(rest) > 0.0035 * this.scale || !walking) foot.plant.lerp(rest, smooth(dt, 0.12));
          goal.copy(foot.plant);
        }
        foot.swinging = swing;
        if (pose === 'tap' && foot.part === 'Front' && foot.side === 'L') goal.y += 0.001 * Math.max(0, Math.sin(this.poseSince * 8));
      }
      if (!foot.target) foot.target = goal.clone();
      foot.target.lerp(goal, smooth(dt, 0.055));
      this._solveFoot(foot);
    }
  }

  _solveFoot(foot) {
    // Short CCD chain, retaining the authored joint lengths and stance.
    for (let iteration = 0; iteration < 5; iteration++) {
      for (const joint of foot.chain) {
        joint.getWorldPosition(this._joint);
        foot.tip.getWorldPosition(this._tip).sub(this._joint).normalize();
        this._to.copy(foot.target).sub(this._joint).normalize();
        joint.parent.getWorldQuaternion(this._parentQ).invert();
        this._tip.applyQuaternion(this._parentQ);
        this._to.applyQuaternion(this._parentQ);
        this._q.setFromUnitVectors(this._tip, this._to);
        joint.quaternion.premultiply(this._q);
        const rest = this.restQuat[joint.name];
        const angle = rest.angleTo(joint.quaternion);
        if (angle > 1.15) joint.quaternion.slerp(rest, 1 - 1.15 / angle);
        joint.updateWorldMatrix(false, true);
      }
    }
  }
}
