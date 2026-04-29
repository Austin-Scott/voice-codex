import fs from "node:fs";
import path from "node:path";
import type { DirectoryListing } from "../shared/protocol.js";

export function resolveWorkspaceRoot(root: string): string {
  return path.resolve(root);
}

export function resolveWithinRoot(root: string, target?: string): string {
  const resolvedRoot = resolveWorkspaceRoot(root);
  const resolvedTarget = path.resolve(resolvedRoot, target || ".");
  if (!isWithinRoot(resolvedRoot, resolvedTarget)) {
    throw new Error("Path is outside the configured workspace root");
  }
  return resolvedTarget;
}

export function assertExistingDirectory(root: string, target: string): string {
  const resolved = resolveWithinRoot(root, target);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error("Working directory does not exist");
  }
  return resolved;
}

export function listDirectories(root: string, target?: string): DirectoryListing {
  const resolvedRoot = resolveWorkspaceRoot(root);
  const current = assertExistingDirectory(resolvedRoot, target || resolvedRoot);
  const entries = fs
    .readdirSync(current, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(current, entry.name)
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    root: resolvedRoot,
    current,
    parent: current === resolvedRoot ? undefined : path.dirname(current),
    entries
  };
}

export function createDirectory(root: string, parentPath: string, name: string): DirectoryListing {
  const parent = assertExistingDirectory(root, parentPath);
  const cleanName = name.trim();
  if (!cleanName || cleanName.includes("/") || cleanName.includes("\\") || cleanName === "." || cleanName === "..") {
    throw new Error("Directory name must be a single folder name");
  }

  const target = resolveWithinRoot(root, path.join(parent, cleanName));
  fs.mkdirSync(target);
  return listDirectories(root, target);
}

function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
