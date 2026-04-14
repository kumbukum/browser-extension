const fs = require('fs');
const archiver = require('archiver');
const path = require('path');

// Get browser from command line argument
const browser = process.argv[2] || 'chrome';
const buildDir = browser === 'firefox' ? 'build-firefox' : 'build';
const outputFileName = browser === 'firefox' ? 'build-firefox.zip' : 'build.zip';

const output = fs.createWriteStream(path.join(__dirname, outputFileName));
const archive = archiver('zip', {
  zlib: { level: 9 }
});

output.on('close', function() {
  console.log(`${archive.pointer()} total bytes`);
  console.log(`${browser.charAt(0).toUpperCase() + browser.slice(1)} extension packaged as ${outputFileName}`);
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
