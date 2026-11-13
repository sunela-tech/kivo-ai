import { UserButton } from "@clerk/react";
import { Box, Clapperboard, FolderOpen, Gem, Home, ListVideo, Menu, Settings, Sparkles, Shapes, X } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useSession } from "../lib/session";
import { Logo, cx } from "./ui";

const NAV = [
  { to: "/", label: "Home", icon: Home, end: true },
  { to: "/create", label: "Create", icon: Sparkles },
  { to: "/projects", label: "Projects", icon: FolderOpen },
  { to: "/assets", label: "Assets", icon: Shapes },
  { to: "/editor", label: "3D Editor", icon: Box },
  { to: "/renders", label: "Render Queue", icon: ListVideo },
  { to: "/subscription", label: "Subscription", icon: Gem },
  { to: "/settings", label: "Settings", icon: Settings },
];

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { me, activeJobs } = useSession();
  const navigate = useNavigate();
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center px-5">
        <NavLink to="/" onClick={onNavigate} aria-label="Kivo home">
          <Logo />
        </NavLink>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-2" aria-label="Main">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cx(
                "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                isActive ? "bg-violet-600/15 text-ink" : "text-ink-3 hover:bg-panel-2 hover:text-ink",
              )
            }
          >
            {({ isActive }) => (
              <>
                <Icon className={cx("size-[18px]", isActive ? "text-violet-400" : "text-ink-4 group-hover:text-ink-2")} />
                <span className="flex-1">{label}</span>
                {to === "/renders" && activeJobs.length > 0 && (
                  <span className="rounded-full bg-violet-600 px-1.5 text-[10px] leading-4 font-semibold text-white">{activeJobs.length}</span>
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      {me && (
        <div className="border-t border-line p-3">
          {/* A quiet, static summary: no meters or animations competing with the workspace. */}
          <button
            onClick={() => {
              navigate("/subscription");
              onNavigate?.();
            }}
            className="w-full rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-panel-2"
          >
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-ink">{me.plan.name} plan</span>
              <span className="text-ink-3">
                {me.usage.remaining} of {me.usage.limit} left
              </span>
            </div>
            <div className="mt-1 text-[11px] text-ink-4">videos this month</div>
          </button>
          <div className="mt-2 flex items-center gap-3 px-3 py-2">
            <UserButton />
            <span className="text-xs text-ink-3">Account</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function AppShell() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 border-r border-line bg-night-850/80 backdrop-blur lg:block">
        <Sidebar />
      </aside>

      {/* Mobile */}
      <div className="fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-night-900/90 px-4 backdrop-blur lg:hidden">
        <Logo size={24} />
        <button onClick={() => setOpen(true)} aria-label="Open menu" className="rounded-lg p-2 text-ink-2 hover:bg-panel-2">
          <Menu className="size-5" />
        </button>
      </div>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 animate-fade-in bg-night-950/70" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 animate-rise border-r border-line bg-night-850">
            <button onClick={() => setOpen(false)} aria-label="Close menu" className="absolute top-4 right-3 rounded-lg p-1.5 text-ink-3 hover:bg-panel-2">
              <X className="size-4" />
            </button>
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}

      <main className="min-w-0 flex-1 px-4 pt-20 pb-16 sm:px-8 lg:px-12 lg:pt-10">
        <div className="mx-auto max-w-6xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export { Clapperboard };
