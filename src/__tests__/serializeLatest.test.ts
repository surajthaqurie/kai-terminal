import { describe, expect, it } from "vitest";
import { serializeLatest } from "../components/terminalFit";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("serializeLatest (PTY resize ordering)", () => {
  it("sends one at a time and only the newest pending call", async () => {
    const sent: number[] = [];
    const resolvers: Array<() => void> = [];
    const send = serializeLatest((n: number) => {
      sent.push(n);
      return new Promise<void>((r) => resolvers.push(r));
    });

    send(1);
    send(2);
    send(3); // replaces 2 while 1 is in flight
    expect(sent).toEqual([1]);

    resolvers[0]();
    await flush();
    expect(sent).toEqual([1, 3]);

    resolvers[1]();
    await flush();
    send(4);
    expect(sent).toEqual([1, 3, 4]);
  });

  it("keeps going after a failed or throwing send", async () => {
    const sent: number[] = [];
    let first = true;
    const send = serializeLatest((n: number) => {
      sent.push(n);
      if (first) {
        first = false;
        throw new Error("gone");
      }
      return Promise.reject(new Error("gone"));
    });
    send(1);
    send(2);
    await flush();
    await flush();
    expect(sent).toEqual([1, 2]);
    send(3);
    await flush();
    expect(sent).toEqual([1, 2, 3]);
  });
});
