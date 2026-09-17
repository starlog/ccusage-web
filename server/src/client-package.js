import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLIENT_DIR = path.join(serverRoot, '..', 'client');
const DIST_DIR = path.join(serverRoot, '.client-dist');
const TARBALL = path.join(DIST_DIR, 'cc-usage-client.tgz');

let current = null; // { version, hash, file, builtAt }
let building = null;

/** Newest modification time of the files that go into the package. */
function sourceMtime() {
  let newest = fs.statSync(path.join(CLIENT_DIR, 'package.json')).mtimeMs;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  for (const dir of ['bin', 'src']) walk(path.join(CLIENT_DIR, dir));
  return newest;
}

/** npm that belongs to this node (npm start sets npm_execpath). */
function npm(args, cwd) {
  const viaExecPath = process.env.npm_execpath?.endsWith('.js');
  const command = viaExecPath ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return new Promise((resolve, reject) => {
    execFile(command, viaExecPath ? [process.env.npm_execpath, ...args] : args, { cwd, encoding: 'utf8', shell: !viaExecPath && process.platform === 'win32' }, (error, stdout, stderr) =>
      error ? reject(new Error(`npm ${args.join(' ')}: ${(stderr || error.message).trim()}`)) : resolve(stdout),
    );
  });
}

async function build() {
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const [packed] = JSON.parse(await npm(['pack', '--json', '--pack-destination', DIST_DIR], CLIENT_DIR));
  fs.renameSync(path.join(DIST_DIR, packed.filename), TARBALL);
  const hash = createHash('sha256').update(fs.readFileSync(TARBALL)).digest('hex');
  current = { version: packed.version, hash, file: TARBALL, builtAt: Date.now() };
  console.log(`[client] packaged cc-usage-client ${packed.version} (${hash.slice(0, 12)})`);
  return current;
}

/**
 * The current client package, rebuilt when client sources changed. The hash goes into the download URL so
 * npx never reuses a cached older package.
 */
export async function clientPackage() {
  if (current && current.builtAt >= sourceMtime()) return current;
  building ??= build().finally(() => {
    building = null;
  });
  return building;
}

export const packagePath = (pkg) => `/client/cc-usage-client-${pkg.version}-${pkg.hash.slice(0, 12)}.tgz`;
