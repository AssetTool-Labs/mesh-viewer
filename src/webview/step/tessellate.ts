import { Matrix4, ShapeUtils, Vector2, Vector3, Vector4 } from 'three';
import { NURBSCurve } from 'three/examples/jsm/curves/NURBSCurve.js';
import { NURBSSurface } from 'three/examples/jsm/curves/NURBSSurface.js';
import {
  entityArgs,
  isStepEnum,
  isStepRef,
  parsePart21,
  type StepDocument,
  type StepEntity,
  type StepValue,
} from './part21';

export interface StepMeshData {
  readonly name: string;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Float32Array;
  readonly indices: Uint32Array;
}

export interface StepTessellationResult {
  readonly name: string;
  readonly meshes: StepMeshData[];
  readonly faceCount: number;
  readonly skippedFaceCount: number;
  readonly unit: string;
  readonly warnings: string[];
}

interface Placement {
  readonly origin: Vector3;
  readonly x: Vector3;
  readonly y: Vector3;
  readonly z: Vector3;
}

interface Surface {
  readonly type: string;
  readonly periodU?: number;
  readonly periodV?: number;
  pointAt(u: number, v: number): Vector3;
  project(point: Vector3): Vector2;
  normalAt(u: number, v: number): Vector3;
  nativeParameter?(point: Vector2): Vector2;
}

interface FaceMesh {
  readonly positions: number[];
  readonly normals: number[];
  readonly colors: number[];
  readonly indices: number[];
}

interface MutableMeshData extends FaceMesh {
  readonly name: string;
}

interface RepresentationGeometry {
  readonly meshes: StepMeshData[];
  readonly faceCount: number;
  readonly skippedFaceCount: number;
}

interface AssemblyEdge {
  readonly childId: number;
  readonly transform: Matrix4;
}

const DEFAULT_COLOR: readonly [number, number, number] = [0.71, 0.71, 0.71];
const CURVE_SEGMENTS = 32;
const EPSILON = 1e-8;

class StepResolver {
  private readonly warnings = new Set<string>();
  private readonly styledColors = new Map<number, readonly [number, number, number]>();
  private readonly pointCache = new Map<string, Vector3>();
  private readonly directionCache = new Map<number, Vector3>();
  private currentLengthScale: number;
  private readonly sourceUnit: string;

  constructor(private readonly document: StepDocument) {
    const unit = this.resolveLengthUnit();
    this.currentLengthScale = unit.scaleToMillimetres;
    this.sourceUnit = unit.label;
    this.collectStyledColors();
  }

  tessellate(): StepTessellationResult {
    const meshes: StepMeshData[] = [];
    let faceCount = 0;
    let skippedFaceCount = 0;

    const representations = new Map<number, StepEntity>();
    for (const type of ['SHAPE_REPRESENTATION', 'ADVANCED_BREP_SHAPE_REPRESENTATION']) {
      for (const representation of this.document.byType.get(type) ?? []) representations.set(representation.id, representation);
    }
    const names = this.representationNames();
    const children = new Map<number, AssemblyEdge[]>();
    const childIds = new Set<number>();
    for (const relationship of this.document.byType.get('REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION') ?? []) {
      const relationArgs = entityArgs(relationship, 'REPRESENTATION_RELATIONSHIP');
      const transformArgs = entityArgs(relationship, 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION');
      const child = relationArgs && this.refEntity(relationArgs[2]);
      const parent = relationArgs && this.refEntity(relationArgs[3]);
      const transformation = transformArgs && this.refEntity(transformArgs[0]);
      if (!child || !parent || !transformation) continue;
      const childScale = this.resolveLengthUnit(child).scaleToMillimetres;
      const parentScale = this.resolveLengthUnit(parent).scaleToMillimetres;
      let transform: Matrix4 | undefined;
      if (transformation.type === 'ITEM_DEFINED_TRANSFORMATION') {
        const from = this.requireRefEntity(transformation.args[2], `Transformation #${transformation.id} has no source placement.`);
        const to = this.requireRefEntity(transformation.args[3], `Transformation #${transformation.id} has no target placement.`);
        transform = this.placementMatrix(to, parentScale).multiply(this.placementMatrix(from, childScale).invert());
      } else {
        transform = this.cartesianTransformation(transformation, parentScale);
      }
      childIds.add(child.id);
      if (!transform) {
        this.warnings.add(`Assembly transformation type ${transformation.type} is not supported; its child was skipped.`);
        continue;
      }
      const edges = children.get(parent.id) ?? [];
      edges.push({ childId: child.id, transform });
      children.set(parent.id, edges);
    }

    const cache = new Map<number, RepresentationGeometry>();
    const buildRepresentation = (representation: StepEntity): RepresentationGeometry => {
      const cached = cache.get(representation.id);
      if (cached) return cached;
      const previousScale = this.currentLengthScale;
      this.currentLengthScale = this.resolveLengthUnit(representation).scaleToMillimetres;
      const builtMeshes: StepMeshData[] = [];
      let builtFaceCount = 0;
      let builtSkippedCount = 0;
      for (const solid of this.refEntities(representation.args[1]).filter((item) => item.type === 'MANIFOLD_SOLID_BREP')) {
        const shell = this.refEntity(solid.args[1]);
        const faces = this.refEntities(shell?.args[1]);
        const built = this.tessellateFaces(
          faces,
          this.entityName(solid) || names.get(representation.id) || `Solid #${solid.id}`,
          this.colorFor(solid.id),
        );
        builtFaceCount += faces.length;
        builtSkippedCount += built.skipped;
        if (built.mesh.positions.length > 0) builtMeshes.push(built.mesh);
      }
      const geometry = { meshes: builtMeshes, faceCount: builtFaceCount, skippedFaceCount: builtSkippedCount };
      this.currentLengthScale = previousScale;
      cache.set(representation.id, geometry);
      return geometry;
    };

    const visit = (representationId: number, world: Matrix4, path: Set<number>): void => {
      if (path.has(representationId)) {
        this.warnings.add(`Assembly representation #${representationId} contains a cycle.`);
        return;
      }
      const representation = representations.get(representationId);
      if (!representation) return;
      const nextPath = new Set(path).add(representationId);
      const built = buildRepresentation(representation);
      for (const mesh of built.meshes) meshes.push(transformMesh(mesh, world, names.get(representationId)));
      faceCount += built.faceCount;
      skippedFaceCount += built.skippedFaceCount;
      for (const edge of children.get(representationId) ?? []) {
        visit(edge.childId, world.clone().multiply(edge.transform), nextPath);
      }
    };

    const roots = [...representations.values()].filter((representation) => !childIds.has(representation.id));
    for (const root of roots) visit(root.id, new Matrix4(), new Set());

    if (meshes.length === 0) {
      const faces = [...(this.document.byType.get('ADVANCED_FACE') ?? [])];
      const built = this.tessellateFaces(faces, this.productName() || 'STEP');
      faceCount = faces.length;
      skippedFaceCount = built.skipped;
      if (built.mesh.positions.length > 0) meshes.push(built.mesh);
    }

    if (meshes.length === 0) {
      throw new Error(
        `No supported faces could be tessellated. ${[...this.warnings].slice(0, 3).join(' ')}`.trim(),
      );
    }

    return {
      name: this.productName() || 'STEP',
      meshes,
      faceCount,
      skippedFaceCount,
      unit: this.sourceUnit === 'mm' ? 'mm' : `${this.sourceUnit} (normalized to mm)`,
      warnings: [...this.warnings],
    };
  }

  private tessellateFaces(
    faces: readonly StepEntity[],
    name: string,
    fallbackColor: readonly [number, number, number] = DEFAULT_COLOR,
  ): { mesh: StepMeshData; skipped: number } {
    const mesh: MutableMeshData = { name, positions: [], normals: [], colors: [], indices: [] };
    let skipped = 0;
    for (const face of faces) {
      try {
        const faceMesh = this.tessellateFace(face, fallbackColor);
        const base = mesh.positions.length / 3;
        mesh.positions.push(...faceMesh.positions);
        mesh.normals.push(...faceMesh.normals);
        mesh.colors.push(...faceMesh.colors);
        mesh.indices.push(...faceMesh.indices.map((index) => index + base));
      } catch (error) {
        skipped++;
        const detail = error instanceof Error ? error.message : String(error);
        this.warnings.add(`Face #${face.id}: ${detail}`);
      }
    }
    return {
      mesh: {
        name,
        positions: new Float32Array(mesh.positions),
        normals: new Float32Array(mesh.normals),
        colors: new Float32Array(mesh.colors),
        indices: new Uint32Array(mesh.indices),
      },
      skipped,
    };
  }

  private tessellateFace(face: StepEntity, fallbackColor: readonly [number, number, number]): FaceMesh {
    const surfaceEntity = this.requireRefEntity(face.args[2], `Face #${face.id} has no surface.`);
    const surface = this.surface(surfaceEntity);
    const bounds = this.refEntities(face.args[1]);
    if (bounds.length === 0) throw new Error('has no boundary loops.');

    const projected = bounds.map((bound) => {
      const edgeLoop = this.requireRefEntity(bound.args[1], `Boundary #${bound.id} has no edge loop.`);
      const loop = this.edgeLoop(edgeLoop, surfaceEntity, surface);
      let points = loop.points;
      let uv = loop.uv;
      if (isStepEnum(bound.args[2], 'F')) {
        points = points.reverse();
        uv = uv.reverse();
      }
      if (surface.periodU) uv = unwrapPeriodicLoop(uv, 'x', surface.periodU);
      if (surface.periodV) uv = unwrapPeriodicLoop(uv, 'y', surface.periodV);
      return { points, uv, area: signedArea(uv) };
    });

    projected.sort((left, right) => Math.abs(right.area) - Math.abs(left.area));
    const outer = projected[0];
    const holes = projected.slice(1);
    if (surface.periodU) {
      const outerCenter = averageU(outer.uv);
      for (const hole of holes) shiftLoopNear(hole.uv, outerCenter, 'x', surface.periodU);
    }
    if (surface.periodV) {
      const outerCenter = averageCoordinate(outer.uv, 'y');
      for (const hole of holes) shiftLoopNear(hole.uv, outerCenter, 'y', surface.periodV);
    }

    const contour = outer.uv.map((point) => point.clone());
    const holeContours = holes.map((hole) => hole.uv.map((point) => point.clone()));
    let triangles = ShapeUtils.triangulateShape(contour, holeContours);
    if (triangles.length === 0) throw new Error('boundary triangulation produced no triangles.');

    let allUv = [...contour, ...holeContours.flat()];
    ({ points: allUv, triangles } = insertSurfaceCenter(surface, allUv, triangles));
    ({ points: allUv, triangles } = refineSurfaceTriangles(surface, allUv, triangles));
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const sameSense = !isStepEnum(face.args[3], 'F');
    const surfaceRef = face.args[2];
    const color = this.colorFor(face.id)
      ?? (isStepRef(surfaceRef) ? this.colorFor(surfaceRef.id) : undefined)
      ?? fallbackColor;
    for (const uv of allUv) {
      const point = surface.pointAt(uv.x, uv.y);
      const normal = surface.normalAt(uv.x, uv.y).multiplyScalar(sameSense ? 1 : -1).normalize();
      positions.push(point.x, point.y, point.z);
      normals.push(normal.x, normal.y, normal.z);
      colors.push(color[0], color[1], color[2]);
    }

    const indices: number[] = [];
    for (const triangle of triangles) {
      let [a, b, c] = triangle;
      const pa = vectorAt(positions, a);
      const pb = vectorAt(positions, b);
      const pc = vectorAt(positions, c);
      const geometricNormal = pb.sub(pa).cross(pc.sub(pa));
      const expectedNormal = vectorAt(normals, a).add(vectorAt(normals, b)).add(vectorAt(normals, c));
      if (geometricNormal.dot(expectedNormal) < 0) [b, c] = [c, b];
      indices.push(a, b, c);
    }
    return { positions, normals, colors, indices };
  }

  private edgeLoop(loop: StepEntity, surfaceEntity: StepEntity, surface: Surface): { points: Vector3[]; uv: Vector2[] } {
    const orientedEdges = this.refEntities(loop.args[1]);
    const points: Vector3[] = [];
    const uv: Vector2[] = [];
    for (const oriented of orientedEdges) {
      const edge = this.requireRefEntity(oriented.args[3], `Oriented edge #${oriented.id} has no edge curve.`);
      const start = this.pointFromVertex(this.requireRefEntity(edge.args[1], `Edge #${edge.id} has no start vertex.`));
      const end = this.pointFromVertex(this.requireRefEntity(edge.args[2], `Edge #${edge.id} has no end vertex.`));
      const curve = this.requireRefEntity(edge.args[3], `Edge #${edge.id} has no curve geometry.`);
      const sameSense = !isStepEnum(edge.args[4], 'F');
      let sampled = this.sampleCurve(curve, start, end, sameSense);
      let sampledUv = this.samplePCurve(curve, surfaceEntity, surface, sampled, sameSense)
        ?? sampled.map((point) => surface.project(point));
      if (isStepEnum(oriented.args[4], 'F')) {
        sampled = sampled.reverse();
        sampledUv = sampledUv.reverse();
      }
      if (points.length > 0 && sampled.length > 0 && points[points.length - 1].distanceTo(sampled[0]) < EPSILON) {
        sampled = sampled.slice(1);
        sampledUv = sampledUv.slice(1);
      }
      points.push(...sampled);
      uv.push(...sampledUv);
    }
    if (points.length > 2 && points[0].distanceTo(points[points.length - 1]) < EPSILON) {
      points.pop();
      uv.pop();
    }
    if (points.length < 3) throw new Error(`edge loop #${loop.id} has fewer than three distinct points.`);
    return { points, uv };
  }

  private samplePCurve(
    curve: StepEntity,
    surfaceEntity: StepEntity,
    surface: Surface,
    sampled: readonly Vector3[],
    sameSense: boolean,
  ): Vector2[] | undefined {
    if (curve.type !== 'SURFACE_CURVE' && curve.type !== 'SEAM_CURVE') return undefined;
    const pcurve = this.refEntities(curve.args[2]).find((candidate) => {
      const basis = candidate.type === 'PCURVE' ? candidate.args[1] : undefined;
      return isStepRef(basis) && basis.id === surfaceEntity.id;
    });
    const representation = pcurve && this.refEntity(pcurve.args[2]);
    const parameterCurve = representation && this.refEntities(representation.args[1])[0];
    if (!parameterCurve || parameterCurve.type !== 'LINE' || !surface.nativeParameter) return undefined;
    const originEntity = this.refEntity(parameterCurve.args[1]);
    const vector = this.refEntity(parameterCurve.args[2]);
    const directionEntity = vector && this.refEntity(vector.args[1]);
    if (!originEntity || !directionEntity) return undefined;
    const originValues = this.numberList(originEntity.args[1]);
    const directionValues = this.numberList(directionEntity.args[1]);
    const origin = surface.nativeParameter(new Vector2(originValues[0] ?? 0, originValues[1] ?? 0));
    const direction = new Vector2(directionValues[0] ?? 0, directionValues[1] ?? 0)
      .multiplyScalar(sameSense ? 1 : -1);
    const projected = sampled.map((point) => surface.project(point));
    if (surface.periodU) projected.splice(0, projected.length, ...unwrapPeriodicLoop(projected, 'x', surface.periodU));
    if (surface.periodV) projected.splice(0, projected.length, ...unwrapPeriodicLoop(projected, 'y', surface.periodV));
    const axisTolerance = Math.max(Math.abs(direction.x), Math.abs(direction.y)) * 1e-8;
    if (Math.abs(direction.y) <= axisTolerance) {
      for (const point of projected) point.y = origin.y;
    } else if (Math.abs(direction.x) <= axisTolerance) {
      for (const point of projected) point.x = origin.x;
    }
    const first = projected[0];
    const last = projected[projected.length - 1];
    adjustPeriodicEnd(first, last, direction.x, surface.periodU, 'x');
    adjustPeriodicEnd(first, last, direction.y, surface.periodV, 'y');
    return projected;
  }

  private sampleCurve(curve: StepEntity, start: Vector3, end: Vector3, sameSense: boolean): Vector3[] {
    if (curve.type === 'SURFACE_CURVE' || curve.type === 'SEAM_CURVE') {
      return this.sampleCurve(this.requireRefEntity(curve.args[1], `Curve #${curve.id} has no 3D basis curve.`), start, end, sameSense);
    }
    if (curve.type === 'TRIMMED_CURVE') {
      const senseAgreement = !isStepEnum(curve.args[4], 'F');
      return this.sampleCurve(
        this.requireRefEntity(curve.args[1], `Trimmed curve #${curve.id} has no basis curve.`),
        start,
        end,
        sameSense === senseAgreement,
      );
    }
    if (curve.type === 'LINE') return [start.clone(), end.clone()];
    if (curve.type === 'CIRCLE' || curve.type === 'ELLIPSE') {
      const placement = this.placement(this.requireRefEntity(curve.args[1], `Curve #${curve.id} has no placement.`));
      const radiusX = this.number(curve.args[2], `Curve #${curve.id} has no radius.`) * this.currentLengthScale;
      const radiusY = curve.type === 'ELLIPSE'
        ? this.number(curve.args[3], `Ellipse #${curve.id} has no minor radius.`) * this.currentLengthScale
        : radiusX;
      const angleAt = (point: Vector3): number => {
        const relative = point.clone().sub(placement.origin);
        return Math.atan2(relative.dot(placement.y) / radiusY, relative.dot(placement.x) / radiusX);
      };
      const startAngle = angleAt(start);
      let endAngle = angleAt(end);
      const closed = start.distanceTo(end) < EPSILON;
      if (sameSense) {
        while (endAngle <= startAngle + EPSILON) endAngle += Math.PI * 2;
      } else {
        while (endAngle >= startAngle - EPSILON) endAngle -= Math.PI * 2;
      }
      if (!closed && Math.abs(endAngle - startAngle) > Math.PI * 1.999) {
        endAngle += sameSense ? -Math.PI * 2 : Math.PI * 2;
      }
      const count = Math.max(2, Math.ceil((Math.abs(endAngle - startAngle) / (Math.PI * 2)) * CURVE_SEGMENTS));
      const points: Vector3[] = [];
      for (let index = 0; index <= count; index++) {
        const angle = startAngle + ((endAngle - startAngle) * index) / count;
        points.push(
          placement.origin
            .clone()
            .addScaledVector(placement.x, Math.cos(angle) * radiusX)
            .addScaledVector(placement.y, Math.sin(angle) * radiusY),
        );
      }
      points[0] = start.clone();
      points[points.length - 1] = end.clone();
      return points;
    }
    if (entityArgs(curve, 'B_SPLINE_CURVE') || curve.type === 'B_SPLINE_CURVE_WITH_KNOTS') {
      return this.sampleBSplineCurve(curve, start, end, sameSense);
    }

    this.warnings.add(`Curve type ${curve.type} is approximated as a straight edge.`);
    return [start.clone(), end.clone()];
  }

  private sampleBSplineCurve(curve: StepEntity, start: Vector3, end: Vector3, sameSense: boolean): Vector3[] {
    const simple = curve.type === 'B_SPLINE_CURVE_WITH_KNOTS';
    const spline = simple ? curve.args.slice(1, 6) : entityArgs(curve, 'B_SPLINE_CURVE');
    const withKnots = simple ? curve.args.slice(6, 9) : entityArgs(curve, 'B_SPLINE_CURVE_WITH_KNOTS');
    if (!spline || !withKnots) return [start.clone(), end.clone()];
    const degree = this.number(spline[0], `B-spline #${curve.id} has no degree.`);
    const controls = this.refEntities(spline[1]).map((entity) => this.point(entity));
    const multiplicities = this.numberList(withKnots[0]);
    const uniqueKnots = this.numberList(withKnots[1]);
    const knots = expandStepKnots(multiplicities, uniqueKnots);
    validateStepSpline(degree, controls.length, knots.length, `B-spline #${curve.id}`);
    const weights = this.numberList(entityArgs(curve, 'RATIONAL_B_SPLINE_CURVE')?.[0]);
    const controlPoints = controls.map(
      (point, index) => new Vector4(point.x, point.y, point.z, weights[index] ?? 1),
    );
    const nurbs = new NURBSCurve(degree, knots, controlPoints);
    const curvePoint = (parameter: number): Vector3 => nurbs.getPoint(parameter, new Vector3());
    const first = curvePoint(0);
    const last = curvePoint(1);
    const directError = first.distanceTo(start) + last.distanceTo(end);
    const reverseError = first.distanceTo(end) + last.distanceTo(start);
    const minimum = controls[0].clone();
    const maximum = controls[0].clone();
    for (const point of controls) {
      minimum.min(point);
      maximum.max(point);
    }
    const tolerance = Math.max(minimum.distanceTo(maximum) * 0.0025, 0.02);
    if (Math.min(directError, reverseError) <= tolerance * 4) {
      const selected = adaptiveCurvePoints(curvePoint, tolerance);
      if (reverseError < directError) selected.reverse();
      selected[0] = start.clone();
      selected[selected.length - 1] = end.clone();
      return selected;
    }

    const dense = Array.from({ length: CURVE_SEGMENTS * 4 + 1 }, (_, index) => curvePoint(index / (CURVE_SEGMENTS * 4)));
    const startIndex = closestPointIndex(dense, start);
    const endIndex = closestPointIndex(dense, end);
    let selected: Vector3[];
    if (sameSense) {
      selected = startIndex <= endIndex ? dense.slice(startIndex, endIndex + 1) : dense.slice(startIndex).concat(dense.slice(0, endIndex + 1));
    } else {
      selected = startIndex >= endIndex ? dense.slice(endIndex, startIndex + 1).reverse() : dense.slice(endIndex).concat(dense.slice(0, startIndex + 1)).reverse();
    }
    if (selected.length < 2) selected = [start.clone(), end.clone()];
    selected[0] = start.clone();
    selected[selected.length - 1] = end.clone();
    return selected;
  }

  private surface(entity: StepEntity): Surface {
    if (entity.type === 'PLANE') {
      const placement = this.placement(this.requireRefEntity(entity.args[1], `Plane #${entity.id} has no placement.`));
      return {
        type: entity.type,
        periodU: undefined,
        periodV: undefined,
        pointAt: (u, v) => placement.origin.clone().addScaledVector(placement.x, u).addScaledVector(placement.y, v),
        project: (point) => {
          const relative = point.clone().sub(placement.origin);
          return new Vector2(relative.dot(placement.x), relative.dot(placement.y));
        },
        normalAt: () => placement.z.clone(),
        nativeParameter: (point) => point.multiplyScalar(this.currentLengthScale),
      };
    }
    if (entity.type === 'CYLINDRICAL_SURFACE') {
      const placement = this.placement(this.requireRefEntity(entity.args[1], `Cylinder #${entity.id} has no placement.`));
      const radius = this.number(entity.args[2], `Cylinder #${entity.id} has no radius.`) * this.currentLengthScale;
      return {
        type: entity.type,
        periodU: Math.PI * 2,
        periodV: undefined,
        pointAt: (u, v) => placement.origin
          .clone()
          .addScaledVector(placement.x, Math.cos(u) * radius)
          .addScaledVector(placement.y, Math.sin(u) * radius)
          .addScaledVector(placement.z, v),
        project: (point) => {
          const relative = point.clone().sub(placement.origin);
          return new Vector2(Math.atan2(relative.dot(placement.y), relative.dot(placement.x)), relative.dot(placement.z));
        },
        normalAt: (u) => placement.x.clone().multiplyScalar(Math.cos(u)).addScaledVector(placement.y, Math.sin(u)),
        nativeParameter: (point) => new Vector2(point.x, point.y * this.currentLengthScale),
      };
    }
    if (entity.type === 'CONICAL_SURFACE') {
      const placement = this.placement(this.requireRefEntity(entity.args[1], `Cone #${entity.id} has no placement.`));
      const radius = this.number(entity.args[2], `Cone #${entity.id} has no radius.`) * this.currentLengthScale;
      const semiAngle = this.number(entity.args[3], `Cone #${entity.id} has no semi-angle.`);
      const sine = Math.sin(semiAngle);
      const cosine = Math.cos(semiAngle);
      return {
        type: entity.type,
        periodU: Math.PI * 2,
        periodV: undefined,
        pointAt: (u, v) => {
          const radial = placement.x.clone().multiplyScalar(Math.cos(u)).addScaledVector(placement.y, Math.sin(u));
          return placement.origin
            .clone()
            .addScaledVector(radial, radius + v * sine)
            .addScaledVector(placement.z, v * cosine);
        },
        project: (point) => {
          const relative = point.clone().sub(placement.origin);
          const v = Math.abs(cosine) > EPSILON ? relative.dot(placement.z) / cosine : 0;
          return new Vector2(Math.atan2(relative.dot(placement.y), relative.dot(placement.x)), v);
        },
        normalAt: (u) => placement.x
          .clone()
          .multiplyScalar(Math.cos(u) * cosine)
          .addScaledVector(placement.y, Math.sin(u) * cosine)
          .addScaledVector(placement.z, -sine),
        nativeParameter: (point) => new Vector2(point.x, point.y * this.currentLengthScale),
      };
    }
    if (entity.type === 'SPHERICAL_SURFACE') {
      const placement = this.placement(this.requireRefEntity(entity.args[1], `Sphere #${entity.id} has no placement.`));
      const radius = this.number(entity.args[2], `Sphere #${entity.id} has no radius.`) * this.currentLengthScale;
      return {
        type: entity.type,
        periodU: Math.PI * 2,
        periodV: undefined,
        pointAt: (u, v) => {
          const radialScale = Math.cos(v) * radius;
          return placement.origin
            .clone()
            .addScaledVector(placement.x, Math.cos(u) * radialScale)
            .addScaledVector(placement.y, Math.sin(u) * radialScale)
            .addScaledVector(placement.z, Math.sin(v) * radius);
        },
        project: (point) => {
          const relative = point.clone().sub(placement.origin);
          return new Vector2(
            Math.atan2(relative.dot(placement.y), relative.dot(placement.x)),
            Math.asin(clamp(relative.dot(placement.z) / radius, -1, 1)),
          );
        },
        normalAt: (u, v) => new Vector3()
          .addScaledVector(placement.x, Math.cos(u) * Math.cos(v))
          .addScaledVector(placement.y, Math.sin(u) * Math.cos(v))
          .addScaledVector(placement.z, Math.sin(v)),
        nativeParameter: (point) => point,
      };
    }
    if (entity.type === 'TOROIDAL_SURFACE') {
      const placement = this.placement(this.requireRefEntity(entity.args[1], `Torus #${entity.id} has no placement.`));
      const majorRadius = this.number(entity.args[2], `Torus #${entity.id} has no major radius.`) * this.currentLengthScale;
      const minorRadius = this.number(entity.args[3], `Torus #${entity.id} has no minor radius.`) * this.currentLengthScale;
      return {
        type: entity.type,
        periodU: Math.PI * 2,
        periodV: Math.PI * 2,
        pointAt: (u, v) => {
          const radial = placement.x.clone().multiplyScalar(Math.cos(u)).addScaledVector(placement.y, Math.sin(u));
          return placement.origin
            .clone()
            .addScaledVector(radial, majorRadius + minorRadius * Math.cos(v))
            .addScaledVector(placement.z, minorRadius * Math.sin(v));
        },
        project: (point) => {
          const relative = point.clone().sub(placement.origin);
          const x = relative.dot(placement.x);
          const y = relative.dot(placement.y);
          const z = relative.dot(placement.z);
          return new Vector2(Math.atan2(y, x), Math.atan2(z, Math.hypot(x, y) - majorRadius));
        },
        normalAt: (u, v) => placement.x
          .clone()
          .multiplyScalar(Math.cos(u) * Math.cos(v))
          .addScaledVector(placement.y, Math.sin(u) * Math.cos(v))
          .addScaledVector(placement.z, Math.sin(v)),
        nativeParameter: (point) => point,
      };
    }
    if (entity.type === 'SURFACE_OF_REVOLUTION') {
      const profileEntity = this.requireRefEntity(entity.args[1], `Surface #${entity.id} has no generating curve.`);
      const axisEntity = this.requireRefEntity(entity.args[2], `Surface #${entity.id} has no axis placement.`);
      const axisOrigin = this.point(this.requireRefEntity(axisEntity.args[1], `Axis #${axisEntity.id} has no origin.`));
      const axis = this.direction(this.requireRefEntity(axisEntity.args[2], `Axis #${axisEntity.id} has no direction.`));
      const profilePoint = this.curveEvaluator(profileEntity);
      const pointAt = (u: number, v: number): Vector3 => {
        const profile = profilePoint(clamp(v, 0, 1));
        return profile.sub(axisOrigin).applyAxisAngle(axis, u).add(axisOrigin);
      };
      return {
        type: entity.type,
        periodU: Math.PI * 2,
        periodV: undefined,
        pointAt,
        project: (point) => {
          const targetRelative = point.clone().sub(axisOrigin);
          const targetAxial = targetRelative.dot(axis);
          const targetRadialLength = targetRelative.clone().addScaledVector(axis, -targetAxial).length();
          let bestParameter = 0;
          let bestError = Number.POSITIVE_INFINITY;
          for (let index = 0; index <= 96; index++) {
            const parameter = index / 96;
            const candidate = profilePoint(parameter).sub(axisOrigin);
            const axial = candidate.dot(axis);
            const radial = candidate.clone().addScaledVector(axis, -axial).length();
            const error = (axial - targetAxial) ** 2 + (radial - targetRadialLength) ** 2;
            if (error < bestError) {
              bestError = error;
              bestParameter = parameter;
            }
          }
          const base = profilePoint(bestParameter).sub(axisOrigin);
          const baseAxial = base.dot(axis);
          const baseRadial = base.addScaledVector(axis, -baseAxial).normalize();
          const targetRadial = targetRelative.addScaledVector(axis, -targetAxial).normalize();
          const angle = Math.atan2(axis.dot(baseRadial.clone().cross(targetRadial)), baseRadial.dot(targetRadial));
          return new Vector2(angle, bestParameter);
        },
        normalAt: (u, v) => surfaceNormal(pointAt, u, v, true),
      };
    }
    if (entityArgs(entity, 'B_SPLINE_SURFACE') || entity.type === 'B_SPLINE_SURFACE_WITH_KNOTS') {
      return this.bsplineSurface(entity);
    }
    throw new Error(`surface type ${entity.type} is not supported yet.`);
  }

  private bsplineSurface(entity: StepEntity): Surface {
    const simple = entity.type === 'B_SPLINE_SURFACE_WITH_KNOTS';
    const spline = simple ? entity.args.slice(1, 8) : entityArgs(entity, 'B_SPLINE_SURFACE');
    const withKnots = simple ? entity.args.slice(8, 13) : entityArgs(entity, 'B_SPLINE_SURFACE_WITH_KNOTS');
    if (!spline || !withKnots) throw new Error(`B-spline surface #${entity.id} has no knot definition.`);
    const degreeU = this.number(spline[0], `B-spline surface #${entity.id} has no U degree.`);
    const degreeV = this.number(spline[1], `B-spline surface #${entity.id} has no V degree.`);
    const controlRows = Array.isArray(spline[2]) ? spline[2] : [];
    const weightsValue = entityArgs(entity, 'RATIONAL_B_SPLINE_SURFACE')?.[0];
    const weightRows = Array.isArray(weightsValue) ? weightsValue : [];
    const controlPoints = controlRows.map((row, rowIndex) => {
      const controls = this.refEntities(row);
      const weights = this.numberList(weightRows[rowIndex]);
      return controls.map((control, columnIndex) => {
        const point = this.point(control);
        return new Vector4(point.x, point.y, point.z, weights[columnIndex] ?? 1);
      });
    });
    if (controlPoints.length === 0 || controlPoints.some((row) => row.length === 0)) {
      throw new Error(`B-spline surface #${entity.id} has no control points.`);
    }
    const knotsU = expandStepKnots(this.numberList(withKnots[0]), this.numberList(withKnots[2]));
    const knotsV = expandStepKnots(this.numberList(withKnots[1]), this.numberList(withKnots[3]));
    validateStepSpline(degreeU, controlPoints.length, knotsU.length, `B-spline surface #${entity.id} U`);
    validateStepSpline(degreeV, controlPoints[0].length, knotsV.length, `B-spline surface #${entity.id} V`);
    const nurbs = new NURBSSurface(degreeU, degreeV, knotsU, knotsV, controlPoints);
    const pointAt = (u: number, v: number): Vector3 => {
      const target = new Vector3();
      nurbs.getPoint(clamp(u, 0, 1), clamp(v, 0, 1), target);
      return target;
    };
    return {
      type: 'B_SPLINE_SURFACE',
      periodU: undefined,
      periodV: undefined,
      pointAt,
      project: (point) => projectToSurface(pointAt, point),
      normalAt: (u, v) => surfaceNormal(pointAt, u, v),
    };
  }

  private curveEvaluator(entity: StepEntity): (parameter: number) => Vector3 {
    if (entity.type === 'CIRCLE' || entity.type === 'ELLIPSE') {
      const placement = this.placement(this.requireRefEntity(entity.args[1], `Curve #${entity.id} has no placement.`));
      const radiusX = this.number(entity.args[2], `Curve #${entity.id} has no radius.`) * this.currentLengthScale;
      const radiusY = entity.type === 'ELLIPSE'
        ? this.number(entity.args[3], `Ellipse #${entity.id} has no minor radius.`) * this.currentLengthScale
        : radiusX;
      return (parameter) => {
        const angle = parameter * Math.PI * 2;
        return placement.origin
          .clone()
          .addScaledVector(placement.x, Math.cos(angle) * radiusX)
          .addScaledVector(placement.y, Math.sin(angle) * radiusY);
      };
    }
    if (entityArgs(entity, 'B_SPLINE_CURVE') || entity.type === 'B_SPLINE_CURVE_WITH_KNOTS') {
      const simple = entity.type === 'B_SPLINE_CURVE_WITH_KNOTS';
      const spline = simple ? entity.args.slice(1, 6) : entityArgs(entity, 'B_SPLINE_CURVE');
      const withKnots = simple ? entity.args.slice(6, 9) : entityArgs(entity, 'B_SPLINE_CURVE_WITH_KNOTS');
      if (!spline || !withKnots) throw new Error(`B-spline curve #${entity.id} has no knot definition.`);
      const degree = this.number(spline[0], `B-spline curve #${entity.id} has no degree.`);
      const controls = this.refEntities(spline[1]).map((control) => this.point(control));
      const knots = expandStepKnots(this.numberList(withKnots[0]), this.numberList(withKnots[1]));
      validateStepSpline(degree, controls.length, knots.length, `B-spline curve #${entity.id}`);
      const weights = this.numberList(entityArgs(entity, 'RATIONAL_B_SPLINE_CURVE')?.[0]);
      const nurbs = new NURBSCurve(
        degree,
        knots,
        controls.map((point, index) => new Vector4(point.x, point.y, point.z, weights[index] ?? 1)),
      );
      return (parameter) => nurbs.getPoint(clamp(parameter, 0, 1), new Vector3());
    }
    throw new Error(`generating curve type ${entity.type} is not supported.`);
  }

  private placement(entity: StepEntity, scale = this.currentLengthScale): Placement {
    const origin = this.point(
      this.requireRefEntity(entity.args[1], `Placement #${entity.id} has no origin.`),
      scale,
    );
    const z = this.refEntity(entity.args[2]) ? this.direction(this.requireRefEntity(entity.args[2], '')) : new Vector3(0, 0, 1);
    let x = this.refEntity(entity.args[3]) ? this.direction(this.requireRefEntity(entity.args[3], '')) : new Vector3(1, 0, 0);
    x = x.clone().addScaledVector(z, -x.dot(z)).normalize();
    if (x.lengthSq() < EPSILON) x = Math.abs(z.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
    const y = z.clone().cross(x).normalize();
    return { origin, x, y, z };
  }

  private placementMatrix(entity: StepEntity, scale = this.currentLengthScale): Matrix4 {
    const placement = this.placement(entity, scale);
    return new Matrix4().makeBasis(placement.x, placement.y, placement.z).setPosition(placement.origin);
  }

  private cartesianTransformation(entity: StepEntity, scale: number): Matrix4 | undefined {
    const base = entityArgs(entity, 'CARTESIAN_TRANSFORMATION_OPERATOR');
    const direct = entity.type === 'CARTESIAN_TRANSFORMATION_OPERATOR_3D' ? entity.args.slice(1) : undefined;
    const args = base ?? direct;
    if (!args) return undefined;
    const axis1 = this.refEntity(args[0]);
    const axis2 = this.refEntity(args[1]);
    const origin = this.refEntity(args[2]);
    if (!origin) return undefined;
    const x = axis1 ? this.direction(axis1) : new Vector3(1, 0, 0);
    const yHint = axis2 ? this.direction(axis2) : new Vector3(0, 1, 0);
    let zEntity: StepEntity | undefined;
    if (entity.type === 'CARTESIAN_TRANSFORMATION_OPERATOR_3D') zEntity = this.refEntity(entity.args[5]);
    else zEntity = this.refEntity(entityArgs(entity, 'CARTESIAN_TRANSFORMATION_OPERATOR_3D')?.[0]);
    const z = zEntity ? this.direction(zEntity) : x.clone().cross(yHint).normalize();
    const y = z.clone().cross(x).normalize();
    const factor = typeof args[3] === 'number' && Number.isFinite(args[3]) ? args[3] : 1;
    return new Matrix4()
      .makeBasis(x.multiplyScalar(factor), y.multiplyScalar(factor), z.multiplyScalar(factor))
      .setPosition(this.point(origin, scale));
  }

  private pointFromVertex(vertex: StepEntity): Vector3 {
    return this.point(this.requireRefEntity(vertex.args[1], `Vertex #${vertex.id} has no point.`));
  }

  private point(entity: StepEntity, scale = this.currentLengthScale): Vector3 {
    const cacheKey = `${entity.id}:${scale}`;
    const cached = this.pointCache.get(cacheKey);
    if (cached) return cached.clone();
    const coordinates = this.numberList(entity.args[1]);
    const point = new Vector3(coordinates[0] ?? 0, coordinates[1] ?? 0, coordinates[2] ?? 0)
      .multiplyScalar(scale);
    this.pointCache.set(cacheKey, point);
    return point.clone();
  }

  private direction(entity: StepEntity): Vector3 {
    const cached = this.directionCache.get(entity.id);
    if (cached) return cached.clone();
    const ratios = this.numberList(entity.args[1]);
    const direction = new Vector3(ratios[0] ?? 0, ratios[1] ?? 0, ratios[2] ?? 0).normalize();
    this.directionCache.set(entity.id, direction);
    return direction.clone();
  }

  private collectStyledColors(): void {
    for (const styled of this.document.byType.get('STYLED_ITEM') ?? []) {
      const target = styled.args[2];
      if (!isStepRef(target)) continue;
      const queue = this.refEntities(styled.args[1]);
      const visited = new Set<number>();
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current.id)) continue;
        visited.add(current.id);
        if (current.type === 'COLOUR_RGB') {
          this.styledColors.set(target.id, [
            this.number(current.args[1], ''),
            this.number(current.args[2], ''),
            this.number(current.args[3], ''),
          ]);
          break;
        }
        if (current.type === 'DRAUGHTING_PRE_DEFINED_COLOUR') {
          const name = typeof current.args[0] === 'string' ? current.args[0].toLowerCase() : '';
          const named: Record<string, readonly [number, number, number]> = {
            black: [0, 0, 0],
            white: [1, 1, 1],
            red: [1, 0, 0],
            green: [0, 1, 0],
            blue: [0, 0, 1],
            yellow: [1, 1, 0],
            cyan: [0, 1, 1],
            magenta: [1, 0, 1],
          };
          const color = named[name];
          if (color) this.styledColors.set(target.id, color);
          break;
        }
        for (const ref of collectRefs(current.args)) {
          const referenced = this.document.entities.get(ref);
          if (referenced) queue.push(referenced);
        }
      }
    }
  }

  private colorFor(entityId: number): readonly [number, number, number] | undefined {
    return this.styledColors.get(entityId);
  }

  private productName(): string {
    const product = this.document.byType.get('PRODUCT')?.[0];
    return typeof product?.args[0] === 'string' ? product.args[0] : '';
  }

  private representationNames(): Map<number, string> {
    const names = new Map<number, string>();
    for (const relation of this.document.byType.get('SHAPE_DEFINITION_REPRESENTATION') ?? []) {
      const productShape = this.refEntity(relation.args[0]);
      const representation = this.refEntity(relation.args[1]);
      const productDefinition = productShape && this.refEntity(productShape.args[2]);
      const formation = productDefinition && this.refEntity(productDefinition.args[2]);
      const product = formation && this.refEntity(formation.args[2]);
      const name = product && typeof product.args[0] === 'string' ? product.args[0] : '';
      if (representation && name) names.set(representation.id, name);
    }
    return names;
  }

  private resolveLengthUnit(representation?: StepEntity): { label: string; scaleToMillimetres: number } {
    representation ??= this.document.byType.get('ADVANCED_BREP_SHAPE_REPRESENTATION')?.[0]
      ?? this.document.byType.get('SHAPE_REPRESENTATION')?.[0];
    const context = representation ? this.refEntity(representation.args[2]) : undefined;
    const assigned = context ? entityArgs(context, 'GLOBAL_UNIT_ASSIGNED_CONTEXT')?.[0] : undefined;
    const units = this.refEntities(assigned);
    const lengthUnit = units.find((unit) => entityArgs(unit, 'LENGTH_UNIT') !== undefined)
      ?? (this.document.byType.get('LENGTH_UNIT') ?? [])[0];
    return lengthUnit ? this.unitDefinition(lengthUnit, new Set()) : { label: 'model units', scaleToMillimetres: 1 };
  }

  private unitDefinition(
    entity: StepEntity,
    visited: Set<number>,
  ): { label: string; scaleToMillimetres: number } {
    if (visited.has(entity.id)) return { label: 'model units', scaleToMillimetres: 1 };
    visited.add(entity.id);
    const si = entityArgs(entity, 'SI_UNIT');
    if (si && isStepEnum(si[1], 'METRE')) {
      const prefix = isStepEnum(si[0]) ? si[0].value : '';
      const factors: Record<string, number> = {
        EXA: 1e18,
        PETA: 1e15,
        TERA: 1e12,
        GIGA: 1e9,
        MEGA: 1e6,
        KILO: 1e3,
        HECTO: 1e2,
        DECA: 1e1,
        DECI: 1e-1,
        CENTI: 1e-2,
        MILLI: 1e-3,
        MICRO: 1e-6,
        NANO: 1e-9,
      };
      const metres = factors[prefix] ?? 1;
      const labels: Record<string, string> = { MILLI: 'mm', CENTI: 'cm', MICRO: 'µm' };
      return { label: labels[prefix] ?? (prefix ? `${prefix.toLowerCase()}metre` : 'm'), scaleToMillimetres: metres * 1000 };
    }

    const conversion = entityArgs(entity, 'CONVERSION_BASED_UNIT');
    const measure = conversion ? this.refEntity(conversion[1]) : undefined;
    if (conversion && measure) {
      const rawValue = measure.args[0];
      const value = typeof rawValue === 'number'
        ? rawValue
        : typeof rawValue === 'object' && rawValue !== null && !Array.isArray(rawValue) && rawValue.kind === 'call'
          ? this.number(rawValue.args[0], '')
          : 1;
      const base = this.refEntity(measure.args[1]);
      const baseUnit = base ? this.unitDefinition(base, visited) : { label: 'model units', scaleToMillimetres: 1 };
      return {
        label: typeof conversion[0] === 'string' ? conversion[0] : 'converted units',
        scaleToMillimetres: value * baseUnit.scaleToMillimetres,
      };
    }
    return { label: 'model units', scaleToMillimetres: 1 };
  }

  private entityName(entity: StepEntity): string {
    return typeof entity.args[0] === 'string' ? entity.args[0] : '';
  }

  private refEntity(value: StepValue | undefined): StepEntity | undefined {
    return isStepRef(value) ? this.document.entities.get(value.id) : undefined;
  }

  private requireRefEntity(value: StepValue | undefined, message: string): StepEntity {
    const entity = this.refEntity(value);
    if (!entity) throw new Error(message);
    return entity;
  }

  private refEntities(value: StepValue | undefined): StepEntity[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      const entity = this.refEntity(item);
      return entity ? [entity] : [];
    });
  }

  private number(value: StepValue | undefined, message: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(message || 'Expected a finite number.');
    return value;
  }

  private numberList(value: StepValue | undefined): number[] {
    return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : [];
  }
}

export function tessellateStep(source: string): StepTessellationResult {
  return new StepResolver(parsePart21(source)).tessellate();
}

function collectRefs(value: StepValue): number[] {
  if (Array.isArray(value)) return value.flatMap(collectRefs);
  if (isStepRef(value)) return [value.id];
  if (typeof value === 'object' && value !== null && value.kind === 'call') return value.args.flatMap(collectRefs);
  return [];
}

function vectorAt(values: readonly number[], index: number): Vector3 {
  return new Vector3(values[index * 3], values[index * 3 + 1], values[index * 3 + 2]);
}

function closestPointIndex(points: readonly Vector3[], target: Vector3): number {
  let closest = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length; index++) {
    const candidate = points[index].distanceToSquared(target);
    if (candidate < distance) {
      closest = index;
      distance = candidate;
    }
  }
  return closest;
}

function adaptiveCurvePoints(pointAt: (parameter: number) => Vector3, tolerance: number): Vector3[] {
  const points: Vector3[] = [pointAt(0)];
  const append = (startParameter: number, endParameter: number, start: Vector3, end: Vector3, depth: number): void => {
    const middleParameter = (startParameter + endParameter) * 0.5;
    const middle = pointAt(middleParameter);
    const chordMiddle = start.clone().add(end).multiplyScalar(0.5);
    if (depth < 9 && middle.distanceTo(chordMiddle) > tolerance) {
      append(startParameter, middleParameter, start, middle, depth + 1);
      append(middleParameter, endParameter, middle, end, depth + 1);
    } else {
      points.push(end);
    }
  };
  append(0, 1, points[0], pointAt(1), 0);
  return points;
}

function signedArea(points: readonly Vector2[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area * 0.5;
}

function unwrapPeriodicLoop(points: readonly Vector2[], axis: 'x' | 'y', period: number): Vector2[] {
  if (points.length === 0) return [];
  const unwrapped = [points[0].clone()];
  for (let index = 1; index < points.length; index++) {
    const point = points[index].clone();
    while (point[axis] - unwrapped[index - 1][axis] > period * 0.5 + EPSILON) point[axis] -= period;
    while (point[axis] - unwrapped[index - 1][axis] < -period * 0.5 - EPSILON) point[axis] += period;
    unwrapped.push(point);
  }
  return unwrapped;
}

function averageU(points: readonly Vector2[]): number {
  return averageCoordinate(points, 'x');
}

function averageCoordinate(points: readonly Vector2[], axis: 'x' | 'y'): number {
  return points.reduce((sum, point) => sum + point[axis], 0) / Math.max(points.length, 1);
}

function shiftLoopNear(points: readonly Vector2[], target: number, axis: 'x' | 'y', period: number): void {
  const shift = Math.round((target - averageCoordinate(points, axis)) / period) * period;
  for (const point of points) point[axis] += shift;
}

function adjustPeriodicEnd(
  start: Vector2,
  end: Vector2,
  direction: number,
  period: number | undefined,
  axis: 'x' | 'y',
): void {
  if (!period) return;
  if (Math.abs(end[axis] - start[axis]) < EPSILON) {
    end[axis] = start[axis] + (direction < 0 ? -period : period);
    return;
  }
  if (direction >= 0) while (end[axis] < start[axis]) end[axis] += period;
  else while (end[axis] > start[axis]) end[axis] -= period;
}

export function expandStepKnots(multiplicities: readonly number[], values: readonly number[]): number[] {
  if (multiplicities.length === 0 || multiplicities.length !== values.length) {
    throw new Error('B-spline knot values and multiplicities have different lengths.');
  }
  const knots: number[] = [];
  for (let index = 0; index < values.length; index++) {
    const multiplicity = multiplicities[index];
    if (!Number.isSafeInteger(multiplicity) || multiplicity < 1 || multiplicity > 64) {
      throw new Error(`Invalid B-spline knot multiplicity ${multiplicity}.`);
    }
    if (!Number.isFinite(values[index]) || (index > 0 && values[index] < values[index - 1])) {
      throw new Error('B-spline knots must be finite and nondecreasing.');
    }
    if (knots.length + multiplicity > 1_000_000) throw new Error('B-spline knot vector is too large.');
    for (let repeat = 0; repeat < multiplicity; repeat++) knots.push(values[index]);
  }
  return knots;
}

export { parsePart21 } from './part21';

function validateDegree(degree: number, label: string): void {
  if (!Number.isSafeInteger(degree) || degree < 1 || degree > 16) {
    throw new Error(`${label} degree ${degree} is outside the supported range 1–16.`);
  }
}

function validateSplineCardinality(degree: number, controls: number, knots: number, label: string): void {
  if (controls < degree + 1 || controls > 1_000_000 || knots !== controls + degree + 1) {
    throw new Error(`${label} has inconsistent control-point and knot counts.`);
  }
}

export function validateStepSpline(degree: number, controls: number, knots: number, label = 'B-spline'): void {
  validateDegree(degree, label);
  validateSplineCardinality(degree, controls, knots, label);
}

function projectToSurface(pointAt: (u: number, v: number) => Vector3, target: Vector3): Vector2 {
  const divisions = 8;
  let bestU = 0;
  let bestV = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let row = 0; row <= divisions; row++) {
    for (let column = 0; column <= divisions; column++) {
      const u = row / divisions;
      const v = column / divisions;
      const distance = pointAt(u, v).distanceToSquared(target);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestU = u;
        bestV = v;
      }
    }
  }

  for (let iteration = 0; iteration < 12; iteration++) {
    const residual = pointAt(bestU, bestV).sub(target);
    const step = 1e-4;
    const du = pointAt(clamp(bestU + step, 0, 1), bestV)
      .sub(pointAt(clamp(bestU - step, 0, 1), bestV))
      .multiplyScalar(0.5 / step);
    const dv = pointAt(bestU, clamp(bestV + step, 0, 1))
      .sub(pointAt(bestU, clamp(bestV - step, 0, 1)))
      .multiplyScalar(0.5 / step);
    const uu = du.dot(du);
    const uv = du.dot(dv);
    const vv = dv.dot(dv);
    const determinant = uu * vv - uv * uv;
    if (Math.abs(determinant) < 1e-16) break;
    const ru = residual.dot(du);
    const rv = residual.dot(dv);
    const deltaU = (vv * ru - uv * rv) / determinant;
    const deltaV = (uu * rv - uv * ru) / determinant;
    bestU = clamp(bestU - deltaU, 0, 1);
    bestV = clamp(bestV - deltaV, 0, 1);
    if (deltaU * deltaU + deltaV * deltaV < 1e-16) break;
  }
  return new Vector2(bestU, bestV);
}

function surfaceNormal(
  pointAt: (u: number, v: number) => Vector3,
  u: number,
  v: number,
  periodicU = false,
): Vector3 {
  const step = 1e-4;
  const evaluate = (sampleU: number, sampleV: number): Vector3 => {
    const du = pointAt(periodicU ? sampleU + step : clamp(sampleU + step, 0, 1), sampleV)
      .sub(pointAt(periodicU ? sampleU - step : clamp(sampleU - step, 0, 1), sampleV));
    const dv = pointAt(sampleU, clamp(sampleV + step, 0, 1))
      .sub(pointAt(sampleU, clamp(sampleV - step, 0, 1)));
    return du.cross(dv);
  };
  const normal = evaluate(u, v);
  if (normal.lengthSq() > 1e-20) return normal.normalize();
  for (const offset of [1e-3, -1e-3, 1e-2, -1e-2]) {
    const nearby = evaluate(u, clamp(v + offset, 0, 1));
    if (nearby.lengthSq() > 1e-20) return nearby.normalize();
  }
  return new Vector3(0, 0, 1);
}

function refineSurfaceTriangles(
  surface: Surface,
  inputPoints: readonly Vector2[],
  inputTriangles: readonly number[][],
): { points: Vector2[]; triangles: number[][] } {
  if (surface.type === 'PLANE') return { points: [...inputPoints], triangles: [...inputTriangles] };
  const points = inputPoints.map((point) => point.clone());
  let triangles = inputTriangles.map((triangle) => [...triangle]);
  const maximumPasses = surface.type === 'SPHERICAL_SURFACE' || surface.type === 'TOROIDAL_SURFACE' ? 3 : 2;

  for (let pass = 0; pass < maximumPasses; pass++) {
    const shouldRefine = triangles.some(([a, b, c]) =>
      edgeSurfaceError(surface, points[a], points[b]) ||
      edgeSurfaceError(surface, points[b], points[c]) ||
      edgeSurfaceError(surface, points[c], points[a]),
    );
    if (!shouldRefine) break;

    const midpointCache = new Map<string, number>();
    const midpoint = (left: number, right: number): number => {
      const key = left < right ? `${left}:${right}` : `${right}:${left}`;
      const cached = midpointCache.get(key);
      if (cached !== undefined) return cached;
      const index = points.length;
      points.push(points[left].clone().lerp(points[right], 0.5));
      midpointCache.set(key, index);
      return index;
    };
    const refined: number[][] = [];
    for (const [a, b, c] of triangles) {
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      refined.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
    }
    triangles = refined;
  }
  return { points, triangles };
}

function insertSurfaceCenter(
  surface: Surface,
  inputPoints: readonly Vector2[],
  inputTriangles: readonly number[][],
): { points: Vector2[]; triangles: number[][] } {
  if (surface.type === 'PLANE' || inputPoints.length === 0) {
    return { points: [...inputPoints], triangles: [...inputTriangles] };
  }
  const minimum = inputPoints.reduce((result, point) => result.min(point), inputPoints[0].clone());
  const maximum = inputPoints.reduce((result, point) => result.max(point), inputPoints[0].clone());
  const center = minimum.add(maximum).multiplyScalar(0.5);
  const containingIndex = inputTriangles.findIndex(([a, b, c]) =>
    pointInTriangle(center, inputPoints[a], inputPoints[b], inputPoints[c]),
  );
  if (containingIndex < 0) return { points: [...inputPoints], triangles: [...inputTriangles] };
  const points = [...inputPoints, center];
  const centerIndex = points.length - 1;
  const triangles = inputTriangles.map((triangle) => [...triangle]);
  const [a, b, c] = triangles[containingIndex];
  triangles.splice(containingIndex, 1, [a, b, centerIndex], [b, c, centerIndex], [c, a, centerIndex]);
  return { points, triangles };
}

function pointInTriangle(point: Vector2, a: Vector2, b: Vector2, c: Vector2): boolean {
  const area = (left: Vector2, middle: Vector2, right: Vector2): number =>
    (middle.x - left.x) * (right.y - left.y) - (middle.y - left.y) * (right.x - left.x);
  const first = area(a, b, point);
  const second = area(b, c, point);
  const third = area(c, a, point);
  const hasNegative = first < -EPSILON || second < -EPSILON || third < -EPSILON;
  const hasPositive = first > EPSILON || second > EPSILON || third > EPSILON;
  return !(hasNegative && hasPositive);
}

function edgeSurfaceError(surface: Surface, firstUv: Vector2, secondUv: Vector2): boolean {
  const first = surface.pointAt(firstUv.x, firstUv.y);
  const second = surface.pointAt(secondUv.x, secondUv.y);
  const liftedMiddle = surface.pointAt((firstUv.x + secondUv.x) * 0.5, (firstUv.y + secondUv.y) * 0.5);
  const chordMiddle = first.clone().add(second).multiplyScalar(0.5);
  return liftedMiddle.distanceTo(chordMiddle) > Math.max(first.distanceTo(second) * 0.01, 0.02);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function transformMesh(mesh: StepMeshData, transform: Matrix4, instanceName?: string): StepMeshData {
  const positions = new Float32Array(mesh.positions);
  const normals = new Float32Array(mesh.normals);
  for (let index = 0; index < positions.length; index += 3) {
    const point = new Vector3(positions[index], positions[index + 1], positions[index + 2]).applyMatrix4(transform);
    positions[index] = point.x;
    positions[index + 1] = point.y;
    positions[index + 2] = point.z;
    const normal = new Vector3(normals[index], normals[index + 1], normals[index + 2]).transformDirection(transform);
    normals[index] = normal.x;
    normals[index + 1] = normal.y;
    normals[index + 2] = normal.z;
  }
  return {
    name: instanceName || mesh.name,
    positions,
    normals,
    colors: new Float32Array(mesh.colors),
    indices: new Uint32Array(mesh.indices),
  };
}