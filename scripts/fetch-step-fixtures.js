const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const zlib = require('node:zlib');

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
  ['step-nema17-motor.step', '7a192833722ef5216bf7916c97870b6d4677db237143e3275305d5e846cc0521', 'https://raw.githubusercontent.com/FreeCAD/FreeCAD-library/master/Electronics%20Parts/Motors/Stepper/NEMA/Old/NEMA-17_Stepper_Motor_40mm.step'],
  ['step-occt-screw.step', '4b3649a4f5c4f05c7a06a402a91fe2fd7e3cba1615520fbd8c62a62610ad3e69', 'https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/master/data/step/screw.step'],
];
const nistArchive = {
  url: 'https://raw.githubusercontent.com/usnistgov/SFA/master/Release/NIST-PMI-STEP-Files.zip',
  hash: '1fb91bb8ff0fe02032b948fda0775bc74591cd0bebc0988347d32574e5884f90',
  entries: [[
    'step-nist-ftc08-ap242-tg.stp',
    '40cd4e5e2e02b5742e0884ba5b132f2e37d2215c45f57afb48962a05a060c384',
    'NIST-PMI-STEP-Files/nist_ftc_08_asme1_ap242-e4-tg.stp',
  ]],
};

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

function extractZipEntry(archive, targetName) {
  let endOffset = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset--) {
    if (archive.readUInt32LE(offset) === 0x06054b50) { endOffset = offset; break; }
  }
  if (endOffset < 0) throw new Error('NIST fixture archive has no ZIP directory.');
  const entryCount = archive.readUInt16LE(endOffset + 10);
  let offset = archive.readUInt32LE(endOffset + 16);
  for (let index = 0; index < entryCount; index++) {
    if (offset < 0 || offset + 46 > endOffset) throw new Error('NIST fixture archive directory is invalid.');
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('NIST fixture archive directory is invalid.');
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength + extraLength + commentLength > endOffset) {
      throw new Error('NIST fixture archive directory entry is truncated.');
    }
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name === targetName) {
      if (localOffset + 30 > archive.length) throw new Error(`ZIP entry ${name} has an invalid local offset.`);
      if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`ZIP entry ${name} has no local header.`);
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      if (dataOffset + compressedSize > archive.length) throw new Error(`ZIP entry ${name} is truncated.`);
      const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
      let extracted;
      if (method === 0) extracted = Buffer.from(compressed);
      else if (method === 8) extracted = zlib.inflateRawSync(compressed);
      else throw new Error(`ZIP entry ${name} uses unsupported compression method ${method}.`);
      if (extracted.length !== uncompressedSize) throw new Error(`ZIP entry ${name} has an invalid extracted size.`);
      return extracted;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP entry not found: ${targetName}`);
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
  const needsArchive = nistArchive.entries.some(([name]) => !fs.existsSync(path.join(root, name)));
  let archive;
  if (needsArchive) {
    console.log('Fetching official NIST STEP fixtures');
    archive = await download(nistArchive.url);
    const archiveHash = hash(archive);
    if (archiveHash !== nistArchive.hash) {
      throw new Error(`NIST archive checksum mismatch: expected ${nistArchive.hash}, received ${archiveHash}`);
    }
  }
  for (const [name, expectedHash, entryName] of nistArchive.entries) {
    const target = path.join(root, name);
    let content = fs.existsSync(target) ? fs.readFileSync(target) : null;
    if (!content) {
      content = extractZipEntry(archive, entryName);
      fs.writeFileSync(target, content);
    }
    const actualHash = hash(content);
    if (actualHash !== expectedHash) {
      throw new Error(`${name} checksum mismatch: expected ${expectedHash}, received ${actualHash}`);
    }
  }
}

module.exports = { extractZipEntry };

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}