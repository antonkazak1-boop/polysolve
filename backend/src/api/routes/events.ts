import { Router, Request, Response } from 'express';
import { gammaClient } from '../../clients/gamma-client';
import { fetchNewsForEvent } from '../../clients/perplexity-client';

export const eventsRouter = Router();

// GET /api/events/resolve-condition/:conditionId — find event slug by market conditionId (for wallet positions)
eventsRouter.get('/resolve-condition/:conditionId', async (req: Request, res: Response) => {
  try {
    const conditionId = (req.params.conditionId || '').trim();
    if (!conditionId) return res.status(400).json({ error: 'conditionId required' });
    const slug = await gammaClient.getEventSlugByConditionId(conditionId);
    if (!slug) return res.status(404).json({ error: 'Event not found for this market' });
    res.json({ eventId: slug, slug });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Resolve failed' });
  }
});

// GET /api/events - list events with tag/category filter
eventsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const tag_slug = req.query.tag as string;
    const order = (req.query.order as string) || 'volume24hr';
    const closed = req.query.closed === 'true';
    const featured = req.query.featured === 'true' ? true : undefined;

    const events = await gammaClient.getEvents({
      limit,
      offset,
      active: !closed,
      closed,
      archived: false,
      order,
      ascending: false,
      ...(tag_slug && tag_slug !== 'all' && { tag_slug }),
      ...(featured !== undefined && { featured }),
    });

    res.json({ events, total: events.length, limit, offset, hasMore: events.length === limit });
  } catch (error: any) {
    console.error('Error fetching events:', error.message);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// GET /api/events/tags - get all tags
eventsRouter.get('/tags', async (_req, res) => {
  try {
    const tags = await gammaClient.getTags();
    res.json(tags);
  } catch {
    res.status(500).json({ error: 'Failed to fetch tags' });
  }
});

// GET /api/events/:id - single event (id or slug)
eventsRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    let event = await gammaClient.getEvent(req.params.id);
    if (!event) event = await gammaClient.getEventBySlug(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json(event);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch event' });
  }
});

// GET /api/events/:id/news - fetch Perplexity news for an event
eventsRouter.get('/:id/news', async (req: Request, res: Response) => {
  try {
    const event = await gammaClient.getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const news = await fetchNewsForEvent(event.title, event.description);
    res.json({ eventId: req.params.id, eventTitle: event.title, news });
  } catch (error: any) {
    console.error('News fetch error:', error.message);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});
