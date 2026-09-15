import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { decodeActivity, regionRates } from './brain-data.js';

const CIRCUITS = [
  ['PAM11', 'Dopamine', '#ffb84d'], ['MN9', 'Feeding', '#7ee787'],
  ['P1', 'Courtship', '#ff6bcb'], ['pIP10', 'Song', '#c792ea'],
  ['DNg12', 'Grooming', '#7fd4ff'], ['GF', 'Escape', '#ff7878'],
  ['DNa02_L', 'Steering · left', '#f6c977'], ['DNa02_R', 'Steering · right', '#f6c977'],
  ['MDN', 'Backward walking', '#d0aaff'], ['motor', 'Motor output', '#e6e6e6'],
];

export class BrainView {
  constructor(host) {
    this.host = host;
    this.status = document.getElementById('brainStatus');
    this.coverage = document.getElementById('brainCoverage');
    this.focusLabel = document.getElementById('brainFocus');
    this.regionList = document.getElementById('brainRegions');
    this.circuitSelect = document.getElementById('brainCircuit');
    this.scopeSelect = document.getElementById('brainScope');
    this.flyId = null;
    this.activityTick = null;
    this.sampleTick = null;
    this.pending = false;
    this.nextPoll = 0;
    this.generation = 0;
    this.rates = {};
    this.regionSelected = -1;
    this.ready = false;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.setClearColor(0x06131a, 1);
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-label', 'Rotatable MaleCNS neuron atlas with live simulated activity');
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 1;
    this.controls.maxDistance = 12;
    this.controls.autoRotate = false;
    for (const [key, label] of CIRCUITS) this.circuitSelect.add(new Option(label, key));
    this.circuitSelect.addEventListener('change', () => this.selectCircuit());
    this.scopeSelect.addEventListener('change', () => this.fit());
    document.getElementById('brainScan').addEventListener('change', e => { if (this.material) this.material.uniforms.uScan.value = e.target.checked ? 1 : 0; });
    const expand = document.getElementById('brainExpand');
    expand.addEventListener('click', () => {
      const expanded = document.getElementById('brain').classList.toggle('expanded');
      expand.textContent = expanded ? 'Close' : 'Expand'; expand.setAttribute('aria-expanded', String(expanded));
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.getElementById('brain').classList.contains('expanded')) expand.click(); });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.load().catch(error => { this.status.textContent = 'Atlas unavailable'; this.coverage.textContent = error.message; });
  }

  async load() {
    const base = './assets/brain-atlas/';
    const fetchFile = async (name, type) => { const r = await fetch(base + name); if (!r.ok) throw new Error('Build atlas: python web/tools/export_brain_atlas.py'); return r[type](); };
    const [atlas, points, indices, regions] = await Promise.all([
      fetchFile('atlas.json', 'json'), fetchFile('positions.f32', 'arrayBuffer'),
      fetchFile('indices.u32', 'arrayBuffer'), fetchFile('regions.u8', 'arrayBuffer'),
    ]);
    this.atlas = atlas;
    this.indices = new Uint32Array(indices);
    this.regions = new Uint8Array(regions);
    const raw = new Float32Array(points), n = this.indices.length;
    if (raw.length !== n * 3 || n !== atlas.visible || this.regions.length !== atlas.neurons) throw new Error('Atlas files do not match');
    this.positions = new Float32Array(raw.length);
    this.colors = new Float32Array(raw.length);
    this.previous = new Float32Array(n);
    this.current = new Float32Array(n);
    this.selected = new Float32Array(n);
    const brain = new Float32Array(n), region = new Float32Array(n);
    const palette = atlas.regions.map(r => new THREE.Color(r.color));
    this.bounds = new THREE.Box3(); this.brainBounds = new THREE.Box3();
    // Keep the source anatomy, presenting source Z vertically for the cord.
    for (let i = 0; i < n; i++) {
      const p = new THREE.Vector3((raw[i * 3] - 48000) / 45000, -(raw[i * 3 + 2] - 72000) / 45000, (raw[i * 3 + 1] - 35000) / 45000);
      p.toArray(this.positions, i * 3); this.bounds.expandByPoint(p);
      brain[i] = raw[i * 3 + 2] < atlas.brainCutoff ? 1 : 0;
      if (brain[i]) this.brainBounds.expandByPoint(p);
      region[i] = this.regions[this.indices[i]];
      palette[region[i]].toArray(this.colors, i * 3);
    }
    this.baseColors = this.colors.slice();
    const geometry = new THREE.BufferGeometry();
    for (const [name, array, size] of [ ['position', this.positions, 3], ['color', this.colors, 3], ['aPrevious', this.previous, 1], ['aCurrent', this.current, 1], ['aBrain', brain, 1], ['aRegion', region, 1], ['aSelected', this.selected, 1] ]) geometry.setAttribute(name, new THREE.BufferAttribute(array, size));
    this.geometry = geometry;
    this.material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uBlend: { value: 1 }, uBrainOnly: { value: 1 }, uScan: { value: 1 }, uScanY: { value: 0 }, uRegion: { value: -1 }, uCircuit: { value: 0 }, uPixelRatio: { value: this.renderer.getPixelRatio() }, uLive: { value: 1 } },
      vertexShader: `attribute vec3 color; attribute float aPrevious; attribute float aCurrent; attribute float aBrain; attribute float aRegion; attribute float aSelected;
        uniform float uBlend,uBrainOnly,uScan,uScanY,uRegion,uCircuit,uPixelRatio,uLive;
        varying vec3 vColor; varying float vIntensity,vVisible,vSelected;
        void main(){
          float activity=mix(aPrevious,aCurrent,uBlend)*uLive;
          float regionMatch=1.0-step(0.5,abs(aRegion-uRegion));
          float focus=uRegion<0.0?1.0:mix(0.08,1.0,regionMatch);
          float circuitFocus=mix(1.0,mix(0.05,1.0,aSelected),uCircuit);
          float scan=exp(-pow((position.y-uScanY)*28.0,2.0))*uScan;
          vVisible=1.0-uBrainOnly*(1.0-aBrain);
          vSelected=aSelected*uCircuit;
          vIntensity=(0.085+vSelected*0.3+scan*0.1+activity*0.85)*focus*circuitFocus;
          vColor=mix(color,vec3(0.72,0.94,1.0),scan*0.25);
          vec4 mv=modelViewMatrix*vec4(position,1.0);
          gl_Position=projectionMatrix*mv;
          gl_PointSize=clamp((1.0+activity*2.8+vSelected*3.0)*uPixelRatio*3.0/-mv.z,0.8,10.0);
        }`,
      fragmentShader: `varying vec3 vColor; varying float vIntensity,vVisible,vSelected;
        void main(){if(vVisible<0.5)discard;float r=length(gl_PointCoord-0.5)*2.0;if(r>1.0)discard;float glow=exp(-r*r*3.0);gl_FragColor=vec4(vColor*vIntensity,glow);}`,
    });
    this.cloud = new THREE.Points(geometry, this.material);
    this.cloud.frustumCulled = false;
    this.scene.add(this.cloud);
    this.regionButtons = atlas.regions.map((r, i) => {
      const button = document.createElement('button');button.type = 'button';button.className = 'brain-region';
      button.style.setProperty('--region-color', r.color);button.setAttribute('aria-pressed', 'false');
      const label = document.createElement('span');label.textContent = r.name;
      const rate = document.createElement('b');rate.textContent = '—';button.append(label, rate);
      button.addEventListener('click', () => {
        this.regionSelected = this.regionSelected === i ? -1 : i;
        this.material.uniforms.uRegion.value = this.regionSelected;
        if (this.regionSelected === 4 || this.regionSelected === 5) { this.scopeSelect.value = 'cns';this.fit(); }
        this.regionButtons.forEach((b, j) => b.setAttribute('aria-pressed', String(j === this.regionSelected)));
      });
      this.regionList.appendChild(button);return button;
    });
    this.ready = true; this.status.textContent = 'Waiting for activity';
    this.coverage.title = `${atlas.missing.toLocaleString()} simulated neurons have no soma coordinates and are omitted from the anatomy only. Groups use annotated neuron superclasses.`;
    this.fit();this.selectCircuit();
    if (this.flyId) this.applyReadouts();
  }

  resize() {
    const { width, height } = this.host.getBoundingClientRect();
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);this.camera.aspect = width / height;this.camera.updateProjectionMatrix();
  }

  fit() {
    if (!this.ready) return;
    const brainOnly = this.scopeSelect.value === 'brain';
    this.material.uniforms.uBrainOnly.value = brainOnly ? 1 : 0;
    const box = brainOnly ? this.brainBounds : this.bounds;
    const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    this.resize();
    const distance = Math.max(size.y, size.x / this.camera.aspect) / (2 * Math.tan(THREE.MathUtils.degToRad(35 / 2))) * 1.2;
    this.controls.target.copy(center);this.camera.position.copy(center).add(new THREE.Vector3(0, 0, distance));this.controls.update();
    this.coverage.textContent = `${(brainOnly ? this.atlas.brainVisible : this.atlas.visible).toLocaleString()} soma locations · ${this.atlas.neurons.toLocaleString()} simulated neurons`;
  }

  selectCircuit() {
    if (!this.ready) return;
    const key = this.circuitSelect.value;
    if (key) {
      this.regionSelected = -1;this.material.uniforms.uRegion.value = -1;
      this.regionButtons.forEach(button => button.setAttribute('aria-pressed', 'false'));
    }
    const group = new Set(this.atlas.circuits[key] ?? []);
    const color = new THREE.Color(CIRCUITS.find(c => c[0] === key)?.[2] ?? '#ffffff');
    this.colors.set(this.baseColors);
    for (let i = 0; i < this.indices.length; i++) {
      this.selected[i] = group.has(this.indices[i]) ? 1 : 0;
      if (this.selected[i]) color.toArray(this.colors, i * 3);
    }
    this.geometry.attributes.color.needsUpdate = true;
    this.geometry.attributes.aSelected.needsUpdate = true;
    this.material.uniforms.uCircuit.value = key ? 1 : 0;
    if (key && this.selected.some((selected, i) => selected && !this.geometry.attributes.aBrain.array[i])) {
      this.scopeSelect.value = 'cns';this.fit();
    }
    this.updateFocusLabel();
  }

  setFly(id, data) {
    if (id !== this.flyId) {
      this.flyId = id;this.generation++;this.activityTick = null;this.sampleTick = null;this.counts = null;this.lastActivityAt = null;this.nextPoll = 0;
      if (this.ready) { this.previous.fill(0);this.current.fill(0);this.upload();this.regionButtons.forEach(b => b.querySelector('b').textContent = '—'); }
    }
    this.data = data;
    this.rates = data?.rates ?? {};
    if (!this.ready) return;
    this.updateFocusLabel();
    if (!id || data?.status !== 'ready') { this.status.textContent = id ? 'Brain loading' : 'No fly selected';return; }
    if (!data.activity_available && data.tick !== this.sampleTick) { this.sampleTick = data.tick;this.applyReadouts(); }
    if (!data.activity_available) this.status.textContent = 'Live circuit averages';
    else if (this.lastActivityAt && performance.now() - this.lastActivityAt > 5000) this.status.textContent = 'Activity stream paused';
  }

  updateFocusLabel() {
    const key = this.circuitSelect.value;
    if (!key) { this.focusLabel.textContent = 'Activity across all visible neurons';return; }
    const name = CIRCUITS.find(c => c[0] === key)?.[1] ?? key;
    const visible = this.selected.reduce((sum, n) => sum + n, 0);
    this.focusLabel.textContent = `${name} · ${visible}/${this.atlas.circuits[key]?.length ?? 0} soma locations · ${(this.rates[key] ?? 0).toFixed(1)} Hz`;
  }

  applyReadouts() {
    if (!this.ready) return;
    this.previous.set(this.current);this.current.fill(0);
    const byNeuron = new Float32Array(this.atlas.neurons);
    for (const [key] of CIRCUITS) for (const index of this.atlas.circuits[key] ?? []) byNeuron[index] = Math.sqrt(Math.min(1, (this.rates[key] ?? 0) / 60));
    for (let i = 0; i < this.indices.length; i++) this.current[i] = byNeuron[this.indices[i]];
    this.upload();
  }

  upload() { this.geometry.attributes.aPrevious.needsUpdate = true;this.geometry.attributes.aCurrent.needsUpdate = true;this.material.uniforms.uBlend.value = 0; }

  async pollActivity() {
    const id = this.flyId, generation = this.generation;
    this.pending = true;
    try {
      const response = await fetch(`api/flies/${encodeURIComponent(id)}/activity`, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error('Activity unavailable');
      const activity = decodeActivity(await response.arrayBuffer(), this.atlas.neurons);
      if (generation !== this.generation || activity.tick === this.activityTick) return;
      this.activityTick = activity.tick;this.counts = activity.counts;this.lastActivityAt = performance.now();
      this.previous.set(this.current);
      for (let i = 0; i < this.indices.length; i++) this.current[i] = Math.sqrt(Math.min(1, this.counts[this.indices[i]] / 3));
      this.upload();
      const rates = regionRates(this.counts, this.regions, this.atlas.regions.length, activity.durationMs);
      this.regionButtons.forEach((button, i) => {
        button.querySelector('b').textContent = rates[i].toFixed(1) + ' Hz';
        button.style.setProperty('--activity', Math.min(1, rates[i] / 30));
      });
      this.status.textContent = 'Live neuron activity';
    } catch {
      if (generation === this.generation) { this.status.textContent = 'Circuit averages · stream unavailable';this.applyReadouts(); }
    } finally { this.pending = false; }
  }

  update(dt, t) {
    if (!this.ready) return;
    const uniforms = this.material.uniforms;
    uniforms.uBlend.value = Math.min(1, uniforms.uBlend.value + dt / 0.2);
    uniforms.uLive.value = !this.flyId || this.data?.status !== 'ready' ? 0 : 1;
    const box = this.scopeSelect.value === 'brain' ? this.brainBounds : this.bounds;
    uniforms.uScanY.value = THREE.MathUtils.lerp(box.min.y, box.max.y, (t * 0.13) % 1);
    if (this.data?.activity_available && !this.pending && performance.now() >= this.nextPoll) {
      this.nextPoll = performance.now() + 300;this.pollActivity();
    }
    this.controls.update(dt);this.renderer.render(this.scene, this.camera);
  }
}
