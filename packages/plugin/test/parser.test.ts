import { describe, test, expect } from "bun:test";
import { parseFrontmatter } from "../src/parser";

describe("parseFrontmatter", () => {
  test("should parse valid frontmatter with all fields", () => {
    const text = `---
linear_session: ses_abc123
linear_issue: CODE-42
linear_organization: org_xyz
workdir: /path/to/workdir
---
This is the actual message content.`;

    const result = parseFrontmatter(text);

    expect(result.context).toEqual({
      sessionId: "ses_abc123",
      issueId: "CODE-42",
      organizationId: "org_xyz",
      workdir: "/path/to/workdir",
    });
    expect(result.text).toBe(text);
  });

  test("should parse frontmatter with optional sessionId missing", () => {
    const text = `---
linear_issue: CODE-42
linear_organization: org_xyz
workdir: /path/to/workdir
---
Message content here.`;

    const result = parseFrontmatter(text);

    expect(result.context).toEqual({
      sessionId: null,
      issueId: "CODE-42",
      organizationId: "org_xyz",
      workdir: "/path/to/workdir",
    });
  });

  test("should return null context when required field 'linear_issue' is missing", () => {
    const text = `---
linear_session: ses_abc123
linear_organization: org_xyz
workdir: /path/to/workdir
---
Message content.`;

    const result = parseFrontmatter(text);

    expect(result.context).toBeNull();
    expect(result.text).toBe(text);
  });

  test("should return null context when required field 'linear_organization' is missing", () => {
    const text = `---
linear_session: ses_abc123
linear_issue: CODE-42
workdir: /path/to/workdir
---
Message content.`;

    const result = parseFrontmatter(text);

    expect(result.context).toBeNull();
  });

  test("should return null context when required field 'workdir' is missing", () => {
    const text = `---
linear_session: ses_abc123
linear_issue: CODE-42
linear_organization: org_xyz
---
Message content.`;

    const result = parseFrontmatter(text);

    expect(result.context).toBeNull();
  });

  test("should handle malformed YAML gracefully", () => {
    const text = `---
linear_session: [invalid yaml
linear_issue: CODE-42
---
Message content.`;

    const result = parseFrontmatter(text);

    expect(result.context).toBeNull();
    expect(result.text).toBe(text);
  });

  test("should return null context when no frontmatter present", () => {
    const text = "This is just a regular message without frontmatter.";

    const result = parseFrontmatter(text);

    expect(result.context).toBeNull();
    expect(result.text).toBe(text);
  });

  test("should return null context when frontmatter is not at start", () => {
    const text = `Some text before
---
linear_session: ses_abc123
linear_issue: CODE-42
linear_organization: org_xyz
workdir: /path/to/workdir
---
Message content.`;

    const result = parseFrontmatter(text);

    expect(result.context).toBeNull();
    expect(result.text).toBe(text);
  });

  test("should handle empty frontmatter", () => {
    const text = `---
---
Message content.`;

    const result = parseFrontmatter(text);

    expect(result.context).toBeNull();
    expect(result.text).toBe(text);
  });

  test("should handle frontmatter with extra fields", () => {
    const text = `---
linear_session: ses_abc123
linear_issue: CODE-42
linear_organization: org_xyz
workdir: /path/to/workdir
extra_field: some_value
another_field: 123
---
Message content.`;

    const result = parseFrontmatter(text);

    expect(result.context).toEqual({
      sessionId: "ses_abc123",
      issueId: "CODE-42",
      organizationId: "org_xyz",
      workdir: "/path/to/workdir",
    });
  });

  test("should handle numeric values for required string fields", () => {
    const text = `---
linear_session: 123
linear_issue: 456
linear_organization: 789
workdir: 202
---
Message content.`;

    const result = parseFrontmatter(text);

    // YAML parses these as numbers, not strings, so validation should fail
    expect(result.context).toBeNull();
  });

  test("should handle multiline content after frontmatter", () => {
    const text = `---
linear_session: ses_abc123
linear_issue: CODE-42
linear_organization: org_xyz
workdir: /path/to/workdir
---
Line 1
Line 2
Line 3`;

    const result = parseFrontmatter(text);

    expect(result.context).not.toBeNull();
    expect(result.text).toBe(text);
  });

  test("should handle frontmatter with quoted strings", () => {
    const text = `---
linear_session: "ses_abc123"
linear_issue: "CODE-42"
linear_organization: "org_xyz"
workdir: "/path/to/workdir"
---
Message content.`;

    const result = parseFrontmatter(text);

    expect(result.context).toEqual({
      sessionId: "ses_abc123",
      issueId: "CODE-42",
      organizationId: "org_xyz",
      workdir: "/path/to/workdir",
    });
  });

  test("should handle frontmatter with special characters in values", () => {
    const text = `---
linear_session: ses_abc-123_def
linear_issue: CODE-42
linear_organization: org_xyz-test
workdir: /path/to/work-dir
---
Message content.`;

    const result = parseFrontmatter(text);

    expect(result.context).toEqual({
      sessionId: "ses_abc-123_def",
      issueId: "CODE-42",
      organizationId: "org_xyz-test",
      workdir: "/path/to/work-dir",
    });
  });

  test("should return original text unchanged in all cases", () => {
    const texts = [
      "No frontmatter",
      `---
linear_issue: CODE-42
---
With partial frontmatter`,
      `---
linear_session: ses_abc123
linear_issue: CODE-42
linear_organization: org_xyz
workdir: /path/to/workdir
---
Valid frontmatter`,
    ];

    for (const text of texts) {
      const result = parseFrontmatter(text);
      expect(result.text).toBe(text);
    }
  });
});
