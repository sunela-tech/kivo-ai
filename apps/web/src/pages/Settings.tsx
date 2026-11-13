import { UserProfile, useClerk } from "@clerk/react";
import { useState } from "react";
import { clerkAppearance } from "../main";
import { Button, Loading, Modal, Notice, PageHeader, Segmented } from "../components/ui";
import { api } from "../lib/api";
import { useSession } from "../lib/session";

export function SettingsPage() {
  const { me, setPreferredMode } = useSession();
  const clerk = useClerk();
  const [confirm, setConfirm] = useState(false);
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!me) return <Loading />;

  const deleteAccount = async () => {
    setDeleting(true);
    setError(null);
    try {
      // The server deletes every project, model and video first, then the Clerk account.
      const res = await api<{ deleted: boolean; clerkDeleted: boolean }>("/account", { method: "DELETE" });
      if (!res.clerkDeleted) await clerk.user?.delete().catch(() => undefined);
      await clerk.signOut({ redirectUrl: "/" });
    } catch (e) {
      setError((e as Error).message);
      setDeleting(false);
    }
  };

  return (
    <>
      <PageHeader title="Settings" />

      <section className="panel mb-6 p-6">
        <h2 className="text-sm font-semibold">Default creation mode</h2>
        <p className="mt-1 mb-4 max-w-xl text-sm text-ink-3">Kivo opens Create in this mode. Both modes are part of every plan, and you can switch at the top of Create whenever you like — switching never changes a project.</p>
        <Segmented
          label="Default creation mode"
          value={me.user.preferredMode}
          onChange={(m) => void setPreferredMode(m)}
          options={[
            { value: "simple", label: "Simple" },
            { value: "advanced", label: "Advanced" },
          ]}
        />
      </section>

      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold text-ink-2">Account, security and billing</h2>
        <UserProfile routing="hash" appearance={{ ...clerkAppearance, elements: { rootBox: "w-full", cardBox: "w-full max-w-none shadow-none border border-line" } }} />
      </section>

      <section className="panel border-bad/30 p-6">
        <h2 className="text-sm font-semibold text-bad">Delete account</h2>
        <p className="mt-1 mb-4 max-w-xl text-sm text-ink-3">Permanently deletes your Kivo account with every project, 3D model and video. This cannot be undone. Cancel any paid plan first if you don't want it to renew.</p>
        <Button variant="danger" onClick={() => setConfirm(true)}>
          Delete my account
        </Button>
      </section>

      <Modal open={confirm} onClose={deleting ? undefined : () => setConfirm(false)} labelledBy="delete-account-title">
        <div className="p-6">
          <h2 id="delete-account-title" className="text-lg font-semibold">
            Delete your account?
          </h2>
          <p className="mt-2 text-sm text-ink-3">All projects, scenes, 3D models and videos will be erased immediately.</p>
          <label htmlFor="confirm-delete" className="label mt-5">
            Type DELETE to confirm
          </label>
          <input id="confirm-delete" value={typed} onChange={(e) => setTyped(e.target.value)} className="field" autoComplete="off" />
          {error && (
            <div className="mt-4">
              <Notice tone="bad">{error}</Notice>
            </div>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Button onClick={() => setConfirm(false)} disabled={deleting}>
              Keep my account
            </Button>
            <Button variant="danger" disabled={typed !== "DELETE"} loading={deleting} onClick={deleteAccount}>
              Delete everything
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
