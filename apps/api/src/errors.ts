import type { Problem } from "@hoosier/shared";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

/** Domain error carrying an HTTP status; rendered as RFC 9457 problem+json. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly title: string,
    detail?: string,
  ) {
    super(detail ?? title);
  }
}

const PG_UNIQUE_VIOLATION = "23505";
const PG_FK_VIOLATION = "23503";
const PG_CHECK_VIOLATION = "23514";

/** Fastify's own 4xx errors (malformed JSON, payload too large, ...). */
function isClientError(err: Error): err is FastifyError & { statusCode: number } {
  const status = (err as FastifyError).statusCode;
  return typeof status === "number" && status >= 400 && status < 500;
}

export function errorHandler(
  err: FastifyError | Error,
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  let problem: Problem;

  if (err instanceof ZodError) {
    // One message per field (the first), so forms show a single clear error each.
    const byPath = new Map<string, string>();
    for (const i of err.issues) {
      const path = i.path.join(".");
      if (!byPath.has(path)) byPath.set(path, i.message);
    }
    problem = {
      type: "https://hoosier-psa.dev/problems/validation",
      title: "Validation failed",
      status: 400,
      errors: [...byPath].map(([path, message]) => ({ path, message })),
    };
  } else if (err instanceof HttpError) {
    problem = {
      type: "about:blank",
      title: err.title,
      status: err.status,
      detail: err.message === err.title ? undefined : err.message,
    };
  } else if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
    problem = { type: "about:blank", title: "Conflict", status: 409, detail: "Already exists" };
  } else if ((err as { code?: string }).code === PG_FK_VIOLATION) {
    problem = {
      type: "about:blank",
      title: "Invalid reference",
      status: 422,
      detail: "A referenced record does not exist",
    };
  } else if ((err as { code?: string }).code === PG_CHECK_VIOLATION) {
    problem = { type: "about:blank", title: "Rule violation", status: 422, detail: err.message };
  } else if (isClientError(err)) {
    problem = { type: "about:blank", title: err.message, status: err.statusCode };
  } else {
    // Unexpected: log everything, tell the client nothing.
    req.log.error({ err }, "unhandled error");
    problem = { type: "about:blank", title: "Internal Server Error", status: 500 };
  }

  void reply.status(problem.status).type("application/problem+json").send(problem);
}
