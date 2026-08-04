import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export type JournalOutcome = "started" | "pending" | "verified" | "failed" | "unknown" | "complete";

export interface JournalEntry {
  timestamp: string;
  planId: string;
  outcome: JournalOutcome;
  target?: string;
  frameHex?: string;
  detail?: string;
}

export async function appendJournal(path: string, entry: Omit<JournalEntry, "timestamp">): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const record: JournalEntry = { timestamp: new Date().toISOString(), ...entry };
  await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
}

export async function assertPlanNotConsumed(path: string, planId: string): Promise<void> {
  try {
    const records = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JournalEntry);
    if (records.some((entry) => entry.planId === planId && entry.outcome === "complete")) {
      throw new Error(`Patch plan ${planId} has already been consumed`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
