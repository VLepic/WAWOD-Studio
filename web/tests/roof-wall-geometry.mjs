import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { buildSync } from "esbuild";

process.on("uncaughtException", (error) => { console.error(error.message); process.exit(1); });

const bundle = buildSync({
  stdin: { contents: `
    export * from './src/domain/roof-wall-geometry';
    export * from './src/domain/roof-solver';
    export * from './src/domain/preview-3d-geometry';
    export * from './src/domain/project-serialization';
  `, resolveDir: process.cwd(), loader: "ts" },
  bundle: true, platform: "node", format: "esm", write: false,
}).outputFiles[0].text;
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`);
const plane = { uCoeff: 0.5, vCoeff: -0.8, constantM: 3.3 };
const polygon = [{ x: -1, y: -1 }, { x: 5, y: -1 }, { x: 5, y: 1 }, { x: -1, y: 1 }];
const roof = { center: { x: 0, y: 0 }, yawDeg: 0, faces: [
  { id: "face", polygonLocal: polygon, polygonWorld: polygon, planeOuter: plane, thicknessM: 0.3 },
] };
const options = {
  roof, start: { x: 0, y: 0 }, direction: { x: 1, y: 0 },
  footprint: [{ x: 0, y: -0.2 }, { x: 4, y: -0.2 }, { x: 4, y: 0.2 }, { x: 0, y: 0.2 }],
  bottomM: 0, topM: 10, openings: [],
};
function volume(meshes) {
  let volume = 0;
  for (const mesh of meshes) for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = mesh.indices.slice(i, i + 3).map((j) => mesh.vertices[j]);
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return volume;
}
function close(actual, expected, label) { assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`); }
const plain = api.buildRoofWallGeometry(options);
close(volume(plain), 6.4, "closed sloping solid volume");
for (const mesh of plain) for (const [x, y, z] of mesh.vertices) {
  assert.ok(y >= -1e-7 && y <= 3 + 0.5 * x + 0.8 * z + 1e-7, "roof clips actual face, not centerline");
}
for (const surface of ["Left", "Right"]) {
  const vertices = plain.filter((m) => m.surface === surface).flatMap((m) => m.vertices);
  assert.ok(vertices.some(([x, y, z]) => Math.abs(y - (3 + 0.5 * x + 0.8 * z)) < 1e-7), `${surface} reaches roof`);
}
const door = api.buildRoofWallGeometry({ ...options, openings: [{ minU: 1, maxU: 2, minZ: 0, maxZ: 2 }] });
close(volume(door), 5.6, "door opening subtracts correct solid");
const window = api.buildRoofWallGeometry({ ...options, openings: [{ minU: 1, maxU: 2, minZ: 1, maxZ: 2 }] });
close(volume(window), 6, "window opening subtracts correct solid");
const limited = api.buildRoofWallGeometry({ ...options, topM: 3.5 });
for (const mesh of limited) for (const [, y] of mesh.vertices) assert.ok(y <= 3.5 + 1e-7, "maximum height respected");
const reversed = api.buildRoofWallGeometry({ ...options, start: { x: 4, y: 0 }, direction: { x: -1, y: 0 } });
close(volume(reversed), 6.4, "drawing direction independent");
const miterFootprint = [{ x: -0.2, y: -0.2 }, { x: 4.2, y: -0.2 }, { x: 3.8, y: 0.2 }, { x: 0.2, y: 0.2 }];
let area = 0, momentU = 0, momentN = 0;
for (let i = 0; i < miterFootprint.length; i++) {
  const a = miterFootprint[i], b = miterFootprint[(i + 1) % miterFootprint.length];
  const cross = a.x * b.y - a.y * b.x;
  area += cross / 2; momentU += (a.x + b.x) * cross / 6; momentN += (a.y + b.y) * cross / 6;
}
close(volume(api.buildRoofWallGeometry({ ...options, footprint: miterFootprint })), 3 * area + 0.5 * momentU + 0.8 * momentN, "mitered ends follow roof at displaced coordinates");
const verticalPolygon = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 5 }, { x: -1, y: 5 }];
close(volume(api.buildRoofWallGeometry({ ...options, direction: { x: 0, y: 1 }, roof: {
  ...roof, faces: [{ ...roof.faces[0], polygonLocal: verticalPolygon, polygonWorld: verticalPolygon,
    planeOuter: { uCoeff: 0.8, vCoeff: 0.5, constantM: 3.3 } }],
} })), 6.4, "perpendicular wall direction");
const splitRoof = { ...roof, faces: [
  { ...roof.faces[0], polygonLocal: polygon.slice(0, 3), polygonWorld: polygon.slice(0, 3) },
  { ...roof.faces[0], id: "other", polygonLocal: [polygon[0], polygon[2], polygon[3]], polygonWorld: [polygon[0], polygon[2], polygon[3]] },
] };
close(volume(api.buildRoofWallGeometry({ ...options, roof: splitRoof })), 6.4, "roof triangulation does not change solid");
const yaw = 37 * Math.PI / 180, center = { x: 10, y: -8 };
const rotatedPolygon = polygon.map((p) => ({ x: center.x + p.x * Math.cos(yaw) - p.y * Math.sin(yaw), y: center.y + p.x * Math.sin(yaw) + p.y * Math.cos(yaw) }));
close(volume(api.buildRoofWallGeometry({ ...options, start: center, direction: { x: Math.cos(yaw), y: Math.sin(yaw) },
  roof: { ...roof, center, yawDeg: 37, faces: [{ ...roof.faces[0], polygonWorld: rotatedPolygon }] },
})), 6.4, "translated and rotated roof coordinates");
const lowerPolygon = [{ x: -1, y: -1 }, { x: 2, y: -1 }, { x: 2, y: 1 }, { x: -1, y: 1 }];
close(volume(api.buildRoofWallGeometry({ ...options, roof: { ...roof, faces: [
  { ...roof.faces[0], id: "lower", polygonLocal: lowerPolygon, polygonWorld: lowerPolygon, planeOuter: { uCoeff: 0, vCoeff: 0, constantM: 1.3 } }, roof.faces[0],
] } })), 4.4, "overlapping roof faces obey solver precedence");
const crossingFloor = api.buildRoofWallGeometry({ ...options, roof: { ...roof, faces: [{ ...roof.faces[0], planeOuter: { ...plane, constantM: -0.3 } }] } });
for (const mesh of crossingFloor) for (const [, y] of mesh.vertices) assert.ok(y >= -1e-7, "no inverted triangles below floor");

for (const path of ["public/samples/default.wawod", ...process.argv.slice(2)]) {
  assert.ok(existsSync(path), `missing fixture ${path}`);
  const project = api.parseProjectJson(readFileSync(path, "utf8")).project;
  const roofs = api.solveProjectRoofs(project);
  let count = 0;
  for (const wall of project.walls.filter((w) => w.topMode === "FollowRoof" && w.stairFollowMode === "None")) {
    const start = project.nodes.find((n) => n.id === wall.startNodeId).position;
    const end = project.nodes.find((n) => n.id === wall.endNodeId).position;
    const roof = roofs.find((r) => api.solveWallSegmentsAgainstRoof(r, start, end).length);
    if (!roof) continue;
    const level = project.levels.find((l) => l.id === wall.levelId);
    const type = project.wallTypes.find((t) => t.id === wall.wallTypeId);
    const isolated = { ...project, walls: [wall], nodes: project.nodes.filter((n) => n.id === wall.startNodeId || n.id === wall.endNodeId),
      slabs: [], shapes: [], stairs: [], models: [], groundSurfaces: [], materialAssignments: [],
      doors: project.doors.filter((o) => o.wallId === wall.id), windows: project.windows.filter((o) => o.wallId === wall.id),
      site: { ...project.site, visible3D: false } };
    const scene = api.buildPreview3DScene(isolated, "ArchitecturalJoin", "LevelColor", project.roofLayers.map((l) => l.id));
    assert.ok(scene.meshes.length, `missing wall ${wall.id}`);
    for (const mesh of scene.meshes) for (const [x, y, z] of mesh.vertices) {
      const height = api.getRoofHeightAtPoint(roof, { x, y: -z }, "inner");
      assert.ok(y >= level.elevationM - 1e-6 && y <= level.elevationM + type.heightM + 1e-6, `wall height limit ${wall.id}`);
      const onRoofBoundary = roof.faces.some((face) => face.polygonWorld.some((a, i, polygon) => {
        const b = polygon[(i + 1) % polygon.length];
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        const cross = (x - a.x) * (b.y - a.y) - (-z - a.y) * (b.x - a.x);
        const along = (x - a.x) * (b.x - a.x) + (-z - a.y) * (b.y - a.y);
        return length > 0 && Math.abs(cross) / length < 1e-6 && along >= -1e-6 && along <= length * length + 1e-6;
      }));
      // Discontinuous roof edges have two legitimate one-sided heights.
      if (height !== null && !onRoofBoundary) assert.ok(y <= height + 1e-6, `wall above roof ${wall.id}: ${y} > ${height}`);
    }
    count++;
  }
  assert.ok(count > 0);
  console.log(`PASS: ${path}: ${count} roof-following walls clipped within roof and height limits`);
}
console.log("PASS: analytical roof clipping, openings, height caps, floor clipping, direction and triangle partitions");
