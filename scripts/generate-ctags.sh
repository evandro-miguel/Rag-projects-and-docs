#!/bin/bash
# Generate ctags-like symbol index using grep
# Faster and more reliable than Node.js for simple pattern matching

OUTPUT_FILE="${1:-symbol-index.txt}"
SEARCH_DIR="${2:-.}"

echo "🔍 Generating symbol index for $SEARCH_DIR..."
echo "Output: $OUTPUT_FILE"
echo ""

# Find all TypeScript files
find "$SEARCH_DIR" \
  -type f \
  -name "*.ts" -o -name "*.tsx" \
  -not -path "*/node_modules/*" \
  -not -path "*/.git/*" \
  -not -path "*/dist/*" \
  -not -path "*/build/*" \
  -not -path "*/.qwen/*" \
  -not -path "*/.afol/wb/*" \
  -not -path "*/coverage/*" \
  > /tmp/ts_files.txt

echo "Found $(wc -l < /tmp/ts_files.txt) TypeScript files"

# Extract symbols
{
  echo "# Symbol Index"
  echo "# Generated: $(date -Iseconds)"
  echo "# Files: $(wc -l < /tmp/ts_files.txt)"
  echo ""
  echo "## Exports"
  echo ""

  # Export const
  grep -rn "^export const [A-Za-z_]" "$SEARCH_DIR" \
    --include="*.ts" \
    --include="*.tsx" \
    --exclude-dir=node_modules \
    --exclude-dir=.git \
    --exclude-dir=dist \
    --exclude-dir=.qwen \
    --exclude-dir=".afol/wb" \
    | head -500

  echo ""
  echo "## Functions"
  echo ""

  # Export function
  grep -rn "^export function [A-Za-z_]" "$SEARCH_DIR" \
    --include="*.ts" \
    --include="*.tsx" \
    --exclude-dir=node_modules \
    --exclude-dir=.git \
    --exclude-dir=dist \
    --exclude-dir=.qwen \
    --exclude-dir=".afol/wb" \
    | head -300

  echo ""
  echo "## Classes/Interfaces"
  echo ""

  # Export class/interface
  grep -rn "^export \(class\|interface\) [A-Za-z_]" "$SEARCH_DIR" \
    --include="*.ts" \
    --include="*.tsx" \
    --exclude-dir=node_modules \
    --exclude-dir=.git \
    --exclude-dir=dist \
    --exclude-dir=.qwen \
    --exclude-dir=".afol/wb" \
    | head -200

} > "$OUTPUT_FILE"

echo ""
echo "✅ Symbol index generated!"
echo "📄 Lines: $(wc -l < "$OUTPUT_FILE")"
echo ""
echo "Top files by symbol count:"
cut -d: -f1 "$OUTPUT_FILE" | sort | uniq -c | sort -rn | head -10
