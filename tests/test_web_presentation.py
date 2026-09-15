"""Checks for aligning the web presentation with real anatomy and food geometry."""
import numpy as np
import pyarrow as pa
import pyarrow.feather as feather
import pytest

from heaven import world as W
from web.server.food_world import FEMALE_BODY_RADIUS, MALE_BODY_RADIUS, FoodWorld
from web.tools.export_brain_atlas import export_atlas


def test_atlas_keeps_kernel_order_and_omits_only_missing_somas(tmp_path):
    data, out = tmp_path / 'data', tmp_path / 'out'
    data.mkdir()
    np.savez(data / 'graph.npz', ids=np.array([30, 10, 20]))
    feather.write_feather(pa.Table.from_pylist([
        {'bodyId': 10, 'type': 'MN9', 'somaSide': 'L', 'superclass': 'vnc_motor', 'somaLocation': None},
        {'bodyId': 20, 'type': 'PAM11', 'somaSide': 'R', 'superclass': 'cb_intrinsic', 'somaLocation': [30, 40, 50]},
        {'bodyId': 30, 'type': 'DNp01', 'somaSide': 'L', 'superclass': 'descending_neuron', 'somaLocation': [10, 20, 30]},
    ]), data / 'annotations.feather')
    atlas = export_atlas(data, out)
    assert atlas['neurons'] == 3 and atlas['missing'] == 1
    assert np.fromfile(out / 'indices.u32', dtype='<u4').tolist() == [0, 2]
    assert np.fromfile(out / 'positions.f32', dtype='<f4').reshape(-1, 3).tolist() == [[10, 20, 30], [30, 40, 50]]
    assert atlas['circuits']['MN9'] == [1]  # still in the simulation/readout
    assert atlas['circuits']['PAM11'] == [2]
    assert np.fromfile(out / 'regions.u8', dtype='u1').tolist() == [3, 5, 1]


@pytest.fixture
def food_world(monkeypatch):
    # World constants are isolated per real worker; restore them in tests.
    monkeypatch.setattr(W, 'FRUIT_POS', W.FRUIT_POS.copy())
    monkeypatch.setattr(W, 'FRUIT_RADIUS', W.FRUIT_RADIUS)
    return FoodWorld(foods=[
        {'id': 'a', 'name': 'Apple', 'x': 0.1, 'y': 0.1, 'radius': 0.025},
        {'id': 'b', 'name': 'Banana', 'x': 0.8, 'y': 0.6, 'radius': 0.06},
    ])


def walk(world, target, ticks, **action):
    for _ in range(ticks):
        world.sense(0.05)
        world.act(0.05, {'state': 'EXPLORE', 'subphase': None, 'target_pos': target, 'speed': 0.05, **action})
        yield world.fly.pos


def test_foraging_and_sugar_contact_follow_the_nearest_visible_food(food_world):
    world = food_world
    world.fly.pos = np.array([0.8 + 0.06 + MALE_BODY_RADIUS, 0.6])
    world.sense(0.05)
    assert world.food_target['id'] == 'b'
    assert np.allclose(W.FRUIT_POS, [0.8, 0.6])
    assert world.snapshot()['near_fruit']
    assert world._last_currents['sugar'] > 0
    assert W.FRUIT_RADIUS == pytest.approx(0.06 + MALE_BODY_RADIUS + 0.003)
    world.fly.pos = np.array([0.4, 0.35])
    world.sense(0.05)
    assert not world.snapshot()['near_fruit']
    assert world._last_currents['sugar'] == 0


def test_sugar_contact_starts_at_the_food_surface(food_world):
    world = food_world
    world.fly.pos = np.array([0.1 + 0.025 + MALE_BODY_RADIUS + 0.002, 0.1])
    world.sense(0.05)
    assert world.snapshot()['near_fruit']
    world.fly.pos = np.array([0.1 + 0.045, 0.1])  # inside heaven's 5 cm fruit range, not touching
    world.sense(0.05)
    assert not world.snapshot()['near_fruit']


def test_food_target_stays_fixed_during_a_feeding_bout(food_world):
    world = food_world
    world._feeding = True
    initial = world.food_target.copy()
    world.fly.pos = np.array([0.8, 0.6])
    world.sense(0.05)
    assert world.food_target == initial
    world._feeding = False
    world.sense(0.05)
    assert world.food_target['id'] == 'b'


def test_feeding_holds_the_body_against_the_food_surface(food_world):
    world = food_world
    world.fly.pos = np.array([0.2, 0.1])
    for pos in walk(world, W.FRUIT_POS, 200, state='FEED', feeding=True):
        assert np.linalg.norm(pos - [0.1, 0.1]) >= 0.025 + MALE_BODY_RADIUS - 1e-9
    assert np.linalg.norm(world.fly.pos - [0.1, 0.1]) == pytest.approx(0.025 + MALE_BODY_RADIUS)
    assert world.fly.pos[1] == pytest.approx(0.1)  # no drifting around the food
    assert world.snapshot()['near_fruit']


def test_a_body_passing_a_food_walks_around_it(food_world):
    world = food_world
    world.fly.pos = np.array([0.03, 0.1])
    target = np.array([0.2, 0.1])  # directly behind the apple's center
    for pos in walk(world, target, 400):
        assert np.linalg.norm(pos - [0.1, 0.1]) >= 0.025 + MALE_BODY_RADIUS - 1e-9
    assert np.linalg.norm(world.fly.pos - target) < 1e-3


def test_the_female_waits_outside_the_food(food_world):
    world = food_world
    world.female_present = True
    world.female.pos = np.array([0.3, 0.1])
    for _ in range(300):
        world._female_wander(0.05, holding_still=False)
        assert np.linalg.norm(world.female.pos - [0.1, 0.1]) >= 0.025 + FEMALE_BODY_RADIUS - 1e-9


def test_spawn_slots_start_touching_different_foods():
    import json
    from pathlib import Path

    foods = json.loads((Path(__file__).parents[1] / 'web/food-layout.json').read_text())
    for seed in range(6):
        world = FoodWorld(seed=seed, foods=foods)
        world.sense(0.05)
        food = world.foods[seed % len(foods)]
        distance = np.linalg.norm(world.fly.pos - [food['x'], food['y']])
        assert food['radius'] + MALE_BODY_RADIUS <= distance < W.FRUIT_RADIUS
        assert world.food_target['id'] == food['id'] and world.snapshot()['near_fruit']


@pytest.fixture
def worker(monkeypatch):
    from pathlib import Path

    monkeypatch.syspath_prepend(str(Path(__file__).parents[1] / 'web/server'))
    from web.server import fly_worker
    return fly_worker


def test_sustained_female_contact_is_delivered_as_calibrations_pulse_train(food_world):
    # heaven.world only leaves the female contact un-pulsed because the film's
    # tapping is brief. Here the male can hold contact for seconds at a time, so
    # FoodWorld delivers it as the 0.3 s-in-1 s train calibration probed P1 with;
    # a sustained 20 mV would otherwise drive the network into the same distorted
    # state the other held senses are duty-cycled to avoid.
    world = food_world
    world.female_present = True
    world.female.pos = world.fly.pos + 0.001
    contacts = []
    for _ in range(40):  # 2 simulated seconds
        world.sense(0.05)
        contacts.append(world._last_currents['female'])
    assert max(contacts) > 0 and 0.0 in contacts  # pulsed, not sustained
    assert sum(v > 0 for v in contacts) == pytest.approx(0.3 * len(contacts), abs=2)


def test_a_mated_male_may_court_again_after_his_refractory_period(worker):
    thresholds = {'MN9': 5.0, 'DNg12': 5.0, 'GF': 20.0, 'MDN': 5.0, 'P1': 3.0, 'pIP10': 3.0}
    behavior = worker.HeavenBehavior(thresholds=thresholds, seed=0)
    behavior.has_mated = True
    world = W.World(seed=0)
    world.female_present = True
    rates = dict.fromkeys(['MN9', 'DNg12', 'GF', 'P1', 'pIP10', 'MDN', 'motor', 'DNa02_L', 'DNa02_R'], 0.0)
    ticks = 0
    while behavior.has_mated:
        behavior.tick(rates, 0.05, world.snapshot())
        ticks += 1
        assert ticks <= 200
    expected = round(worker.REMATE_S / 0.05)
    assert ticks in (expected, expected + 1)  # float accumulation may cost one tick


def test_dopamine_covers_every_courtship_stage_from_song_onward(worker):
    assert {('COURT', sub) for sub in ('SING', 'ATTEMPT', 'MATE', 'DISMOUNT')} <= worker.REWARD_STATES
