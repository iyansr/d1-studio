import { useQuery } from '@tanstack/react-query';
import { KeyRoundIcon, ServerOffIcon } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';

import { DbPicker } from '@/components/db-picker';
import { Studio } from '@/components/studio';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { ApiError, queries, sessionLost } from '@/lib/api';

export function App() {
  const meta = useQuery(queries.meta());
  const lost = useSyncExternalStore(sessionLost.subscribe, sessionLost.get);
  const mode = meta.data?.mode;

  useEffect(() => {
    // Points --primary and --ring at the remote accent (index.css).
    if (mode) document.documentElement.dataset.mode = mode;
  }, [mode]);

  if (lost || (meta.error instanceof ApiError && meta.error.status === 401)) {
    return (
      <FullPage
        icon={<KeyRoundIcon />}
        title="Session ended"
        description="Open the link printed in your terminal. It changes each time d1-studio starts."
      />
    );
  }
  if (meta.isPending) {
    return (
      <div className="flex h-svh items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (meta.isError) {
    return (
      <FullPage
        icon={<ServerOffIcon />}
        title="Can't load the studio"
        description={meta.error.message}
      />
    );
  }
  if (meta.data.state === 'needs-db') return <DbPicker meta={meta.data} />;
  return <Studio meta={meta.data} />;
}

function FullPage(props: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <main className="flex h-svh items-center justify-center p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">{props.icon}</EmptyMedia>
          <EmptyTitle>{props.title}</EmptyTitle>
          <EmptyDescription>{props.description}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </main>
  );
}
