"""One fly, one process: runs heaven's real closed loop (world -> brain ->
behaviour -> world) forever and publishes its latest tick as JSON.

Why a whole OS process per fly rather than a thread: the compiled connectome
kernel does not release Python's GIL during a step (measured — two brains
stepped from two threads took ~2x one brain's solo time, not ~1x), so
concurrent flies only get real parallelism across separate processes.

Why not paced to wall-clock 50 ms ticks: measured throughput on this machine
is ~140-210 ms of wall time per 50 ms of simulated neural time (i.e. a fly
lives at roughly 0.25-0.3x real time). The loop just runs ticks back to back;
the browser interpolates between the arriving snapshots. The neural gating
itself (heaven.brain, heaven.behaviour's thresholds) is untouched — see
`_speed_up_bouts` and `HeavenBehavior` below for the deliberate, documented
departures from heaven's own pacing.
"""

import argparse
import json
import sys
import struct
import time
import traceback
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from heaven import world as W  # noqa: E402
from heaven.behaviour import FlyBehavior, load_thresholds  # noqa: E402
from heaven.brain import SILENCE_MV, TICK_MS, ConnectomeBrain  # noqa: E402
from food_world import FoodWorld  # noqa: E402

DT = TICK_MS / 1000.0
REWARD_MV = 20.0  # matches experiments/fly-wirehead's PAM11_CURRENT_MV
# Activities that count as an "infinite dopamine" moment: the reward current
# (see `step_with_reward`) is injected into PAM11 on the tick right after the
# behaviour layer reports the fly is doing one of these.
REWARD_STATES = {
    ("FEED", None),
    ("BASK", "belly_up"),  # keyed off pose, not subphase — see main loop
    ("COURT", "SING"),
    ("COURT", "ATTEMPT"),
    ("COURT", "MATE"),
    ("COURT", "DISMOUNT"),
}
REMATE_S = 5.0  # simulated seconds after dismounting before a male may court again (see HeavenBehavior)


def atomic_json(path, data):
    tmp = path.with_suffix(".json.partial")
    tmp.write_text(json.dumps(data, allow_nan=False))
    tmp.replace(path)


def step_with_reward(brain, frame, currents, reward_mv, ms=TICK_MS):
    """heaven.brain.ConnectomeBrain.step, plus an optional PAM11 reward pulse.

    Duplicates step()'s body rather than editing heaven/brain.py (kept
    unmodified, per this repo's convention of calling each project's own
    simulation code as-is) — the extra branch is the only difference.
    """
    pulses = [(brain.senses[k], float(v)) for k, v in currents.items() if k in brain.senses and v]
    pulses += [(ix, SILENCE_MV) for ix in brain.silenced.values()]
    if reward_mv:
        pulses.append((brain.readouts["PAM11"], float(reward_mv)))
    counts, _ = brain.brain.rgb_step(frame, ms, learning=False, stimulation=pulses or None)
    brain.latest_spike_counts = counts
    seconds = ms / 1000
    rates = {k: float(counts[ix].sum() / (len(ix) * seconds)) for k, ix in brain.readouts.items()}
    rates["network_spikes"] = int(counts.sum())
    return rates


def _speed_up_bouts():
    """Shorten heaven.behaviour's held-bout durations for a live demo.

    heaven.behaviour's own timings (SING up to 45 simulated seconds, MATE 14,
    ...) are tuned for an offline film, not a page someone is watching live.
    At this machine's ~0.25-0.3x real-time factor, those durations alone —
    before any wandering/waiting — would add HOURS of real wall-clock time to
    reach a full courtship. Nothing about *whether or when* a behaviour is
    entered changes (that's still gated by the real brain's thresholds,
    unmodified); only how long an already-entered bout is held.
    """
    import heaven.behaviour as beh

    beh.SING_TIMEOUT_S = 8.0
    beh.MATE_S = 6.0
    beh.MAX_GROOM_S = 6.0
    beh.MAX_THERMO_S = 12.0
    beh.MAX_FRUIT_WAIT_S = 4.0


class HeavenBehavior(FlyBehavior):
    """heaven.behaviour.FlyBehavior, except mating isn't once in a lifetime.

    heaven.behaviour sets `has_mated` for good at the end of MATE, so a male
    that has mated never courts again — measured headless, that fly then
    went the rest of the run with its reward current off. Here it clears
    REMATE_S simulated seconds after he dismounts. Whether he then courts
    again is still P1 clearing its calibrated threshold on contact.
    """

    since_mated = 0.0

    def tick(self, raw_rates, dt, snapshot):
        if self.has_mated and self.state != "COURT":
            self.since_mated += dt
            if self.since_mated >= REMATE_S:
                self.has_mated, self.since_mated = False, 0.0
        return super().tick(raw_rates, dt, snapshot)


def run(fly_id, out_dir, seed):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    latest = out_dir / "latest.json"
    atomic_json(latest, {"id": fly_id, "status": "loading", "message": "waking the connectome…"})

    try:
        _speed_up_bouts()
        thresholds = load_thresholds()
        brain = ConnectomeBrain()
        world = FoodWorld(seed=seed, hunger_start=0.35)
        # Infinite dopamine's other half: she's here from tick one, not after
        # heaven.world's scripted 125 simulated-second wait. She starts next to
        # the fly's own food (which FoodWorld just selected as W.FRUIT_POS) and
        # forages there, because heaven.world's two fixed female spots are both
        # deep in cold shade: a male walking to either one thermoregulates the
        # whole way and turns back before he ever reaches her, so odd-seeded
        # flies never courted at all (measured headless). Contact is still
        # P1-gated like heaven's own film; only her starting point moved.
        world.female_present = True
        world.female.pos = world.fly.pos + np.array([0.0, 0.03])
        behavior = HeavenBehavior(thresholds=thresholds, seed=seed)

        atomic_json(latest, {"id": fly_id, "status": "ready", "message": "ready"})
        print(f"[fly {fly_id}] brain ready: {brain.brain.n:,} neurons", flush=True)

        reward_mv = 0.0
        tick = 0
        while True:
            step_started = time.perf_counter()
            currents = world.sense(DT)
            frame = world.retina_frame()
            rates = step_with_reward(brain, frame, currents, reward_mv)
            snapshot = world.snapshot()
            action = behavior.tick(rates, DT, snapshot)
            world.act(DT, action)
            tick_ms_wall = (time.perf_counter() - step_started) * 1000

            key = (action["state"], "belly_up" if action["pose"] == "bask_belly_up" else action.get("subphase"))
            reward_active = key in REWARD_STATES
            reward_mv = REWARD_MV if reward_active else 0.0

            # Full-population activity, kept out of the lightweight swarm JSON.
            # Atlas indices use the kernel's neuron order. Header carries the
            # tick and duration so a viewer never mistakes display decay for Hz.
            counts = np.clip(brain.latest_spike_counts, 0, 65535).astype('<u2')
            activity_tmp = out_dir / 'activity.bin.partial'
            activity_tmp.write_bytes(struct.pack('<4sIIf', b'FHB1', tick, len(counts), TICK_MS) + counts.tobytes())
            activity_tmp.replace(out_dir / 'activity.bin')
            state = {
                "id": fly_id,
                "status": "ready",
                "tick": tick,
                "activity_available": True,
                "t": round(snapshot["t"], 3),
                "state": action["state"],
                "subphase": action["subphase"],
                "pose": action["pose"],
                "flying": action["flying"],
                "feeding": action["feeding"],
                "food_target": world.food_target,
                "grooming": action["grooming"],
                "wing_song": action["wing_song"],
                "proboscis": action["proboscis"],
                "turn_bias": action["turn_bias"],
                "male": {
                    "x": snapshot["fly_x"], "y": snapshot["fly_y"],
                    "heading": snapshot["fly_heading"], "altitude": snapshot["fly_altitude"],
                },
                "female": {
                    "present": snapshot["female_present"],
                    "x": snapshot["female_x"], "y": snapshot["female_y"],
                },
                "satiety": snapshot["satiety"],
                "temperature_c": snapshot["temperature_c"],
                "dust": snapshot["dust"],
                "rates": {k: round(v, 2) for k, v in rates.items()},
                "reward_active": reward_active,
                "tick_ms_wall": round(tick_ms_wall, 1),
            }
            atomic_json(latest, state)
            tick += 1
    except Exception as error:  # noqa: BLE001 — report, don't crash silently
        atomic_json(latest, {
            "id": fly_id, "status": "error",
            "message": f"{type(error).__name__}: {error}",
            "traceback": traceback.format_exc(),
        })
        print(f"[fly {fly_id}] error: {error}", flush=True)
        raise


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--id", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--seed", type=int, default=0)
    args = p.parse_args()
    run(args.id, args.out, args.seed)
