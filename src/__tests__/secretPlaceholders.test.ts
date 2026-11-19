import { describe, expect, it } from "vitest";
import { isPlaceholderSecret, isSensitiveContent } from "../core/indexer";

// Values are assembled at runtime so secret scanners do not flag this file.
const j = (...parts: string[]) => parts.join("");

describe("obvious placeholder keys do not hide a file", () => {
  it("accepts documented example keys and fixtures", () => {
    // AWS's own documentation key.
    expect(isSensitiveContent(j("aws_access_key_id = ", "AKIA", "IOSFODNN7EXAMPLE"))).toBe(false);
    expect(isSensitiveContent(j("GITHUB_TOKEN=", "ghp_", "x".repeat(36)))).toBe(false);
    expect(isSensitiveContent(j("token: ", "ghp_", "abcdefghijklmnopqrstuvwxyz123456"))).toBe(
      false
    );
    expect(isSensitiveContent(j("SLACK=", "xox", "b-123456789-abcdef"))).toBe(false);
    expect(isSensitiveContent(j("key = ", "sk-ant-", "api03-REDACTED-REDACTED-REDACTED"))).toBe(
      false
    );
    expect(
      isSensitiveContent(j("OPENAI_API_KEY=", "sk-", "your-key-placeholder-0000000000000000"))
    ).toBe(false);
    const fakePem = j(
      "-----",
      "BEGIN ",
      "RSA ",
      "PRIVATE KEY-----\nEXAMPLEKEYBODY\n-----",
      "END RSA PRIVATE KEY-----"
    );
    expect(isSensitiveContent(fakePem)).toBe(false);
  });

  it("still rejects real-looking keys, even next to a placeholder", () => {
    const real = j("AKIA", "Q7RZ2M4KXW9T3BNP");
    expect(isSensitiveContent(real)).toBe(true);
    expect(isSensitiveContent(j("AKIA", "IOSFODNN7EXAMPLE\n", real))).toBe(true);
    expect(isSensitiveContent(j("ghp_", "Qm7Xk2PzR9vLw4Tn8BcY3hJ6dF1gS5aE"))).toBe(true);
    const realPem = j("-----", "BEGIN ", "PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n");
    expect(isSensitiveContent(realPem)).toBe(true);
  });

  it("judges only the value, never the variable name in front of it", () => {
    // "EXAMPLE" in the name must not excuse a real key.
    expect(isSensitiveContent(j("EXAMPLE_KEY=", "AKIA", "Q7RZ2M4KXW9T3BNP"))).toBe(true);
    expect(
      isSensitiveContent(j("example_token = ", "ghp_", "Qm7Xk2PzR9vLw4Tn8BcY3hJ6dF1gS5aE"))
    ).toBe(true);
  });

  it("the AWS secret key setting name still always counts", () => {
    expect(isSensitiveContent(j("aws_secret_", "access_key = EXAMPLE"))).toBe(true);
  });

  it("recognizes the placeholder markers", () => {
    expect(isPlaceholderSecret("IOSFODNN7EXAMPLE")).toBe(true);
    expect(isPlaceholderSecret("xxxxxxxxxxxx")).toBe(true);
    expect(isPlaceholderSecret("Qm7Xk2PzR9vLw4Tn8BcY3")).toBe(false);
  });
});
