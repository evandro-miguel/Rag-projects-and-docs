export type ExternalDocQualityReason =
  | 'empty'
  | 'control-character'
  | 'include-only'
  | 'redirect-only'
  | 'non-semantic';

export interface ExternalDocQualityAssessment {
  readonly valid: boolean;
  readonly reasons: ExternalDocQualityReason[];
  readonly semanticCharacters: number;
}

const REDIRECT_ONLY_REGEX =
  /^\s*(?:<!--[\s\S]*?"Redirect"\s*:\s*"[^"]+"[\s\S]*?-->|\{\s*"Redirect"\s*:\s*"[^"]+"\s*\}|\[\s*"Redirect"\s*:\s*"[^"]+"\s*\])\s*$/iu;
const MARKDOWN_INCLUDE_ONLY_REGEX = /^\s*--8<--\s*["'][^"']+["']\s*$/iu;
const RST_INCLUDE_DIRECTIVE_REGEX = /^\s*\.\.\s+(?:include|literalinclude)::\s+\S+\s*$/iu;
const RST_DIRECTIVE_OPTION_REGEX = /^([ \t]+):[A-Za-z][\w-]*:\s*.*$/u;
const RST_COMMENT_LINE_REGEX = /^([ \t]*)\.\.(?!\s+[A-Za-z][\w-]*::)(?:\s+.*)?$/u;
const FRONTMATTER_REGEX = /^\s*---\s*\n[\s\S]*?\n---(?:\s*\n|$)/u;
const SCRIPT_STYLE_EMBED_REGEX =
  /<(?:script|style|iframe)\b[^>]*>[\s\S]*?<\/(?:script|style|iframe)>/giu;
const SELF_CLOSING_EMBED_REGEX = /<(?:script|style|iframe)\b[^>]*\/?>/giu;
const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/gu;
const MARKDOWN_IMAGE_REGEX = /!\[[^\]]*\]\([^)]*\)/gu;
const HTML_TAG_REGEX = /<\/?[A-Za-z][^>]*>/gu;
const URL_REGEX = /\bhttps?:\/\/\S+/gu;
const SEMANTIC_CHARACTER_REGEX = /[\p{L}\p{N}]/gu;
const MIN_SEMANTIC_CHARACTERS = 16;

export function normalizeExternalDocControlCharacters(content: string): string {
  return [...content]
    .map((character) => (isExternalDocControlCharacter(character) ? ' ' : character))
    .join('');
}

function isExternalDocControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return (
    codePoint !== undefined &&
    (codePoint <= 8 ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127)
  );
}

function containsExternalDocControlCharacter(content: string): boolean {
  return [...content].some(isExternalDocControlCharacter);
}

function isRstIncludeOnlyContent(content: string): boolean {
  let includeDirectiveCount = 0;
  let canReadDirectiveOptions = false;
  let optionIndentation = 0;
  let commentIndentation: number | null = null;

  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) {
      canReadDirectiveOptions = false;
      optionIndentation = 0;
      continue;
    }
    if (RST_INCLUDE_DIRECTIVE_REGEX.test(line)) {
      includeDirectiveCount += 1;
      canReadDirectiveOptions = true;
      optionIndentation = 0;
      commentIndentation = null;
      continue;
    }
    if (commentIndentation !== null) {
      const indentation = line.match(/^[ \t]*/u)?.[0].length ?? 0;
      if (indentation > commentIndentation) {
        continue;
      }
      commentIndentation = null;
    }
    const commentMatch = RST_COMMENT_LINE_REGEX.exec(line);
    if (commentMatch) {
      commentIndentation = commentMatch[1].length;
      canReadDirectiveOptions = false;
      optionIndentation = 0;
      continue;
    }
    const optionMatch = RST_DIRECTIVE_OPTION_REGEX.exec(line);
    if (canReadDirectiveOptions && optionMatch) {
      optionIndentation = optionMatch[1].length;
      continue;
    }
    if (canReadDirectiveOptions && optionIndentation > 0) {
      const indentation = line.match(/^[ \t]*/u)?.[0].length ?? 0;
      if (indentation > optionIndentation) {
        continue;
      }
    }
    return false;
  }

  return includeDirectiveCount > 0;
}

function semanticCharacterCount(content: string): number {
  const withoutPresentation = content
    .replace(FRONTMATTER_REGEX, '')
    .replace(SCRIPT_STYLE_EMBED_REGEX, ' ')
    .replace(SELF_CLOSING_EMBED_REGEX, ' ')
    .replace(HTML_COMMENT_REGEX, ' ')
    .replace(MARKDOWN_IMAGE_REGEX, ' ')
    .replace(HTML_TAG_REGEX, ' ')
    .replace(URL_REGEX, ' ');
  return withoutPresentation.match(SEMANTIC_CHARACTER_REGEX)?.length ?? 0;
}

export function assessExternalDocContent(content: string): ExternalDocQualityAssessment {
  const reasons: ExternalDocQualityReason[] = [];
  const trimmed = content.trim();

  if (!trimmed) {
    reasons.push('empty');
  } else {
    if (containsExternalDocControlCharacter(content)) {
      reasons.push('control-character');
    }
    if (MARKDOWN_INCLUDE_ONLY_REGEX.test(trimmed) || isRstIncludeOnlyContent(trimmed)) {
      reasons.push('include-only');
    }
    if (REDIRECT_ONLY_REGEX.test(trimmed)) {
      reasons.push('redirect-only');
    }
  }

  const semanticCharacters = semanticCharacterCount(content);
  if (trimmed && semanticCharacters < MIN_SEMANTIC_CHARACTERS) {
    reasons.push('non-semantic');
  }

  return {
    valid: reasons.length === 0,
    reasons,
    semanticCharacters,
  };
}
