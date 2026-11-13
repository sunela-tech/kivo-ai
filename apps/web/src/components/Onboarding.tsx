import { Check, SlidersHorizontal, Sparkles } from "lucide-react";
import { useState } from "react";
import { Button, Logo, Modal, cx } from "./ui";

type Mode = "simple" | "advanced";

const MODES: { id: Mode; icon: typeof Sparkles; title: string; text: string; points: string[] }[] = [
  {
    id: "simple",
    icon: Sparkles,
    title: "Simple Mode",
    text: "Just describe your idea. Kivo handles everything else.",
    points: ["One prompt, one click", "Gemini plans models, motion, cameras and light", "Great for a first video"],
  },
  {
    id: "advanced",
    icon: SlidersHorizontal,
    title: "Advanced Mode",
    text: "Take full creative control of your 3D production.",
    points: ["Full 3D scene editor and timeline", "Cameras, lights, materials and keyframes", "AI Director for changes in plain language"],
  },
];

/** First-video welcome. Both modes are selectable on every plan. */
export function Onboarding({ open, initial, onChoose }: { open: boolean; initial: Mode; onChoose: (mode: Mode) => void }) {
  const [mode, setMode] = useState<Mode>(initial);
  return (
    <Modal open={open} wide labelledBy="welcome-title">
      <div className="p-8 sm:p-10">
        <Logo size={30} wordmark={false} />
        <h2 id="welcome-title" className="mt-5 text-3xl font-semibold tracking-tight">
          Welcome to Kivo
        </h2>
        <p className="mt-2 text-ink-2">Your imagination is about to become a 3D movie.</p>

        <div role="radiogroup" aria-label="Choose how you want to create" className="mt-8 grid gap-4 sm:grid-cols-2">
          {MODES.map(({ id, icon: Icon, title, text, points }) => {
            const selected = mode === id;
            return (
              <button
                key={id}
                role="radio"
                aria-checked={selected}
                onClick={() => setMode(id)}
                className={cx(
                  "relative rounded-2xl border p-5 text-left transition-all duration-200",
                  selected ? "border-violet-500 bg-violet-600/10 shadow-[0_0_0_4px_rgb(139_124_246/0.12)]" : "border-line bg-night-850 hover:border-line-2",
                )}
              >
                <span className={cx("absolute top-4 right-4 flex size-5 items-center justify-center rounded-full border", selected ? "border-violet-500 bg-violet-600 text-white" : "border-line-2")}>
                  {selected && <Check className="size-3" />}
                </span>
                <span className="flex size-10 items-center justify-center rounded-xl bg-violet-600/15 text-violet-300">
                  <Icon className="size-5" />
                </span>
                <div className="mt-4 text-base font-semibold">{title}</div>
                <p className="mt-1 text-sm text-ink-2">“{text}”</p>
                <ul className="mt-4 space-y-1.5 text-xs text-ink-3">
                  {points.map((p) => (
                    <li key={p} className="flex items-start gap-2">
                      <Check className="mt-0.5 size-3 shrink-0 text-violet-400" /> {p}
                    </li>
                  ))}
                </ul>
              </button>
            );
          })}
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-4">
          <p className="text-xs text-ink-3">Both modes are included on every plan, and you can switch any time.</p>
          <Button variant="primary" size="lg" onClick={() => onChoose(mode)}>
            Start with {mode === "simple" ? "Simple" : "Advanced"} Mode
          </Button>
        </div>
      </div>
    </Modal>
  );
}
