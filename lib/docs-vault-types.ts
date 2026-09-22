export interface DocsVaultSearchMetadata {
  sourceId?: string;
  category?: string;
  language?: string;
  kind?: 'official-docs' | 'book' | 'package-docs' | 'repository-docs';
  authority?: 'official' | 'publisher' | 'community-vetted';
  tags?: readonly string[];
  canonicalUrl?: string;
  canonicalPath?: string;
  wikiPath?: string;
  rawPath?: string;
  wikiReference?: string;
  pageId?: string;
  trustLevel?: 'official' | 'publisher' | 'community-vetted';
}
