#!/usr/bin/env node
// A stand-in for `claude -p --output-format stream-json`: reads the prompt on stdin and prints
// the same kind of JSON lines the real CLI does. Special prompts: SLOW (waits until stopped),
// FAIL (exits non-zero), DELAY (a short pause before answering).
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
if (process.argv.includes("--version")) {
  console.log("fake-agent 1.0.0");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const finish = () => {
    out({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.01,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
      },
    });
  };
  if (input.includes("FAIL")) {
    console.error("fake agent exploded");
    process.exit(3);
  }
  out({
    type: "system",
    subtype: "init",
    session_id: "11111111-1111-1111-1111-111111111111",
    model: "fake",
  });
  const m = process.argv.indexOf("--model");
  const model = m >= 0 ? ` [model=${process.argv[m + 1]}]` : "";
  out({
    type: "assistant",
    message: { content: [{ type: "text", text: "echo: " + input.trim() + model }] },
  });
  if (input.includes("SLOW")) return void setTimeout(finish, 60000);
  if (input.includes("DELAY")) return void setTimeout(finish, 400);
  finish();
});
