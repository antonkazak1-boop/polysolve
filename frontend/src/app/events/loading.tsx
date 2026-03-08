export default function EventsLoading() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="h-10 bg-gray-800 rounded-xl w-full max-w-sm" />
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="h-40 bg-gray-800 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
