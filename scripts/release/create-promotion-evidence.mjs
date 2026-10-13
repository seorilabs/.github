#!/usr/bin/env node
import { createPromotionEvidence } from './release-promotion-evidence.mjs';
try {
  const result = createPromotionEvidence({ directory: process.env.PROMOTION_EVIDENCE_DIRECTORY, outputFile: process.env.PROMOTION_EVIDENCE_ZIP });
  console.log(result.logLine);
} catch (error) { console.error(error.message); process.exitCode = 1; }
