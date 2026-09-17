import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
const isWindows = process.platform === 'win32';

// Same location the Python client (ccusage_report.py) uses, so existing settings carry over.
export const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'cc-usage');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const STATE_FILE = path.join(CONFIG_DIR, 'state.json');
export const LAST_UPLOAD_FILE = path.join(CONFIG_DIR, 'last-upload.json');

// Stable install used by the daily schedule (npx caches are temporary).
export const DATA_DIR = isWindows
  ? path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'cc-usage')
  : path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'cc-usage');
export const INSTALLED_ENTRY = path.join(DATA_DIR, 'node_modules', 'cc-usage-client', 'bin', 'cc-usage.js');

export const LOG_FILE =
  process.platform === 'darwin' ? path.join(home, 'Library', 'Logs', 'cc-usage.log') : path.join(DATA_DIR, 'upload.log');

// Short command users can run after setup. ~/.local/bin is on PATH for most Claude Code installs.
export const USER_BIN_DIR = isWindows ? path.join(DATA_DIR, 'bin') : path.join(home, '.local', 'bin');
export const WRAPPER_FILE = path.join(USER_BIN_DIR, isWindows ? 'cc-usage.cmd' : 'cc-usage');
