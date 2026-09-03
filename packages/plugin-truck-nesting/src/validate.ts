import type { NestResult, PlacedItem, ValidationFinding } from "./types";

const EPS = 1e-6;

function overlapsY(a: PlacedItem, b: PlacedItem): boolean {
  return a.y < b.y + b.width - EPS && b.y < a.y + a.width - EPS;
}

function rectsOverlap(a: PlacedItem, b: PlacedItem): boolean {
  return a.x < b.x + b.length - EPS && b.x < a.x + a.length - EPS && overlapsY(a, b);
}

/**
 * Sanity-checks a nest result: pallets that didn't fit, a load longer than the
 * trailer, pallets overlapping, and the load-order rule — no later drop parked
 * between an earlier drop and the door. Overlap and blocked-access shouldn't
 * fire against `nestByOrders`'s own output (the banding rules them out), so they
 * pay off the moment anything can move a pallet independently of its band.
 */
export function validateNest(result: NestResult): ValidationFinding[] {
  const { trailer, placed, unplaced } = result;
  const findings: ValidationFinding[] = [];

  for (const u of unplaced) {
    findings.push({ level: "error", message: `${u.count} pallet${u.count === 1 ? "" : "s"} for ${u.city || "an order"} ${u.reason} — not placed.` });
  }

  if (result.usedLength > trailer.length + EPS) {
    const shortBy = Math.ceil(result.usedLength - trailer.length);
    findings.push({
      level: "error",
      message: `Load doesn't fit: needs ${shortBy} mm more length than "${trailer.name}" has (${trailer.length} mm).`,
    });
  }

  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      if (rectsOverlap(placed[i], placed[j])) {
        findings.push({ level: "error", message: `Pallets for ${placed[i].city || "?"} and ${placed[j].city || "?"} overlap.` });
      }
    }
  }

  for (const a of placed) {
    for (const b of placed) {
      if (b.orderIndex <= a.orderIndex) continue;
      if (!overlapsY(a, b)) continue;
      if (b.x < a.x - EPS) {
        findings.push({
          level: "error",
          message: `${b.city || `Drop ${b.orderIndex + 1}`} (unloaded after ${a.city || `drop ${a.orderIndex + 1}`}) blocks it from the door.`,
        });
      }
    }
  }

  const seen = new Set<string>();
  const unique = findings.filter((f) => (seen.has(f.message) ? false : (seen.add(f.message), true)));
  if (unique.length === 0) unique.push({ level: "info", message: "No issues — the plan unloads cleanly." });
  return unique;
}
