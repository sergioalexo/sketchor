import * as THREE from "three";
import type { Bounds3, Model3D } from "./types";

/**
 * three.js plumbing shared by the interactive viewer and the thumbnail
 * renderer, so a card preview and the opened model look the same: one
 * merged mesh with baked vertex colours, one line-segments object for the
 * B-rep edges, a headlight rig, and a CAD-style isometric framing.
 *
 * Z is up. That's the STEP convention (and Onshape's), and it is what the
 * view presets assume.
 */

export const STAGE_BACKGROUND = 0x17181c;
export const EDGE_COLOR = 0x1c1d21;
export const SELECT_COLOR: [number, number, number] = [0x5a, 0x8d, 0xff];

export type ViewPreset = "iso" | "top" | "front" | "right" | "back" | "left" | "bottom";

/** Unit view directions (from the model toward the camera), Z up. */
const VIEW_DIR: Record<ViewPreset, [number, number, number]> = {
  iso: [1, -1, 1],
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  right: [1, 0, 0],
  left: [-1, 0, 0],
};

/** Camera "up" per preset — Z, except when looking straight along Z. */
function viewUp(preset: ViewPreset): THREE.Vector3 {
  if (preset === "top") return new THREE.Vector3(0, 1, 0);
  if (preset === "bottom") return new THREE.Vector3(0, -1, 0);
  return new THREE.Vector3(0, 0, 1);
}

export function viewDirection(preset: ViewPreset): THREE.Vector3 {
  return new THREE.Vector3(...VIEW_DIR[preset]).normalize();
}

export interface ModelObjects {
  group: THREE.Group;
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
  geometry: THREE.BufferGeometry;
  edgeGeometry: THREE.BufferGeometry;
  dispose(): void;
}

/**
 * Builds the renderable objects for a model. The colour attribute is a
 * *copy* of the model's, so selection highlighting can write into it and
 * restore from the model's pristine array.
 */
export function buildModelObjects(model: Model3D): ModelObjects {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(model.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(model.normals, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(model.colors.slice(), 3, true));
  geometry.setIndex(new THREE.BufferAttribute(model.indices, 1));
  geometry.boundingBox = toBox3(model.bounds);
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());

  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    // Push faces back a hair so coplanar edge lines win the depth test.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;

  const edgeGeometry = new THREE.BufferGeometry();
  edgeGeometry.setAttribute("position", new THREE.BufferAttribute(model.edges, 3));
  edgeGeometry.boundingBox = geometry.boundingBox;
  edgeGeometry.boundingSphere = geometry.boundingSphere;
  const edges = new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({ color: EDGE_COLOR }));
  edges.frustumCulled = false;

  const group = new THREE.Group();
  group.add(mesh, edges);
  return {
    group,
    mesh,
    edges,
    geometry,
    edgeGeometry,
    dispose() {
      geometry.dispose();
      edgeGeometry.dispose();
      material.dispose();
      (edges.material as THREE.Material).dispose();
    },
  };
}

/** A headlight rig: soft sky/ground fill plus a key light that follows the camera. */
export function buildLights(camera: THREE.Camera): THREE.Object3D[] {
  const hemi = new THREE.HemisphereLight(0xffffff, 0x666a72, 1.1);
  hemi.position.set(0, 0, 1);
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(0.6, 0.8, 1.2);
  // Parenting the key light *and its target* to the camera makes it a
  // headlight — the model is always lit from where you look, so no view is
  // ever in shadow. (A directional light shines toward its target, which
  // must be in the scene graph to follow the camera.)
  key.target.position.set(0, 0, -1);
  camera.add(key, key.target);
  return [hemi, camera];
}

export function toBox3(b: Bounds3): THREE.Box3 {
  return new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));
}

/**
 * Points an orthographic camera at `bounds` from `preset` and sizes its
 * frustum so the model's projected extent fits with `padding` (fraction of
 * the larger side) to spare. Used for thumbnails and the view presets.
 */
export function frameOrthographic(
  camera: THREE.OrthographicCamera,
  bounds: Bounds3,
  preset: ViewPreset,
  aspect: number,
  padding = 0.08,
): void {
  const box = toBox3(bounds);
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3);
  const dir = viewDirection(preset);
  camera.up.copy(viewUp(preset));
  camera.position.copy(center).addScaledVector(dir, radius * 4);
  camera.lookAt(center);
  camera.updateMatrixWorld();

  // Project the eight corners to find the true screen-space extent — tighter
  // than the bounding sphere, which wastes a third of a thumbnail.
  const view = camera.matrixWorldInverse;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const p = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    p.applyMatrix4(view);
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const w = Math.max(maxX - minX, 1e-3);
  const h = Math.max(maxY - minY, 1e-3);
  const halfW = (Math.max(w, h * aspect) / 2) * (1 + padding);
  const halfH = halfW / aspect;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  camera.left = cx - halfW;
  camera.right = cx + halfW;
  camera.top = cy + halfH;
  camera.bottom = cy - halfH;
  camera.near = 0.01 * radius;
  camera.far = radius * 10;
  camera.updateProjectionMatrix();
}

/**
 * Places a perspective camera to see all of `bounds` — from a preset, or
 * along an explicit unit direction (model → camera) to keep the user's
 * current orbit — and returns the orbit target (the box centre).
 */
export function framePerspective(
  camera: THREE.PerspectiveCamera,
  bounds: Bounds3,
  from: ViewPreset | THREE.Vector3,
): THREE.Vector3 {
  const box = toBox3(bounds);
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3);
  const fov = (camera.fov * Math.PI) / 180;
  const fitH = radius / Math.sin(fov / 2);
  const fitW = radius / Math.sin(Math.atan(Math.tan(fov / 2) * camera.aspect));
  const dist = Math.max(fitH, fitW) * 1.05;
  const dir = from instanceof THREE.Vector3 ? from : viewDirection(from);
  if (!(from instanceof THREE.Vector3)) camera.up.copy(viewUp(from));
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = Math.max(dist / 1000, 1e-3);
  camera.far = dist * 20 + radius * 4;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  return center;
}
