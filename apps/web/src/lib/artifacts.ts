import type {Session} from "@supabase/supabase-js";
import {supabase} from "./supabase";

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(-100);
}

function inferMediaType(file: File): string {
  if (file.type) return file.type;
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  return {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    heic: "image/heic",
    heif: "image/heif",
    webm: "audio/webm",
    m4a: "audio/mp4",
    mp4: "audio/mp4",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    pdf: "application/pdf",
    txt: "text/plain",
  }[extension || ""] || "application/octet-stream";
}

async function sha256(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

interface ArtifactLinkOptions {
  bodyAreaCode?: string;
  viewCode?: string;
  displayOrder?: number;
  capturedAt?: string;
}

export async function uploadArtifact(
  session: Session,
  eventId: string,
  file: File,
  bucket: "skin-originals" | "voice-originals" | "input-originals",
  role: "skin_photo" | "voice_note" | "original_input",
  options: ArtifactLinkOptions = {},
): Promise<string> {
  const objectPath = `${session.user.id}/${eventId}/${crypto.randomUUID()}-${sanitizeFilename(file.name)}`;
  const mediaType = inferMediaType(file);
  const {error: uploadError} = await supabase.storage.from(bucket).upload(objectPath, file, {
    contentType: mediaType,
    upsert: false,
  });
  if (uploadError) throw uploadError;

  const hash = await sha256(file);
  const {data: artifact, error: artifactError} = await supabase
    .from("artifacts")
    .insert({
      user_id: session.user.id,
      bucket,
      object_path: objectPath,
      sha256: hash,
      media_type: mediaType,
      byte_size: file.size,
      original_filename: file.name,
      artifact_kind: role,
      captured_at: options.capturedAt || new Date().toISOString(),
      metadata: {},
    })
    .select()
    .single();
  if (artifactError) throw artifactError;

  const {error: linkError} = await supabase.from("record_artifacts").insert({
    user_id: session.user.id,
    event_id: eventId,
    artifact_id: artifact.id,
    role,
    body_area_code: options.bodyAreaCode || null,
    view_code: options.viewCode || null,
    display_order: options.displayOrder || 0,
  });
  if (linkError) throw linkError;
  return artifact.id as string;
}
