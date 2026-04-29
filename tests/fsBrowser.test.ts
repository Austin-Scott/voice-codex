import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertExistingDirectory, createDirectory, listDirectories } from "../src/server/fsBrowser";

const root = path.join(process.cwd(), "runtime", "fs-browser-test");

beforeEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "alpha"), { recursive: true });
  fs.mkdirSync(path.join(root, "beta"), { recursive: true });
  fs.writeFileSync(path.join(root, "file.txt"), "not a directory");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("fsBrowser", () => {
  it("lists only child directories under the root", () => {
    const listing = listDirectories(root);

    expect(listing.root).toBe(path.resolve(root));
    expect(listing.current).toBe(path.resolve(root));
    expect(listing.parent).toBeUndefined();
    expect(listing.entries.map((entry) => entry.name)).toEqual(["alpha", "beta"]);
  });

  it("creates a child directory and returns its listing", () => {
    const listing = createDirectory(root, root, "gamma");

    expect(listing.current).toBe(path.join(root, "gamma"));
    expect(fs.statSync(path.join(root, "gamma")).isDirectory()).toBe(true);
  });

  it("rejects paths outside the root", () => {
    expect(() => assertExistingDirectory(root, path.dirname(root))).toThrow(
      "Path is outside the configured workspace root"
    );
  });

  it("rejects nested names for directory creation", () => {
    expect(() => createDirectory(root, root, "bad/name")).toThrow(
      "Directory name must be a single folder name"
    );
  });
});
