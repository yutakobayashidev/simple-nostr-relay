import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@/database";
import Database from "better-sqlite3";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, describe, expect, it } from "vitest";

const PRUNE_MIGRATION = "0005_prune_replaced_versions";
const AUTHOR_A = "a".repeat(64);
const AUTHOR_B = "b".repeat(64);

describe(`migration ${PRUNE_MIGRATION}`, () => {
  const migrationsBefore = mkdtempSync(join(tmpdir(), "relay-migrations-"));
  afterAll(() => rmSync(migrationsBefore, { recursive: true, force: true }));

  it("keeps only the newest version of each replaceable and addressable event", async () => {
    // Build the database as it was before the prune migration, then seed it the way the old save logic did.
    cpSync("./drizzle", migrationsBefore, { recursive: true });
    const journalPath = join(migrationsBefore, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    journal.entries = journal.entries.filter((entry: { tag: string }) => entry.tag !== PRUNE_MIGRATION);
    writeFileSync(journalPath, JSON.stringify(journal));

    const db = drizzle(new Database(":memory:"), { schema });
    await migrate(db, { migrationsFolder: migrationsBefore });

    let tagSeq = 0;
    const seed = (
      id: string,
      kind: number,
      createdAt: number,
      replaced: boolean,
      { author = AUTHOR_A, d }: { author?: string; d?: string } = {},
    ) => {
      db.insert(schema.events)
        .values({
          id,
          kind,
          author,
          detegator: null,
          sig: "0".repeat(128),
          hidden: false,
          replaced,
          content: "",
          first_seen: new Date(0),
          created_at: new Date(createdAt * 1000),
          raw: { id },
        })
        .run();
      if (d !== undefined)
        db.insert(schema.tags)
          .values({ id: `tag-${tagSeq++}`, eventId: id, name: "d", value: d, rest: [] })
          .run();
    };

    // Addressable history: only the newest version survives, with its tags.
    seed("app-v1", 30078, 100, true, { d: "settings" });
    seed("app-v2", 30078, 200, true, { d: "settings" });
    seed("app-v3", 30078, 300, false, { d: "settings" });
    // The same author and kind with another d is a different address.
    seed("app-other", 30078, 50, false, { d: "other" });
    // Another author using the same d is a different address too.
    seed("app-b", 30078, 10, false, { author: AUTHOR_B, d: "settings" });
    // The old save logic flagged the newest version when an older one arrived later.
    seed("list-newest", 30003, 500, true, { d: "bookmarks" });
    seed("list-older", 30003, 400, false, { d: "bookmarks" });
    // Replaceable history keyed by author and kind.
    seed("profile-v1", 0, 10, true);
    seed("profile-v2", 0, 20, false);
    seed("profile-b", 0, 5, false, { author: AUTHOR_B });
    // On equal created_at the lowest id wins.
    seed("relays-b", 10002, 50, false);
    seed("relays-a", 10002, 50, true);
    // Regular events are never pruned.
    seed("note-1", 1, 1, false);
    seed("note-2", 1, 2, false);

    await migrate(db, { migrationsFolder: "./drizzle" });

    const events = db
      .select({ id: schema.events.id, replaced: schema.events.replaced })
      .from(schema.events)
      .orderBy(asc(schema.events.id))
      .all();
    expect(events).toEqual(
      ["app-b", "app-other", "app-v3", "list-newest", "note-1", "note-2", "profile-b", "profile-v2", "relays-a"].map((id) => ({
        id,
        replaced: false,
      })),
    );

    const tagOwners = db.select({ eventId: schema.tags.eventId }).from(schema.tags).orderBy(asc(schema.tags.eventId)).all();
    expect(tagOwners.map((tag) => tag.eventId)).toEqual(["app-b", "app-other", "app-v3", "list-newest"]);
  });
});
