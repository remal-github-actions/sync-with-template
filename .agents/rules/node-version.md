# Node.js Version

- The Node.js major version has a single source of truth: `runs.using` in `action.yml` (e.g. `node24`). To upgrade Node.js, change it there.
- Derived files: `.nvmrc`, `.tool-versions`, `package.json`, `tsconfig.json`, `.github/renovate.json5`. Never edit the Node.js version in them by hand; run `node update-node-version-in-files <major>` to propagate.
- CI (`.github/workflows/build.yml`) reads the major version from `action.yml`, runs `update-node-version-in-files`, and commits resulting changes via the `[push-back]` step.
- Renovate bumps minor/patch versions of `nodejs` in `.tool-versions` and of `@types/node`. Major Node.js updates are disabled in `.github/renovate.json5`.
- `yarn install` runs `check-dependency-engines.js` (`afterInstall` hook in `.yarnrc.yml`). It fails the install if `engines.node` of any installed dependency does not accept the version from `.nvmrc`.
- `update-node-version-in-files.js` and `check-dependency-engines.js` are propagated from the [template-typescript](https://github.com/remal-github-actions/template-typescript) project. Edit them only there.
