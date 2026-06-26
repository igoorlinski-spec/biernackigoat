/**
 * Bootstrap installer - downloads npm and installs project dependencies
 * Run with: "C:\Program Files\Adobe\Adobe Creative Cloud Experience\libs\node.exe" bootstrap_install.js
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const PROJECT_DIR = path.join(__dirname);

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, { headers: { 'User-Agent': 'node-installer' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        file.close();
        try { fs.unlinkSync(dest); } catch(e) {}
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (e) => {
      try { fs.unlinkSync(dest); } catch(x) {}
      reject(e);
    });
  });
}

async function main() {
  const tmpDir = os.tmpdir();
  const npmTgz = path.join(tmpDir, 'npm-installer.tgz');
  const npmDir = path.join(tmpDir, 'npm-cli-extracted');

  console.log('[1/3] Downloading npm 10.9.2...');
  await download('https://registry.npmjs.org/npm/-/npm-10.9.2.tgz', npmTgz);
  console.log('      OK - Downloaded to', npmTgz);

  console.log('[2/3] Extracting npm...');
  if (fs.existsSync(npmDir)) {
    fs.rmSync(npmDir, { recursive: true, force: true });
  }
  fs.mkdirSync(npmDir, { recursive: true });
  
  const tarCmd = `tar -xzf "${npmTgz}" -C "${npmDir}" --strip-components=1`;
  execSync(tarCmd);
  console.log('      OK - Extracted to', npmDir);

  console.log('[3/3] Running npm install in project...');
  const npmBin = path.join(npmDir, 'bin', 'npm-cli.js');
  const nodeExe = process.execPath;
  
  execSync(`"${nodeExe}" "${npmBin}" install`, {
    cwd: PROJECT_DIR,
    stdio: 'inherit'
  });
  
  console.log('\n=== Installation complete! ===');
  console.log('Now starting server...\n');
  
  // Start server
  execSync(`"${nodeExe}" server.js`, {
    cwd: PROJECT_DIR,
    stdio: 'inherit'
  });
}

main().catch(e => {
  console.error('\nERROR:', e.message);
  process.exit(1);
});
