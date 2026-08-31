const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const esbuild = require('esbuild');
const THREE = require('three');
const { extractZipEntry } = require('./fetch-step-fixtures');

const root = path.resolve(__dirname, '..');
function makeZipEntry(name, content, method) {
  const nameBytes = Buffer.from(name);
  const compressed = method === 8 ? zlib.deflateRawSync(content) : content;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const centralOffset = local.length + nameBytes.length + compressed.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBytes, compressed, central, nameBytes, end]);
}

const zipContent = Buffer.from('STEP fixture');
assert.deepEqual(extractZipEntry(makeZipEntry('stored.step', zipContent, 0), 'stored.step'), zipContent);
assert.deepEqual(extractZipEntry(makeZipEntry('deflated.step', zipContent, 8), 'deflated.step'), zipContent);
assert.throws(() => extractZipEntry(Buffer.alloc(22), 'missing.step'), /no ZIP directory/);
const invalidDirectory = makeZipEntry('bad.step', zipContent, 0);
invalidDirectory.writeUInt32LE(invalidDirectory.length, invalidDirectory.length - 6);
assert.throws(() => extractZipEntry(invalidDirectory, 'bad.step'), /directory is invalid/);
const truncatedEntry = makeZipEntry('truncated.step', zipContent, 0);
const centralOffset = truncatedEntry.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
truncatedEntry.writeUInt32LE(truncatedEntry.length, centralOffset + 20);
assert.throws(() => extractZipEntry(truncatedEntry, 'truncated.step'), /is truncated/);

const fixtures = [
  { file: 'step-cube.stp', faces: 6, meshes: 1, bounds: [[-160, -140, 0], [140, 160, 300]] },
  { file: 'step-rounded-cube.step', faces: 7, meshes: 1, bounds: [[0, 0, 0], [10, 10, 10]], maxTriangles: 80 },
  {
    file: 'step-conical-surface.step',
    faces: 5,
    meshes: 1,
    bounds: [[-19, -13.50632, 13.98605], [-12, 13.51649, 41.01395]],
    tolerance: 0.05,
  },
  { file: 'step-cube-inch.step', faces: 6, meshes: 1, bounds: [[0, 0, 0], [1000, 1000, 1000]] },
  { file: 'step-cube-meter.step', faces: 6, meshes: 1, bounds: [[0, 0, 0], [1000, 1000, 1000]] },
  {
    file: 'step-assembly-ap214.stp',
    faces: 160,
    meshes: 18,
    bounds: [[-10, 0, -4], [190, 150, 80]],
    colors: 5,
  },
  {
    file: 'step-led-5mm.step',
    faces: 25,
    meshes: 3,
    bounds: [[-2.9, -2.89672, -1.575822], [2.9, 2.89672, 8.69679]],
    tolerance: 0.05,
  },
  {
    file: 'step-resistor.step',
    faces: 28,
    meshes: 6,
    bounds: [[-5.25, -1.14692, -4], [5.25, 1.14774, 1.14692]],
    tolerance: 0.05,
  },
  {
    file: 'step-nema17-motor.step',
    faces: 55,
    meshes: 1,
    bounds: [[-21.15, -21.15, 0], [21.15, 21.15, 60.1]],
    tolerance: 0.05,
  },
  {
    file: 'step-nist-ftc08-ap242-tg.stp',
    faces: 273,
    meshes: 2,
    bounds: [[-155.79726, -111.34725, 0], [155.79726, 111.34725, 48.26]],
    exactTriangles: 3370,
    colors: 2,
    tolerance: 0.01,
  },
  {
    file: 'step-occt-screw.step',
    faces: 10,
    meshes: 1,
    bounds: [[-27.81968, -10.8263, -34.56367], [-7.97655, 9.14478, 7.73145]],
    tolerance: 0.05,
  },
];

for (const fixture of fixtures) {
  const filePath = path.join(root, 'test_data', fixture.file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing STEP fixture: ${filePath}. See test_data/SOURCES.md.`);
  }
}

const built = esbuild.buildSync({
  entryPoints: [path.join(root, 'src/webview/step/tessellate.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const compiled = { exports: {} };
new Function('module', 'exports', 'require', built.outputFiles[0].text)(compiled, compiled.exports, require);
const {
  buildSurfaceRectangle,
  expandStepKnots,
  parsePart21,
  projectTorusLocal,
  rectangleCoordinates,
  tessellateStep,
  validateStepSpline,
} = compiled.exports;
const spindleU = 0.7;
const spindleV = Math.PI;
const spindleRadius = 1 + 2 * Math.cos(spindleV);
const projectedSpindle = projectTorusLocal(
  spindleRadius * Math.cos(spindleU),
  spindleRadius * Math.sin(spindleU),
  2 * Math.sin(spindleV),
  1,
  2,
  { axis: 'y', value: spindleV },
);
assert.ok(
  Math.abs(Math.atan2(Math.sin(projectedSpindle.x - spindleU), Math.cos(projectedSpindle.x - spindleU))) <= 1e-12,
  'negative-radius torus branch preserves periodic u',
);
assert.ok(Math.abs(projectedSpindle.y - spindleV) <= 1e-12, 'negative-radius torus branch preserves v');
const singularV = Math.acos(-0.5);
const projectedSingularity = projectTorusLocal(0, 0, 2 * Math.sin(singularV), 1, 2, {
  axis: 'y',
  value: singularV,
  companion: 1.25,
});
assert.equal(projectedSingularity.x, 1.25, 'spindle-torus singularity preserves declared u');
assert.equal(projectedSingularity.y, singularV, 'spindle-torus singularity preserves declared v');
const textBuilt = esbuild.buildSync({
  entryPoints: [path.join(root, 'src/webview/textEncoding.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const textCompiled = { exports: {} };
new Function('module', 'exports', 'require', textBuilt.outputFiles[0].text)(textCompiled, textCompiled.exports, require);
const workerSourceBuilt = esbuild.buildSync({
  entryPoints: [path.join(root, 'src/webview/step/workerSource.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const workerSourceCompiled = { exports: {} };
new Function('module', 'exports', 'require', workerSourceBuilt.outputFiles[0].text)(
  workerSourceCompiled,
  workerSourceCompiled.exports,
  require,
);
assert.throws(() => tessellateStep(''), /Not an ISO-10303-21 STEP file/);
assert.throws(() => tessellateStep('ISO-10303-21; HEADER; ENDSEC; DATA; ENDSEC; END-ISO-10303-21;'), /contains no entities/);
assert.throws(() => expandStepKnots([65], [0]), /Invalid B-spline knot multiplicity/);
assert.throws(() => expandStepKnots([2], [Number.NaN]), /finite and nondecreasing/);
assert.throws(() => validateStepSpline(99, 100, 200), /outside the supported range/);
assert.throws(() => validateStepSpline(3, 4, 7), /inconsistent control-point and knot counts/);
assert.deepEqual(
  rectangleCoordinates(
    [new THREE.Vector2(0, 0), new THREE.Vector2(0.1, 0), new THREE.Vector2(0.4, 0), new THREE.Vector2(1, 0)],
    'x',
    0,
    1,
    1e-6,
  ),
  [0, 0.1, 0.4, 1],
  'structured grids preserve nonuniform source coordinates',
);
const denseRectangle = Array.from({ length: 513 }, (_, index) => new THREE.Vector2(index / 512, 0))
  .concat([new THREE.Vector2(1, 1), new THREE.Vector2(0, 1)]);
assert.equal(
  buildSurfaceRectangle({ type: 'CYLINDRICAL_SURFACE', periodU: Math.PI * 2 }, denseRectangle, [], undefined),
  undefined,
  'structured grids reject excessive coordinate counts',
);
const productCoordinates = Array.from({ length: 317 }, (_, index) => index / 316);
const denseProductRectangle = productCoordinates.map((x) => new THREE.Vector2(x, 0))
  .concat(productCoordinates.slice(1).map((y) => new THREE.Vector2(1, y)))
  .concat(productCoordinates.slice(0, -1).reverse().map((x) => new THREE.Vector2(x, 1)))
  .concat(productCoordinates.slice(1, -1).reverse().map((y) => new THREE.Vector2(0, y)));
assert.equal(
  buildSurfaceRectangle({ type: 'CYLINDRICAL_SURFACE', periodU: Math.PI * 2 }, denseProductRectangle, [], undefined),
  undefined,
  'structured grids reject excessive point products',
);
const nearFullAngle = Math.PI * 1.95;
const nearFullCylinder = buildSurfaceRectangle(
  { type: 'CYLINDRICAL_SURFACE', periodU: Math.PI * 2 },
  [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(nearFullAngle, 0),
    new THREE.Vector2(nearFullAngle, 1),
    new THREE.Vector2(0, 1),
  ],
  [],
  undefined,
);
assert.ok(nearFullCylinder, 'near-full cylinder uses a structured grid');
assert.equal(
  Math.max(...nearFullCylinder.points.map((point) => point.x)),
  nearFullAngle,
  'near-full cylinder preserves its trimmed angular span',
);

const binaryDocument = parsePart21('ISO-10303-21; DATA; #1=PROPERTY_DEFINITION(\'binary\',"0aFF",$); ENDSEC; END-ISO-10303-21;');
assert.deepEqual(binaryDocument.entities.get(1).args[1], { kind: 'binary', value: '0AFF' });
const latin1Bytes = Uint8Array.from([
  ...Buffer.from("ISO-10303-21; DATA; #1=PRODUCT('Pi"),
  0xe8,
  ...Buffer.from("ce','','',()); ENDSEC; END-ISO-10303-21;"),
]);
assert.equal(parsePart21(textCompiled.exports.decodeText(latin1Bytes.buffer)).entities.get(1).type, 'PRODUCT');

const trimmedSemicircle = `ISO-10303-21;
DATA;
#1=CARTESIAN_POINT('',(1.,0.,0.));
#2=CARTESIAN_POINT('',(-1.,0.,0.));
#3=VERTEX_POINT('',#1);
#4=VERTEX_POINT('',#2);
#5=CARTESIAN_POINT('',(0.,0.,0.));
#6=DIRECTION('',(0.,0.,1.));
#7=DIRECTION('',(1.,0.,0.));
#8=AXIS2_PLACEMENT_3D('',#5,#6,#7);
#9=CIRCLE('',#8,1.);
#10=TRIMMED_CURVE('',#9,(#1),(#2),.F.,.CARTESIAN.);
#11=EDGE_CURVE('',#3,#4,#10,.T.);
#12=ORIENTED_EDGE('',*,*,#11,.T.);
#13=VECTOR('',#7,1.);
#14=LINE('',#2,#13);
#15=EDGE_CURVE('',#4,#3,#14,.T.);
#16=ORIENTED_EDGE('',*,*,#15,.T.);
#17=EDGE_LOOP('',(#12,#16));
#18=FACE_OUTER_BOUND('',#17,.T.);
#19=PLANE('',#8);
#20=ADVANCED_FACE('',(#18),#19,.T.);
#21=CLOSED_SHELL('',(#20));
#22=MANIFOLD_SOLID_BREP('',#21);
#23=GEOMETRIC_REPRESENTATION_CONTEXT(3);
#24=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#22),#23);
ENDSEC;
END-ISO-10303-21;`;
const tessellatedStripAndFan = `ISO-10303-21;
DATA;
#1=COORDINATES_LIST('',5,((0.,0.,0.),(1.,0.,0.),(1.,1.,0.),(0.,1.,0.),(.5,.5,1.)));
#2=COMPLEX_TRIANGULATED_FACE('',#1,5,((0.,0.,1.)),$,(1,2,3,4,5),((1,2,3,4)),((5,1,2,3)));
#3=TESSELLATED_SOLID('',(#2),$);
#4=GEOMETRIC_REPRESENTATION_CONTEXT(3);
#5=TESSELLATED_SHAPE_REPRESENTATION('',(#3),#4);
ENDSEC;
END-ISO-10303-21;`;
const tessellatedResult = tessellateStep(tessellatedStripAndFan);
assert.equal(tessellatedResult.faceCount, 1, 'tessellated body face count');
assert.equal(tessellatedResult.meshes[0].indices.length / 3, 4, 'triangle strips and fans are expanded');
assert.deepEqual(
  Array.from(tessellatedResult.meshes[0].indices),
  [0, 1, 2, 2, 3, 1, 4, 0, 1, 4, 1, 2],
  'triangle strips alternate winding and fans retain their center',
);
assert.ok(tessellatedResult.meshes[0].normals.every(Number.isFinite), 'tessellated normals are finite');
assert.ok(
  Array.from(tessellatedResult.meshes[0].normals).every((value, index) => index % 3 === 2 ? value === 1 : value === 0),
  'tessellated faces preserve authored normals',
);
assert.throws(
  () => tessellateStep(tessellatedStripAndFan.replace('((1,2,3,4))', '((1,2,.5,4))')),
  /invalid triangle strip/,
  'malformed tessellated indices fail cleanly',
);
assert.throws(
  () => tessellateStep(tessellatedStripAndFan.replace('((1,2,3,4))', '$')),
  /invalid triangle strips/,
  'malformed tessellated strip containers fail cleanly',
);
assert.throws(
  () => tessellateStep(tessellatedStripAndFan.replace('((1,2,3,4))', '((1,2))')),
  /invalid triangle strips/,
  'short tessellated strip groups fail cleanly',
);
assert.throws(
  () => tessellateStep(tessellatedStripAndFan.replace("#2=COMPLEX_TRIANGULATED_FACE('',#1,5,", "#2=COMPLEX_TRIANGULATED_FACE('',#1,5.5,")),
  /invalid point count/,
  'noninteger tessellated point counts fail cleanly',
);
assert.throws(
  () => tessellateStep(tessellatedStripAndFan.replace("#1=COORDINATES_LIST('',5,", "#1=COORDINATES_LIST('',6,")),
  /point count does not match its coordinates/,
  'coordinate lists validate their declared point count',
);
const implicitTessellated = tessellateStep(tessellatedStripAndFan.replace('(1,2,3,4,5),((1,2,3,4))', '(),((1,2,3,4))'));
assert.equal(implicitTessellated.meshes[0].indices.length / 3, 4, 'implicit tessellated point indices use coordinate order');
assert.throws(
  () => tessellateStep(tessellatedStripAndFan
    .replace("#2=COMPLEX_TRIANGULATED_FACE('',#1,5,", "#2=COMPLEX_TRIANGULATED_FACE('',#1,6,")
    .replace('(1,2,3,4,5),((1,2,3,4))', '(),((1,2,3,4))')),
  /implicit point count does not match/,
  'implicit tessellated point counts must match their coordinate list',
);
assert.throws(
  () => tessellateStep(tessellatedStripAndFan
    .replace("#2=COMPLEX_TRIANGULATED_FACE('',#1,5,", "#2=COMPLEX_TRIANGULATED_FACE('',#1,6,")
    .replace('(1,2,3,4,5),((1,2,3,4))', '(1,2,3,4,5,99),((1,2,3,4))')),
  /outside its coordinate list/,
  'unused out-of-range point mappings fail cleanly',
);
const reversedTessellated = tessellateStep(tessellatedStripAndFan.replace('((1,2,3,4))', '((1,3,2))'));
for (let index = 0; index < reversedTessellated.meshes[0].indices.length; index += 3) {
  const [a, b, c] = Array.from(reversedTessellated.meshes[0].indices.slice(index, index + 3));
  const positions = reversedTessellated.meshes[0].positions;
  const normal = new THREE.Vector3().fromArray(positions, b * 3)
    .sub(new THREE.Vector3().fromArray(positions, a * 3))
    .cross(new THREE.Vector3().fromArray(positions, c * 3).sub(new THREE.Vector3().fromArray(positions, a * 3)));
  assert.ok(normal.z > 0, 'authored normals correct reversed tessellated winding');
}
const perPointNormals = tessellateStep(tessellatedStripAndFan.replace(
  '((0.,0.,1.)),$,(1,2,3,4,5)',
  '((0.,0.,1.),(0.,0.,1.),(0.,0.,1.),(0.,0.,1.),(0.,0.,1.)),$,(1,2,3,4,5)',
));
assert.deepEqual(perPointNormals.meshes[0].normals, tessellatedResult.meshes[0].normals, 'per-point tessellated normals are preserved');
const computedNormals = tessellateStep(tessellatedStripAndFan.replace('((0.,0.,1.)),$', '(),$'));
assert.ok(computedNormals.meshes[0].normals.every(Number.isFinite), 'missing tessellated normals are computed');
const duplicateTessellatedRepresentation = tessellateStep(tessellatedStripAndFan.replace(
  '#5=TESSELLATED_SHAPE_REPRESENTATION',
  "#6=SHAPE_REPRESENTATION('',(#3),#4);\n#5=TESSELLATED_SHAPE_REPRESENTATION",
));
assert.equal(duplicateTessellatedRepresentation.meshes.length, 1, 'equivalent representations emit a tessellated body once');
assert.equal(duplicateTessellatedRepresentation.faceCount, 1, 'equivalent representations count tessellated faces once');
const differentlyScaledRepresentations = tessellateStep(tessellatedStripAndFan
  .replace('#4=GEOMETRIC_REPRESENTATION_CONTEXT(3);', "#4=(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#7)));\n#7=(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.));\n#8=(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#9)));\n#9=(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT($,.METRE.));")
  .replace('#5=TESSELLATED_SHAPE_REPRESENTATION', "#6=SHAPE_REPRESENTATION('',(#3),#8);\n#5=TESSELLATED_SHAPE_REPRESENTATION"));
assert.equal(differentlyScaledRepresentations.meshes.length, 2, 'different representation unit contexts retain both body instances');
assert.ok(
  Math.max(...differentlyScaledRepresentations.meshes.map((mesh) => Math.max(...mesh.positions))) >= 1_000,
  'representation unit contexts apply distinct scales',
);
const trimmedResult = tessellateStep(trimmedSemicircle);
assert.equal(trimmedResult.unit, 'model units', 'missing STEP length units remain labeled as model units');
const trimmedPositions = Array.from(trimmedResult.meshes[0].positions);
const trimmedY = trimmedPositions.filter((_, index) => index % 3 === 1);
assert.ok(Math.min(...trimmedY) < -0.99, 'trimmed curve follows reversed basis direction');
assert.ok(Math.max(...trimmedY) < 0.01, 'trimmed curve does not use the opposite semicircle');
assert.throws(
  () => tessellateStep(trimmedSemicircle.replace("#9=CIRCLE('',#8,1.);", "#9=CIRCLE('',#8,0.);")),
  /positive radii/,
  'zero-radius circles fail cleanly',
);
const alternateRepresentation = tessellateStep(
  trimmedSemicircle.replace('ADVANCED_BREP_SHAPE_REPRESENTATION', 'MANIFOLD_SURFACE_SHAPE_REPRESENTATION'),
);
assert.equal(alternateRepresentation.meshes.length, 1, 'shape-representation subtypes are traversed');
const complexManifold = tessellateStep(trimmedSemicircle
  .replace("#22=MANIFOLD_SOLID_BREP('',#21);", "#22=(MANIFOLD_SOLID_BREP(#21) REPRESENTATION_ITEM(''));"));
assert.equal(complexManifold.meshes.length, 1, 'complex manifold B-reps resolve their closed shell');
const mixedBody = tessellateStep(trimmedSemicircle
  .replace("#24=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#22),#23);", "#24=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#22,#25),#23);\n#25=FACETED_BREP('',#21);"));
assert.equal(mixedBody.meshes.length, 1, 'supported bodies remain visible in mixed representations');
assert.equal(mixedBody.skippedBodyCount, 1, 'unsupported bodies are reported');
assert.ok(mixedBody.warnings.some((warning) => warning.includes('FACETED_BREP')), 'unsupported body warning names its type');
const surfaceModelBody = tessellateStep(trimmedSemicircle
  .replace("#24=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#22),#23);", "#24=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#22,#25),#23);\n#25=FACE_BASED_SURFACE_MODEL('',());"));
assert.equal(surfaceModelBody.skippedBodyCount, 1, 'unsupported surface-model bodies are reported');
for (const body of [
  "BREP_WITH_VOIDS('',#21,())",
  "CSG_SOLID('',#21)",
  "EXTRUDED_AREA_SOLID('',#21,#8,1.)",
]) {
  const result = tessellateStep(trimmedSemicircle
    .replace("#24=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#22),#23);", `#24=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#22,#25),#23);\n#25=${body};`));
  assert.equal(result.skippedBodyCount, 1, `${body.split('(')[0]} bodies are reported`);
}
const complexVoids = tessellateStep(trimmedSemicircle
  .replace("#24=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#22),#23);", "#24=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#22,#25),#23);")
  .replace('ENDSEC;', "#25=(BREP_WITH_VOIDS(#21,()) MANIFOLD_SOLID_BREP(#21) REPRESENTATION_ITEM(''));\nENDSEC;"));
assert.equal(complexVoids.skippedBodyCount, 1, 'complex B-reps with voids are reported before manifold handling');

const assemblySource = fs.readFileSync(path.join(root, 'test_data', 'step-assembly-ap214.stp'), 'utf8');
const mixedUnitSource = assemblySource.replace(
  '#1116 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );',
  '#1116 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT($,.METRE.) );',
);
assert.notEqual(mixedUnitSource, assemblySource, 'mixed-unit fixture mutation');
const mixedUnitResult = tessellateStep(mixedUnitSource);
const rod = mixedUnitResult.meshes.find((mesh) => mesh.name === 'rod');
assert.ok(rod, 'mixed-unit assembly contains rod instance');
const rodSpan = [0, 1, 2].map((axis) => {
  const values = Array.from(rod.positions).filter((_, index) => index % 3 === axis);
  return Math.max(...values) - Math.min(...values);
});
assert.ok(Math.max(...rodSpan) > 199_000, 'metre child representation is normalized independently');
const nut = mixedUnitResult.meshes.find((mesh) => mesh.name === 'nut');
assert.ok(nut, 'mixed-unit assembly contains millimetre sibling');
const nutCoordinates = Array.from(nut.positions);
assert.ok(Math.max(...nutCoordinates.map(Math.abs)) < 1_000, 'millimetre siblings retain their original scale');

const closeTo = (actual, expected, tolerance = 1e-3) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `Expected ${actual} to be within ${tolerance} of ${expected}`);
};

for (const fixture of fixtures) {
  const started = performance.now();
  const result = tessellateStep(fs.readFileSync(path.join(root, 'test_data', fixture.file), 'utf8'));
  assert.equal(result.faceCount - result.skippedFaceCount, fixture.faces, `${fixture.file}: face coverage`);
  assert.equal(result.skippedFaceCount, 0, `${fixture.file}: skipped faces`);
  assert.equal(result.meshes.length, fixture.meshes, `${fixture.file}: mesh instances`);
  assert.deepEqual(result.warnings, [], `${fixture.file}: warnings`);

  const positions = result.meshes.flatMap((mesh) => Array.from(mesh.positions));
  assert.ok(positions.length > 0 && positions.every(Number.isFinite), `${fixture.file}: finite positions`);
  for (const mesh of result.meshes) {
    assert.equal(mesh.positions.length, mesh.normals.length, `${fixture.file}: normal count`);
    assert.equal(mesh.positions.length, mesh.colors.length, `${fixture.file}: color count`);
    assert.ok(mesh.normals.every(Number.isFinite), `${fixture.file}: finite normals`);
    for (let index = 0; index < mesh.normals.length; index += 3) {
      const length = Math.hypot(mesh.normals[index], mesh.normals[index + 1], mesh.normals[index + 2]);
      assert.ok(length > 0.5 && length < 1.5, `${fixture.file}: usable unit normal at vertex ${index / 3}`);
    }
    assert.ok(mesh.colors.every(Number.isFinite), `${fixture.file}: finite colors`);
    assert.ok(mesh.indices.every((index) => index >= 0 && index < mesh.positions.length / 3), `${fixture.file}: valid indices`);
  }

  const axes = [0, 1, 2].map((axis) => positions.filter((_, index) => index % 3 === axis));
  for (let axis = 0; axis < 3; axis++) {
    closeTo(Math.min(...axes[axis]), fixture.bounds[0][axis], fixture.tolerance);
    closeTo(Math.max(...axes[axis]), fixture.bounds[1][axis], fixture.tolerance);
  }
  if (fixture.colors) {
    const colors = new Set(result.meshes.flatMap((mesh) => {
      const values = [];
      for (let index = 0; index < mesh.colors.length; index += 3) {
        values.push(Array.from(mesh.colors.slice(index, index + 3), (value) => value.toFixed(3)).join(','));
      }
      return values;
    }));
    assert.equal(colors.size, fixture.colors, `${fixture.file}: distinct part colors`);
  }
  const triangles = result.meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0);
  if (fixture.exactTriangles) assert.equal(triangles, fixture.exactTriangles, `${fixture.file}: triangle count`);
  if (fixture.maxTriangles) {
    assert.ok(triangles <= fixture.maxTriangles, `${fixture.file}: trimmed periodic faces use structured grids`);
  }
  console.log(`${fixture.file}: ${result.meshes.length} mesh(es), ${triangles} triangles, ${(performance.now() - started).toFixed(1)} ms`);
}

const roundedCube = tessellateStep(fs.readFileSync(path.join(root, 'test_data', 'step-rounded-cube.step'), 'utf8')).meshes[0];
const roundedGeometry = new THREE.BufferGeometry();
roundedGeometry.setAttribute('position', new THREE.BufferAttribute(roundedCube.positions, 3));
roundedGeometry.setIndex(new THREE.BufferAttribute(roundedCube.indices, 1));
const roundedMesh = new THREE.Mesh(roundedGeometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
const roundedRaycaster = new THREE.Raycaster();
for (const [x, z] of [[6, 9.5], [7, 9], [8, 8], [8.5, 7], [9.5, 6], [7.5, 8.5]]) {
  roundedRaycaster.set(new THREE.Vector3(x, -1, z), new THREE.Vector3(0, 1, 0));
  assert.equal(roundedRaycaster.intersectObject(roundedMesh, false).length, 2, 'Rounded corner stays closed beneath its arc');
}
roundedRaycaster.set(new THREE.Vector3(9, -1, 9), new THREE.Vector3(0, 1, 0));
assert.equal(roundedRaycaster.intersectObject(roundedMesh, false).length, 0, 'Rounded corner stays open outside its arc');

const screw = tessellateStep(fs.readFileSync(path.join(root, 'test_data', 'step-occt-screw.step'), 'utf8')).meshes[0];
const screwGeometry = new THREE.BufferGeometry();
screwGeometry.setAttribute('position', new THREE.BufferAttribute(screw.positions, 3));
screwGeometry.setAttribute('normal', new THREE.BufferAttribute(screw.normals, 3));
screwGeometry.setIndex(new THREE.BufferAttribute(screw.indices, 1));
const screwMesh = new THREE.Mesh(screwGeometry, new THREE.MeshStandardMaterial({ side: THREE.FrontSide }));
const screwRaycaster = new THREE.Raycaster();
const screwHeadTarget = new THREE.Vector3(-17.89811, -0.8263, 6);
for (const originY of [-30, 30]) {
  const origin = new THREE.Vector3(-17.89811, originY, 6);
  screwRaycaster.set(origin, screwHeadTarget.clone().sub(origin).normalize());
  const hit = screwRaycaster.intersectObject(screwMesh, false)[0];
  assert.ok(hit && hit.distance < 25, 'Screw head exterior remains visible with front-face culling');
}
for (const [radius, expectedSamples] of [[5.5, 72], [6.5, 72], [7.5, 64], [8.5, 64], [9.5, 64]]) {
  let visibleSamples = 0;
  for (let index = 0; index < 72; index++) {
    const angle = (index + 0.5) * Math.PI * 2 / 72;
    screwRaycaster.set(
      new THREE.Vector3(
        screwHeadTarget.x + radius * Math.cos(angle),
        screwHeadTarget.y + radius * Math.sin(angle),
        -45,
      ),
      new THREE.Vector3(0, 0, 1),
    );
    if (screwRaycaster.intersectObject(screwMesh, false)[0]) visibleSamples++;
  }
  assert.equal(visibleSamples, expectedSamples, 'Screw head and slot match reference shaft-side culling');
}

const led = tessellateStep(fs.readFileSync(path.join(root, 'test_data', 'step-led-5mm.step'), 'utf8'));
const ledShell = led.meshes.find((mesh) => mesh.name === 'Funda');
assert.ok(ledShell, 'LED contains its shell mesh');
let maximumDomeEdge = 0;
for (let index = 0; index < ledShell.indices.length; index += 3) {
  const triangle = Array.from(ledShell.indices.slice(index, index + 3));
  if (!triangle.every((vertex) => ledShell.positions[vertex * 3 + 2] >= 6.199)) continue;
  for (const [first, second] of [[0, 1], [1, 2], [2, 0]]) {
    maximumDomeEdge = Math.max(
      maximumDomeEdge,
      new THREE.Vector3().fromArray(ledShell.positions, triangle[first] * 3)
        .distanceTo(new THREE.Vector3().fromArray(ledShell.positions, triangle[second] * 3)),
    );
  }
}
assert.ok(maximumDomeEdge <= 0.6, 'LED dome avoids seam-spanning triangles');
const ledGeometry = new THREE.BufferGeometry();
ledGeometry.setAttribute('position', new THREE.BufferAttribute(ledShell.positions, 3));
ledGeometry.setIndex(new THREE.BufferAttribute(ledShell.indices, 1));
const ledMesh = new THREE.Mesh(ledGeometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
const ledRaycaster = new THREE.Raycaster();
for (const z of [6.25, 7, 7.5, 8]) {
  for (let index = 0; index < 72; index++) {
    const angle = (index + 0.5) * Math.PI * 2 / 72;
    ledRaycaster.set(
      new THREE.Vector3(5 * Math.cos(angle), 5 * Math.sin(angle), z),
      new THREE.Vector3(-Math.cos(angle), -Math.sin(angle), 0),
    );
    assert.ok(ledRaycaster.intersectObject(ledMesh, false).length > 0, 'LED dome remains continuously visible');
  }
}

const nema = tessellateStep(fs.readFileSync(path.join(root, 'test_data', 'step-nema17-motor.step'), 'utf8'));
const nemaGeometry = new THREE.BufferGeometry();
nemaGeometry.setAttribute('position', new THREE.BufferAttribute(nema.meshes[0].positions, 3));
nemaGeometry.setIndex(new THREE.BufferAttribute(nema.meshes[0].indices, 1));
const nemaMesh = new THREE.Mesh(nemaGeometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
const nemaRaycaster = new THREE.Raycaster();
for (const z of [42, 50]) {
  for (let index = 0; index < 72; index++) {
    const angle = (index + 0.5) * Math.PI * 2 / 72;
    nemaRaycaster.set(
      new THREE.Vector3(6 * Math.cos(angle), 6 * Math.sin(angle), z),
      new THREE.Vector3(-Math.cos(angle), -Math.sin(angle), 0),
    );
    const shaftHit = nemaRaycaster.intersectObject(nemaMesh, false)
      .find((hit) => hit.point.x ** 2 + hit.point.y ** 2 < 10);
    assert.ok(shaftHit, `NEMA shaft remains continuous at z=${z}`);
    if (z === 50) {
      const expectedRadius = Math.cos(angle) >= -0.8 ? 2.5 : 2 / -Math.cos(angle);
      assert.ok(
        Math.abs(Math.hypot(shaftHit.point.x, shaftHit.point.y) - expectedRadius) <= 0.15,
        'NEMA upper shaft retains its D-cut profile',
      );
    }
  }
}

const resistor = tessellateStep(fs.readFileSync(path.join(root, 'test_data', 'step-resistor.step'), 'utf8'));
const resistorMeshes = resistor.meshes.map((meshData) => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(meshData.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.name = meshData.name;
  return mesh;
});
const raycaster = new THREE.Raycaster();
for (const [ringName, sampleX] of [['Ring-1', -1.33], ['Ring-2', -0.44], ['Ring-3', 0.44], ['Ring-4', 1.33]]) {
  let visibleSamples = 0;
  for (let index = 0; index < 72; index++) {
    const angle = (index + 0.5) * Math.PI * 2 / 72;
    raycaster.set(
      new THREE.Vector3(sampleX, 5 * Math.cos(angle), 5 * Math.sin(angle)),
      new THREE.Vector3(0, -Math.cos(angle), -Math.sin(angle)),
    );
    if (raycaster.intersectObjects(resistorMeshes, false)[0]?.object.name === ringName) visibleSamples++;
  }
  assert.equal(visibleSamples, 72, `${ringName} remains continuously visible around the body`);
}

const pins = resistor.meshes.find((mesh) => mesh.name === 'pins');
assert.ok(pins, 'Resistor contains its pin mesh');
assert.ok(pins.indices.length / 3 <= 2_000, 'Pin elbows use trimmed periodic torus grids');
const pinPositions = pins.positions;
for (let index = 0; index < pinPositions.length; index += 3) {
  const x = pinPositions[index];
  const z = pinPositions[index + 2];
  assert.ok(z >= -1.001 || Math.abs(x) >= 4.7, 'Pin elbows stay within their trimmed quarter-torus envelope');
}

async function testWorkerSourceRetry() {
  let attempts = 0;
  const fetcher = async () => {
    attempts++;
    return attempts === 1
      ? { ok: false, status: 503 }
      : { ok: true, status: 200, text: async () => 'worker source' };
  };
  await assert.rejects(() => workerSourceCompiled.exports.fetchStepWorkerSource('worker.js', fetcher), /503/);
  assert.equal(await workerSourceCompiled.exports.fetchStepWorkerSource('worker.js', fetcher), 'worker source');
  assert.equal(attempts, 2, 'failed STEP worker source fetch is retried');
}

testWorkerSourceRetry().then(
  () => console.log(`STEP regression passed (${fixtures.length} files).`),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);