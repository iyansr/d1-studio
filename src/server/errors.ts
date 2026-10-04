import { HTTPException } from 'hono/http-exception';

import type { WritePreview } from '../shared/edits';

/** Error body shape for every API error. */
export interface ApiErrorBody {
  error: {
    message: string;
    /**
     * What the UI acts on: `conflict` (a row changed since it was loaded),
     * `confirmation_required` (409, run again with `confirm`) and
     * `confirmation_mismatch` (403, the typed name was wrong).
     */
    code?: 'conflict' | 'confirmation_required' | 'confirmation_mismatch';
    /** The failing statement of a batch, as sent to the driver. */
    statementIndex?: number;
    /** The failing op of a `/api/batch` request. */
    opIndex?: number;
    /** 429 only: seconds until the D1 API accepts requests again. */
    retryAfter?: number;
  };
  /** With `confirmation_required` and `confirmation_mismatch`: what would run. */
  preview?: WritePreview;
}

export function apiError(
  status: 400 | 403 | 404 | 409,
  message: string,
  extra: Omit<ApiErrorBody['error'], 'message'> & { preview?: WritePreview } = {},
): HTTPException {
  const { preview, ...error } = extra;
  const body: ApiErrorBody = { error: { message, ...error } };
  if (preview) body.preview = preview;
  return new HTTPException(status, {
    res: new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  });
}
