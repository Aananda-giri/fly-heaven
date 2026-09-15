import { CLEARING_W, CLEARING_H } from './heaven-coords.js';

function closestPoint(o, x, z) {
  const vx = o.bx - o.ax, vz = o.bz - o.az;
  const u = Math.max(0, Math.min(1, ((x - o.ax) * vx + (z - o.az) * vz) / (vx * vx + vz * vz || 1)));
  return [o.ax + u * vx, o.az + u * vz];
}

// The brain's world contains point agents. Give the visible bodies clearance
// from scenery, including along interpolated paths between neural snapshots.
export class ForestNavigation {
  constructor() { this.obstacles = []; }

  // An id lets a feeding fly reach into the one food it is eating.
  addCircle(x, z, radius, height, id = null) {
    this.obstacles.push({ ax: x, az: z, bx: x, bz: z, radius, height, id });
  }

  addCapsule(ax, az, bx, bz, radius, height) {
    this.obstacles.push({ ax, az, bx, bz, radius, height, id: null });
  }

  overlaps(x, z, radius, altitude, id) {
    return id !== null && this.obstacles.some(o => {
      if (o.id !== id || altitude > o.height + 0.003) return false;
      const [cx, cz] = closestPoint(o, x, z);
      return Math.hypot(x - cx, z - cz) < o.radius + radius;
    });
  }

  constrain(x, z, radius = 0.012, altitude = 0, ignore = null) {
    const boundX = CLEARING_W / 2 - radius;
    const boundZ = CLEARING_H / 2 - radius;
    for (let pass = 0; pass < 8; pass++) {
      x = Math.max(-boundX, Math.min(boundX, x));
      z = Math.max(-boundZ, Math.min(boundZ, z));
      let changed = false;
      for (const o of this.obstacles) {
        if (altitude > o.height + 0.003 || (ignore !== null && o.id === ignore)) continue;
        const [cx, cz] = closestPoint(o, x, z);
        let dx = x - cx, dz = z - cz;
        const distance = Math.hypot(dx, dz), clearance = o.radius + radius;
        if (distance >= clearance) continue;
        if (distance < 1e-8) { dx = 1; dz = 0; }
        const norm = Math.hypot(dx, dz);
        x = cx + dx / norm * (clearance + 0.0001);
        z = cz + dz / norm * (clearance + 0.0001);
        if (Math.abs(x) > boundX || Math.abs(z) > boundZ) {
          // An obstacle beside the clearing edge must push into the
          // clearing rather than through its boundary.
          const inward = Math.hypot(cx, cz) || 1;
          x = cx - cx / inward * (clearance + 0.0001);
          z = cz - cz / inward * (clearance + 0.0001);
        }
        changed = true;
      }
      if (!changed) break;
    }
    return [x, z];
  }

  move(fromX, fromZ, toX, toZ, radius, altitude, ignore = null) {
    const steps = Math.max(1, Math.ceil(Math.hypot(toX - fromX, toZ - fromZ) / 0.002));
    const dx = (toX - fromX) / steps, dz = (toZ - fromZ) / steps;
    let x = fromX, z = fromZ;
    for (let i = 0; i < steps; i++) {
      let [nextX, nextZ] = this.constrain(x + dx, z + dz, radius, altitude, ignore);
      if (Math.hypot(nextX - x, nextZ - z) < Math.hypot(dx, dz) * 0.15) {
        // A direct approach to an obstacle's center has no natural slide
        // direction. Pick a consistent tangent so the fly keeps walking.
        [nextX, nextZ] = this.constrain(x + dx - dz, z + dz + dx, radius, altitude, ignore);
      }
      x = nextX; z = nextZ;
    }
    return [x, z];
  }
}
