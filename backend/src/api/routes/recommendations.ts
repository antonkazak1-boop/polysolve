import { Router, Request, Response } from 'express';
import { generateRecommendations, invalidateRecommendationsCache } from '../../services/recommendation-engine';

export const recommendationsRouter = Router();

// GET /api/recommendations — top-10 with Perplexity analysis
recommendationsRouter.get('/', async (req: Request, res: Response) => {
  req.setTimeout(180000); // Perplexity batch can take time
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 20);
    const skipNews = req.query.skipNews === 'true';

    const recommendations = await generateRecommendations(limit, skipNews);
    res.json({ recommendations, total: recommendations.length, generatedAt: new Date().toISOString() });
  } catch (error: any) {
    console.error('Error generating recommendations:', error.message);
    res.status(500).json({ error: 'Failed to generate recommendations', detail: error.message });
  }
});

// POST /api/recommendations/refresh — invalidate cache and regenerate (with Perplexity)
recommendationsRouter.post('/refresh', async (req: Request, res: Response) => {
  req.setTimeout(180000);
  try {
    invalidateRecommendationsCache();
    const skipNews = req.query.skipNews === 'true';
    const recommendations = await generateRecommendations(10, skipNews);
    res.json({ recommendations, refreshed: true });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to refresh recommendations' });
  }
});
