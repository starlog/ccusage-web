import fs from 'node:fs';
import { CONFIG_DIR, CONFIG_FILE, STATE_FILE } from './paths.js';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`경고: ${file}을(를) 읽지 못해 무시합니다 (${error.message})`);
    return {};
  }
}

function writeJson(file, value, { secret = false } = {}) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // Created owner-only from the start (the settings may hold the upload token); chmod covers existing files.
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', ...(secret ? { mode: 0o600 } : {}) });
  if (secret && process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

/** Saved settings: user, name, server, token, machineId, fallbackMachineUuid. */
export const loadConfig = () => readJson(CONFIG_FILE);
export const saveConfig = (config) => writeJson(CONFIG_FILE, config, { secret: true });

/** Last run, last success and schedule details, for `cc-usage status`. */
export const loadState = () => readJson(STATE_FILE);
export const updateState = (patch) => writeJson(STATE_FILE, { ...loadState(), ...patch });

/** Option > environment variable > saved config. */
export function resolveSettings(options, config = loadConfig()) {
  const pick = (option, env, key) => options[option] ?? (process.env[env] || undefined) ?? config[key];
  return {
    user: pick('user', 'CCUSAGE_USER', 'user'),
    name: pick('name', 'CCUSAGE_NAME', 'name'),
    server: pick('server', 'CCUSAGE_SERVER', 'server'),
    token: pick('token', 'CCUSAGE_TOKEN', 'token'),
    machineId: pick('machine-id', 'CCUSAGE_MACHINE_ID', 'machineId'),
  };
}
