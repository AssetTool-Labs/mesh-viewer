const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const THREE = require('three');

const root = path.resolve(__dirname, '..');
const fixtures = [
  { file: 'step-cube.stp', faces: 6, meshes: 1, bounds: [[-160, -140, 0], [140, 160, 300]] },
  { file: 'step-rounded-cube.step', faces: 7, meshes: 1, bounds: [[0, 0, 0], [10, 10, 10]] },
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
const { expandStepKnots, parsePart21, tessellateStep, validateStepSpline } = compiled.exports;
assert.throws(() => tessellateStep(''), /Not an ISO-10303-21 STEP file/);
assert.throws(() => tessellateStep('ISO-10303-21; HEADER; ENDSEC; DATA; ENDSEC; END-ISO-10303-21;'), /contains no entities/);
assert.throws(() => expandStepKnots([65], [0]), /Invalid B-spline knot multiplicity/);
assert.throws(() => expandStepKnots([2], [Number.NaN]), /finite and nondecreasing/);
assert.throws(() => validateStepSpline(99, 100, 200), /outside the supported range/);
assert.throws(() => validateStepSpline(3, 4, 7), /inconsistent control-point and knot counts/);

const binaryDocument = parsePart21('ISO-10303-21; DATA; #1=PROPERTY_DEFINITION(\'binary\',"0aFF",$); ENDSEC; END-ISO-10303-21;');
assert.deepEqual(binaryDocument.entities.get(1).args[1], { kind: 'binary', value: '0AFF' });

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
const trimmedResult = tessellateStep(trimmedSemicircle);
const trimmedPositions = Array.from(trimmedResult.meshes[0].positions);
const trimmedY = trimmedPositions.filter((_, index) => index % 3 === 1);
assert.ok(Math.min(...trimmedY) < -0.99, 'trimmed curve follows reversed basis direction');
assert.ok(Math.max(...trimmedY) < 0.01, 'trimmed curve does not use the opposite semicircle');

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
    const colors = new Set(result.meshes.map((mesh) => Array.from(mesh.colors.slice(0, 3), (value) => value.toFixed(3)).join(',')));
    assert.equal(colors.size, fixture.colors, `${fixture.file}: distinct part colors`);
  }
  const triangles = result.meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0);
  console.log(`${fixture.file}: ${result.meshes.length} mesh(es), ${triangles} triangles, ${(performance.now() - started).toFixed(1)} ms`);
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
    const angle = index * Math.PI * 2 / 72;
    raycaster.set(
      new THREE.Vector3(sampleX, 5 * Math.cos(angle), 5 * Math.sin(angle)),
      new THREE.Vector3(0, -Math.cos(angle), -Math.sin(angle)),
    );
    if (raycaster.intersectObjects(resistorMeshes, false)[0]?.object.name === ringName) visibleSamples++;
  }
  assert.equal(visibleSamples, 72, `${ringName} remains continuously visible around the body`);
}

console.log(`STEP regression passed (${fixtures.length} files).`);