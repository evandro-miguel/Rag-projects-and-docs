# OpenCode Batch Refine — Prompt para Agentes

> **Como usar:** Cole este prompt no OpenCode. Substitua os `{{PLACEHOLDERS}}` pelos paths reais.
> **Modelos recomendados:** Qwen 3.5 (coding), GLM 4.7 (ZAI)
> **Lote ideal:** 5–10 files por execução

---

## Sua Tarefa

Você é um processador de documentação técnica para um sistema RAG. Sua missão é transformar arquivos de documentação bruta em Markdown limpo e otimizado para busca semântica por agentes de IA.

## Arquivos para Processar

**Diretório fonte:** `{{SOURCE_DIR}}`
**Diretório destino:** `{{DEST_DIR}}`

Processe ESTES arquivos (leia cada um, refine, e salve no destino mantendo a mesma estrutura de pastas):

```
{{FILE_1}}
{{FILE_2}}
{{FILE_3}}
{{FILE_4}}
{{FILE_5}}
```

## Regras de Processamento

### YAML Frontmatter (OBRIGATÓRIO no topo de cada arquivo)

Gere este bloco no topo de CADA arquivo processado:

```yaml
---
title: "[Título descritivo do conteúdo — NÃO o nome do arquivo]"
description: "[1-2 frases explicando o que este arquivo cobre, focado no conteúdo técnico principal]"
source: "[path relativo do arquivo original, ex: nextjs-docs/docs/01-app/01-getting-started/07-server-and-client-components.mdx]"
framework: "[nextjs | typescript | react | tailwind | bun]"
topics: [lista, de, tópicos, relevantes, em, kebab-case]
complexity: "[beginner | intermediate | advanced]"
---
```

### Regras de Conteúdo

**REMOVER:**
- Menus de navegação, sidebars, breadcrumbs, table of contents gerados
- Cookie notices, "was this helpful?", botões de feedback/share
- Marketing ("Get started today!", "Join thousands...")
- Headers/footers repetidos entre páginas
- "Edit this page on GitHub"
- Licenças > 3 linhas

**PRESERVAR (perda de qualquer um destes é falha):**
- TODOS os code blocks — completos, sem alteração, com syntax highlighting
- Assinaturas de API — nomes de função, parâmetros, tipos de retorno
- Definições de tipos — interfaces, types, enums, schemas
- Tabelas — parâmetros, comparações, feature matrices
- Opções de configuração — todas as keys, env vars, defaults
- Warnings, Notes, Important, Deprecated
- Error codes e mensagens

### Estrutura do Output

1. **Heading hierarchy estrita:**
   - `#` — título do documento (1 por arquivo)
   - `##` — seções principais
   - `###` — sub-seções
   - NUNCA pule níveis (# → ###)

2. **Cada seção `##` deve ser auto-suficiente:**
   A primeira frase DEVE nomear o assunto explicitamente.

   ✅ BOM: `## Server Components\n\nServer Components in Next.js render exclusively on the server...`

   ❌ RUIM: `## Server Components\n\nThey render on the server...` ("They" perde contexto quando isolado)

3. **Parágrafos curtos:** Máximo 3-4 frases. Um parágrafo = uma ideia.

4. **Links:** Manter texto descritivo. Converter `[Learn more](/path)` → `[Learn more about Server Components](path)`.

### Anti-Hallucination (INVIOLÁVEL)

- NUNCA invente informação que não está no arquivo fonte
- NUNCA crie exemplos de código que não existem no original
- NUNCA especule sobre comportamentos não documentados
- Se algo é ambíguo, mantenha o texto original

## Formato de Execução

Para CADA arquivo:
1. Leia o conteúdo bruto do source
2. Aplique as regras acima
3. Salve o resultado no destino (mesmo nome de arquivo, mesma estrutura de pasta)
4. Reporte: `✅ Processado: {{filename}} ({{linhas_antes}} → {{linhas_depois}} linhas)`

Ao final, reporte um resumo:
```
📊 Lote concluído
   Processados: X/Y arquivos
   Redução média: Z%
```

---

## Exemplo de Uso no OpenCode

```
Processe estes 5 arquivos usando as instruções em ingest/prompts/opencode-batch-refine.md:

SOURCE_DIR: /path/to/rag-v2/ingest/source/external/nextjs-docs/docs/01-app/01-getting-started/
DEST_DIR: /path/to/rag-v2/ingest/processed/external/nextjs-docs/01-app/01-getting-started/

Files:
1. 01-installation.mdx
2. 02-layouts-and-pages.mdx
3. 03-images.mdx
4. 04-fonts.mdx
5. 05-css.mdx
```
