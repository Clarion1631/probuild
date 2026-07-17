import { getFieldUpdatesFeed, getUnreadFieldUpdatesCount } from "@/lib/actions";
import { getSessionOrDev } from "@/lib/auth";
import FieldUpdatesClient from "./FieldUpdatesClient";

export const dynamic = "force-dynamic";

export default async function FieldUpdatesPage() {
    const session = await getSessionOrDev();
    if (!session?.user) {
        return <div className="p-6 text-hui-textMuted">Sign in to view field updates.</div>;
    }
    const [{ comments, scope }, unreadCount] = await Promise.all([
        getFieldUpdatesFeed({ limit: 100, sinceDays: 21 }),
        getUnreadFieldUpdatesCount(),
    ]);

    const serialized = comments
        .filter(c => c.task?.projectId != null)
        .map(c => ({
            id: c.id,
            text: c.text,
            createdAt: c.createdAt.toISOString(),
            authorName: c.user?.name || c.user?.email || c.subcontractorName || "Unknown",
            authorEmail: c.user?.email ?? null,
            photos: c.photos,
            task: c.task && c.task.projectId
                ? { id: c.task.id, name: c.task.name, projectId: c.task.projectId, projectName: c.task.project?.name ?? "" }
                : null,
        }));

    return <FieldUpdatesClient initialComments={serialized} initialUnread={unreadCount} scope={scope} />;
}
