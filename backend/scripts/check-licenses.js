const { execSync } = require('child_process');
const path = require('path');

try {
  // Only allow these licenses (edit this list)
  const allowed = [
    'MIT',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'ISC',
    '0BSD',
    'CC0-1.0',
    'Unlicense'
  ].join(';');

  console.log('\n🔍 Checking licenses of all packages...\n');

  execSync(
    `npx license-checker --production --onlyAllow "${allowed}" --excludePrivatePackages`,
    { stdio: 'inherit' }
  );

  console.log('\n✅ All packages have allowed open-source licenses.\n');
} catch (err) {
  console.error('\n❌ BLOCKED: Some packages have licenses that are NOT allowed!');
  console.error('Please verify the package license before using it.\n');
  process.exit(1); // This stops the install
}