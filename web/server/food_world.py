"""Web-only food placements shared with the renderer, using heaven's world.

Foraging and sensory geometry are scripted as before. Feeding continues to
require the unchanged MN9 neural threshold; no food animation forces a state.
Each worker owns a process, so its selected W.FRUIT_POS is isolated.

heaven.world's fruit is a point the fly walks onto. These foods are solid
props, so bodies stop at a food's surface and walk around foods in their way,
and gustatory contact begins at that surface rather than centimetres short.
"""
import json
from pathlib import Path

import numpy as np
from heaven import world as W

# web/fly.js FlyRig.radius (0.012 x scale); the female is drawn at 1.08.
MALE_BODY_RADIUS = 0.012
FEMALE_BODY_RADIUS = 0.012 * 1.08
CONTACT_REACH = 0.003  # tarsi and proboscis touch just past the body clearance
SLIDE_FRACTION = 0.15  # a step blocked below this share walks around the food


class FoodWorld(W.World):
    def __init__(self, seed=0, hunger_start=0.35, foods=None):
        super().__init__(seed=seed, hunger_start=hunger_start)
        self.foods = foods if foods is not None else json.loads((Path(__file__).resolve().parents[1] / 'food-layout.json').read_text())
        metadata_path = Path(__file__).resolve().parents[1] / 'assets/food-pack.json'
        if metadata_path.exists():
            metadata = json.loads(metadata_path.read_text())
            self.foods = [dict(food) for food in self.foods]
            for food in self.foods:
                shape = metadata.get(food.get('model'))
                if shape:
                    food['radius'] = shape['radius'] * food['size']
                    food['height'] = shape['height'] * food['size']
        if not self.foods:
            raise ValueError('At least one food placement is required')
        # Start each new fly touching a different food item. This makes the
        # clearing readable immediately while the brain begins its own loop.
        spawn_food = self.foods[seed % len(self.foods)]
        side = -1 if seed % 2 else 1
        center = np.array([spawn_food['x'], spawn_food['y']])
        direction = np.array([side * 0.018, 0.012]) / np.hypot(0.018, 0.012)
        spawn = center + direction * (spawn_food['radius'] + MALE_BODY_RADIUS + CONTACT_REACH / 2)
        spawn = np.clip(spawn, 0.025, [1.175, 0.775])
        self.fly.pos = self._clear_foods(spawn, spawn, MALE_BODY_RADIUS, 0.0, None)
        self.food_target = None
        self._feeding = False
        # heaven.world only leaves the foreleg female contact un-pulsed because the
        # film's tapping is brief and self-limiting. Once the male can hold contact
        # for tens of seconds (which he does here, walking at her until P1 lets him
        # court), that sustained current distorts the recurrent network exactly as
        # the other held senses would, and P1 goes silent instead of crossing. Use
        # the same 0.3 s pulse train calibration probed P1 with.
        self._on_time["female"] = 0.0
        self._select_food()

    def _currents(self, dt):
        currents = super()._currents(dt)
        currents["female"] = self._pulse("female", currents["female"], dt)
        return currents

    def _select_food(self):
        if self._feeding and self.food_target is not None:
            return
        food = min(self.foods, key=lambda f: np.linalg.norm(self.fly.pos - [f['x'], f['y']]) - f['radius'])
        self.food_target = {key: food[key] for key in ('id', 'name', 'x', 'y')}
        W.FRUIT_POS = np.array([food['x'], food['y']], dtype=float)
        # Sugar is a contact sense: it starts where the body meets the food.
        W.FRUIT_RADIUS = food['radius'] + MALE_BODY_RADIUS + CONTACT_REACH

    def _clear_foods(self, before, after, body_radius, altitude, target):
        """Keep a walking body outside every food. A body headed into a food
        has arrived and stops at its surface; one passing it walks around."""
        pos = np.array(after, dtype=float)
        step = pos - before
        for food in self.foods:
            if altitude >= food.get('height', np.inf):
                continue
            center = np.array([food['x'], food['y']])
            clearance = food['radius'] + body_radius
            offset = pos - center
            distance = np.linalg.norm(offset)
            if distance >= clearance:
                continue
            if distance < 1e-9:
                offset = before - center
                distance = np.linalg.norm(offset)
                if distance < 1e-9:
                    offset, distance = np.array([1.0, 0.0]), 1.0
            radial = offset / distance
            pos = center + radial * clearance
            arriving = target is not None and np.linalg.norm(np.asarray(target) - center) < clearance
            if arriving or np.linalg.norm(pos - before) >= SLIDE_FRACTION * np.linalg.norm(step):
                continue
            # A head-on approach has no natural slide direction. Walk around
            # the food on a consistent side instead of pressing into it.
            tangent = np.array([-radial[1], radial[0]])
            if tangent @ step < 0:
                tangent = -tangent
            around = before + tangent * np.linalg.norm(step) - center
            pos = center + around / np.linalg.norm(around) * clearance
        return pos

    def sense(self, dt):
        self._select_food()
        return super().sense(dt)

    def act(self, dt, action):
        self._feeding = action.get('feeding', False)
        before = self.fly.pos.copy()
        result = super().act(dt, action)
        target = None if action.get('flying') else action.get('target_pos')
        self.fly.pos = self._clear_foods(before, self.fly.pos, MALE_BODY_RADIUS, self.fly.altitude, target)
        return result

    def _female_wander(self, dt, holding_still):
        before = self.female.pos.copy()
        super()._female_wander(dt, holding_still)
        if self.female_present:
            # She forages around the selected food, so she waits at its surface.
            self.female.pos = self._clear_foods(before, self.female.pos, FEMALE_BODY_RADIUS, 0.0, W.FRUIT_POS)
