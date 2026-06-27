#!/bin/bash
# Manual PII check — run before push if you bypassed the pre-commit hook
PATTERNS="marcus|/home/marcus|/Users/marcus|5C:02:72:09:B0:7F|sparky"
if grep -rni "$PATTERNS" \
    --include="*.py" --include="*.ts" --include="*.tsx" --include="*.sh" --include="*.md" \
    --include="*.json" --include="*.html" --include="*.css" \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.venv .; then
    echo ""
    echo "WARNING: Potential PII found in working tree."
    exit 1
fi
echo "OK: No PII detected."
