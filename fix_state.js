const fs = require('fs');
const content = fs.readFileSync('main_scripts/extension-impl.js', 'utf8');

// We want to replace all context.globalState with context.workspaceState
// EXCEPT for EXTENSION_VERSION_KEY and CDP_SETUP_COMPLETED_KEY

let newContent = content.replace(/globalState/g, 'workspaceState');

// Revert the ones that should stay global
newContent = newContent.replace(/context\.workspaceState(\.get|\.update)\(\s*(?:EXTENSION_VERSION_KEY|CDP_SETUP_COMPLETED_KEY)/g, 
    (match, method) => `context.globalState${method}(${match.includes('EXTENSION') ? 'EXTENSION_VERSION_KEY' : 'CDP_SETUP_COMPLETED_KEY'}`);

newContent = newContent.replace(/globalContext\.workspaceState/g, 'globalContext.globalState');

// Remove singleton lock
// We replace the block that checks for active instance
const lockStart = newContent.indexOf('// Check for instance locking');
const lockEnd = newContent.indexOf('// We are the leader or lock is dead');
if (lockStart > -1 && lockEnd > -1) {
    newContent = newContent.substring(0, lockStart) + newContent.substring(lockEnd);
}

// And remove the lock acquiring lines
newContent = newContent.replace(/globalContext\.globalState\.update\(lockKey, myId\);\s+globalContext\.globalState\.update\(`\$\{lockKey\}-ping`, Date\.now\(\)\);/g, '');

newContent = newContent.replace(/if \(isLockedOut\) \{[\s\S]*?updateStatusBar\(\);\s+\}/, '');

fs.writeFileSync('main_scripts/extension-impl.js', newContent);
console.log('Successfully updated extension-impl.js');
