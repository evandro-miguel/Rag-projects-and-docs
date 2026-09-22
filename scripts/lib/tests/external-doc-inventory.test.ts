import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyExternalDocEntries,
  removeGeneratedExternalDocArtifacts,
} from '../external-doc-inventory.js';

describe('external-doc-inventory', () => {
  it('separates retrievable sources from generated navigation artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'external-doc-inventory-'));
    const useful = join(root, 'useful.md');
    const redirect = join(root, 'redirect.md');
    writeFileSync(useful, '# API\n\nUse the stable API for technical work.');
    writeFileSync(redirect, '<!--{ "Redirect": "/api" }-->');

    const result = classifyExternalDocEntries(
      [
        { rawFile: useful, relativePath: 'useful.md' },
        { rawFile: redirect, relativePath: 'redirect.md' },
      ],
      'provider-docs',
      (content) => content
    );

    expect(result.eligible.map(({ sourcePath }) => sourcePath)).toEqual([
      'provider-docs/useful.md',
    ]);
    expect(result.excluded[0]?.quality.reasons).toContain('redirect-only');
  });

  it.each([
    ['', 'empty'],
    ['<!--{ "Redirect": "/api" }-->', 'redirect-only'],
    ['--8<-- "shared.md"', 'include-only'],
  ])('excludes current invalid content %j regardless of cached output', (content, reason) => {
    const root = mkdtempSync(join(tmpdir(), 'external-doc-cache-aware-'));
    const rawFile = join(root, 'redirect.md');
    writeFileSync(rawFile, content);
    writeFileSync(join(root, 'processed.md'), '# API\n\nUse the stable API for technical work.');

    const result = classifyExternalDocEntries(
      [{ rawFile, relativePath: 'redirect.md' }],
      'provider-docs',
      (raw) => raw
    );

    expect(result.eligible).toEqual([]);
    expect(result.excluded[0]?.quality.reasons).toContain(reason);
  });

  it('skips raw symlink leaves and matching directories before reading content', () => {
    const root = mkdtempSync(join(tmpdir(), 'external-doc-raw-inputs-'));
    const outside = mkdtempSync(join(tmpdir(), 'external-doc-raw-outside-'));
    const symlink = join(root, 'linked.md');
    const directory = join(root, 'directory.md');
    writeFileSync(join(outside, 'linked.md'), '# Escaped source\n\nThis must not be read.');
    symlinkSync(join(outside, 'linked.md'), symlink);
    mkdirSync(directory);

    const result = classifyExternalDocEntries(
      [
        { rawFile: symlink, relativePath: 'linked.md' },
        { rawFile: directory, relativePath: 'directory.md' },
      ],
      'provider-docs',
      (content) => content
    );

    expect(result).toEqual({ eligible: [], excluded: [] });
  });

  it('removes only generated files under the selected source root', () => {
    const root = mkdtempSync(join(tmpdir(), 'external-doc-artifacts-'));
    const sourceRoot = join(root, 'provider-docs');
    const generated = join(sourceRoot, 'redirect.md');
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(generated, 'generated');

    expect(
      removeGeneratedExternalDocArtifacts(root, 'provider-docs', ['redirect.md', 'missing.md'])
    ).toEqual(['redirect.md']);
    expect(() => readFileSync(generated)).toThrow();
    expect(() =>
      removeGeneratedExternalDocArtifacts(root, 'provider-docs', ['../outside.md'])
    ).toThrow('unsafe generated Docs artifact path');
  });

  it('rejects generated artifacts that resolve through a symlink outside the source root', () => {
    const root = mkdtempSync(join(tmpdir(), 'external-doc-symlink-'));
    const sourceRoot = join(root, 'provider-docs');
    const outsideRoot = mkdtempSync(join(tmpdir(), 'external-doc-outside-'));
    const outside = join(outsideRoot, 'redirect.md');
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(outside, 'must remain');
    symlinkSync(outside, join(sourceRoot, 'redirect.md'));

    expect(() =>
      removeGeneratedExternalDocArtifacts(root, 'provider-docs', ['redirect.md'])
    ).toThrow('outside source root');
    expect(readFileSync(outside, 'utf-8')).toBe('must remain');
  });

  it('rejects a symlinked generated-artifact source root before deletion', () => {
    const root = mkdtempSync(join(tmpdir(), 'external-doc-source-link-'));
    const outsideRoot = mkdtempSync(join(tmpdir(), 'external-doc-source-outside-'));
    const outside = join(outsideRoot, 'redirect.md');
    writeFileSync(outside, 'must remain');
    symlinkSync(outsideRoot, join(root, 'provider-docs'));

    expect(() =>
      removeGeneratedExternalDocArtifacts(root, 'provider-docs', ['redirect.md'])
    ).toThrow('symlinked source root');
    expect(readFileSync(outside, 'utf-8')).toBe('must remain');
  });

  it('rejects a source name that escapes the processed root', () => {
    const root = mkdtempSync(join(tmpdir(), 'external-doc-source-escape-'));
    const outsideRoot = mkdtempSync(join(tmpdir(), 'external-doc-source-escape-outside-'));
    const outside = join(outsideRoot, 'redirect.md');
    writeFileSync(outside, 'must remain');

    expect(() => removeGeneratedExternalDocArtifacts(root, '../outside', ['redirect.md'])).toThrow(
      'unsafe generated Docs source root'
    );
    expect(readFileSync(outside, 'utf-8')).toBe('must remain');
  });

  it('rejects a symlinked processed root before resolving generated artifacts', () => {
    const parent = mkdtempSync(join(tmpdir(), 'external-doc-root-link-'));
    const processedRoot = join(parent, 'processed');
    const outsideRoot = mkdtempSync(join(tmpdir(), 'external-doc-root-outside-'));
    const outside = join(outsideRoot, 'provider-docs', 'redirect.md');
    mkdirSync(join(outsideRoot, 'provider-docs'), { recursive: true });
    writeFileSync(outside, 'must remain');
    symlinkSync(outsideRoot, processedRoot);

    expect(() =>
      removeGeneratedExternalDocArtifacts(processedRoot, 'provider-docs', ['redirect.md'])
    ).toThrow('symlinked processed root');
    expect(readFileSync(outside, 'utf-8')).toBe('must remain');
  });

  it('rejects a processed root with a symlinked ancestor', () => {
    const parent = mkdtempSync(join(tmpdir(), 'external-doc-ancestor-link-'));
    const linkParent = join(parent, 'linked-parent');
    const outsideRoot = mkdtempSync(join(tmpdir(), 'external-doc-ancestor-outside-'));
    const processedRoot = join(linkParent, 'processed');
    const outside = join(outsideRoot, 'processed', 'provider-docs', 'redirect.md');
    mkdirSync(join(outsideRoot, 'processed', 'provider-docs'), { recursive: true });
    writeFileSync(outside, 'must remain');
    symlinkSync(outsideRoot, linkParent);

    expect(() =>
      removeGeneratedExternalDocArtifacts(processedRoot, 'provider-docs', ['redirect.md'])
    ).toThrow('symlinked processed root');
    expect(readFileSync(outside, 'utf-8')).toBe('must remain');
  });
});
