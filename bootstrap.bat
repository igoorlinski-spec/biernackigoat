@echo off
REM Bootstrap script - downloads npm and installs dependencies
SET NODEPATH="C:\Program Files\Adobe\Adobe Creative Cloud Experience\libs\node.exe"
SET PROJECTDIR=%~dp0

echo [1/3] Checking Node.js...
%NODEPATH% --version
IF %ERRORLEVEL% NEQ 0 (
    echo ERROR: Adobe node.exe not found!
    pause
    exit /b 1
)

echo [2/3] Downloading npm...
%NODEPATH% -e "
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? require('https') : require('http');
    const file = fs.createWriteStream(dest);
    proto.get(url, { headers: { 'User-Agent': 'node-installer' } }, (res) => {
      if ([301,302,307,308].includes(res.statusCode)) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (e) => { try{fs.unlinkSync(dest);}catch(x){} reject(e); });
  });
}

async function main() {
  const tmpDir = os.tmpdir();
  const npmTgz = path.join(tmpDir, 'npm.tgz');
  const npmDir = path.join(tmpDir, 'npm-cli');

  console.log('Downloading npm...');
  await download('https://registry.npmjs.org/npm/-/npm-10.9.2.tgz', npmTgz);
  console.log('Downloaded npm.tgz');

  fs.mkdirSync(npmDir, { recursive: true });
  execSync('tar -xzf \"' + npmTgz + '\" -C \"' + npmDir + '\" --strip-components=1');
  console.log('Extracted npm to', npmDir);

  // Now run npm install
  const npmBin = path.join(npmDir, 'bin', 'npm-cli.js');
  console.log('Running npm install...');
  execSync(
    '\"' + process.execPath + '\" \"' + npmBin + '\" install --prefer-offline',
    { cwd: '%PROJECTDIR%', stdio: 'inherit' }
  );
  console.log('Installation complete!');
}

main().catch(e => { console.error(e); process.exit(1); });
"

IF %ERRORLEVEL% NEQ 0 (
    echo ERROR: npm install failed!
    pause
    exit /b 1
)

echo [3/3] Starting server...
%NODEPATH% server.js
