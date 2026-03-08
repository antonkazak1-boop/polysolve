export default function DashboardLoading() {
  return (
    <div className="space-y-8 animate-pulse">
      <div className="h-8 bg-gray-800 rounded w-40" />
      <div className="space-y-3">
        <div className="h-5 bg-gray-800 rounded w-32" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[1, 2, 3].map(i => <div key={i} className="h-24 bg-gray-800 rounded-xl" />)}
        </div>
      </div>
      <div className="space-y-3">
        <div className="h-5 bg-gray-800 rounded w-48" />
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {[1, 2, 3, 4, 5].map(i => <div key={i} className="h-40 bg-gray-800 rounded-xl" />)}
        </div>
      </div>
    </div>
  );
}
