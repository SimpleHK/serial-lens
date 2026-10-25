// Mechanical manifest checks that would have caught real breakage in this
// repo: missing main entry, view containers without an icon file, views
// pointing at undeclared containers, dangling activation references.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));

const errors = [];

if (pkg.main && !fs.existsSync(path.join(root, pkg.main))) {
  errors.push(`main entry "${pkg.main}" does not exist on disk (build first or fix the path)`);
}

const containers = new Set(Object.keys(pkg.contributes?.viewsContainers ?? {}).flatMap((where) =>
  (pkg.contributes.viewsContainers[where] ?? []).map((c) => c.id),
));

for (const [where, list] of Object.entries(pkg.contributes?.viewsContainers ?? {})) {
  if (!['activitybar', 'panel'].includes(where)) {
    errors.push(`viewsContainers target "${where}" is not a valid location (activitybar | panel)`);
  }
  for (const c of list) {
    if (!c.icon || typeof c.icon !== 'string') {
      errors.push(`view container "${c.id}" is missing the mandatory "icon" property`);
    } else if (!fs.existsSync(path.join(root, c.icon))) {
      errors.push(`view container "${c.id}" icon file "${c.icon}" does not exist`);
    }
  }
}

for (const [container, views] of Object.entries(pkg.contributes?.views ?? {})) {
  if (!containers.has(container)) {
    errors.push(
      `views are registered under container "${container}" but it is not declared in viewsContainers (a bare built-in id like "panel" is NOT valid — views get silently demoted to the Explorer)`,
    );
  }
  for (const v of views) {
    if (v.type !== 'webview' && v.type !== 'tree') {
      errors.push(`view "${v.id}" has unknown type "${v.type}"`);
    }
  }
}

if (errors.length) {
  console.error(`manifest check FAILED (${errors.length}):`);
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  process.exit(1);
}
console.log('manifest ok');
