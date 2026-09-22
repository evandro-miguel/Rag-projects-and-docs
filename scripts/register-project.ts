import path from 'node:path';

interface CliArgs {
  rootPath?: string;
}

const LEGACY_ENTRYPOINT_MESSAGE = [
  'scripts/register-project.ts is retired.',
  'Use the supported Postgres wrapper instead:',
  '  bun run register-project -- <args>',
].join('\n');

export function resolveRegistrationRootPath(
  args: CliArgs,
  options: {
    projectSourcePath?: string;
  } = {}
): string {
  const requestedRoot = args.rootPath ?? options.projectSourcePath;
  if (!requestedRoot) {
    throw new Error(
      'Project root path is required. Pass --root <absolute-path> or set PROJECT_SOURCE_PATH.'
    );
  }

  return path.resolve(requestedRoot);
}

export async function main(): Promise<never> {
  console.error(LEGACY_ENTRYPOINT_MESSAGE);
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
