import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { extractSymbolsAndDeps, indexProject, EXTRACTOR_VERSION } from "../core/indexer";
import { resolveDependency, buildReverseImportMap } from "../core/importResolver";
import { registerProject, loadProjectIndex, getProjectIndexPath } from "../core/registry";
import { detectStaleIndexEntries } from "../core/indexer";
import type { IndexedSymbol } from "../core/types";

function ts(src: string, file = "src/a.ts") {
  return extractSymbolsAndDeps(src, file, "typescript");
}
function byName(symbols: IndexedSymbol[], name: string): IndexedSymbol[] {
  return symbols.filter((s) => s.name === name);
}
function one(symbols: IndexedSymbol[], name: string): IndexedSymbol {
  const found = byName(symbols, name);
  expect(found, `symbol ${name}`).toHaveLength(1);
  return found[0];
}

describe("TypeScript / JavaScript extraction", () => {
  it("recognises multiline function signatures and reports the full range", () => {
    const src = [
      "export async function loadThing(", // 1
      "  id: string,", // 2
      "  options: { retries: number; verbose?: boolean },", // 3
      "): Promise<{ ok: boolean }> {", // 4
      "  const local = id.trim();", // 5
      "  return { ok: local.length > 0 };", // 6
      "}", // 7
    ].join("\n");
    const { symbols } = ts(src);
    expect(symbols.map((s) => s.name)).toEqual(["loadThing"]);
    const fn = symbols[0];
    expect(fn.kind).toBe("function");
    expect(fn.isExported).toBe(true);
    expect(fn.location.line).toBe(1);
    expect(fn.location.endLine).toBe(7);
    expect(fn.signature).toContain("loadThing(");
    expect(fn.signature).toContain("Promise<{ ok: boolean }>");
    expect(fn.signature).not.toContain("const local");
  });

  it("does not mistake a return-type object literal for the function body", () => {
    const src = [
      "function f(): { a: number } {",
      "  return { a: 1 };",
      "}",
      "const after = 2;",
    ].join("\n");
    const { symbols } = ts(src);
    expect(one(symbols, "f").location.endLine).toBe(3);
    expect(one(symbols, "after").location.line).toBe(4);
  });

  it("indexes module-level declarations but not locals", () => {
    const src = [
      "const TOP_LEVEL = 1;", // 1
      "let counter = 0;", // 2
      "export function work() {", // 3
      "  const inner = 5;", // 4
      "  let temp = inner + 1;", // 5
      "  function nested() { return temp; }", // 6
      "  const arrow = () => temp;", // 7
      "  return nested() + arrow();", // 8
      "}", // 9
      "if (counter) {", // 10
      "  const inBlock = 1;", // 11
      "}", // 12
    ].join("\n");
    const names = ts(src).symbols.map((s) => s.name);
    expect(names).toEqual(["TOP_LEVEL", "counter", "work"]);
    for (const local of ["inner", "temp", "nested", "arrow", "inBlock"]) {
      expect(names).not.toContain(local);
    }
  });

  it("classifies constants, variables, arrow functions and exports", () => {
    const src = [
      "export const MAX_ITEMS = 10;",
      "const hidden = 'x';",
      "export const add = (a: number, b: number) => a + b;",
      "export const load = async (",
      "  id: string,",
      "): Promise<string> => {",
      "  return id;",
      "};",
      "const useIt = useCallback(() => 1, []);",
    ].join("\n");
    const { symbols } = ts(src);
    expect(one(symbols, "MAX_ITEMS")).toMatchObject({ kind: "constant", isExported: true });
    expect(one(symbols, "hidden")).toMatchObject({ kind: "variable", isExported: false });
    expect(one(symbols, "add")).toMatchObject({ kind: "function", isExported: true });
    const load = one(symbols, "load");
    expect(load.kind).toBe("function");
    expect(load.location).toMatchObject({ line: 4, endLine: 8 });
    // A call result is a variable, not a function.
    expect(one(symbols, "useIt").kind).toBe("variable");
  });

  it("handles classes, methods with modifiers, accessors and visibility", () => {
    const src = [
      "export class Service<T> extends Base {", // 1
      "  private secret = 1;", // 2
      "  handler = (e: Event) => {", // 3
      "    return e;", // 4
      "  };", // 5
      "  constructor(private readonly dep: Dep) { super(); }", // 6
      "  async run(", // 7
      "    input: T,", // 8
      "  ): Promise<void> {", // 9
      "    const x = 1;", // 10
      "  }", // 11
      "  private helper(): void {}", // 12
      "  static create(): Service<number> { return new Service(); }", // 13
      "  get size(): number { return 1; }", // 14
      "}", // 15
    ].join("\n");
    const { symbols } = ts(src);
    const cls = one(symbols, "Service");
    expect(cls).toMatchObject({ kind: "class", isExported: true });
    expect(cls.location).toMatchObject({ line: 1, endLine: 15 });
    const run = one(symbols, "run");
    expect(run).toMatchObject({ kind: "function", container: "Service", isExported: true });
    expect(run.location).toMatchObject({ line: 7, endLine: 11 });
    expect(one(symbols, "helper")).toMatchObject({ container: "Service", isExported: false });
    expect(one(symbols, "create").location.line).toBe(13);
    expect(one(symbols, "size").location.line).toBe(14);
    expect(one(symbols, "handler")).toMatchObject({ kind: "function", container: "Service" });
    expect(one(symbols, "constructor")).toMatchObject({
      kind: "function",
      container: "Service",
      isExported: true,
    });
    expect(one(symbols, "constructor").location).toMatchObject({ line: 6, endLine: 6 });
    // Private properties are indexed (never exported); locals inside bodies are not.
    expect(one(symbols, "secret")).toMatchObject({
      kind: "variable",
      container: "Service",
      isExported: false,
    });
    // `constructor(private readonly dep: Dep)` declares a property.
    expect(one(symbols, "dep")).toMatchObject({
      kind: "variable",
      container: "Service",
      isExported: false,
    });
    expect(byName(symbols, "x")).toHaveLength(0);
  });

  it("indexes private class properties and constructor parameter properties", () => {
    const src = [
      "export class Repo {", // 1
      "  private cache = new Map<string, number>();", // 2
      "  #token = 'x';", // 3
      "  private static readonly LIMIT = 5;", // 4
      "  constructor(", // 5
      "    private readonly db: Db<string, number>,", // 6
      "    public name: string = 'a, b',", // 7
      "    protected opts: { retries: number; cb: (a: number, b: number) => void },", // 8
      "    readonly id: number,", // 9
      "    plain: string,", // 10
      "    @Inject(TOKEN) private svc: Svc,", // 11
      "  ) {", // 12
      "    this.cache.clear();", // 13
      "  }", // 14
      "}", // 15
      "class Overloads {", // 16
      "  constructor(a: string);", // 17
      "  constructor(a: number);", // 18
      "  constructor(private a: unknown) {}", // 19
      "}", // 20
      "export class Plain {", // 21
      "  constructor(a: string, b = 1) {}", // 22
      "}", // 23
    ].join("\n");
    const { symbols } = ts(src);
    const member = (name: string) => one(symbols, name);
    expect(member("cache")).toMatchObject({
      kind: "variable",
      container: "Repo",
      isExported: false,
    });
    expect(member("#token")).toMatchObject({ container: "Repo", isExported: false });
    expect(member("LIMIT")).toMatchObject({
      kind: "constant",
      container: "Repo",
      isExported: false,
    });
    expect(member("db")).toMatchObject({ kind: "variable", container: "Repo", isExported: false });
    expect(member("db").location).toMatchObject({ line: 6, endLine: 6 });
    expect(member("db").signature).toBe("private readonly db: Db<string, number>");
    // A default containing a comma, and a public parameter, stay one parameter each.
    expect(member("name")).toMatchObject({ container: "Repo", isExported: true });
    expect(member("opts")).toMatchObject({ container: "Repo", isExported: false });
    expect(member("id")).toMatchObject({ container: "Repo", isExported: true });
    expect(member("svc")).toMatchObject({ container: "Repo", isExported: false });
    expect(member("svc").location.line).toBe(11);
    // A parameter without a modifier is not a property.
    expect(byName(symbols, "plain")).toHaveLength(0);
    expect(byName(symbols, "retries")).toHaveLength(0);
    // Only the implementation of an overloaded constructor declares properties.
    expect(byName(symbols, "a").filter((s) => s.container === "Overloads")).toHaveLength(1);
    expect(byName(symbols, "b")).toHaveLength(0);
    expect(symbols.filter((s) => s.container === "Plain").map((s) => s.name)).toEqual([
      "constructor",
    ]);
  });

  it("indexes class properties (private ones included) and constructors with their visibility", () => {
    const src = [
      "export class Config {", // 1
      "  readonly name: string;", // 2
      "  static readonly MAX_RETRIES = 3;", // 3
      "  protected timeout?: number = 30;", // 4
      "  private secret = 'x';", // 5
      "  #hidden = 1;", // 6
      "  items: Array<{ id: string }> = [];", // 7
      "  count;", // 8
      "  [key: string]: unknown;", // 9
      "  @Input() label = 'a';", // 10
      "  private constructor(name: string) { this.name = name; }", // 11
      "  total = (a: number) => a;", // 12
      "}", // 13
      "class Local {", // 14
      "  value = 1;", // 15
      "}", // 16
    ].join("\n");
    const { symbols } = ts(src);
    expect(one(symbols, "name")).toMatchObject({
      kind: "variable",
      container: "Config",
      isExported: true,
    });
    expect(one(symbols, "name").location).toMatchObject({ line: 2, endLine: 2 });
    expect(one(symbols, "name").signature).toContain("readonly name: string");
    expect(one(symbols, "MAX_RETRIES")).toMatchObject({ kind: "constant", isExported: true });
    expect(one(symbols, "timeout")).toMatchObject({ kind: "variable", isExported: false });
    expect(one(symbols, "items").location.line).toBe(7);
    expect(one(symbols, "count").container).toBe("Config");
    expect(one(symbols, "label").location.line).toBe(10);
    expect(one(symbols, "total").kind).toBe("function"); // function-valued: still a function
    expect(one(symbols, "secret")).toMatchObject({ kind: "variable", isExported: false });
    expect(one(symbols, "#hidden")).toMatchObject({ container: "Config", isExported: false });
    expect(byName(symbols, "key")).toHaveLength(0);
    // A private constructor is indexed but not exported.
    expect(one(symbols, "constructor")).toMatchObject({ container: "Config", isExported: false });
    expect(one(symbols, "value")).toMatchObject({ container: "Local", isExported: false });
  });

  it("indexes interfaces, type aliases, enums and namespaces with ranges", () => {
    const src = [
      "export interface Options {", // 1
      "  name: string;", // 2
      "  run(): void;", // 3
      "}", // 4
      "export type Result =", // 5
      "  | { ok: true }", // 6
      "  | { ok: false };", // 7
      "enum Color { Red, Green }", // 8
      "export namespace Util {", // 9
      "  export function helper() {}", // 10
      "}", // 11
    ].join("\n");
    const { symbols } = ts(src);
    expect(one(symbols, "Options")).toMatchObject({ kind: "interface", isExported: true });
    expect(one(symbols, "Options").location).toMatchObject({ line: 1, endLine: 4 });
    expect(byName(symbols, "run")).toHaveLength(0); // interface members are not indexed
    expect(one(symbols, "Result").location).toMatchObject({ line: 5, endLine: 7 });
    expect(one(symbols, "Color").location).toMatchObject({ line: 8, endLine: 8 });
    expect(one(symbols, "Util").kind).toBe("module");
    expect(one(symbols, "helper")).toMatchObject({ container: "Util", isExported: true });
  });

  it("marks `export { a }` and `export default name` lists as exported", () => {
    const src = [
      "function a() {}",
      "const b = 1;",
      "class C {}",
      "function hidden() {}",
      "export { a, b as renamed };",
      "export default C;",
    ].join("\n");
    const { symbols } = ts(src);
    expect(one(symbols, "a").isExported).toBe(true);
    expect(one(symbols, "b").isExported).toBe(true);
    expect(one(symbols, "C").isExported).toBe(true);
    expect(one(symbols, "hidden").isExported).toBe(false);
  });

  it("ignores declarations inside comments, strings, templates and regexes", () => {
    const src = [
      "// export function commented() {}",
      "/* export function blockCommented() {",
      "   const x = 1; */",
      "const text = 'function fake() {}';",
      "const tpl = `",
      "export function inTemplate() {}",
      "  ${ '}' }",
      "`;",
      "const re = /[}{]function bad\\(\\)/g;",
      "export function real() {",
      "  return '}'; // }",
      "}",
      "export function afterReal() {}",
    ].join("\n");
    const { symbols } = ts(src);
    expect(symbols.map((s) => s.name)).toEqual(["text", "tpl", "re", "real", "afterReal"]);
    expect(one(symbols, "real").location).toMatchObject({ line: 10, endLine: 12 });
    expect(one(symbols, "afterReal").location.line).toBe(13);
  });

  it("is CRLF-safe: same names and line numbers as LF", () => {
    const lf = [
      "export function a(",
      "  x: number,",
      ") {",
      "  return x;",
      "}",
      "export const B = 2;",
    ].join("\n");
    const crlf = lf.replace(/\n/g, "\r\n");
    const a = ts(lf).symbols;
    const b = ts(crlf).symbols;
    expect(b.map((s) => [s.name, s.location.line, s.location.endLine])).toEqual(
      a.map((s) => [s.name, s.location.line, s.location.endLine])
    );
    expect(b[0].signature).not.toContain("\r");
  });

  it("does not crash or hang on malformed and truncated input", () => {
    const inputs = [
      "export function broken(",
      "export class {",
      "function a() { { { {",
      "}}}} export const x = ",
      "const s = 'unterminated\nexport function after() {}",
      "`unterminated template ${",
      "export const f = (a, b",
      "\u0000\u0001garbage\uffff",
      "export function ok() {}\n/* never closed",
      "",
    ];
    for (const input of inputs) {
      expect(() => ts(input)).not.toThrow();
    }
    // Recovery: an unterminated quote on one line does not swallow the next declaration.
    expect(byName(ts(inputs[4]).symbols, "after")).toHaveLength(1);
    // An unclosed body has no claimed end line.
    expect(
      one(ts("export function open() {\n  const x = 1;\n").symbols, "open").location.endLine
    ).toBe(undefined);
  });

  it("is deterministic and ordered by source position", () => {
    const src = "export const z = 1;\nexport function a() {}\nexport class M {}\n";
    const first = JSON.stringify(ts(src));
    expect(JSON.stringify(ts(src))).toBe(first);
    expect(ts(src).symbols.map((s) => s.name)).toEqual(["z", "a", "M"]);
  });

  it("treats a long single-line source as minified and skips it", () => {
    const giant = "function bundled(){" + "var a=1;".repeat(600) + "}";
    expect(giant.length).toBeGreaterThan(2048);
    expect(ts(giant + "\nexport function kept() {}").symbols.map((s) => s.name)).toEqual(["kept"]);
  });

  it("reads multi-line, type-only, side-effect, re-export and dynamic imports", () => {
    const src = [
      "import {",
      "  alpha,",
      "  beta as b2,",
      "  type Gamma,",
      "} from './mod';",
      "import Def, * as ns from '../other';",
      "import type { T } from 'pkg';",
      "import './side-effect.css';",
      "export { x } from './re';",
      "export * from './star';",
      "const lazy = () => import('./lazy');",
      "const c = require('cjs-lib');",
      "// import fake from './commented';",
      "const s = \"import nope from './in-string'\";",
    ].join("\n");
    const deps = ts(src).dependencies;
    const spec = deps.map((d) => d.targetSpecifier);
    expect(spec).toEqual([
      "./mod",
      "../other",
      "pkg",
      "./side-effect.css",
      "./re",
      "./star",
      "./lazy",
      "cjs-lib",
    ]);
    expect(deps[0].importedSymbols).toEqual(["alpha", "beta", "Gamma"]);
    expect(deps[1].importedSymbols).toEqual(["Def", "ns"]);
    expect(deps[0].isExternal).toBe(false);
    expect(deps[2].isExternal).toBe(true);
  });

  it("extracts JS files and CommonJS exports", () => {
    const src = [
      "exports.helper = function (a) {",
      "  return a;",
      "};",
      "module.exports.VALUE = 3;",
    ].join("\n");
    const { symbols } = extractSymbolsAndDeps(src, "lib/x.js", "javascript");
    expect(one(symbols, "helper")).toMatchObject({ kind: "function", isExported: true });
    expect(one(symbols, "helper").location).toMatchObject({ line: 1, endLine: 3 });
    expect(one(symbols, "VALUE")).toMatchObject({ kind: "constant", isExported: true });
  });

  it("handles JSX text with apostrophes without corrupting scope", () => {
    const src = [
      "export function View() {",
      "  return <p>Don't stop {value}</p>;",
      "}",
      "export const Other = () => <b>it's</b>;",
    ].join("\n");
    const { symbols } = extractSymbolsAndDeps(src, "src/View.tsx", "typescript");
    expect(symbols.map((s) => s.name)).toEqual(["View", "Other"]);
    expect(one(symbols, "View").location.endLine).toBe(3);
  });
});

describe("Rust extraction", () => {
  const rs = (src: string) => extractSymbolsAndDeps(src, "src/lib.rs", "rust");

  it("distinguishes pub, pub(crate) and private items", () => {
    const src = [
      "pub fn public_fn() {}",
      "pub(crate) fn crate_fn() {}",
      "pub(super) fn super_fn() {}",
      "fn private_fn() {}",
      "#[derive(Debug)]",
      "pub struct Open { pub a: u32 }",
      "struct Closed;",
      "pub enum Kind { A, B }",
      "pub trait Shape { fn area(&self) -> f64; }",
      "pub const LIMIT: usize = 3;",
      "static mut COUNTER: u32 = 0;",
      "pub type Alias = Vec<u8>;",
      "pub mod inner { pub fn deep() {} }",
    ].join("\n");
    const { symbols } = rs(src);
    expect(one(symbols, "public_fn").isExported).toBe(true);
    expect(one(symbols, "crate_fn").isExported).toBe(false);
    expect(one(symbols, "super_fn").isExported).toBe(false);
    expect(one(symbols, "private_fn").isExported).toBe(false);
    expect(one(symbols, "Open")).toMatchObject({ kind: "class", isExported: true });
    expect(one(symbols, "Closed")).toMatchObject({ kind: "class", isExported: false });
    expect(one(symbols, "Kind").isExported).toBe(true);
    expect(one(symbols, "Shape")).toMatchObject({ kind: "interface", isExported: true });
    expect(one(symbols, "area")).toMatchObject({ container: "Shape", isExported: true });
    expect(one(symbols, "LIMIT")).toMatchObject({ kind: "constant", isExported: true });
    expect(one(symbols, "COUNTER")).toMatchObject({ kind: "variable", isExported: false });
    expect(one(symbols, "Alias").kind).toBe("type");
    expect(one(symbols, "inner").kind).toBe("module");
    expect(one(symbols, "deep")).toMatchObject({ container: "inner", isExported: true });
  });

  it("handles multiline signatures, impl blocks and accurate ranges", () => {
    const src = [
      "pub struct Cache {", // 1
      "    items: Vec<u8>,", // 2
      "}", // 3
      "impl<T: Clone> Cache {", // 4
      "    pub fn get<K>(", // 5
      "        &self,", // 6
      "        key: K,", // 7
      "    ) -> Option<&u8>", // 8
      "    where", // 9
      "        K: Into<usize>,", // 10
      "    {", // 11
      "        let local = 1;", // 12
      "        None", // 13
      "    }", // 14
      "    fn private_helper(&self) {}", // 15
      "}", // 16
      "impl Display for Cache {", // 17
      "    fn fmt(&self, f: &mut Formatter) -> Result { Ok(()) }", // 18
      "}", // 19
    ].join("\n");
    const { symbols } = rs(src);
    expect(one(symbols, "Cache").location).toMatchObject({ line: 1, endLine: 3 });
    const get = one(symbols, "get");
    expect(get).toMatchObject({ container: "Cache", isExported: true });
    expect(get.location).toMatchObject({ line: 5, endLine: 14 });
    expect(get.signature).toContain("-> Option<&u8>");
    expect(one(symbols, "private_helper")).toMatchObject({ container: "Cache", isExported: false });
    expect(one(symbols, "fmt").container).toBe("Cache");
    expect(byName(symbols, "local")).toHaveLength(0);
  });

  it("marks trait-impl methods exported when the type and the trait are public", () => {
    const src = [
      "pub struct Cache {}", // 1
      "pub(crate) struct Hidden {}", // 2
      "trait Local { fn go(&self); }", // 3
      "pub trait Open { fn open(&self); }", // 4
      "impl Display for Cache {", // 5
      "    fn fmt(&self, f: &mut Formatter) -> Result { Ok(()) }", // 6
      "}", // 7
      "impl Display for Hidden {", // 8
      "    fn fmt(&self, f: &mut Formatter) -> Result { Ok(()) }", // 9
      "}", // 10
      "impl Local for Cache {", // 11
      "    fn go(&self) {}", // 12
      "}", // 13
      "impl Open for Cache {", // 14
      "    fn open(&self) {}", // 15
      "}", // 16
      "impl Display for Elsewhere {", // 17
      "    fn fmt(&self, f: &mut Formatter) -> Result { Ok(()) }", // 18
      "}", // 19
      "impl Cache {", // 20
      "    fn private_inherent(&self) {}", // 21
      "}", // 22
    ].join("\n");
    const { symbols } = rs(src);
    const atLine = (line: number) => symbols.find((s) => s.location.line === line)!;
    expect(atLine(6)).toMatchObject({ name: "fmt", container: "Cache", isExported: true });
    expect(atLine(9)).toMatchObject({ name: "fmt", container: "Hidden", isExported: false });
    // A private trait of this file does not make its methods public.
    expect(atLine(12)).toMatchObject({ name: "go", isExported: false });
    expect(atLine(15)).toMatchObject({ name: "open", container: "Cache", isExported: true });
    // A type declared elsewhere is unknown, so it stays unexported.
    expect(atLine(18)).toMatchObject({ container: "Elsewhere", isExported: false });
    // Inherent methods still need their own `pub`.
    expect(atLine(21)).toMatchObject({ name: "private_inherent", isExported: false });
  });

  it("ignores items in comments, strings, raw strings and char literals", () => {
    const src = [
      "// pub fn commented() {}",
      "/* nested /* pub fn inner() {} */ still comment */",
      'const S: &str = "pub fn in_string() {";',
      'const R: &str = r#"}} pub fn raw() {"#;',
      "const C: char = '{';",
      "fn lifetime<'a>(x: &'a str) -> &'a str { x }",
      "pub fn real() {}",
    ].join("\n");
    const names = rs(src).symbols.map((s) => s.name);
    expect(names).toEqual(["S", "R", "C", "lifetime", "real"]);
  });

  it("collects use declarations, including grouped and wrapped ones", () => {
    const src = [
      "use std::collections::HashMap;",
      "use crate::util::{",
      "    helper,",
      "    other as alias,",
      "};",
      "pub use self::inner::Thing;",
    ].join("\n");
    const deps = rs(src).dependencies;
    expect(deps.map((d) => d.targetSpecifier)).toEqual([
      "std::collections::HashMap",
      "crate::util",
      "self::inner::Thing",
    ]);
    expect(deps[1].importedSymbols).toEqual(["helper", "other"]);
    expect(deps.map((d) => d.isExternal)).toEqual([true, false, false]);
  });
});

describe("Go extraction", () => {
  const go = (src: string) => extractSymbolsAndDeps(src, "pkg/svc.go", "go");

  it("handles funcs, methods, wrapped signatures and exported-ness by capitalisation", () => {
    const src = [
      "package svc", // 1
      "", // 2
      "type Server struct {", // 3
      "\tName string", // 4
      "}", // 5
      "", // 6
      "type store interface {", // 7
      "\tGet(k string) string", // 8
      "}", // 9
      "", // 10
      "func (s *Server) Handle(", // 11
      "\tctx context.Context,", // 12
      "\treq Request,", // 13
      ") (resp Response, err error) {", // 14
      "\tlocal := 1", // 15
      "\treturn", // 16
      "}", // 17
      "", // 18
      "func helper() interface{} {", // 19
      "\treturn nil", // 20
      "}", // 21
      "", // 22
      "type Celsius float64", // 23
    ].join("\n");
    const { symbols } = go(src);
    expect(one(symbols, "Server")).toMatchObject({ kind: "class", isExported: true });
    expect(one(symbols, "Server").location).toMatchObject({ line: 3, endLine: 5 });
    expect(one(symbols, "store")).toMatchObject({ kind: "interface", isExported: false });
    const handle = one(symbols, "Handle");
    expect(handle).toMatchObject({ kind: "function", container: "Server", isExported: true });
    expect(handle.location).toMatchObject({ line: 11, endLine: 17 });
    expect(one(symbols, "helper")).toMatchObject({ isExported: false });
    expect(one(symbols, "helper").location).toMatchObject({ line: 19, endLine: 21 });
    expect(one(symbols, "Celsius")).toMatchObject({ kind: "type", isExported: true });
    expect(byName(symbols, "local")).toHaveLength(0);
    expect(byName(symbols, "Name")).toHaveLength(0);
  });

  it("handles const/var blocks and single declarations", () => {
    const src = [
      "package p",
      'const Version = "1"',
      "const (",
      "\tA = iota",
      "\tB",
      "\tmax, Min = 1, 2",
      ")",
      "var (",
      "\tglobalCount int",
      "\tOther = struct {",
      "\t\tx int",
      "\t}{}",
      ")",
      "var single int",
      "func f() {",
      "\tvar inside int",
      "}",
    ].join("\n");
    const { symbols } = go(src);
    const names = symbols.map((s) => s.name);
    expect(names).toEqual([
      "Version",
      "A",
      "B",
      "max",
      "Min",
      "globalCount",
      "Other",
      "single",
      "f",
    ]);
    expect(one(symbols, "A")).toMatchObject({ kind: "constant", isExported: true });
    expect(one(symbols, "max").isExported).toBe(false);
    expect(one(symbols, "globalCount")).toMatchObject({ kind: "variable", isExported: false });
    expect(names).not.toContain("inside");
  });

  it("reads single and grouped imports with aliases", () => {
    const src = [
      "package p",
      'import "fmt"',
      "import (",
      '\tstr "strings"',
      '\t"example.com/mod/util"',
      '\t_ "embed"',
      ")",
      '// import "commented"',
    ].join("\n");
    const deps = go(src).dependencies;
    expect(deps.map((d) => d.targetSpecifier)).toEqual([
      "fmt",
      "strings",
      "example.com/mod/util",
      "embed",
    ]);
    expect(deps[1].importedSymbols).toEqual(["str"]);
  });

  it("ignores raw strings and comments that contain declarations", () => {
    const src = [
      "package p",
      "const sample = `",
      "func inString() {}",
      "`",
      "// func commented() {}",
      "func real() {}",
    ].join("\n");
    const names = go(src).symbols.map((s) => s.name);
    expect(names).toEqual(["sample", "real"]);
  });
});

describe("Python extraction", () => {
  const py = (src: string) => extractSymbolsAndDeps(src, "pkg/mod.py", "python");

  it("handles wrapped def signatures, classes, methods and block ranges", () => {
    const src = [
      "import os", // 1
      "from . import sibling", // 2
      "from .util import (", // 3
      "    one,", // 4
      "    two as deux,", // 5
      ")", // 6
      "", // 7
      "MAX_SIZE = 10", // 8
      "_private = 1", // 9
      "", // 10
      "class Service(Base):", // 11
      '    """Docstring with def fake(): inside."""', // 12
      "    limit = 3", // 13
      "", // 14
      "    def run(", // 15
      "        self,", // 16
      "        value: int,", // 17
      "    ) -> int:", // 18
      "        local = value", // 19
      "        def nested(): pass", // 20
      "        return local", // 21
      "", // 22
      "    def _hidden(self): pass", // 23
      "", // 24
      "async def top(x):", // 25
      "    return x", // 26
      "# trailing comment", // 27
    ].join("\n");
    const { symbols, dependencies } = py(src);
    expect(symbols.map((s) => s.name)).toEqual([
      "MAX_SIZE",
      "_private",
      "Service",
      "run",
      "_hidden",
      "top",
    ]);
    expect(one(symbols, "MAX_SIZE")).toMatchObject({ kind: "constant", isExported: true });
    expect(one(symbols, "_private").isExported).toBe(false);
    const svc = one(symbols, "Service");
    expect(svc.location).toMatchObject({ line: 11, endLine: 23 });
    const run = one(symbols, "run");
    expect(run).toMatchObject({ container: "Service", kind: "function", isExported: true });
    expect(run.location).toMatchObject({ line: 15, endLine: 21 });
    expect(run.signature).toContain("-> int:");
    expect(one(symbols, "_hidden").isExported).toBe(false);
    expect(one(symbols, "top").location).toMatchObject({ line: 25, endLine: 26 });
    expect(byName(symbols, "nested")).toHaveLength(0);
    expect(byName(symbols, "local")).toHaveLength(0);

    expect(dependencies.map((d) => d.targetSpecifier)).toEqual(["os", ".", ".util"]);
    expect(dependencies[2].importedSymbols).toEqual(["one", "two"]);
    expect(dependencies.map((d) => d.isExternal)).toEqual([true, false, false]);
  });

  it("handles CRLF, tabs and conditional definitions", () => {
    const src = [
      "import sys",
      "if sys.platform == 'win32':",
      "\tdef win_only():",
      "\t\treturn 1",
      "else:",
      "\tdef other_only():",
      "\t\treturn 2",
    ].join("\r\n");
    const { symbols } = py(src);
    expect(symbols.map((s) => s.name)).toEqual(["win_only", "other_only"]);
    expect(one(symbols, "win_only").location).toMatchObject({ line: 3, endLine: 4 });
  });

  it("never throws on malformed source", () => {
    for (const input of [
      "def broken(",
      "class :",
      "'''never closed\ndef x(): pass",
      "\t\t  \n  def",
    ]) {
      expect(() => py(input)).not.toThrow();
    }
  });
});

describe("dependency resolution", () => {
  const files = new Set([
    "src/a.ts",
    "src/b.ts",
    "src/util/index.ts",
    "src/comp.tsx",
    "pkg/__init__.py",
    "pkg/mod.py",
    "pkg/sub/leaf.py",
  ]);
  const has = (p: string) => files.has(p);

  it("resolves relative TS/JS specifiers, ESM .js extensions and directory index files", () => {
    expect(resolveDependency({ targetSpecifier: "./b" }, "src/a.ts", has)).toEqual({
      resolvedPath: "src/b.ts",
      resolution: "resolved",
    });
    expect(resolveDependency({ targetSpecifier: "./b.js" }, "src/a.ts", has).resolvedPath).toBe(
      "src/b.ts"
    );
    expect(resolveDependency({ targetSpecifier: "./util" }, "src/a.ts", has).resolvedPath).toBe(
      "src/util/index.ts"
    );
    expect(resolveDependency({ targetSpecifier: "./comp" }, "src/a.ts", has).resolvedPath).toBe(
      "src/comp.tsx"
    );
  });

  it("reports unresolved, non-relative and unsupported explicitly instead of guessing", () => {
    expect(resolveDependency({ targetSpecifier: "./missing" }, "src/a.ts", has)).toEqual({
      resolvedPath: null,
      resolution: "unresolved",
    });
    expect(resolveDependency({ targetSpecifier: "@/alias/x" }, "src/a.ts", has).resolution).toBe(
      "non-relative"
    );
    expect(resolveDependency({ targetSpecifier: "react" }, "src/a.ts", has).resolution).toBe(
      "non-relative"
    );
    // Rust: a `crate::` path whose module is not an indexed file is unresolved, a crate name is not followed.
    expect(resolveDependency({ targetSpecifier: "crate::x" }, "src/lib.rs", has).resolution).toBe(
      "unresolved"
    );
    expect(resolveDependency({ targetSpecifier: "std::fmt" }, "src/lib.rs", has).resolution).toBe(
      "non-relative"
    );
    expect(resolveDependency({ targetSpecifier: "x" }, "notes.txt", has).resolution).toBe(
      "unsupported"
    );
    expect(resolveDependency({ targetSpecifier: "../../escape" }, "src/a.ts", has).resolution).toBe(
      "unresolved"
    );
  });

  it("resolves Python relative imports", () => {
    expect(resolveDependency({ targetSpecifier: ".mod" }, "pkg/other.py", has).resolvedPath).toBe(
      "pkg/mod.py"
    );
    expect(resolveDependency({ targetSpecifier: "." }, "pkg/other.py", has).resolvedPath).toBe(
      "pkg/__init__.py"
    );
    expect(
      resolveDependency({ targetSpecifier: "..mod" }, "pkg/sub/leaf.py", has).resolvedPath
    ).toBe("pkg/mod.py");
  });
});

describe("hostile input stays linear (no quadratic regex scans)", () => {
  // Each shape is a file of many unterminated statements. Before the clause patterns
  // were length-bounded, ~128 KB of these took seconds and 512 KB tens of seconds, all
  // while the indexer held the project lock. Generous limits keep this stable on slow CI.
  const SIZE = 256 * 1024;
  const shapes: Array<[string, string, string]> = [
    ["typescript", "a.ts", "import {a,\n"],
    ["typescript", "b.ts", "import\n"],
    ["typescript", "c.ts", "import a\n"],
    ["typescript", "d.ts", "export {a,\n"],
    ["rust", "a.rs", "use a::{b,\n"],
    ["rust", "b.rs", "pub(\n"],
    ["rust", "c.rs", "#[\n"],
    ["go", "a.go", "import (\n"],
  ];
  for (const [lang, file, unit] of shapes) {
    it(`${file}: ${JSON.stringify(unit)} repeated to 256 KB`, () => {
      const text = unit.repeat(Math.ceil(SIZE / unit.length));
      const t0 = performance.now();
      const result = extractSymbolsAndDeps(text, `src/${file}`, lang);
      const ms = performance.now() - t0;
      expect(Array.isArray(result.symbols)).toBe(true);
      expect(ms).toBeLessThan(1500);
    });
  }

  it("still parses a long, legitimate multi-line import and a long grouped use", () => {
    const names = Array.from({ length: 150 }, (_, i) => `symbol${i}`);
    const ts = `import {\n  ${names.join(",\n  ")},\n} from "./big";\n`;
    const dep = extractSymbolsAndDeps(ts, "src/x.ts", "typescript").dependencies[0];
    expect(dep.targetSpecifier).toBe("./big");
    expect(dep.importedSymbols).toHaveLength(150);
    const rs = `use crate::big::{\n    ${names.join(",\n    ")},\n};\n`;
    const rdep = extractSymbolsAndDeps(rs, "src/x.rs", "rust").dependencies[0];
    expect(rdep.targetSpecifier).toBe("crate::big");
    expect(rdep.importedSymbols).toHaveLength(150);
  });
});

describe("indexing integration", () => {
  let home = "";
  let root = "";
  const prevHome = process.env.KAI_HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-sym-home-"));
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-sym-proj-"));
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

  it("populates resolvedPath, lineCount and the extractor version, and builds a reverse map", async () => {
    write("src/a.ts", "import { b } from './b';\nimport x from 'react';\nexport function a() {}\n");
    write("src/b.ts", "export function b() {}\n");
    const index = await indexProject(registerProject(root));
    expect(index.extractorVersion).toBe(EXTRACTOR_VERSION);
    const a = index.files["src/a.ts"];
    expect(a.lineCount).toBe(3);
    expect(a.dependencies[0]).toMatchObject({
      resolvedPath: "src/b.ts",
      resolution: "resolved",
      isExternal: false,
    });
    expect(a.dependencies[1]).toMatchObject({ resolvedPath: null, resolution: "non-relative" });
    expect(buildReverseImportMap(index).get("src/b.ts")).toEqual(["src/a.ts"]);
  });

  it("re-resolves reused files when a target appears later", async () => {
    write("src/a.ts", "import './later';\n");
    const meta = registerProject(root);
    const first = await indexProject(meta);
    expect(first.files["src/a.ts"].dependencies[0].resolution).toBe("unresolved");
    write("src/later.ts", "export const L = 1;\n");
    const second = await indexProject(meta);
    expect(second.files["src/a.ts"].dependencies[0].resolvedPath).toBe("src/later.ts");
  });

  it("re-extracts a snapshot written by an older extractor, once", async () => {
    write("src/a.ts", "export function alpha(\n  x: number,\n) {\n  return x;\n}\n");
    const meta = registerProject(root);
    await indexProject(meta);
    expect(detectStaleIndexEntries(loadProjectIndex(meta.id)!).isStale).toBe(false);

    // Simulate an index written by the previous extractor: no version, and the
    // wrapped signature was missed.
    const legacy = loadProjectIndex(meta.id)!;
    delete legacy.extractorVersion;
    legacy.files["src/a.ts"].symbols = [];
    legacy.symbolIndex = {};
    fs.writeFileSync(getProjectIndexPath(meta.id), JSON.stringify(legacy));
    const drift = detectStaleIndexEntries(loadProjectIndex(meta.id)!);
    expect(drift.extractorOutdated).toBe(true);
    expect(drift.isStale).toBe(true);

    const migrated = await indexProject(meta);
    expect(migrated.extractorVersion).toBe(EXTRACTOR_VERSION);
    expect(migrated.symbolIndex["alpha"]?.[0].location).toMatchObject({ line: 1, endLine: 5 });
    // Reprocessing is not a content change.
    expect(migrated.changes?.modified).toEqual([]);
    expect(detectStaleIndexEntries(migrated).isStale).toBe(false);
  });
});
