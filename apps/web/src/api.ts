import type { Company } from "@hoosier/shared";

export interface ListResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Dev-only identity until Entra sign-in lands (docs/07-roadmap.md, milestone 1).
const DEV_MEMBER_ID = import.meta.env.VITE_DEV_MEMBER_ID ?? "1";

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { headers: { "x-dev-member-id": DEV_MEMBER_ID }, signal });
  if (!res.ok) {
    let title = res.statusText;
    try {
      title = ((await res.json()) as { title?: string }).title ?? title;
    } catch {
      /* body was not JSON */
    }
    throw new ApiError(res.status, title);
  }
  return (await res.json()) as T;
}

export function listCompanies(q: string, signal?: AbortSignal): Promise<ListResponse<Company>> {
  const params = new URLSearchParams({ limit: "100" });
  if (q.trim()) params.set("q", q.trim());
  return get(`/api/v1/companies?${params}`, signal);
}
