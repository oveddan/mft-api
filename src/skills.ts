import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Serves the agent skill over MCP per the Skills Extension (SEP-2640,
// io.modelcontextprotocol/skills): every file of the skill directory is a
// `skill://<name>/<path>` resource, and `skills/list` / `skills/get` return a
// manifest carrying each file's digest and size.
//
// The skill directory shipped in the npm package is the single source. The
// server reads it once at startup, so the digests it publishes always describe
// the exact bytes it serves.

export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";

/** `skills/` at the package root. Resolves the same from `src/` and `dist/`. */
export const DEFAULT_SKILLS_ROOT = fileURLToPath(new URL("../skills/", import.meta.url));

export interface SkillFile {
  uri: string;
  path: string;
  mimeType: string;
  text: string;
  digest: string;
  size: number;
}

export interface Skill {
  uri: string;
  frontmatter: { name: string; description: string; [key: string]: unknown };
  files: SkillFile[];
}

/** The `Skill` entry shape that `skills/list` and `skills/get` return. */
export function skillEntry(skill: Skill): { uri: string; frontmatter: Skill["frontmatter"]; resources: Array<{ uri: string; digest: string; size: number }> } {
  return {
    uri: skill.uri,
    frontmatter: skill.frontmatter,
    resources: skill.files.map(({ uri, digest, size }) => ({ uri, digest, size })),
  };
}

const MIME_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".json": "application/json",
};

/**
 * Parses the flat `key: value` frontmatter this project's skills use.
 *
 * The extension requires the frontmatter to be returned verbatim, so anything
 * this parser does not understand is refused rather than approximated — a
 * nested key silently dropped here would be a manifest that misdescribes the
 * file it points at.
 */
export function parseFrontmatter(markdown: string): Skill["frontmatter"] {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) throw new Error("SKILL.md must begin with YAML frontmatter");
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const field = /^([A-Za-z][\w-]*):\s+(.+)$/.exec(line);
    if (!field) throw new Error(`Unsupported SKILL.md frontmatter line: ${line}`);
    const value = field[2]!.trim();
    if (/^["'[{|>&*!]/.test(value)) throw new Error(`Unsupported SKILL.md frontmatter value for ${field[1]}`);
    fields[field[1]!] = value;
  }
  if (!fields.name || !fields.description) throw new Error("SKILL.md frontmatter requires name and description");
  return fields as Skill["frontmatter"];
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : Promise.resolve(entry.isFile() ? [path] : []);
    }),
  );
  return nested.flat().sort();
}

export async function loadSkill(directory: string): Promise<Skill> {
  const markdown = await readFile(join(directory, "SKILL.md"), "utf8");
  const frontmatter = parseFrontmatter(markdown);
  const base = `skill://${frontmatter.name}`;
  const files = await Promise.all(
    (await listFiles(directory)).map(async (absolute): Promise<SkillFile> => {
      const bytes = await readFile(absolute);
      const path = relative(directory, absolute).split(sep).join("/");
      return {
        uri: `${base}/${path}`,
        path,
        mimeType: MIME_TYPES[extname(path)] ?? "text/plain",
        text: bytes.toString("utf8"),
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        size: bytes.length,
      };
    }),
  );
  return { uri: `${base}/SKILL.md`, frontmatter, files };
}

/** Every immediate subdirectory of `root` that contains a SKILL.md is a skill. */
export async function loadSkills(root: string = DEFAULT_SKILLS_ROOT): Promise<Skill[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const skills: Skill[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const skill = await loadSkill(join(root, entry.name));
    // The spec requires the URI's final segment to equal the skill name, and
    // Agent Skills requires the name to equal the directory name.
    if (skill.frontmatter.name !== entry.name) {
      throw new Error(`Skill directory ${entry.name} declares name ${skill.frontmatter.name}`);
    }
    skills.push(skill);
  }
  return skills;
}
