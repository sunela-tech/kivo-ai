import { Clapperboard, Send, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import { JobProgress } from "../components/JobProgress";
import { Spinner } from "../components/ui";
import { ApiError, api, type DirectorResult } from "../lib/api";
import { useJob, useSession } from "../lib/session";
import { useEditor } from "./store";

interface Turn {
  id: number;
  instruction: string;
  status: "thinking" | "done" | "error";
  result?: DirectorResult;
  error?: string;
}

const SUGGESTIONS = ["Make the camera rotate around the main character.", "Change the lighting to sunset.", "Add a cinematic close-up at the end.", "Make the background buildings taller."];

/**
 * AI Director: plain-language changes to the scene.
 * Gemini answers with validated edit operations; the server applies them and
 * returns the new scene. Only genuinely new objects go to Meshy.
 */
export function DirectorPanel() {
  const projectId = useEditor((s) => s.projectId)!;
  const { refresh } = useSession();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [pendingJob, setPendingJob] = useState<string | null>(null);
  const counter = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const busy = turns.some((t) => t.status === "thinking") || !!pendingJob;

  const { job } = useJob(pendingJob, async (finished) => {
    setPendingJob(null);
    if (finished.status === "succeeded") await useEditor.getState().reload();
    await refresh();
  });

  const send = async (instruction: string) => {
    const clean = instruction.trim();
    if (clean.length < 3 || busy) return;
    // Make sure the server is directing the scene the user is looking at.
    await useEditor.getState().save();
    const id = ++counter.current;
    setTurns((t) => [...t, { id, instruction: clean, status: "thinking" }]);
    setText("");
    requestAnimationFrame(() => list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" }));
    try {
      const result = await api<DirectorResult>(`/projects/${projectId}/director`, { body: { instruction: clean } });
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, status: "done", result } : x)));
      if (result.pending && result.job) {
        setPendingJob(result.job.id);
        await refresh();
      } else if (result.changed && result.spec) {
        useEditor.getState().adopt({ spec: result.spec, version: result.version ?? 0 });
      }
    } catch (e) {
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, status: "error", error: e instanceof ApiError ? e.message : "The director could not be reached." } : x)));
    }
    requestAnimationFrame(() => list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" }));
  };

  return (
    <div className="flex h-full flex-col">
      <div ref={list} className="flex-1 space-y-3 overflow-y-auto p-3">
        {turns.length === 0 && (
          <div className="pt-2">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <Clapperboard className="size-4 text-violet-400" /> AI Director
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">Describe a change and Gemini edits the scene for you: movement, cameras, lighting, the cut, even new objects. Everything it does can be undone.</p>
            <div className="mt-3 space-y-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} className="block w-full rounded-lg border border-line bg-night-850 px-3 py-2 text-left text-[11px] text-ink-2 hover:border-violet-500/50 hover:text-ink">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((turn) => (
          <div key={turn.id} className="space-y-2">
            <div className="ml-6 rounded-xl rounded-tr-sm bg-violet-600/20 px-3 py-2 text-xs text-ink">{turn.instruction}</div>
            {turn.status === "thinking" && (
              <div className="flex items-center gap-2 px-1 text-[11px] text-ink-3">
                <Spinner className="size-3.5" /> Directing…
              </div>
            )}
            {turn.status === "error" && <div className="mr-6 rounded-xl rounded-tl-sm border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">{turn.error}</div>}
            {turn.status === "done" && turn.result && (
              <div className="mr-6 rounded-xl rounded-tl-sm border border-line bg-night-850 px-3 py-2 text-xs">
                {turn.result.summary && <p className="text-ink-2">{turn.result.summary}</p>}
                {turn.result.applied.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5 text-[11px] text-ink-3">
                    {turn.result.applied.map((a, i) => (
                      <li key={i} className="flex gap-1.5">
                        <span className="text-good">✓</span> {a}
                      </li>
                    ))}
                  </ul>
                )}
                {turn.result.skipped.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5 text-[11px] text-warn/90">
                    {turn.result.skipped.map((a, i) => (
                      <li key={i}>Skipped — {a}</li>
                    ))}
                  </ul>
                )}
                {turn.result.cannotDo && <p className="mt-1.5 text-[11px] text-warn">{turn.result.cannotDo}</p>}
                {(turn.result.warnings?.length ?? 0) > 0 && <p className="mt-1.5 text-[11px] text-ink-4">{turn.result.warnings!.join(" ")}</p>}
                {turn.result.pending && (
                  <p className="mt-1.5 text-[11px] text-violet-300">
                    Meshy is generating {turn.result.newModels?.join(", ") ?? "the new model"}. The scene updates when it's ready — nothing else is regenerated.
                  </p>
                )}
                {!turn.result.changed && !turn.result.cannotDo && <p className="text-ink-3">Nothing was changed.</p>}
              </div>
            )}
          </div>
        ))}
        {job && pendingJob && (
          <div className="rounded-xl border border-line bg-night-850 p-3">
            <JobProgress job={job} compact />
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
        className="border-t border-line p-3"
      >
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(text);
              }
            }}
            rows={2}
            maxLength={800}
            placeholder="Make the character walk more slowly…"
            aria-label="Instruction for the AI Director"
            className="field resize-none text-xs"
          />
          <button type="submit" disabled={busy || text.trim().length < 3} aria-label="Send to the AI Director" className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-violet-600 text-white transition-colors hover:bg-violet-500 disabled:bg-panel-3 disabled:text-ink-4">
            {busy ? <Sparkles className="size-4 animate-pulse-soft" /> : <Send className="size-4" />}
          </button>
        </div>
      </form>
    </div>
  );
}
