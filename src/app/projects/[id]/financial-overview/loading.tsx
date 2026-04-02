const Skeleton = ({ className }: { className?: string }) => <div className={`animate-pulse rounded-md bg-slate-200 ${className}`} />;
export default function Loading() {
  return (
    <div className="flex-1 w-full p-8 max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-6">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-6 w-32" />
        </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
      <Skeleton className="h-[300px] mt-6 w-full" />
      <Skeleton className="h-8 w-48 mt-8 mb-4" />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mt-4">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
    </div>
  );
}
