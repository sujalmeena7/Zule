import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.length !== 2) {
  console.error('Usage: node native/stage-c/build-native.mjs');
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, '..', '..');
const probePath = resolve(here, 'toolchain-probe.mjs');
const projectPath = resolve(here, 'ZuleUI.vcxproj');
const outputDir = `${resolve(workspace, 'dist', 'stage-c')}${sep}`;

const probe = spawnSync(process.execPath, [probePath, '--require-available'], {
  encoding: 'utf8', timeout: 60000, windowsHide: true,
});
process.stdout.write(probe.stdout ?? '');
process.stderr.write(probe.stderr ?? '');
if (probe.status !== 0) {
  console.error('[stage-c] Exact production toolchain probe failed; native build remains disabled.');
  process.exit(1);
}

const result = JSON.parse(probe.stdout);
const msbuildPath = result.details?.msbuildPath;
const webView2SdkRoot = result.details?.webView2SdkRoot;
const requiredFiles = [
  resolve(webView2SdkRoot ?? '', 'include', 'WebView2.h'),
  resolve(webView2SdkRoot ?? '', 'x64', 'WebView2LoaderStatic.lib'),
];
if (!msbuildPath || !existsSync(msbuildPath) || !webView2SdkRoot || requiredFiles.some((path) => !existsSync(path))) {
  console.error('[stage-c] Locked pre-provisioned MSBuild/WebView2 SDK paths are absent; no restore or download is permitted.');
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });
const args = [
  projectPath, '/nologo', '/m', '/t:Build', '/restore:false',
  '/p:Configuration=Release', '/p:Platform=x64', '/p:RestorePackages=false',
  `/p:WebView2SdkRoot=${webView2SdkRoot}${sep}`,
  `/p:OutDir=${outputDir}`,
];
const build = spawnSync(msbuildPath, args, { stdio: 'inherit', timeout: 20 * 60 * 1000, windowsHide: true });
if (build.error || build.status !== 0) {
  console.error(`[stage-c] MSBuild failed closed (${build.error?.message ?? `exit ${build.status}`}).`);
  process.exit(build.status || 1);
}
console.log(`[stage-c] Built explicit project ${projectPath} into ${outputDir}`);