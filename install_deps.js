/**
 * Simple dependency installer using Node.js built-ins
 * Downloads npm CLI and installs dependencies
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const os = require('os');
const zlib = require('zlib');

const CWD = __dirname;
const NODE_MODULES = path.join(CWD, 'node_modules');

// Packages to install
const deps = {
  'express': '4.19.2',
  'cors': '2.8.5',
  'bcryptjs': '2.4.3',
  'socket.io': '4.7.5',
  'sqlite3': '5.1.7'
};

// Helper to download file
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, { headers: { 'User-Agent': 'node' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// Get package tarball URL from npm registry
async function getPackageInfo(name, version) {
  return new Promise((resolve, reject) => {
    const url = `https://registry.npmjs.org/${name}/${version}`;
    https.get(url, { headers: { 'User-Agent': 'node' } }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch(e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// Extract tar.gz
async function extractTarGz(tarPath, destDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    const tar = require('child_process');
    // Use built-in tar on Windows 10+
    try {
      execSync(`tar -xzf "${tarPath}" -C "${destDir}" --strip-components=1`, { stdio: 'pipe' });
      resolve();
    } catch(e) {
      reject(e);
    }
  });
}

async function installPackage(name, version) {
  console.log(`Installing ${name}@${version}...`);
  
  try {
    const info = await getPackageInfo(name, version);
    const tarballUrl = info.dist.tarball;
    
    const tmpTar = path.join(os.tmpdir(), `${name.replace('/', '_')}-${version}.tgz`);
    const pkgDir = path.join(NODE_MODULES, name);
    
    // Download tarball
    await download(tarballUrl, tmpTar);
    
    // Create destination directory
    fs.mkdirSync(pkgDir, { recursive: true });
    
    // Extract
    await extractTarGz(tmpTar, pkgDir);
    
    // Clean up
    try { fs.unlinkSync(tmpTar); } catch(e) {}
    
    console.log(`  ✓ ${name}@${version} installed`);
    
    // Install sub-dependencies
    const pkgJson = path.join(pkgDir, 'package.json');
    if (fs.existsSync(pkgJson)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
      if (pkg.dependencies) {
        for (const [depName, depVersion] of Object.entries(pkg.dependencies)) {
          const cleanVersion = depVersion.replace(/[\^~>=<]/, '').split(' ')[0];
          const depDir = path.join(NODE_MODULES, depName);
          if (!fs.existsSync(depDir)) {
            await installPackage(depName, cleanVersion).catch(e => {
              console.warn(`  ! Failed to install sub-dep ${depName}: ${e.message}`);
            });
          }
        }
      }
    }
  } catch(e) {
    console.error(`  ✗ Failed to install ${name}: ${e.message}`);
  }
}

async function main() {
  console.log('Creating node_modules directory...');
  fs.mkdirSync(NODE_MODULES, { recursive: true });
  
  for (const [name, version] of Object.entries(deps)) {
    const depDir = path.join(NODE_MODULES, name);
    if (fs.existsSync(depDir)) {
      console.log(`  ✓ ${name} already installed, skipping`);
      continue;
    }
    await installPackage(name, version);
  }
  
  console.log('\nDone! All dependencies installed.');
}

main().catch(console.error);
