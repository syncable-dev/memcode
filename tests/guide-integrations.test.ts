import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { integrationScenes } from "../src/components/IntegrationGuidePreviews";
import { guideArticles, guideIntegrations } from "../src/guide-content";

const inGroup = guideArticles.filter((item) => item.group === "Integrations");

test("every page of the Integrations group belongs to a tool, and every tool has its logo and pages", () => {
  for (const { id, name } of guideIntegrations) {
    assert.ok(existsSync(`public/integrations/${id}.svg`), `${name} has no logo`);
    assert.ok(
      inGroup.some((item) => item.integration === id),
      `${name} has no pages`,
    );
  }
  for (const item of inGroup) {
    assert.ok(item.integration, `${item.id} belongs to no tool`);
    assert.ok(integrationScenes[item.id], `${item.id} has no illustration`);
  }
  assert.ok(
    guideArticles.every((item) => !item.integration || item.group === "Integrations"),
  );
});
