import { useEffect, useRef, useState } from "react";
import { lookupBranchRequest, type BranchRequestLookup, type PlatformProvider } from "./git";

export interface RequestConnection {
  provider: PlatformProvider;
  instanceUrl: string;
  remoteUrl: string;
  token: string;
  useGlab?: boolean;
}

interface Result {
  connection: RequestConnection;
  source: string;
  data?: BranchRequestLookup;
  error?: string;
}

export function useBranchRequest(connection: RequestConnection | null, source: string) {
  const [result, setResult] = useState<Result | null>(null);
  const [revision, setRevision] = useState(0);
  const lastRead = useRef(0);
  useEffect(() => {
    if (!connection || !source) return;
    let active = true;
    lastRead.current = Date.now();
    void lookupBranchRequest({ ...connection, source }).then(
      data => { if (active) setResult({ connection, source, data }); },
      error => { if (active) setResult({ connection, source, error: String(error) }); },
    );
    const onFocus = () => {
      if (Date.now() - lastRead.current > 1_000) setRevision(value => value + 1);
    };
    window.addEventListener("focus", onFocus);
    return () => { active = false; window.removeEventListener("focus", onFocus); };
  }, [connection, source, revision]);
  const current = result?.connection === connection && result?.source === source ? result : null;
  return { data: current?.data, error: current?.error, refresh: () => {
    setResult(previous => previous?.error ? null : previous);
    setRevision(v => v + 1);
  } };
}
