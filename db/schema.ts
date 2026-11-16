import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
} from "drizzle-orm/sqlite-core";
export const sessions = sqliteTable(
  "sessions",
  {
    id: text().primaryKey(),
    environment: text().notNull(),
    thread: text().notNull(),
    label: text().notNull(),
    deliveryHash: text("delivery_hash").notNull(),
    state: text().notNull().default("open"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    purgeAt: integer("purge_at").notNull(),
  },
  (t) => [index("sessions_purge").on(t.purgeAt)],
);
export const photos = sqliteTable(
  "photos",
  {
    session: text()
      .notNull()
      .references(() => sessions.id),
    id: text().notNull(),
    sha256: text().notNull(),
    size: integer().notNull(),
    ready: integer().notNull().default(0),
    position: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.session, t.id] })],
);
