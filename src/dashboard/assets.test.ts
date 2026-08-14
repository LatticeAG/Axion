import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dashboardDir = dirname(fileURLToPath((import.meta as { url: string }).url));

describe("dashboard assets", () => {
  it("does not load React from unpkg and does not use origin-root /app.js", () => {
    const html = readFileSync(join(dashboardDir, "index.html"), "utf8");
    expect(html).not.toContain("unpkg.com");
    expect(html).not.toMatch(/["']\/app\.js["']/);
    expect(html).not.toMatch(/["']\/styles\.css["']/);
    expect(html).toContain('src="app.js"');
    expect(html).toContain('href="styles.css"');
    expect(html).toContain("vendor/react.production.min.js");
    expect(html).toContain("vendor/react-dom.production.min.js");
  });
});
