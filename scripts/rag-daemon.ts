import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveRepoPath } from './lib/runtime-env.js';

const DAEMON_DIR = resolveRepoPath('.data/rag-daemon');
const PID_PATH = resolve(DAEMON_DIR, 'daemon.pid');
const STATE_PATH = resolve(DAEMON_DIR, 'daemon.json');
const LOG_PATH = resolve(DAEMON_DIR, 'daemon.log');

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(): number | undefined {
  if (!existsSync(PID_PATH)) {
    return undefined;
  }

  const pid = Number(readFileSync(PID_PATH, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function writeState(startedAt: string): void {
  mkdirSync(DAEMON_DIR, { recursive: true });
  writeFileSync(
    STATE_PATH,
    `${JSON.stringify(
      {
        pid: process.pid,
        runtime: 'postgres',
        startedAt,
        heartbeatAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

function resolveBunCommand(): string {
  if (process.versions.bun && process.execPath) {
    return process.execPath;
  }
  return process.env.BUN_BIN || 'bun';
}

async function startDaemon(): Promise<void> {
  const existingPid = readPid();
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`rag-daemon already running pid=${existingPid}`);
    return;
  }

  mkdirSync(DAEMON_DIR, { recursive: true });
  rmSync(PID_PATH, { force: true });

  const child = spawn(resolveBunCommand(), ['run', 'scripts/rag-daemon.ts', 'run'], {
    cwd: resolveRepoPath(),
    detached: true,
    env: { ...process.env },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  if (!child.pid) {
    throw new Error('Failed to start rag-daemon');
  }

  writeFileSync(PID_PATH, `${child.pid}\n`, 'utf8');
  writeFileSync(LOG_PATH, `started pid=${child.pid} runtime=postgres\n`, { flag: 'a' });
  child.unref();
  console.log(`rag-daemon started pid=${child.pid}`);
}

function statusDaemon(): void {
  const pid = readPid();
  const running = pid ? isProcessRunning(pid) : false;
  const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : null;

  console.log(
    JSON.stringify(
      {
        running,
        pid: running ? pid : undefined,
        state,
      },
      null,
      2
    )
  );
}

function stopDaemon(): void {
  const pid = readPid();
  if (!pid || !isProcessRunning(pid)) {
    rmSync(PID_PATH, { force: true });
    console.log('rag-daemon not running');
    return;
  }

  process.kill(pid, 'SIGTERM');
  rmSync(PID_PATH, { force: true });
  console.log(`rag-daemon stopped pid=${pid}`);
}

async function runDaemon(): Promise<void> {
  const startedAt = new Date().toISOString();
  writeFileSync(PID_PATH, `${process.pid}\n`, 'utf8');
  writeState(startedAt);

  const heartbeat = setInterval(() => writeState(startedAt), 5_000);
  const shutdown = () => {
    clearInterval(heartbeat);
    rmSync(PID_PATH, { force: true });
    process.exit(0);
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'status';
  if (command === 'start') {
    await startDaemon();
    return;
  }
  if (command === 'status') {
    statusDaemon();
    return;
  }
  if (command === 'stop') {
    stopDaemon();
    return;
  }
  if (command === 'run') {
    await runDaemon();
    return;
  }

  throw new Error(`Unknown rag-daemon command: ${command}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
