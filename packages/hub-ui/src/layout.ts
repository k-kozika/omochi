import { overlaps, type Panel } from './contracts.js';

/** Place the edited panel first, then push colliding panels down in visual order. */
export function placePanel(panels: Panel[], changed: Panel): Panel[] {
  const placed: Panel[] = [{ ...changed, w: Math.max(1, Math.min(12, changed.w)), h: Math.max(1, changed.h) }];
  placed[0]!.x = Math.max(0, Math.min(12 - placed[0]!.w, changed.x));
  placed[0]!.y = Math.max(0, changed.y);
  for (const panel of panels.filter(p => p.id !== changed.id).sort((a, b) => a.y - b.y || a.x - b.x)) {
    const next = { ...panel };
    let collisions = placed.filter(p => overlaps(p, next));
    while (collisions.length) {
      next.y = Math.max(...collisions.map(p => p.y + p.h));
      collisions = placed.filter(p => overlaps(p, next));
    }
    placed.push(next);
  }
  return placed.sort((a, b) => a.y - b.y || a.x - b.x);
}
