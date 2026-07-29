import type {Session} from "@supabase/supabase-js";

const apiBase = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") || "";

export async function apiPost<T>(
  path: string,
  session: Session,
  body: unknown,
): Promise<T> {
  if (!apiBase) throw new Error("The Python API URL is not configured.");
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {detail?: string};
    throw new Error(payload.detail || `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

