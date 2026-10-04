import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import type { WritePreview } from '@shared/edits';

import { StatementList } from './statement-list';

const changes = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'}`;

/** Appears only while something is staged (T6): apply, discard, or look at the SQL first. */
export function EditToolbar(props: {
  count: number;
  /** A dry run or an apply is in flight. */
  busy: boolean;
  onApply: () => void;
  onDiscard: () => void;
  onShowSql: () => void;
}) {
  return (
    <section
      aria-label="Staged changes"
      className="flex flex-wrap items-center gap-2 border-b bg-staged/10 px-3 py-1.5"
    >
      <span className="text-sm font-medium tabular-nums" aria-live="polite">
        {changes(props.count)} staged
      </span>
      <Button variant="link" size="sm" disabled={props.busy} onClick={props.onShowSql}>
        Show SQL
      </Button>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={props.busy} onClick={props.onDiscard}>
          Discard
        </Button>
        <Button size="sm" disabled={props.busy} onClick={props.onApply}>
          {props.busy && <Spinner data-icon="inline-start" />}
          Apply {changes(props.count)}
        </Button>
      </div>
    </section>
  );
}

/** "Show SQL": the statements Apply would run, read-only and highlighted. */
export function SqlPreviewSheet(props: { preview: WritePreview | null; onClose: () => void }) {
  const { preview } = props;
  return (
    <Sheet open={preview !== null} onOpenChange={(open) => !open && props.onClose()}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>SQL to run</SheetTitle>
          <SheetDescription>
            Nothing has run yet. Values are shown inline to read; they run as bound parameters.
          </SheetDescription>
        </SheetHeader>
        {preview && (
          <ScrollArea className="min-h-0 flex-1 px-4 pb-4 **:data-[slot=scroll-area-viewport]:max-h-full">
            <StatementList statements={preview.statements} />
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  );
}
