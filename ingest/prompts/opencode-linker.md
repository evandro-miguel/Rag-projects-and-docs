# OpenCode Linker Pass — Prompt para Agentes

> **Quando usar:** DEPOIS de processar todos os arquivos de um diretório/fonte com o batch-refine.
> **Modelos recomendados:** Qwen 3.5 (coding), GLM 4.7 (ZAI) — precisa de contexto longo
> **Input:** Diretório com arquivos já processados (com YAML frontmatter)

---

## Sua Tarefa

Você é um agente de linkagem para um sistema RAG de documentação. Sua missão tem 2 partes:

1. **Adicionar `related:` links** no frontmatter de cada arquivo processado
2. **Gerar `_index.md`** para cada subdiretório

Você NÃO altera o conteúdo do documento — apenas o frontmatter YAML e os arquivos de índice.

## Diretório para Processar

```
{{PROCESSED_DIR}}
```

Exemplo: `/path/to/rag-v2/ingest/processed/external/nextjs-docs/`

## Parte 1: Adicionar `related:` ao Frontmatter

Para CADA arquivo `.md` / `.mdx` no diretório:

1. Leia o frontmatter existente (title, description, topics)
2. Leia os frontmatters de TODOS os outros arquivos no mesmo fonte
3. Identifique relações baseadas em:
   - **Topics em comum** — arquivos que compartilham 2+ topics
   - **Referências cruzadas** — se o conteúdo menciona conceitos de outro arquivo
   - **Hierarquia** — parent/child (ex: `server-components` ↔ `data-fetching`)
4. Adicione o campo `related:` ao frontmatter

### Formato do `related:`

```yaml
related:
  - path: "01-getting-started/08-fetching-data.mdx"
    why: "Data fetching patterns used inside Server Components"
  - path: "01-getting-started/06-layouts-and-pages.mdx"
    why: "Layout system where Server Components are the default"
  - path: "02-guides/caching.mdx"
    why: "Caching strategies that affect Server Component rendering"
```

### Regras de Linkagem

- **Máximo 5 links** por arquivo (os mais relevantes)
- **Mínimo 1 link** (todo arquivo tem pelo menos 1 conceito relacionado)
- O campo `why` é **obrigatório** — 1 frase explicando a conexão
- Paths são **relativos à raiz do fonte** (não absolutos)
- NUNCA linke um arquivo para si mesmo
- Priorize links que um agente seguiria para resolver uma dúvida real

## Parte 2: Gerar `_index.md` por Subdiretório

Para CADA subdiretório que contém arquivos processados, crie um `_index.md`:

```markdown
---
title: "[Nome descritivo do folder]"
type: folder-index
framework: "[framework]"
file_count: [número]
description: "[O que este grupo de docs cobre como um todo]"
---

# [Título do Folder]

[1-2 frases descrevendo o escopo geral deste grupo de documentos]

## Files

| File | Description | Topics |
|------|-------------|--------|
| `installation.mdx` | Project setup with create-next-app, prerequisites | setup, npm, config |
| `server-and-client-components.mdx` | How Server and Client Components work in App Router | RSC, hydration, "use client" |

## Concept Map

Relações entre os conceitos deste folder:

- **Server Components** → renderizam no servidor; buscam dados via async/await
  - Usados em: `layouts-and-pages.mdx`, `fetching-data.mdx`
- **Client Components** → marcados com `"use client"`; usam hooks e browser APIs
  - Usados em: `server-and-client-components.mdx`, `forms-and-mutations.mdx`
- **Layouts** → compartilham UI entre páginas; são Server Components por padrão
  - Definidos em: `layouts-and-pages.mdx`; afetam `linking-and-navigating.mdx`
```

### Regras do _index.md

- Gere 1 `_index.md` por subdiretório que tenha **3+ arquivos**
- O Concept Map deve mostrar relações REAIS baseadas no conteúdo — não inventar
- A tabela de Files deve ter TODOS os arquivos do folder
- O `description` do frontmatter é usado para busca — deve ser claro o escopo

## Formato de Execução

1. Primeiro, leia todos os frontmatters do diretório para construir o mapa mental
2. Depois, para cada arquivo, adicione `related:`
3. Depois, para cada subdiretório, gere `_index.md`
4. Reporte:

```
🔗 Linkagem concluída
   Arquivos atualizados: X
   Links criados: Y
   Índices gerados: Z subdiretórios
```

## Anti-Hallucination

- Links `related:` devem ser baseados APENAS em topics e conteúdo real dos arquivos
- O Concept Map deve refletir APENAS o que está documentado
- Se dois arquivos não têm relação clara, NÃO force um link

---

## Exemplo de Uso no OpenCode

```
Execute a linkagem usando as instruções em ingest/prompts/opencode-linker.md:

PROCESSED_DIR: /path/to/rag-v2/ingest/processed/external/nextjs-docs/01-app/01-getting-started/

Leia todos os arquivos processados neste diretório, adicione related: links no frontmatter de cada um, e gere _index.md.
```
