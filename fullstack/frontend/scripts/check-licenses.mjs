#!/usr/bin/env node
/**
 * License Coverage Checker
 * Validates that all production dependencies in frontend package.json
 * and backend requirements.txt are registered in src/data/licenses.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const frontendDir = path.resolve(__dirname, '..');
const rootDir = path.resolve(frontendDir, '..', '..');
const backendDir = path.resolve(rootDir, 'fullstack', 'backend');

const packageJsonPath = path.resolve(frontendDir, 'package.json');
const licensesJsonPath = path.resolve(frontendDir, 'src', 'data', 'licenses.json');
const requirementsPath = path.resolve(backendDir, 'requirements.txt');

console.log('[license-check] Verifying OSS license coverage...');

// 1. Read licenses.json
if (!fs.existsSync(licensesJsonPath)) {
  console.error(`[ERROR] licenses.json not found at ${licensesJsonPath}`);
  process.exit(1);
}

const licensesData = JSON.parse(fs.readFileSync(licensesJsonPath, 'utf8'));
if (!licensesData.packages || !Array.isArray(licensesData.packages)) {
  console.error('[ERROR] licenses.json must contain a "packages" array');
  process.exit(1);
}

const registeredNames = new Set(
  licensesData.packages.map((pkg) => pkg.name.toLowerCase())
);

// Validate that each registered package has required fields
for (const pkg of licensesData.packages) {
  if (!pkg.name || !pkg.license || !pkg.text || !pkg.copyright) {
    console.error(`[ERROR] Package "${pkg.name}" is missing required fields (name, license, text, copyright)`);
    process.exit(1);
  }
}

let hasError = false;

// 2. Check frontend dependencies
if (fs.existsSync(packageJsonPath)) {
  const pkgJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const deps = Object.keys(pkgJson.dependencies || {});
  console.log(`[license-check] Checking ${deps.length} frontend dependencies...`);
  for (const dep of deps) {
    if (!registeredNames.has(dep.toLowerCase())) {
      console.error(`[ERROR] Frontend dependency "${dep}" is missing from licenses.json!`);
      hasError = true;
    }
  }
} else {
  console.warn(`[WARN] package.json not found at ${packageJsonPath}`);
}

// 3. Check backend requirements.txt
if (fs.existsSync(requirementsPath)) {
  const reqContent = fs.readFileSync(requirementsPath, 'utf8');
  const lines = reqContent.split(/\r?\n/);
  const backendPkgs = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Extract package name before ==, >=, <=, etc.
    const match = trimmed.match(/^([a-zA-Z0-9_\-]+)/);
    if (match) {
      const name = match[1];
      // Test-only / build-only packages like pytest, playwright can be optional or ignored if dev-only
      if (['pytest', 'playwright'].includes(name.toLowerCase())) {
        continue;
      }
      backendPkgs.push(name);
    }
  }

  console.log(`[license-check] Checking ${backendPkgs.length} backend production dependencies...`);
  for (const pkg of backendPkgs) {
    if (!registeredNames.has(pkg.toLowerCase())) {
      console.error(`[ERROR] Backend dependency "${pkg}" is missing from licenses.json!`);
      hasError = true;
    }
  }
}

if (hasError) {
  console.error('\n[FAILED] OSS License check failed. Please register missing packages in src/data/licenses.json before building.\n');
  process.exit(1);
}

console.log(`[SUCCESS] All dependencies are fully covered in licenses.json (${licensesData.packages.length} packages total).\n`);
