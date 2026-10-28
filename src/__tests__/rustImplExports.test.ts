import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { indexProject } from "../core/indexer";
import { registerProject } from "../core/registry";
import { extractSymbolsAndDeps } from "../core/symbolExtractor";
import { settleRustImplExports } from "../core/rustImplExports";
import type { IndexedSymbol } from "../core/types";

const rs = (src: string, rel = "src/api.rs") => extractSymbolsAndDeps(src, rel, "rust");
const sym = (symbols: IndexedSymbol[], name: string): IndexedSymbol => {
  const found = symbols.filter((s) => s.name === name);
  if (found.length !== 1) throw new Error(`expected one ${name}, got ${found.length}`);
  return found[0];
};

describe("Rust trait-impl extraction: references to declarations in other files", () => {
  it("records the use-expanded path of a type or trait declared elsewhere", () => {
    const { symbols } = rs(
      [
        "use crate::model::{Open as Renamed, Closed};",
        "use crate::traits::Pub;",
        "use std::fmt::Display;",
        "impl Pub for Renamed { fn a1(&self) {} }",
        "impl Display for Closed { fn a2(&self) {} }",
        "impl Pub for Closed { fn a3(&self) {} }",
        "impl Default for Closed { fn a4(&self) {} }",
      ].join("\n")
    );
    // The alias is expanded to the imported item, never matched by its local name.
    expect(sym(symbols, "a1").implOf).toEqual({
      type: "crate::model::Open",
      trait: "crate::traits::Pub",
    });
    expect(sym(symbols, "a2").implOf).toEqual({
      type: "crate::model::Closed",
      trait: "std::fmt::Display",
    });
    expect(sym(symbols, "a4").implOf).toEqual({ type: "crate::model::Closed", trait: "Default" });
    // Until the cross-file pass runs, a type from elsewhere is never guessed exported.
    for (const name of ["a1", "a2", "a3", "a4"]) expect(sym(symbols, name).isExported).toBe(false);
  });

  it("keeps a same-file public type exported and refers only the trait", () => {
    const { symbols } = rs(
      [
        "use crate::traits::Internal;",
        "pub struct Local;",
        "impl Internal for Local { fn b1(&self) {} }",
        "impl Display for Local { fn b2(&self) {} }",
      ].join("\n")
    );
    expect(sym(symbols, "b1")).toMatchObject({
      isExported: true,
      implOf: { trait: "crate::traits::Internal" },
    });
    expect(sym(symbols, "b2")).toMatchObject({ isExported: true, implOf: { trait: "Display" } });
  });

  it("has nothing to settle when this file declares both sides", () => {
    const { symbols } = rs(
      [
        "pub struct T;",
        "pub trait Open { fn open(&self); }",
        "trait Hidden { fn hide(&self); }",
        "impl Open for T { fn c1(&self) {} }",
        "impl Hidden for T { fn c2(&self) {} }",
      ].join("\n")
    );
    expect(sym(symbols, "c1")).toMatchObject({ isExported: true });
    expect(sym(symbols, "c1").implOf).toBeUndefined();
    expect(sym(symbols, "c2")).toMatchObject({ isExported: false });
    expect(sym(symbols, "c2").implOf).toBeUndefined();
  });

  it("does not match a qualified path to a same-named declaration of this file", () => {
    const { symbols } = rs(
      [
        "use crate::model;",
        "pub struct Closed;",
        "pub trait Pub { fn p(&self); }",
        "impl Pub for Closed { fn d1(&self) {} }",
        "impl Pub for model::Closed { fn d2(&self) {} }",
      ].join("\n")
    );
    expect(sym(symbols, "d1")).toMatchObject({ isExported: true });
    expect(sym(symbols, "d1").implOf).toBeUndefined();
    expect(sym(symbols, "d2")).toMatchObject({
      isExported: false,
      implOf: { type: "crate::model::Closed" },
    });
  });

  it("expands a bound module, a child `mod foo;` and refuses an ambiguous binding", () => {
    const { symbols } = rs(
      [
        "mod net;",
        "use crate::traits;",
        "use crate::first::Twin;",
        "mod inner { use crate::second::Twin; }",
        "impl traits::Pub for net::Client { fn e1(&self) {} }",
        "impl traits::Pub for Twin { fn e2(&self) {} }",
      ].join("\n")
    );
    expect(sym(symbols, "e1").implOf).toEqual({
      type: "self::net::Client",
      trait: "crate::traits::Pub",
    });
    // `Twin` is bound to two different paths in this file: it cannot be pinned down.
    expect(sym(symbols, "e2")).toMatchObject({ isExported: false });
    expect(sym(symbols, "e2").implOf).toBeUndefined();
  });

  it("settles an impl in an inline module and a non-path type without a reference", () => {
    const { symbols } = rs(
      [
        "use crate::model::Open;",
        "use crate::traits::Pub;",
        "mod inner { impl Pub for Open { fn f1(&self) {} } }",
        "impl Pub for (Open, Open) { fn f2(&self) {} }",
        "impl Pub for [Open; 2] { fn f3(&self) {} }",
      ].join("\n")
    );
    for (const name of ["f1", "f2", "f3"]) {
      expect(sym(symbols, name)).toMatchObject({ isExported: false });
      expect(sym(symbols, name).implOf).toBeUndefined();
    }
  });

  it("resolves a type declared in an inline module of the same file", () => {
    const { symbols } = rs(
      [
        "pub mod shapes { pub struct Square; struct Hidden; }",
        "pub trait Pub { fn p(&self); }",
        "impl Pub for shapes::Square { fn g1(&self) {} }",
        "impl Pub for shapes::Hidden { fn g2(&self) {} }",
        "impl Pub for shapes::Missing { fn g3(&self) {} }",
      ].join("\n")
    );
    expect(sym(symbols, "g1")).toMatchObject({ isExported: true });
    expect(sym(symbols, "g2")).toMatchObject({ isExported: false });
    expect(sym(symbols, "g3")).toMatchObject({ isExported: false });
    for (const name of ["g1", "g2", "g3"]) expect(sym(symbols, name).implOf).toBeUndefined();
  });
});

describe("settleRustImplExports on a built index", () => {
  let home = "";
  let root = "";
  const prevHome = process.env.KAI_HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-rsimpl-home-"));
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-rsimpl-proj-"));
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
  const exported = (index: Awaited<ReturnType<typeof build>>, rel: string, name: string) =>
    sym(index.files[rel].symbols, name).isExported;

  const writeCrate = () => {
    put("Cargo.toml", '[package]\nname = "app"\nversion = "0.1.0"\n');
    put(
      "src/lib.rs",
      ["mod model;", "mod traits;", "mod a;", "mod b;", "mod barrel;", "mod net;", "mod api;"].join(
        "\n"
      )
    );
    put("src/model.rs", "pub struct Open;\nstruct Closed;\npub(crate) struct Internal;\n");
    put(
      "src/traits.rs",
      "pub trait Pub { fn p(&self); }\npub(crate) trait Inner { fn i(&self); }\ntrait Priv { fn v(&self); }\n"
    );
    put("src/a.rs", "pub struct Dup;\npub struct Twin;\npub struct Solo;\n");
    put("src/b.rs", "struct Dup;\npub struct Twin;\n");
    put("src/barrel.rs", "pub use crate::a::*;\npub use crate::b::*;\n");
    put("src/net/mod.rs", "mod client;\npub use self::client::Client;\n");
    put("src/net/client.rs", "pub struct Client;\n");
  };

  it("exports a trait-impl method only when the type and trait elsewhere are public", async () => {
    writeCrate();
    put(
      "src/api.rs",
      [
        "use crate::model::{Open, Closed, Internal};",
        "use crate::model::Open as Alias;",
        "use crate::traits::{Pub, Inner, Priv};",
        "use crate::nowhere::Ghost;",
        "use crate::net::Client;",
        "use std::fmt::Display;",
        "impl Pub for Open { fn ok_plain(&self) {} }",
        "impl Pub for Alias { fn ok_alias(&self) {} }",
        "impl Display for Open { fn ok_std_trait(&self) {} }",
        "impl Default for Open { fn ok_prelude_trait(&self) {} }",
        "impl Pub for Client { fn ok_reexported_type(&self) {} }",
        "impl crate::traits::Pub for Open { fn ok_inline_path(&self) {} }",
        "impl Pub for Closed { fn no_private_type(&self) {} }",
        "impl Pub for Internal { fn no_crate_type(&self) {} }",
        "impl Inner for Open { fn no_crate_trait(&self) {} }",
        "impl Priv for Open { fn no_private_trait(&self) {} }",
        "impl Pub for Ghost { fn no_unresolved_type(&self) {} }",
        "impl Pub for Unbound { fn no_unbound_type(&self) {} }",
        "pub struct Mine;",
        "impl Inner for Mine { fn no_crate_trait_local_type(&self) {} }",
        "impl Pub for Mine { fn ok_local_type(&self) {} }",
      ].join("\n")
    );
    const index = await build();
    const f = "src/api.rs";
    for (const name of [
      "ok_plain",
      "ok_alias",
      "ok_std_trait",
      "ok_prelude_trait",
      "ok_reexported_type",
      "ok_inline_path",
      "ok_local_type",
    ]) {
      expect(exported(index, f, name), name).toBe(true);
    }
    for (const name of [
      "no_private_type",
      "no_crate_type",
      "no_crate_trait",
      "no_private_trait",
      "no_unresolved_type",
      "no_unbound_type",
      "no_crate_trait_local_type",
    ]) {
      expect(exported(index, f, name), name).toBe(false);
    }
  });

  it("stays unexported for an unresolved trait path, a name collision and an ambiguous barrel", async () => {
    writeCrate();
    put(
      "src/api.rs",
      [
        "use crate::model::Open;",
        "use crate::traits::Pub;",
        "use crate::b::Dup;",
        "use crate::barrel::{Twin, Solo};",
        "use crate::nowhere::Missing;",
        "use crate::traits;",
        "impl Missing for Open { fn no_unresolved_trait(&self) {} }",
        // `Dup` is public in a.rs but private in b.rs: the import names b.rs.
        "impl Pub for Dup { fn no_collision_private(&self) {} }",
        // Both a.rs and b.rs declare `Twin` behind the barrel: ambiguous.
        "impl Pub for Twin { fn no_ambiguous_barrel(&self) {} }",
        "impl Pub for Solo { fn ok_single_definer_behind_barrel(&self) {} }",
        "impl traits::Pub for Open { fn ok_bound_module(&self) {} }",
        "impl traits::Inner for Open { fn no_bound_module_crate_trait(&self) {} }",
      ].join("\n")
    );
    const index = await build();
    const f = "src/api.rs";
    expect(exported(index, f, "no_unresolved_trait")).toBe(false);
    expect(exported(index, f, "no_collision_private")).toBe(false);
    expect(exported(index, f, "no_ambiguous_barrel")).toBe(false);
    expect(exported(index, f, "ok_single_definer_behind_barrel")).toBe(true);
    expect(exported(index, f, "ok_bound_module")).toBe(true);
    expect(exported(index, f, "no_bound_module_crate_trait")).toBe(false);
  });

  it("reads a trait provided by a resolved glob import, and a prelude trait through a glob", async () => {
    writeCrate();
    put(
      "src/api.rs",
      [
        "use crate::model::Open;",
        "use crate::traits::*;",
        "impl Pub for Open { fn ok_glob_pub_trait(&self) {} }",
        "impl Inner for Open { fn no_glob_crate_trait(&self) {} }",
        "impl Default for Open { fn ok_prelude_with_glob(&self) {} }",
      ].join("\n")
    );
    const index = await build();
    const f = "src/api.rs";
    expect(exported(index, f, "ok_glob_pub_trait")).toBe(true);
    expect(exported(index, f, "no_glob_crate_trait")).toBe(false);
    expect(exported(index, f, "ok_prelude_with_glob")).toBe(true);
  });

  it("follows a change in another file without the impl's own file changing", async () => {
    writeCrate();
    put(
      "src/api.rs",
      "use crate::model::Closed;\nuse crate::traits::Pub;\nimpl Pub for Closed { fn follows(&self) {} }\n"
    );
    expect(exported(await build(), "src/api.rs", "follows")).toBe(false);

    put("src/model.rs", "pub struct Open;\npub struct Closed;\npub(crate) struct Internal;\n");
    const widened = await build();
    expect(exported(widened, "src/api.rs", "follows")).toBe(true);

    put("src/traits.rs", "pub trait Pub { fn p(&self); }\n");
    put("src/model.rs", "pub struct Open;\nstruct Closed;\n");
    expect(exported(await build(), "src/api.rs", "follows")).toBe(false);
  });

  it("persists only the references, and a rebuild reuses them", async () => {
    writeCrate();
    put(
      "src/api.rs",
      "use crate::model::Open;\nuse crate::traits::Pub;\nimpl Pub for Open { fn kept(&self) {} }\n"
    );
    const first = await build();
    const kept = sym(first.files["src/api.rs"].symbols, "kept");
    expect(kept.implOf).toEqual({ type: "crate::model::Open", trait: "crate::traits::Pub" });
    const second = await build();
    expect(sym(second.files["src/api.rs"].symbols, "kept")).toMatchObject({
      isExported: true,
      implOf: { type: "crate::model::Open", trait: "crate::traits::Pub" },
    });
  });

  it("ignores snapshots without references and non-Rust files", () => {
    const plain: IndexedSymbol[] = [
      {
        name: "legacy",
        kind: "function",
        filePath: "src/old.rs",
        location: { filePath: "src/old.rs", line: 1, column: 1 },
        isExported: false,
        container: "T",
      },
    ];
    const files = {
      "src/old.rs": { dependencies: [], symbols: plain },
      "src/x.ts": { dependencies: [] },
    };
    settleRustImplExports(files, (p) => p in files, null);
    expect(plain[0].isExported).toBe(false);
  });
});
