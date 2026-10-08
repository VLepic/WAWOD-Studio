import clipping from "polygon-clipping";
import type { MultiPolygon, Polygon, Pair } from "polygon-clipping";
import { ShapeUtils, Vector2 } from "three";
import type { Vec2 } from "./project-model";
import type { SolvedRoof } from "./roof-solver";

type Point = [number, number, number]; // Wall coordinates: distance, normal offset, elevation.
type Surface = "Left" | "Right" | "Other";
interface Face { points: Point[]; surface: Surface }
interface Plane { normal: Point; constant: number }
export interface RoofWallGeometryOptions {
  roof: SolvedRoof;
  start: Vec2;
  direction: Vec2;
  footprint: Vec2[]; // Wall-local distance and normal offset, including miter ends.
  bottomM: number;
  topM: number;
  openings: Array<{ minU: number; maxU: number; minZ: number; maxZ: number }>;
}
export interface RoofWallMesh {
  surface: Surface;
  vertices: Point[];
  indices: number[];
}
const EPS = 1e-7;
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Point, b: Point): Point => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const normalize = (a: Point): Point => {
  const length = Math.hypot(...a);
  return length > EPS ? [a[0] / length, a[1] / length, a[2] / length] : [0, 0, 0];
};
const faceNormal = (points: Point[]) => {
  for (let i = 1; i < points.length - 1; i++) {
    const normal = cross(sub(points[i], points[0]), sub(points[i + 1], points[0]));
    if (Math.hypot(...normal) > EPS) return normalize(normal);
  }
  return null;
};
function clean(points: Point[]) {
  return points.filter((p, i) => Math.hypot(...sub(p, points[(i + points.length - 1) % points.length])) > EPS);
}

// Clip a convex solid, preserving outward winding and closing each new cut.
function clipSolid(faces: Face[], plane: Plane): Face[] {
  const result: Face[] = [];
  const cutPoints: Point[] = [];
  for (const face of faces) {
    const points: Point[] = [];
    for (let i = 0; i < face.points.length; i++) {
      const a = face.points[i], b = face.points[(i + 1) % face.points.length];
      const da = dot(plane.normal, a) - plane.constant;
      const db = dot(plane.normal, b) - plane.constant;
      if (da <= EPS) points.push(a);
      if ((da < -EPS && db > EPS) || (da > EPS && db < -EPS)) {
        const t = da / (da - db);
        const point: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        points.push(point);
        cutPoints.push(point);
      } else if (Math.abs(da) <= EPS) {
        cutPoints.push(a);
      }
    }
    const polygon = clean(points);
    if (polygon.length >= 3 && faceNormal(polygon)) result.push({ points: polygon, surface: face.surface });
  }
  const unique = cutPoints.filter((p, i) => !cutPoints.slice(0, i).some((q) => Math.hypot(...sub(p, q)) < EPS));
  if (unique.length >= 3 && faces.some((f) => f.points.some((p) => dot(plane.normal, p) > plane.constant + EPS))) {
    const normal = normalize(plane.normal);
    const axis = normalize(cross(Math.abs(normal[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0], normal));
    const other = cross(normal, axis);
    const center: Point = [0, 0, 0];
    for (const p of unique) for (let i = 0; i < 3; i++) center[i] += p[i] / unique.length;
    unique.sort((a, b) => {
      const da = sub(a, center), db = sub(b, center);
      return Math.atan2(dot(da, other), dot(da, axis)) - Math.atan2(dot(db, other), dot(db, axis));
    });
    if (faceNormal(unique)) result.push({ points: unique, surface: "Other" });
  }
  return result;
}

function box(minU: number, maxU: number, minN: number, maxN: number, minZ: number, maxZ: number): Face[] {
  const p: Point[] = [
    [minU, minN, minZ], [maxU, minN, minZ], [maxU, maxN, minZ], [minU, maxN, minZ],
    [minU, minN, maxZ], [maxU, minN, maxZ], [maxU, maxN, maxZ], [minU, maxN, maxZ],
  ];
  return [
    { points: [p[0], p[3], p[2], p[1]], surface: "Other" },
    { points: [p[4], p[5], p[6], p[7]], surface: "Other" },
    { points: [p[0], p[1], p[5], p[4]], surface: "Left" },
    { points: [p[3], p[7], p[6], p[2]], surface: "Right" },
    { points: [p[0], p[4], p[7], p[3]], surface: "Other" },
    { points: [p[1], p[2], p[6], p[5]], surface: "Other" },
  ];
}
function polygonPlanes(polygon: Vec2[]): Plane[] {
  const area = polygon.reduce((sum, p, i) => {
    const q = polygon[(i + 1) % polygon.length];
    return sum + p.x * q.y - p.y * q.x;
  }, 0);
  const sign = area >= 0 ? 1 : -1;
  return polygon.map((p, i) => {
    const q = polygon[(i + 1) % polygon.length];
    const normal: Point = [sign * (q.y - p.y), sign * (p.x - q.x), 0];
    return { normal, constant: normal[0] * p.x + normal[1] * p.y };
  });
}
function cuts(values: number[]) {
  return values.sort((a, b) => a - b).filter((v, i, all) => i === 0 || v - all[i - 1] > EPS);
}

export function buildRoofWallGeometry(options: RoofWallGeometryOptions): RoofWallMesh[] {
  const { roof, start, direction, footprint, bottomM, topM, openings } = options;
  if (topM <= bottomM || footprint.length < 3) return [];
  const normal = { x: direction.y, y: -direction.x };
  const local = (p: Vec2): Vec2 => ({
    x: (p.x - start.x) * direction.x + (p.y - start.y) * direction.y,
    y: (p.x - start.x) * normal.x + (p.y - start.y) * normal.y,
  });
  const world = (p: Point): Point => [
    start.x + direction.x * p[0] + normal.x * p[1], p[2],
    -(start.y + direction.y * p[0] + normal.y * p[1]),
  ];
  const minU = Math.min(...footprint.map((p) => p.x)), maxU = Math.max(...footprint.map((p) => p.x));
  const minN = Math.min(...footprint.map((p) => p.y)), maxN = Math.max(...footprint.map((p) => p.y));
  const uCuts = cuts([minU, maxU, ...openings.flatMap((o) => [o.minU, o.maxU]).filter((v) => v > minU && v < maxU)]);
  const zCuts = cuts([bottomM, topM, ...openings.flatMap((o) => [o.minZ, o.maxZ]).filter((v) => v > bottomM && v < topM)]);
  const footprintPlanes = polygonPlanes(footprint);
  const faces: Face[] = [];
  const yaw = roof.yawDeg * Math.PI / 180;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const toRoofLocal = (p: Vec2) => ({
    x: (p.x - roof.center.x) * cos + (p.y - roof.center.y) * sin,
    y: -(p.x - roof.center.x) * sin + (p.y - roof.center.y) * cos,
  });
  let covered: MultiPolygon = [];
  for (const roofFace of roof.faces) {
    const polygon = roofFace.polygonWorld.map(local);
    if (Math.max(...polygon.map((p) => p.x)) < minU - EPS ||
        Math.min(...polygon.map((p) => p.x)) > maxU + EPS ||
        Math.max(...polygon.map((p) => p.y)) < minN - EPS ||
        Math.min(...polygon.map((p) => p.y)) > maxN + EPS) continue;
    const height = (p: Vec2) => {
      const q = toRoofLocal(p);
      return roofFace.planeOuter.uCoeff * q.x + roofFace.planeOuter.vCoeff * q.y + roofFace.planeOuter.constantM - roofFace.thicknessM;
    };
    const originHeight = height(start);
    const du = height({ x: start.x + direction.x, y: start.y + direction.y }) - originHeight;
    const dn = height({ x: start.x + normal.x, y: start.y + normal.y }) - originHeight;
    const roofPlane = { normal: [-du, -dn, 1] as Point, constant: originHeight };
    const region: Polygon = [polygon.map((p) => [p.x, p.y])];
    // Match the roof solver's first-face precedence at overlapping footprints.
    const exposed = covered.length ? clipping.difference(region, covered) : [region];
    covered = clipping.union(region, covered);
    for (const part of exposed) {
      const rings = part.map((ring) => {
        const end = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? -1 : ring.length;
        return ring.slice(0, end).map(([x, y]) => new Vector2(x, y));
      });
      const points = rings.flat();
      const triangles = ShapeUtils.triangulateShape(rings[0], rings.slice(1));
      for (const triangle of triangles) {
        const trianglePlanes = polygonPlanes(triangle.map((i) => points[i]));
        for (let u = 0; u < uCuts.length - 1; u++) for (let z = 0; z < zCuts.length - 1; z++) {
          const midU = (uCuts[u] + uCuts[u + 1]) / 2, midZ = (zCuts[z] + zCuts[z + 1]) / 2;
          if (openings.some((o) => midU > o.minU && midU < o.maxU && midZ > o.minZ && midZ < o.maxZ)) continue;
          let solid = box(uCuts[u], uCuts[u + 1], minN, maxN, zCuts[z], zCuts[z + 1]);
          for (const plane of [...footprintPlanes, ...trianglePlanes, roofPlane]) {
            solid = clipSolid(solid, plane);
            if (!solid.length) break;
          }
          faces.push(...solid);
        }
      }
    }
  }

  // Union coplanar faces and subtract opposing faces: only the solid's exterior
  // survives, not the partition caps introduced by openings or roof triangles.
  interface Group {
    normal: Point; constant: number; axis: Point; other: Point;
    positive: Polygon[]; negative: Polygon[];
    positiveSurface: Surface; negativeSurface: Surface;
  }
  const groups = new Map<string, Group>();
  const round = (v: number) => Math.round(v * 1e6);
  for (const face of faces) {
    const outward = faceNormal(face.points);
    if (!outward) continue;
    const sign = (outward.find((v) => Math.abs(v) > EPS) ?? 1) > 0 ? 1 : -1;
    const n = outward.map((v) => v * sign) as Point;
    const constant = dot(n, face.points[0]);
    const key = [...n, constant].map(round).join(":");
    const axis = normalize(cross(Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0], n));
    const group = groups.get(key) ?? {
      normal: n, constant, axis, other: cross(n, axis), positive: [], negative: [],
      positiveSurface: face.surface, negativeSurface: face.surface,
    };
    const snap = (value: number) => Math.round(value * 1e7) / 1e7;
    const ring = face.points.map((p) => [snap(dot(p, group.axis)), snap(dot(p, group.other))] as Pair)
      .filter((p, i, points) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
    if (ring.length < 3) continue;
    (sign === 1 ? group.positive : group.negative).push([ring]);
    if (sign === 1) group.positiveSurface = face.surface;
    else group.negativeSurface = face.surface;
    groups.set(key, group);
  }
  const meshes: RoofWallMesh[] = [];
  const union = (polygons: Polygon[]): MultiPolygon => polygons.length ? clipping.union(polygons[0], ...polygons.slice(1)) : [];
  for (const group of groups.values()) {
    const positive = union(group.positive), negative = union(group.negative);
    for (const sign of [1, -1]) {
      const own = sign === 1 ? positive : negative, opposite = sign === 1 ? negative : positive;
      if (!own.length) continue;
      const boundary = opposite.length ? clipping.difference(own, opposite) : own;
      const mesh: RoofWallMesh = { surface: sign === 1 ? group.positiveSurface : group.negativeSurface, vertices: [], indices: [] };
      for (const polygon of boundary) {
        const rings = polygon.map((ring) => ring.slice(0, -1).map(([x, y]) => new Vector2(x, y)));
        const flat = rings.flat();
        const offset = mesh.vertices.length;
        for (const p of flat) {
          mesh.vertices.push(world([0, 1, 2].map((i) => group.normal[i] * group.constant + group.axis[i] * p.x + group.other[i] * p.y) as Point));
        }
        for (const tri of ShapeUtils.triangulateShape(rings[0], rings.slice(1))) {
          const a = flat[tri[0]], b = flat[tri[1]], c = flat[tri[2]];
          const orientation = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
          // Plan Y maps to negative world Z, reversing the local winding.
          const ordered = orientation * sign < 0 ? tri : [tri[0], tri[2], tri[1]];
          mesh.indices.push(...ordered.map((i) => offset + i));
        }
      }
      if (mesh.indices.length) meshes.push(mesh);
    }
  }
  return meshes;
}
