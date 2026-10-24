// The GitDonkey mark as a small 3D enamel badge, for the donkey in the
// corner: the logo's paths (lib/logo-mark.js) extruded the way the homepage
// hero does it, with ears and a jaw that move, pupils that look around and
// three forelock cables in the theme's red, amber and cyan.
import * as THREE from '../../../node_modules/three/build/three.module.min.js';

const EAR = 'M20.5 24.5 C 15 17.5, 11 9, 12 3 C 12.4 1.2, 14.6 0.8, 16.2 2.2 C 21 6.5, 26 12.5, 28.8 19.5 Z';
const EAR_INNER = 'M22.6 20.2 C 19.4 15.6, 17.4 10.6, 16.9 7.2 C 19.6 10.2, 22.4 14, 24.8 18.2 Z';
const HEAD = 'M32 15 C 40.6 15, 45.6 20.2, 45.6 28 C 45.6 34, 43.6 39, 43.6 44 C 43.6 47, 45.2 49.4, 45.2 53 C 45.2 58.6, 39.6 62.6, 32 62.6 C 24.4 62.6, 18.8 58.6, 18.8 53 C 18.8 49.4, 20.4 47, 20.4 44 C 20.4 39, 18.4 34, 18.4 28 C 18.4 20.2, 23.4 15, 32 15 Z';
const MUZZLE = 'M32 44.6 C 39.8 44.6, 45.2 48.2, 45.2 53 C 45.2 58.6, 39.6 62.6, 32 62.6 C 24.4 62.6, 18.8 58.6, 18.8 53 C 18.8 48.2, 24.2 44.6, 32 44.6 Z';
const mirror = (d) => d.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_, x, y) => `${+(64 - Number(x)).toFixed(2)} ${y}`);

export const S = 0.058; // logo units → world units
export const BONE = 0xece8df;

/** A shape from absolute M / C / Z path data (all the mark uses). */
function pathShape(d) {
  const shape = new THREE.Shape();
  const nums = (s) => s.trim().split(/[\s,]+/).filter(Boolean).map(Number);
  for (const [, cmd, body] of d.matchAll(/([MCZ])([^MCZ]*)/g)) {
    const n = nums(body);
    if (cmd === 'M') shape.moveTo(n[0], n[1]);
    else if (cmd === 'C') for (let i = 0; i + 5 < n.length; i += 6) shape.bezierCurveTo(n[i], n[i + 1], n[i + 2], n[i + 3], n[i + 4], n[i + 5]);
  }
  return shape;
}

function ellipseShape(cx, cy, rx, ry, rotation = 0) {
  const shape = new THREE.Shape();
  shape.absellipse(cx, cy, rx, ry, 0, Math.PI * 2, false, rotation);
  return shape;
}

function slab(shapes, { depth, bevel, z, material, curveSegments = 32 }) {
  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel * 0.65,
    bevelSegments: 5,
    curveSegments,
  });
  geo.rotateX(Math.PI); // logo y-down → y-up; the back cap now faces the camera
  geo.translate(0, 0, z);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, material);
}

export function createMaterials() {
  const mat = (color, opts = {}) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.42, clearcoat: 0.6, clearcoatRoughness: 0.28, ...opts });
  return {
    bone: mat(BONE, { roughness: 0.46, sheen: 0.25, sheenColor: new THREE.Color(0xffffff) }),
    muzzle: mat(0xd5cebf, { roughness: 0.55 }),
    dark: mat(0x0b0c0e, { roughness: 0.22, clearcoat: 1 }),
    earInner: mat(0x2a2b30, { roughness: 0.7, clearcoat: 0.2 }),
    cables: [0xff5a3c, 0xffb627, 0x36c3d0].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5 })),
  };
}

/** Studio light without an environment map: soft fill from above, a key from the front left and a warm rim. */
export function light(scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6b6156, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.position.set(-4, 6, 8);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffe2b0, 1.1);
  rim.position.set(5, 2, -4);
  scene.add(rim);
}

/**
 * The head. `inner` is in logo units with y flipped, so a point (x, y) on the
 * 64-unit mark sits at (x, -y) inside it. The jaw pivots at the muzzle's
 * centre, each ear at its base, and the pupils move inside their sockets.
 */
export function buildDonkey(materials) {
  const root = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.set(-32, 32, 0);
  root.add(inner);
  root.scale.setScalar(S);

  const ears = [];
  for (const side of [0, 1]) {
    const flip = side ? mirror : (d) => d;
    const base = side ? [39.4, 22] : [24.6, 22];
    const ear = new THREE.Group();
    ear.position.set(base[0], -base[1], 0);
    const outer = slab([pathShape(flip(EAR))], { depth: 3, bevel: 0.9, z: -2.4, material: materials.bone });
    const innerEar = slab([pathShape(flip(EAR_INNER))], { depth: 0.5, bevel: 0.35, z: -1.1, material: materials.earInner });
    for (const m of [outer, innerEar]) {
      m.geometry.translate(-base[0], base[1], 0);
      ear.add(m);
    }
    ear.userData.side = side;
    ears.push(ear);
    inner.add(ear);
  }

  inner.add(slab([pathShape(HEAD)], { depth: 7, bevel: 1.3, z: 0, material: materials.bone }));
  const jaw = new THREE.Group();
  jaw.position.set(32, -53.6, 0);
  const muzzle = slab([pathShape(MUZZLE)], { depth: 1, bevel: 0.9, z: 1.1, material: materials.muzzle });
  const nostrils = slab([ellipseShape(27.6, 54.6, 1.55, 2.7, -22 * Math.PI / 180), ellipseShape(36.4, 54.6, 1.55, 2.7, 22 * Math.PI / 180)], { depth: 0.3, bevel: 0.2, z: 2.2, material: materials.dark, curveSegments: 20 });
  for (const m of [muzzle, nostrils]) {
    m.position.set(-32, 53.6, 0);
    jaw.add(m);
  }
  inner.add(jaw);
  // Jack-socket eyes: a glossy dark ring with a bone pupil.
  inner.add(slab([ellipseShape(24.6, 31, 3.4, 3.4), ellipseShape(39.4, 31, 3.4, 3.4)], { depth: 0.6, bevel: 0.35, z: 1.4, material: materials.dark }));
  const pupilGeo = new THREE.SphereGeometry(1.25, 20, 14);
  pupilGeo.scale(1, 1, 0.45);
  const pupils = [];
  for (const x of [24.6, 39.4]) {
    const pupil = new THREE.Mesh(pupilGeo, materials.bone);
    pupil.position.set(x, -31, 2.05);
    pupil.userData.home = pupil.position.clone();
    pupils.push(pupil);
    inner.add(pupil);
  }
  // Forelock: three patch cables out of sockets on the brow, curling back over the head.
  const socketGeo = new THREE.CylinderGeometry(1.15, 1.15, 0.8, 20);
  socketGeo.rotateX(Math.PI / 2);
  const forelock = [];
  [[29.2, 17.6, -1], [32, 16.9, 0], [34.8, 17.6, 1]].forEach(([x, y, lean], i) => {
    const s = new THREE.Mesh(socketGeo, materials.dark);
    s.position.set(x, -y, 1.0);
    inner.add(s);
    const curve = new THREE.CubicBezierCurve3(
      new THREE.Vector3(x, -y, 1.3),
      new THREE.Vector3(x + lean * 2, -y + 7, 4),
      new THREE.Vector3(x + lean * 7, -y + 12, -1),
      new THREE.Vector3(x + lean * 9, -y + 6, -5),
    );
    const cable = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.85, 10, false), materials.cables[i]);
    forelock.push(cable);
    inner.add(cable);
  });
  return { root, inner, ears, jaw, pupils, forelock };
}

export { THREE };
