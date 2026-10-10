import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppleNotesManager } from "../services/appleNotesManager.js";
import {
  readRichNote,
  enrichNoteRead,
  richContentHash,
  type RichNote,
} from "../utils/noteRichText.js";
import { CodedError, errorResult } from "../utils/errorCodes.js";
import { exactIdInput, NOTE_ID_MESSAGE } from "../utils/noteIdentifiers.js";
import { decodeMessage } from "../utils/protobuf.js";
const moduleDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(moduleDir, basename(moduleDir) === "tools" ? "../.." : "..");
const worker = resolve(root, "native/checklist/worker.py");
const library = resolve(root, "native/checklist/libnotes-checklist.dylib");
export function checklistRuntimeReady() {
  return !!process.env.APPLE_NOTES_MCP_AX_PYTHON && existsSync(worker) && existsSync(library);
}
function fail(
  code:
    | "revision_conflict"
    | "ambiguous"
    | "unsupported"
    | "verification_failed"
    | "timeout_indeterminate",
  message: string,
  uncertain = false
): never {
  throw new CodedError(message, {
    code,
    committed: uncertain ? undefined : false,
    indeterminate: uncertain,
  });
}
export function targetItem(rich: RichNote, index: number, text: string) {
  const items = [...(rich.checklistItems || [])].sort((a, b) => a.start - b.start);
  const item = items[index];
  if (!item || item.text !== text || items.filter((i) => i.text === text).length !== 1)
    fail("ambiguous", "Exact checklist text and index do not uniquely match");
  if (rich.text.slice(item.start).split("\n")[0] !== text)
    fail("unsupported", "Checklist paragraph is not a single exact line");
  return { item, items };
}
// Remove only the checklist done bit from paragraph signatures. Everything
// else, including item identities, formatting and native objects, must match.
function styles(rich: RichNote) {
  return rich.styleRuns?.map((run) => ({
    ...run,
    signature: JSON.stringify(
      (JSON.parse(run.signature) as [number, unknown][]).map(([n, v]) => {
        if (n !== 2 || typeof v !== "string") return [n, v];
        return [
          n,
          decodeMessage(Buffer.from(v, "hex"), { keepFixed: true }).map((f) => [
            f.fieldNumber,
            f.fieldNumber === 5 && f.value instanceof Uint8Array
              ? decodeMessage(f.value, { keepFixed: true })
                  .filter((c) => c.fieldNumber !== 2)
                  .map((c) => [
                    c.fieldNumber,
                    c.value instanceof Uint8Array ? Buffer.from(c.value).toString("hex") : c.value,
                  ])
              : f.value instanceof Uint8Array
                ? Buffer.from(f.value).toString("hex")
                : f.value,
          ]),
        ];
      })
    ),
  }));
}
export function assertTickPreserved(
  before: RichNote,
  after: RichNote,
  targetId: string,
  done: boolean
) {
  for (const key of [
    "text",
    "links",
    "nativeTags",
    "nativeObjectIds",
    "objects",
    "objectData",
  ] as const)
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      fail("verification_failed", `Collateral change in ${key}`, true);
  if (JSON.stringify(styles(before)) !== JSON.stringify(styles(after)))
    fail("verification_failed", "Collateral formatting change", true);
  const expected = before.checklistItems?.map((i) => ({
    ...i,
    done: i.id === targetId ? done : i.done,
  }));
  if (JSON.stringify(expected) !== JSON.stringify(after.checklistItems))
    fail("verification_failed", "Only target checklist state may change", true);
}
let busy = false;
export async function setChecklistItem(
  manager: AppleNotesManager,
  args: {
    id: string;
    expectedContentHash: string;
    index: number;
    text: string;
    checked: boolean;
    dryRun?: boolean;
  }
) {
  if (busy) fail("unsupported", "Another checklist tick is running");
  busy = true;
  const lock = resolve(homedir(), ".hermes/apple-notes-checklist-operation.lock");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    busy = false;
    fail("unsupported", "Another checklist tick is running or operation lock unavailable");
  }
  try {
    const note = manager.getNoteById(args.id);
    if (!note || note.passwordProtected) fail("unsupported", "Missing or locked note");
    const body = manager.getNoteContentById(args.id);
    if (body === null) fail("unsupported", "Note unavailable");
    const enriched = enrichNoteRead(args.id, body);
    const before = readRichNote(args.id);
    if (
      enriched.revision !== before.revision ||
      richContentHash(body, enriched) !== args.expectedContentHash
    )
      fail("revision_conflict", "Read fresh contentHash before ticking");
    const { item } = targetItem(before, args.index, args.text);
    if (item.done === args.checked && !args.dryRun)
      return {
        ok: true,
        changed: false,
        checked: item.done,
        contentHash: args.expectedContentHash,
      };
    if (!checklistRuntimeReady())
      fail(
        "unsupported",
        "Configure APPLE_NOTES_MCP_AX_PYTHON with Hermes Python and build native/checklist/toggle.swift"
      );
    let response: { ok: boolean; reason?: string; error?: string };
    try {
      response = JSON.parse(
        execFileSync(process.env.APPLE_NOTES_MCP_AX_PYTHON!, [worker, library], {
          input: JSON.stringify({
            id: args.id,
            title: note.title,
            text: before.text,
            item: args.text,
            start: item.start,
            dryRun: args.dryRun,
          }),
          encoding: "utf8",
          stdio: ["pipe", "pipe", "inherit"],
          timeout: 5000,
          maxBuffer: 65536,
        })
      );
    } catch {
      fail(
        "timeout_indeterminate",
        "Checklist worker failed or timed out; read before retrying",
        true
      );
    }
    if (!response.ok) {
      if (response.reason === "accessibility" || response.reason === "busy")
        throw new CodedError(response.error || response.reason, {
          code: response.reason === "accessibility" ? "permission_denied" : "unsupported",
          reason: response.reason,
          committed: false,
          indeterminate: false,
        });
      fail("unsupported", response.error || response.reason || "AX refused");
    }
    if (args.dryRun) return { ok: true, dryRun: true, index: args.index, checked: item.done };
    const deadline = Date.now() + 2000;
    do {
      const after = readRichNote(args.id);
      const actual = after.checklistItems?.find((i) => i.id === item.id);
      if (actual?.done === args.checked) {
        assertTickPreserved(before, after, item.id, args.checked);
        const afterBody = manager.getNoteContentById(args.id);
        if (afterBody === null) fail("verification_failed", "Readback unavailable", true);
        const read = enrichNoteRead(args.id, afterBody);
        if (read.revision !== after.revision)
          fail("verification_failed", "Concurrent change after verification", true);
        return {
          ok: true,
          changed: true,
          index: args.index,
          checked: args.checked,
          contentHash: richContentHash(afterBody, read),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    fail(
      "verification_failed",
      "Requested checklist state did not verify; read before retrying",
      true
    );
  } finally {
    rmdirSync(lock);
    busy = false;
  }
}
export function registerChecklistToggle(server: McpServer, manager: AppleNotesManager) {
  const input = {
    id: exactIdInput("ICNote", /^x-coredata:\/\/[0-9a-f-]+\/ICNote\/p\d+$/i, NOTE_ID_MESSAGE),
    expectedContentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    index: z.number().int().nonnegative(),
    text: z
      .string()
      .min(1)
      .max(10000)
      .refine((s) => !/[\r\n\0]/u.test(s)),
    checked: z.boolean(),
    dryRun: z.boolean().optional(),
  };
  server.registerTool(
    "set-checklist-item",
    {
      description:
        "Check/uncheck one existing native checklist item by exact note ID, zero-based checklist index and exact unique text. Fresh contentHash required. Preserves text, formatting, native identities, tags and other checked states. Uses existing Hermes Python Accessibility identity; foreground UI required. dryRun only locates. Never retry uncertain outcomes without rereading.",
      inputSchema: input,
      outputSchema: z.object({}).passthrough(),
    },
    (async (args: z.infer<z.ZodObject<typeof input>>) => {
      try {
        const result = await setChecklistItem(manager, args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error), error);
      }
    }) as unknown as ToolCallback<typeof input>
  );
}
