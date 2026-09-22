import { describe, expect, it } from 'vitest';
import { assessExternalDocContent } from '../external-doc-quality.js';

describe('external-doc-quality', () => {
  it('accepts technical prose with code and lightweight HTML', () => {
    const result = assessExternalDocContent(`
# FastAPI CLI

Run the development server with:

<div class="termy"><span>fastapi dev</span></div>

\`\`\`bash
fastapi dev
\`\`\`
`);

    expect(result.valid).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it.each([
    ['', 'empty'],
    ['   \n\t', 'empty'],
    ['![](epub-cover.png)', 'non-semantic'],
    ['<iframe src="form"></iframe>\n<script src="widget.js"></script>', 'non-semantic'],
    ['<!--{ "Redirect": "/doc/gdb" }-->', 'redirect-only'],
    ['--8<-- "CONTRIBUTING.md"', 'include-only'],
    ['.. include:: README.rst', 'include-only'],
    ['.. include:: README.rst\n   :start-line: 1', 'include-only'],
    ['.. include:: README.rst\n\n.. Cache-generated source placeholder only', 'include-only'],
    [
      '.. include:: README.rst\n\n.. Cache-generated source placeholder only\n   This body is generated too.',
      'include-only',
    ],
    [
      '.. include:: first.rst\n   :start-line: 1\n\n.. include:: second.rst\n   :end-line: 5',
      'include-only',
    ],
    ['.. include:: example.rst\n   :caption: A long\n     caption continuation', 'include-only'],
  ])('rejects non-retrievable content (%s)', (content, reason) => {
    const result = assessExternalDocContent(content);

    expect(result.valid).toBe(false);
    expect(result.reasons).toContain(reason);
  });

  it('accepts semantic prose surrounding RST includes', () => {
    const result = assessExternalDocContent(`
Introductory context for the included examples.

.. include:: example.rst
   :start-line: 1

The surrounding section explains how the included example is used.
`);

    expect(result.valid).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('rejects control characters while allowing tabs and newlines', () => {
    const result = assessExternalDocContent('# Install\n\nLinux users \u0014 install unzip.');

    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('control-character');
  });
});
