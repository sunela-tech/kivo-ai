import { SignIn, SignUp } from "@clerk/react";
import { Box, Camera, Clapperboard, Sparkles, Wand2 } from "lucide-react";
import { useState } from "react";
import { Logo, cx } from "../components/ui";
import type { AppConfig } from "../lib/api";

const STEPS = [
  { icon: Sparkles, title: "Write an idea", text: "One sentence is enough." },
  { icon: Box, title: "Meshy builds the models", text: "Every character, prop and set piece." },
  { icon: Wand2, title: "Gemini directs", text: "Movement, cameras, light and the edit." },
  { icon: Camera, title: "Blender renders", text: "Real frames, encoded to MP4." },
];

export function LandingPage({ config }: { config: AppConfig }) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-up");
  const free = config.plans.find((p) => p.id === "free");
  return (
    <div className="mx-auto grid min-h-dvh max-w-6xl items-center gap-12 px-6 py-12 lg:grid-cols-[1.1fr_0.9fr]">
      <div>
        <Logo size={34} />
        <h1 className="mt-10 text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl">
          Imagine it. <span className="bg-linear-to-r from-violet-300 to-violet-500 bg-clip-text text-transparent">Animate it.</span>
        </h1>
        <p className="mt-5 max-w-lg text-lg text-ink-2 text-pretty">Kivo turns a written idea into a real animated 3D video. Describe a scene and get an MP4 — or open the full 3D editor and direct every shot yourself.</p>

        <ol className="mt-10 grid gap-3 sm:grid-cols-2">
          {STEPS.map(({ icon: Icon, title, text }, i) => (
            <li key={title} className="panel flex items-start gap-3 p-4">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-violet-600/15 text-violet-300">
                <Icon className="size-[18px]" />
              </span>
              <div>
                <div className="text-sm font-semibold">
                  <span className="mr-1.5 text-ink-4 tabular-nums">{i + 1}</span>
                  {title}
                </div>
                <div className="mt-0.5 text-xs text-ink-3">{text}</div>
              </div>
            </li>
          ))}
        </ol>

        {free && (
          <p className="mt-8 flex items-center gap-2 text-sm text-ink-3">
            <Clapperboard className="size-4 text-violet-400" />
            Free includes {free.videosPerMonth} videos a month and the full editor — Simple and Advanced Mode on every plan.
          </p>
        )}
      </div>

      <div className="flex flex-col items-center">
        <div className="mb-4 inline-flex rounded-xl border border-line bg-night-850 p-1 text-sm">
          {(["sign-up", "sign-in"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={cx("rounded-lg px-4 py-1.5 font-medium transition-colors", mode === m ? "bg-violet-600 text-white" : "text-ink-3 hover:text-ink")}>
              {m === "sign-up" ? "Create account" : "Sign in"}
            </button>
          ))}
        </div>
        {mode === "sign-up" ? <SignUp routing="hash" signInUrl="#" /> : <SignIn routing="hash" signUpUrl="#" />}
      </div>
    </div>
  );
}
