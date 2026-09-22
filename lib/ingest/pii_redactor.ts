/**
 * @module ingest/pii_redactor
 * @description PII detection and redaction middleware for document ingestion.
 *
 * This module provides functionality to detect and redact Personally Identifiable
 * Information (PII) before content is chunked and embedded. This ensures sensitive
 * data never enters the vector database.
 *
 * Supported PII types:
 * - CPF (Brazilian individual taxpayer ID)
 * - CNPJ (Brazilian company taxpayer ID)
 * - Email addresses
 * - Brazilian phone numbers
 * - US SSN (Social Security Number)
 * - Credit card numbers
 *
 * @security SC-05: PII never enters embeddings
 *
 * @example
 * // Detect PII in text
 * import { detectPII, redactPII } from './pii_redactor.js';
 * const matches = detectPII(text);
 * const redacted = redactPII(text);
 */

/**
 * Types of PII that can be detected and redacted.
 */
export type PIIType = 'cpf' | 'cnpj' | 'email' | 'phone_br' | 'ssn' | 'credit_card';

/**
 * Represents a detected PII match in text.
 */
export interface PIIMatch {
  /** Type of PII detected */
  type: PIIType;
  /** The exact matched text */
  value: string;
  /** Start position in the original text */
  startIndex: number;
  /** End position in the original text */
  endIndex: number;
  /** Suggested redaction placeholder */
  placeholder: string;
}

/**
 * Result of PII redaction containing both redacted text and match details.
 */
export interface RedactionResult {
  /** Text with PII replaced by placeholders */
  redactedText: string;
  /** All PII matches found and redacted */
  matches: PIIMatch[];
  /** Whether any PII was found */
  hasPII: boolean;
}

/**
 * Configuration options for PII redaction.
 */
export interface RedactionOptions {
  /** Custom replacement pattern. Use {type} for PII type placeholder */
  replacementPattern?: string;
  /** Types of PII to detect. Defaults to all types */
  types?: PIIType[];
  /** Whether to preserve formatting in redacted text */
  preserveFormatting?: boolean;
}

/**
 * Default placeholder mappings for each PII type.
 */
const DEFAULT_PLACEHOLDERS: Record<PIIType, string> = {
  cpf: '[REDACTED_CPF]',
  cnpj: '[REDACTED_CNPJ]',
  email: '[REDACTED_EMAIL]',
  phone_br: '[REDACTED_PHONE]',
  ssn: '[REDACTED_SSN]',
  credit_card: '[REDACTED_CARD]',
};

/**
 * PII detection patterns with their configurations.
 * Each pattern includes the regex and validation function for accuracy.
 */
const PII_PATTERNS: Record<
  PIIType,
  {
    pattern: RegExp;
    placeholder: string;
    description: string;
    validator?: (value: string) => boolean;
  }
> = {
  cpf: {
    // CPF: XXX.XXX.XXX-XX or XXXXXXXXXXX (11 digits)
    pattern: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g,
    placeholder: DEFAULT_PLACEHOLDERS.cpf,
    description: 'Brazilian CPF (individual taxpayer ID)',
    validator: validateCPF,
  },
  cnpj: {
    // CNPJ: XX.XXX.XXX/XXXX-XX or XXXXXXXXXXXXXX (14 digits)
    pattern: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g,
    placeholder: DEFAULT_PLACEHOLDERS.cnpj,
    description: 'Brazilian CNPJ (company taxpayer ID)',
    validator: validateCNPJ,
  },
  email: {
    // Email: standard email format
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    placeholder: DEFAULT_PLACEHOLDERS.email,
    description: 'Email address',
  },
  phone_br: {
    // Brazilian phone: multiple formats
    // (XX) XXXXX-XXXX, (XX) XXXX-XXXX, +55 XX XXXXX-XXXX, etc.
    pattern: /(?:\+55\s?)?(?:\(?[1-9]{2}\)?\s?)?(?:9\d{4}|[2-8]\d{3})[-\s]?\d{4}/g,
    placeholder: DEFAULT_PLACEHOLDERS.phone_br,
    description: 'Brazilian phone number',
  },
  ssn: {
    // US SSN: XXX-XX-XXXX
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    placeholder: DEFAULT_PLACEHOLDERS.ssn,
    description: 'US Social Security Number',
    validator: validateSSN,
  },
  credit_card: {
    // Credit card: 13-19 digits, possibly with spaces or dashes
    pattern: /\b(?:\d{4}[-\s]?){3,4}\d{1,4}\b/g,
    placeholder: DEFAULT_PLACEHOLDERS.credit_card,
    description: 'Credit card number',
    validator: validateCreditCard,
  },
};

/**
 * Validates a CPF number using the official algorithm.
 * CPF must pass the checksum verification.
 *
 * @param cpf - CPF string (digits only or formatted)
 * @returns true if valid CPF checksum
 */
function validateCPF(cpf: string): boolean {
  // Remove non-digits
  const digits = cpf.replace(/\D/g, '');

  // Must be 11 digits
  if (digits.length !== 11) return false;

  // Check for all same digits (invalid but passes checksum)
  if (/^(\d)\1+$/.test(digits)) return false;

  // Validate check digits
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += Number.parseInt(digits[i], 10) * (10 - i);
  }
  let remainder = (sum * 10) % 11;
  if (remainder === 10) remainder = 0;
  if (remainder !== Number.parseInt(digits[9], 10)) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += Number.parseInt(digits[i], 10) * (11 - i);
  }
  remainder = (sum * 10) % 11;
  if (remainder === 10) remainder = 0;
  if (remainder !== Number.parseInt(digits[10], 10)) return false;

  return true;
}

/**
 * Validates a CNPJ number using the official algorithm.
 * CNPJ must pass the checksum verification.
 *
 * @param cnpj - CNPJ string (digits only or formatted)
 * @returns true if valid CNPJ checksum
 */
function validateCNPJ(cnpj: string): boolean {
  // Remove non-digits
  const digits = cnpj.replace(/\D/g, '');

  // Must be 14 digits
  if (digits.length !== 14) return false;

  // Check for all same digits (invalid but passes checksum)
  if (/^(\d)\1+$/.test(digits)) return false;

  // Validate check digits
  const weights1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const weights2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number.parseInt(digits[i], 10) * weights1[i];
  }
  let remainder = sum % 11;
  const digit1 = remainder < 2 ? 0 : 11 - remainder;
  if (digit1 !== Number.parseInt(digits[12], 10)) return false;

  sum = 0;
  for (let i = 0; i < 13; i++) {
    sum += Number.parseInt(digits[i], 10) * weights2[i];
  }
  remainder = sum % 11;
  const digit2 = remainder < 2 ? 0 : 11 - remainder;
  if (digit2 !== Number.parseInt(digits[13], 10)) return false;

  return true;
}

/**
 * Validates a US SSN format and range.
 * SSN must not have invalid area/group/serial numbers.
 *
 * @param ssn - SSN string in XXX-XX-XXXX format
 * @returns true if valid SSN format and range
 */
function validateSSN(ssn: string): boolean {
  const match = ssn.match(/^(\d{3})-(\d{2})-(\d{4})$/);
  if (!match) return false;

  const [, area, group, serial] = match;

  // Area cannot be 000, 666, or 900-999
  const areaNum = Number.parseInt(area, 10);
  if (areaNum === 0 || areaNum === 666 || areaNum >= 900) return false;

  // Group cannot be 00
  if (group === '00') return false;

  // Serial cannot be 0000
  if (serial === '0000') return false;

  return true;
}

/**
 * Validates a credit card number using the Luhn algorithm.
 *
 * @param cardNumber - Credit card string (digits only or formatted)
 * @returns true if valid Luhn checksum
 */
function validateCreditCard(cardNumber: string): boolean {
  // Remove non-digits
  const digits = cardNumber.replace(/\D/g, '');

  // Must be 13-19 digits
  if (digits.length < 13 || digits.length > 19) return false;

  // Luhn algorithm
  let sum = 0;
  let isEven = false;

  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number.parseInt(digits[i], 10);

    if (isEven) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    isEven = !isEven;
  }

  return sum % 10 === 0;
}

/**
 * Detects all PII matches in the given text.
 *
 * Scans text for all configured PII types and returns an array of matches
 * with their positions and types. Matches are sorted by start position.
 *
 * @param text - Text to scan for PII
 * @param types - Optional array of PII types to detect (defaults to all)
 * @returns Array of PIIMatch objects sorted by position
 *
 * @example
 * const matches = detectPII('Contact: joao@email.com, CPF: 123.456.789-00');
 * // Returns array with email and CPF matches
 */
export function detectPII(text: string, types?: PIIType[]): PIIMatch[] {
  const typesToCheck = types ?? (Object.keys(PII_PATTERNS) as PIIType[]);
  const matches: PIIMatch[] = [];

  for (const type of typesToCheck) {
    const config = PII_PATTERNS[type];
    const regex = new RegExp(config.pattern.source, config.pattern.flags);

    let match = regex.exec(text);
    while (match !== null) {
      const value = match[0];

      // Validate if validator exists
      if (config.validator && !config.validator(value)) {
        match = regex.exec(text);
        continue;
      }

      matches.push({
        type,
        value,
        startIndex: match.index,
        endIndex: match.index + value.length,
        placeholder: config.placeholder,
      });
      match = regex.exec(text);
    }
  }

  // Sort by start position (and longer match first when starts are equal)
  matches.sort((a: PIIMatch, b: PIIMatch) => {
    if (a.startIndex !== b.startIndex) return a.startIndex - b.startIndex;
    return b.endIndex - a.endIndex;
  });

  // Resolve overlap conflicts to avoid corrupt replacements.
  // Example: credit card numbers can also match the phone regex.
  const filtered: PIIMatch[] = [];
  for (const match of matches) {
    const last = filtered[filtered.length - 1];
    if (!last) {
      filtered.push(match);
      continue;
    }

    const overlaps = match.startIndex < last.endIndex;
    if (!overlaps) {
      filtered.push(match);
      continue;
    }

    const lastLen = last.endIndex - last.startIndex;
    const currentLen = match.endIndex - match.startIndex;
    if (currentLen > lastLen) {
      filtered[filtered.length - 1] = match;
    }
  }

  return filtered;
}

/**
 * Redacts all PII in the given text by replacing with placeholders.
 *
 * @param text - Text to redact PII from
 * @param replacement - Optional custom replacement string (default: type-specific placeholders)
 * @returns Text with PII replaced by placeholders
 *
 * @example
 * const redacted = redactPII('My CPF is 123.456.789-00');
 * // Returns: 'My CPF is [REDACTED_CPF]'
 */
export function redactPII(text: string, replacement?: string): string {
  const matches = detectPII(text);

  if (matches.length === 0) return text;

  // Process from end to start to preserve indices
  let result = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const placeholder = replacement ?? match.placeholder;
    result = result.slice(0, match.startIndex) + placeholder + result.slice(match.endIndex);
  }

  return result;
}

/**
 * Redacts PII with full result including match details.
 *
 * @param text - Text to redact PII from
 * @param options - Redaction options
 * @returns RedactionResult with redacted text and match details
 *
 * @example
 * const result = redactPIIWithDetails('Contact: joao@email.com');
 * console.log(result.redactedText); // 'Contact: [REDACTED_EMAIL]'
 * console.log(result.hasPII); // true
 */
export function redactPIIWithDetails(
  text: string,
  options: RedactionOptions = {}
): RedactionResult {
  const matches = detectPII(text, options.types);

  if (matches.length === 0) {
    return {
      redactedText: text,
      matches: [],
      hasPII: false,
    };
  }

  let result = text;

  // Apply custom replacement pattern if provided
  if (options.replacementPattern) {
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      const placeholder = options.replacementPattern.replace('{type}', match.placeholder);
      result = result.slice(0, match.startIndex) + placeholder + result.slice(match.endIndex);
    }
  } else {
    // Standard redaction
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      result = result.slice(0, match.startIndex) + match.placeholder + result.slice(match.endIndex);
    }
  }

  return {
    redactedText: result,
    matches,
    hasPII: true,
  };
}

/**
 * Creates a middleware function for the ingestion pipeline.
 *
 * The middleware detects and redacts PII from content before it's processed
 * further (chunked, embedded). The original content is preserved for storage,
 * while the redacted version is used for embeddings.
 *
 * @param options - Configuration options for the middleware
 * @returns Middleware function that processes content
 *
 * @example
 * const middleware = createRedactionMiddleware();
 * const result = middleware(documentContent);
 * // result.originalContent - original text
 * // result.redactedContent - text with PII redacted
 * // result.piiMatches - detected PII details
 */
export function createRedactionMiddleware(options: RedactionOptions = {}): (content: string) => {
  originalContent: string;
  redactedContent: string;
  piiMatches: PIIMatch[];
  hasPII: boolean;
} {
  return (content: string) => {
    const result = redactPIIWithDetails(content, options);

    return {
      originalContent: content,
      redactedContent: result.redactedText,
      piiMatches: result.matches,
      hasPII: result.hasPII,
    };
  };
}

/**
 * Performance-optimized batch PII detection for multiple documents.
 *
 * Processes multiple texts in a single pass, useful for batch ingestion.
 * Optimized for performance (<10ms per document target).
 *
 * @param texts - Array of texts to process
 * @param types - Optional PII types to detect
 * @returns Array of PIIMatch arrays, one per input text
 *
 * @example
 * const results = detectPIIBatch(['doc1 with email@test.com', 'doc2 with CPF']);
 */
export function detectPIIBatch(texts: string[], types?: PIIType[]): PIIMatch[][] {
  return texts.map((text) => detectPII(text, types));
}

/**
 * Performance-optimized batch PII redaction.
 *
 * @param texts - Array of texts to redact
 * @param replacement - Optional custom replacement
 * @returns Array of redacted texts
 */
export function redactPIIBatch(texts: string[], replacement?: string): string[] {
  return texts.map((text) => redactPII(text, replacement));
}

/**
 * Check if text contains any PII without returning details.
 * Fast check for early filtering.
 *
 * @param text - Text to check
 * @returns true if any PII is detected
 */
export function hasPII(text: string): boolean {
  const types = Object.keys(PII_PATTERNS) as PIIType[];

  for (const type of types) {
    const config = PII_PATTERNS[type];
    const regex = new RegExp(config.pattern.source, config.pattern.flags);
    const match = regex.exec(text);

    if (match) {
      // Validate if validator exists
      if (config.validator && !config.validator(match[0])) {
        continue;
      }
      return true;
    }
  }

  return false;
}

/**
 * Get a summary of PII types found in text.
 *
 * @param text - Text to analyze
 * @returns Record of PII types to count of occurrences
 */
export function getPIISummary(text: string): Record<PIIType, number> {
  const matches = detectPII(text);
  const summary: Record<PIIType, number> = {
    cpf: 0,
    cnpj: 0,
    email: 0,
    phone_br: 0,
    ssn: 0,
    credit_card: 0,
  };

  for (const match of matches) {
    summary[match.type]++;
  }

  return summary;
}
