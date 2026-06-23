#!/bin/bash
# scripts/install-hooks.sh
set -e

PROJECT_ROOT="$(realpath "${1:-$(pwd)}")"

# Validate that PROJECT_ROOT is a real git repository before writing hooks
if [ ! -d "$PROJECT_ROOT/.git" ]; then
  echo "Error: $PROJECT_ROOT is not a git repository (no .git directory found)" >&2
  exit 1
fi

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

cat > "$PROJECT_ROOT/.git/hooks/prepare-commit-msg" << 'EOF'
#!/bin/sh
# DocRel prepare-commit-msg hook
docrel annotate-commit "$1"
EOF

chmod +x "$PROJECT_ROOT/.git/hooks/pre-commit"
chmod +x "$PROJECT_ROOT/.git/hooks/post-commit"
chmod +x "$PROJECT_ROOT/.git/hooks/pre-push"
chmod +x "$PROJECT_ROOT/.git/hooks/prepare-commit-msg"

echo "✅ DocRel hooks installed"
