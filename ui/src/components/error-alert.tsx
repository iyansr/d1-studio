import { type ReactNode, useEffect, useState } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * An API error with its message verbatim (UI-8). When the request may work
 * again, a Retry button; on a 429 it stays disabled for `Retry-After` (T9).
 */
export function ErrorAlert(props: {
  title: ReactNode;
  error: Error;
  onRetry?: () => void;
  /** More actions, before Retry. */
  children?: ReactNode;
  className?: string;
}) {
  const { error, onRetry } = props;
  const apiError = error instanceof ApiError ? error : undefined;
  const retry = onRetry && (!apiError || apiError.retryable) ? onRetry : undefined;
  const wait = useCountdown(apiError?.retryAfter, error);
  const actions = props.children || retry;

  return (
    <Alert
      variant="destructive"
      className={cn(actions && "has-data-[slot=alert-action]:pr-2.5", props.className)}
    >
      <AlertTitle>{props.title}</AlertTitle>
      <AlertDescription className="font-mono whitespace-pre-wrap">{error.message}</AlertDescription>
      {actions && (
        <AlertAction className="static col-span-full mt-2 flex gap-2">
          {props.children}
          {retry && (
            <Button variant="outline" size="sm" disabled={wait > 0} onClick={retry}>
              {wait > 0 ? `Retry in ${wait}s` : "Retry"}
            </Button>
          )}
        </AlertAction>
      )}
    </Alert>
  );
}

/** Seconds left of `seconds`, restarting whenever `key` changes. */
function useCountdown(seconds: number | undefined, key: unknown): number {
  const [left, setLeft] = useState(seconds ?? 0);
  useEffect(() => {
    void key;
    if (!seconds || seconds <= 0) {
      setLeft(0);
      return;
    }
    const until = Date.now() + seconds * 1000;
    setLeft(seconds);
    const timer = window.setInterval(() => {
      const next = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      setLeft(next);
      if (next === 0) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [seconds, key]);
  return left;
}
