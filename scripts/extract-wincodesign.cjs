const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const cacheDir = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'winCodeSign');
const z7 = path.join(process.cwd(), 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
const target = path.join(cacheDir, 'winCodeSign-2.6.0');

if (!fs.existsSync(target)) {
  fs.mkdirSync(target, { recursive: true });
}

const files = fs.readdirSync(cacheDir).filter(f => f.endsWith('.7z'));
if (files.length > 0) {
  const archive = path.join(cacheDir, files[0]);
  console.log('Extracting to:', target);
  try {
    execSync(`"${z7}" x -y -bd -snld "-o${target}" "${archive}"`, { stdio: 'inherit' });
  } catch (e) {
    console.log('Handled symlink warning, continuing...');
  }
}
