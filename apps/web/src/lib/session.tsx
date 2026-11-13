import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type AppConfig, type Job, type Me } from "./api";

/** App-wide session: who the user is, their plan and quota (as the server sees them), and running jobs. */
interface SessionValue {
  config: AppConfig;
  me: Me | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setPreferredMode: (mode: "simple" | "advanced") => Promise<void>;
  markOnboarded: () => Promise<void>;
  activeJobs: Job[];
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ config, children }: { config: AppConfig; children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const data = await api<Me>("/me");
      setMe(data);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // While jobs are running, keep the session fresh so quota and job badges are accurate everywhere.
  const running = (me?.activeJobs.length ?? 0) > 0;
  const failed = !me && !!error;
  useEffect(() => {
    window.clearInterval(timer.current);
    // Poll quickly while work is running or the first load has not succeeded yet.
    timer.current = window.setInterval(() => void refresh(), failed ? 3000 : running ? 5000 : 60000);
    return () => window.clearInterval(timer.current);
  }, [running, failed, refresh]);

  const setPreferredMode = useCallback(
    async (mode: "simple" | "advanced") => {
      setMe((m) => (m ? { ...m, user: { ...m.user, preferredMode: mode } } : m));
      await api("/me", { method: "PATCH", body: { preferredMode: mode } }).catch(() => undefined);
    },
    [],
  );
  const markOnboarded = useCallback(async () => {
    setMe((m) => (m ? { ...m, user: { ...m.user, onboarded: true } } : m));
    await api("/me", { method: "PATCH", body: { onboarded: true } }).catch(() => undefined);
  }, []);

  const value = useMemo<SessionValue>(
    () => ({ config, me, loading, error, refresh, setPreferredMode, markOnboarded, activeJobs: me?.activeJobs ?? [] }),
    [config, me, loading, error, refresh, setPreferredMode, markOnboarded],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
}

/** Poll a job until it finishes. Returns the latest server state — never a guess. */
export function useJob(jobId: string | null | undefined, onDone?: (job: Job) => void) {
  const [job, setJob] = useState<Job | null>(null);
  const [queue, setQueue] = useState<{ position: number } | null>(null);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    setJob(null);
    setQueue(null);
    if (!jobId) return;
    let stop = false;
    let timeout: number | undefined;
    const tick = async () => {
      try {
        const data = await api<{ job: Job; queue: { position: number } | null }>(`/jobs/${jobId}`);
        if (stop) return;
        setJob(data.job);
        setQueue(data.queue);
        if (["succeeded", "failed", "canceled"].includes(data.job.status)) {
          done.current?.(data.job);
          return;
        }
      } catch {
        /* transient: keep polling */
      }
      if (!stop) timeout = window.setTimeout(tick, 2500);
    };
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timeout);
    };
  }, [jobId]);

  return { job, queue };
}

export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void; setData: (v: T) => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    load()
      .then((d) => live && (setData(d), setError(null)))
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { data, error, loading, reload: () => setNonce((n) => n + 1), setData };
}
