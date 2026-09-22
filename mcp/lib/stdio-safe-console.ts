import { format } from 'node:util';

type ConsoleMethod = 'log' | 'info' | 'debug';
type ConsoleFunction = (...args: unknown[]) => void;

const originalConsole: Record<ConsoleMethod, ConsoleFunction> = {
  log: console.log,
  info: console.info,
  debug: console.debug,
};

let activeRedirects = 0;

function writeToStderr(...args: unknown[]): void {
  process.stderr.write(`${format(...args)}\n`);
}

function setRedirectedConsole(): void {
  console.log = writeToStderr;
  console.info = writeToStderr;
  console.debug = writeToStderr;
}

function restoreConsole(): void {
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.debug = originalConsole.debug;
}

export async function runWithStdioSafeConsole<T>(operation: () => Promise<T> | T): Promise<T> {
  if (activeRedirects === 0) {
    setRedirectedConsole();
  }
  activeRedirects += 1;

  try {
    return await operation();
  } finally {
    activeRedirects -= 1;
    if (activeRedirects === 0) {
      restoreConsole();
    }
  }
}
