'use strict';

const fs = require('fs');
const path = require('path');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMaxRevision(parentOutputDir, SKU) {
  const pattern = new RegExp(`^${escapeRegExp(SKU)}-.*-R(\\d+)$`);
  let maximum = 0;
  for (const entry of fs.readdirSync(parentOutputDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(pattern);
    if (!match) continue;
    const revision = Number(match[1]);
    if (Number.isSafeInteger(revision) && revision > maximum) maximum = revision;
  }
  return maximum;
}

function reserveVersionedOutputDir({ parentOutputDir, SKU, safeProductName }) {
  if (!parentOutputDir) throw new Error('parentOutputDir is empty.');
  if (!/^\d{7}$/.test(String(SKU || ''))) throw new Error('SKU must be exactly 7 digits.');
  if (!safeProductName) throw new Error('safeProductName is empty.');

  fs.mkdirSync(parentOutputDir, { recursive: true });
  let revision = findMaxRevision(parentOutputDir, SKU) + 1;

  for (let attempt = 0; attempt < 100000; attempt += 1, revision += 1) {
    const folderName = `${SKU}-${safeProductName}-R${revision}`;
    const outputDir = path.join(parentOutputDir, folderName);
    try {
      fs.mkdirSync(outputDir, { recursive: false });
      return { outputDir, folderName, revision };
    } catch (error) {
      if (error && error.code === 'EEXIST') continue;
      throw error;
    }
  }

  throw new Error(`Unable to reserve a revision directory for SKU ${SKU}.`);
}

function reserveExecutionOutputDir({ parentOutputDir, SKU, safeProductName, n8nExecutionId }) {
  if (!parentOutputDir) throw new Error('parentOutputDir is empty.');
  if (!/^\d{7}$/.test(String(SKU || ''))) throw new Error('SKU must be exactly 7 digits.');
  if (!safeProductName) throw new Error('safeProductName is empty.');

  const executionId = String(n8nExecutionId || '').trim();
  if (!/^\d+$/.test(executionId)) throw new Error('n8nExecutionId must contain digits only.');

  fs.mkdirSync(parentOutputDir, { recursive: true });
  const folderName = `${SKU}-${safeProductName}-${executionId}`;
  const outputDir = path.join(parentOutputDir, folderName);
  try {
    fs.mkdirSync(outputDir, { recursive: false });
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      const existsError = new Error(`Output directory already exists for n8n execution ${executionId}: ${outputDir}`);
      existsError.code = 'OUTPUT_DIR_EXISTS';
      throw existsError;
    }
    throw error;
  }
  return { outputDir, folderName, revision: 1, n8nExecutionId: executionId };
}

module.exports = { findMaxRevision, reserveExecutionOutputDir, reserveVersionedOutputDir };
