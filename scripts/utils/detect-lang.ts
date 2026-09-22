export type SearchContext = {
  lang?: string;
  ecosystem?: string;
};

/**
 * Builds the search context based on the active file extension.
 * Derives both language and the primary ecosystem for fallback.
 */
export function buildSearchContext(activeFile: string): SearchContext {
  if (!activeFile) return {};

  const ext = activeFile.split('.').pop()?.toLowerCase();

  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      return { lang: 'ts', ecosystem: 'node' }; // Or 'bun', standardizing on 'node' ecosystem for JS/TS
    case 'py':
      return { lang: 'py', ecosystem: 'python' };
    case 'go':
      return { lang: 'go', ecosystem: 'go' };
    case 'rs':
      return { lang: 'rs', ecosystem: 'rust' };
    default:
      return {};
  }
}
