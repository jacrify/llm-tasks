import { describe, it, expect } from "vitest";
import { Plugin } from "obsidian";

describe("scaffolding", () => {
  it("obsidian mock exports Plugin class", () => {
    expect(Plugin).toBeDefined();
    const plugin = new Plugin();
    expect(plugin).toBeInstanceOf(Plugin);
  });

  it("main.ts exports a Plugin subclass", async () => {
    const { default: LlmTasksPlugin } = await import("../src/main");
    expect(LlmTasksPlugin.prototype).toBeInstanceOf(Object);
    const instance = new LlmTasksPlugin();
    expect(instance).toBeInstanceOf(Plugin);
  });
});
