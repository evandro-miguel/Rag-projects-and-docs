#!/usr/bin/env bun

import './lib/runtime-env.js';
import { readDocsRagFreshness } from './lib/docs-rag-freshness.js';

const flags = new Set(process.argv.slice(2));
const freshness = readDocsRagFreshness();

if (flags.has('--text')) {
  if (freshness.status === 'ok') {
    const age = freshness.ageHours === undefined ? 'unknown' : `${freshness.ageHours.toFixed(1)}h`;
    console.log(`Docs RAG freshness OK (${age} old)`);
  } else {
    console.log(freshness.warning);
  }
} else {
  console.log(JSON.stringify(freshness, null, 2));
}

process.exit(flags.has('--strict') && freshness.status !== 'ok' ? 10 : 0);
