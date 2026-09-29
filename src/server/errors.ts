import { HTTPException } from "hono/http-exception";

/** Error body shape for every API error. */
export interface ApiErrorBody {
  error: {
    message: string;
    statementIndex?: number;
    /** 429 only: seconds until the D1 API accepts requests again. */
    retryAfter?: number;
  };
}

export function apiError(status: 400 | 403 | 404 | 409, message: string): HTTPException {
  const body: ApiErrorBody = { error: { message } };
  return new HTTPException(status, {
    res: new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  });
}
