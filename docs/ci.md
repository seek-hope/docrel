# CI/CD Integration

DocRelay is designed to gate documentation drift in CI: scan, then fail the
pipeline when docs go stale. This page covers GitHub Actions, GitLab CI, and
status badges.

**Prerequisite for all setups:** commit `.docrelay/config.yaml` (created by
`doc-relay init`). The database itself lives in `.git/docrelay.db`, which CI
always clones fresh, so every job starts with a clean scan.

## GitHub Actions

```yaml
name: DocRelay
on: [push, pull_request]

jobs:
  doc-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install --global doc-relay
      - run: doc-relay scan
      - run: doc-relay check --strict
```

Useful extras:

- `doc-relay check --strict --format ci` emits `::warning`/`::error`
  annotations that GitHub renders inline on the PR files view.
- `doc-relay impact --format ci $(git diff --name-only origin/main...HEAD)`
  scopes the report to docs affected by the PR's changed files.
- `doc-relay review --format markdown >> $GITHUB_STEP_SUMMARY` adds a mapping
  audit to the job summary page.

## GitLab CI

A ready-to-copy template lives at
[`docs/templates/gitlab-ci.yml`](templates/gitlab-ci.yml):

```yaml
docrelay:check:
  stage: test
  image: node:22
  script:
    - npm install --global doc-relay
    - doc-relay scan
    - doc-relay check --strict
```

## Status badges

`doc-relay check --format shields` prints a [shields.io endpoint](https://shields.io/endpoint)
payload — compact JSON describing documentation health:

```json
{"schemaVersion":1,"label":"docs","message":"in sync","color":"brightgreen"}
```

When docs are stale the payload becomes `{"...","message":"3 stale","color":"red"}`.

Publish the JSON from your default-branch pipeline, then point shields.io at
the hosted URL:

**GitHub Pages**

```yaml
- run: npm install --global doc-relay && doc-relay scan
- run: mkdir -p public && doc-relay check --format shields > public/docs-badge.json
- uses: peaceiris/actions-gh-pages@v4
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    publish_dir: ./public
```

**GitLab Pages** — see the `docrelay:badge` job in the
[template](templates/gitlab-ci.yml).

Then embed the badge:

```markdown
![docs](https://img.shields.io/endpoint?url=https://<you>.github.io/<repo>/docs-badge.json)
```
