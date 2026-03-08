import SmartMoneyFeed from '@/components/SmartMoneyFeed';

export default function FeedPage() {
  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-white">Smart Money Feed</h1>
        <p className="text-gray-400 text-sm mt-1">
          Лента сделок топ-трейдеров и watched кошельков в реальном времени. Обновляется каждые 60с.
        </p>
      </div>
      <SmartMoneyFeed className="min-h-[80vh]" />
    </div>
  );
}
