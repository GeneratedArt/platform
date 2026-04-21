import { z } from "zod";

export const Role = z.enum(["collector", "artist", "gallery", "curator", "steward"]);
export type Role = z.infer<typeof Role>;

export const ProjectStatus = z.enum([
  "draft",
  "review",
  "approved",
  "live",
  "sold_out",
  "archived",
]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const ArtistStatus = z.enum(["pending", "approved", "suspended"]);
export type ArtistStatus = z.infer<typeof ArtistStatus>;

export const CreateProjectInput = z.object({
  title: z.string().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9-]{3,40}$/),
  description: z.string().max(4000).optional(),
  edition_size: z.number().int().min(1).max(100000),
  price_eth: z.number().min(0),
  royalty_bps: z.number().int().min(0).max(1000).default(750),
  license: z.string().default("CC-BY-NC-4.0"),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

export const ApplyArtistInput = z.object({
  slug: z.string().regex(/^[a-z0-9-]{3,40}$/),
  bio: z.string().max(2000),
  portfolio_links: z.array(z.string().url()).max(10),
});
export type ApplyArtistInput = z.infer<typeof ApplyArtistInput>;
