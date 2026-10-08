import {
  createVec2,
} from "./project-model";
import { ShapeUtils, Vector2 } from "three";
import type {
  GroundSurface,
  MaterialSurface,
  Project,
  Shape,
  Slab,
  Stair,
  Vec2,
  WallStairFollowProfile,
} from "./project-model";
import {
  getRoofHeightAtPoint,
  solveProjectRoofs,
  solveRoofFromSlab,
  solveWallSegmentsAgainstRoof,
} from "./roof-solver";
import {
  areDirectionsCollinear,
  buildPreviewWallTopology,
  getSegmentDirection2D,
} from "./preview-3d-wall-geometry";
import type { RenderWallRun } from "./preview-3d-wall-geometry";
import { getSlabWorldPolygon } from "./slab-geometry";
import { buildRoofWallGeometry } from "./roof-wall-geometry";
import type {
  Preview3DRenderMode,
  Preview3DSurfaceMode,
} from "../store/editor-ui-store";

export interface Preview3DBoxPrimitive {
  kind: "box";
  center: [number, number, number];
  size: [number, number, number];
  yawRad: number;
  color: string;
}

export interface Preview3DCylinderPrimitive {
  kind: "cylinder";
  center: [number, number, number];
  radius: number;
  height: number;
  color: string;
}

export interface Preview3DMarkerPrimitive {
  kind: "marker";
  position: [number, number, number];
  radius: number;
  color: string;
}

export interface Preview3DMeshPrimitive {
  kind: "mesh";
  vertices: [number, number, number][];
  indices: number[];
  color: string;
  opacity?: number;
  castShadow?: boolean;
  showEdges?: boolean;
}

export interface Preview3DSceneData {
  boxes: Preview3DBoxPrimitive[];
  cylinders: Preview3DCylinderPrimitive[];
  markers: Preview3DMarkerPrimitive[];
  meshes: Preview3DMeshPrimitive[];
  target: [number, number, number];
  radius: number;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

interface WallMiterProfile {
  minU: number;
  maxU: number;
  startPositiveSideOffsetM: number;
  startNegativeSideOffsetM: number;
  endPositiveSideOffsetM: number;
  endNegativeSideOffsetM: number;
}

function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

function add3(left: Vec3, right: Vec3) {
  return vec3(left.x + right.x, left.y + right.y, left.z + right.z);
}

function subtract3(left: Vec3, right: Vec3) {
  return vec3(left.x - right.x, left.y - right.y, left.z - right.z);
}

function scale3(value: Vec3, scalar: number) {
  return vec3(value.x * scalar, value.y * scalar, value.z * scalar);
}

function dot3(left: Vec3, right: Vec3) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function cross3(left: Vec3, right: Vec3) {
  return vec3(
    left.y * right.z - left.z * right.y,
    left.z * right.x - left.x * right.z,
    left.x * right.y - left.y * right.x,
  );
}

function length3(value: Vec3) {
  return Math.sqrt(dot3(value, value));
}

function normalize3(value: Vec3) {
  const length = length3(value);
  if (length < 0.000001) {
    return vec3();
  }

  return scale3(value, 1 / length);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function signedPolygonArea(points: Vec2[]) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }

  return area / 2;
}

function lineIntersection2D(
  lineStart: Vec2,
  lineEnd: Vec2,
  clipStart: Vec2,
  clipEnd: Vec2,
) {
  const lineDeltaX = lineEnd.x - lineStart.x;
  const lineDeltaY = lineEnd.y - lineStart.y;
  const clipDeltaX = clipEnd.x - clipStart.x;
  const clipDeltaY = clipEnd.y - clipStart.y;
  const denominator = lineDeltaX * clipDeltaY - lineDeltaY * clipDeltaX;
  if (Math.abs(denominator) < 0.000001) {
    return lineEnd;
  }

  const t =
    ((clipStart.x - lineStart.x) * clipDeltaY -
      (clipStart.y - lineStart.y) * clipDeltaX) /
    denominator;
  return createVec2(lineStart.x + lineDeltaX * t, lineStart.y + lineDeltaY * t);
}

function clipPolygonToConvexPolygon(subject: Vec2[], clipPolygon: Vec2[]) {
  if (subject.length < 3 || clipPolygon.length < 3) {
    return [];
  }

  const orientation = signedPolygonArea(clipPolygon) >= 0 ? 1 : -1;
  let output = subject;

  for (let clipIndex = 0; clipIndex < clipPolygon.length; clipIndex += 1) {
    const clipStart = clipPolygon[clipIndex];
    const clipEnd = clipPolygon[(clipIndex + 1) % clipPolygon.length];
    const input = output;
    output = [];

    if (input.length === 0) {
      break;
    }

    const isInside = (point: Vec2) => {
      const cross =
        (clipEnd.x - clipStart.x) * (point.y - clipStart.y) -
        (clipEnd.y - clipStart.y) * (point.x - clipStart.x);
      return orientation * cross >= -0.000001;
    };

    let previous = input[input.length - 1];
    let previousInside = isInside(previous);

    for (const current of input) {
      const currentInside = isInside(current);
      if (currentInside) {
        if (!previousInside) {
          output.push(lineIntersection2D(previous, current, clipStart, clipEnd));
        }
        output.push(current);
      } else if (previousInside) {
        output.push(lineIntersection2D(previous, current, clipStart, clipEnd));
      }

      previous = current;
      previousInside = currentInside;
    }
  }

  return output.filter(
    (point, index, points) =>
      index === 0 ||
      Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) > 0.0001,
  );
}

function uniqueSortedCuts(values: number[]) {
  return [...values]
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right)
    .filter((value, index, sorted) => index === 0 || Math.abs(value - sorted[index - 1]) > 0.001);
}

function toWorldPoint2D(position: Vec2, elevationM: number) {
  return vec3(position.x, elevationM, -position.y);
}

function rgbToCss(color: RgbColor) {
  return `rgb(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)})`;
}

function hexToRgb(colorHex: string): RgbColor | null {
  const match = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(colorHex);
  if (!match) {
    return null;
  }

  return {
    r: Number.parseInt(match[1], 16),
    g: Number.parseInt(match[2], 16),
    b: Number.parseInt(match[3], 16),
  };
}

function shadeColor(color: RgbColor, factor: number) {
  const mix = clamp(factor, 0, 1.5);
  return {
    r: clamp(color.r * mix, 0, 255),
    g: clamp(color.g * mix, 0, 255),
    b: clamp(color.b * mix, 0, 255),
  };
}

function levelColor(index: number): RgbColor {
  const palette: RgbColor[] = [
    { r: 197, g: 157, b: 95 },
    { r: 116, g: 175, b: 208 },
    { r: 139, g: 188, b: 143 },
    { r: 206, g: 132, b: 96 },
  ];

  return palette[index % palette.length];
}

function getBaseSurfaceColor(index: number, surfaceMode: Preview3DSurfaceMode) {
  if (surfaceMode === "GrayOpaque") {
    const grayPalette: RgbColor[] = [
      { r: 154, g: 158, b: 164 },
      { r: 144, g: 148, b: 154 },
      { r: 168, g: 172, b: 178 },
    ];

    return grayPalette[index % grayPalette.length];
  }

  return levelColor(index);
}


function computeAngularWallExtension(
  currentDirection: Vec3,
  neighborDirection: Vec3,
  currentThicknessM: number,
  neighborThicknessM: number,
) {
  const normalizedDot = clamp(dot3(currentDirection, neighborDirection), -1, 1);
  const angleRad = Math.acos(normalizedDot);

  if (angleRad < 0.05 || angleRad > Math.PI - 0.05) {
    return 0;
  }

  const halfReferenceThicknessM = Math.max(currentThicknessM, neighborThicknessM) / 2;
  const rawExtensionM = halfReferenceThicknessM / Math.tan(angleRad / 2);
  const limitedExtensionM = clamp(
    rawExtensionM,
    0,
    Math.max(currentThicknessM, neighborThicknessM) * 3,
  );

  return Number.isFinite(limitedExtensionM) ? limitedExtensionM : 0;
}

function trimSegmentLengthForLanding(segmentLengthM: number, trimM: number) {
  return Math.max(0, Math.min(trimM, Math.max(segmentLengthM / 2 - 0.05, 0)));
}

function pointAlong2DSegment(start: Vec2, end: Vec2, offsetM: number) {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthM = Math.hypot(deltaX, deltaY);
  if (lengthM < 0.0001) {
    return start;
  }

  const t = offsetM / lengthM;
  return {
    x: start.x + deltaX * t,
    y: start.y + deltaY * t,
  };
}

interface StairProfileSection {
  startPoint: Vec2;
  endPoint: Vec2;
  lengthM: number;
  startTrimM: number;
  endTrimM: number;
  startElevationM: number;
  endElevationM: number;
  stepCount: number;
}

function buildStairProfileSections(stair: Stair, levelElevationM: number): StairProfileSection[] {
  const landingHalfM = stair.landingLengthM / 2;
  const effectiveSegments = stair.pathNodes
    .slice(0, -1)
    .map((startPoint, index) => {
      const endPoint = stair.pathNodes[index + 1];
      const lengthM = Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y);
      const startTrimM = index > 0 ? trimSegmentLengthForLanding(lengthM, landingHalfM) : 0;
      const endTrimM =
        index < stair.pathNodes.length - 2
          ? trimSegmentLengthForLanding(lengthM, landingHalfM)
          : 0;
      return {
        startPoint,
        endPoint,
        lengthM,
        startTrimM,
        endTrimM,
        effectiveLengthM: Math.max(lengthM - startTrimM - endTrimM, 0),
      };
    })
    .filter((segment) => segment.lengthM > 0.0001 && segment.effectiveLengthM > 0.0001);

  if (effectiveSegments.length === 0) {
    return [];
  }

  const totalEffectiveRunM = effectiveSegments.reduce(
    (sum, segment) => sum + segment.effectiveLengthM,
    0,
  );
  const totalRiseM = stair.endElevationM - levelElevationM;
  const totalStepCount = Math.max(
    effectiveSegments.length,
    Math.round(Math.abs(totalRiseM) / stair.riserHeightM),
  );
  const stepCounts = effectiveSegments.map(() => 1);
  let remainingStepCount = Math.max(0, totalStepCount - effectiveSegments.length);
  const allocations = effectiveSegments.map((segment) => {
    const raw = (segment.effectiveLengthM / totalEffectiveRunM) * remainingStepCount;
    const integer = Math.floor(raw);
    return { integer, remainder: raw - integer };
  });

  allocations.forEach((allocation, index) => {
    stepCounts[index] += allocation.integer;
    remainingStepCount -= allocation.integer;
  });
  allocations
    .map((allocation, index) => ({ ...allocation, index }))
    .sort((left, right) => right.remainder - left.remainder)
    .slice(0, remainingStepCount)
    .forEach((allocation) => {
      stepCounts[allocation.index] += 1;
    });

  let accumulatedElevationM = levelElevationM;
  return effectiveSegments.map((segment, index) => {
    const segmentRiseM = (totalRiseM * segment.effectiveLengthM) / totalEffectiveRunM;
    const section: StairProfileSection = {
      ...segment,
      startElevationM: accumulatedElevationM,
      endElevationM: accumulatedElevationM + segmentRiseM,
      stepCount: stepCounts[index],
    };
    accumulatedElevationM += segmentRiseM;
    return section;
  });
}

function getStairTopElevationAtPoint(
  sections: readonly StairProfileSection[],
  point: Vec2,
  profile: WallStairFollowProfile,
) {
  let nearest: { distanceSquared: number; elevationM: number } | null = null;

  for (const section of sections) {
    const deltaX = section.endPoint.x - section.startPoint.x;
    const deltaY = section.endPoint.y - section.startPoint.y;
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;
    if (lengthSquared < 0.000001) {
      continue;
    }

    const rawT =
      ((point.x - section.startPoint.x) * deltaX +
        (point.y - section.startPoint.y) * deltaY) /
      lengthSquared;
    const t = clamp(rawT, 0, 1);
    const projected = createVec2(
      section.startPoint.x + deltaX * t,
      section.startPoint.y + deltaY * t,
    );
    const distanceSquared =
      (point.x - projected.x) ** 2 + (point.y - projected.y) ** 2;
    const offsetM = t * section.lengthM;
    let elevationM: number;

    if (offsetM <= section.startTrimM + 0.0001) {
      elevationM = section.startElevationM;
    } else if (offsetM >= section.lengthM - section.endTrimM - 0.0001) {
      elevationM = section.endElevationM;
    } else {
      const effectiveLengthM = section.lengthM - section.startTrimM - section.endTrimM;
      if (profile === "Smooth") {
        const progress = clamp((offsetM - section.startTrimM) / effectiveLengthM, 0, 1);
        elevationM =
          section.startElevationM +
          (section.endElevationM - section.startElevationM) * progress;
      } else {
        const stepRunM = effectiveLengthM / section.stepCount;
        const stepIndex = Math.min(
          section.stepCount - 1,
          Math.max(0, Math.floor((offsetM - section.startTrimM) / stepRunM)),
        );
        const stepRiseM =
          (section.endElevationM - section.startElevationM) / section.stepCount;
        const stepStartM = section.startElevationM + stepRiseM * stepIndex;
        const stepEndM = stepStartM + stepRiseM;
        elevationM = Math.max(stepStartM, stepEndM);
      }
    }

    if (!nearest || distanceSquared < nearest.distanceSquared) {
      nearest = { distanceSquared, elevationM };
    }
  }

  return nearest?.elevationM ?? null;
}

function cross2(left: Vec2, right: Vec2) {
  return left.x * right.y - left.y * right.x;
}

function rightNormal2(direction: Vec2) {
  return createVec2(direction.y, -direction.x);
}

function createYawBoxVertices(center: Vec3, sizeX: number, sizeY: number, sizeZ: number, yawRad: number) {
  const halfX = sizeX / 2;
  const halfY = sizeY / 2;
  const halfZ = sizeZ / 2;
  const cos = Math.cos(yawRad);
  const sin = Math.sin(yawRad);
  const localVertices = [
    vec3(-halfX, -halfY, -halfZ),
    vec3(halfX, -halfY, -halfZ),
    vec3(halfX, halfY, -halfZ),
    vec3(-halfX, halfY, -halfZ),
    vec3(-halfX, -halfY, halfZ),
    vec3(halfX, -halfY, halfZ),
    vec3(halfX, halfY, halfZ),
    vec3(-halfX, halfY, halfZ),
  ];

  return localVertices.map((vertex) =>
    add3(
      center,
      vec3(
        vertex.x * cos - vertex.z * sin,
        vertex.y,
        vertex.x * sin + vertex.z * cos,
      ),
    ),
  );
}

export function buildPreview3DScene(
  project: Project,
  renderMode: Preview3DRenderMode,
  surfaceMode: Preview3DSurfaceMode,
  hiddenRoofLayerIds: readonly string[] = [],
): Preview3DSceneData {
  const levelById = new Map(project.levels.map((level) => [level.id, level] as const));
  const levelIndexById = new Map(project.levels.map((level, index) => [level.id, index] as const));
  const hiddenRoofLayerIdSet = new Set(hiddenRoofLayerIds);
  const wallTypeById = new Map(project.wallTypes.map((wallType) => [wallType.id, wallType] as const));
  const nodeById = new Map(project.nodes.map((node) => [node.id, node] as const));
  const materialById = new Map(project.materials.map((material) => [material.id, material] as const));
  const materialAssignmentByTarget = new Map(
    project.materialAssignments
      .filter((assignment) => assignment.surface === "All")
      .map((assignment) => [
        `${assignment.targetKind}:${assignment.targetId}`,
        assignment,
      ] as const),
  );
  const materialAssignmentBySurface = new Map(
    project.materialAssignments.map((assignment) => [
      `${assignment.targetKind}:${assignment.targetId}:${assignment.surface}`,
      assignment,
    ] as const),
  );
  const getTargetMaterialId = (
    targetKind: "Wall" | "Slab" | "RoofFace",
    targetId: string,
    surface: MaterialSurface = "All",
  ) =>
    materialAssignmentBySurface.get(`${targetKind}:${targetId}:${surface}`)?.materialId ??
    materialAssignmentByTarget.get(`${targetKind}:${targetId}`)?.materialId ??
    null;
  const getTargetColor = (
    targetKind: "Wall" | "Slab" | "RoofFace",
    targetId: string,
    fallback: RgbColor,
  ) => {
    const materialId = getTargetMaterialId(targetKind, targetId);
    const material = materialId ? materialById.get(materialId) : null;
    return material ? (hexToRgb(material.colorHex) ?? fallback) : fallback;
  };
  const wallTopology = buildPreviewWallTopology(project, nodeById, wallTypeById);
  const {
    wallOpeningsByWallId,
    nodeWallAggregates,
    wallRenderInfoById,
    wallIdsByNodeId,
    renderWalls,
  } = wallTopology;
  const solvedRoofs = solveProjectRoofs(project);

  const boxes: Preview3DBoxPrimitive[] = [];
  const cylinders: Preview3DCylinderPrimitive[] = [];
  const markers: Preview3DMarkerPrimitive[] = [];
  const meshes: Preview3DMeshPrimitive[] = [];
  const worldPoints: Vec3[] = [];

  const registerPoints = (points: Vec3[]) => {
    worldPoints.push(...points);
  };

  const addBoxPrimitive = (
    center: Vec3,
    sizeX: number,
    sizeY: number,
    sizeZ: number,
    yawRad: number,
    color: RgbColor,
  ) => {
    boxes.push({
      kind: "box",
      center: [center.x, center.y, center.z],
      size: [sizeX, sizeY, sizeZ],
      yawRad,
      color: rgbToCss(color),
    });
    registerPoints(createYawBoxVertices(center, sizeX, sizeY, sizeZ, yawRad));
  };

  const addCylinderPrimitive = (
    center: Vec3,
    radius: number,
    height: number,
    color: RgbColor,
  ) => {
    cylinders.push({
      kind: "cylinder",
      center: [center.x, center.y, center.z],
      radius,
      height,
      color: rgbToCss(color),
    });
    registerPoints([
      vec3(center.x - radius, center.y - height / 2, center.z - radius),
      vec3(center.x + radius, center.y + height / 2, center.z + radius),
    ]);
  };

  const addMeshPrimitive = (
    vertices: Vec3[],
    indices: number[],
    color: RgbColor,
    opacity?: number,
    options?: { castShadow?: boolean; showEdges?: boolean },
  ) => {
    meshes.push({
      kind: "mesh",
      vertices: vertices.map((vertex) => [vertex.x, vertex.y, vertex.z]),
      indices,
      color: rgbToCss(color),
      opacity,
      castShadow: options?.castShadow,
      showEdges: options?.showEdges,
    });
    registerPoints(vertices);
  };

  type SolvedRoof = ReturnType<typeof solveProjectRoofs>[number];
  type SolvedRoofFace = SolvedRoof["faces"][number];

  const getRoofFaceBasis = (face: SolvedRoofFace) => {
    const originPlan = face.polygonLocal[0] ?? createVec2();
    const origin = vec3(
      originPlan.x,
      face.planeOuter.uCoeff * originPlan.x +
        face.planeOuter.vCoeff * originPlan.y +
        face.planeOuter.constantM,
      -originPlan.y,
    );
    const tangentX = vec3(1, face.planeOuter.uCoeff, 0);
    const tangentY = vec3(0, face.planeOuter.vCoeff, -1);
    const normal = normalize3(cross3(tangentX, tangentY));
    const gradientLength = Math.hypot(face.planeOuter.uCoeff, face.planeOuter.vCoeff);
    const widthAxis =
      gradientLength > 0.0001
        ? normalize3(vec3(-face.planeOuter.vCoeff, 0, -face.planeOuter.uCoeff))
        : normalize3(tangentX);
    const heightAxis = normalize3(cross3(normal, widthAxis));

    const toWorld = (point: Vec2) => {
      return vec3(
        point.x,
        face.planeOuter.uCoeff * point.x +
          face.planeOuter.vCoeff * point.y +
          face.planeOuter.constantM,
        -point.y,
      );
    };
    const toUv = (point: Vec2) => {
      const delta = subtract3(toWorld(point), origin);
      return createVec2(dot3(delta, widthAxis), dot3(delta, heightAxis));
    };
    const fromUv = (point: Vec2) =>
      add3(origin, add3(scale3(widthAxis, point.x), scale3(heightAxis, point.y)));

    return { origin, widthAxis, heightAxis, normal, toUv, fromUv };
  };

  const getRoofOpeningDimensions = (opening: Project["roofOpenings"][number]) => {
    return opening.rotationDeg === 90
      ? { widthM: opening.heightM, heightM: opening.widthM }
      : { widthM: opening.widthM, heightM: opening.heightM };
  };

  const addRoofFaceShell = (topVertices: Vec3[], thicknessM: number, color: RgbColor) => {
    if (topVertices.length < 3) {
      return;
    }

    const safeThicknessM = Math.max(thicknessM, 0.01);
    const bottomVertices = topVertices.map((vertex) =>
      vec3(vertex.x, vertex.y - safeThicknessM, vertex.z),
    );
    const vertices = [...topVertices, ...bottomVertices];
    const vertexCount = topVertices.length;
    const indices: number[] = [];

    for (let index = 1; index < vertexCount - 1; index += 1) {
      indices.push(0, index, index + 1);
    }

    for (let index = 1; index < vertexCount - 1; index += 1) {
      indices.push(vertexCount, vertexCount + index + 1, vertexCount + index);
    }

    for (let index = 0; index < vertexCount; index += 1) {
      const nextIndex = (index + 1) % vertexCount;
      const topStart = index;
      const topEnd = nextIndex;
      const bottomStart = vertexCount + index;
      const bottomEnd = vertexCount + nextIndex;
      indices.push(topStart, topEnd, bottomEnd, topStart, bottomEnd, bottomStart);
    }

    addMeshPrimitive(vertices, indices, color);
  };

  const addMergedRoofFaceShell = (topPolygons: Vec3[][], thicknessM: number, color: RgbColor) => {
    const safeThicknessM = Math.max(thicknessM, 0.01);
    const vertices: Vec3[] = [];
    const indices: number[] = [];
    const edgeCounts = new Map<string, number>();
    const shellEdges: Array<{
      key: string;
      topStartIndex: number;
      topEndIndex: number;
      bottomStartIndex: number;
      bottomEndIndex: number;
    }> = [];
    const quantize = (value: number) => Math.round(value * 10000) / 10000;
    const pointKey = (point: Vec3) =>
      `${quantize(point.x)},${quantize(point.y)},${quantize(point.z)}`;
    const edgeKey = (start: Vec3, end: Vec3) => {
      const startKey = pointKey(start);
      const endKey = pointKey(end);
      return startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
    };

    for (const topVertices of topPolygons) {
      if (topVertices.length < 3) {
        continue;
      }

      const vertexOffset = vertices.length;
      const bottomOffset = vertexOffset + topVertices.length;
      const bottomVertices = topVertices.map((vertex) =>
        vec3(vertex.x, vertex.y - safeThicknessM, vertex.z),
      );
      vertices.push(...topVertices, ...bottomVertices);

      for (let index = 1; index < topVertices.length - 1; index += 1) {
        indices.push(vertexOffset, vertexOffset + index, vertexOffset + index + 1);
      }

      for (let index = 1; index < topVertices.length - 1; index += 1) {
        indices.push(bottomOffset, bottomOffset + index + 1, bottomOffset + index);
      }

      for (let index = 0; index < topVertices.length; index += 1) {
        const nextIndex = (index + 1) % topVertices.length;
        const key = edgeKey(topVertices[index], topVertices[nextIndex]);
        edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
        shellEdges.push({
          key,
          topStartIndex: vertexOffset + index,
          topEndIndex: vertexOffset + nextIndex,
          bottomStartIndex: bottomOffset + index,
          bottomEndIndex: bottomOffset + nextIndex,
        });
      }
    }

    for (const edge of shellEdges) {
      if ((edgeCounts.get(edge.key) ?? 0) !== 1) {
        continue;
      }

      indices.push(
        edge.topStartIndex,
        edge.topEndIndex,
        edge.bottomEndIndex,
        edge.topStartIndex,
        edge.bottomEndIndex,
        edge.bottomStartIndex,
      );
    }

    if (vertices.length > 0 && indices.length > 0) {
      addMeshPrimitive(vertices, indices, color);
    }
  };

  const addSectionBox = (
    thicknessM: number,
    heightM: number,
    zStartM: number,
    start: Vec3,
    end: Vec3,
    color: RgbColor,
  ) => {
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const length = Math.sqrt(dx * dx + dz * dz);
    const yawRad = Math.atan2(dx, dz);
    const center = vec3(
      (start.x + end.x) / 2,
      start.y + zStartM + heightM / 2,
      (start.z + end.z) / 2,
    );

    addBoxPrimitive(center, thicknessM, heightM, Math.max(length, 0.01), yawRad, color);
  };

  const addMergedWallShell = (
    cells: Array<{ minU: number; maxU: number; minV: number; maxV: number }>,
    thicknessM: number,
    start: Vec3,
    direction: Vec3,
    color: RgbColor,
    miterProfile?: WallMiterProfile,
  ) => {
    const safeThicknessM = Math.max(thicknessM, 0.01);
    const halfThicknessM = safeThicknessM / 2;
    const normal = normalize3(vec3(-direction.z, 0, direction.x));
    const vertices: Vec3[] = [];
    const indices: number[] = [];
    const edgeCounts = new Map<string, number>();
    const shellEdges: Array<{
      key: string;
      frontStartIndex: number;
      frontEndIndex: number;
      backStartIndex: number;
      backEndIndex: number;
    }> = [];
    const quantize = (value: number) => Math.round(value * 10000) / 10000;
    const localKey = (u: number, v: number) => `${quantize(u)},${quantize(v)}`;
    const edgeKey = (startU: number, startV: number, endU: number, endV: number) => {
      const startKey = localKey(startU, startV);
      const endKey = localKey(endU, endV);
      return startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
    };
    const offsetUForSide = (u: number, side: -1 | 1) => {
      if (!miterProfile) {
        return u;
      }

      if (Math.abs(u - miterProfile.minU) < 0.0001) {
        return u + (side === 1 ? miterProfile.startPositiveSideOffsetM : miterProfile.startNegativeSideOffsetM);
      }

      if (Math.abs(u - miterProfile.maxU) < 0.0001) {
        return u + (side === 1 ? miterProfile.endPositiveSideOffsetM : miterProfile.endNegativeSideOffsetM);
      }

      return u;
    };
    const toWorld = (u: number, v: number, side: -1 | 1) =>
      add3(
        add3(start, scale3(direction, offsetUForSide(u, side))),
        add3(vec3(0, v, 0), scale3(normal, side * halfThicknessM)),
      );

    for (const cell of cells) {
      if (cell.maxU - cell.minU < 0.001 || cell.maxV - cell.minV < 0.001) {
        continue;
      }

      const frontOffset = vertices.length;
      const backOffset = frontOffset + 4;
      const localCorners = [
        { u: cell.minU, v: cell.minV },
        { u: cell.maxU, v: cell.minV },
        { u: cell.maxU, v: cell.maxV },
        { u: cell.minU, v: cell.maxV },
      ];

      vertices.push(
        ...localCorners.map((corner) => toWorld(corner.u, corner.v, 1)),
        ...localCorners.map((corner) => toWorld(corner.u, corner.v, -1)),
      );
      indices.push(
        frontOffset,
        frontOffset + 1,
        frontOffset + 2,
        frontOffset,
        frontOffset + 2,
        frontOffset + 3,
        backOffset,
        backOffset + 2,
        backOffset + 1,
        backOffset,
        backOffset + 3,
        backOffset + 2,
      );

      for (let index = 0; index < localCorners.length; index += 1) {
        const nextIndex = (index + 1) % localCorners.length;
        const current = localCorners[index];
        const next = localCorners[nextIndex];
        const key = edgeKey(current.u, current.v, next.u, next.v);
        edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
        shellEdges.push({
          key,
          frontStartIndex: frontOffset + index,
          frontEndIndex: frontOffset + nextIndex,
          backStartIndex: backOffset + index,
          backEndIndex: backOffset + nextIndex,
        });
      }
    }

    for (const edge of shellEdges) {
      if ((edgeCounts.get(edge.key) ?? 0) !== 1) {
        continue;
      }

      indices.push(
        edge.frontStartIndex,
        edge.frontEndIndex,
        edge.backEndIndex,
        edge.frontStartIndex,
        edge.backEndIndex,
        edge.backStartIndex,
      );
    }

    if (vertices.length > 0 && indices.length > 0) {
      addMeshPrimitive(vertices, indices, color);
    }
  };

  const addMergedSlopedWallShell = (
    cells: Array<{
      startOffsetM: number;
      endOffsetM: number;
      bottomStartHeightM: number;
      bottomEndHeightM: number;
      topStartHeightM: number;
      topEndHeightM: number;
    }>,
    thicknessM: number,
    start: Vec3,
    direction: Vec3,
    color: RgbColor,
    miterProfile?: WallMiterProfile,
  ) => {
    const safeThicknessM = Math.max(thicknessM, 0.01);
    const halfThicknessM = safeThicknessM / 2;
    const normal = normalize3(vec3(-direction.z, 0, direction.x));
    const vertices: Vec3[] = [];
    const indices: number[] = [];
    interface LocalEdge {
      startU: number;
      startH: number;
      endU: number;
      endH: number;
    }
    const nonVerticalEdges = new Map<string, { count: number; edge: LocalEdge }>();
    const verticalEdgesByU = new Map<string, { u: number; edges: LocalEdge[] }>();
    const quantize = (value: number) => Math.round(value * 10000) / 10000;
    const localKey = (u: number, h: number) => `${quantize(u)},${quantize(h)}`;
    const edgeKey = (startU: number, startH: number, endU: number, endH: number) => {
      const startKey = localKey(startU, startH);
      const endKey = localKey(endU, endH);
      return startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
    };
    const offsetUForSide = (offsetM: number, side: -1 | 1) => {
      if (!miterProfile) {
        return offsetM;
      }

      if (Math.abs(offsetM - miterProfile.minU) < 0.0001) {
        return offsetM + (side === 1 ? miterProfile.startPositiveSideOffsetM : miterProfile.startNegativeSideOffsetM);
      }

      if (Math.abs(offsetM - miterProfile.maxU) < 0.0001) {
        return offsetM + (side === 1 ? miterProfile.endPositiveSideOffsetM : miterProfile.endNegativeSideOffsetM);
      }

      return offsetM;
    };
    const toWorld = (offsetM: number, heightM: number, side: -1 | 1) => {
      const base = add3(start, scale3(direction, offsetUForSide(offsetM, side)));
      return add3(vec3(base.x, heightM, base.z), scale3(normal, side * halfThicknessM));
    };
    const emitSideFace = (edge: LocalEdge) => {
      const offset = vertices.length;
      vertices.push(
        toWorld(edge.startU, edge.startH, 1),
        toWorld(edge.endU, edge.endH, 1),
        toWorld(edge.endU, edge.endH, -1),
        toWorld(edge.startU, edge.startH, -1),
      );
      indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
    };

    for (const cell of cells) {
      if (
        cell.endOffsetM <= cell.startOffsetM + 0.0001 ||
        Math.max(cell.topStartHeightM, cell.topEndHeightM) <=
          Math.min(cell.bottomStartHeightM, cell.bottomEndHeightM) + 0.0001
      ) {
        continue;
      }

      const frontOffset = vertices.length;
      const backOffset = frontOffset + 4;
      const corners = [
        { u: cell.startOffsetM, h: cell.bottomStartHeightM },
        { u: cell.endOffsetM, h: cell.bottomEndHeightM },
        { u: cell.endOffsetM, h: cell.topEndHeightM },
        { u: cell.startOffsetM, h: cell.topStartHeightM },
      ];

      vertices.push(
        ...corners.map((corner) => toWorld(corner.u, corner.h, 1)),
        ...corners.map((corner) => toWorld(corner.u, corner.h, -1)),
      );
      indices.push(
        frontOffset,
        frontOffset + 1,
        frontOffset + 2,
        frontOffset,
        frontOffset + 2,
        frontOffset + 3,
        backOffset,
        backOffset + 2,
        backOffset + 1,
        backOffset,
        backOffset + 3,
        backOffset + 2,
      );

      for (let index = 0; index < corners.length; index += 1) {
        const nextIndex = (index + 1) % corners.length;
        const current = corners[index];
        const next = corners[nextIndex];
        const edge: LocalEdge = {
          startU: current.u,
          startH: current.h,
          endU: next.u,
          endH: next.h,
        };
        if (Math.abs(current.u - next.u) < 0.0001) {
          const uKey = `${quantize(current.u)}`;
          const group = verticalEdgesByU.get(uKey) ?? { u: current.u, edges: [] };
          group.edges.push(edge);
          verticalEdgesByU.set(uKey, group);
        } else {
          const key = edgeKey(current.u, current.h, next.u, next.h);
          const existing = nonVerticalEdges.get(key);
          nonVerticalEdges.set(key, {
            count: (existing?.count ?? 0) + 1,
            edge: existing?.edge ?? edge,
          });
        }
      }
    }

    for (const { count, edge } of nonVerticalEdges.values()) {
      if (count === 1) {
        emitSideFace(edge);
      }
    }

    for (const { u, edges } of verticalEdgesByU.values()) {
      const heightCuts = Array.from(
        new Set(edges.flatMap((edge) => [quantize(edge.startH), quantize(edge.endH)])),
      ).sort((left, right) => left - right);

      for (let index = 0; index < heightCuts.length - 1; index += 1) {
        const minH = heightCuts[index];
        const maxH = heightCuts[index + 1];
        if (maxH <= minH + 0.0001) {
          continue;
        }

        const midpointH = (minH + maxH) / 2;
        const coveringEdges = edges.filter(
          (edge) =>
            midpointH > Math.min(edge.startH, edge.endH) - 0.0001 &&
            midpointH < Math.max(edge.startH, edge.endH) + 0.0001,
        );
        if (coveringEdges.length !== 1) {
          continue;
        }

        const sourceEdge = coveringEdges[0];
        emitSideFace(
          sourceEdge.startH <= sourceEdge.endH
            ? { startU: u, startH: minH, endU: u, endH: maxH }
            : { startU: u, startH: maxH, endU: u, endH: minH },
        );
      }
    }

    if (vertices.length > 0 && indices.length > 0) {
      addMeshPrimitive(vertices, indices, color);
    }
  };

  const addShapePrimitive = (shape: Shape, levelElevationM: number, color: RgbColor) => {
    const center = vec3(
      shape.pose.position.x,
      levelElevationM + shape.zStartM + shape.heightM / 2,
      -shape.pose.position.y,
    );

    if (shape.kind === "Cylinder") {
      addCylinderPrimitive(center, shape.sizeM / 2, shape.heightM, color);
      return;
    }

    addBoxPrimitive(center, shape.sizeM, shape.heightM, shape.sizeM, 0, color);
  };

  const addGroundSurfacePrimitive = (groundSurface: GroundSurface) => {
    const halfWidth = groundSurface.widthM / 2;
    const halfDepth = groundSurface.depthM / 2;
    const yawRad = (groundSurface.pose.yawDeg * Math.PI) / 180;
    const cos = Math.cos(yawRad);
    const sin = Math.sin(yawRad);
    const localCorners = [
      createVec2(-halfWidth, -halfDepth),
      createVec2(halfWidth, -halfDepth),
      createVec2(halfWidth, halfDepth),
      createVec2(-halfWidth, halfDepth),
    ];
    const vertices = localCorners.map((corner) => {
      const worldX = groundSurface.pose.position.x + corner.x * cos - corner.y * sin;
      const worldY = groundSurface.pose.position.y + corner.x * sin + corner.y * cos;
      return vec3(worldX, 0, -worldY);
    });
    const color =
      groundSurface.kind === "Grass"
        ? { r: 74, g: 143, b: 78 }
        : { r: 150, g: 154, b: 160 };

    addMeshPrimitive(vertices, [0, 1, 2, 0, 2, 3], color, 1);
  };

  const addSitePrimitive = () => {
    if (!project.site.visible3D || project.site.boundary.length < 3) {
      return;
    }

    const contour = project.site.boundary.map((point) => new Vector2(point.x, point.y));
    const vertices = project.site.boundary.map((point) =>
      vec3(point.x, project.site.elevationM - 0.015, -point.y),
    );
    const indices = ShapeUtils.triangulateShape(contour, []).flat();

    meshes.push({
      kind: "mesh",
      vertices: vertices.map((vertex) => [vertex.x, vertex.y, vertex.z]),
      indices,
      color: rgbToCss({ r: 65, g: 119, b: 67 }),
      opacity: 1,
      castShadow: false,
    });
  };

  const addSolvedRoofMesh = (solvedRoof: SolvedRoof, color: RgbColor, slabId?: string) => {
    solvedRoof.faces.forEach((face) => {
      const faceColor = slabId
        ? getTargetColor("Slab", slabId, color)
        : getTargetColor("RoofFace", face.id, color);
      const faceOpenings = project.roofOpenings.filter(
        (opening) =>
          opening.roofSketchId === solvedRoof.sketchId && opening.roofFaceId === face.id,
      );
      const thicknessM = Math.max(face.thicknessM, 0.01);

      if (faceOpenings.length === 0) {
        const topVertices = face.polygonLocal.map((localPoint) =>
          vec3(
            localPoint.x,
            face.planeOuter.uCoeff * localPoint.x +
              face.planeOuter.vCoeff * localPoint.y +
              face.planeOuter.constantM,
            -localPoint.y,
          ),
        );
        addRoofFaceShell(topVertices, thicknessM, faceColor);
        return;
      }

      const basis = getRoofFaceBasis(face);
      const polygonUv = face.polygonLocal.map((localPoint) => basis.toUv(localPoint));
      const minU = Math.min(...polygonUv.map((point) => point.x));
      const maxU = Math.max(...polygonUv.map((point) => point.x));
      const minV = Math.min(...polygonUv.map((point) => point.y));
      const maxV = Math.max(...polygonUv.map((point) => point.y));
      const openingRects = faceOpenings.map((opening) => {
        const centerUv = basis.toUv(opening.center);
        const { widthM, heightM } = getRoofOpeningDimensions(opening);
        return {
          minU: centerUv.x - widthM / 2,
          maxU: centerUv.x + widthM / 2,
          minV: centerUv.y - heightM / 2,
          maxV: centerUv.y + heightM / 2,
        };
      });
      const uCuts = uniqueSortedCuts([
        minU,
        maxU,
        ...openingRects.flatMap((rect) => [
          clamp(rect.minU, minU, maxU),
          clamp(rect.maxU, minU, maxU),
        ]),
      ]);
      const vCuts = uniqueSortedCuts([
        minV,
        maxV,
        ...openingRects.flatMap((rect) => [
          clamp(rect.minV, minV, maxV),
          clamp(rect.maxV, minV, maxV),
        ]),
      ]);
      const roofCellPolygons: Vec3[][] = [];

      for (let uIndex = 0; uIndex < uCuts.length - 1; uIndex += 1) {
        for (let vIndex = 0; vIndex < vCuts.length - 1; vIndex += 1) {
          const cellMinU = uCuts[uIndex];
          const cellMaxU = uCuts[uIndex + 1];
          const cellMinV = vCuts[vIndex];
          const cellMaxV = vCuts[vIndex + 1];
          if (cellMaxU - cellMinU < 0.001 || cellMaxV - cellMinV < 0.001) {
            continue;
          }

          const intersectsOpening = openingRects.some(
            (rect) =>
              cellMaxU > rect.minU + 0.001 &&
              cellMinU < rect.maxU - 0.001 &&
              cellMaxV > rect.minV + 0.001 &&
              cellMinV < rect.maxV - 0.001,
          );
          if (intersectsOpening) {
            continue;
          }

          const clippedCell = clipPolygonToConvexPolygon(
            [
              createVec2(cellMinU, cellMinV),
              createVec2(cellMaxU, cellMinV),
              createVec2(cellMaxU, cellMaxV),
              createVec2(cellMinU, cellMaxV),
            ],
            polygonUv,
          );
          if (clippedCell.length < 3) {
            continue;
          }

          roofCellPolygons.push(clippedCell.map((point) => basis.fromUv(point)));
        }
      }

      addMergedRoofFaceShell(roofCellPolygons, thicknessM, faceColor);
    });
  };

  const addSlabPrimitive = (slab: Slab, levelElevationM: number, color: RgbColor) => {
    const center = vec3(
      slab.pose.position.x,
      levelElevationM + slab.zOffsetM + slab.thicknessM / 2,
      -slab.pose.position.y,
    );

    if (slab.kind === "Circle") {
      addCylinderPrimitive(center, Math.max(slab.widthM, slab.depthM) / 2, slab.thicknessM, color);
      return;
    }

    if (slab.kind === "Freeform") {
      const polygon = getSlabWorldPolygon(slab);
      if (polygon.length < 3) {
        return;
      }

      const contour = polygon.map((point) => new Vector2(point.x, point.y));
      const triangles = ShapeUtils.triangulateShape(contour, []);
      const bottomM = levelElevationM + slab.zOffsetM;
      const topM = bottomM + slab.thicknessM;
      const topVertices = polygon.map((point) => vec3(point.x, topM, -point.y));
      const bottomVertices = polygon.map((point) => vec3(point.x, bottomM, -point.y));
      const vertices = [...topVertices, ...bottomVertices];
      const indices: number[] = [];

      for (const triangle of triangles) {
        const [first, second, third] = triangle;
        indices.push(first, second, third);
        indices.push(
          polygon.length + first,
          polygon.length + third,
          polygon.length + second,
        );
      }

      for (let index = 0; index < polygon.length; index += 1) {
        const nextIndex = (index + 1) % polygon.length;
        indices.push(
          index,
          nextIndex,
          polygon.length + nextIndex,
          index,
          polygon.length + nextIndex,
          polygon.length + index,
        );
      }

      addMeshPrimitive(vertices, indices, color);
      return;
    }

    if (slab.roofType !== "Flat") {
      const solvedRoof =
        solvedRoofs.find((roof) => roof.sourceKind === "LegacySlab" && roof.slabId === slab.id) ??
        solveRoofFromSlab(slab, levelElevationM);
      if (!solvedRoof) {
        return;
      }

      addSolvedRoofMesh(solvedRoof, shadeColor(color, 0.78), slab.id);
      return;
    }

    addBoxPrimitive(center, slab.widthM, slab.thicknessM, slab.depthM, 0, color);
  };

  const addStairPrimitives = (stair: Stair, levelElevationM: number, color: RgbColor) => {
    if (stair.pathNodes.length < 2) {
      return;
    }

    const segmentDefinitions = stair.pathNodes
      .slice(0, -1)
      .map((startPoint, index) => {
        const endPoint = stair.pathNodes[index + 1];
        const lengthM = Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y);
        return { index, startPoint, endPoint, lengthM };
      })
      .filter((segment) => segment.lengthM > 0.0001);

    if (segmentDefinitions.length === 0) {
      return;
    }

    const landingHalfM = stair.landingLengthM / 2;
    const effectiveSegments = segmentDefinitions.map((segment, index, segments) => {
      const startTrimM = index > 0 ? trimSegmentLengthForLanding(segment.lengthM, landingHalfM) : 0;
      const endTrimM =
        index < segments.length - 1
          ? trimSegmentLengthForLanding(segment.lengthM, landingHalfM)
          : 0;

      return {
        ...segment,
        startTrimM,
        endTrimM,
        effectiveLengthM: Math.max(segment.lengthM - startTrimM - endTrimM, 0),
      };
    });

    const totalEffectiveRunM = effectiveSegments.reduce(
      (sum, segment) => sum + segment.effectiveLengthM,
      0,
    );
    const totalRiseM = stair.endElevationM - levelElevationM;
    const sections = effectiveSegments.filter((segment) => segment.effectiveLengthM > 0.0001);
    const sectionCount = sections.length;
    const totalStepCount = Math.max(
      sectionCount,
      Math.round(Math.abs(totalRiseM) / stair.riserHeightM),
    );
    const stepCounts = sections.map(() => 1);
    let remainingStepCount = Math.max(0, totalStepCount - sectionCount);

    const weightedAdditionalCounts = sections.map((section) => {
      if (remainingStepCount === 0 || totalEffectiveRunM <= 0.0001) {
        return { integer: 0, remainder: 0 };
      }

      const rawAdditional = (section.effectiveLengthM / totalEffectiveRunM) * remainingStepCount;
      const integer = Math.floor(rawAdditional);
      return {
        integer,
        remainder: rawAdditional - integer,
      };
    });

    weightedAdditionalCounts.forEach((allocation, index) => {
      stepCounts[index] += allocation.integer;
      remainingStepCount -= allocation.integer;
    });

    weightedAdditionalCounts
      .map((allocation, index) => ({ ...allocation, index }))
      .sort((left, right) => right.remainder - left.remainder)
      .slice(0, remainingStepCount)
      .forEach((allocation) => {
        stepCounts[allocation.index] += 1;
      });

    let accumulatedElevationM = levelElevationM;
    sections.forEach((section, sectionIndex) => {
      const segmentStepCount = stepCounts[sectionIndex];
      const segmentRiseM =
        totalEffectiveRunM > 0.0001
          ? (totalRiseM * section.effectiveLengthM) / totalEffectiveRunM
          : totalRiseM / sectionCount;
      const stepRiseM = segmentRiseM / segmentStepCount;
      const stepRunM = section.effectiveLengthM / segmentStepCount;

      for (let stepIndex = 0; stepIndex < segmentStepCount; stepIndex += 1) {
        const localStartOffsetM = section.startTrimM + stepRunM * stepIndex;
        const localEndOffsetM = section.startTrimM + stepRunM * (stepIndex + 1);
        const startPoint2D = pointAlong2DSegment(
          section.startPoint,
          section.endPoint,
          localStartOffsetM,
        );
        const endPoint2D = pointAlong2DSegment(
          section.startPoint,
          section.endPoint,
          localEndOffsetM,
        );
        const stepStartElevationM = accumulatedElevationM + stepRiseM * stepIndex;
        const stepEndElevationM = accumulatedElevationM + stepRiseM * (stepIndex + 1);
        const stepBottomElevationM = Math.min(stepStartElevationM, stepEndElevationM);
        const stepHeightM = Math.max(Math.abs(stepEndElevationM - stepStartElevationM), 0.02);

        addSectionBox(
          stair.widthM,
          stepHeightM,
          stepBottomElevationM - levelElevationM,
          toWorldPoint2D(startPoint2D, levelElevationM),
          toWorldPoint2D(endPoint2D, levelElevationM),
          color,
        );
      }

      accumulatedElevationM += segmentRiseM;
    });

    if (stair.pathNodes.length > 2) {
      const platformSizeM = Math.max(stair.widthM, stair.landingLengthM || stair.widthM);
      let consumedRunM = 0;

      effectiveSegments.forEach((segment, index) => {
        consumedRunM += segment.effectiveLengthM;
        const nodeIndex = index + 1;
        if (nodeIndex >= stair.pathNodes.length - 1) {
          return;
        }

        const landingElevationM =
          totalEffectiveRunM > 0.0001
            ? levelElevationM + (totalRiseM * consumedRunM) / totalEffectiveRunM
            : levelElevationM;
        const sectionStepCount = Math.max(stepCounts[Math.min(index, stepCounts.length - 1)] ?? 1, 1);
        const segmentRiseM =
          totalEffectiveRunM > 0.0001
            ? (totalRiseM * segment.effectiveLengthM) / totalEffectiveRunM
            : totalRiseM / Math.max(sections.length, 1);
        const platformHeightM = Math.max(Math.abs(segmentRiseM / sectionStepCount), 0.02);
        const platformBottomM =
          totalRiseM >= 0 ? landingElevationM - platformHeightM : landingElevationM;
        const nodePoint = stair.pathNodes[nodeIndex];

        addBoxPrimitive(
          vec3(nodePoint.x, platformBottomM + platformHeightM / 2, -nodePoint.y),
          platformSizeM,
          platformHeightM,
          platformSizeM,
          0,
          shadeColor(color, 0.94),
        );
      });
    }
  };

  const getTStemMiterOffsets = (
    nodeId: string,
    currentAwayDirection: Vec2,
    currentThicknessM: number,
    sourceWallIdSet: ReadonlySet<string>,
  ) => {
    const neighborInfos = (wallIdsByNodeId.get(nodeId) ?? [])
      .filter((wallId) => !sourceWallIdSet.has(wallId))
      .map((wallId) => wallRenderInfoById.get(wallId))
      .filter((info): info is NonNullable<typeof info> => info !== undefined);

    for (let leftIndex = 0; leftIndex < neighborInfos.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < neighborInfos.length; rightIndex += 1) {
        const left = neighborInfos[leftIndex];
        const right = neighborInfos[rightIndex];
        if (
          areDirectionsCollinear(left.direction, right.direction) &&
          !areDirectionsCollinear(currentAwayDirection, left.direction)
        ) {
          const leftWallType = wallTypeById.get(left.wall.wallTypeId);
          const rightWallType = wallTypeById.get(right.wall.wallTypeId);
          const hostHalfThicknessM = Math.max(
            leftWallType?.thicknessM ?? 0,
            rightWallType?.thicknessM ?? 0,
          ) / 2;
          const hostNormal = rightNormal2(left.direction);
          const denominator =
            currentAwayDirection.x * hostNormal.x +
            currentAwayDirection.y * hostNormal.y;
          if (hostHalfThicknessM <= 0 || Math.abs(denominator) < 0.0001) {
            return null;
          }

          const currentNormal = rightNormal2(currentAwayDirection);
          const currentHalfThicknessM = Math.max(currentThicknessM, 0.01) / 2;
          const hostFaceOffsetM = Math.sign(denominator) * hostHalfThicknessM;
          const offsetForSide = (side: -1 | 1) => {
            const sidePointProjection =
              (currentNormal.x * hostNormal.x + currentNormal.y * hostNormal.y) *
              side *
              currentHalfThicknessM;
            const offsetM = (hostFaceOffsetM - sidePointProjection) / denominator;
            return Number.isFinite(offsetM)
              ? clamp(offsetM, 0, Math.max(currentThicknessM, hostHalfThicknessM * 2) * 8)
              : 0;
          };

          return {
            positiveSideOffsetM: offsetForSide(1),
            negativeSideOffsetM: offsetForSide(-1),
          };
        }
      }
    }

    return null;
  };

  const getNeighborPlanDirection = (neighborWall: Project["walls"][number], nodeId: string) => {
    const currentNode = nodeById.get(nodeId);
    const neighborStartNode = nodeById.get(neighborWall.startNodeId);
    const neighborEndNode = nodeById.get(neighborWall.endNodeId);
    if (!currentNode || !neighborStartNode || !neighborEndNode) {
      return null;
    }

    const otherNode = neighborWall.startNodeId === nodeId ? neighborEndNode : neighborStartNode;
    return getSegmentDirection2D(currentNode.position, otherNode.position);
  };

  const getCornerMiterOffsets = (
    nodeId: string,
    currentAwayDirection: Vec2,
    currentThicknessM: number,
    neighborWall: Project["walls"][number] | null,
  ) => {
    if (!neighborWall) {
      return null;
    }

    const node = nodeById.get(nodeId);
    const neighborDirection = getNeighborPlanDirection(neighborWall, nodeId);
    const neighborWallType = wallTypeById.get(neighborWall.wallTypeId);
    if (!node || !neighborDirection || !neighborWallType) {
      return null;
    }

    const denominator = cross2(currentAwayDirection, neighborDirection);
    if (Math.abs(denominator) < 0.0001) {
      return null;
    }

    // Keep this first pass conservative: only true 90-degree corners get a miter.
    if (Math.abs(currentAwayDirection.x * neighborDirection.x + currentAwayDirection.y * neighborDirection.y) > 0.05) {
      return null;
    }

    const currentNormal = rightNormal2(currentAwayDirection);
    const currentHalfThicknessM = currentThicknessM / 2;
    const neighborHalfThicknessM = neighborWallType.thicknessM / 2;
    const offsetForSide = (side: -1 | 1) => {
      const currentSidePoint = createVec2(
        node.position.x + currentNormal.x * side * currentHalfThicknessM,
        node.position.y + currentNormal.y * side * currentHalfThicknessM,
      );
      const neighborNormal = rightNormal2(neighborDirection);
      const candidates = ([-1, 1] as const).map((neighborSide) => {
        const neighborSidePoint = createVec2(
          node.position.x + neighborNormal.x * neighborSide * neighborHalfThicknessM,
          node.position.y + neighborNormal.y * neighborSide * neighborHalfThicknessM,
        );
        const between = createVec2(
          neighborSidePoint.x - currentSidePoint.x,
          neighborSidePoint.y - currentSidePoint.y,
        );
        return cross2(between, neighborDirection) / denominator;
      });
      const sidePointsIntoCorner =
        (currentNormal.x * side) * neighborDirection.x +
          (currentNormal.y * side) * neighborDirection.y >
        0;

      // The inner face trims toward the corner while the outer face extends
      // to the far neighbor face. Selecting by sign is orientation-independent.
      return sidePointsIntoCorner ? Math.max(...candidates) : Math.min(...candidates);
    };

    return {
      positiveSideOffsetM: offsetForSide(1),
      negativeSideOffsetM: offsetForSide(-1),
    };
  };

  const addWallFinishMeshes = () => {
    const finishOffsetM = 0.002;

    for (const wall of project.walls) {
      const level = levelById.get(wall.levelId);
      const wallType = wallTypeById.get(wall.wallTypeId);
      const startNode = nodeById.get(wall.startNodeId);
      const endNode = nodeById.get(wall.endNodeId);
      if (!level || !wallType || !startNode || !endNode) {
        continue;
      }

      const direction = getSegmentDirection2D(startNode.position, endNode.position);
      if (!direction) {
        continue;
      }

      const finishSides = (["Left", "Right"] as const).flatMap((surface) => {
        const materialId = getTargetMaterialId("Wall", wall.id, surface);
        const material = materialId ? materialById.get(materialId) : null;
        return material
          ? [{ surface, color: hexToRgb(material.colorHex) ?? getBaseSurfaceColor(0, surfaceMode) }]
          : [];
      });
      if (finishSides.length === 0) {
        continue;
      }

      const wallLengthM = Math.hypot(
        endNode.position.x - startNode.position.x,
        endNode.position.y - startNode.position.y,
      );
      const reverseDirection = createVec2(-direction.x, -direction.y);
      const sourceWallIdSet = new Set([wall.id]);
      const startTStemMiterOffsets =
        renderMode === "ArchitecturalJoin"
          ? getTStemMiterOffsets(
              wall.startNodeId,
              direction,
              wallType.thicknessM,
              sourceWallIdSet,
            )
          : null;
      const endTStemMiterOffsets =
        renderMode === "ArchitecturalJoin"
          ? getTStemMiterOffsets(
              wall.endNodeId,
              reverseDirection,
              wallType.thicknessM,
              sourceWallIdSet,
            )
          : null;
      const startNeighborWall =
        renderMode === "ArchitecturalJoin" &&
        !startTStemMiterOffsets &&
        (nodeWallAggregates.get(wall.startNodeId)?.count ?? 0) === 2
          ? project.walls.find(
              (candidate) =>
                candidate.id !== wall.id &&
                (candidate.startNodeId === wall.startNodeId ||
                  candidate.endNodeId === wall.startNodeId),
            ) ?? null
          : null;
      const endNeighborWall =
        renderMode === "ArchitecturalJoin" &&
        !endTStemMiterOffsets &&
        (nodeWallAggregates.get(wall.endNodeId)?.count ?? 0) === 2
          ? project.walls.find(
              (candidate) =>
                candidate.id !== wall.id &&
                (candidate.startNodeId === wall.endNodeId ||
                  candidate.endNodeId === wall.endNodeId),
            ) ?? null
          : null;
      const startCornerMiterOffsets = getCornerMiterOffsets(
        wall.startNodeId,
        direction,
        wallType.thicknessM,
        startNeighborWall,
      );
      const endCornerMiterOffsets = getCornerMiterOffsets(
        wall.endNodeId,
        reverseDirection,
        wallType.thicknessM,
        endNeighborWall,
      );
      const miterProfile: WallMiterProfile = {
        minU: 0,
        maxU: wallLengthM,
        startPositiveSideOffsetM:
          startTStemMiterOffsets?.positiveSideOffsetM ??
          startCornerMiterOffsets?.positiveSideOffsetM ??
          0,
        startNegativeSideOffsetM:
          startTStemMiterOffsets?.negativeSideOffsetM ??
          startCornerMiterOffsets?.negativeSideOffsetM ??
          0,
        endPositiveSideOffsetM: -(
          endTStemMiterOffsets?.negativeSideOffsetM ??
          endCornerMiterOffsets?.negativeSideOffsetM ??
          0
        ),
        endNegativeSideOffsetM: -(
          endTStemMiterOffsets?.positiveSideOffsetM ??
          endCornerMiterOffsets?.positiveSideOffsetM ??
          0
        ),
      };
      const offsetUForSide = (u: number, side: -1 | 1) => {
        if (Math.abs(u) < 0.0001) {
          return u +
            (side === 1
              ? miterProfile.startPositiveSideOffsetM
              : miterProfile.startNegativeSideOffsetM);
        }

        if (Math.abs(u - wallLengthM) < 0.0001) {
          return u +
            (side === 1
              ? miterProfile.endPositiveSideOffsetM
              : miterProfile.endNegativeSideOffsetM);
        }

        return u;
      };
      const wallNormal = rightNormal2(direction);
      const wallHalfThicknessM = Math.max(wallType.thicknessM, 0.01) / 2;
      const openings = wallOpeningsByWallId.get(wall.id) ?? [];
      const matchingRoof =
        wall.topMode === "FollowRoof"
          ? solvedRoofs.find(
              (roof) =>
                solveWallSegmentsAgainstRoof(
                  roof,
                  startNode.position,
                  endNode.position,
                ).length > 0,
            ) ?? null
          : null;
      const roofSegments = matchingRoof
        ? solveWallSegmentsAgainstRoof(
            matchingRoof,
            startNode.position,
            endNode.position,
          )
        : [];
      const roofSegmentsWithOffsets = roofSegments.map((segment) => ({
        ...segment,
        startOffsetM:
          (segment.start.x - startNode.position.x) * direction.x +
          (segment.start.y - startNode.position.y) * direction.y,
        endOffsetM:
          (segment.end.x - startNode.position.x) * direction.x +
          (segment.end.y - startNode.position.y) * direction.y,
      }));
      const stair =
        wall.stairFollowMode !== "None" && wall.stairId
          ? project.stairs.find(
              (candidate) => candidate.id === wall.stairId && candidate.levelId === wall.levelId,
            ) ?? null
          : null;
      const stairSections = stair ? buildStairProfileSections(stair, level.elevationM) : [];
      if (matchingRoof && !stair) {
        const half = wallHalfThicknessM;
        const roofMeshes = buildRoofWallGeometry({
          roof: matchingRoof,
          start: startNode.position,
          direction,
          footprint: [
            createVec2(miterProfile.startNegativeSideOffsetM, -half),
            createVec2(wallLengthM + miterProfile.endNegativeSideOffsetM, -half),
            createVec2(wallLengthM + miterProfile.endPositiveSideOffsetM, half),
            createVec2(miterProfile.startPositiveSideOffsetM, half),
          ],
          bottomM: level.elevationM,
          topM: level.elevationM + wallType.heightM,
          openings: openings.map((opening) => ({
            minU: opening.offsetM - opening.widthM / 2,
            maxU: opening.offsetM + opening.widthM / 2,
            minZ: level.elevationM + (opening.kind === "door" ? 0 : opening.sillHeightM),
            maxZ: level.elevationM + (opening.kind === "door" ? 0 : opening.sillHeightM) + opening.heightM,
          })),
        });
        for (const finish of finishSides) {
          const side = finish.surface === "Left" ? -1 : 1;
          for (const mesh of roofMeshes.filter((candidate) => candidate.surface === finish.surface)) {
            addMeshPrimitive(mesh.vertices.map(([x, y, z]) => vec3(
              x + side * wallNormal.x * finishOffsetM,
              y,
              z - side * wallNormal.y * finishOffsetM,
            )), mesh.indices, finish.color, undefined, { castShadow: false, showEdges: false });
          }
        }
        continue;
      }
      const sampleSpacingM = stair
        ? clamp(stair.treadDepthM / 4, 0.025, 0.075)
        : matchingRoof
          ? 0.15
          : wallLengthM;
      const sampleCount = Math.max(1, Math.ceil(wallLengthM / Math.max(sampleSpacingM, 0.01)));
      const uCuts = uniqueSortedCuts([
        0,
        wallLengthM,
        ...Array.from({ length: sampleCount - 1 }, (_, index) =>
          (wallLengthM * (index + 1)) / sampleCount,
        ),
        ...openings.flatMap((opening) => [
          clamp(opening.offsetM - opening.widthM / 2, 0, wallLengthM),
          clamp(opening.offsetM + opening.widthM / 2, 0, wallLengthM),
        ]),
        ...roofSegmentsWithOffsets.flatMap((segment) => {
          return [
            clamp(segment.startOffsetM, 0, wallLengthM),
            clamp(segment.endOffsetM, 0, wallLengthM),
          ];
        }),
      ]);
      const zCuts = uniqueSortedCuts([
        0,
        wallType.heightM,
        ...openings.flatMap((opening) => [
          clamp(opening.kind === "door" ? 0 : opening.sillHeightM, 0, wallType.heightM),
          clamp(
            opening.kind === "door"
              ? opening.heightM
              : opening.sillHeightM + opening.heightM,
            0,
            wallType.heightM,
          ),
        ]),
      ]);

      for (const finish of finishSides) {
        // Left/right are defined while looking from the wall start toward its end.
        const side: -1 | 1 = finish.surface === "Left" ? -1 : 1;
        const planPointAt = (u: number, includeFinishOffset: boolean) => {
          const adjustedU = offsetUForSide(u, side);
          const normalOffsetM =
            side * (wallHalfThicknessM + (includeFinishOffset ? finishOffsetM : 0));
          return createVec2(
            startNode.position.x + direction.x * adjustedU + wallNormal.x * normalOffsetM,
            startNode.position.y + direction.y * adjustedU + wallNormal.y * normalOffsetM,
          );
        };
        const getBoundsAt = (u: number) => {
          const point = planPointAt(u, false);
          if (stair && stairSections.length > 0) {
            const stairElevationM = getStairTopElevationAtPoint(
              stairSections,
              point,
              wall.stairFollowProfile,
            );
            if (stairElevationM === null) {
              return null;
            }

            const followedHeightM = clamp(
              stairElevationM + wall.stairFollowOffsetM - level.elevationM,
              0,
              wallType.heightM,
            );
            return wall.stairFollowMode === "Bottom"
              ? { bottomM: followedHeightM, topM: wallType.heightM }
              : { bottomM: 0, topM: followedHeightM };
          }

          if (matchingRoof) {
            const centerlinePoint = createVec2(
              startNode.position.x + direction.x * clamp(u, 0, wallLengthM),
              startNode.position.y + direction.y * clamp(u, 0, wallLengthM),
            );
            const segmentHeightM = roofSegmentsWithOffsets.flatMap((segment) => {
              const minOffsetM = Math.min(segment.startOffsetM, segment.endOffsetM);
              const maxOffsetM = Math.max(segment.startOffsetM, segment.endOffsetM);
              if (
                u < minOffsetM - 0.0001 ||
                u > maxOffsetM + 0.0001 ||
                Math.abs(segment.endOffsetM - segment.startOffsetM) < 0.0001
              ) {
                return [];
              }

              const amount = clamp(
                (u - segment.startOffsetM) /
                  (segment.endOffsetM - segment.startOffsetM),
                0,
                1,
              );
              return [
                segment.startHeightM +
                  (segment.endHeightM - segment.startHeightM) * amount,
              ];
            })[0] ?? null;
            const roofHeightM =
              getRoofHeightAtPoint(matchingRoof, point, "inner") ??
              getRoofHeightAtPoint(matchingRoof, centerlinePoint, "inner") ??
              segmentHeightM;
            if (roofHeightM !== null) {
              return {
                bottomM: 0,
                topM: clamp(roofHeightM - level.elevationM, 0, wallType.heightM),
              };
            }

            return null;
          }

          return { bottomM: 0, topM: wallType.heightM };
        };
        const vertices: Vec3[] = [];
        const indices: number[] = [];
        const emitCell = (
          minU: number,
          maxU: number,
          bottomStartM: number,
          bottomEndM: number,
          topStartM: number,
          topEndM: number,
        ) => {
          if (
            maxU <= minU + 0.0001 ||
            Math.max(topStartM, topEndM) <= Math.min(bottomStartM, bottomEndM) + 0.0001
          ) {
            return;
          }

          const startPoint = planPointAt(minU, true);
          const endPoint = planPointAt(maxU, true);
          const offset = vertices.length;
          vertices.push(
            vec3(startPoint.x, level.elevationM + bottomStartM, -startPoint.y),
            vec3(endPoint.x, level.elevationM + bottomEndM, -endPoint.y),
            vec3(endPoint.x, level.elevationM + topEndM, -endPoint.y),
            vec3(startPoint.x, level.elevationM + topStartM, -startPoint.y),
          );
          indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
        };

        for (let uIndex = 0; uIndex < uCuts.length - 1; uIndex += 1) {
          const minU = uCuts[uIndex];
          const maxU = uCuts[uIndex + 1];
          const midU = (minU + maxU) / 2;
          const useSteppedMidpoint = stair && wall.stairFollowProfile === "Stepped";
          const midBounds = getBoundsAt(midU);
          if (!midBounds) {
            continue;
          }
          const startBounds =
            getBoundsAt(useSteppedMidpoint ? midU : minU) ?? midBounds;
          const endBounds =
            getBoundsAt(useSteppedMidpoint ? midU : maxU) ?? midBounds;

          for (let zIndex = 0; zIndex < zCuts.length - 1; zIndex += 1) {
            const minZ = zCuts[zIndex];
            const maxZ = zCuts[zIndex + 1];
            const midZ = (minZ + maxZ) / 2;
            const insideOpening = openings.some((opening) => {
              const openingMinU = opening.offsetM - opening.widthM / 2;
              const openingMaxU = opening.offsetM + opening.widthM / 2;
              const openingMinZ = opening.kind === "door" ? 0 : opening.sillHeightM;
              const openingMaxZ =
                opening.kind === "door"
                  ? opening.heightM
                  : opening.sillHeightM + opening.heightM;
              return (
                midU > openingMinU + 0.0001 &&
                midU < openingMaxU - 0.0001 &&
                midZ > openingMinZ + 0.0001 &&
                midZ < openingMaxZ - 0.0001
              );
            });
            if (insideOpening) {
              continue;
            }

            emitCell(
              minU,
              maxU,
              Math.max(minZ, startBounds.bottomM),
              Math.max(minZ, endBounds.bottomM),
              Math.min(maxZ, startBounds.topM),
              Math.min(maxZ, endBounds.topM),
            );
          }
        }

        if (vertices.length > 0 && indices.length > 0) {
          addMeshPrimitive(vertices, indices, finish.color, undefined, {
            castShadow: false,
            showEdges: false,
          });
        }
      }
    }
  };

  const wallIdsRenderedByUnion = new Set<string>();

  type FlatWallUnionOpening = {
    minU: number;
    maxU: number;
    minZ: number;
    maxZ: number;
  };

  type FlatWallUnionPrism = {
    wallId: string;
    wallHeightM: number;
    halfThicknessM: number;
    start: Vec2;
    direction: Vec2;
    normal: Vec2;
    minU: number;
    maxU: number;
    openings: FlatWallUnionOpening[];
  };

  const addFlatOrthogonalWallUnionMeshes = () => {
    if (renderMode !== "ArchitecturalJoin") {
      return;
    }

    const wallsByUnionKey = new Map<string, RenderWallRun[]>();
    for (const wall of renderWalls) {
      const wallDirection = getSegmentDirection2D(wall.start, wall.end);
      if (
        !wallDirection ||
        wall.topMode === "FollowRoof" ||
        wall.stairFollowMode !== "None" ||
        (Math.abs(wallDirection.x) > 0.0001 && Math.abs(wallDirection.y) > 0.0001)
      ) {
        continue;
      }

      const level = levelById.get(wall.levelId);
      if (!level || !wallTypeById.has(wall.wallTypeId)) {
        continue;
      }

      const sourceWallIdSet = new Set(wall.sourceWallIds);
      const reverseDirection = createVec2(-wallDirection.x, -wallDirection.y);
      const isTStem =
        getTStemMiterOffsets(
          wall.startNodeId,
          wallDirection,
          wallTypeById.get(wall.wallTypeId)?.thicknessM ?? 0.01,
          sourceWallIdSet,
        ) !== null ||
        getTStemMiterOffsets(
          wall.endNodeId,
          reverseDirection,
          wallTypeById.get(wall.wallTypeId)?.thicknessM ?? 0.01,
          sourceWallIdSet,
        ) !== null;
      if (isTStem) {
        continue;
      }

      const unionKey = `${wall.levelId}|${wall.topMode}`;
      const currentWalls = wallsByUnionKey.get(unionKey) ?? [];
      currentWalls.push(wall);
      wallsByUnionKey.set(unionKey, currentWalls);
    }

    const dot2 = (left: Vec2, right: Vec2) => left.x * right.x + left.y * right.y;
    const quantizedCellKey = (xIndex: number, yIndex: number, zIndex: number) =>
      `${xIndex}:${yIndex}:${zIndex}`;
    const toPlanPoint = (prism: FlatWallUnionPrism, u: number, normalOffsetM: number) =>
      createVec2(
        prism.start.x + prism.direction.x * u + prism.normal.x * normalOffsetM,
        prism.start.y + prism.direction.y * u + prism.normal.y * normalOffsetM,
      );
    const containsPlanPoint = (prism: FlatWallUnionPrism, point: Vec2) => {
      const delta = createVec2(point.x - prism.start.x, point.y - prism.start.y);
      const u = dot2(delta, prism.direction);
      const normalOffsetM = dot2(delta, prism.normal);
      return (
        u >= prism.minU - 0.0001 &&
        u <= prism.maxU + 0.0001 &&
        Math.abs(normalOffsetM) <= prism.halfThicknessM + 0.0001
      );
    };
    const isOpeningVoidAt = (prism: FlatWallUnionPrism, point: Vec2, zM: number) => {
      const delta = createVec2(point.x - prism.start.x, point.y - prism.start.y);
      const u = dot2(delta, prism.direction);
      const normalOffsetM = dot2(delta, prism.normal);
      if (Math.abs(normalOffsetM) > prism.halfThicknessM + 0.0001) {
        return false;
      }

      return prism.openings.some(
        (opening) =>
          u > opening.minU + 0.0001 &&
          u < opening.maxU - 0.0001 &&
          zM > opening.minZ + 0.0001 &&
          zM < opening.maxZ - 0.0001,
      );
    };
    const getUnionTopHeightAt = (
      prisms: FlatWallUnionPrism[],
      point: Vec2,
      zM: number,
    ) => {
      let topHeightM: number | null = null;
      for (const prism of prisms) {
        if (!containsPlanPoint(prism, point) || isOpeningVoidAt(prism, point, zM)) {
          continue;
        }

        const prismTopHeightM = prism.wallHeightM;
        if (prismTopHeightM === null || prismTopHeightM < zM - 0.0001) {
          continue;
        }

        topHeightM = Math.max(topHeightM ?? 0, prismTopHeightM);
      }

      return topHeightM;
    };
    const addPlanCutsForLocalBoundary = (
      prism: FlatWallUnionPrism,
      u: number,
      xCuts: number[],
      yCuts: number[],
    ) => {
      const negativeSide = toPlanPoint(prism, u, -prism.halfThicknessM);
      const positiveSide = toPlanPoint(prism, u, prism.halfThicknessM);
      xCuts.push(negativeSide.x, positiveSide.x);
      yCuts.push(negativeSide.y, positiveSide.y);
    };

    for (const walls of wallsByUnionKey.values()) {
      const prisms: FlatWallUnionPrism[] = [];
      const xCuts: number[] = [];
      const yCuts: number[] = [];
      const zCuts: number[] = [];
      const level = levelById.get(walls[0]?.levelId ?? "");
      if (!level) {
        continue;
      }

      for (const wall of walls) {
        const wallDirection = getSegmentDirection2D(wall.start, wall.end);
        const wallType = wallTypeById.get(wall.wallTypeId);
        if (!wallDirection || !wallType) {
          continue;
        }

        const wallLengthM = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
        const startAggregate = nodeWallAggregates.get(wall.startNodeId);
        const endAggregate = nodeWallAggregates.get(wall.endNodeId);
        const startExtensionM =
          (startAggregate?.count ?? 0) > 1 ? (startAggregate?.maxThicknessM ?? wallType.thicknessM) / 2 : 0;
        const endExtensionM =
          (endAggregate?.count ?? 0) > 1 ? (endAggregate?.maxThicknessM ?? wallType.thicknessM) / 2 : 0;
        const minU = -startExtensionM;
        const maxU = wallLengthM + endExtensionM;
        const prism: FlatWallUnionPrism = {
          wallId: wall.id,
          wallHeightM: wallType.heightM,
          halfThicknessM: Math.max(wallType.thicknessM, 0.01) / 2,
          start: wall.start,
          direction: wallDirection,
          normal: rightNormal2(wallDirection),
          minU,
          maxU,
          openings: wall.openings
            .map((opening) => {
              const minOpeningU = clamp(opening.offsetM - opening.widthM / 2, minU, maxU);
              const maxOpeningU = clamp(opening.offsetM + opening.widthM / 2, minU, maxU);
              const minZ = opening.kind === "door" ? 0 : opening.sillHeightM;
              const maxZ =
                opening.kind === "door"
                  ? opening.heightM
                  : opening.sillHeightM + opening.heightM;
              return {
                minU: minOpeningU,
                maxU: maxOpeningU,
                minZ: clamp(minZ, 0, wallType.heightM),
                maxZ: clamp(maxZ, 0, wallType.heightM),
              };
            })
            .filter(
              (opening) =>
                opening.maxU > opening.minU + 0.001 &&
                opening.maxZ > opening.minZ + 0.001,
            ),
        };

        prisms.push(prism);
        zCuts.push(0, prism.wallHeightM);
        addPlanCutsForLocalBoundary(prism, prism.minU, xCuts, yCuts);
        addPlanCutsForLocalBoundary(prism, prism.maxU, xCuts, yCuts);
        for (const opening of prism.openings) {
          addPlanCutsForLocalBoundary(prism, opening.minU, xCuts, yCuts);
          addPlanCutsForLocalBoundary(prism, opening.maxU, xCuts, yCuts);
          zCuts.push(opening.minZ, opening.maxZ);
        }

      }

      const sortedXCuts = uniqueSortedCuts(xCuts);
      const sortedYCuts = uniqueSortedCuts(yCuts);
      const sortedZCuts = uniqueSortedCuts(zCuts);
      if (sortedXCuts.length < 2 || sortedYCuts.length < 2 || sortedZCuts.length < 2) {
        continue;
      }

      const solidCellKeys = new Set<string>();
      for (let xIndex = 0; xIndex < sortedXCuts.length - 1; xIndex += 1) {
        for (let yIndex = 0; yIndex < sortedYCuts.length - 1; yIndex += 1) {
          for (let zIndex = 0; zIndex < sortedZCuts.length - 1; zIndex += 1) {
            const center = createVec2(
              (sortedXCuts[xIndex] + sortedXCuts[xIndex + 1]) / 2,
              (sortedYCuts[yIndex] + sortedYCuts[yIndex + 1]) / 2,
            );
            const centerZ = (sortedZCuts[zIndex] + sortedZCuts[zIndex + 1]) / 2;
            const topHeightM = getUnionTopHeightAt(prisms, center, centerZ);
            if (topHeightM !== null && centerZ <= topHeightM + 0.0001) {
              solidCellKeys.add(quantizedCellKey(xIndex, yIndex, zIndex));
            }
          }
        }
      }

      const vertices: Vec3[] = [];
      const indices: number[] = [];
      const toWorld = (x: number, y: number, z: number) =>
        vec3(x, level.elevationM + z, -y);
      const emitQuad = (corners: Vec3[]) => {
        const offset = vertices.length;
        vertices.push(...corners);
        indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
      };
      const hasSolidCell = (xIndex: number, yIndex: number, zIndex: number) =>
        solidCellKeys.has(quantizedCellKey(xIndex, yIndex, zIndex));
      const topAtCellCorner = (x: number, y: number, fallbackZ: number, layerZ: number) => {
        const topHeightM = getUnionTopHeightAt(prisms, createVec2(x, y), layerZ);
        return clamp(topHeightM ?? fallbackZ, fallbackZ, layerZ);
      };

      for (let xIndex = 0; xIndex < sortedXCuts.length - 1; xIndex += 1) {
        for (let yIndex = 0; yIndex < sortedYCuts.length - 1; yIndex += 1) {
          for (let zIndex = 0; zIndex < sortedZCuts.length - 1; zIndex += 1) {
            if (!hasSolidCell(xIndex, yIndex, zIndex)) {
              continue;
            }

            const x0 = sortedXCuts[xIndex];
            const x1 = sortedXCuts[xIndex + 1];
            const y0 = sortedYCuts[yIndex];
            const y1 = sortedYCuts[yIndex + 1];
            const z0 = sortedZCuts[zIndex];
            const z1 = sortedZCuts[zIndex + 1];
            const topX0Y0 = topAtCellCorner(x0, y0, z0, z1);
            const topX0Y1 = topAtCellCorner(x0, y1, z0, z1);
            const topX1Y0 = topAtCellCorner(x1, y0, z0, z1);
            const topX1Y1 = topAtCellCorner(x1, y1, z0, z1);

            if (!hasSolidCell(xIndex - 1, yIndex, zIndex)) {
              emitQuad([
                toWorld(x0, y0, z0),
                toWorld(x0, y1, z0),
                toWorld(x0, y1, topX0Y1),
                toWorld(x0, y0, topX0Y0),
              ]);
            }
            if (!hasSolidCell(xIndex + 1, yIndex, zIndex)) {
              emitQuad([
                toWorld(x1, y1, z0),
                toWorld(x1, y0, z0),
                toWorld(x1, y0, topX1Y0),
                toWorld(x1, y1, topX1Y1),
              ]);
            }
            if (!hasSolidCell(xIndex, yIndex - 1, zIndex)) {
              emitQuad([
                toWorld(x1, y0, z0),
                toWorld(x0, y0, z0),
                toWorld(x0, y0, topX0Y0),
                toWorld(x1, y0, topX1Y0),
              ]);
            }
            if (!hasSolidCell(xIndex, yIndex + 1, zIndex)) {
              emitQuad([
                toWorld(x0, y1, z0),
                toWorld(x1, y1, z0),
                toWorld(x1, y1, topX1Y1),
                toWorld(x0, y1, topX0Y1),
              ]);
            }
            if (!hasSolidCell(xIndex, yIndex, zIndex - 1)) {
              emitQuad([
                toWorld(x0, y0, z0),
                toWorld(x1, y0, z0),
                toWorld(x1, y1, z0),
                toWorld(x0, y1, z0),
              ]);
            }
            if (!hasSolidCell(xIndex, yIndex, zIndex + 1)) {
              emitQuad([
                toWorld(x0, y1, topX0Y1),
                toWorld(x1, y1, topX1Y1),
                toWorld(x1, y0, topX1Y0),
                toWorld(x0, y0, topX0Y0),
              ]);
            }
          }
        }
      }

      if (vertices.length > 0 && indices.length > 0) {
        addMeshPrimitive(
          vertices,
          indices,
          getBaseSurfaceColor(levelIndexById.get(level.id) ?? 0, surfaceMode),
        );
        for (const prism of prisms) {
          wallIdsRenderedByUnion.add(prism.wallId);
        }
      }
    }
  };


  addFlatOrthogonalWallUnionMeshes();

  for (const wall of renderWalls) {
    if (wallIdsRenderedByUnion.has(wall.id)) {
      continue;
    }

    const level = levelById.get(wall.levelId);
    const wallType = wallTypeById.get(wall.wallTypeId);
    if (!level || !wallType) {
      continue;
    }

    const sourceWallIdSet = new Set(wall.sourceWallIds);
    const startAggregate = nodeWallAggregates.get(wall.startNodeId);
    const endAggregate = nodeWallAggregates.get(wall.endNodeId);
    const startWorld = toWorldPoint2D(wall.start, level.elevationM);
    const endWorld = toWorldPoint2D(wall.end, level.elevationM);
    const startDirection = normalize3(subtract3(endWorld, startWorld));
    const endDirection = normalize3(subtract3(startWorld, endWorld));
    const renderWallDirection = getSegmentDirection2D(wall.start, wall.end) ?? createVec2(1, 0);
    const reverseRenderWallDirection = createVec2(-renderWallDirection.x, -renderWallDirection.y);
    const startTStemMiterOffsets =
      renderMode === "ArchitecturalJoin"
        ? getTStemMiterOffsets(
            wall.startNodeId,
            renderWallDirection,
            wallType.thicknessM,
            sourceWallIdSet,
          )
        : null;
    const endTStemMiterOffsets =
      renderMode === "ArchitecturalJoin"
        ? getTStemMiterOffsets(
            wall.endNodeId,
            reverseRenderWallDirection,
            wallType.thicknessM,
            sourceWallIdSet,
          )
        : null;
    const startFallbackExtensionM =
      renderMode === "ArchitecturalJoin" &&
      (startAggregate?.count ?? 0) > 1 &&
      !startTStemMiterOffsets
        ? (startAggregate?.maxThicknessM ?? wallType.thicknessM) / 2
        : 0;
    const endFallbackExtensionM =
      renderMode === "ArchitecturalJoin" &&
      (endAggregate?.count ?? 0) > 1 &&
      !endTStemMiterOffsets
        ? (endAggregate?.maxThicknessM ?? wallType.thicknessM) / 2
        : 0;
    const startNeighborWall =
      renderMode === "ArchitecturalJoin" && (startAggregate?.count ?? 0) === 2
        ? project.walls.find(
            (candidate) =>
              !sourceWallIdSet.has(candidate.id) &&
              (candidate.startNodeId === wall.startNodeId ||
                candidate.endNodeId === wall.startNodeId),
          ) ?? null
        : null;
    const endNeighborWall =
      renderMode === "ArchitecturalJoin" && (endAggregate?.count ?? 0) === 2
        ? project.walls.find(
            (candidate) =>
              !sourceWallIdSet.has(candidate.id) &&
              (candidate.startNodeId === wall.endNodeId ||
                candidate.endNodeId === wall.endNodeId),
          ) ?? null
        : null;
    const startNeighborDirection =
      startNeighborWall
        ? (() => {
            const neighborStartNode = nodeById.get(startNeighborWall.startNodeId);
            const neighborEndNode = nodeById.get(startNeighborWall.endNodeId);
            if (!neighborStartNode || !neighborEndNode) {
              return null;
            }

            const neighborStartWorld = toWorldPoint2D(neighborStartNode.position, level.elevationM);
            const neighborEndWorld = toWorldPoint2D(neighborEndNode.position, level.elevationM);
            return startNeighborWall.startNodeId === wall.startNodeId
              ? normalize3(subtract3(neighborEndWorld, neighborStartWorld))
              : normalize3(subtract3(neighborStartWorld, neighborEndWorld));
          })()
        : null;
    const endNeighborDirection =
      endNeighborWall
        ? (() => {
            const neighborStartNode = nodeById.get(endNeighborWall.startNodeId);
            const neighborEndNode = nodeById.get(endNeighborWall.endNodeId);
            if (!neighborStartNode || !neighborEndNode) {
              return null;
            }

            const neighborStartWorld = toWorldPoint2D(neighborStartNode.position, level.elevationM);
            const neighborEndWorld = toWorldPoint2D(neighborEndNode.position, level.elevationM);
            return endNeighborWall.startNodeId === wall.endNodeId
              ? normalize3(subtract3(neighborEndWorld, neighborStartWorld))
              : normalize3(subtract3(neighborStartWorld, neighborEndWorld));
          })()
        : null;
    const startMiterOffsets =
      renderMode === "ArchitecturalJoin" && !startTStemMiterOffsets
        ? getCornerMiterOffsets(
            wall.startNodeId,
            renderWallDirection,
            wallType.thicknessM,
            startNeighborWall,
          )
        : null;
    const endMiterOffsets =
      renderMode === "ArchitecturalJoin" && !endTStemMiterOffsets
        ? getCornerMiterOffsets(
            wall.endNodeId,
            reverseRenderWallDirection,
            wallType.thicknessM,
            endNeighborWall,
          )
        : null;
    const startAngularExtensionM =
      startNeighborWall && startNeighborDirection
        ? computeAngularWallExtension(
            startDirection,
            startNeighborDirection,
            wallType.thicknessM,
            wallTypeById.get(startNeighborWall.wallTypeId)?.thicknessM ?? wallType.thicknessM,
          )
        : startFallbackExtensionM;
    const endAngularExtensionM =
      endNeighborWall && endNeighborDirection
        ? computeAngularWallExtension(
            endDirection,
            endNeighborDirection,
            wallType.thicknessM,
            wallTypeById.get(endNeighborWall.wallTypeId)?.thicknessM ?? wallType.thicknessM,
          )
        : endFallbackExtensionM;
    const startExtensionM =
      startTStemMiterOffsets ? 0 : startMiterOffsets ? 0 : startAngularExtensionM;
    const endExtensionM =
      endTStemMiterOffsets ? 0 : endMiterOffsets ? 0 : endAngularExtensionM;

    const wallColor = getBaseSurfaceColor(levelIndexById.get(level.id) ?? 0, surfaceMode);
    const wallDirection = normalize3(subtract3(endWorld, startWorld));
    const wallLengthM = length3(subtract3(endWorld, startWorld));
    const wallMinU = -startExtensionM;
    const wallMaxU = wallLengthM + endExtensionM;
    const wallMiterProfile: WallMiterProfile = {
      minU: wallMinU,
      maxU: wallMaxU,
      startPositiveSideOffsetM:
        startTStemMiterOffsets?.positiveSideOffsetM ??
        startMiterOffsets?.positiveSideOffsetM ??
        0,
      startNegativeSideOffsetM:
        startTStemMiterOffsets?.negativeSideOffsetM ??
        startMiterOffsets?.negativeSideOffsetM ??
        0,
      endPositiveSideOffsetM: -(
        endTStemMiterOffsets?.negativeSideOffsetM ??
        endMiterOffsets?.negativeSideOffsetM ??
        0
      ),
      endNegativeSideOffsetM: -(
        endTStemMiterOffsets?.positiveSideOffsetM ??
        endMiterOffsets?.positiveSideOffsetM ??
        0
      ),
    };
    const wallOpenings = wall.openings
      .slice()
      .sort((left, right) => left.offsetM - right.offsetM);

    if (wall.stairFollowMode !== "None" && wall.stairId) {
      const stair = project.stairs.find(
        (candidate) => candidate.id === wall.stairId && candidate.levelId === wall.levelId,
      );
      if (stair) {
        const stairSections = buildStairProfileSections(stair, level.elevationM);
        if (stairSections.length > 0) {
          const maxWallTopHeightM = level.elevationM + wallType.heightM;
          const sampleSpacingM = clamp(stair.treadDepthM / 4, 0.025, 0.075);
          const sampleCount = Math.max(1, Math.ceil((wallMaxU - wallMinU) / sampleSpacingM));
          const stairWallCells: Parameters<typeof addMergedSlopedWallShell>[0] = [];

          for (let index = 0; index < sampleCount; index += 1) {
            const startOffsetM = wallMinU + ((wallMaxU - wallMinU) * index) / sampleCount;
            const endOffsetM = wallMinU + ((wallMaxU - wallMinU) * (index + 1)) / sampleCount;
            const midpointOffsetM = (startOffsetM + endOffsetM) / 2;
            const getFollowElevationM = (offsetM: number) => {
              const point = createVec2(
                wall.start.x + renderWallDirection.x * offsetM,
                wall.start.y + renderWallDirection.y * offsetM,
              );
              const elevationM = getStairTopElevationAtPoint(
                stairSections,
                point,
                wall.stairFollowProfile,
              );
              return elevationM === null ? null : elevationM + wall.stairFollowOffsetM;
            };
            const midpointElevationM = getFollowElevationM(midpointOffsetM);
            if (midpointElevationM === null) {
              continue;
            }

            const startElevationM =
              wall.stairFollowProfile === "Smooth"
                ? getFollowElevationM(startOffsetM) ?? midpointElevationM
                : midpointElevationM;
            const endElevationM =
              wall.stairFollowProfile === "Smooth"
                ? getFollowElevationM(endOffsetM) ?? midpointElevationM
                : midpointElevationM;
            const bottomStartHeightM =
              wall.stairFollowMode === "Bottom"
                ? Math.min(startElevationM, maxWallTopHeightM)
                : level.elevationM;
            const bottomEndHeightM =
              wall.stairFollowMode === "Bottom"
                ? Math.min(endElevationM, maxWallTopHeightM)
                : level.elevationM;
            const topStartHeightM =
              wall.stairFollowMode === "Bottom"
                ? maxWallTopHeightM
                : Math.max(level.elevationM, Math.min(startElevationM, maxWallTopHeightM));
            const topEndHeightM =
              wall.stairFollowMode === "Bottom"
                ? maxWallTopHeightM
                : Math.max(level.elevationM, Math.min(endElevationM, maxWallTopHeightM));
            if (
              Math.max(topStartHeightM, topEndHeightM) <=
              Math.min(bottomStartHeightM, bottomEndHeightM) + 0.0001
            ) {
              continue;
            }

            stairWallCells.push({
              startOffsetM,
              endOffsetM,
              bottomStartHeightM,
              bottomEndHeightM,
              topStartHeightM,
              topEndHeightM,
            });
          }

          const compactStairWallCells = stairWallCells.reduce<typeof stairWallCells>(
            (compacted, cell) => {
              const previous = compacted[compacted.length - 1];
              if (
                previous &&
                Math.abs(previous.endOffsetM - cell.startOffsetM) < 0.0001 &&
                Math.abs(previous.bottomEndHeightM - cell.bottomStartHeightM) < 0.0001 &&
                Math.abs(previous.bottomStartHeightM - cell.bottomStartHeightM) < 0.0001 &&
                Math.abs(previous.topEndHeightM - cell.topStartHeightM) < 0.0001 &&
                Math.abs(previous.topStartHeightM - cell.topStartHeightM) < 0.0001
              ) {
                previous.endOffsetM = cell.endOffsetM;
                previous.bottomEndHeightM = cell.bottomEndHeightM;
                previous.topEndHeightM = cell.topEndHeightM;
                return compacted;
              }

              compacted.push({ ...cell });
              return compacted;
            },
            [],
          );

          addMergedSlopedWallShell(
            compactStairWallCells,
            wallType.thicknessM,
            startWorld,
            wallDirection,
            wallColor,
            wallMiterProfile,
          );
          continue;
        }
      }
    }

    if (wall.topMode === "FollowRoof") {
      const matchingRoof = solvedRoofs.find((roof) =>
        solveWallSegmentsAgainstRoof(roof, wall.start, wall.end).length > 0,
      );
      if (matchingRoof) {
        const half = Math.max(wallType.thicknessM, 0.01) / 2;
        const roofMeshes = buildRoofWallGeometry({
          roof: matchingRoof,
          start: wall.start,
          direction: renderWallDirection,
          footprint: [
            createVec2(wallMinU + wallMiterProfile.startNegativeSideOffsetM, -half),
            createVec2(wallMaxU + wallMiterProfile.endNegativeSideOffsetM, -half),
            createVec2(wallMaxU + wallMiterProfile.endPositiveSideOffsetM, half),
            createVec2(wallMinU + wallMiterProfile.startPositiveSideOffsetM, half),
          ],
          bottomM: level.elevationM,
          topM: level.elevationM + wallType.heightM,
          openings: wallOpenings.map((opening) => ({
            minU: opening.offsetM - opening.widthM / 2,
            maxU: opening.offsetM + opening.widthM / 2,
            minZ: level.elevationM + (opening.kind === "door" ? 0 : opening.sillHeightM),
            maxZ: level.elevationM + (opening.kind === "door" ? 0 : opening.sillHeightM) + opening.heightM,
          })),
        });
        for (const mesh of roofMeshes) {
          addMeshPrimitive(mesh.vertices.map(([x, y, z]) => vec3(x, y, z)), mesh.indices, wallColor);
        }
        continue;
      }
    }

    if (wallOpenings.length === 0) {
      addMergedWallShell(
        [
          {
            minU: wallMinU,
            maxU: wallMaxU,
            minV: 0,
            maxV: wallType.heightM,
          },
        ],
        wallType.thicknessM,
        startWorld,
        wallDirection,
        wallColor,
        wallMiterProfile,
      );
      continue;
    }

    const openingRects = wallOpenings
      .map((opening) => {
        const minU = opening.offsetM - opening.widthM / 2;
        const maxU = opening.offsetM + opening.widthM / 2;
        const minV = opening.kind === "door" ? 0 : opening.sillHeightM;
        const maxV =
          opening.kind === "door"
            ? opening.heightM
            : opening.sillHeightM + opening.heightM;
        return {
          minU: clamp(minU, wallMinU, wallMaxU),
          maxU: clamp(maxU, wallMinU, wallMaxU),
          minV: clamp(minV, 0, wallType.heightM),
          maxV: clamp(maxV, 0, wallType.heightM),
        };
      })
      .filter(
        (rect) =>
          rect.maxU > rect.minU + 0.001 &&
          rect.maxV > rect.minV + 0.001,
      );
    const uCuts = uniqueSortedCuts([
      wallMinU,
      wallMaxU,
      ...openingRects.flatMap((rect) => [rect.minU, rect.maxU]),
    ]);
    const vCuts = uniqueSortedCuts([
      0,
      wallType.heightM,
      ...openingRects.flatMap((rect) => [rect.minV, rect.maxV]),
    ]);
    const wallCells: Array<{ minU: number; maxU: number; minV: number; maxV: number }> = [];

    for (let uIndex = 0; uIndex < uCuts.length - 1; uIndex += 1) {
      for (let vIndex = 0; vIndex < vCuts.length - 1; vIndex += 1) {
        const cell = {
          minU: uCuts[uIndex],
          maxU: uCuts[uIndex + 1],
          minV: vCuts[vIndex],
          maxV: vCuts[vIndex + 1],
        };
        const intersectsOpening = openingRects.some(
          (rect) =>
            cell.maxU > rect.minU + 0.001 &&
            cell.minU < rect.maxU - 0.001 &&
            cell.maxV > rect.minV + 0.001 &&
            cell.minV < rect.maxV - 0.001,
        );
        if (!intersectsOpening) {
          wallCells.push(cell);
        }
      }
    }

    addMergedWallShell(
      wallCells,
      wallType.thicknessM,
      startWorld,
      wallDirection,
      wallColor,
      wallMiterProfile,
    );
  }

  addWallFinishMeshes();

  if (renderMode === "NodePost") {
    for (const node of project.nodes) {
      const level = levelById.get(node.levelId);
      const aggregate = nodeWallAggregates.get(node.id);
      if (!level || !aggregate || aggregate.count === 0) {
        continue;
      }

      addCylinderPrimitive(
        vec3(
          node.position.x,
          level.elevationM + aggregate.maxHeightM / 2,
          -node.position.y,
        ),
        Math.max(aggregate.maxThicknessM / 2, 0.04),
        aggregate.maxHeightM,
        shadeColor(getBaseSurfaceColor(levelIndexById.get(level.id) ?? 0, surfaceMode), 0.72),
      );
    }
  }

  addSitePrimitive();

  for (const groundSurface of project.groundSurfaces) {
    addGroundSurfacePrimitive(groundSurface);
  }

  for (const stair of project.stairs) {
    const level = levelById.get(stair.levelId);
    if (!level) {
      continue;
    }

    addStairPrimitives(
      stair,
      level.elevationM,
      surfaceMode === "GrayOpaque"
        ? { r: 150, g: 154, b: 160 }
        : { r: 134, g: 196, b: 231 },
    );
  }

  for (const slab of project.slabs) {
    const level = levelById.get(slab.levelId);
    if (!level) {
      continue;
    }

    const fallbackColor = shadeColor(
        getBaseSurfaceColor(levelIndexById.get(level.id) ?? 0, surfaceMode),
        surfaceMode === "GrayOpaque" ? 0.9 : 0.82,
      );
    addSlabPrimitive(slab, level.elevationM, getTargetColor("Slab", slab.id, fallbackColor));
  }

  for (const roof of solvedRoofs) {
    if (roof.sourceKind !== "Sketch") {
      continue;
    }

    if (roof.layerId && hiddenRoofLayerIdSet.has(roof.layerId)) {
      continue;
    }

    addSolvedRoofMesh(
      roof,
      surfaceMode === "GrayOpaque"
        ? { r: 132, g: 136, b: 142 }
        : { r: 186, g: 124, b: 82 },
    );
  }
  for (const shape of project.shapes) {
    const level = levelById.get(shape.levelId);
    if (!level) {
      continue;
    }

    addShapePrimitive(
      shape,
      level.elevationM,
      surfaceMode === "GrayOpaque"
        ? { r: 156, g: 160, b: 166 }
        : shape.kind === "Cylinder"
          ? { r: 110, g: 193, b: 205 }
          : { r: 125, g: 209, b: 185 },
    );
  }

  for (const model of project.externalModels) {
    const level = levelById.get(model.levelId);
    if (!level) {
      continue;
    }

    const position = vec3(model.position.x, level.elevationM + model.zM, -model.position.y);
    markers.push({
      kind: "marker",
      position: [position.x, position.y, position.z],
      color: rgbToCss({ r: 255, g: 139, b: 94 }),
      radius: 0.12,
    });
    registerPoints([
      vec3(position.x - 0.12, position.y - 0.12, position.z - 0.12),
      vec3(position.x + 0.12, position.y + 0.12, position.z + 0.12),
    ]);
  }

  if (worldPoints.length === 0) {
    return {
      boxes,
      cylinders,
      markers,
      meshes,
      target: [0, 0, 0],
      radius: 10,
    };
  }

  const min = vec3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  const max = vec3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
  for (const point of worldPoints) {
    min.x = Math.min(min.x, point.x);
    min.y = Math.min(min.y, point.y);
    min.z = Math.min(min.z, point.z);
    max.x = Math.max(max.x, point.x);
    max.y = Math.max(max.y, point.y);
    max.z = Math.max(max.z, point.z);
  }

  return {
    boxes,
    cylinders,
    markers,
    meshes,
    target: [
      (min.x + max.x) / 2,
      (min.y + max.y) / 2,
      (min.z + max.z) / 2,
    ],
    radius: Math.max(4, length3(subtract3(max, min)) * 0.55),
  };
}
