import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOG_FILE } from './paths.js';

// Overridable names so the scheduler can be exercised without touching a real registration.
const LAUNCHD_LABEL = process.env.CC_USAGE_SCHEDULE_NAME || 'com.cc-usage.client';
const CRON_TAG = `# ${process.env.CC_USAGE_SCHEDULE_NAME || 'cc-usage-client'}`;
const WINDOWS_TASK = process.env.CC_USAGE_SCHEDULE_NAME || 'cc-usage-client';

export function parseTime(value) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value ?? '');
  if (!match) throw new Error('시각은 HH:MM 형식이어야 합니다 (예: 13:00)');
  return { hour: Number(match[1]), minute: Number(match[2]), text: `${match[1].padStart(2, '0')}:${match[2]}` };
}

/** Absolute node + script, so the job does not depend on PATH (the classic cron problem). */
const jobArgs = (entry) => [process.execPath, entry, 'send', '--log', LOG_FILE];

const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', ...options });

function failIf(result, what) {
  if (result.error?.code === 'ENOENT') throw new Error(`${what}: 명령을 찾을 수 없습니다`);
  if (result.status !== 0) throw new Error(`${what} 실패: ${(result.stderr || result.stdout || '').trim().slice(0, 300)}`);
}

// ------------------------------------------------------------------ macOS: launchd

const plistFile = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function launchdPlist(entry, time) {
  const args = jobArgs(entry).map((a) => `      <string>${xml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(LAUNCHD_LABEL)}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>StartCalendarInterval</key>
    <dict>
      <key>Hour</key>
      <integer>${time.hour}</integer>
      <key>Minute</key>
      <integer>${time.minute}</integer>
    </dict>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${xml(`${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`)}</string>
    </dict>
    <key>StandardErrorPath</key>
    <string>${xml(LOG_FILE)}</string>
  </dict>
</plist>
`;
}

const launchdDomain = () => `gui/${process.getuid()}`;

const macos = {
  kind: 'launchd',
  location: plistFile,
  preview: (entry, time) => launchdPlist(entry, time),
  register(entry, time) {
    fs.mkdirSync(path.dirname(plistFile()), { recursive: true });
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.writeFileSync(plistFile(), launchdPlist(entry, time));
    run('launchctl', ['bootout', `${launchdDomain()}/${LAUNCHD_LABEL}`]); // replace a previous registration
    failIf(run('launchctl', ['bootstrap', launchdDomain(), plistFile()]), 'launchctl bootstrap');
  },
  unregister() {
    const loaded = run('launchctl', ['bootout', `${launchdDomain()}/${LAUNCHD_LABEL}`]).status === 0;
    const existed = fs.existsSync(plistFile());
    fs.rmSync(plistFile(), { force: true });
    return loaded || existed;
  },
  registered: () => run('launchctl', ['print', `${launchdDomain()}/${LAUNCHD_LABEL}`]).status === 0,
};

// ------------------------------------------------------------------ Linux: cron

const shellQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

function readCrontab() {
  const result = run('crontab', ['-l']);
  if (result.error?.code === 'ENOENT') throw new Error('crontab 명령이 없습니다. cron을 설치하거나 setup --no-schedule을 사용하세요');
  return result.status === 0 ? result.stdout : ''; // "no crontab for user" exits non-zero
}

function writeCrontab(text) {
  failIf(run('crontab', ['-'], { input: text }), 'crontab 등록');
}

const withoutOurLines = (text) =>
  text
    .split('\n')
    .filter((line) => line && !line.endsWith(CRON_TAG))
    .join('\n');

// cron turns an unescaped % into a newline even inside quotes.
const cronLine = (entry, time) =>
  `${time.minute} ${time.hour} * * * ${jobArgs(entry).map((a) => shellQuote(a).replace(/%/g, '\\%')).join(' ')} ${CRON_TAG}`;

const linux = {
  kind: 'cron',
  location: () => 'crontab',
  preview: (entry, time) => cronLine(entry, time),
  register(entry, time) {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    const rest = withoutOurLines(readCrontab());
    writeCrontab(`${rest ? `${rest}\n` : ''}${cronLine(entry, time)}\n`);
  },
  unregister() {
    let current;
    try {
      current = readCrontab();
    } catch {
      return false;
    }
    if (!current.split('\n').some((line) => line.endsWith(CRON_TAG))) return false;
    const rest = withoutOurLines(current);
    writeCrontab(rest ? `${rest}\n` : '');
    return true;
  },
  registered() {
    try {
      return readCrontab().split('\n').some((line) => line.endsWith(CRON_TAG));
    } catch {
      return false;
    }
  },
};

// ------------------------------------------------------------------ Windows: Task Scheduler

// schtasks /TR takes one command line; quote each part the way cmd.exe expects.
const windowsCommand = (entry) => jobArgs(entry).map((a) => `"${a}"`).join(' ');

const windows = {
  kind: 'Windows 작업 스케줄러',
  location: () => `작업 이름 ${WINDOWS_TASK}`,
  preview: (entry, time) => `schtasks /Create /F /SC DAILY /TN ${WINDOWS_TASK} /ST ${time.text} /TR ${windowsCommand(entry)}`,
  register(entry, time) {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    failIf(
      run('schtasks', ['/Create', '/F', '/SC', 'DAILY', '/TN', WINDOWS_TASK, '/ST', time.text, '/TR', windowsCommand(entry)], {
        windowsVerbatimArguments: false,
      }),
      'schtasks /Create',
    );
  },
  unregister: () => run('schtasks', ['/Delete', '/F', '/TN', WINDOWS_TASK]).status === 0,
  registered: () => run('schtasks', ['/Query', '/TN', WINDOWS_TASK]).status === 0,
};

export function scheduler() {
  if (process.platform === 'darwin') return macos;
  if (process.platform === 'win32') return windows;
  return linux;
}
