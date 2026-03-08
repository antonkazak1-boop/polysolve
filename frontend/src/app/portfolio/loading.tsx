export default function PortfolioLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="flex items-center justify-between">
        <div className="h-8 bg-gray-800 rounded w-48" />
        <div className="h-9 bg-gray-800 rounded-xl w-32" />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[1, 2, 3, 4].map(i => <div key={i} className="h-20 bg-gray-800 rounded-xl" />)}
      </div>
      <div className="h-64 bg-gray-800 rounded-2xl" />
      <div className="h-80 bg-gray-800 rounded-2xl" />
    </div>
  );
}
