import fs from 'node:fs';
import path from 'node:path';

const BASE_DIR = process.env.DOCS_LINKER_BASE_DIR || 'ingest/processed/external/bun-docs';
const TARGET_DIRS = (process.env.DOCS_LINKER_TARGET_DIRS || 'runtime,bundler,pm')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

const allFiles = [];

// 1. Collect all relevant files and their metadata
function collectFiles(dir, relativePath = '') {
  const fullPath = path.join(BASE_DIR, dir, relativePath);
  if (!fs.existsSync(fullPath)) return;
  const entries = fs.readdirSync(fullPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(relativePath, entry.name);
    const entryFullPath = path.join(fullPath, entry.name);

    if (entry.isDirectory()) {
      collectFiles(dir, entryPath);
    } else if (entry.name.endsWith('.md') && !entry.name.startsWith('_')) {
      const content = fs.readFileSync(entryFullPath, 'utf-8');
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (frontmatterMatch) {
        const yaml = frontmatterMatch[1];
        const titleMatch = yaml.match(/title:\s*"(.*?)"/) || yaml.match(/title:\s*(.*)/);
        const topicsMatch = yaml.match(/topics:\s*\[(.*?)\]/);
        const descriptionMatch =
          yaml.match(/description:\s*"(.*?)"/) || yaml.match(/description:\s*(.*)/);

        allFiles.push({
          fullPath: entryFullPath,
          relPath: path.join(dir, entryPath),
          dir: path.join(dir, relativePath),
          title: titleMatch ? titleMatch[1].replace(/"/g, '') : entry.name,
          topics: topicsMatch
            ? topicsMatch[1].split(',').map((t) => t.trim().replace(/"/g, ''))
            : [],
          description: descriptionMatch ? descriptionMatch[1].replace(/"/g, '') : '',
          content: content,
        });
      }
    }
  }
}

TARGET_DIRS.forEach((dir) => {
  collectFiles(dir);
});

// 2. Define relationship rules
function getRelated(file, files) {
  const related = [];
  for (const other of files) {
    if (file.relPath === other.relPath) continue;

    let score = 0;
    let why = '';

    // Common topics (High weight)
    const commonTopics = file.topics.filter((t) => other.topics.includes(t));
    if (commonTopics.length >= 2) {
      score += 50;
      why = `Shares core concepts: ${commonTopics.slice(0, 2).join(', ')}`;
    } else if (commonTopics.length === 1) {
      score += 20;
      why = `Related to ${commonTopics[0]}`;
    }

    // Cross-references in content (Medium weight)
    if (
      file.content.includes(other.relPath.replace('.md', '')) ||
      file.content.includes(other.title) ||
      (other.topics.length > 0 && file.content.includes(other.topics[0]))
    ) {
      score += 15;
      if (!why) why = `Complementary content regarding ${other.title}`;
    }

    // Directory Sibling (Low weight)
    if (file.dir === other.dir) {
      score += 5;
      if (!why) why = `Sibling documentation in the ${file.dir} section`;
    }

    if (score > 0) {
      related.push({ path: other.relPath, why, score });
    }
  }

  return related
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ path, why }) => ({ path, why }));
}

// 3. Update files
let updatedCount = 0;
let linksCreated = 0;

allFiles.forEach((file) => {
  const related = getRelated(file, allFiles);
  if (related.length > 0) {
    let newContent = file.content;
    const relatedYaml = `related:\n${related.map((r) => `  - path: "${r.path}"\n    why: "${r.why}"`).join('\n')}`;

    // Clean existing related section if it exists
    // This is a bit safer regex for frontmatter replacement
    newContent = newContent.replace(/^related:[\s\S]*?(?=\n\w+:|\n---)/m, '');

    // Insert new related section at the top of frontmatter
    newContent = newContent.replace(/---\n/, `---\n${relatedYaml}\n`);

    fs.writeFileSync(file.fullPath, newContent);
    updatedCount++;
    linksCreated += related.length;
  }
});

// 4. Generate _index.md
const dirGroups = {};
allFiles.forEach((f) => {
  if (!dirGroups[f.dir]) dirGroups[f.dir] = [];
  dirGroups[f.dir].push(f);
});

let indicesGenerated = 0;
for (const [dir, files] of Object.entries(dirGroups)) {
  if (files.length >= 3) {
    const indexPath = path.join(BASE_DIR, dir, '_index.md');
    const titleRaw = dir.split('/').pop();
    const title = titleRaw.charAt(0).toUpperCase() + titleRaw.slice(1);
    const framework = 'bun';
    const description = `Overview of Bun ${title} documentation and resources.`;

    let content = `---
title: "${title}"
type: folder-index
framework: "${framework}"
file_count: ${files.length}
description: "${description}"
---

# ${title}

${description}

## Files

| File | Description | Topics |
|------|-------------|--------|
`;

    files.forEach((f) => {
      content += `| \`${path.basename(f.relPath)}\` | ${f.description} | ${f.topics.join(', ')} |\n`;
    });

    content += `\n## Concept Map\n\nRelações entre os conceitos deste folder:\n\n`;

    const topicMap = {};
    files.forEach((f) => {
      f.topics.forEach((t) => {
        if (!topicMap[t]) topicMap[t] = [];
        topicMap[t].push(path.basename(f.relPath));
      });
    });

    Object.entries(topicMap)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 5)
      .forEach(([topic, refs]) => {
        content += `- **${topic}** → Covered in: ${refs.map((r) => `\`${r}\``).join(', ')}\n`;
      });

    fs.writeFileSync(indexPath, content);
    indicesGenerated++;
  }
}

console.log(`🔗 Linkagem concluída`);
console.log(`   Arquivos atualizados: ${updatedCount}`);
console.log(`   Links criados: ${linksCreated}`);
console.log(`   Índices gerados: ${indicesGenerated} subdiretórios`);
