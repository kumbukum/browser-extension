const fs = require('fs');
const path = require('path');

const buildDir = 'build';
const outputFileName = 'build.zip';

async function pack() {
  const { ZipArchive } = await import('archiver');

  const output = fs.createWriteStream(path.join(__dirname, outputFileName));
  const archive = new ZipArchive({
    zlib: { level: 9 }
  });

  output.on('close', function() {
    console.log(`${archive.pointer()} total bytes`);
    console.log(`Chrome extension packaged as ${outputFileName}`);
  });

  archive.on('warning', function(err) {
    if (err.code === 'ENOENT') {
      console.warn(err);
    } else {
      throw err;
    }
  });

  archive.on('error', function(err) {
    throw err;
  });

  archive.pipe(output);
  archive.directory(buildDir, false);
  archive.finalize();
}

pack();
