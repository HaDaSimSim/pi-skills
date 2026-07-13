// Persona discovery for primary agents — bundled/user/project markdown presets.
//
// Adapted from subagents/agents.ts with separate discovery directories to keep
// primary personas (builder/planner/unspecified) independent from subagent presets.
//
// Discovery dirs (precedence: bundled < user < project):
//   bundled  — next to this file: agents/*.md
//   user     — ~/.pi/agent/primary-agents/*.md
//   project  — .ohpi/primary-agents/*.md  (walked up from cwd)
//
// Each persona is a markdown file with YAML frontmatter (name, description,
// tools, default, model) + body (system prompt). The "default" field selects
// the active persona for fresh sessions.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type PersonaScope = "user" | "project" | "both";

export interface PersonaConfig {
  name: string;
  description: string;
  tools?: string[];
  default?: boolean;
  model?: string;
  systemPrompt: string;
  source: "user" | "project" | "bundled";
  filePath: string;
}

export interface PersonaDiscoveryResult {
  personas: PersonaConfig[];
  projectPersonasDir: string | null;
  defaultPersona: PersonaConfig | undefined;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadPersonasFromDir(dir: string, source: "user" | "project" | "bundled"): PersonaConfig[] {
  const personas: PersonaConfig[] = [];
  if (!fs.existsSync(dir)) return personas;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return personas;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
    const name = typeof frontmatter.name === "string" ? frontmatter.name : "";
    const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
    if (!name || !description) continue;

    const tools =
      typeof frontmatter.tools === "string"
        ? frontmatter.tools
            .split(",")
            .map((t: string) => t.trim())
            .filter(Boolean)
        : undefined;

    // YAML may parse `default: true` as boolean or string — accept both.
    const isDefault =
      frontmatter.default === true ||
      frontmatter.default === "true" ||
      frontmatter.default === "True";

    const model = typeof frontmatter.model === "string" ? frontmatter.model : undefined;

    personas.push({
      name,
      description,
      tools: tools && tools.length > 0 ? tools : undefined,
      default: isDefault || undefined,
      model,
      systemPrompt: body,
      source,
      filePath,
    });
  }
  return personas;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

import { findOhpiRoot, ohpiSubdir } from "./shared/ohpi-paths.ts";

/**
 * Resolve the project-scoped primary-agents dir using the shared .ohpi/ path
 * helper (task 31). Walks up from cwd to find an existing .ohpi/ root, then
 * returns `.ohpi/primary-agents/` beneath it. Returns null if no .ohpi/ exists.
 */
function findNearestProjectPersonasDir(cwd: string): string | null {
  const root = findOhpiRoot(cwd);
  if (!root) return null;
  return ohpiSubdir(root, "primaryAgents");
}

// ── Discovery ────────────────────────────────────────────────────────────────

export function discoverPersonas(cwd: string, scope: PersonaScope): PersonaDiscoveryResult {
  const userDir = path.join(getAgentDir(), "primary-agents");
  const projectPersonasDir = findNearestProjectPersonasDir(cwd);
  const bundledDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");

  const bundledPersonas = loadPersonasFromDir(bundledDir, "bundled");
  const userPersonas = scope === "project" ? [] : loadPersonasFromDir(userDir, "user");
  const projectPersonas =
    scope === "user" || !projectPersonasDir
      ? []
      : loadPersonasFromDir(projectPersonasDir, "project");

  // Override priority: bundled → user → project. Later entries with the same
  // name win (project overrides user overrides bundled).
  const personaMap = new Map<string, PersonaConfig>();
  for (const p of bundledPersonas) personaMap.set(p.name, p);
  if (scope === "both") {
    for (const p of userPersonas) personaMap.set(p.name, p);
    for (const p of projectPersonas) personaMap.set(p.name, p);
  } else if (scope === "user") {
    for (const p of userPersonas) personaMap.set(p.name, p);
  } else if (scope === "project") {
    for (const p of projectPersonas) personaMap.set(p.name, p);
  }

  const personas = Array.from(personaMap.values());

  // The default persona is the one with `default: true`. If multiple are
  // marked default (shouldn't happen), the first wins (map insertion order).
  const defaultPersona = personas.find((p) => p.default === true);

  return { personas, projectPersonasDir, defaultPersona };
}

export function formatPersonaList(
  personas: PersonaConfig[],
  maxItems: number,
): { text: string; remaining: number } {
  if (personas.length === 0) return { text: "none", remaining: 0 };
  const listed = personas.slice(0, maxItems);
  const remaining = personas.length - listed.length;
  return {
    text: listed.map((p) => `${p.name} (${p.source}): ${p.description}`).join("; "),
    remaining,
  };
}
