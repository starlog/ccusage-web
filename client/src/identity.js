import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { saveConfig } from './config.js';

// Same rules as the server (server/src/ingest.js).
export const USER_RE = /^[\w.%+@-]{1,200}$/;
const NAME_MAX = 50;
const CONTROL_RE = /[\p{Cc}\p{Cf}]/u;

export function validateUser(user) {
  if (!USER_RE.test(user)) {
    throw new Error(`사용자 ID "${user}"는 영문, 숫자와 . _ % + @ - 만 쓸 수 있습니다. 한글 이름은 이름(--name)에 넣으세요.`);
  }
  return user;
}

/** Display name such as 홍길동: NFC-normalized, whitespace collapsed, no control characters. Empty means none. */
export function normalizeName(name) {
  if (name == null) return null;
  const value = String(name).normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (!value) return null;
  if ([...value].length > NAME_MAX || CONTROL_RE.test(value)) {
    throw new Error(`이름은 ${NAME_MAX}자 이하이고 제어 문자가 없어야 합니다.`);
  }
  return value;
}

const output = (command, args) => {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};

export function defaultUser() {
  return output('git', ['config', '--global', 'user.email']).trim() || os.userInfo().username;
}

/** The OS-provided stable machine identifier, if one can be read. */
function osMachineUuid() {
  if (process.platform === 'darwin') {
    return output('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']).match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] ?? null;
  }
  if (process.platform === 'win32') {
    const text = output('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']);
    return text.match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1] ?? null;
  }
  for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch {
      // try the next location
    }
  }
  return null;
}

/** Stable, anonymized id of this computer. Changing the formula would split a person's existing records. */
export function machineId(config) {
  let raw = osMachineUuid();
  if (!raw) {
    raw = config.fallbackMachineUuid;
    if (!raw) {
      raw = randomUUID();
      saveConfig({ ...config, fallbackMachineUuid: raw });
    }
  }
  return createHash('sha256').update(`cc-usage:${raw}`).digest('hex').slice(0, 32);
}
