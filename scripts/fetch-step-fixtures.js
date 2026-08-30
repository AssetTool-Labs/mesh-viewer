const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'test_data');
const fixtures = [
  ['step-cube.stp', 'f2e8c17cddf0421e925db847412080bac15713396dfaf134f195e9dad216a3f2', 'https://raw.githubusercontent.com/kovacsv/occt-import-js/0.0.23/test/testfiles/simple-basic-cube/cube.stp'],
  ['step-rounded-cube.step', '96e91abd536879747dcd49de707314d0157bc2d066b591a3244c81a726e52961', 'https://raw.githubusercontent.com/kovacsv/occt-import-js/0.0.23/test/testfiles/rounded-cube/rounded-cube.step'],
  ['step-conical-surface.step', 'fa9dfef56daf69aa0630220d445a3034976af8dc6a7f59192a87a4b61d8db85e', 'https://raw.githubusercontent.com/kovacsv/occt-import-js/0.0.23/test/testfiles/conical-surface/conical-surface.step'],
  ['step-cube-inch.step', 'e98c309bf845ed521d0d7c45e672fe7f42287328a4a04720ed120558b8c6d4d1', 'https://raw.githubusercontent.com/kovacsv/occt-import-js/0.0.23/test/testfiles/cube-units/cube-in.step'],
  ['step-cube-meter.step', 'e8beb5f6b6123ad09097f988f31a178181ef1f8916734aeb0afa642c0e19af0f', 'https://raw.githubusercontent.com/kovacsv/occt-import-js/0.0.23/test/testfiles/cube-units/cube-m.step'],
  ['step-assembly-ap214.stp', '038be659c54b16c9f3da8d7b2da7b63e3fd8879d3abe5b7826108336a7c0bae9', 'https://raw.githubusercontent.com/kovacsv/occt-import-js/0.0.23/test/testfiles/cax-if/as1-oc-214.stp'],
  ['step-led-5mm.step', 'b242fbdb070c8e84e874f9be0d1a46ce782e4c64e864db956f1e78f6c82e53bb', 'https://raw.githubusercontent.com/FreeCAD/FreeCAD-library/master/Electronics%20Parts/LEDs/led-5mm.step'],
  ['step-resistor.step', '1d21c579b7043a4e80b8c08905174146f1060d9c88d54c71b71101c9e7d9e6fa', 'https://raw.githubusercontent.com/FreeCAD/FreeCAD-library/master/Electronics%20Parts/Resistors/res-1_4w-1K.step'],
];

function hash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed (${response.statusCode}): ${url}`));
        response.resume();
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  fs.mkdirSync(root, { recursive: true });
  for (const [name, expectedHash, url] of fixtures) {
    const target = path.join(root, name);
    let content = fs.existsSync(target) ? fs.readFileSync(target) : null;
    if (!content) {
      console.log(`Fetching ${name}`);
      content = await download(url);
      fs.writeFileSync(target, content);
    }
    const actualHash = hash(content);
    if (actualHash !== expectedHash) {
      throw new Error(`${name} checksum mismatch: expected ${expectedHash}, received ${actualHash}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});