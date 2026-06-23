#!/bin/bash
# scripts/install-hooks.sh
set -e

PROJECT_ROOT="${1:-$(pwd)}"

cat > "$PROJECT_ROOT/.git/hooks/pre-commit" << 'EOF'
#!/bin/sh
docrel check --strict
if [ $? -ne 0 ]; then
  echo ""
  echo "⛔ DocRel: Documentation is stale. Run 'docrel sync' or use --no-verify to skip."
  exit 1
fi
EOF

cat > "$PROJECT_ROOT/.git/hooks/post-commit" << 'EOF'
#!/bin/sh
git diff --name-only HEAD~1..HEAD 2>/dev/null | xargs -r docrel impact --
EOF

cat > "$PROJECT_ROOT/.git/hooks/pre-push" << 'EOF'
#!/bin/sh
docrel check --strict
if [ $? -ne 0 ]; then
  echo ""
  echo "⛔ DocRel: Cannot push with stale documentation."
  exit 1
fi
EOF

chmod +x "$PROJECT_ROOT/.git/hooks/pre-commit"
chmod +x "$PROJECT_ROOT/.git/hooks/post-commit"
chmod +x "$PROJECT_ROOT/.git/hooks/pre-push"

echo "✅ DocRel hooks installed"
