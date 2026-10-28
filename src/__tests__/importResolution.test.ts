import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { indexProject } from "../core/indexer";
import { registerProject } from "../core/registry";
import {
  buildReverseImportMap,
  dependencyTargets,
  resolveDependency,
  type PathAliases,
} from "../core/importResolver";
import { loadTsPathAliases, stripJsonComments } from "../core/tsconfigAliases";
import { parseTomlSubset } from "../core/pythonRoots";
import type { IndexedDependency } from "../core/types";

const files = (...paths: string[]) => {
  const set = new Set(paths);
  return (p: string) => set.has(p);
};

describe("Python `from . import a, b`", () => {
  const has = files(
    "pkg/__init__.py",
    "pkg/a.py",
    "pkg/b.py",
    "pkg/sub/__init__.py",
    "pkg/main.py"
  );

  it("resolves every sibling module instead of only __init__.py", () => {
    const r = resolveDependency(
      { targetSpecifier: ".", importedSymbols: ["a", "b"] },
      "pkg/main.py",
      has
    );
    expect(r.resolution).toBe("resolved");
    expect(r.resolvedPath).toBe("pkg/a.py");
    expect(r.resolvedPaths).toEqual(["pkg/a.py", "pkg/b.py"]);
  });

  it("includes the package __init__ when a name is not a module (defined there)", () => {
    const r = resolveDependency(
      { targetSpecifier: ".", importedSymbols: ["a", "helper"] },
      "pkg/main.py",
      has
    );
    expect(r.resolvedPaths).toEqual(["pkg/__init__.py", "pkg/a.py"]);
  });

  it("keeps resolving a bare package import and a single module to one target", () => {
    expect(
      resolveDependency({ targetSpecifier: ".", importedSymbols: [] }, "pkg/main.py", has)
    ).toEqual({ resolvedPath: "pkg/__init__.py", resolution: "resolved" });
    expect(
      resolveDependency({ targetSpecifier: ".a", importedSymbols: ["x"] }, "pkg/main.py", has)
    ).toEqual({ resolvedPath: "pkg/a.py", resolution: "resolved" });
  });

  it("resolves modules imported from a subpackage and names that are sub-packages", () => {
    const hasSub = files("pkg/sub/__init__.py", "pkg/sub/x.py", "pkg/main.py");
    const r = resolveDependency(
      { targetSpecifier: ".sub", importedSymbols: ["x"] },
      "pkg/main.py",
      hasSub
    );
    expect(r.resolvedPath).toBe("pkg/sub/x.py");
    const pkgAsName = resolveDependency(
      { targetSpecifier: ".", importedSymbols: ["sub"] },
      "pkg/main.py",
      has
    );
    expect(pkgAsName.resolvedPath).toBe("pkg/sub/__init__.py");
  });

  it("stays unresolved, never guessed, when nothing matches", () => {
    expect(
      resolveDependency({ targetSpecifier: ".missing", importedSymbols: [] }, "pkg/main.py", has)
        .resolution
    ).toBe("unresolved");
  });

  it("feeds every target into the reverse import map and dependencyTargets", () => {
    const dep: IndexedDependency = {
      sourceFile: "pkg/main.py",
      targetSpecifier: ".",
      isExternal: false,
      importedSymbols: ["a", "b"],
      resolvedPath: "pkg/a.py",
      resolvedPaths: ["pkg/a.py", "pkg/b.py"],
      resolution: "resolved",
    };
    const index = {
      files: {
        "pkg/main.py": { dependencies: [dep] },
        "pkg/a.py": { dependencies: [] },
        "pkg/b.py": { dependencies: [] },
      },
    } as unknown as Parameters<typeof buildReverseImportMap>[0];
    const reverse = buildReverseImportMap(index);
    expect(reverse.get("pkg/a.py")).toEqual(["pkg/main.py"]);
    expect(reverse.get("pkg/b.py")).toEqual(["pkg/main.py"]);
    expect(dependencyTargets(dep, "pkg/main.py", files("pkg/a.py", "pkg/b.py"))).toEqual([
      "pkg/a.py",
      "pkg/b.py",
    ]);
  });
});

describe("tsconfig path aliases", () => {
  const aliases: PathAliases = {
    baseUrl: "src",
    paths: [
      { pattern: "@/*", targets: ["src/*"] },
      { pattern: "@lib/*", targets: ["src/lib/*", "vendor/lib/*"] },
      { pattern: "config", targets: ["src/config/index.ts"] },
    ],
  };
  const has = files(
    "src/utils/format.ts",
    "src/lib/date.ts",
    "vendor/lib/only-vendor.ts",
    "src/config/index.ts",
    "src/shared/thing.ts",
    "src/app.ts"
  );
  const resolve = (specifier: string) =>
    resolveDependency({ targetSpecifier: specifier }, "src/app.ts", has, aliases);

  it("resolves wildcard, fallback-target, exact and baseUrl specifiers", () => {
    expect(resolve("@/utils/format")).toMatchObject({
      resolvedPath: "src/utils/format.ts",
      resolution: "resolved",
    });
    expect(resolve("@lib/date").resolvedPath).toBe("src/lib/date.ts");
    expect(resolve("@lib/only-vendor").resolvedPath).toBe("vendor/lib/only-vendor.ts");
    expect(resolve("config").resolvedPath).toBe("src/config/index.ts");
    expect(resolve("shared/thing").resolvedPath).toBe("src/shared/thing.ts");
  });

  it("reports a matched alias with no indexed target as unresolved, not as a package", () => {
    expect(resolve("@/missing").resolution).toBe("unresolved");
  });

  it("leaves real packages and non-TS importers alone", () => {
    expect(resolve("react").resolution).toBe("non-relative");
    expect(
      resolveDependency({ targetSpecifier: "@/utils/format" }, "src/x.py", has, aliases).resolution
    ).toBe("non-relative");
  });

  it("without configured aliases behaves as before", () => {
    expect(
      resolveDependency({ targetSpecifier: "@/utils/format" }, "src/app.ts", has).resolution
    ).toBe("non-relative");
  });
});

describe("tsconfig loading and indexing", () => {
  let home = "";
  let root = "";
  const prevHome = process.env.KAI_HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-alias-home-"));
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-alias-proj-"));
    process.env.KAI_HOME = home;
  });
  afterEach(() => {
    process.env.KAI_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (rel: string, content: string) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  it("strips comments and trailing commas without touching strings", () => {
    const parsed = JSON.parse(
      stripJsonComments('{\n // c\n "a": "http://x/*y*/", /* b */ "b": [1, 2,],\n}')
    );
    expect(parsed).toEqual({ a: "http://x/*y*/", b: [1, 2] });
  });

  it("reads paths relative to baseUrl, and follows a relative extends", () => {
    write(
      "tsconfig.base.json",
      '{ "compilerOptions": { "baseUrl": ".", "paths": { "@core/*": ["src/core/*"] } } }'
    );
    write("tsconfig.json", '{ "extends": "./tsconfig.base.json" /* shared */, }');
    expect(loadTsPathAliases(root)).toEqual({
      baseUrl: "",
      paths: [{ pattern: "@core/*", targets: ["src/core/*"] }],
    });
  });

  it("returns null for a missing, malformed or alias-free config", () => {
    expect(loadTsPathAliases(root)).toBeNull();
    write("tsconfig.json", "{ not json");
    expect(loadTsPathAliases(root)).toBeNull();
    write("tsconfig.json", '{ "compilerOptions": { "strict": true } }');
    expect(loadTsPathAliases(root)).toBeNull();
  });

  it("ignores targets and extends that escape the project root", () => {
    write(
      "tsconfig.json",
      '{ "extends": "../outside.json", "compilerOptions": { "paths": { "@x/*": ["../../etc/*"] } } }'
    );
    expect(loadTsPathAliases(root)).toBeNull();
  });

  it("indexes an aliased import as resolved and as a reverse edge", async () => {
    write(
      "tsconfig.json",
      '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }'
    );
    write("src/a.ts", "import { b } from '@/b';\nimport r from 'react';\nexport const a = b;\n");
    write("src/b.ts", "export const b = 1;\n");
    const index = await indexProject(registerProject(root));
    const [aliased, pkg] = index.files["src/a.ts"].dependencies;
    expect(aliased).toMatchObject({
      resolvedPath: "src/b.ts",
      resolution: "resolved",
      isExternal: false,
    });
    expect(pkg).toMatchObject({ resolution: "non-relative", isExternal: true });
    expect(buildReverseImportMap(index).get("src/b.ts")).toEqual(["src/a.ts"]);
  });

  it("indexes Python `from . import a, b` with an edge to each module", async () => {
    write("pkg/__init__.py", "");
    write("pkg/a.py", "def fa(): pass\n");
    write("pkg/b.py", "def fb(): pass\n");
    write("pkg/main.py", "from . import a, b\n");
    const index = await indexProject(registerProject(root));
    const dep = index.files["pkg/main.py"].dependencies[0];
    expect(dep.resolvedPaths).toEqual(["pkg/a.py", "pkg/b.py"]);
    const reverse = buildReverseImportMap(index);
    expect(reverse.get("pkg/a.py")).toEqual(["pkg/main.py"]);
    expect(reverse.get("pkg/b.py")).toEqual(["pkg/main.py"]);
  });

  it("uses the nearest tsconfig per file in a monorepo", async () => {
    write("tsconfig.json", '{ "compilerOptions": { "paths": { "@root/*": ["shared/*"] } } }');
    write(
      "packages/app/tsconfig.json",
      '{ "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/*"] } } }'
    );
    write("packages/lib/tsconfig.json", '{ "compilerOptions": { "strict": true } }');
    write("shared/util.ts", "export const util = 1;\n");
    write("packages/app/src/helper.ts", "export const helper = 1;\n");
    write(
      "packages/app/src/main.ts",
      "import { helper } from '@app/helper';\nimport { util } from '@root/util';\nexport const m = [helper, util];\n"
    );
    write("packages/lib/index.ts", "import { util } from '@root/util';\nexport const l = util;\n");
    write("top.ts", "import { util } from '@root/util';\nexport const t = util;\n");

    const index = await indexProject(registerProject(root));
    const [appAlias, rootAliasFromApp] = index.files["packages/app/src/main.ts"].dependencies;
    expect(appAlias).toMatchObject({
      resolvedPath: "packages/app/src/helper.ts",
      resolution: "resolved",
    });
    // The nearest config (packages/app) does not declare `@root`, and does not inherit the root one.
    expect(rootAliasFromApp.resolution).toBe("non-relative");
    // packages/lib has a tsconfig without aliases: nothing is inherited from the root.
    expect(index.files["packages/lib/index.ts"].dependencies[0].resolution).toBe("non-relative");
    // Files governed by the root config use its aliases.
    expect(index.files["top.ts"].dependencies[0]).toMatchObject({
      resolvedPath: "shared/util.ts",
      resolution: "resolved",
    });
  });

  it("follows a relative extends in a package config", async () => {
    write(
      "tsconfig.base.json",
      '{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["libs/*"] } } }'
    );
    write("apps/web/tsconfig.json", '{ "extends": "../../tsconfig.base.json" }');
    write("libs/x.ts", "export const x = 1;\n");
    write("apps/web/page.ts", "import { x } from '@lib/x';\nexport const p = x;\n");
    const index = await indexProject(registerProject(root));
    expect(index.files["apps/web/page.ts"].dependencies[0]).toMatchObject({
      resolvedPath: "libs/x.ts",
      resolution: "resolved",
    });
  });
});

describe("re-exports (barrels and Python __init__)", () => {
  let home = "";
  let root = "";
  const prevHome = process.env.KAI_HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-reexp-home-"));
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-reexp-proj-"));
    process.env.KAI_HOME = home;
  });
  afterEach(() => {
    process.env.KAI_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (rel: string, content: string) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  const targetsOf = (index: Awaited<ReturnType<typeof indexProject>>, rel: string, i = 0) =>
    dependencyTargets(index.files[rel].dependencies[i], rel, (p) =>
      Object.prototype.hasOwnProperty.call(index.files, p)
    );

  it("records the defining file behind a named barrel re-export", async () => {
    write("lib/a.ts", "export function alpha() {}\n");
    write("lib/b.ts", "export function beta() {}\n");
    write("lib/index.ts", "export { alpha } from './a';\nexport { beta as renamed } from './b';\n");
    write("app.ts", "import { alpha, renamed } from './lib';\nalpha(); renamed();\n");
    const index = await indexProject(registerProject(root));
    expect(index.files["lib/index.ts"].dependencies[0].reExportedNames).toEqual(["alpha"]);
    expect(index.files["lib/index.ts"].dependencies[1].reExportedNames).toEqual(["renamed"]);
    // Direct target first, then the files that define the imported names.
    expect(targetsOf(index, "app.ts")).toEqual(["lib/index.ts", "lib/a.ts", "lib/b.ts"]);
    const reverse = buildReverseImportMap(index);
    expect(reverse.get("lib/a.ts")).toEqual(["app.ts", "lib/index.ts"]);
  });

  it("only follows the names that are imported", async () => {
    write("lib/a.ts", "export function alpha() {}\n");
    write("lib/b.ts", "export function beta() {}\n");
    write("lib/index.ts", "export { alpha } from './a';\nexport { beta } from './b';\n");
    write("app.ts", "import { alpha } from './lib';\nalpha();\n");
    const index = await indexProject(registerProject(root));
    expect(targetsOf(index, "app.ts")).toEqual(["lib/index.ts", "lib/a.ts"]);
  });

  it("follows star exports only into files that export the imported name, and chains", async () => {
    write("lib/a.ts", "export function alpha() {}\n");
    write("lib/b.ts", "export function beta() {}\n");
    write("lib/inner/index.ts", "export * from '../a';\n");
    write("lib/index.ts", "export * from './inner';\nexport * from './b';\n");
    write("app.ts", "import { alpha } from './lib';\nalpha();\n");
    const index = await indexProject(registerProject(root));
    expect(targetsOf(index, "app.ts")).toEqual(["lib/index.ts", "lib/inner/index.ts", "lib/a.ts"]);
  });

  it("is cycle-safe and leaves side-effect imports alone", async () => {
    write("x/a.ts", "export * from './b';\nexport const a = 1;\n");
    write("x/b.ts", "export * from './a';\nexport const b = 1;\n");
    write("use.ts", "import { a } from './x/a';\nimport * as ns from './x/b';\nimport './x/b';\n");
    const index = await indexProject(registerProject(root));
    const [named, namespaced, sideEffect] = index.files["use.ts"].dependencies;
    expect(named.resolvedPath).toBe("x/a.ts");
    expect(namespaced.resolvedPaths).toEqual(["x/b.ts", "x/a.ts"]);
    expect(sideEffect.resolvedPaths).toBeUndefined();
  });

  it("follows a default import through `export { default } from` and `export { x as default }`", async () => {
    write("ui/button.ts", "export default function Button() {}\n");
    write("ui/card.ts", "export function Card() {}\n");
    write("ui/other.ts", "export default 1;\n");
    write(
      "ui/index.ts",
      "export { default } from './button';\nexport { Card as default2 } from './card';\n"
    );
    write("ui/alt.ts", "export { Card as default } from './card';\n");
    write("app.ts", "import Button from './ui';\nimport Card from './ui/alt';\n");
    const index = await indexProject(registerProject(root));
    expect(index.files["app.ts"].dependencies[0].importBindings).toEqual(["default"]);
    expect(targetsOf(index, "app.ts", 0)).toEqual(["ui/index.ts", "ui/button.ts"]);
    expect(targetsOf(index, "app.ts", 1)).toEqual(["ui/alt.ts", "ui/card.ts"]);
  });

  it("does not reach a default export through `export *`", async () => {
    write("ui/button.ts", "export default function Button() {}\nexport const size = 1;\n");
    write("ui/index.ts", "export * from './button';\n");
    write("app.ts", "import Button, { size } from './ui';\nimport Plain from './ui';\n");
    const index = await indexProject(registerProject(root));
    // Default + named: reaches the file only for the named `size`.
    expect(targetsOf(index, "app.ts", 0)).toEqual(["ui/index.ts", "ui/button.ts"]);
    // Default alone cannot pass through `export *`.
    expect(targetsOf(index, "app.ts", 1)).toEqual(["ui/index.ts"]);
  });

  it("follows a namespace import into everything the barrel re-exports", async () => {
    write("lib/a.ts", "export function alpha() {}\n");
    write("lib/b.ts", "export function beta() {}\n");
    write("lib/empty.ts", "const hidden = 1;\n");
    write(
      "lib/index.ts",
      "export { alpha } from './a';\nexport * from './b';\nexport * from './empty';\n"
    );
    write("app.ts", "import * as lib from './lib';\nlib.alpha();\n");
    const index = await indexProject(registerProject(root));
    expect(index.files["app.ts"].dependencies[0].importBindings).toEqual(["namespace"]);
    // A star export of a file with no exports adds nothing.
    expect(targetsOf(index, "app.ts")).toEqual(["lib/index.ts", "lib/a.ts", "lib/b.ts"]);
    expect(buildReverseImportMap(index).get("lib/b.ts")).toEqual(["app.ts", "lib/index.ts"]);
  });

  it("recomputes on every build instead of accumulating targets", async () => {
    write("lib/a.ts", "export function alpha() {}\n");
    write("lib/index.ts", "export { alpha } from './a';\n");
    write("app.ts", "import { alpha } from './lib';\n");
    const registered = registerProject(root);
    await indexProject(registered);
    const again = await indexProject(registered, { forceRebuild: true });
    expect(targetsOf(again, "app.ts")).toEqual(["lib/index.ts", "lib/a.ts"]);
  });

  it("follows a Python package __init__ re-export, including aliases", async () => {
    write("pkg/__init__.py", "from .models import User\nfrom .util import helper as h\n");
    write("pkg/models.py", "class User: ...\n");
    write("pkg/util.py", "def helper(): ...\n");
    write("app/main.py", "from ..pkg import User, h\n");
    const index = await indexProject(registerProject(root));
    expect(index.files["pkg/__init__.py"].dependencies[0].reExportedNames).toEqual(["User"]);
    expect(index.files["pkg/__init__.py"].dependencies[1].reExportedNames).toEqual(["h"]);
    expect(targetsOf(index, "app/main.py")).toEqual([
      "pkg/__init__.py",
      "pkg/models.py",
      "pkg/util.py",
    ]);
  });

  it("does not treat imports in an ordinary module as re-exports", async () => {
    write("pkg/__init__.py", "");
    write("pkg/models.py", "class User: ...\n");
    write("pkg/service.py", "from .models import User\n");
    write("main.py", "from pkg.service import User\n");
    const index = await indexProject(registerProject(root));
    expect(index.files["pkg/service.py"].dependencies[0].reExportedNames).toBeUndefined();
  });
});

describe("Python absolute imports of project modules", () => {
  const has = files(
    "app/__init__.py",
    "app/models.py",
    "app/services/__init__.py",
    "app/services/billing.py",
    "src/core/__init__.py",
    "src/core/engine.py",
    "tool.py"
  );
  const resolve = (specifier: string, names: string[] = []) =>
    resolveDependency(
      { targetSpecifier: specifier, importedSymbols: names },
      "app/main.py",
      has,
      null
    );

  it("resolves dotted project modules and packages", () => {
    expect(resolve("app.models", ["User"])).toEqual({
      resolvedPath: "app/models.py",
      resolution: "resolved",
      internal: true,
    });
    expect(resolve("app.services.billing").resolvedPath).toBe("app/services/billing.py");
    expect(resolve("tool").resolvedPath).toBe("tool.py");
  });

  it("resolves names that are submodules of an imported package", () => {
    expect(resolve("app.services", ["billing"]).resolvedPaths).toBeUndefined();
    expect(resolve("app.services", ["billing"]).resolvedPath).toBe("app/services/billing.py");
    expect(resolve("app.services", ["billing", "helper"]).resolvedPaths).toEqual([
      "app/services/__init__.py",
      "app/services/billing.py",
    ]);
  });

  it("finds top-level packages under src/", () => {
    expect(resolve("core.engine").resolvedPath).toBe("src/core/engine.py");
  });

  it("leaves the standard library and installed packages non-relative", () => {
    expect(resolve("os").resolution).toBe("non-relative");
    expect(resolve("requests.adapters").resolution).toBe("non-relative");
    expect(resolve("app.missing").resolution).toBe("non-relative");
  });

  it("does not apply to other languages", () => {
    expect(
      resolveDependency({ targetSpecifier: "tool" }, "app/main.ts", has, null).resolution
    ).toBe("non-relative");
  });

  it("marks a resolved project module as internal in the index", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-pyabs-home-"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-pyabs-proj-"));
    const prev = process.env.KAI_HOME;
    process.env.KAI_HOME = home;
    try {
      const put = (rel: string, content: string) => {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
      };
      put("app/__init__.py", "");
      put("app/models.py", "class User: ...\n");
      put("app/main.py", "import os\nfrom app.models import User\n");
      const index = await indexProject(registerProject(root));
      const [stdlib, project] = index.files["app/main.py"].dependencies;
      expect(stdlib).toMatchObject({ resolution: "non-relative", isExternal: true });
      expect(project).toMatchObject({
        resolvedPath: "app/models.py",
        resolution: "resolved",
        isExternal: false,
      });
      expect(buildReverseImportMap(index).get("app/models.py")).toEqual(["app/main.py"]);
    } finally {
      process.env.KAI_HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Python source roots from pyproject.toml / setup.cfg", () => {
  let home = "";
  let root = "";
  const prevHome = process.env.KAI_HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-pyroots-home-"));
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-pyroots-proj-"));
    process.env.KAI_HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.KAI_HOME;
    else process.env.KAI_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const put = (rel: string, content: string) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  const depOf = async (rel: string, i = 0) => {
    const index = await indexProject(registerProject(root));
    return index.files[rel].dependencies[i];
  };

  it("reads setuptools package-dir (inline table)", async () => {
    put("pyproject.toml", '[tool.setuptools]\npackage-dir = {"" = "lib"}\n');
    put("lib/mypkg/__init__.py", "");
    put("lib/mypkg/core.py", "def run(): ...\n");
    put("app.py", "from mypkg.core import run\n");
    expect(await depOf("app.py")).toMatchObject({
      resolvedPath: "lib/mypkg/core.py",
      resolution: "resolved",
      isExternal: false,
    });
  });

  it("reads the package-dir table form and packages.find where", async () => {
    put(
      "pyproject.toml",
      [
        "[tool.setuptools.packages.find]",
        'where = ["python"]',
        "",
        "[tool.setuptools.package-dir]",
        '"" = "ignored-dir"',
      ].join("\n")
    );
    put("python/tool/__init__.py", "");
    put("python/tool/x.py", "");
    put("app.py", "import tool.x\n");
    expect((await depOf("app.py")).resolvedPath).toBe("python/tool/x.py");
  });

  it("reads poetry `from`, pytest pythonpath (multi-line array) and hatch wheel packages", async () => {
    put(
      "pyproject.toml",
      [
        "[tool.poetry]",
        'packages = [{ include = "pa", from = "poetry_src" }]',
        "[tool.pytest.ini_options]",
        "pythonpath = [",
        '  "path_a",  # comment',
        '  "path_b",',
        "]",
        "[tool.hatch.build.targets.wheel]",
        'packages = ["hatch_src/hp"]',
      ].join("\n")
    );
    put("poetry_src/pa/__init__.py", "");
    put("path_b/pb/__init__.py", "");
    put("hatch_src/hp/__init__.py", "");
    put("app.py", "import pa\nimport pb\nimport hp\n");
    expect((await depOf("app.py", 0)).resolvedPath).toBe("poetry_src/pa/__init__.py");
    expect((await depOf("app.py", 1)).resolvedPath).toBe("path_b/pb/__init__.py");
    expect((await depOf("app.py", 2)).resolvedPath).toBe("hatch_src/hp/__init__.py");
  });

  it("reads setup.cfg package_dir and packages.find where", async () => {
    put(
      "setup.cfg",
      [
        "[options]",
        "package_dir =",
        "    =cfg_src",
        "",
        "[options.packages.find]",
        "where = other_src",
      ].join("\n")
    );
    put("cfg_src/one/__init__.py", "");
    put("other_src/two/__init__.py", "");
    put("app.py", "import one\nimport two\n");
    expect((await depOf("app.py", 0)).resolvedPath).toBe("cfg_src/one/__init__.py");
    expect((await depOf("app.py", 1)).resolvedPath).toBe("other_src/two/__init__.py");
  });

  it("treats a nested pyproject directory (monorepo package) as a root of its own", async () => {
    put("libs/common/pyproject.toml", "[project]\nname = 'common'\n");
    put("libs/common/src/common/__init__.py", "");
    put("libs/common/src/common/util.py", "");
    put("services/api/main.py", "from common.util import thing\n");
    expect((await depOf("services/api/main.py")).resolvedPath).toBe(
      "libs/common/src/common/util.py"
    );
  });

  it("ignores roots that leave the project and malformed configs", async () => {
    put(
      "pyproject.toml",
      '[tool.setuptools]\npackage-dir = {"" = "../outside"}\n[broken\nx = = =\n'
    );
    put("app.py", "import nothing_here\n");
    expect((await depOf("app.py")).resolution).toBe("non-relative");
  });

  it("is not fooled by prototype-polluting keys", () => {
    const doc = parseTomlSubset('[__proto__]\npolluted = "yes"\n[tool.x]\n__proto__ = "no"\n');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(doc)).not.toContain("__proto__");
  });

  it("resolves a namespace package whose modules sit in different roots", () => {
    const has = files("lib1/ns/a.py", "lib2/ns/b.py", "app.py");
    const r = resolveDependency(
      { targetSpecifier: "ns", importedSymbols: ["a", "b"] },
      "app.py",
      has,
      null,
      ["", "lib1", "lib2"]
    );
    expect(r).toMatchObject({ resolution: "resolved", internal: true });
    expect(r.resolvedPaths).toEqual(["lib1/ns/a.py", "lib2/ns/b.py"]);
    // Without those roots it stays a package name.
    expect(
      resolveDependency({ targetSpecifier: "ns", importedSymbols: ["a"] }, "app.py", has).resolution
    ).toBe("non-relative");
  });

  it("does not resolve a standard-library name to a local file from another directory", () => {
    const has = files("logging.py", "main.py", "app/x.py", "src/types.py", "src/run.py");
    const imp = (specifier: string, from: string) =>
      resolveDependency({ targetSpecifier: specifier, importedSymbols: [] }, from, has).resolution;
    // Same directory as the module: Python itself prefers the local file.
    expect(imp("logging", "main.py")).toBe("resolved");
    expect(imp("types", "src/run.py")).toBe("resolved");
    // Elsewhere it is the standard library.
    expect(imp("logging", "app/x.py")).toBe("non-relative");
    expect(imp("types", "app/x.py")).toBe("non-relative");
  });
});

describe("tsconfig extends arrays and packages, jsconfig and project references", () => {
  let home = "";
  let root = "";
  const prevHome = process.env.KAI_HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-tsref-home-"));
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-tsref-proj-"));
    process.env.KAI_HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.KAI_HOME;
    else process.env.KAI_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (rel: string, content: string) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  const depsOf = async (rel: string) => {
    const index = await indexProject(registerProject(root));
    return index.files[rel].dependencies;
  };

  it("merges an `extends` array with later entries winning, and the config itself last", () => {
    write("a.json", '{ "compilerOptions": { "baseUrl": ".", "paths": { "@a/*": ["from-a/*"] } } }');
    write("b.json", '{ "compilerOptions": { "paths": { "@b/*": ["from-b/*"] } } }');
    write("tsconfig.json", '{ "extends": ["./a.json", "./b.json"] }');
    // `paths` is taken whole from the last config that declares it (b), `baseUrl` from a.
    expect(loadTsPathAliases(root)).toEqual({
      baseUrl: "",
      paths: [{ pattern: "@b/*", targets: ["from-b/*"] }],
    });
    write(
      "tsconfig.json",
      '{ "extends": ["./a.json", "./b.json"], "compilerOptions": { "paths": { "@me/*": ["me/*"] } } }'
    );
    expect(loadTsPathAliases(root)?.paths).toEqual([{ pattern: "@me/*", targets: ["me/*"] }]);
  });

  it("follows an `extends` from a package inside the project's node_modules", () => {
    write(
      "node_modules/@acme/tsconfig/base.json",
      '{ "compilerOptions": { "paths": { "@/*": ["src/*"] } } }'
    );
    write(
      "tsconfig.json",
      '{ "extends": "@acme/tsconfig/base.json", "compilerOptions": { "baseUrl": "." } }'
    );
    // The project's own baseUrl anchors the package's `paths`.
    expect(loadTsPathAliases(root)).toEqual({
      baseUrl: "",
      paths: [{ pattern: "@/*", targets: ["src/*"] }],
    });
    // A package directory resolves to its tsconfig.json, and `.json` is optional.
    write("node_modules/shared-cfg/tsconfig.json", '{ "compilerOptions": { "baseUrl": "lib" } }');
    write("apps/x/tsconfig.json", '{ "extends": "shared-cfg" }');
    expect(loadTsPathAliases(root, "apps/x")?.baseUrl).toBe("node_modules/shared-cfg/lib");
  });

  it("refuses a package config that is not found inside the project, or that escapes it", () => {
    write("tsconfig.json", '{ "extends": "no-such-package" }');
    expect(loadTsPathAliases(root)).toBeNull();
    write("tsconfig.json", '{ "extends": "../outside/tsconfig.json" }');
    expect(loadTsPathAliases(root)).toBeNull();
    write("tsconfig.json", '{ "extends": "pkg/../../x" }');
    expect(loadTsPathAliases(root)).toBeNull();
  });

  it("uses jsconfig.json when a directory has no tsconfig.json", async () => {
    write(
      "jsconfig.json",
      '{ "compilerOptions": { "baseUrl": ".", "paths": { "~/*": ["src/*"] } } }'
    );
    write("src/a.js", "import { b } from '~/b';\nexport const a = b;\n");
    write("src/b.js", "export const b = 1;\n");
    expect((await depsOf("src/a.js"))[0]).toMatchObject({
      resolvedPath: "src/b.js",
      resolution: "resolved",
    });
  });

  it("prefers tsconfig.json over jsconfig.json in the same directory", () => {
    write("jsconfig.json", '{ "compilerOptions": { "baseUrl": "js" } }');
    write("tsconfig.json", '{ "compilerOptions": { "baseUrl": "ts" } }');
    expect(loadTsPathAliases(root)?.baseUrl).toBe("ts");
  });

  it("routes a file through a solution-style tsconfig to the referenced config that covers it", async () => {
    write(
      "tsconfig.json",
      '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tools" }] }'
    );
    write(
      "tsconfig.app.json",
      '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } }, "include": ["src"], "exclude": ["src/legacy"] }'
    );
    write(
      "tools/tsconfig.json",
      '{ "compilerOptions": { "baseUrl": ".", "paths": { "#t/*": ["./lib/*"] } }, "include": ["**/*.ts"] }'
    );
    write("src/b.ts", "export const b = 1;\n");
    write("src/main.ts", "import { b } from '@/b';\nexport const m = b;\n");
    write("src/legacy/old.ts", "import { b } from '@/b';\nexport const o = b;\n");
    write("tools/lib/util.ts", "export const util = 1;\n");
    write("tools/run.ts", "import { util } from '#t/util';\nexport const r = util;\n");
    const index = await indexProject(registerProject(root));
    expect(index.files["src/main.ts"].dependencies[0]).toMatchObject({
      resolvedPath: "src/b.ts",
      resolution: "resolved",
    });
    // Excluded by the referenced config: no aliases, so it stays a package-looking name.
    expect(index.files["src/legacy/old.ts"].dependencies[0].resolution).toBe("non-relative");
    // The nearest config for tools/ is tools/tsconfig.json itself.
    expect(index.files["tools/run.ts"].dependencies[0]).toMatchObject({
      resolvedPath: "tools/lib/util.ts",
      resolution: "resolved",
    });
  });

  it("covers files by `files`, `**` globs and an implicit directory", async () => {
    write(
      "tsconfig.json",
      '{ "files": [], "references": [{ "path": "./one.json" }, { "path": "./two.json" }] }'
    );
    write(
      "one.json",
      '{ "compilerOptions": { "baseUrl": ".", "paths": { "@one/*": ["a/*"] } }, "files": ["entry.ts"] }'
    );
    write(
      "two.json",
      '{ "compilerOptions": { "baseUrl": ".", "paths": { "@two/*": ["b/*"] } }, "include": ["pkgs/**/src/*.ts"] }'
    );
    write("a/x.ts", "export const x = 1;\n");
    write("b/y.ts", "export const y = 1;\n");
    write("entry.ts", "import { x } from '@one/x';\nexport const e = x;\n");
    write("pkgs/deep/src/z.ts", "import { y } from '@two/y';\nexport const z = y;\n");
    write("pkgs/deep/other/w.ts", "import { y } from '@two/y';\nexport const w = y;\n");
    const index = await indexProject(registerProject(root));
    expect(index.files["entry.ts"].dependencies[0].resolvedPath).toBe("a/x.ts");
    expect(index.files["pkgs/deep/src/z.ts"].dependencies[0].resolvedPath).toBe("b/y.ts");
    // Not covered by any referenced config.
    expect(index.files["pkgs/deep/other/w.ts"].dependencies[0].resolution).toBe("non-relative");
  });

  it("keeps a config's own aliases when it also lists references", async () => {
    write(
      "tsconfig.json",
      '{ "compilerOptions": { "baseUrl": ".", "paths": { "@own/*": ["own/*"] } }, "references": [{ "path": "./other.json" }] }'
    );
    write(
      "other.json",
      '{ "compilerOptions": { "baseUrl": ".", "paths": { "@other/*": ["x/*"] } } }'
    );
    write("own/a.ts", "export const a = 1;\n");
    write("main.ts", "import { a } from '@own/a';\nexport const m = a;\n");
    expect((await depsOf("main.ts"))[0].resolvedPath).toBe("own/a.ts");
  });

  it("ignores references that escape the project, are missing or malformed", () => {
    write(
      "tsconfig.json",
      '{ "references": [{ "path": "../elsewhere" }, { "path": "./missing" }, { "nopath": 1 }, 7, null] }'
    );
    expect(loadTsPathAliases(root)).toBeNull();
  });
});

describe("Rust module and Go package resolution", () => {
  let home = "";
  let root = "";
  const prevHome = process.env.KAI_HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-rsgo-home-"));
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-rsgo-proj-"));
    process.env.KAI_HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.KAI_HOME;
    else process.env.KAI_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const put = (rel: string, content: string) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  const build = () => indexProject(registerProject(root));
  const targets = (index: Awaited<ReturnType<typeof build>>, rel: string, spec: string) => {
    const dep = index.files[rel].dependencies.find((d) => d.targetSpecifier === spec);
    if (!dep) throw new Error(`no dependency ${spec} in ${rel}`);
    return dependencyTargets(dep, rel, (p) => Object.prototype.hasOwnProperty.call(index.files, p));
  };

  describe("Rust", () => {
    const writeCrate = () => {
      put("Cargo.toml", '[package]\nname = "app"\nversion = "0.1.0"\n');
      put(
        "src/lib.rs",
        [
          "mod util;",
          "mod net;",
          '#[path = "elsewhere.rs"] mod moved;',
          "mod inline { mod deep; }",
          "pub use self::net::Client;",
          "pub fn root_fn() {}",
        ].join("\n")
      );
      put("src/util.rs", "pub fn helper() {}\npub fn other() {}\n");
      put("src/net/mod.rs", "mod client;\npub use self::client::Client;\n");
      put(
        "src/net/client.rs",
        "use super::Config;\nuse crate::util::helper;\npub struct Client;\n"
      );
    };

    it("links `mod foo;` declarations to their files and skips path/inline ones", async () => {
      writeCrate();
      const index = await build();
      expect(targets(index, "src/lib.rs", "self::util")).toEqual(["src/util.rs"]);
      expect(targets(index, "src/lib.rs", "self::net")).toEqual(["src/net/mod.rs"]);
      expect(index.files["src/net/mod.rs"].dependencies[0]).toMatchObject({
        targetSpecifier: "self::client",
        resolvedPath: "src/net/client.rs",
        isExternal: false,
      });
      const specs = index.files["src/lib.rs"].dependencies.map((d) => d.targetSpecifier);
      expect(specs).not.toContain("self::moved");
      expect(specs).not.toContain("self::deep");
    });

    it("resolves crate::, self:: and super:: paths to the module files", async () => {
      writeCrate();
      const index = await build();
      expect(targets(index, "src/net/client.rs", "crate::util::helper")).toEqual(["src/util.rs"]);
      // `super::Config` is an item of src/net/mod.rs, the parent module.
      expect(targets(index, "src/net/client.rs", "super::Config")).toEqual(["src/net/mod.rs"]);
      expect(index.files["src/net/client.rs"].dependencies[1].isExternal).toBe(false);
    });

    it("follows `pub use` re-exports to the file that defines the item", async () => {
      writeCrate();
      put("src/app.rs", "use crate::Client;\nfn go(_c: Client) {}\n");
      const index = await build();
      expect(index.files["src/lib.rs"].dependencies.find((d) => d.reExportedNames)).toMatchObject({
        targetSpecifier: "self::net::Client",
        reExportedNames: ["Client"],
      });
      // crate::Client -> lib.rs, then through `pub use self::net::Client` to net/mod.rs and client.rs.
      expect(targets(index, "src/app.rs", "crate::Client")).toEqual([
        "src/lib.rs",
        "src/net/mod.rs",
        "src/net/client.rs",
      ]);
      expect(buildReverseImportMap(index).get("src/net/client.rs")).toContain("src/app.rs");
    });

    it("flattens nested use groups and resolves imported names that are modules", async () => {
      writeCrate();
      put("src/app.rs", "use crate::{util::{helper, other as o}, net::{self, Client}};\n");
      const index = await build();
      const specs = index.files["src/app.rs"].dependencies.map((d) => [
        d.targetSpecifier,
        d.importedSymbols,
      ]);
      expect(specs).toEqual([
        ["crate::util", ["helper", "other"]],
        ["crate", ["net"]],
        ["crate::net", ["Client"]],
      ]);
      expect(targets(index, "src/app.rs", "crate::util")).toEqual(["src/util.rs"]);
      // `net` is itself a module: `crate` + name `net` reaches src/net/mod.rs.
      expect(targets(index, "src/app.rs", "crate")).toEqual(["src/net/mod.rs"]);
    });

    it("resolves other crates of the workspace and leaves real packages alone", async () => {
      put("crates/core/Cargo.toml", '[package]\nname = "my-core"\n');
      put("crates/core/src/lib.rs", "pub mod types;\n");
      put("crates/core/src/types.rs", "pub struct Kind;\n");
      put("crates/cli/Cargo.toml", '[package]\nname = "cli"\n');
      put(
        "crates/cli/src/main.rs",
        "use my_core::types::Kind;\nuse std::fmt;\nuse serde::Serialize;\nuse crate::missing::Thing;\nfn main() {}\n"
      );
      const index = await build();
      const deps = index.files["crates/cli/src/main.rs"].dependencies;
      expect(deps[0]).toMatchObject({
        resolvedPath: "crates/core/src/types.rs",
        resolution: "resolved",
        isExternal: false,
      });
      expect(deps[1]).toMatchObject({ resolution: "non-relative", isExternal: true });
      expect(deps[2]).toMatchObject({ resolution: "non-relative", isExternal: true });
      expect(deps[3]).toMatchObject({ resolution: "unresolved" });
    });

    it("does not link a missing `crate::` module to the importing file", () => {
      const has = files("src/lib.rs");
      const r = resolveDependency(
        { targetSpecifier: "crate::nope::X", importedSymbols: ["X"] },
        "src/lib.rs",
        has
      );
      expect(r).toEqual({ resolvedPath: null, resolution: "unresolved" });
    });
  });

  describe("Go", () => {
    const writeModule = () => {
      put("go.mod", "module example.com/app\n\ngo 1.22\n\nrequire github.com/x/y v1.0.0\n");
      put(
        "main.go",
        [
          "package main",
          "",
          "import (",
          '  "fmt"',
          '  st "example.com/app/internal/store"',
          '  "github.com/x/y"',
          '  "example.com/app/missing"',
          ")",
          "func main() { fmt.Println(st.X, y.Y) }",
        ].join("\n")
      );
      put("internal/store/store.go", "package store\nvar X = 1\n");
      put("internal/store/db.go", "package store\nvar Y = 2\n");
      put("internal/store/store_test.go", "package store\n");
    };

    it("resolves an import path under the module to the package's non-test files", async () => {
      writeModule();
      const index = await build();
      const deps = index.files["main.go"].dependencies;
      expect(deps[1]).toMatchObject({
        targetSpecifier: "example.com/app/internal/store",
        resolvedPath: "internal/store/db.go",
        resolvedPaths: ["internal/store/db.go", "internal/store/store.go"],
        resolution: "resolved",
        isExternal: false,
      });
      expect(deps[0]).toMatchObject({ resolution: "non-relative", isExternal: true });
      expect(deps[2]).toMatchObject({ resolution: "non-relative", isExternal: true });
      // Under the module but no such package in the index.
      expect(deps[3]).toMatchObject({ resolution: "unresolved" });
      expect(buildReverseImportMap(index).get("internal/store/store.go")).toEqual(["main.go"]);
    });

    it("prefers the longest module path, and follows local replace directives", async () => {
      writeModule();
      put("tools/go.mod", "module example.com/app/tools\n");
      put("tools/gen/gen.go", "package gen\n");
      put("third_party/lib/lib.go", "package lib\n");
      put(
        "go.mod",
        [
          "module example.com/app",
          "replace example.com/lib => ./third_party/lib",
          "replace (",
          "  example.com/other v1.2.3 => ../outside",
          ")",
        ].join("\n")
      );
      put(
        "cmd/run.go",
        'package main\nimport (\n  "example.com/app/tools/gen"\n  "example.com/lib"\n  "example.com/other"\n)\n'
      );
      const index = await build();
      const [gen, lib, other] = index.files["cmd/run.go"].dependencies;
      expect(gen.resolvedPath).toBe("tools/gen/gen.go");
      expect(lib.resolvedPath).toBe("third_party/lib/lib.go");
      // A replace target outside the project is ignored.
      expect(other.resolution).toBe("non-relative");
    });

    it("caps the files recorded per package", async () => {
      put("go.mod", "module m.io/x\n");
      for (let i = 0; i < 12; i++) put(`pkg/f${String(i).padStart(2, "0")}.go`, "package pkg\n");
      put("a.go", 'package x\nimport "m.io/x/pkg"\n');
      const index = await build();
      expect(index.files["a.go"].dependencies[0].resolvedPaths).toHaveLength(8);
    });
  });
});
