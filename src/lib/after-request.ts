import { after } from "next/server";

// next/server's after() throws outside a request scope (verify scripts, CLI
// tools importing server libs). Deferred best-effort work should degrade to a
// detached run there, not crash the caller.
export function runAfterRequest(task: () => Promise<unknown>): void {
    try {
        after(task);
    } catch {
        void task().catch(error => {
            console.error("[after-request] detached task failed", error);
        });
    }
}
