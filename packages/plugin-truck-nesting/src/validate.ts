import type { NestResult, PlacedItem, ValidationFinding } from "./types";

const EPS = 1e-6;

function overlapsY(a: PlacedItem, b: PlacedItem): boolean {
  return a.y < b.y + b.width - EPS && b.y < a.y + a.width - EPS;
}

function rectsOverlap(a: PlacedItem, b: PlacedItem): boolean {
  return a.x < b.x + b.length - EPS && b.x < a.x + a.length - EPS && overlapsY(a, b);
}

/**
 * The validation pass: overlap, overhang (doesn't fit),
 * blocked-access, and a coarse weight-distribution check. Overlap and
 * blocked-access should never fire against `nestTruck`'s own output — the
 * zone/shelf construction rules them out by design — so they're kept here
 * as the self-check that starts paying off the moment anything (a future
 * drag-to-renest) can move a placed item independently of its band.
 */
export function validateNest(result: NestResult): ValidationFinding[] {
  const { trailer, placed, unplaced } = result;
  const findings: ValidationFinding[] = [];

  for (const u of unplaced) {
    findings.push({ level: "error", message: `${u.count}× "${u.label}" ${u.reason} — not placed.` });
  }

  if (result.usedLength > trailer.length + EPS) {
    const shortBy = Math.ceil(result.usedLength - trailer.length);
    findings.push({
      level: "error",
      message: `Load doesn't fit: needs ${shortBy} mm more trailer length than "${trailer.name}" has (${trailer.length} mm).`,
    });
  }

  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      if (rectsOverlap(placed[i], placed[j])) {
        findings.push({ level: "error", message: `"${placed[i].label}" and "${placed[j].label}" overlap.` });
      }
    }
  }

  for (const a of placed) {
    for (const b of placed) {
      if (b.stop <= a.stop) continue;
      if (!overlapsY(a, b)) continue;
      if (b.x < a.x - EPS) {
        findings.push({
          level: "error",
          message: `"${b.label}" (stop ${b.stop}) blocks "${a.label}" (stop ${a.stop}) from reaching the door.`,
        });
      }
    }
  }

  if (placed.length > 0) {
    const midpoint = trailer.length / 2;
    let front = 0;
    let rear = 0;
    for (const p of placed) {
      const center = p.x + p.length / 2;
      if (center < midpoint) front += p.weightKg;
      else rear += p.weightKg;
    }
    const total = front + rear;
    if (total > 0) {
      const frontPct = (front / total) * 100;
      const rearPct = (rear / total) * 100;
      if (frontPct > 65 || rearPct > 65) {
        findings.push({
          level: "warn",
          message: `Weight is lopsided: ${frontPct.toFixed(0)}% door-half / ${rearPct.toFixed(0)}% nose-half. This is a floor-position estimate, not an axle-load calculation.`,
        });
      }
      if (trailer.maxWeightKg !== undefined && total > trailer.maxWeightKg + EPS) {
        findings.push({
          level: "error",
          message: `Total load ${Math.round(total)} kg exceeds ${trailer.name}'s ${trailer.maxWeightKg} kg limit.`,
        });
      }
    }
  }

  if (findings.length === 0) findings.push({ level: "info", message: "No issues found." });
  return findings;
}
