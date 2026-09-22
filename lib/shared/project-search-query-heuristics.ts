const CALLER_QUERY_PATTERNS = [
  /(?:who|what)\s+calls?\s+(\w+)/i,
  /callers?\s+of\s+(\w+)/i,
  /where\s+is\s+(\w+)\s+called/i,
  /how\s+(?:does|is)\s+(\w+)\s+(?:get|being)?\s+called/i,
];

export function detectCallerStyleProjectQuery(query: string): string | null {
  for (const pattern of CALLER_QUERY_PATTERNS) {
    const match = query.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return null;
}

export function canUseHybridKeywordFastPath(query: string): boolean {
  return detectCallerStyleProjectQuery(query) === null;
}
