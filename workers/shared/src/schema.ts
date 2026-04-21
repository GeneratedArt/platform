/**
 * Drizzle schema for D1. Source of truth for the SQL migrations under
 * workers/api/migrations/. Regenerate migrations with `drizzle-kit generate`.
 */
import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  githubLogin: text("github_login").unique(),
  walletAddress: text("wallet_address").unique(),
  displayName: text("display_name"),
  bio: text("bio"),
  avatarR2Key: text("avatar_r2_key"),
  role: text("role").notNull().default("collector"),
  createdAt: integer("created_at").notNull(),
});

export const artists = sqliteTable("artists", {
  userId: text("user_id").primaryKey().references(() => users.id),
  slug: text("slug").notNull().unique(),
  website: text("website"),
  socialsJson: text("socials_json"),
  status: text("status").notNull().default("pending"),
  approvedAt: integer("approved_at"),
  approvedBy: text("approved_by").references(() => users.id),
});

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    artistId: text("artist_id").notNull().references(() => users.id),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    description: text("description"),
    githubRepo: text("github_repo").notNull(),
    releaseTag: text("release_tag"),
    bundleCid: text("bundle_cid"),
    license: text("license").notNull().default("CC-BY-NC-4.0"),
    editionSize: integer("edition_size").notNull(),
    priceWei: text("price_wei").notNull(),
    royaltyBps: integer("royalty_bps").notNull().default(750),
    contractAddress: text("contract_address"),
    status: text("status").notNull().default("draft"),
    createdAt: integer("created_at").notNull(),
    mintedCount: integer("minted_count").notNull().default(0),
  },
  (t) => ({
    statusIdx: index("idx_projects_status").on(t.status),
    artistIdx: index("idx_projects_artist").on(t.artistId),
  })
);

export const editions = sqliteTable(
  "editions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    tokenId: integer("token_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    ownerAddress: text("owner_address").notNull(),
    mintedAt: integer("minted_at").notNull(),
    previewR2Key: text("preview_r2_key"),
    metadataCid: text("metadata_cid"),
  },
  (t) => ({
    uniqProjectToken: uniqueIndex("uniq_project_token").on(t.projectId, t.tokenId),
    ownerIdx: index("idx_editions_owner").on(t.ownerAddress),
    projectIdx: index("idx_editions_project").on(t.projectId),
  })
);

export const galleries = sqliteTable("galleries", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  city: text("city"),
  country: text("country"),
  description: text("description"),
  stewardUserId: text("steward_user_id").references(() => users.id),
  physical: integer("physical").notNull().default(0),
});

export const exhibitions = sqliteTable("exhibitions", {
  id: text("id").primaryKey(),
  galleryId: text("gallery_id").notNull().references(() => galleries.id),
  title: text("title").notNull(),
  startsAt: integer("starts_at").notNull(),
  endsAt: integer("ends_at"),
  projectIdsJson: text("project_ids_json").notNull(),
});

export const physicalEditions = sqliteTable("physical_editions", {
  editionId: text("edition_id").primaryKey().references(() => editions.id),
  dongleSerial: text("dongle_serial").unique(),
  printSpecJson: text("print_spec_json"),
  shippedTo: text("shipped_to"),
  status: text("status").notNull().default("pending"),
});

export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  expiresAt: integer("expires_at").notNull(),
});

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  actorUserId: text("actor_user_id"),
  action: text("action").notNull(),
  subject: text("subject"),
  detailsJson: text("details_json"),
  createdAt: integer("created_at").notNull(),
});
