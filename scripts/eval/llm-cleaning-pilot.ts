import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { glob } from 'glob';
import { getRefinerRuntimeConfig, refineDocument } from '../lib/llm-refiner.js';

interface PilotOptions {
  sourceRoot: string;
  sourcePrefix: string;
  limit: number;
  outBaseDir: string;
  pattern: string;
}

interface FileStats {
  imports: number;
  jsxTags: number;
  siteRefs: number;
  chars: number;
  hasYamlFenceTop: boolean;
  hasUnknownSource: boolean;
  hasFrontmatter: boolean;
}

interface FileResult {
  file: string;
  relativePath: string;
  sourcePath: string;
  status: 'ok' | 'error';
  before: FileStats;
  after?: FileStats;
  error?: string;
}

type NumericStatsKey = 'imports' | 'jsxTags' | 'siteRefs' | 'chars';

const IMPORT_REGEX = /^\s*import\s+/gmu;
const JSX_TAG_REGEX = /^\s*<\/?[A-Z][A-Za-z0-9]*(\s+[^>]*)?\/?>\s*$/gmu;
const SITE_COMPONENT_PATH_REGEX = /@site\/src\/components/gmu;
const YAML_FENCE_TOP_REGEX = /^```yaml\s*$/u;
const UNKNOWN_SOURCE_REGEX = /^source:\s*["']unknown["']\s*$/mu;

function parseOptions(argv: string[] = process.argv.slice(2)): PilotOptions {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      continue;
    }
    const [flag, value] = arg.includes('=')
      ? arg.split('=', 2)
      : [arg, argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : ''];
    if (!arg.includes('=') && value) {
      i += 1;
    }
    args.set(flag, value ?? '');
  }

  const sourceRoot = args.get('--source-root') || 'ingest/source/external/bun-docs';
  const sourcePrefix = args.get('--source-prefix') || 'bun-docs';
  const outBaseDir = args.get('--out-dir') || '.data/llm-cleaning-pilot';
  const pattern = args.get('--pattern') || '**/*.{md,mdx}';
  const rawLimit = Number.parseInt(args.get('--limit') || '10', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 10;

  return { sourceRoot, sourcePrefix, limit, outBaseDir, pattern };
}

function toTimestamp(date = new Date()): string {
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return [
    date.getUTCFullYear().toString(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    '_',
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join('');
}

function sanitizeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function countMatches(content: string, pattern: RegExp): number {
  return (content.match(pattern) ?? []).length;
}

function collectStats(content: string): FileStats {
  const normalized = content.replace(/\r\n/gu, '\n');
  return {
    imports: countMatches(normalized, IMPORT_REGEX),
    jsxTags: countMatches(normalized, JSX_TAG_REGEX),
    siteRefs: countMatches(normalized, SITE_COMPONENT_PATH_REGEX),
    chars: normalized.length,
    hasYamlFenceTop: YAML_FENCE_TOP_REGEX.test(normalized.split('\n')[0]?.trim() ?? ''),
    hasUnknownSource: UNKNOWN_SOURCE_REGEX.test(normalized),
    hasFrontmatter: normalized.startsWith('---\n'),
  };
}

function writeTextFile(targetPath: string, content: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, content, 'utf-8');
}

function sumField(results: FileResult[], side: 'before' | 'after', key: NumericStatsKey): number {
  return results.reduce((accumulator, result) => {
    if (result.status !== 'ok') {
      return accumulator;
    }
    const stats = side === 'before' ? result.before : result.after;
    return accumulator + (stats?.[key] ?? 0);
  }, 0);
}

async function main(): Promise<void> {
  const options = parseOptions();
  const runtime = getRefinerRuntimeConfig();
  const files = (
    await glob(options.pattern, {
      cwd: options.sourceRoot,
      absolute: true,
      nodir: true,
    })
  )
    .sort((left, right) => left.localeCompare(right))
    .slice(0, options.limit);

  if (files.length === 0) {
    throw new Error(`No files matched in ${options.sourceRoot} with pattern "${options.pattern}".`);
  }

  const modelLabel = sanitizeSegment(runtime.model || 'model');
  const runId = `${toTimestamp()}_${modelLabel}`;
  const runDir = join(options.outBaseDir, runId);
  const rawDir = join(runDir, 'raw');
  const cleanDir = join(runDir, 'clean');
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(cleanDir, { recursive: true });

  const selectedFiles = files.map((filePath) =>
    relative(options.sourceRoot, filePath).split('\\').join('/')
  );
  writeTextFile(join(runDir, 'files.txt'), `${selectedFiles.join('\n')}\n`);

  const startedAt = new Date().toISOString();
  const results: FileResult[] = [];

  for (const absolutePath of files) {
    const relativePath = relative(options.sourceRoot, absolutePath).split('\\').join('/');
    const sourcePath = `${options.sourcePrefix}/${relativePath}`;
    const rawContent = readFileSync(absolutePath, 'utf-8');
    const before = collectStats(rawContent);

    writeTextFile(join(rawDir, relativePath), rawContent);

    try {
      const cleanedContent = await refineDocument(rawContent, { sourcePath });
      writeTextFile(join(cleanDir, relativePath), cleanedContent);
      const after = collectStats(cleanedContent);
      results.push({
        file: absolutePath,
        relativePath,
        sourcePath,
        status: 'ok',
        before,
        after,
      });
      console.log(`OK ${relativePath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        file: absolutePath,
        relativePath,
        sourcePath,
        status: 'error',
        before,
        error: message,
      });
      console.log(`ERR ${relativePath}: ${message}`);
    }
  }

  const okResults = results.filter((result) => result.status === 'ok');
  const summary = {
    totalFiles: files.length,
    okFiles: okResults.length,
    errorFiles: results.length - okResults.length,
    totals: {
      before: {
        imports: sumField(results, 'before', 'imports'),
        jsxTags: sumField(results, 'before', 'jsxTags'),
        siteRefs: sumField(results, 'before', 'siteRefs'),
        chars: sumField(results, 'before', 'chars'),
      },
      after: {
        imports: sumField(results, 'after', 'imports'),
        jsxTags: sumField(results, 'after', 'jsxTags'),
        siteRefs: sumField(results, 'after', 'siteRefs'),
        chars: sumField(results, 'after', 'chars'),
      },
    },
    quality: {
      topYamlFenceFiles: okResults.filter((result) => result.after?.hasYamlFenceTop).length,
      unknownSourceFiles: okResults.filter((result) => result.after?.hasUnknownSource).length,
      frontmatterFiles: okResults.filter((result) => result.after?.hasFrontmatter).length,
      expandedFiles: okResults.filter((result) => (result.after?.chars ?? 0) > result.before.chars)
        .length,
      reducedFiles: okResults.filter((result) => (result.after?.chars ?? 0) < result.before.chars)
        .length,
    },
  };

  const report = {
    runDir,
    provider: runtime.provider,
    model: runtime.model,
    endpoint: runtime.endpoint ?? null,
    sourceRoot: options.sourceRoot,
    sourcePrefix: options.sourcePrefix,
    pattern: options.pattern,
    startedAt,
    finishedAt: new Date().toISOString(),
    summary,
    results,
  };

  writeTextFile(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

  console.log('---');
  console.log(`Run Dir: ${runDir}`);
  console.log(
    `Summary: ${summary.okFiles}/${summary.totalFiles} ok | imports ${summary.totals.before.imports} -> ${summary.totals.after.imports} | chars ${summary.totals.before.chars} -> ${summary.totals.after.chars}`
  );
}

await main();
