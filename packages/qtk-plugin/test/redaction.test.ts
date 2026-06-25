import { describe, expect, test } from "bun:test";
import { redactModelText, redactSecrets } from "../src/redaction.ts";

describe("model-facing secret redaction", () => {
  test("redacts AWS keys", () => {
    const result = redactSecrets("AKIAIOSFODNN7EXAMPLE");
    expect(result.text).toBe("[REDACTED_SECRET_VALUE]");
    expect(result.count).toBe(1);
  });

  test("redacts GitHub and AI provider tokens", () => {
    const input = [
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef12",
      "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef12_12345",
      "sk-ant-abcdefghijklmnopqrstuvwxyz1234567890",
      "sk-abcdefghijklmnopqrstuvwxyz1234567890",
    ].join("\n");

    const result = redactSecrets(input);

    expect(result.count).toBe(4);
    expect(result.text).not.toContain("ghp_");
    expect(result.text).not.toContain("github_pat_");
    expect(result.text).not.toContain("sk-ant-");
    expect(result.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  test("redacts bearer tokens and secret assignments", () => {
    const input = [
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789abcdef",
      'DATABASE_PASSWORD="correct-horse-battery-staple"',
      "AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    ].join("\n");

    const result = redactSecrets(input);

    expect(result.count).toBe(3);
    expect(result.text).not.toContain("Bearer abcdef");
    expect(result.text).not.toContain("correct-horse");
    expect(result.text).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789ABCD");
  });

  test("redacts private key blocks", () => {
    const input = `before
-----BEGIN RSA PRIVATE KEY-----
super-secret-key-material
-----END RSA PRIVATE KEY-----
after`;

    const result = redactSecrets(input);

    expect(result.count).toBe(1);
    expect(result.text).toContain("before");
    expect(result.text).toContain("after");
    expect(result.text).not.toContain("PRIVATE KEY");
    expect(result.text).not.toContain("super-secret-key-material");
  });

  test("wraps redacted model text with metadata", () => {
    const result = redactModelText("token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef12");

    expect(result.count).toBe(1);
    expect(result.text).toContain('<qtk-redacted count=1 categories=["github-token"]>');
    expect(result.text).toContain("[REDACTED_SECRET_VALUE]");
    expect(result.text).toContain("</qtk-redacted>");
  });

  test("reports redaction categories", () => {
    const result = redactModelText([
      "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef12",
      'bearer_token="launchpad-token"',
    ].join("\n"));

    expect(result.count).toBe(2);
    expect(result.categories).toEqual(["github-token", "secret-literal"]);
    expect(result.text).toContain(
      '<qtk-redacted count=2 categories=["github-token","secret-literal"]>',
    );
  });

  test("leaves benign short strings and identifiers unchanged", () => {
    const input = "const apiKey = getConfig('api_key');\nsk-short";

    const result = redactSecrets(input);

    expect(result.count).toBe(0);
    expect(result.text).toBe(input);
  });

  test("does not redact common non-secret metadata fields", () => {
    const input = [
      'author: "Grace Hopper"',
      'authority = "https://example.test"',
      'tokenizer_type: "bpe_tokenizer_default"',
    ].join("\n");

    const result = redactSecrets(input);

    expect(result.count).toBe(0);
    expect(result.text).toBe(input);
  });

  test("still redacts authorization and token assignment fields", () => {
    const input = [
      'authorization="Basic dXNlcjpwYXNzMTIzNDU2"',
      "auth_token=abcdefghijklmnopqrstuvwxyz1234567890",
    ].join("\n");

    const result = redactSecrets(input);

    expect(result.count).toBe(2);
    expect(result.text).not.toContain("Basic dXNl");
    expect(result.text).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
  });

  test("preserves source identifiers while redacting fixture literal values", () => {
    const input = `mock_request.state.launchpad_auth = LaunchpadAuthContext(
    bearer_token="launchpad-token",
    account_id="acct_12345",
)`;

    const result = redactSecrets(input);

    expect(result.count).toBe(1);
    expect(result.text).toContain("mock_request.state.launchpad_auth");
    expect(result.text).toContain("LaunchpadAuthContext");
    expect(result.text).toContain('bearer_token="[REDACTED_SECRET_VALUE]"');
    expect(result.text).toContain('account_id="acct_12345"');
    expect(result.text).not.toContain("launchpad-token");
  });

  test("does not redact code identifier assignments", () => {
    const input = [
      "launchpad_auth = LaunchpadAuthContext",
      "auth_provider = request.state.launchpad_auth",
    ].join("\n");

    const result = redactSecrets(input);

    expect(result.count).toBe(0);
    expect(result.text).toBe(input);
  });
});
