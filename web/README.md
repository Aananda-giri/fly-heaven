# Fly Haven — live connectome-driven forest floor

A browser-based alternative to the Blender continuous-film pipeline (see the
top-level [README](../README.md)): one or more rigged houseflies, each
driven by its own live instance of the real 166,700-neuron MaleCNS v1.0
brain, wandering a macro-scale forest floor with procedural scenery and a user-supplied low-poly food pack. Grass
blades genuinely tower over the fly — everything is sized in real-world
units (meters) against its true ~13×9×20mm body.

**The brain is real, not scripted.** Each fly is a full closed loop —
`heaven.world` (physiology, fruit, sunbeam, a female) → `heaven.brain`'s
compiled connectome kernel → `heaven.behaviour`'s calibrated thresholds →
back to the world — running live in its own Python process
(`web/server/fly_worker.py`), streamed to the browser over a small local
HTTP API (`web/server/app.py`). Whether and when a fly feeds, baskets belly-up,
or courts and mates is a real readout of the connectome, exactly like the
Blender pipeline; only the environment, the female's long-range approach, and
the visible poses are scripted, per this repo's usual split.

**"Infinite dopamine":** whenever a fly is eating, sunbathing belly-up, or
past the SING stage of courtship, `fly_worker.py` injects a real 20mV pulse
into its PAM11 dopamine cells (the same magnitude `experiments/fly-wirehead`
uses) — so those three moments both trigger the real reward circuitry *and*
show up as a live PAM11 Hz readout / glowing gauge in the page. She's also
present in the world from tick one instead of `heaven.world`'s scripted
125-second wait.

**Heaven's love life:** a male isn't mated for good — `HeavenBehavior` lets him
court again 5 simulated seconds after dismounting, and whether he does is still
P1's calibrated threshold on contact. Two web-only tweaks make that contact
reachable. First, `food_world.py` delivers the sustained foreleg female current
as the same 0.3 s-in-1 s pulse train calibration probed P1 with (`heaven.world`
leaves it un-pulsed only because the film's tapping is brief, but here the male
can hold contact for tens of seconds). Second, `fly_worker.py` starts her next
to the fly's own food instead of at `heaven.world`'s two fixed spots, both of
which sit deep in cold shade a male turns back from before reaching her. An
earlier attempt instead flattened heaven's 17-34 °C weather to a fully
comfortable 23-27 °C; headless measurement showed that removed the thermal
drive P1 needs to respond at all — the male then held uninterrupted contact yet
never courted, and reward fell to feeding alone (~8%). So heaven's weather is
used unmodified.

**Multiple flies:** the checkboxes in the page (up to `MAX_FLIES`, default 4)
each spawn or kill one full brain process. Each fly gets its own independent
world (and, once she's found, her own female) sharing the one visible
clearing.

## Run it

```sh
web/server/setup_data.sh          # first time only — links the prepared MaleCNS graph
web/tools/build_housefly.sh       # first time only — builds assets/housefly.glb
web/tools/build_food_pack.sh      # first time only — builds the local food variants
uv run python web/server/app.py   # serves the page + API on :8934
```

Opens `http://localhost:8934/` automatically. Needs WebGL 2, a C++17
compiler (for the kernel's one-time build), and the ~1.1GB MaleCNS graph
prepared per the top-level README (`fly-heaven.ipynb` sections 0 and 2.1) —
`setup_data.sh` looks for an already-prepared copy first (e.g. a sibling
project that ran the same notebook) before asking you to run it.

**This machine's real-time factor is ~0.25-0.3x** (measured: ~150-300ms of
wall time per 50ms of simulated neural time — the compiled kernel doesn't
release Python's GIL, which is also why each fly is its own OS process, not
a thread). A fly's subjective time runs slower than the wall clock; the
browser smooths the resulting sparse updates into 60fps motion rather than
faking a faster clock. `fly_worker.py`'s `_speed_up_bouts()` shortens
`heaven.behaviour`'s held-bout durations (SING, MATE, GROOM, THERMOREGULATE)
for exactly this reason — documented there. Along with the remating,
female-contact and female-placement changes above, these are the web's only
deliberate departures from heaven's world and pacing; no neural threshold or
readout is changed.

## Public demo

<https://demo.aanandagiri.com.np/fly-heaven/> serves this app from two machines,
the way [fly-chess](https://github.com/Aananda-giri/fly-chess) does:

- **The laptop** (preferred; 16 cores, up to 4 flies) runs this checkout via
  `deploy/laptop/fly-heaven-laptop.service` on 127.0.0.1:8935, reached through
  the `laptop-demos` tunnel as `demo-gpu.aanandagiri.com.np`.
- **lucy** (always on; 4 cores, 1 fly) runs a trimmed copy — code, built assets
  and the three connectome files a brain reads — shipped by
  `scripts/deploy_home_server.sh` and served by `deploy/fly-heaven.service` on
  127.0.0.1:8934 through the `lucy-demos` tunnel as `demo-cpu.aanandagiri.com.np`.
  Re-run the script after changing code or assets.
- **`deploy/router`** is the Worker on `demo.aanandagiri.com.np/fly-heaven*`.
  Flies live on one server, so a page stays with whichever server answered its
  page load (a cookie) and moves to lucy only when the laptop stops answering;
  the page then renews its session token and starts over there. Deploy it with
  the command in `deploy/router/wrangler.jsonc`.

The tunnels' `^/fly-heaven` routes are configured in Cloudflare, not in this
repo. Both services pass `--base-path /fly-heaven`, their public host and
origin, and `--idle-stop 120`, which stops every fly two minutes after the last
page stops polling. The server still binds only to 127.0.0.1 and never serves
`web/server/`, `web/tests/`, `.py`/`.sh` files, directory listings, or the
BlenderKit `.blend`. Every visitor to a server sees, and can add or remove, the
same flies.

## Layout

- `index.html` / `main.js` — page shell, renderer, camera, server polling,
  fly-pair pooling (clones one loaded glTF via `SkeletonUtils` rather than
  refetching per fly), UI (checkboxes, dopamine gauge, status line).
- `forest.js` — ground, grass, rocks, twigs, leaves, sky/fog, plus the fruit
  and sunbeam props placed at `heaven.world`'s real `FRUIT_POS`/`SUNBEAM_POS`.
  Sized to comfortably hold `heaven.world.CLEARING`'s real 1.2×0.8m extent.
  Scenery is generated on `<canvas>` or as procedural geometry; six food
  variants come from the supplied Blender pack. `food-layout.json` shares
  placements with the worker and clears scenery from the food sites.
- `brain-view.js` / `brain-data.js` — a separate, rotatable Three.js soma atlas,
  full-population spike-frame decoding, circuit highlights and annotated
  population averages. A scan sweep is a display effect.
- `heaven-coords.js` — the one shared mapping from `heaven.world`'s (x, y)
  meter frame to this scene's XZ ground plane.
- `fly.js` — `FlyRig`: a puppet, not a brain. Turns a server-reported pose
  name (`walk`, `feed`, `bask_belly_up`, `sing`, `mate`, ...) into bone
  rotations, smoothing the server's sparse ticks into continuous motion.
  Bone names use Three.js's glTF sanitization and match bones rather than
  same-named mesh parts. Feet use a short CCD solve to hold ground contacts;
  gait phase follows distance traveled and stops when the fly stops.
- `navigation.js` — body clearance, clearing boundaries, and swept movement
  around rocks, twig capsules, leaves, and individual berries. Dense grass
  stays outside the full simulated walking area. These are visual corrections
  to the point-agent world; they do not alter neural behavior decisions.
- `web/server/food_world.py` — web-only nearest-food selection and sensory
  contact ranges, using the unchanged heaven behavior thresholds. Each brain
  process owns its selected food position.
- `web/server/fly_worker.py` — one fly, one process: runs the real closed
  loop forever, writes its latest tick as JSON.
- `web/server/app.py` — stdlib-only local HTTP server (modeled on
  `experiments/fly-wirehead`'s own): serves `web/` as static files, spawns/
  reaps fly-worker processes, and answers `GET /api/flies`.
- `web/server/setup_data.sh` — links `data/fly-wirehead` and
  `runs/fly-heaven/calibration.json` from wherever they're already prepared.
- `vendor/` — Three.js 0.180.0 + GLTFLoader/DRACOLoader/OrbitControls/
  SkeletonUtils + the Draco decoder, vendored locally (see `THIRD_PARTY.md`).
- `tools/build_housefly.sh` + `tools/export_housefly.py` — rebuild
  `assets/housefly.glb` from the BlenderKit source (76MB → ~4.3MB via
  `gltf-transform`, keeping the node hierarchy intact so bones stay
  addressable by name).
- `assets/`, `data/`, `runs/` — all gitignored; regenerated by the scripts
  above rather than committed (`assets/blenderkit-housefly` is BlenderKit
  Royalty Free material, kept local per `THIRD_PARTY.md`).

## Check the visible poses

Open `http://localhost:8934/tools/pose-preview.html` with the server running.
The pose selector previews feeding, quiet resting, belly-up basking, grooming,
one-wing song, mounting, walking, and flight using the production rig. This
preview does not start or alter a brain process. A stationary walking preview
holds its feet still; the live gait runs only when the body travels.

```sh
node --test web/tests/*.test.mjs
uv run python -m pytest -q tests
```

The fly keeps the source mesh and textures with a less reflective chitin
finish and translucent, double-sided wings. A feeding fly faces its food and
dabs an extended proboscis onto the food's actual mesh surface, keeping its
eyes out of it. Courtship keeps bodies apart; mating aligns the male behind and above the female with legs
gripping her thorax and flanks. Pose transitions blend body rotation and foot
targets, including a roll around the thorax for belly-up resting.

The camera starts close enough to see the flies and follows by translating
both its position and orbit target, preserving the user's viewing distance.
`MAX_FLIES` (in `web/server/app.py`) remains a CPU/memory cap (~525MB and
~150-300ms/tick per brain on this machine).

## Live brain anatomy

The brain panel shows real annotated soma locations from
[MaleCNS v1.0](https://male-cns.janelia.org/download/), in the same neuron order
as the live kernel. The full simulation contains 166,700 neurons; 139,662 have
soma coordinates and appear in the atlas (124,296 in the brain crop). Cells
without coordinates remain in the simulation and population averages.

Use **Expand** for a large view, drag to rotate, scroll to zoom, and choose
**Brain + nerve cord** to see the complete available CNS anatomy. The fly
selector follows an independent brain. Circuit selection highlights the real
annotated PAM11, P1, MN9, pIP10, grooming, steering, escape or motor cells;
motor selection also opens the nerve-cord view. The group buttons isolate
source superclass populations, rather than claiming detailed neuropil masks.

Workers write `activity.bin` atomically after every neural tick. The separate
`GET /api/flies/<id>/activity` endpoint serves a 16-byte header (FHB1 magic,
tick, neuron count, simulated duration) and little-endian uint16 spike counts.
Only the selected fly's full stream is polled. Glow blends snapshots; group
Hz is computed from spike counts, population size, and simulated time.
The scan sweep is decorative, and this is simulated activity on reconstructed
anatomy, rather than an acquired functional scan.

The server exports the atlas automatically if it is missing. To rebuild it:

```sh
uv run python web/tools/export_brain_atlas.py
```

Older running workers can still show their live circuit averages. The full
neuron stream requires the updated server and newly started workers. Existing
history traces remain available under **Activity traces**.

## Imported foods

`tools/build_food_pack.sh` accepts a `.blend` path as its first argument. Its
default is the supplied file in `~/Downloads/heaven/foods-and-fruits-pack-low-poly (2)/source/`.
The export selects six variants, bakes away the source layout, lays banana and
mango flat, normalizes their dimensions, and embeds bounded-size textures.
It writes `assets/food-pack.glb` and size metadata in `assets/food-pack.json`;
both generated files stay local. It never saves over the source `.blend`.

`food-layout.json` places red/green apples, banana, orange, melon and mango
alongside the existing berries. Visible geometry determines collision radii;
exported geometry sizes determine sensory ranges in the worker. Foraging
selects the nearest food and holds that target through a feeding bout. In the
worker, foods are solid: both flies stop at a food's surface and walk around
foods in their way, and sugar contact begins at that surface. Feeding
continues to require MN9 activity and the existing physiology gates. The UI
names the food when the followed fly eats.

The **flight speed** slider changes visual playback from 0.25× to 3×. It
adjusts interpolation, pose cycles, camera follow, and environment motion;
the connectome still advances at fixed 50 ms neural ticks, so the slider does
not alter behavior decisions or neural timing.
