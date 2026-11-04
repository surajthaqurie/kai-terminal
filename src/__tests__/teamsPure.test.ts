import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  clip,
  ellipsize,
  padRight,
  renderParts,
  textWidth,
  visibleWidth,
  wrap,
} from "../cli/teams/ansi";
import { InputParser } from "../cli/teams/input";
import { parseUriList, readClipboardAttachments, splitPastedPaths } from "../core/teams/clipboard";
import { composeHtml, decodeEntities, parseBody, sanitize } from "../core/teams/html";
import { rowsForImage, sniffImage } from "../core/teams/images";
import { privateTempDir } from "../core/teams/tempdir";

describe("sanitize", () => {
  it("removes escape sequences, control characters and bidi overrides but keeps newlines", () => {
    const evil = "hi\u001b[2J\u001b]0;title\u0007 there\u202e!\nline2\tx\u009b";
    const out = sanitize(evil);
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("\u0007");
    expect(out).not.toContain("\u202e");
    expect(out).not.toContain("\u009b");
    expect(out).toContain("\nline2 x");
  });
});

describe("parseBody", () => {
  it("turns Teams HTML into text with mentions, line breaks and entities", () => {
    const html =
      '<p>Hi <at id="0">Priya Nair</at>, build &amp; test OK</p><div>Line two<br>Line three</div>';
    expect(parseBody(html, true).text).toBe(
      "Hi @Priya Nair, build & test OK\nLine two\nLine three"
    );
  });

  it("collects inline images and keeps emoji as characters", () => {
    const html =
      '<div>look <img src="https://graph.microsoft.com/v1.0/chats/1/messages/2/hostedContents/3/$value" alt="shot"> ' +
      '<img itemtype="http://schema.skype.com/Emoji" alt="\ud83d\ude00" src="x"><emoji alt="\ud83d\udc4d"></emoji></div>';
    const r = parseBody(html, true);
    expect(r.images).toEqual([
      {
        url: "https://graph.microsoft.com/v1.0/chats/1/messages/2/hostedContents/3/$value",
        alt: "shot",
      },
    ]);
    // The picture leaves its surrounding spaces behind; the emoji stay as characters.
    expect(r.text).toBe("look  \ud83d\ude00\ud83d\udc4d");
  });

  it("never lets markup or escapes through to the terminal", () => {
    const r = parseBody("<script>alert(1)</script><b>bold</b>\u001b[31m red", true);
    expect(r.text).not.toContain("<");
    expect(r.text).not.toContain("\u001b");
    expect(parseBody("plain \u001b[31mtext", false).text).toBe("plain [31mtext");
  });

  it("decodes numeric entities and leaves unknown ones", () => {
    expect(decodeEntities("&#65;&#x42;&nbsp;&bogus;")).toBe("AB &bogus;");
  });
});

describe("composeHtml", () => {
  it("escapes text, keeps line breaks and references hosted images 1..n", () => {
    const html = composeHtml("a <b> & c\nnext", 2, [{ name: "r.pdf", url: "https://x/y?a=1&b=2" }]);
    expect(html).toContain("a &lt;b&gt; &amp; c<br>next");
    expect(html).toContain('src="../hostedContents/1/$value"');
    expect(html).toContain('src="../hostedContents/2/$value"');
    expect(html).toContain('href="https://x/y?a=1&amp;b=2"');
    expect(composeHtml("   ", 0)).toBe("");
  });
});

describe("sniffImage", () => {
  const png = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1,
    0x40, 0, 0, 0, 0xb4,
  ]);

  it("reads PNG size from the header, not the file name", () => {
    expect(sniffImage(png)).toMatchObject({
      kind: "png",
      width: 320,
      height: 180,
      mime: "image/png",
    });
  });

  it("reads GIF and JPEG sizes", () => {
    const gif = Uint8Array.from([...Buffer.from("GIF89a"), 0x40, 0x01, 0xb4, 0x00, 0, 0]);
    expect(sniffImage(gif)).toMatchObject({ kind: "gif", width: 320, height: 180 });
    // SOI, APP0 (length 4), SOF0 with height 180 and width 320.
    const jpg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 180, 1, 64, 3, 1, 0x11, 0,
    ]);
    expect(sniffImage(jpg)).toMatchObject({ kind: "jpeg", width: 320, height: 180 });
  });

  it("refuses text and unknown data", () => {
    expect(
      sniffImage(new TextEncoder().encode("hello world, not an image at all............"))
    ).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
  });

  it("sizes the picture in terminal rows, clamped", () => {
    expect(rowsForImage({ width: 320, height: 180 }, 40, 14)).toBe(12);
    expect(rowsForImage({ width: 100, height: 4000 }, 40, 14)).toBe(14);
    expect(rowsForImage({ width: 0, height: 0 }, 30, 14)).toBe(10);
  });
});

describe("text layout helpers", () => {
  it("counts wide characters as two cells and combining marks as none", () => {
    expect(textWidth("abc")).toBe(3);
    expect(textWidth("\u4e16\u754c")).toBe(4);
    expect(textWidth("e\u0301")).toBe(1);
  });

  it("clips, pads and ellipsizes by cells", () => {
    expect(clip("\u4e16\u754c\u4e16", 5)).toBe("\u4e16\u754c");
    expect(padRight("ab", 5)).toBe("ab   ");
    expect(ellipsize("hello world", 8)).toBe("hello w\u2026");
    expect(ellipsize("hi", 8)).toBe("hi");
  });

  it("wraps words and breaks over-long ones", () => {
    expect(wrap("one two three", 7)).toEqual(["one two", "three"]);
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrap("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });

  it("renders parts to an exact width", () => {
    const row = renderParts(
      [
        ["1", "hello"],
        ["36", " world"],
      ],
      20
    );
    expect(visibleWidth(row)).toBe(20);
    expect(visibleWidth(renderParts([["", "too long for it"]], 5))).toBe(5);
  });
});

describe("InputParser", () => {
  const events = (...chunks: string[]) => {
    const p = new InputParser();
    return chunks.flatMap((c) => p.feed(c));
  };

  it("parses text, enter, newline, backspace and control keys", () => {
    expect(events("hi\r")).toEqual([
      { type: "text", text: "hi" },
      { type: "key", key: "enter" },
    ]);
    expect(events("\n\u007f\u0016\u0003")).toEqual([
      { type: "key", key: "newline" },
      { type: "key", key: "backspace" },
      { type: "ctrl", letter: "v" },
      { type: "ctrl", letter: "c" },
    ]);
  });

  it("parses arrows, page keys, delete and a lone Escape", () => {
    expect(events("\u001b[A\u001b[B\u001b[C\u001b[D\u001b[5~\u001b[6~\u001b[3~\u001bOA")).toEqual([
      { type: "key", key: "up" },
      { type: "key", key: "down" },
      { type: "key", key: "right" },
      { type: "key", key: "left" },
      { type: "key", key: "pageup" },
      { type: "key", key: "pagedown" },
      { type: "key", key: "delete" },
      { type: "key", key: "up" },
    ]);
    expect(events("\u001b")).toEqual([{ type: "key", key: "escape" }]);
  });

  it("parses SGR mouse presses and the wheel", () => {
    expect(events("\u001b[<0;12;5M\u001b[<0;12;5m\u001b[<64;3;4M\u001b[<65;3;4M")).toEqual([
      { type: "mouse", action: "press", x: 12, y: 5 },
      { type: "mouse", action: "release", x: 12, y: 5 },
      { type: "mouse", action: "wheelup", x: 3, y: 4 },
      { type: "mouse", action: "wheeldown", x: 3, y: 4 },
    ]);
  });

  it("collects a bracketed paste, even across chunks, as one event", () => {
    expect(events("\u001b[200~C:\\a b.png\r\nline\u001b[201~x")).toEqual([
      { type: "paste", text: "C:\\a b.png\nline" },
      { type: "text", text: "x" },
    ]);
    expect(events("\u001b[200~abc", "def\u001b[20", "1~")).toEqual([
      { type: "paste", text: "abcdef" },
    ]);
  });

  it("waits for the rest of a split escape sequence", () => {
    expect(events("\u001b[", "A")).toEqual([{ type: "key", key: "up" }]);
  });
});

describe("clipboard paths", () => {
  it("reads absolute file paths from a uri-list", () => {
    const text =
      "# c\r\nfile:///home/a/My%20Shot.png\r\nfile://localhost/tmp/b.txt\r\nhttps://x\r\nfile://rel.png\r\n";
    expect(parseUriList(text)).toEqual(["/home/a/My Shot.png", "/tmp/b.txt"]);
  });

  it("splits pasted text into paths, honouring quotes and escaped spaces", () => {
    expect(splitPastedPaths('"C:\\My Files\\a.png" C:\\b.png ', true)).toEqual([
      "C:\\My Files\\a.png",
      "C:\\b.png",
    ]);
    expect(splitPastedPaths("'/home/me/My Shot.png' /tmp/b.txt ", false)).toEqual([
      "/home/me/My Shot.png",
      "/tmp/b.txt",
    ]);
    expect(splitPastedPaths("/home/me/My\\ Shot.png", false)).toEqual(["/home/me/My Shot.png"]);
    expect(splitPastedPaths("   ", false)).toEqual([]);
  });

  it("reads copied files on Windows and saved images, using PowerShell with a path in the environment", async () => {
    const calls: Array<{ cmd: string; env?: NodeJS.ProcessEnv }> = [];
    const files = await readClipboardAttachments({
      platform: "win32",
      dir: "C:\\tmp",
      now: () => 7,
      run: async (cmd, _args, env) => {
        calls.push({ cmd, env });
        return { code: 0, stdout: Buffer.from("C:\\a.png\r\nC:\\b c.txt\r\n") };
      },
    });
    expect(files).toEqual(["C:\\a.png", "C:\\b c.txt"]);
    expect(calls[0].cmd).toBe("powershell");
    expect(calls[0].env?.KAI_PASTE_PNG).toContain("paste-7.png");
    const none = await readClipboardAttachments({
      platform: "win32",
      dir: "C:\\tmp",
      run: async () => ({ code: 1, stdout: Buffer.alloc(0) }),
    });
    expect(none).toEqual([]);
  });

  it("prefers copied files over the image on Linux and finds nothing for plain text", async () => {
    const run =
      (types: string, uri = "") =>
      async (_cmd: string, args: string[]) => {
        if (args.includes("--list-types")) return { code: 0, stdout: Buffer.from(types) };
        if (args.includes("text/uri-list")) return { code: 0, stdout: Buffer.from(uri) };
        return { code: 1, stdout: Buffer.alloc(0) };
      };
    expect(
      await readClipboardAttachments({
        platform: "linux",
        dir: "/tmp",
        run: run("text/uri-list\ntext/plain", "file:///tmp/x%20y.png\n"),
      })
    ).toEqual(["/tmp/x y.png"]);
    expect(
      await readClipboardAttachments({ platform: "linux", dir: "/tmp", run: run("text/plain\n") })
    ).toEqual([]);
  });
});

describe("privateTempDir", () => {
  const base = () => fs.mkdtempSync(path.join(os.tmpdir(), "kai-td-"));

  it("makes a per-user folder under the base", () => {
    const b = base();
    const dir = privateTempDir("kai-paste", { base: b, platform: "win32", uid: null });
    expect(dir).toBe(path.join(b, "kai-paste"));
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    fs.rmSync(b, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("reuses its own private folder", () => {
    const b = base();
    const uid = process.getuid!();
    const first = privateTempDir("kai-paste", { base: b, uid });
    expect(first).toBe(path.join(b, `kai-paste-${uid}`));
    expect(privateTempDir("kai-paste", { base: b, uid })).toBe(first);
    fs.rmSync(b, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "does not use a folder other people can enter, or a symlink",
    () => {
      const b = base();
      const uid = process.getuid!();
      const planted = path.join(b, `kai-paste-${uid}`);
      fs.mkdirSync(planted, { mode: 0o777 });
      fs.chmodSync(planted, 0o777);
      const dir = privateTempDir("kai-paste", { base: b, uid });
      expect(dir).not.toBe(planted);
      expect(fs.statSync(dir).mode & 0o077).toBe(0);

      const b2 = base();
      const target = path.join(b2, "victim");
      fs.mkdirSync(target, { mode: 0o700 });
      fs.symlinkSync(target, path.join(b2, `kai-paste-${uid}`));
      const dir2 = privateTempDir("kai-paste", { base: b2, uid });
      expect(fs.realpathSync(dir2)).not.toBe(fs.realpathSync(target));
      fs.rmSync(b, { recursive: true, force: true });
      fs.rmSync(b2, { recursive: true, force: true });
    }
  );
});

describe("InputParser focus reporting", () => {
  it("reports the window gaining and losing focus, and keeps parsing around it", () => {
    const p = new InputParser();
    expect(p.feed("\u001b[I")).toEqual([{ type: "focus", focused: true }]);
    expect(p.feed("\u001b[O")).toEqual([{ type: "focus", focused: false }]);
    expect(p.feed("a\u001b[Ib")).toEqual([
      { type: "text", text: "a" },
      { type: "focus", focused: true },
      { type: "text", text: "b" },
    ]);
  });
});
