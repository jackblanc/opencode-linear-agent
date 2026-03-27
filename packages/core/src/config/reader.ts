import { existsSync, readFileSync } from "node:fs";
import { getConfigPath } from "../utils/paths";
import { configFileSchema, type ApplicationConfig } from "./schema";
import { resolve } from "node:path";
import { homedir } from "node:os";

function normalizeProjectsPath(projectsPath: string) {
  if (!projectsPath.startsWith("~/")) {
    return projectsPath;
  }
  return resolve(homedir(), projectsPath.slice(2));
}

export function loadApplicationConfig(
  path: string = getConfigPath(),
): ApplicationConfig {
  if (!existsSync(path)) {
    throw new Error(
      `Config file not found at ${path}. Please create a config file with the necessary configuration values.`,
    );
  }

  const stringFileContents = readFileSync(path, "utf-8");

  let jsonFileContents: object | undefined;
  try {
    jsonFileContents = JSON.parse(stringFileContents);
  } catch (err) {
    throw new Error(`Failed to parse config file at ${path}`, {
      cause: err,
    });
  }

  const result = configFileSchema.safeParse(jsonFileContents);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  return {
    ...result.data,
    projectsPath: normalizeProjectsPath(result.data.projectsPath),
  };
}
