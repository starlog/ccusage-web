import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLIENT_DIR = path.join(serverRoot, '..', 'client');
const NPM_TIMEOUT_MS = 60_000;
const RETRY_AFTER_FAILURE_MS = 60_000;

/**
 * Where built packages go. The package is a rebuildable cache, so when the app folder is read-only (as in some
 * containers) the system temp directory is used instead.
 */
function distDir() {
  const preferred = path.join(serverRoot, '.client-dist');
  try {
    fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    return path.join(os.tmpdir(), 'cc-usage-client-dist');
  }
}

let current = null; // { version, hash, file, builtAt }
let building = null;
let lastFailureAt = 0;

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
    execFile(
      command,
      viaExecPath ? [process.env.npm_execpath, ...args] : args,
      { cwd, encoding: 'utf8', timeout: NPM_TIMEOUT_MS, killSignal: 'SIGKILL', shell: !viaExecPath && process.platform === 'win32' },
      (error, stdout, stderr) => (error ? reject(new Error(`npm ${args.join(' ')}: ${(stderr || error.message).trim()}`)) : resolve(stdout)),
    );
  });
}

async function build() {
  const startedAt = Date.now(); // sources changed while packing are picked up by the next request
  const dir = distDir();
  fs.mkdirSync(dir, { recursive: true });
  const [packed] = JSON.parse(await npm(['pack', '--json', '--pack-destination', dir], CLIENT_DIR));
  const packedFile = path.join(dir, packed.filename);
  const tarball = path.join(dir, 'cc-usage-client.tgz');
  try {
    fs.renameSync(packedFile, tarball);
  } finally {
    fs.rmSync(packedFile, { force: true });
  }
  const hash = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  current = { version: packed.version, hash, file: tarball, builtAt: startedAt };
  console.log(`[client] packaged cc-usage-client ${packed.version} (${hash.slice(0, 12)})`);
  return current;
}

/**
 * The current client package, rebuilt when client sources changed. The hash goes into the download URL so
 * npx never reuses a cached older package. After a failed build, requests reuse the previous package (or fail
 * fast) for a minute instead of starting npm again on every page load.
 */
export async function clientPackage() {
  if (current && current.builtAt >= sourceMtime()) return current;
  if (Date.now() - lastFailureAt < RETRY_AFTER_FAILURE_MS) {
    if (current) return current;
    throw new Error('client packaging failed recently; retrying shortly');
  }
  building ??= build()
    .catch((error) => {
      lastFailureAt = Date.now();
      throw error;
    })
    .finally(() => {
      building = null;
    });
  return building;
}

export const packagePath = (pkg) => `/client/cc-usage-client-${pkg.version}-${pkg.hash.slice(0, 12)}.tgz`;
